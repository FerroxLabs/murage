import { oneShots } from "../engine-one-shots.ts";
import { cloudTurnBot, cloudTurnEnvironment } from "../cloud-home/turn-process.ts";
import { NEUTRAL_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
// Antigravity driver — Google's `agy` CLI in headless stream-JSON mode,
// modeled on claude.ts but fully self-contained. Per-turn CLI process; the conversation continues across
// turns via `--conversation <id>` (the resumeCursor is agy's conversation_id).
// Stream-JSON input requires agy 1.1.15 or newer.
//
// Unlike claude, print mode has NO interactive permission hook: there is no
// per-action broker here. `--mode accept-edits` allows file edits but
// auto-denies shell (`run_command` comes back as a tool ERROR); the default
// `request-review` auto-denies; `--dangerously-skip-permissions` (fullAuto)
// approves everything. Real per-action approval cards are a future path via
// native ACP (agy issue #31), which would reuse acp/core.ts like grok/gemini.
//
// MCP tools: agy has no per-turn MCP flag, so each turn runs agy with a
// Murage-owned HOME (antigravity-scope.ts): the owner's real home mirrored as
// symlinks minus their personal MCP servers, plugins, hooks, skills, workflows
// and instruction files, plus a scoped mcp_config.json holding only the bot's
// computer (cloud box / Local VM / VPS), teammate tools and mounted servers.
// The owner's own ~/.gemini is never written to for tools. Full-auto
// instances only; the host desktop stays off (no approval channel in print
// mode, ever).
import { registerIntake } from "../harness/intake.ts";
import { awaitCliTreeStopped, describeSpawnFailure, engineJob, execCli, killCliTree, spawnCli } from "../procs.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { augmentedPath } from "../env-path.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { decodeInjectId } from "./local-inject.ts";
import { cliSig } from "./isolation-cache.ts";
import { engineFolderUnavailable } from "./scoped-cli-home.ts";
import { buildAntigravityScopedHome, recoverAllScopedHomes, removeAntigravityLegacyMcpEntries } from "./antigravity-scope.ts";

import type { ChildProcess } from "node:child_process";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import { engineClosedLine } from "./stop-copy.ts";
import { acpEngineExitStderrText } from "./acp/core.ts";
import { writeFileAtomic } from "../atomic.ts";
import { ASK_STOP_NOTE, ASK_STOP_PROMPT, ASK_STOP_REASON, replyCarriesAskStopNote } from "./ask-stop.ts";

/** Shown when agy ran under accept-edits, denied an action (a shell command) and wrote no reply. Print mode cannot
 *  ask, so Murage never lets this engine run commands on a bot turn at any level (sendTurn, skipPermissions):
 *  the line names what the owner can do instead of a level that would not change it. */
export const ANTIGRAVITY_DENIED_NOTE =
  "Antigravity could not run a command, because it cannot ask you first. For work that needs commands, choose another engine for this bot, such as Claude or Codex.";

const DRIVER_KIND = "antigravityAgent";
export const ANTIGRAVITY_STREAM_INPUT_MIN_VERSION = "1.1.15";
/** agy's own `--print-timeout` (a Go duration, default 5m) ends print mode
 * after that long however busy the turn is. Set past the longest silence
 * limit an owner can choose (24 hours), so a turn is stopped only by the
 * thread's silence watch, the owner's Stop or a budget stop. */
export const ANTIGRAVITY_PRINT_TIMEOUT = "8760h";

/** The stopReason of an Ask turn Murage ended because a change ran anyway: a stop (turnStopped), never finished work,
 *  and not "cancelled" (the owner's Stop), so the chat shows ASK_STOP_NOTE and no "Stopped by you". */
export const ANTIGRAVITY_ASK_STOP_REASON = ASK_STOP_REASON;

/** The Ask hard stop for agy (./ask-stop.ts). `--mode accept-edits` writes with no ask, and the 1.0.3 real-CLI probe
 * saw it run shell commands too. On an Ask turn the scoped home carries one Murage-owned
 * `hooks.json` PreToolUse hook (matcher "*") that allows only the read tools below and denies every other tool
 * before it runs, with ASK_STOP_NOTE as its reason (agy 1.4.4: a denied run_command and write_file never ran;
 * read_file still read; a hook that fails or crashes also blocks the tool). Names are agy's hook and stream names
 * (read_file, write_file, run_command, ...), not the tool list `init` prints. */
export const ANTIGRAVITY_ASK_READS = [
  "read_file", "view_file", "list_dir", "list_directory", "grep_search", "find_by_name",
  "view_file_outline", "view_code_item", "view_content_chunk", "search_web",
] as const;

/** The hook program. Fail closed: anything it cannot read as one of the allowed reads is denied. */
export const ANTIGRAVITY_ASK_HOOK_SOURCE = `"use strict";
const READS = new Set(${JSON.stringify(ANTIGRAVITY_ASK_READS)});
const REASON = ${JSON.stringify(ASK_STOP_NOTE)};
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let name = "";
  try { const call = JSON.parse(raw); name = call && call.toolCall && typeof call.toolCall.name === "string" ? call.toolCall.name : ""; } catch { name = ""; }
  process.stdout.write(JSON.stringify(READS.has(name) ? { decision: "allow" } : { decision: "deny", reason: REASON }));
});
`;

/** Write the hook program under Murage's data dir (once per content) and return the hooks.json an Ask turn's scoped
 *  home carries. The hook runs as `<this program> <script>`; the child gets ELECTRON_RUN_AS_NODE so a packaged app
 *  runs it as node. agy runs a hook through `sh -c` (Windows: `cmd /c`, which keeps an outer pair of quotes). */
export function antigravityAskStopHooks(dataDir = DATA_DIR, execPath = process.execPath, platform: NodeJS.Platform = process.platform): string {
  const dir = join(dataDir, "native", "antigravity-ask");
  const script = join(dir, `ask-hook-${createHash("sha256").update(ANTIGRAVITY_ASK_HOOK_SOURCE).digest("hex").slice(0, 16)}.cjs`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing: string | null = null;
  try { existing = readFileSync(script, "utf8"); } catch { existing = null; }
  if (existing !== ANTIGRAVITY_ASK_HOOK_SOURCE) writeFileAtomic(script, ANTIGRAVITY_ASK_HOOK_SOURCE, { mode: 0o600 });
  const forward = (path: string) => (platform === "win32" ? path.replace(/\\/g, "/") : path);
  const quoted = `"${forward(execPath)}" "${forward(script)}"`;
  const command = platform === "win32" ? `"${quoted}"` : quoted;
  return `${JSON.stringify({ "murage-ask-stop": { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 15 }] }] } }, null, 2)}\n`;
}

/** The owner's real home, which the scoped homes mirror. */
const realHomeOf = (env: Record<string, string | undefined>): string => env.HOME || env.USERPROFILE || homedir();
/** Murage-owned parent of the per-turn scoped homes. */
const antigravityScopeRoot = (): string => join(DATA_DIR, "native", "antigravity-scope");
let antigravityStartupCleanupDone = false;

export function supportsAntigravityStreamInput(version: string | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const minimum = ANTIGRAVITY_STREAM_INPUT_MIN_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

export interface AntigravityConfig {
  cli: string;
  fullAuto: boolean;
}

// Fallback catalog, mirroring a live `agy models` on agy 1.4.3. The running
// agy's own list (read in refreshModels) wins over this whenever it answers.
export const STATIC_ANTIGRAVITY_MODELS: ModelCatalog = {
  default: "gemini-4-argon-high",
  options: [
    { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
    { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
    { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
    { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
    { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
    { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
    { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
    { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
  ],
};

/** Parse `agy models` output: "<id>\t<label>" per line; other lines (progress text) are ignored. */
export function parseAntigravityModelsOutput(stdout: string): Array<{ id: string; label: string }> {
  const rows: Array<{ id: string; label: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const [id, ...rest] = line.split("\t");
    if (!id || rest.length === 0 || !AGY_MODEL_ID.test(id.trim())) continue;
    rows.push({ id: id.trim(), label: rest.join(" ").trim() || id.trim() });
  }
  return rows;
}

/** The catalog agy itself reported; the default is the static default when listed, else the first row. */
export function catalogFromAgyList(rows: Array<{ id: string; label: string }>, base: ModelCatalog = STATIC_ANTIGRAVITY_MODELS): ModelCatalog {
  if (!rows.length) return base;
  const has = rows.some((row) => row.id === base.default);
  return { default: has ? base.default : rows[0]!.id, options: rows.map((row) => ({ ...row })), source: "live" };
}

function antigravityEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...cloudTurnEnvironment("antigravity", { ...process.env, ...overrides }), PATH: augmentedPath() };
  // The harness process may hold workspace credentials injected by the
  // desktop shell. Antigravity uses its own login, so none belong in any of
  // its turn, snapshot, or helper children.
  stripWorkspaceCredentialEnv(env);
  // agy uses its own login and reads none of these today, but this is the
  // fifth `...process.env` spread reaching a live CLI: keep the whole set of
  // spawn paths uniform rather than relying on that staying true.
  stripRoutingEnv(env);
  return env;
}

const AGY_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return AGY_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; name?: unknown; displayName?: unknown };
    const id = typeof row.id === "string" ? row.id : typeof row.model === "string" ? row.model : "";
    if (!AGY_MODEL_ID.test(id)) return [];
    const label = typeof row.name === "string" ? row.name : typeof row.displayName === "string" ? row.displayName : id;
    return [{ id, label }];
  });
}

/** Extra ids from ~/.gemini/antigravity-cli/settings.json, if the user added any. */
export function readAntigravityModelCatalog(env: Record<string, string | undefined> = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(
      readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return STATIC_ANTIGRAVITY_MODELS;
  }
  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  if (typeof settings.model === "string") extras.push(...extrasFromUnknown([settings.model]));
  const options = STATIC_ANTIGRAVITY_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_ANTIGRAVITY_MODELS.default, options };
}

// ── computer MCP mount ──────────────────────────────────────────────────
// agy has no per-session MCP flag and no project-level MCP config: verified
// against agy 1.1.19, whose embedded docs list exactly two locations — the
// global `~/.gemini/config/mcp_config.json` and per-plugin files — and whose
// `agy mcp list` ignores `.gemini/{settings,mcp_config}.json` in the cwd.
// So Murage tools are mounted by upserting two reserved keys into the global file
// right before each spawn: every other key of the user's config is
// preserved, and a file that cannot be read or parsed is refused — the turn
// fails with repair guidance and the file keeps its bytes — rather than being
// rebuilt from a fresh object (the ensureOpenCodeInjectModel discipline, 0.1.52 A8).
export const ANTIGRAVITY_COMPUTER_MCP_KEY = "murage-computer";
export const ANTIGRAVITY_AGENTS_MCP_KEY = "murage-agents";
/** The owner's own servers ride the same global file under this prefix, so one
 * of theirs named like a server of the owner's own agy config never collides,
 * and a stale one left by a crashed turn can be found and removed. */
export const ANTIGRAVITY_CUSTOM_MCP_PREFIX = "murage-custom-";

export interface AntigravityMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Backward-compatible name retained for callers of the computer-only helper. */
export type AntigravityComputerMcpServer = AntigravityMcpServer;

export interface AntigravityMcpServers {
  [ANTIGRAVITY_COMPUTER_MCP_KEY]?: AntigravityMcpServer;
  [ANTIGRAVITY_AGENTS_MCP_KEY]?: AntigravityMcpServer;
  [key: string]: AntigravityMcpServer | undefined;
}

/** Fields that time a step rather than say what it did. */
const STEP_TIME_KEYS = new Set(["timestamp", "ts", "time", "created_at", "createdAt", "updated_at", "updatedAt", "elapsed_ms", "duration_ms"]);
/** A step's identity and content, without its clock: the same state sent
 * again is not new work, a step whose content grows is. Hashed, so a long
 * turn of growing snapshots keeps a few bytes per step, not the snapshots. */
function stepFingerprint(payload: unknown): string {
  const content = JSON.stringify(payload, (key, value) => (STEP_TIME_KEYS.has(key) ? undefined : value)) ?? "";
  return createHash("sha256").update(content).digest("base64");
}

/** The computer MCP server for this turn, or null when the turn has none.
 * Cloud boxes go through Murage's REST-to-MCP adapter (the same spec
 * claude.ts and codex.ts build); Local VM and VPS connections arrive as a
 * ready-made Cua Driver stdio command and pass through unchanged. */
export function antigravityComputerMcpServer(
  integrations: SendTurnInput["integrations"],
): AntigravityComputerMcpServer | null {
  const computer = integrations?.computer;
  if (computer) {
    const proxyEnv = computerProxyEnv(computer);
    return {
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        MURAGEBOX_BOX_ID: proxyEnv.MURAGEBOX_BOX_ID ?? "",
        MURAGEBOX_BOX_TOKEN: proxyEnv.MURAGEBOX_BOX_TOKEN ?? "",
        ...(proxyEnv.MURAGEBOX_BOX_API ? { MURAGEBOX_BOX_API: proxyEnv.MURAGEBOX_BOX_API } : {}),
        // who-is-driving endpoint, so a person taking the wheel in the
        // panel pauses this bot's hands mid-turn
        MURAGE_CONTROL_URL: proxyEnv.MURAGE_CONTROL_URL ?? "",
        MURAGE_CONTROL_TOKEN: proxyEnv.MURAGE_CONTROL_TOKEN ?? "",
      },
    };
  }
  const local = integrations?.localComputer;
  if (local) return { command: local.command, args: local.args, env: { ...local.env } };
  return null;
}

/** The teammate MCP server for this turn, or null when the turn has none. */
export function antigravityAgentsMcpServer(
  integrations: SendTurnInput["integrations"],
): AntigravityMcpServer | null {
  const agents = integrations?.agents;
  if (!agents) return null;
  return { command: agents.command, args: [...agents.args], env: { ...agents.env } };
}

/** The owner's own servers for this turn, keyed under the custom prefix, with
 * Murage's part of each environment already merged. */
export function antigravityCustomMcpServers(integrations: SendTurnInput["integrations"]): AntigravityMcpServers {
  const servers: AntigravityMcpServers = {};
  for (const mount of customMountEntries(integrations?.custom)) {
    servers[`${ANTIGRAVITY_CUSTOM_MCP_PREFIX}${mount.name}`] = { command: mount.command, args: [...mount.args], env: { ...mount.env } };
  }
  return servers;
}

/** Build every Murage-owned agy MCP entry for one turn. */
export function antigravityMcpServers(integrations: SendTurnInput["integrations"]): AntigravityMcpServers {
  const servers: AntigravityMcpServers = {};
  const computer = antigravityComputerMcpServer(integrations);
  const agents = antigravityAgentsMcpServer(integrations);
  if (computer) servers[ANTIGRAVITY_COMPUTER_MCP_KEY] = computer;
  if (agents) servers[ANTIGRAVITY_AGENTS_MCP_KEY] = agents;
  Object.assign(servers, antigravityCustomMcpServers(integrations));
  return servers;
}

function decodeConfig(raw: unknown): AntigravityConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.cli !== undefined && typeof o.cli !== "string") {
    throw new Error(`antigravity: invalid cli ${JSON.stringify(o.cli)}`);
  }
  if (o.fullAuto !== undefined && typeof o.fullAuto !== "boolean") {
    throw new Error(`antigravity: invalid fullAuto ${JSON.stringify(o.fullAuto)}`);
  }
  return {
    cli: typeof o.cli === "string" ? o.cli : "agy",
    // Default fullAuto to TRUE: agy's headless print harness invokes tools even
    // for trivial prompts and, with no interactive approval channel, auto-denies
    // them — producing no output, so a non-fullAuto bot's turns frequently fail.
    // Default to fullAuto for a usable bot; per-action consent returns with the
    // ACP v2 path. Still throws above on a non-boolean fullAuto.
    fullAuto: o.fullAuto === undefined ? true : o.fullAuto === true,
  };
}

export const AntigravityDriver: ProviderDriver<AntigravityConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      win32: "irm https://antigravity.google/cli/install.ps1 | iex",
    },
    docsUrl: "https://github.com/google-antigravity/antigravity-cli#installation",
  },
  models: STATIC_ANTIGRAVITY_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<AntigravityConfig>): Promise<ProviderInstance> {
    // The engine as Settings names this instance, for every line the chat shows.
    const ENGINE = input.displayName?.trim() || "Antigravity";
    const { instanceId, config } = input;
    const env = antigravityEnvironment(input.environment);
    const catalogEnv: Record<string, string | undefined> = env;
    let models = STATIC_ANTIGRAVITY_MODELS;
    const refreshModels = async () => {
      try {
        // No local server rows (0.1.52 spec E3): agy takes only `--model <id>`
        // and has no base-URL or key input, so a local pick never reached the
        // local host. Hidden rather than listed and failing later.
        const resolved = readAntigravityModelCatalog(catalogEnv);
        if (resolved.options.length) models = resolved;
        // The installed agy's own list wins: ids it no longer accepts must not stay selectable.
        const listed = await new Promise<string>((resolve) => {
          try {
            execCli(config.cli, ["models"], { timeout: 8000, env }, (err, stdout) => resolve(err ? "" : String(stdout)));
          } catch { resolve(""); }
        });
        const live = parseAntigravityModelsOutput(listed);
        if (live.length) {
          const fromAgy = catalogFromAgyList(live);
          const seen = new Set(fromAgy.options.map((option) => option.id));
          const custom = resolved.options.filter((option) => option.custom && !seen.has(option.id));
          models = { default: fromAgy.default, options: [...fromAgy.options, ...custom], source: "live" };
        }
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    // Versions before 1.0.2 mounted Murage's tools in the owner's own global
    // mcp_config.json. Take Murage's entries (and only those) back out, once.
    // The scoped homes of a crashed run are reconciled into the real home (or
    // kept), once per server process: never simply deleted, so a login agy
    // refreshed or a conversation it started in that run is not lost.
    if (!antigravityStartupCleanupDone) {
      antigravityStartupCleanupDone = true;
      try { recoverAllScopedHomes(antigravityScopeRoot()); } catch { /* best effort */ }
    }
    try { removeAntigravityLegacyMcpEntries(realHomeOf(env)); } catch { /* the file keeps its bytes */ }
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    const active = new Map<string, { stop: () => void; turnId: string }>();
    const pending = new Set<string>();
    // a Stop for a turn still reading the engine version, before it starts
    const earlyStops = new Set<string>();
    let disposed = false;
    let verifiedVersion: string | null | undefined;
    const readVersion = () =>
      new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
    // The CLI file the version came from: replaced by `agy update`, it is re-probed; otherwise never.
    let verifiedCliSig = "";
    const versionForTurn = async () => {
      if (verifiedVersion && cliSig(config.cli, env) !== verifiedCliSig) verifiedVersion = undefined;
      if (verifiedVersion === undefined) {
        verifiedVersion = await readVersion();
        if (verifiedVersion) verifiedCliSig = cliSig(config.cli, env);
      }
      return verifiedVersion;
    };
    // every live agy child, tracked independently of `active`: a child can
    // hang AFTER emitting `result` (so it's already removed from `active`), and
    // dispose()/stopAll() must still be able to reap it. Removed on process exit.
    const children = new Set<ChildProcess>();
    const closeFinalizers = new Map<ChildProcess, () => void>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };

    // The shared stop owns POSIX escalation; retain finalizers until its
    // group confirmation. Windows keeps taskkill plus root-close semantics.
    const reapChildren = async () => {
      const stopped = await Promise.all([...children].map(async (child) => {
        killCliTree(child);
        const confirmed = await awaitCliTreeStopped(child);
        if (confirmed) closeFinalizers.get(child)?.();
        return confirmed;
      }));
      if (stopped.includes(false)) throw new Error("Antigravity shutdown is still pending; its processes remain owned");
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      // Murage's Full access still stops before deleting outside its folder,
      // paying and messaging someone new (server/stop-line.ts). Print mode has
      // no way to ask, so under it this engine never skips permissions: it
      // runs in accept-edits (file edits only, no shell, no mounted tools)
      // rather than doing those three without anyone asked.
      const skipPermissions = config.fullAuto && !turn.stopLine && !turn.routeAsks;
      // The Ask hard stop (ANTIGRAVITY_ASK_READS): reads only, every other tool denied by a hook before it runs.
      const askStop = turn.askLevel === true && !skipPermissions;
      /** Something was refused at Ask: the note is due unless the reply already carries it. */
      let askStopRefused = false;
      let askStopReply = "";
      /** Murage ended this Ask turn because a change ran (the hook did not hold). Not the owner's Stop: the turn
       *  settles as ended with the note (ANTIGRAVITY_ASK_STOP_REASON), keeps whatever reply agy gave, and runs nothing more. */
      let askStopHalted = false;
      const { threadId } = turn;
      if (disposed) throw new Error("Antigravity instance is disposed");
      if (active.has(threadId) || pending.has(threadId)) throw new Error("a turn is already running on this thread");
      pending.add(threadId);
      earlyStops.delete(threadId);
      const turnId = newId();

      const version = await versionForTurn();
      if (!supportsAntigravityStreamInput(version)) {
        pending.delete(threadId);
        const reason = version
          ? `Antigravity CLI ${ANTIGRAVITY_STREAM_INPUT_MIN_VERSION}+ is required to send prompts reliably (found ${version}). Run \`agy update\`.`
          : `\`${config.cli}\` CLI not found`;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: reason });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "unsupported_cli", cost: null });
        return { turnId };
      }

      // A saved local pick from before 0.1.52 (`host::model`) would run agy's
      // own cloud model under a local model's name. Refuse it plainly instead.
      if (decodeInjectId(turn.model)) {
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: "Antigravity can't run local models. Pick this model for a bot on Fuigo, Pi, OpenCode, Qwen or Hermes instead.",
        });
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "unsupported_model", cost: null });
        return { turnId };
      }

      // Default cwd to a per-thread workspace under DATA_DIR — deliberately
      // NOT homedir(): a bot running unattended should not get the whole home
      // as its default sandbox. `--add-dir` grants agy access to that dir.
      // strip filesystem-unsafe chars only — never truncate: a 36-char UUID
      // sliced to 32 would collide two threads sharing the first 32 chars onto
      // one workspace dir. replace() already keeps a UUID unique and safe.
      // A turn that names its own folder (the Chief's proposal turn) gets no
      // per-thread workspace: it would stay behind, empty, after every run.
      const tag = threadId.replace(/[^\w-]/g, "");
      const workspace = join(DATA_DIR, "workspaces", tag);
      if (!turn.cwd) {
        try {
          mkdirSync(workspace, { recursive: true });
        } catch (error) {
          pending.delete(threadId);
          throw error;
        }
      }
      const cwd = turn.cwd ?? workspace;

      // agy 1.1.15+ accepts one JSON user event per line on stdin. Keep the
      // complete room/persona payload there: Windows' CreateProcess command
      // line is much smaller than the prompts a channel can legitimately
      // build, and putting this on `--print <prompt>` caused ENAMETOOLONG.
      turn = renderMurageTurn(turn, NEUTRAL_TOOL_SURFACE, { agents: antigravityMcpServers(turn.integrations)[ANTIGRAVITY_AGENTS_MCP_KEY] ? ANTIGRAVITY_AGENTS_MCP_KEY : undefined });
      const prompt = `${askStop ? `${ASK_STOP_PROMPT}\n\n` : ""}${turn.system ? `${turn.system}\n\n${turn.text}` : turn.text}`;
      const resumeCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;

      let settled = false;
      // Set when Murage stopped this turn (interruptTurn, stopAll). The
      // child's exit is then the user's Stop, not a crash (STOP1).
      let stopRequested = false;
      // A step the chat does not show (planning, a response still being
      // written) is still the turn working: report it, so the thread's
      // silence watch never mistakes a long model step for a hang. A step
      // seen before is not new work (a stuck retry loop re-sending its
      // state), and nothing is reported once the turn settled or was stopped.
      const shownSteps = new Set<string>();
      const working = (step?: string) => {
        if (settled || stopRequested || askStopHalted) return;
        if (step !== undefined) {
          if (shownSteps.has(step)) return;
          if (shownSteps.size >= 1_000) shownSteps.clear();
          shownSteps.add(step);
        }
        emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
      };
      // No clock of its own (0.1.61): a child that hangs without `result` and
      // without exiting goes quiet, and the thread's silence watch stops it
      // through interruptTurn like every other engine's turn.
      // Assigned once the child exists. A child can emit `result` and then
      // hang, so settling must still arrange for process and MCP cleanup.
      let armPostSettleCleanup = () => {};
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number },
      ) => {
        if (settled) return;
        settled = true;
        active.delete(threadId);
        armPostSettleCleanup();
        if (askStopRefused && !replyCarriesAskStopNote(askStopReply)) {
          const itemId = `ask-stop-${turnId}`;
          emit({ ...base(threadId, turnId), type: "item.started", itemId, itemType: "tool", origin: "murage", title: ASK_STOP_NOTE, toolKind: "notice" });
          emit({ ...base(threadId, turnId), type: "item.completed", itemId, itemType: "tool", ok: true });
        }
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
      };

      if (earlyStops.delete(threadId)) {
        pending.delete(threadId);
        settle(true, "cancelled");
        return { turnId };
      }
      if (disposed) {
        pending.delete(threadId);
        settle(false, "disposed");
        return { turnId };
      }
      // The submission fence (SendTurnInput.beforeSubmit), on every turn and
      // also when it keeps `--conversation`: with no await between it and the
      // stdin write below. sendTurn has not handed its id back yet, so a
      // refusal throws, having spawned and written nothing.
      try {
        turn.beforeSubmit?.();
      } catch (refusal) {
        pending.delete(threadId);
        throw refusal;
      }
      // Every turn, with or without Murage tools, runs agy in its own scoped
      // home: the owner's personal MCP servers, plugins, hooks, skills,
      // workflows and instruction files are absent, Murage's own tools are
      // present, and the owner's real ~/.gemini is not written. Fails closed: a
      // scope that cannot be built rejects the turn before any spawn.
      // The capability gate in server/index.ts normally withholds these
      // integrations in safe mode. Enforce the same boundary here so a
      // direct adapter caller cannot expose token-bearing tools to a child
      // that has no interactive permission channel.
      const mountedServers = antigravityMcpServers(skipPermissions ? turn.integrations : undefined);
      let scoped: ReturnType<typeof buildAntigravityScopedHome> | null = null;
      let childEnv = env;
      try {
        scoped = buildAntigravityScopedHome({
          realHome: realHomeOf(env),
          scopeRoot: antigravityScopeRoot(),
          name: `${tag}-${turnId}`.slice(0, 120),
          servers: mountedServers,
          ...(askStop ? { askStopHooks: antigravityAskStopHooks() } : {}),
        });
        childEnv = { ...env, HOME: scoped.home, USERPROFILE: scoped.home };
      } catch (error) {
        // Fails closed: never a start in the owner's real home with their personal MCP servers, hooks and skills.
        pending.delete(threadId);
        // A structured code, rendered in the owner's language by the chat (ScopeUnavailableError); the cause stays attached.
        throw engineFolderUnavailable(ENGINE, error);
      }
      const restoreMcp = () => scoped?.dispose();

      const args = [
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT,
        "--add-dir", cwd,
        // fullAuto approves everything; otherwise accept-edits allows file
        // edits but auto-denies shell (no interactive channel in print mode)
        skipPermissions ? "--dangerously-skip-permissions" : "--mode",
      ];
      if (!skipPermissions) args.push("accept-edits");
      if (turn.model) args.push("--model", turn.model);
      if (resumeCursor) args.push("--conversation", resumeCursor);

      // spawnCli resolves npm .cmd shims / shebang scripts on Windows and
      // owns the process-group vs windowsHide difference (see procs.ts)
      // The instance environment is shared by every turn; this turn's copy names its bot.
      const turnEnv: NodeJS.ProcessEnv = { ...childEnv };
      cloudTurnBot(turnEnv, turn.warmIdentity?.botId);
      // the Ask hook runs as `<this program> <script>`; a packaged app is its own node only with this set
      if (askStop) turnEnv.ELECTRON_RUN_AS_NODE = "1";
      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env: turnEnv,
          stdio: ["pipe", "pipe", "pipe"],
        }, engineJob());
      } catch (error) {
        restoreMcp();
        pending.delete(threadId);
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          ...describeSpawnFailure(error instanceof Error ? error : new Error(String(error)), config.cli),
        });
        settle(false, "spawn_error");
        return { turnId };
      }
      children.add(child);
      // The child's identity goes into the scope's manifest at once: a restart after a crash must not recover the home of an agy that is still running.
      scoped?.adoptChild(child.pid);

      let childClosed = false;
      let postSettleReaper: ReturnType<typeof setTimeout> | undefined;
      let windowsStopRetry: ReturnType<typeof setTimeout> | undefined;
      let mcpFinalized = false;
      const finalizeMcp = () => {
        if (mcpFinalized) return;
        mcpFinalized = true;
        restoreMcp();
      };
      const stop = () => {
        killCliTree(child); // process groups are POSIX-only
        if (process.platform === "win32" && !childClosed && !windowsStopRetry) {
          windowsStopRetry = setTimeout(() => { if (!childClosed) killCliTree(child); }, 3_000);
          windowsStopRetry.unref?.();
        }
        void awaitCliTreeStopped(child).then((stopped) => {
          if (stopped) closeFinalizers.get(child)?.();
        });
      };
      /** The Ask hard stop's own end: the child is stopped at once, as for a Stop, but the turn is not the owner's. */
      const haltForAskStop = () => {
        askStopHalted = true;
        stop();
      };
      const requestStop = () => {
        stopRequested = true;
        stop();
      };
      armPostSettleCleanup = () => {
        if (childClosed || postSettleReaper) return;
        // A normal agy process exits immediately after `result`. Give it a
        // short grace, then reap a zombie. Explicit stops use the same bounded
        // SIGKILL escalation so an uncooperative child cannot linger.
        postSettleReaper = setTimeout(stop, 2_000);
        postSettleReaper.unref?.();
      };

      // conversation_id from the init event → the resumeCursor (session.started
      // is what the harness persists as the cursor). Also seeds tool item ids.
      let conversationId: string | null = null;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "agy.stream", msg: o });
        const payload = o[o.event] ?? {};
        switch (o.event) {
          case "init": {
            conversationId = o.conversation_id ?? null;
            emit({
              ...base(threadId, turnId),
              type: "session.started",
              sessionId: conversationId,
              model: turn.model ?? null,
            });
            break;
          }
          case "step_update": {
            if (payload.step_type === "tool") {
              const itemId = `${conversationId ?? o.conversation_id ?? "conv"}:${payload.step_index}`;
              if (payload.state === "ACTIVE") {
                emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "engine", itemId, title: payload.tool_name });
              } else if (payload.state === "DONE") {
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: true });
                // A tool that is not a read finished on an Ask turn: the hook did not hold. Stop the child at once; the
                // turn then ends with the note, as Murage's Ask stop and not as the owner's Stop (haltForAskStop).
                if (askStop && !(ANTIGRAVITY_ASK_READS as readonly string[]).includes(String(payload.tool_name ?? "")) && !settled && !stopRequested && !askStopHalted) {
                  askStopRefused = true;
                  console.warn(`${ENGINE} ask stop: ${String(payload.tool_name ?? "a tool")} ran on an Ask turn; stopping the turn`);
                  haltForAskStop();
                }
              } else if (payload.state === "ERROR") {
                if (askStop && /denied by pre-tool hook/i.test(String(payload.tool_info?.error?.message ?? ""))) askStopRefused = true;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId, ok: false });
              } else {
                working(stepFingerprint(payload));
              }
            } else if (payload.step_type === "agent_response" && payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            } else {
              working(stepFingerprint(payload));
            }
            break;
          }
          case "result": {
            if (stopRequested) return; // root/group close owns cancellation
            // agy delivers the assistant text in result.response (not streamed)
            const response = typeof payload.response === "string" ? payload.response : "";
            askStopReply = response;
            if (response) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: response });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: response });
            } else if (Array.isArray(payload.denied_actions) && payload.denied_actions.length > 0 && !askStopRefused) {
              // accept-edits denied an action (a shell command) and agy wrote no reply: one plain line, not a blank turn.
              const itemId = `denied-${turnId}`;
              emit({ ...base(threadId, turnId), type: "item.started", itemId, itemType: "tool", origin: "murage", title: ANTIGRAVITY_DENIED_NOTE, toolKind: "notice" });
              emit({ ...base(threadId, turnId), type: "item.completed", itemId, itemType: "tool", ok: true });
            }
            if (payload.usage) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                output: payload.usage.output_tokens || 0,
              });
            }
            // A failed result agy writes while shutting down after a
            // requested stop is the user's Stop, not an engine failure:
            // same cancelled state as the close path (STOP1).
            const stoppedResult = stopRequested && payload.status !== "SUCCESS";
            // After the Ask stop halted the child, its result (whatever its status) ends the turn as that stop.
            if (payload.status !== "SUCCESS" && !stoppedResult && !askStopHalted) {
              const errorMessage = typeof payload.message === "string" && payload.message 
                ? payload.message 
                : typeof payload.error === "string" && payload.error 
                  ? payload.error 
                  : `Model turn failed: ${payload.status || "unknown reason"}`;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: errorMessage,
              });
            }
            // result.usage is the turn total (the per-step agent_response
            // figures above are its parts, not additions to it)
            settle(
              stoppedResult || askStopHalted || payload.status === "SUCCESS",
              stoppedResult ? "cancelled" : askStopHalted ? ANTIGRAVITY_ASK_STOP_REASON : payload.status ?? null,
              null,
              payload.usage
                ? {
                    input: (payload.usage.input_tokens || 0) + (payload.usage.cache_read_tokens || 0),
                    output: payload.usage.output_tokens || 0,
                  }
                : undefined,
            );
            break;
          }
        }
      };

      let buf = "";
      child.stdout.setEncoding("utf8"); // decode multibyte across chunk splits
      registerIntake(threadId, child.stdout, child);
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) handleLine(line);
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      child.on("close", (code) => {
        let finalized = false;
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          childClosed = true;
          children.delete(child);
          closeFinalizers.delete(child);
          clearTimeout(postSettleReaper);
          clearTimeout(windowsStopRetry);
          finalizeMcp();
          if (!settled && stopRequested) {
          // The process ended because Murage stopped the turn: settle as
          // cancelled like the ACP, Pi, Claude and Codex drivers, with no
          // runtime error card and no Retry (STOP1).
          settle(true, "cancelled");
          } else if (!settled && askStopHalted) {
          // The process ended because the Ask stop halted it: the turn ends, with the note, and no error card.
          settle(true, ANTIGRAVITY_ASK_STOP_REASON);
          } else if (!settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: engineClosedLine(ENGINE, code, undefined, stderr ? acpEngineExitStderrText(stderr.trim().slice(-300)) : undefined),
          });
            settle(false, "exit_before_result");
          }
        };
        closeFinalizers.set(child, finalize);
        void awaitCliTreeStopped(child).then((stopped) => {
          if (stopped) finalize();
          else emit({ ...base(threadId, turnId), type: "runtime.error", message: `${ENGINE} has not finished closing yet, so this conversation stays busy until it does. Restart Murage if it stays stuck.` });
        });
      });

      active.set(threadId, { stop: requestStop, turnId });
      pending.delete(threadId);

      emit({ ...base(threadId, turnId), type: "turn.started" });

      // The official stream-json input envelope. Closing stdin after this
      // single turn is intentional: agy finishes the active turn, emits its
      // terminal result, then exits cleanly. Conversation continuity still
      // uses --conversation on the next per-turn process.
      const inputMessage = { event: "user", message: { content: prompt } };
      appendNative(threadId, { dir: "out", source: "agy.stream", msg: inputMessage });
      try {
        child.stdin.end(`${JSON.stringify(inputMessage)}\n`);
      } catch (error) {
        emit({
          ...base(threadId, turnId),
          type: "runtime.error",
          message: `Murage could not send this message to ${ENGINE}: ${error instanceof Error ? error.message : String(error)}`,
        });
        stop();
        settle(false, "stdin_write_failed");
      }

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await readVersion();
      verifiedVersion = version;
      if (version) verifiedCliSig = cliSig(config.cli, env);
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      if (!supportsAntigravityStreamInput(version)) {
        return {
          state: "unavailable",
          reason: `Antigravity CLI ${ANTIGRAVITY_STREAM_INPUT_MIN_VERSION}+ is required. Run \`agy update\`.`,
          version,
        };
      }
      // No auth field: agy auth is keyring-backed with no reliable file marker
      // (~/.gemini/antigravity-cli/ exists after first run even when logged
      // out), so any file heuristic would overstate "signed in". Leave undefined.
      return { state: "available", version };
    };

    // A background run of the engine: a conversation deletion pauses these, and one it stopped starts again afterwards (engine-one-shots.ts).
    const generateText = (prompt: string, botId?: string): Promise<string> => oneShots.run("antigravity", undefined, (signal) => generateTextNow(prompt, signal, botId), true);
    const generateTextNow = async (prompt: string, signal: AbortSignal, botId?: string): Promise<string> => {
      const version = await versionForTurn();
      if (!supportsAntigravityStreamInput(version)) {
        throw new Error(
          version
            ? `Antigravity CLI ${ANTIGRAVITY_STREAM_INPUT_MIN_VERSION}+ is required (found ${version}). Run \`agy update\`.`
            : `\`${config.cli}\` CLI not found`,
        );
      }

      // Same scoped home as a turn, with no tools: the owner's personal
      // setup stays out of helper prompts too.
      let textScope: ReturnType<typeof buildAntigravityScopedHome> | null = null;
      let textEnv = env;
      try {
        textScope = buildAntigravityScopedHome({ realHome: realHomeOf(env), scopeRoot: antigravityScopeRoot(), name: `text-${newId()}`, servers: {} });
        textEnv = { ...env, HOME: textScope.home, USERPROFILE: textScope.home };
      } catch (error) {
        // Fails closed: a helper prompt never runs in the owner's real home.
        throw engineFolderUnavailable(ENGINE, error);
      }
      return new Promise<string>((resolve, reject) => {
        let child: ReturnType<typeof spawnCli>;
        try {
          child = spawnCli(
            config.cli,
            [
              "--input-format", "stream-json",
              "--output-format", "stream-json",
              "--model", "gemini-3.8-flash-low",
            ],
            // This call's copy of the scoped text environment names the bot it is made for.
            { env: (() => { const callEnv: NodeJS.ProcessEnv = { ...textEnv }; cloudTurnBot(callEnv, botId); return callEnv; })(), stdio: ["pipe", "pipe", "pipe"] },
          );
        } catch (error) {
          textScope?.dispose();
          reject(error);
          return;
        }
        children.add(child);
        textScope?.adoptChild(child.pid);
        const onStop = () => { killCliTree(child); finish(new Error("cancelled")); };
        signal.addEventListener("abort", onStop, { once: true });

        let settled = false;
        let response: string | null = null;
        let resultError: Error | null = null;
        let stdoutBuffer = "";
        let stderr = "";
        const timer = setTimeout(() => {
          killCliTree(child);
          finish(new Error("Antigravity text generation timed out"));
        }, 60_000);
        timer.unref?.();
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onStop);
          if (error) reject(error);
          else if (resultError) reject(resultError);
          else if (response !== null) resolve(response);
          else reject(new Error(stderr.trim() || "Antigravity exited before returning a result"));
        };

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk;
          let newline;
          while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
            const line = stdoutBuffer.slice(0, newline);
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (event.event !== "result") continue;
              const result = event.result ?? {};
              if (result.status === "SUCCESS" && typeof result.response === "string") response = result.response;
              else resultError = new Error(String(result.message ?? result.error ?? `Antigravity result: ${result.status ?? "unknown"}`));
            } catch {
              // Ignore non-protocol output; close below reports a missing result.
            }
          }
        });
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          children.delete(child);
          textScope?.dispose();
          if (code === 0) finish();
          else finish(new Error(stderr.trim() || `Antigravity exited ${code}`));
        });

        try {
          child.stdin.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
        } catch (error) {
          killCliTree(child);
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return models;
      },
      refreshModels,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        mcpToolSurface: NEUTRAL_TOOL_SURFACE,
        capabilities: {
          sessionModelSwitch: "in-session",
          images: true,
          // Cloud box, Local VM, and VPS computers all mount through the
          // scoped mcp_config.json above. Only full-auto instances advertise
          // it: print mode has no interactive approval channel, and outside
          // --dangerously-skip-permissions agy auto-denies tools that would
          // prompt (the accept-edits shell behavior in the header comment),
          // so a non-fullAuto mount could never fire. localComputerMcp stays
          // unset on purpose — the host desktop requires per-action human
          // approval (see contracts.ts), which print mode cannot deliver in
          // any mode; that returns with the native ACP path (agy issue #31).
          computerMcp: config.fullAuto,
          // The same approval limitation applies to bot-to-bot calls. The
          // harness only injects the short-lived agents proxy when this flag
          // is true, so safe-mode turns never expose a token they cannot use.
          agentsMcp: config.fullAuto,
          // The owner's own servers ride the same scoped file and the same rule: no
          // approval channel, so they are offered only when nothing asks.
          customMcp: config.fullAuto,
        },
        sendTurn,
        interruptTurn: async (threadId) => {
          const run = active.get(threadId);
          if (run) return run.stop();
          if (pending.has(threadId)) earlyStops.add(threadId);
        },
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const threadId of pending) earlyStops.add(threadId);
          for (const { stop } of active.values()) stop();
          await reapChildren(); // also reap children that hung post-result
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText,
      dispose: async () => {
        disposed = true;
        for (const { stop } of active.values()) stop();
        await reapChildren(); // retain listeners on uncertainty
        listeners.clear();
      },
    };
  },
};
