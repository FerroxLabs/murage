// Cursor Agent CLI harness support — Anysphere's `cursor-agent acp` over ACP
// stdio, billed on the Cursor subscription (`cursor-agent login`,
// CURSOR_API_KEY, or CURSOR_AUTH_TOKEN). The generic protocol runtime lives in
// acp/core.ts; this file is only the per-harness quirks.
//
// Verified against the public CLI contract (cursor.com/docs/cli/acp,
// …/reference/parameters): `cursor-agent acp` speaks JSON-RPC on stdio, advertises
// `cursor_login`, and takes `--force` / `--model` as global flags before the
// `acp` subcommand. `session/set_model` is attempted when the CLI supports it;
// a missing method falls back to the argv `--model` pin.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../atomic.ts";
import { DATA_DIR } from "../../config.ts";
import type { ModelCatalog, ProviderErrorCode, SendTurnInput } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { removeLink } from "../../link-removal.ts";
import { OWN_BUILTINS, OWN_HANDLER_CARDED, OWN_READS } from "../../../shared/own-servers.ts";
import { EMAIL_TOOLS_ENV } from "../email-tool-schemas.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

/** Translate an argv `--model` slug into the id this ACP session will accept.
 *
 * Cursor keeps two model namespaces and they do not match. `cursor-agent
 * models` and the `--model` flag speak flat slugs (`auto`, `gpt-5.3-codex`).
 * The ACP session advertises parameterised ids instead
 * (`default[]`, `gpt-5.3-codex[reasoning=medium,fast=false]`), and
 * `session/set_model` accepts *only* those. Sending the argv slug earns
 * `-32602 Invalid params` for every model, not merely unknown ones — which
 * read as "this account cannot use that model" and sent people to check their
 * subscription over a pure id-format mismatch.
 *
 * Matching walks from most to least specific, and `auto` is special-cased
 * because Cursor calls that entry `default[]` while naming it "Auto".
 *
 * Returns null when nothing matches, including when the agent advertised no
 * models at all. The caller then falls back to sending the slug unchanged,
 * which is what older CLIs that ignore the model list still expect.
 */
export function resolveCursorAcpModelId(
  available: Array<{ modelId?: string; name?: string }>,
  wanted: string,
): string | null {
  const want = wanted.trim().toLowerCase();
  if (!want) return null;
  const ids = available.filter((m) => typeof m?.modelId === "string" && m.modelId);
  if (!ids.length) return null;
  const base = (id: string) => id.split("[")[0].trim().toLowerCase();

  const exact = ids.find((m) => m.modelId!.toLowerCase() === want);
  if (exact) return exact.modelId!;

  // A base can be advertised several times with different parameters, e.g.
  // `composer-2.5[fast=false]` and `composer-2.5[fast=true]`. The plain slug
  // means Standard, so prefer the non-fast variant; a `-fast` slug has no base
  // of its own and means the fast=true variant of the base without the suffix.
  const isFast = (id: string) => /[[,]\s*fast\s*=\s*true\s*[\],]/i.test(id);
  const sameBase = ids.filter((m) => base(m.modelId!) === want);
  const byBase = sameBase.find((m) => !isFast(m.modelId!)) ?? sameBase[0];
  if (byBase) return byBase.modelId!;

  if (want.endsWith("-fast")) {
    const stem = want.slice(0, -"-fast".length);
    const fast = ids.find((m) => base(m.modelId!) === stem && isFast(m.modelId!));
    if (fast) return fast.modelId!;
  }

  const byName = ids.find((m) => (m.name ?? "").trim().toLowerCase() === want);
  if (byName) return byName.modelId!;

  if (want === "auto" || want === "default") {
    const dflt = ids.find((m) => base(m.modelId!) === "default");
    if (dflt) return dflt.modelId!;
  }
  return null;
}

export const STATIC_CURSOR_MODELS: ModelCatalog = {
  default: "auto",
  options: [
    { id: "auto", label: "Auto" },
    { id: "composer-2.5", label: "Composer 2.5" },
    { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
    { id: "gpt-5.3-codex", label: "Codex 5.3" },
    { id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 1M Thinking" },
  ],
};

const SLUG = /^[a-z0-9][a-z0-9._:+-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function firstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // CLIs sometimes print a banner before the payload. Take the first
    // {...} or [...] span that parses, rather than requiring a clean stdout.
  }
  const start = trimmed.search(/[{[]/);
  if (start < 0) return null;
  for (let end = trimmed.length; end > start + 1; end--) {
    const slice = trimmed.slice(start, end).trim();
    if (!slice.endsWith("}") && !slice.endsWith("]")) continue;
    try {
      return JSON.parse(slice);
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function labelFor(id: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return id
    .split(/[-_./]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function pushModel(
  options: ModelCatalog["options"],
  seen: Set<string>,
  id: string,
  label?: string,
  custom = false,
): void {
  if (!SLUG.test(id) || seen.has(id)) return;
  seen.add(id);
  options.push({ id, label: labelFor(id, label), ...(custom ? { custom: true as const } : {}) });
}

/** Turn `cursor-agent models` JSON (or a close cousin) into a picker catalog.
 *  Unknown shapes return null so the caller can try text / keep the fallback. */
export function decodeCursorModelCatalog(payload: unknown): ModelCatalog | null {
  const records: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(asRecord(payload)?.models)
      ? (asRecord(payload)!.models as unknown[])
      : Array.isArray(asRecord(payload)?.data)
        ? (asRecord(payload)!.data as unknown[])
        : Array.isArray(asRecord(payload)?.modelIds)
          ? (asRecord(payload)!.modelIds as unknown[])
          : [];
  if (!records.length) return null;

  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const row of records) {
    if (typeof row === "string") {
      pushModel(options, seen, row);
      continue;
    }
    const rec = asRecord(row);
    if (!rec) continue;
    const id = rec.id ?? rec.modelId ?? rec.slug ?? rec.name;
    if (typeof id !== "string") continue;
    const label =
      (typeof rec.label === "string" && rec.label) ||
      (typeof rec.displayName === "string" && rec.displayName) ||
      (typeof rec.name === "string" && rec.name !== id ? rec.name : undefined);
    pushModel(options, seen, id, label || undefined);
  }
  if (!options.length) return null;

  const defaultId =
    (typeof asRecord(payload)?.default === "string" && seen.has(asRecord(payload)!.default as string)
      ? (asRecord(payload)!.default as string)
      : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);

  // Keep the static cloud set at the front (stable picker rail) and append
  // live ids the static list does not already name.
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  return { default: defaultId, options: merged };
}

function stripModelMarkers(label: string): { label: string; isDefault: boolean; isCurrent: boolean } {
  let cleaned = label.trim();
  let isDefault = false;
  let isCurrent = false;
  const defaultMatch = cleaned.match(/\s*\(default\)\s*$/i);
  if (defaultMatch) {
    isDefault = true;
    cleaned = cleaned.slice(0, defaultMatch.index).trim();
  }
  const currentMatch = cleaned.match(/\s*\(current\)\s*$/i);
  if (currentMatch) {
    isCurrent = true;
    cleaned = cleaned.slice(0, currentMatch.index).trim();
  }
  return { label: cleaned, isDefault, isCurrent };
}

/** Parse plain `cursor-agent models` text: one slug per line, optional `id - label`
 *  columns, and `(default)` / `(current)` markers on the label. */
export function decodeCursorModelText(text: string): ModelCatalog | null {
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  let markedDefault: string | undefined;
  let markedCurrent: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || /^available\s+models?\b/i.test(line) || /^models?\b/i.test(line)) continue;
    const stripped = line.replace(/^[\s*•\-]+\s*/, "");
    const parts = stripped.split(/\s+[—–|:]\s+|\s+-\s+|\s{2,}/);
    const id = (parts[0] ?? "").trim();
    const rawLabel = parts.slice(1).join(" ").trim();
    const { label, isDefault, isCurrent } = stripModelMarkers(rawLabel);
    pushModel(options, seen, id, label || undefined);
    if (isDefault) markedDefault = id;
    if (isCurrent) markedCurrent = id;
  }
  if (!options.length) return null;
  const merged: ModelCatalog["options"] = STATIC_CURSOR_MODELS.options.map((option) => ({ ...option }));
  const mergedSeen = new Set(merged.map((option) => option.id));
  for (const option of options) {
    if (mergedSeen.has(option.id)) continue;
    mergedSeen.add(option.id);
    merged.push(option);
  }
  const defaultId =
    (markedDefault && seen.has(markedDefault) ? markedDefault : undefined) ??
    (markedCurrent && seen.has(markedCurrent) ? markedCurrent : undefined) ??
    (seen.has(STATIC_CURSOR_MODELS.default) ? STATIC_CURSOR_MODELS.default : options[0]!.id);
  return { default: defaultId, options: merged };
}

function truthyAuthFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "authenticated", "logged_in", "logged-in", "yes"].includes(normalized)) return true;
    if (["false", "unauthenticated", "logged_out", "logged-out", "no"].includes(normalized)) return false;
  }
  return null;
}

/** Read `cursor-agent status --format json`.
 *  Returns null when the payload does not actually answer the question. */
export function decodeCursorAuthStatus(payload: unknown): boolean | null {
  const rec = asRecord(payload);
  if (!rec) return null;
  const auth = asRecord(rec.auth);
  const candidates = [
    rec.isAuthenticated,
    rec.authenticated,
    rec.loggedIn,
    rec.logged_in,
    auth?.isAuthenticated,
    auth?.authenticated,
    rec.status,
    auth?.status,
  ];
  for (const candidate of candidates) {
    const flag = truthyAuthFlag(candidate);
    if (flag !== null) return flag;
  }
  return null;
}

/** Parse the documented human-readable `cursor-agent status` fallback. */
export function decodeCursorAuthText(text: string): boolean | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (/not (?:logged|signed) in|not authenticated|unauthenticated|logged out/.test(normalized)) return false;
  if (/login successful|logged in|signed in|authenticated/.test(normalized)) return true;
  return null;
}

function execText(
  run: typeof execCli,
  cli: string,
  args: string[],
  env: Record<string, string | undefined>,
): Promise<string | null> {
  return new Promise((resolve) => {
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout ?? ""));
    });
  });
}

export async function probeCursorAuth(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<boolean> {
  if (nonBlank(env.CURSOR_API_KEY) || nonBlank(env.CURSOR_AUTH_TOKEN)) return true;
  for (const args of [["status", "--format", "json"], ["status"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const decoded = decodeCursorAuthStatus(firstJsonValue(stdout)) ?? decodeCursorAuthText(stdout);
    if (decoded !== null) return decoded;
  }
  return false;
}

export async function fetchCursorModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  // Live CLI prints plain text (`slug - Label`); `--format json` is not supported yet.
  for (const args of [["models"], ["--list-models"]] as const) {
    const stdout = await execText(run, cli, [...args], env);
    if (stdout == null) continue;
    const fromText = decodeCursorModelText(stdout);
    if (fromText) return { ...fromText, source: "live" };
    const fromJson = decodeCursorModelCatalog(firstJsonValue(stdout));
    if (fromJson) return { ...fromJson, source: "live" };
  }
  return { ...STATIC_CURSOR_MODELS, source: "static" };
}

export function classifyCursorError(error: unknown): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (
    code === -32000 ||
    /unauthoriz|unauthenticated|not signed in|not logged in|invalid api key|invalid_credentials|authentication required/.test(
      blob,
    )
  ) {
    return "invalid_credentials";
  }
  if (/inactive subscription|subscription.*(expired|inactive)|upgrade your (plan|subscription)/.test(blob)) {
    return "inactive_subscription";
  }
  return undefined;
}

/** The permission cursor-agent is given on a host-computer turn, beside the own reads: Murage's own `computer` MCP tools run without
 *  a session/request_permission, because Murage's computer service asks per action by the exact tool name. Cursor's
 *  own ask for them says only kind "other" (never trusted), so it could not be judged. Shell, edits and every other
 *  MCP tool keep cursor's own allowlist approval. (cursor-agent 2026.10.19: `Mcp(<server>:<tool>)` in the
 *  `permissions.allow` of cli-config.json under CURSOR_CONFIG_DIR.) */
export const CURSOR_HOST_COMPUTER_ALLOW = "Mcp(computer:*)";

/** The config dir cursor-agent reads: CURSOR_CONFIG_DIR, else $XDG_CONFIG_HOME/cursor, else ~/.cursor. */
function cursorConfigDir(env: Record<string, string | undefined>): string {
  if (nonBlank(env.CURSOR_CONFIG_DIR)) return env.CURSOR_CONFIG_DIR!;
  if (nonBlank(env.XDG_CONFIG_HOME)) return join(env.XDG_CONFIG_HOME!, "cursor");
  return join(env.HOME || homedir(), ".cursor");
}

/** Murage's own reads (shared/own-servers.ts OWN_READS: the roster, memory search, ...) on the own servers this turn
 *  hands cursor, one `Mcp(<server>:<tool>)` entry per tool, never a wildcard. They run with no card at every level on
 *  every engine (auto-approve.ts, own-unasked), but cursor's own ask for them says only kind "other" and a title
 *  ("agents-list_bots: list_bots", real cursor-agent 2026.10.19), which is never trusted (Rule 9): the read was held
 *  as a call Murage could not read whole, at every level, and the turn waited on the card. Allowed here, cursor runs
 *  them without asking, exactly as Claude does. Every tool that acts keeps cursor's own ask and Murage's card. */
export function cursorOwnReadAllow(turn: Pick<SendTurnInput, "integrations">): string[] {
  const allow: string[] = [];
  const add = (server: string, mount: string) => {
    for (const tool of OWN_READS.find((row) => row.mount === mount)?.tools ?? []) allow.push(`Mcp(${server}:${tool})`);
  };
  if (turn.integrations?.agents) add(turn.integrations.agents.serverName ?? OWN_BUILTINS.agents, "own:agents");
  if (turn.integrations?.memory) add(OWN_BUILTINS.memory, "own:memory");
  // Bot email (BOT-EMAIL-MURAGE-109 3.2 adapter admission): the handler-carded send tools, by exact name on this turn's own agents mount,
  // only on a turn the email mount admitted for sending. Their handler applies the bot's email setting and holds on Murage's own card.
  const agents = turn.integrations?.agents as { serverName?: string; env?: Record<string, string | undefined> } | undefined;
  if (agents?.env?.[EMAIL_TOOLS_ENV] === "send") {
    for (const row of OWN_HANDLER_CARDED) if (row.mount === "own:agents") allow.push(`Mcp(${agents.serverName ?? OWN_BUILTINS.agents}:${row.tool})`);
  }
  return allow;
}

/** Point this child at a Murage-owned config dir that carries `allow` (the own reads above, and on a host-computer
 *  turn the computer server). The owner's own cursor config is never written: it is neither edited nor copied, so
 *  the owner's allowlist does not apply on this turn (shell asks as it would for a fresh install). Sign-in is
 *  untouched: cursor-agent keeps auth.json outside CURSOR_CONFIG_DIR (verified on 2026.10.19: Linux
 *  $XDG_CONFIG_HOME/cursor, macOS ~/.cursor). Sessions live in `acp-sessions` of the config dir, so that one folder
 *  is linked through to the real one and a session resumes whichever kind of turn opened it. */
export type SessionsSymlink = (target: string, path: string, type: "dir" | "junction") => void;

/** The `acp-sessions` link. A directory symlink needs admin rights or Developer Mode on Windows, which an ordinary
 *  account lacks, so there it is a directory junction (no privilege; the target is absolute). If the link cannot be
 *  made at all the turn still runs, on a sessions folder of its own, rather than failing before spawn. */
export function linkCursorSessions(target: string, link: string, platform: NodeJS.Platform = process.platform, symlink: SessionsSymlink = symlinkSync): void {
  try {
    symlink(target, link, platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (platform !== "win32") throw error;
    mkdirSync(link, { recursive: true, mode: 0o700 });
  }
}

/** Removes the `acp-sessions` link and never what it points to (a junction is dropped as an entry, not followed). */
export function removeCursorSessionsLink(link: string, platform: NodeJS.Platform = process.platform): boolean {
  return removeLink(link, undefined, platform);
}

export function scopeCursorHostComputerConfig(env: Record<string, string | undefined>, botId?: string, allow: readonly string[] = [CURSOR_HOST_COMPUTER_ALLOW]): string {
  const real = cursorConfigDir(env);
  const root = join(DATA_DIR, "native", "cursor-host-config");
  const dir = join(root, (botId ?? "shared").replace(/[^A-Za-z0-9_-]/g, "_"));
  if (real === dir) return dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sessions = join(dir, "acp-sessions");
  let linked = false;
  try { linked = lstatSync(sessions).isSymbolicLink(); } catch { /* absent */ }
  if (!linked && !existsSync(sessions)) {
    mkdirSync(join(real, "acp-sessions"), { recursive: true, mode: 0o700 });
    linkCursorSessions(join(real, "acp-sessions"), sessions);
  }
  // The CLI rewrites this file (model, display); keep what it wrote and set only the permissions.
  const file = join(dir, "cli-config.json");
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch { /* absent or unreadable: start from the minimum */ }
  const permissions = config.permissions as { allow?: unknown; deny?: unknown } | undefined;
  const settled = config.approvalMode === "allowlist" && Array.isArray(permissions?.allow)
    && permissions.allow.length === allow.length && allow.every((entry, i) => (permissions.allow as unknown[])[i] === entry)
    && Array.isArray(permissions.deny) && permissions.deny.length === 0;
  if (!settled) {
    writeFileAtomic(file, `${JSON.stringify({ version: 1, ...config, approvalMode: "allowlist", permissions: { allow: [...allow], deny: [] } }, null, 2)}\n`, { mode: 0o600 });
  }
  env.CURSOR_CONFIG_DIR = dir;
  return dir;
}

export const cursorSupport = (run: typeof execCli): AcpSupport => ({
  driverKind: "cursorAgent",
  displayName: "Cursor",
  models: STATIC_CURSOR_MODELS,
  // Cursor and other coding agents can both install a generic `agent` shim.
  // Cursor's compatibility alias is unambiguous and ships with the same CLI.
  defaultCli: "cursor-agent",
  nativeSource: "cursor.acp",
  loginNote: "Cursor CLI is not signed in: run `cursor-agent login` in a terminal, or set CURSOR_API_KEY",

  install: {
    command: {
      darwin: "curl https://cursor.com/install -fsS | bash",
      linux: "curl https://cursor.com/install -fsS | bash",
      win32: "irm 'https://cursor.com/install?win32=true' | iex",
    },
    docsUrl: "https://cursor.com/docs/cli/installation",
    signInCommand: "cursor-agent login",
  },

  // NOT isolated from the owner's personal setup (rig, cursor-agent
  // 2026.10.01-e373342: ~/.cursor/mcp.json servers, ~/.cursor, ~/.claude and
  // ~/.agents skills and commands load under ACP; hooks and rules did not).
  // No per-process switch covers them: CURSOR_CONFIG_DIR is ignored for MCP;
  // CURSOR_DATA_DIR + `mcp disable` stops servers only (skills and commands
  // stay) and moves the CLI's session data; HOME moves the whole home for the
  // bot's own shell tools and the login lookup. Listed as a residual.
  // Global flags must precede `acp` (cursor.com/docs/cli/reference/parameters).
  // `--force` is the documented auto-approve switch (`--yolo` is an alias);
  // `--model` is the reliable pin — ACP session/set_model is best-effort below.
  // Host-computer turns only: Murage asks for each `computer` action itself (see CURSOR_HOST_COMPUTER_ALLOW).
  // spawnArgs is the one hook that sees the turn and the child's own env, and the env is the spawn contract.
  hostComputerAskedByMurage: true,
  // The Ask hard stop (../ask-stop.ts): Cursor writes inside the project with no permission ask, so an Ask turn runs
  // in Cursor's own "ask" session mode (no edits, no commands; cursor-agent 2026.10.19 refused a write and a shell
  // command there, an override in the prompt included, and still read). `--mode` is ignored by `acp`, so the mode is
  // set over the wire, and a later Auto or Full access turn puts the session back in "agent".
  askStop: { sessionMode: { readOnly: "ask", normal: "agent" } },
  // Every turn that mounts Murage's own servers: their reads run unasked (cursorOwnReadAllow).
  spawnArgs: (config, turn, ctx) => {
    const allow = [...cursorOwnReadAllow(turn), ...(turn.integrations?.localComputer?.scope === "local-computer" ? [CURSOR_HOST_COMPUTER_ALLOW] : [])];
    if (allow.length && ctx?.env) scopeCursorHostComputerConfig(ctx.env, turn.warmIdentity?.botId, allow);
    return [
    ...(config.fullAuto ? ["--force"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "acp",
    ];
  },
  credentialEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],

  resolveModels: (environment, config) => fetchCursorModels(config.cli || "cursor-agent", environment, run),

  // Prefer the advertised ACP method. An already-signed-in CLI should accept
  // cursor_login without a browser; a missing method rides the ambient login
  // (CURSOR_API_KEY / `cursor-agent login`) instead of failing the turn.
  pickAuthMethod: (methods) => (methods.some((m) => m.id === "cursor_login") ? "cursor_login" : null),
  authFailure: "continue",
  isAuthenticated: (env, config) => probeCursorAuth(config.cli || "cursor-agent", env, run),
  classifyError: classifyCursorError,

  async configureSession({ request, sessionId, turn, sessionModels }) {
    if (!turn.model) return;
    // Prefer the id this session actually advertised; fall back to the argv
    // slug so a CLI that advertises nothing behaves exactly as before.
    const modelId = resolveCursorAcpModelId(sessionModels ?? [], turn.model) ?? turn.model;
    try {
      await request("session/set_model", { sessionId, modelId });
    } catch (e) {
      const err = e as Error & { code?: unknown };
      // -32601 method missing, -32602 id not in this session's namespace. In
      // both cases spawnArgs already pinned `--model`, so the turn runs the
      // right model anyway; failing it here would refuse a working request.
      if (err.code === -32601 || err.code === -32602) return;
      throw new Error(
        `Cursor rejected model "${turn.model}" (sent as "${modelId}") via session/set_model: ${err.message}. ` +
          `Check that \`cursor-agent\` is current and that this account can use that model.`,
      );
    }
  },

  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCursorAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(cursorSupport(run));
}

export const CursorAgentDriver = createCursorAgentDriver();
