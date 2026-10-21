import { cloudEngineHome, cloudTurnBot, cloudTurnEnvironment, cloudTurnRender, type CloudCodexPolicy, type CloudMcpStanza } from "../cloud-home/turn-process.ts";
import { queryCloudBotState, type CloudLauncherSpawn } from "../cloud-home/bot-state.ts";
import { cloudMcpStanza } from "../cloud-home/engine-render.ts";
import { CODEX_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
import { notePromptSent } from "../turn-hold.ts";
// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { applyProviderRoute } from "../provider-routing.ts";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { sep } from "node:path";
import { CRED_FILE_ENV, CRED_SERVER_ENV } from "../turn-credential.ts";
import { anyMountIncomplete, clearMountsIncomplete, connectorMountRefsOf, CRED_FILE_PLACEHOLDER, connectorScopeOf, createTurnCredentialStore, splitTurnSecrets, type TurnCredentialStore } from "./turn-credentials.ts";
import { descendantPids, untrackedDescendants } from "./process-tree.ts";
import { diffWarmKey, stableJson, warmKey, type WarmKey } from "./warm-key.ts";

import { DATA_DIR, stripCapturedProviderEnv, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { CODEX_APPROVAL_PIN_ARGS, codexIsolationArgs, codexTurnPolicy, scopedCodexHome } from "./codex-isolation.ts";
import { ScopeUnavailableError, engineUpdateRequired, scopeLocalFailureOf, withScopeRetry } from "./scoped-cli-home.ts";
import {
  CODEX_GATE_MIN, CodexHookGate, HOOK_ASK_BOUND_MS, HOOK_LIVENESS_MS, HookDecisionTable, codexGatePlan, codexShellFormArgs,
  CODEX_HOOK_LAUNCH_ENV, hookConfigOf, hookLaunchLine, newHookToken, routeDelivery, tripwireLine, trustHooks, versionAtLeast, writeHookFiles,
  type CodexGatePlan, type HookAnswer, type HookDelivery, type HookRoute,
} from "./codex-hook.ts";
import { execEnvHanded, execEnvNow, handedEngineEnv, ownedTurnNames, type HandedEnv } from "../engine-env.ts";
import { NarrowDenials } from "../narrow-denials.ts";
import { HookProof, TurnRefusal, hookDidNotStartLine } from "./turn-refusal.ts";
import { appendDecision } from "../decision-log.ts";
import { awaitScopeStart } from "./scoped-cli-home.ts";
import { renderDriverReplay } from "../turn-context.ts";
import { cliSig, knownCliVersion, noteVersionProbe, rememberCliVersion, versionProbeAllowed } from "./isolation-cache.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import { codexConfigMcpServerNames, externalMcpRecords, mountedMcpServerNames } from "./codex-mcp-names.ts";
import type { ExecEnv, McpMountRecord } from "../../shared/mount-identity.ts";
import { createPrewarmGate, createTurnMemory, spawnInputsOf, TAKEOVER_FAILED_MESSAGE, warmPool, pastWarmMaxAge, spawnedAtOf } from "./warm-pool.ts";
import { awaitCliTreeStopped, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { cachedCliVersion } from "../cli-version-cache.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";
import { withCliMemoryLearning } from "./cli-memory-learning.ts";
import { fluxKey } from "../flux-config.ts";
import { applyFluxSurface, FLUX_CODEX_ENV_KEY, FLUX_CODEX_PROVIDER, FLUX_RESPONSES_BASE } from "../flux-routing.ts";
import { codexFluxProviderFor, codexHttpHeaderArgs, fluxMemoryContextForTurn, fluxMemoryDecision, logFluxMemoryHeaders } from "../flux-memory-headers.ts";
import { fluxIdIsRoutable } from "../flux-surface.ts";
import { augmentedPath } from "../env-path.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "./bounded-lines.ts";
import { registerIntake } from "../harness/intake.ts";
import {
  codexNoAnswers,
  fromCodex,
  fromElicitationForm,
  toCodexAnswers,
  toElicitationContent,
  type QuestionAnswer,
  type QuestionSpec,
} from "../question-normalize.ts";
import { QUESTION_TIMEOUT_MS } from "../../shared/questions.ts";
import { CODEX_BUILTIN_COMMANDS, normalizeEngineCommands } from "../engine-commands.ts";
import { engineClosedLine, plainDuration } from "./stop-copy.ts";
import { boundedToolInput, codexApprovalText } from "../approval-text.ts";
import { acpEngineExitStderrText } from "./acp/core.ts";
import { backgroundCapNote, backgroundWaitCapMs, SubtaskTracker } from "../subtasks.ts";
import { shellDialectOf } from "../shell/pwsh.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";
/** Codex mounts the phone under a name of its own, never a bot's server's
 * (mcp-registry.ts reserves it); its tools are named under it. */
export const CODEX_PHONE_MOUNT = "murage_phone";

/** Smallest `x-flux-model-window` observed on a Flux alias
 *  (docs/plans/flux-router-spec.md 6.6). Codex is told this rather than its
 *  own 258400 fallback so it compacts before the smallest backend Flux can
 *  route to overflows. */
const FLUX_CONTEXT_FLOOR = 129_024;

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const DENY_TIMEOUT_NOTE =
  "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";

type StdioMcpServer = { command: string; args: string[]; env: Record<string, string> };

/** Settles one server→client ask. A question's `answer` carries the owner's
 * validated picks (0.1.52 ASK3); `deny` on a question is an explicit skip. */
type AskFinish = ((
  behavior: "allow" | "deny" | "answer",
  message?: string,
  source?: "user" | "timeout" | "system",
  answers?: QuestionAnswer[],
  /** Rule 72 / 73d: the verdict's narrowing denial (`source: "narrow"`) or its narrowed call (`updatedInput`). */
  extra?: { source?: unknown; updatedInput?: unknown },
) => void) & {
  /** A hook ask's identity for the one 3-strike counter of narrowing denials (server/narrow-denials.ts). */
  narrowKey?: { tool: string; text: string };
};

/** Per-process connection state shared by every turn that runs on one app-server. */
interface Conn {
  /** One JSON-RPC id sequence per connection, so a late reply to an earlier turn's request cannot be taken for a new turn's. */
  nextId: number;
  /** Descendants of the app-server once it is up (its MCP servers); undefined until taken. */
  baseline: Set<number> | null | undefined;
  /** Where the connection's stdout frames go now: the running turn, or the idle handler between turns. One splitter lives as long as the process, so a partial frame or a frame after completion is never lost to a switch. */
  onLine: (line: string) => void;
  onOverflow: (overflow: any) => void;
  /** Bytes of a frame the splitter has begun but not finished. Non-zero means a frame started under one owner would finish under the next. */
  buffered: () => number;
}

/** The credential file's path, bound into already-serialized `-c` values:
 * JSON string escaping is what TOML basic strings need, so a Windows path's
 * backslashes survive. */
export function bindCredentialPathInArgs(args: readonly string[], path: string): string[] {
  const escaped = JSON.stringify(path).slice(1, -1);
  return args.map((arg) => arg.replaceAll(CRED_FILE_PLACEHOLDER, escaped));
}

/** An app-server kept warm between turns on one chat thread. */
interface Retained {
  child: ReturnType<typeof spawnCli>;
  warm: WarmKey;
  cred: TurnCredentialStore | null;
  conn: Conn;
  /** The conversation loaded in the app-server. */
  codexThreadId: string;
  /** The bot whose engine home this process runs on. */
  bot?: string | null;
  closing: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  settleCheck?: Promise<void>;
  detachIdle: () => void;
  /** The Rule 68 socket of this process, live as long as the process is. */
  hookGate?: CodexHookGate;
  /** The Rule 74 map this process was handed, with the shell form its checks run. */
  handed?: HandedEnv;
  /** The SessionStart proof of this process (Rule 68c): carried to the next turn while valid under the same hook configuration;
   *  a Rule 67 incident voids it, and a void proof ends reuse. */
  proof?: HookProof;
}

/** mtime+size of Codex's own config: it is read once per process, so a change ends reuse. */
function codexSettingsRevision(env: Record<string, string | undefined>): string {
  try {
    // Codex's own file, a fixed name under its home (never a path a tool call named)
    const st = statSync([env.CODEX_HOME || [homedir(), ".codex"].join(sep), "config.toml"].join(sep));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** How Codex turns are paid for. Off a home: the CLI's own ChatGPT login (childEnv drops OPENAI_API_KEY).
 * On a home the launcher reports the engine-wide C store's mode: an enrolled API key bills per use
 * ("metered", the contract's name for an API-key charge), anything else is the bot's ChatGPT sign-in.
 * A launcher that cannot answer never fails the status check. */
export async function codexCloudBilling(launch?: CloudLauncherSpawn): Promise<"metered" | "subscription"> {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return "subscription";
  try {
    return (await queryCloudBotState(undefined, launch)).engines.codex?.mode === "apikey" ? "metered" : "subscription";
  } catch {
    return "subscription";
  }
}

/** What a server request that arrives with no turn to ask is answered with. */
function idleRefusal(method: string): Record<string, unknown> {
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { result: { decision: "denied" } };
  if (method.endsWith("/requestApproval")) return { result: { decision: "decline" } };
  if (method === "mcpServer/elicitation/request") return { result: { action: "cancel" } };
  if (method === "item/tool/requestUserInput") return { result: { answers: {} } };
  return { error: { code: -32601, message: "no turn is running" } };
}

const renamedMcpServers = new Set<string>();
/** Said once per name, because the rename is deliberate: the model will see
 * this server's tools under the new prefix, and someone reading the log needs
 * to know the server was moved aside rather than lost. Carries names only —
 * never the server's command, args or env. */
const refusedMcpServers = new Set<string>();
/** Said once per name: a custom server whose name (or Codex alias) holds `__`
 * is not mounted, because the engine joins server and tool with `__`. */
function noteRefusedMcpServer(name: string): void {
  if (refusedMcpServers.has(name)) return;
  refusedMcpServers.add(name);
  console.error(`codex: MCP server ${JSON.stringify(name)} not mounted: this name cannot be told apart from its tools`);
}

function noteRenamedMcpServer(name: string, mountName: string, why: string): void {
  // Keyed by the pair, not the name: if the same server later moves to a
  // different mount name, that is a different fact and worth a line.
  const said = JSON.stringify([name, mountName]);
  if (renamedMcpServers.has(said)) return;
  renamedMcpServers.add(said);
  console.error(`codex: MCP server ${JSON.stringify(name)} mounted as ${JSON.stringify(mountName)} so definitions do not merge — ${why}`);
}

/** Codex stops an MCP tool call after 60 seconds unless the server sets
 * `tool_timeout_sec`. Murage's own tools run longer than that (a computer
 * command, a picture, a card waiting on the owner), so every server Murage
 * mounts gets a limit past the longest silence setting (24 hours): a long
 * tool call ends when it answers, on the owner's Stop, or when the thread's
 * silence watch stops the turn, never on a clock. */
export const CODEX_MCP_TOOL_TIMEOUT_SEC = 7 * 24 * 60 * 60;

/** How long Codex waits for a custom stdio server to start (spec 3.6). */
export const CODEX_CUSTOM_MCP_STARTUP_TIMEOUT_SEC = 60;

/** How long Codex waits for a server Murage mounts itself to start and list its
 * tools (its default is 10 s). At least twice the connector bridge's absolute
 * list deadline (8 s), so the bridge's answer, the stand-in included, always
 * arrives before Codex drops the server from the turn. */
export const CODEX_MURAGE_MCP_STARTUP_TIMEOUT_SEC = 20;

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpServer,
  preApproved = true,
): void {
  // The credential file's path and the server's name inside it are not
  // secrets and differ per server, so they ride the server's own `env` table
  // rather than the app-server's shared environment.
  const own = new Set([CRED_FILE_ENV, CRED_SERVER_ENV]);
  const shared = Object.fromEntries(Object.entries(server.env).filter(([key]) => !own.has(key)));
  Object.assign(env, shared);
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(shared))}`,
    "-c", `${prefix}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
  );
  for (const key of own) {
    if (typeof server.env[key] === "string") appServerArgs.push("-c", `${prefix}.env.${key}=${JSON.stringify(server.env[key])}`);
  }
  // Harness-owned servers are pre-quieted; a user-configured server keeps
  // codex's on-request policy so its tool calls become approval cards.
  if (preApproved) {
    appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="auto"`);
    appServerArgs.push("-c", `${prefix}.startup_timeout_sec=${CODEX_MURAGE_MCP_STARTUP_TIMEOUT_SEC}`);
  } else {
    // A user's server often downloads what it runs (npx, uvx, docker) on its
    // first turn. Codex gives a server 10 seconds to start unless told
    // otherwise, and drops it from the turn when that passes.
    appServerArgs.push("-c", `${prefix}.startup_timeout_sec=${CODEX_CUSTOM_MCP_STARTUP_TIMEOUT_SEC}`);
  }
}

// Murage owns browser and computer selection and mounts its own scoped MCP
// servers. Codex's bundled desktop browser/computer tools need the Codex
// desktop app's connection, which a CLI child never has, so leaving them on
// offers the model a route that cannot work. These overrides only reach this
// child process: the owner's Codex install and config are untouched, and
// native web search keeps its configured mode. Codex ignores feature keys it
// does not know (checked on codex-cli 0.156.1), so older CLIs still start.
// Upstream OpenMausBot #1722.
const CODEX_TOOL_SURFACE_ARGS: readonly string[] = [
  "-c", "features.browser_use=false",
  "-c", "features.browser_use_external=false",
  "-c", "features.computer_use=false",
  // Disable the matching plugin instructions too. An inline table, because
  // some CLIs read quoted dotted keys literally.
  "-c", 'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
];

// The Chief's New project proposal turn (SendTurnInput.proposalOnly): no
// shell tool, no web search, no ChatGPT apps and no Murage server; the Chief
// answers with the proposal block in its reply (project-new.ts). Checked on codex-cli
// 0.158.0: `codex -c features.shell_tool=false features list` reports
// shell_tool false, and `web_search` is a validated key (an unknown value
// fails the config load; "disabled" is one of disabled/cached/live).
const CODEX_PROPOSAL_ARGS: readonly string[] = [
  "-c", "features.shell_tool=false",
  "-c", "features.apps=false",
  "-c", 'web_search="disabled"',
];
/** What the owner reads when Codex does not answer one of Murage's
 * requests in time: plain words and a plain duration, never the app-server
 * method or a millisecond count. "timed out" stays in it for the Inbox's
 * grouping (server/inbox-rollup.ts). */
export function codexRpcTimeoutMessage(method: string, timeoutMs: number, engine = "Codex"): string {
  const step = method === "initialize" ? " while starting"
    : method.startsWith("thread/") ? " while opening the conversation"
    : method.startsWith("turn/") || method.startsWith("review/") ? " while starting the turn"
    : "";
  return `${engine} timed out${step} (no answer for ${plainDuration(timeoutMs)}).`;
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex login --device-auth",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    // The engine as Settings names this instance, for every line the chat shows.
    const ENGINE = input.displayName?.trim() || "Codex";
    const { instanceId, config } = input;
    // The Codex version, for the scoped CODEX_HOME gate: probed once per CLI
    // file, a failing probe retried on a bounded backoff (isolation-cache.ts).
    let codexVersion = "";
    let codexVersionSig = "";
    // `force`: a bot turn's second look after an unknown answer, which does not wait for the backoff.
    const codexVersionForTurn = async (env: Record<string, string | undefined>, force = false): Promise<string | undefined> => {
      const sig = cliSig(config.cli, env);
      if (codexVersion && sig === codexVersionSig) return codexVersion;
      const known = knownCliVersion(`codex|${config.cli}`, sig);
      if (known) { codexVersion = known; codexVersionSig = sig; return known; }
      if (!force && !versionProbeAllowed(`codex|${config.cli}`, sig)) return undefined;
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
      });
      noteVersionProbe(`codex|${config.cli}`, sig, Boolean(version));
      if (!version) return undefined;
      codexVersion = version;
      codexVersionSig = sig;
      rememberCliVersion(`codex|${config.cli}`, sig, version);
      return version;
    };
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...cloudTurnEnvironment("codex", { ...process.env, ...input.environment }),
        PATH: augmentedPath(),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal).
      delete env.OPENAI_API_KEY;
      // The harness process may hold workspace credentials (xai/box/voice
      // keys, env-injected at boot); none of them are this CLI's to see.
      stripWorkspaceCredentialEnv(env);
      // An ambient OPENAI_BASE_URL/OPENAI_MODEL from a provider switcher in
      // the user's shell would point the CLI's own ChatGPT login at a third
      // party. Runs before codexLocalProviderArgs, which re-sets its own.
      stripRoutingEnv(env);
      return env;
    };
    const catalogEnv = childEnv();
    let models = STATIC_CODEX_MODELS;
    const refreshModels = async () => {
      try {
        const officialOptions = models.options.filter(option => !option.custom && !option.id.includes("::"));
        const officialFallback = officialOptions.length ? {
          default: officialOptions.some(option => option.id === models.default) ? models.default : officialOptions[0].id,
          options: officialOptions,
        } : STATIC_CODEX_MODELS;
        const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli, officialFallback);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when a local provider is down.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => Promise<boolean>;
      turnId: string;
      asks: Map<string, AskFinish>;
    }
    const active = new Map<string, Turn>();
    // Rule 72: the one counter of narrowing denials; Rule 67: the incident line the bot's next Codex turn carries.
    const narrowDenials = new NarrowDenials();
    const incidentNotes = new Map<string, string>();
    const settledTotals = new Map<string, { input: number; output: number; cachedInput: number }>();

    // One warm app-server per chat thread, kept between turns while every
    // spawn input is unchanged and recycled otherwise.
    const retained = new Map<string, Retained>();
    const closingProcs = new Set<Promise<boolean>>();
    const stuck = new Map<Retained, string>();
    const configuredIdleMinimum = Number(process.env.MURAGE_CODEX_SESSION_IDLE_MIN_MS);
    const idleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0 ? configuredIdleMinimum : 10_000;
    const SESSION_IDLE_MS = Math.max(idleMinimum, Number(process.env.MURAGE_CODEX_SESSION_IDLE_MS) || 15 * 60_000);
    const closeProcess = (r: Retained, threadId: string, why: string): Promise<boolean> => {
      if (r.closing) return Promise.resolve(true);
      r.closing = true;
      if (r.idleTimer) clearTimeout(r.idleTimer);
      r.detachIdle();
      warmPool.release(r);
      // a process we are killing may still emit; nothing is listening
      r.child.on("error", () => {});
      r.cred?.dispose();
      // The reason a warm process was not kept, where diagnostics can see it.
      console.info(`codex close thread=${threadId} reason=${why}`);
      killCliTree(r.child);
      const done = awaitCliTreeStopped(r.child);
      closingProcs.add(done);
      // A process that did not stop stays owned until it does.
      void done.then((stopped) => {
        closingProcs.delete(done);
        if (!stopped) stuck.set(r, threadId);
      }, () => { closingProcs.delete(done); stuck.set(r, threadId); });
      return done;
    };
    /** Waits for closes in flight and retries every process that would not stop. False if any survives. */
    const retryStuck = async (only?: string): Promise<boolean> => {
      const results = await Promise.all([...stuck].filter(([, owner]) => only === undefined || owner === only).map(async ([r]) => {
        killCliTree(r.child);
        const stopped = await awaitCliTreeStopped(r.child).catch(() => false);
        if (stopped) stuck.delete(r);
        return stopped;
      }));
      return !results.includes(false);
    };
    const drainClosing = async (): Promise<boolean> => {
      await Promise.all([...closingProcs].map((p) => p.catch(() => false)));
      return retryStuck();
    };
    const closeRetained = (threadId: string, why: string, only?: Retained): Promise<boolean> => {
      const r = retained.get(threadId);
      if (!r || (only && r !== only)) return Promise.resolve(true);
      retained.delete(threadId);
      return closeProcess(r, threadId, why);
    };
    /** > 0 while Murage removes a deleted conversation from the engine's files (holdIdle): nothing is kept idle or warmed. */
    let idleHeld = 0;
    const armIdle = (threadId: string, r: Retained, hold = false) => {
      if (idleHeld > 0) { void closeRetained(threadId, "deletion-hold", r); return; }
      if (r.idleTimer) clearTimeout(r.idleTimer);
      r.idleTimer = setTimeout(() => void closeRetained(threadId, "idle", r), SESSION_IDLE_MS);
      r.idleTimer.unref?.();
      void warmPool.markIdle(r, {
        engine: "codex",
        threadId,
        pid: () => r.child.pid,
        spawnedAt: spawnedAtOf(r.child),
        scope: { kind: "codex", bot: r.bot ?? null },
        background: backgroundThreads.has(threadId),
        hold,
        close: (reason) => void closeRetained(threadId, reason, r),
      });
    };
    /** Between turns nobody reads the app-server: drain it, refuse anything
     * that asks for a decision, and drop the process if it dies or errs. */
    const attachIdle = (threadId: string, r: Retained) => {
      // The connection's one splitter now feeds this handler.
      r.conn.onLine = (line) => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg?.id === undefined || typeof msg.method !== "string") return;
        try {
          r.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...idleRefusal(msg.method) }) + "\n");
        } catch {}
        void closeRetained(threadId, "permission ask while idle", r);
      };
      r.conn.onOverflow = () => void closeRetained(threadId, "frame too large while idle", r);
      const onStderr = () => {};
      const onError = () => void closeRetained(threadId, "process error", r);
      const onClose = () => void closeRetained(threadId, "process exited", r);
      r.child.stderr.on("data", onStderr);
      r.child.on("error", onError);
      r.child.on("close", onClose);
      r.detachIdle = () => {
        r.child.stderr.off("data", onStderr);
        r.child.off("error", onError);
        r.child.off("close", onClose);
        r.detachIdle = () => {};
      };
    };

    /** Turn ids of intent warms: the engine starts but no turn exists, so nothing carrying one reaches a listener. */
    const prewarmTurnIds = new Set<string>();
    const emit = (event: RuntimeEvent) => {
      if (prewarmTurnIds.has((event as { turnId?: string }).turnId ?? "")) return;
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const backgroundThreads = new Set<string>();
    /** The spawn inputs of each thread's last user turn, memory only (never written to
     * disk): what an intent warm starts the next engine from. */
    const lastTurns = createTurnMemory<SendTurnInput>();
    const prewarming = createPrewarmGate();
    /** The process each in-flight prewarm owns right now (read live, so a relaunch is
     * followed), for a takeover to end through its owned process tree. */
    const prewarmChildren = new Map<string, () => ReturnType<typeof spawnCli> | undefined>();
    const sendTurn = async (turn: SendTurnInput) => {
      if (!turn.prewarm) {
        if (turn.background) backgroundThreads.add(turn.threadId); else backgroundThreads.delete(turn.threadId);
        if (!turn.background) { warmPool.noteUserActivity(); warmPool.sent(turn.threadId); lastTurns.remember(turn.threadId, spawnInputsOf(turn)); }
        // An intent warm is still starting this thread's engine: take it over, never fail as busy.
        if (prewarming.has(turn.threadId) && !(await prewarming.wait(turn.threadId))) {
          // cancel it, wait for its slot, end the process it owns if it will not go: all
          // within one hard bound, after which this send fails clearly (never "already running")
          const freed = await prewarming.takeOver(turn.threadId, {
            stop: () => active.get(turn.threadId)?.stop(),
            child: () => prewarmChildren.get(turn.threadId)?.(),
            slotBusy: () => active.has(turn.threadId),
          });
          if (!freed) {
            console.warn(`codex prewarm takeover thread=${turn.threadId} failed=true reason=prewarm did not stop within bound`);
            throw new Error(TAKEOVER_FAILED_MESSAGE);
          }
        }
      }
      // A process of this thread that would not stop is still owned: nothing new may start
      // beside it until it is confirmed gone.
      if ([...stuck.values()].includes(turn.threadId) && !(await retryStuck(turn.threadId))) {
        console.warn(`codex dispatch thread=${turn.threadId} refused=true reason=previous process still stopping`);
        throw new Error(`${ENGINE} from an earlier start of this conversation has not closed yet, so this message was not sent. Try again in a moment; restart Murage if it keeps happening.`);
      }
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      // Wakes a retry backoff the moment Stop arrives, so the logical turn
      // settles now rather than after the full wait (U06).
      const stopSignal = new AbortController();
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      if (turn.sessionReset || typeof turn.resumeCursor !== "string") settledTotals.delete(threadId);
      let baseline = settledTotals.get(threadId);
      const turnId = newId();
      if (turn.prewarm) prewarmTurnIds.add(turnId);
      /** The warm is over: waiting sends may go. The turn id stays silenced until the final
       * event of the warm has been dropped (`forgetPrewarm`). */
      const endPrewarm = () => { if (turn.prewarm) { prewarmChildren.delete(threadId); prewarming.end(threadId); } };
      const forgetPrewarm = () => { if (turn.prewarm) prewarmTurnIds.delete(turnId); };
      // The dispatch slot is held from here until the turn settles, so nothing
      // that waits before the launch (a settle probe) leaves the thread looking
      // idle. Its stop only records the request; the dispatch checks it.
      const slot: Turn = {
        stop: async () => { stopRequested = true; stopSignal.abort(); return true; },
        turnId,
        asks: new Map(),
      };
      active.set(threadId, slot);
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");
      /** sendTurn has handed the turn id back: a refused submission from here
       * on settles the turn itself (no caller is left to stop it by id). */
      let handedBack = false;

      // Murage's Full access still stops before deleting outside its folder, paying and messaging someone
      // new (see the approval notes below): under it a fullAuto instance asks (`untrusted`).
      const enforceApproval = turn.stopLine === true || (turn.routeAsks === true && config.fullAuto);
      // One policy for thread/start, thread/resume and the Cloud render of a resumed thread.
      const codexPolicy: CloudCodexPolicy = {
        approval: enforceApproval ? "untrusted" : config.fullAuto ? "never" : "on-request",
        sandbox: turn.proposalOnly ? "read-only" : config.fullAuto ? "danger-full-access" : "workspace-write",
      };
      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        // The launcher scopes this turn's state (conversation files, the bot's own sign-in) by bot.
        cloudTurnBot(env, turn.warmIdentity?.botId);
        // Flux Router's Responses surface. This slot is the only correct one:
        // childEnv() has just deleted FLUX_API_KEY (WORKSPACE_CREDENTIAL_ENV,
        // config.ts:549) and the ambient routing vars, so the key has to be
        // re-read from config/process.env by fluxKey() and re-injected under a
        // harness-owned name AFTER the strip — and the provider table only ever
        // exists as argv, which must be complete before spawnCli below.
        //
        // Gated on the codex-qualified id shape (`flux::flux-auto`). A bare
        // `flux-auto` decodes to OFFICIAL_CODEX_PROVIDER (codex-catalog.ts:57)
        // and is refused at spawn (index.ts:2508); it must not half-apply a
        // provider table here that thread/start would never select.
        const flux = !turn.providerRoute && fluxIdIsRoutable(turn.model, DRIVER_KIND)
          ? applyFluxSurface(DRIVER_KIND, env, turn.model, fluxKey())
          : null;
        // Flux Memory: the table this thread starts under. The headers live in
        // three provider tables declared once in argv (flux-routing.ts), so the
        // shared app-server is never recycled for an audience change; the warm
        // key below carries the choice so a change still re-evaluates the thread.
        const fluxMemory = fluxMemoryDecision(fluxMemoryContextForTurn(turn));
        const fluxProvider = codexFluxProviderFor(fluxMemory);
        const providerBinding = turn.providerRoute ? applyProviderRoute(DRIVER_KIND, env, turn.providerRoute) : null;
        // A Flux connection (a named provider route) carries the headers on its own table.
        if (providerBinding?.modelProvider && turn.providerRoute?.preset === "flux") {
          providerBinding.args.push(...codexHttpHeaderArgs(providerBinding.modelProvider, fluxMemory.headers));
          logFluxMemoryHeaders(DRIVER_KIND, fluxMemory);
        }
        // Cloud home: the launcher renders every provider table into config.toml from a typed
        // route and refuses `-c model_providers.*` (CLOUD-ENGINES-DESIGN.md 4.1). A home has no
        // local model servers of its own; a Flux model rides the route's key variable.
        const cloudHome = process.env.MURAGE_CLOUD_ROLE === "home";
        if (cloudHome && flux?.applied) {
          const key = env[FLUX_CODEX_ENV_KEY];
          delete env[FLUX_CODEX_ENV_KEY];
          env.MURAGE_PROVIDER_API_KEY = key;
          cloudTurnRender(env, "route", { provider: FLUX_CODEX_PROVIDER, baseUrl: FLUX_RESPONSES_BASE, model: flux.model ?? "", apiKey: key ?? "", label: "Flux Router" });
        }
        const appServerArgs = [
          "app-server",
          ...(providerBinding || cloudHome ? [] : await codexLocalProviderArgs(env, turn.model)),
          ...(cloudHome ? [] : flux?.args ?? []),
          ...(providerBinding?.args ?? []),
          // Codex has no metadata for a `flux-*` id and falls back to a
          // 258400-token window (probed: `modelContextWindow` in
          // thread/tokenUsage/updated). Flux advertises the real window only
          // in the `x-flux-model-window` response header, which the CLI never
          // sees, and it varied 129024 <-> 1000000 between calls on the same
          // alias (flux-router-spec.md 6.6). Over-estimating is the one-way
          // failure: codex would compact too late and the turn dies on an
          // upstream context-length error mid-thread. So assume the observed
          // floor, exactly as the spec says to. Only set for a Flux turn.
          ...(flux?.applied ? ["-c", `model_context_window=${FLUX_CONTEXT_FLOOR}`] : []),
          ...CODEX_TOOL_SURFACE_ARGS,
          // Codex's own memories (distilled from past sessions into ~/.codex/memories) cross bots and
          // people; what a bot remembers is Murage's to fence.
          "-c", "features.memories=false",
          ...(turn.proposalOnly ? CODEX_PROPOSAL_ARGS : []),
        ];
        // Servers are collected first: per-turn secrets leave their env for the
        // process's credential file before anything reaches argv or env.
        const mounts: Array<{ name: string; server: StdioMcpServer; preApproved: boolean; mountId: string }> = [];
        const mount = (name: string, server: StdioMcpServer, preApproved: boolean, mountId: string) => { mounts.push({ name, server, preApproved, mountId }); };
        if (turn.integrations?.composio) {
          // Connected apps are where a bot pays and messages: at Full (stopLine)
          // and below it (routeAsks) their calls reach Murage's broker.
          mount("murage_connectors", turn.integrations.composio, !turn.stopLine && !turn.routeAsks, "own:connector");
        }
        // The phone and the browser are mounted below, under these names.
        const murageMounts: { agents?: string; memory?: string; phone?: string; browser?: string } = {
          ...(turn.integrations?.phone ? { phone: CODEX_PHONE_MOUNT } : {}), ...(turn.integrations?.browser ? { browser: "browser" } : {}) };
        if (turn.integrations?.agents) {
          murageMounts.agents = "agents";
          mount(murageMounts.agents, turn.integrations.agents, true, "own:agents");
        }
        if (turn.integrations?.memory) {
          murageMounts.memory = "murage-memory";
          mount(murageMounts.memory, turn.integrations.memory, true, "own:memory");
        }
        turn = renderMurageTurn(turn, CODEX_TOOL_SURFACE, murageMounts);
        if (turn.integrations?.computer) {
          const proxyEnv = computerProxyEnv(turn.integrations.computer);
          mount("computer", {
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
          }, true, "own:computer");
        } else if (turn.integrations?.localComputer) {
          // The host daemon and isolated Local VM both arrive as a direct Cua
          // Driver stdio MCP server. Codex sees the same computer tool surface.
          mount("computer", turn.integrations.localComputer, true, "own:computer");
        }
        if (turn.integrations?.browser) {
          mount("browser", turn.integrations.browser, true, "own:browser");
        }
        // A custom server named like one in the owner's own config.toml would
        // be MERGED with it by the `-c` override, not replace it: a stdio
        // command over a remote `url` entry is "invalid configuration" and
        // kills the turn before the model is asked, and any
        // default_tools_approval_mode left in the owner's table silently
        // un-cards the server that was mounted below with preApproved:false.
        // Such a server gets a mount name of its own.
        const declaredInCodexConfig = codexConfigMcpServerNames(env);
        // The servers that actually get mounted, chosen BEFORE any name is
        // allocated: a skipped server must not reserve its name, and a moved
        // server must not land on a sibling's.
        const customMcpServers = customMountEntries(turn.integrations?.custom, (name) => name === "murage-memory")
          .map((mount): [string, { command: string; args: string[]; env: Record<string, string> }] => [mount.name, { command: mount.command, args: mount.args, env: mount.env }])
          // Rule 11: a name holding `__` cannot be told apart from its tools,
          // so it is not mounted and no record is written for it.
          .filter(([name]) => {
            if (!name.includes("__")) return true;
            noteRefusedMcpServer(name);
            return false;
          });
        const mountNames = mountedMcpServerNames(
          customMcpServers.map(([name]) => name),
          declaredInCodexConfig,
        );
        for (const [name, server] of customMcpServers) {
          const mountName = mountNames.get(name) ?? name;
          if (mountName !== name) {
            noteRenamedMcpServer(
              name,
              mountName,
              declaredInCodexConfig.kind === "unreadable"
                ? `Codex's own config.toml could not be read (${declaredInCodexConfig.why}), so every name is treated as taken`
                : "it is also declared in Codex's own config.toml",
            );
          }
          // An alias can only reach `__` through a name ending in `_`; it is
          // refused like the name itself.
          if (mountName.includes("__")) {
            noteRefusedMcpServer(name);
            continue;
          }
          mount(mountName, server, false, `custom:${name}`);
        }
        // Cloud home: no server-side credential file (the turn cannot read the server's /tmp); secrets stay inline.
        const { stableServers, secrets } = turn.warmIdentity && process.env.MURAGE_CLOUD_ROLE !== "home"
          ? splitTurnSecrets(Object.fromEntries(mounts.map((m) => [m.name, m.server])))
          : { stableServers: Object.fromEntries(mounts.map((m) => [m.name, m.server])), secrets: {} };
        if (cloudHome) {
          // The launcher renders [mcp_servers.*] from its own proxy table and puts each proxy's
          // variables in the engine environment under env_vars (design 2.3, 5.3). A server
          // the home cannot express (an owner's stdio command) is not mounted there.
          const stanzas: Record<string, CloudMcpStanza> = {};
          for (const m of mounts) {
            const stanza = cloudMcpStanza(m.server, { ask: !m.preApproved });
            if (stanza) stanzas[m.name] = stanza;
          }
          const phone = turn.integrations?.phone ? cloudMcpStanza(turn.integrations.phone) : null;
          if (phone) stanzas[CODEX_PHONE_MOUNT] = phone;
          cloudTurnRender(env, "mcp", Object.keys(stanzas).length ? stanzas : undefined);
        } else for (const m of mounts) mountMcpServer(appServerArgs, env, m.name, stableServers[m.name] as StdioMcpServer, m.preApproved);
        // The owner's global AGENTS.md / AGENTS.override.md and personal skills
        // folder out of this app-server: a scoped CODEX_HOME on a proven Codex
        // (codex-isolation.ts). Set on the child's env only after every read of
        // the owner's real home above and below (codexHome is resolved first).
        // A provider route brings its own Codex home; that one is Murage's already.
        let scopedHome: string | null = null;
        // Item 1: the per-version policy. Below the version that retired the ask-for-everything value the driver sends what it always
        // sent; from there `on-request` runs only behind the Rule 68 gate, and a build that cannot carry the gate is refused here.
        let gatePlan: CodexGatePlan = { mode: "legacy" };
        let shellFormPinned = false;
        try {
          if (!providerBinding && !cloudHome) {
            const preparingId = `preparing-${turnId}`;
            let preparing = false;
            try {
              await awaitScopeStart("codex", () => { preparing = true; emit({ ...base(threadId, turnId), type: "item.started", itemId: preparingId, itemType: "tool", origin: "murage", title: "Preparing Codex..." }); }, ENGINE);
            } finally {
              if (preparing) emit({ ...base(threadId, turnId), type: "item.completed", itemId: preparingId, itemType: "tool", ok: true });
            }
          }
          // Fails closed: contention is retried within a bound; a scope that cannot be established rejects the turn before any spawn.
          // An unknown version is probed once more before the turn is rejected (the owner is told to update Codex).
          // (A Cloud home runs the image's own Codex: no version probe, no scoped home, and the launcher renders config.toml and the
          // effective policy, so the Rule 68 gate, its -c pins and the shell-form -c pins are not sent there; it refuses any other -c.)
          const probedVersion = providerBinding || cloudHome ? undefined : (await codexVersionForTurn(env)) ?? (await codexVersionForTurn(env, true));
          // A provider route still needs the version to spell the approval policy and to choose the gate.
          if (providerBinding && !cloudHome) await codexVersionForTurn(env);
          const versionNow = probedVersion ?? (providerBinding ? codexVersion || undefined : undefined);
          gatePlan = cloudHome ? { mode: "legacy" } : codexGatePlan(versionNow);
          if (gatePlan.mode === "refuse") throw engineUpdateRequired(ENGINE, versionNow, CODEX_GATE_MIN);
          // Rule 68a: the gate lives in the scoped home, so a gated provider-route turn gets one (or is refused as scope_unavailable);
          // a legacy provider-route turn keeps the provider's own home as before.
          scopedHome = cloudHome || (providerBinding && gatePlan.mode !== "gated") ? null : await withScopeRetry(() => scopedCodexHome(env, versionNow, turn.warmIdentity?.botId), ENGINE);
          // Rule 68a: the gate lives only in a scoped home. A gated plan with none (an env naming a path under the scopes folder that is
          // no scope) is refused here, before any spawn, never run with on-request and no hook.
          if (gatePlan.mode === "gated" && scopedHome === null) {
            throw new ScopeUnavailableError(`${ENGINE}'s own engine folder could not be set up, so its pre-execution gate cannot run.`, false, { code: "unavailable", engine: ENGINE });
          }
          if (gatePlan.mode === "gated") {
            // A retired approval policy in the owner's copied config.toml would stop a current Codex before it starts; hooks on, once.
            appServerArgs.push(...CODEX_APPROVAL_PIN_ARGS, "-c", "features.hooks=true");
          }
          // Rule 74: no login shell, the handed environment whole, the pins as policy, the shell-form features off.
          // (pushed once the environment is handed below: the policy's `set` is that hand's resolved pin map)
          shellFormPinned = !cloudHome && versionAtLeast(versionNow, CODEX_GATE_MIN);
        } catch (error) {
          if (!(error instanceof ScopeUnavailableError)) throw error;
          // The turn id is already handed back, so the rejection is the turn's own failure: a structured error the chat words in
          // the owner's language (localFailure + engine), and no process is started.
          if (active.get(threadId) === slot) active.delete(threadId);
          if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: error.message, localFailure: scopeLocalFailureOf(error), ...(error.engine ? { localFailureEngine: error.engine } : {}) });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "scope_unavailable", cost: null });
          endPrewarm(); forgetPrewarm();
          return;
        }
        // The owner's own servers and personal skills off for this app-server (codex-isolation.ts).
        // (A Cloud home renders its own config.toml through the launcher: no owner servers or skills to turn off there.)
        if (!cloudHome) appServerArgs.push(...codexIsolationArgs(env, declaredInCodexConfig,
          new Set([...mounts.map((m) => m.name), ...(turn.integrations?.phone ? [CODEX_PHONE_MOUNT] : [])])));
        if (turn.integrations?.phone && !cloudHome) {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          const prefix = `mcp_servers.${CODEX_PHONE_MOUNT}`;
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.tool_timeout_sec=${CODEX_MCP_TOOL_TIMEOUT_SEC}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }

        // Cloud home: the engine home is the default working directory, never the server uid's own.
        const turnCwd = turn.cwd ?? (process.env.MURAGE_CLOUD_ROLE === "home" ? cloudEngineHome("codex") : homedir());
        // What this turn needs of a process, minus per-turn secrets and the
        // credential file's own path. Everything that can carry a secret is
        // keyed by its hash only: the complete effective spawn environment
        // (provider and Flux keys, mounted servers' env), each MCP server
        // definition, and the argv.
        const digest = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
        // Rule 74a..b: the engine is handed the finished F12 map as its explicit env (the owner's toolchain environment, Codex's own
        // KEY/SECRET/TOKEN strip, the driver's names, the pins last), and every ask reports it.
        const processEnv: NodeJS.ProcessEnv = process.env;
        const driverNames: Record<string, string> = {};
        for (const [name, value] of Object.entries(env)) if (typeof value === "string" && name !== "PATH" && processEnv[name] !== value) driverNames[name] = value;
        for (const [name, value] of Object.entries(input.environment ?? {})) if (typeof value === "string" && env[name] === value && name !== "PATH") driverNames[name] = value;
        if (scopedHome) driverNames.CODEX_HOME = scopedHome;
        // The captured map loses every provider routing and credential name (childEnv's strips ran on this process's
        // environment only, and a Finder launch's capture holds names it never had); this turn's values of the ones that
        // are not secrets come back, and the driver's own keys come back through driverNames.
        const ownedNames = Object.fromEntries(Object.entries(ownedTurnNames(env, stripCapturedProviderEnv)).filter(([name]) => !/KEY|SECRET|TOKEN/i.test(name)));
        const handed: HandedEnv = await handedEngineEnv({
          strip: (map) => {
            for (const name of Object.keys(processEnv)) if (!(name in env)) delete map[name];
            stripCapturedProviderEnv(map);
            for (const name of Object.keys(map)) if (/KEY|SECRET|TOKEN/i.test(name)) delete map[name];
            return map;
          },
          extra: { ...ownedNames, ...driverNames },
          cwd: turn.cwd ?? homedir(),
        }, env); // a Cloud home hands the pins on top of this turn's cloudTurnEnvironment map
        if (shellFormPinned) appServerArgs.push(...codexShellFormArgs(handed.pins));
        const mountRefs = connectorMountRefsOf(stableServers, secrets, threadId);
        const warm: WarmKey = warmKey({
          bot: turn.warmIdentity?.botId ?? null,
          thread: threadId,
          audience: turn.warmIdentity ? [turn.warmIdentity.audience, turn.warmIdentity.decidedOwner === true, turn.warmIdentity.humanPrincipal ?? null] : null,
          stopLine: turn.stopLine === true,
          // below-Full asks route to Murage's broker (int3): a permission change, so it recycles
          routeAsks: turn.routeAsks === true,
          proposalOnly: turn.proposalOnly === true,
          model: turn.model ?? null,
          providerRoute: turn.providerRoute ? [turn.providerRoute.connectionId, turn.providerRoute.revision] : null,
          fluxMemory: flux?.applied ? fluxProvider : null,
          cwd: turnCwd,
          mcp: Object.fromEntries(Object.entries(stableServers).map(([name, server]) => [name, digest(server)])),
          // the bot's connected-app access: a change relists the tools by recycling
          connectorScope: connectorScopeOf(secrets),
          env: digest({ env, handed: handed.env }),
          settingsRev: codexSettingsRevision(env),
          // the scope's login generation this process runs on: a new generation never reuses a process on the older one
          scopeHome: scopedHome,
          args: digest(appServerArgs),
        });
        for (const name of Object.keys(env)) delete env[name];
        Object.assign(env, handed.env);
        if (scopedHome) env.CODEX_HOME = scopedHome;
        const shellForm: readonly string[] = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-Command"] : [handed.env.SHELL || "/bin/sh", "-c"];
        // 1.0.4 F1: every command runs under this form, so the gates read its
        // text in this form's dialect (PowerShell on Windows)
        const commandShell = shellDialectOf(shellForm);
        // F4 (Rule 54): the mounts this app-server loads, read from the Codex
        // home in effect for the spawn. A config.toml that cannot be read
        // leaves the list unstated, so no MCP ask on this turn is proven.
        const mcpMountRecords: McpMountRecord[] | undefined = (() => {
          const own: McpMountRecord[] = mounts.map((m) => ({
            engineName: m.name,
            mountId: m.mountId,
            provenance: m.mountId.startsWith("custom:") ? "custom" : "own",
          }));
          if (turn.integrations?.phone) own.push({ engineName: CODEX_PHONE_MOUNT, mountId: "own:phone", provenance: "own" });
          const external = externalMcpRecords(env, new Set(own.map((r) => r.engineName)));
          return external.kind === "records" ? [...own, ...external.records] : undefined;
        })();

        // Reuse the retained app-server when it is idle, unchanged and holds
        // the conversation the harness wants resumed; otherwise close it and
        // spawn fresh. Only a first attempt may adopt: a relaunch is always a
        // new process launched by this turn.
        let reuse: Retained | null = null;
        let spawnReason: string | null = null;
        if (attempt === 0) {
          let live = retained.get(threadId);
          // A settle-time probe may still be deciding whether this process stays.
          // The thread's dispatch slot is already held, so a second send is
          // refused as busy and Stop during this wait is seen below.
          if (live?.settleCheck) {
            await live.settleCheck;
            live = retained.get(threadId);
          }
          // Headroom for one more engine: evicts an idle one if needed, never refuses.
          if (!live) await warmPool.beforeSpawn();
          // A prewarm never starts an engine while Murage removes a deleted conversation from the engine's files (holdIdle).
          if (turn.prewarm && idleHeld > 0 && !live) {
            if (active.get(threadId) === slot) active.delete(threadId);
            endPrewarm(); forgetPrewarm();
            return;
          }
          if (stopRequested || active.get(threadId) !== slot) {
            if (stopRequested) {
              void closeRetained(threadId, "stop");
              if (active.get(threadId) === slot) active.delete(threadId);
              emit({ ...base(threadId, turnId), type: "turn.started" });
              emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
            }
            endPrewarm(); forgetPrewarm();
            return;
          }
          const cursorNow = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          spawnReason = !turn.warmIdentity ? "no-warm-identity"
            : !live ? "no-process"
            : turn.sessionReset ? "sessionReset"
            : live.conn.buffered() > 0 ? "partial-frame"
            : live.child.exitCode !== null || live.child.signalCode !== null ? "process-exited"
            : pastWarmMaxAge(spawnedAtOf(live.child)) ? "max-age"
            // Rule 68c with Rule 67: an incident voided this process's proof, so the next turn runs the whole handshake on a new one
            : live.proof?.voided ? "hook-proof-void"
            : live.proof && scopedHome !== null && !live.proof.sameHookConfig(hookConfigOf(scopedHome)) ? "hook-config-changed"
            : diffWarmKey(live.warm, warm) ?? (cursorNow && cursorNow !== live.codexThreadId ? "cursor" : null)
              // Codex lists a server's tools once: an engine that was handed only the stand-in list is replaced
              ?? (anyMountIncomplete(mountRefs) ? "connector-mount-incomplete" : null);
          if (spawnReason !== null && live && !turn.prewarm) clearMountsIncomplete(mountRefs);
          console.info(`codex dispatch thread=${threadId} process=${spawnReason === null ? "reused reason=unchanged" : `spawned reason=${spawnReason}`}`);
          if (turn.prewarm && live) {
            // an engine is already live on this thread: nothing to warm
            if (active.get(threadId) === slot) active.delete(threadId);
            endPrewarm(); forgetPrewarm();
            return;
          }
          if (live && spawnReason === null) {
            // adopt synchronously: nothing awaits between the check and here
            retained.delete(threadId);
            live.detachIdle();
            warmPool.release(live);
            if (live.idleTimer) clearTimeout(live.idleTimer);
            try {
              live.cred?.write(secrets);
              reuse = live;
            } catch {
              spawnReason = "credential write failed";
              void closeProcess(live, threadId, "credential write failed");
            }
          } else if (live) {
            void closeRetained(threadId, turn.sessionReset ? "context reset" : spawnReason === "max-age" ? "max-age" : `spawn contract changed: ${spawnReason}`);
          }
        } else {
          console.info(`codex dispatch thread=${threadId} process=spawned reason=retry`);
        }
        let cred: TurnCredentialStore | null = reuse?.cred ?? null;
        if (!reuse && Object.keys(secrets).length) {
          cred = createTurnCredentialStore();
          cred.write(secrets);
        }
        const spawnArgs = cred ? bindCredentialPathInArgs(appServerArgs, cred.path) : appServerArgs;
        // Rule 68: one socket per app-server process; the files of the gate are written into the scope for every gated turn (hooks.json
        // never changes, so its trust holds; the env file carries this turn's token).
        const gated = gatePlan.mode === "gated" && scopedHome !== null; // a gated plan always has its scope (thrown above otherwise)
        const hookToken = newHookToken();
        let hookGate: CodexHookGate | undefined = reuse?.hookGate;
        if (gated && !hookGate) {
          hookGate = new CodexHookGate();
          await hookGate.listen();
        }
        const hookFiles = gated && hookGate ? writeHookFiles(scopedHome!, hookGate.path, hookToken) : null;
        // Windows: the hooks.json command is `%MURAGE_CODEX_HOOK%` (codex-hook.ts); the launch line it expands to rides in this
        // process's environment, which Codex hands each hook it runs.
        if (hookFiles && !reuse && process.platform === "win32") env[CODEX_HOOK_LAUNCH_ENV] = hookLaunchLine(process.execPath, hookFiles.script);
        // the process's SessionStart proof, kept with it between turns
        const proof: HookProof | undefined = reuse?.proof ?? (gated ? new HookProof(hookConfigOf(scopedHome!)) : undefined);
        // On a home the launcher stages only the rollout this process will thread/resume (its
        // state allowlist); a process that starts a new thread names none.
        // A resumed thread names the policy it runs under: the launcher renders it as the effective one.
        if (!reuse && process.env.MURAGE_CLOUD_ROLE === "home") {
          const resumeId = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : undefined;
          cloudTurnRender(env, "resume", resumeId);
          cloudTurnRender(env, "codexPolicy", resumeId ? codexPolicy : undefined);
        }
        let child: ReturnType<typeof spawnCli>;
        try {
          child = reuse ? reuse.child : spawnCli(config.cli, spawnArgs, {
            cwd: turnCwd,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (error) {
          if (!reuse) hookGate?.close();
          throw error;
        }
        if (!reuse && hookGate) { const owned = hookGate; child.once("exit", () => owned.close()); }
        // One id counter, one baseline and one frame splitter per process,
        // across the turns on it. Byte-bounded framing (A4): UTF-8 is decoded
        // per complete line, so a multibyte character split across reads
        // stays intact, and one frame never holds more than
        // ENGINE_FRAME_MAX_BYTES of the shared process.
        const conn: Conn = reuse?.conn ?? (() => {
          const made: Conn = { nextId: 1, baseline: undefined, onLine: () => {}, onOverflow: () => {}, buffered: () => 0 };
          const lines = createBoundedLineSplitter({ onLine: (line) => made.onLine(line), onOverflow: (overflow) => made.onOverflow(overflow) });
          made.buffered = () => lines.bufferedBytes;
          child.stdout.on("data", (chunk: Buffer) => lines.push(chunk));
          registerIntake(threadId, child.stdout, child);
          return made;
        })();
        const ownsProcess = !reuse;
        if (turn.prewarm && ownsProcess) prewarmChildren.set(threadId, () => child);
        const unsubscribe: Array<() => void> = [];
        const on = <E extends { on(event: any, fn: any): unknown; off(event: any, fn: any): unknown }>(emitter: E, event: string, fn: (...args: any[]) => void) => {
          emitter.on(event, fn);
          unsubscribe.push(() => emitter.off(event, fn));
        };

      let abandoned = false;
      const state = {
        settled: false,
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running THREAD total; the harness
        // wants this turn's figure, so the last report is banked on settle
        total: undefined as { input: number; output: number; cachedInput: number } | undefined,
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
      };

      // Sub agents (Codex "collab" tool calls) are other threads on this
      // app-server. They keep running, and keep asking, after the parent's
      // turn/completed, so the turn is held until they finish.
      const helpers = {
        tracker: new SubtaskTracker(),
        open: new Set<string>(),
        tools: new Map<string, number>(),
        holding: false,
        woken: false,
        cap: undefined as ReturnType<typeof setTimeout> | undefined,
        grace: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      const HELPER_WAKE_GRACE_MS = Number(process.env.MURAGE_CODEX_WAKE_GRACE_MS) > 0 ? Number(process.env.MURAGE_CODEX_WAKE_GRACE_MS) : 5_000;

      const asks = new Map<string, AskFinish>();
      let codexThreadId: string | null = null;
      let codexTurnId: string | null = null;
      let awaitingTurnStart = false;
      // Set just before turn/start is written. From then on the engine may
      // have accepted the turn, so a crash is never replayed (U-17).
      let turnStartSent = false;
      // thread/compact/start answers `{}`: its turn is named only by the
      // notifications that follow, so the first one on this thread names it.
      let adoptFirstTurn = false;
      let earlyNotificationBytes = 0;
      const earlyNotifications: any[] = [];
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000, onResult?: (v: any) => void) =>
        new Promise<any>((resolve, reject) => {
          const id = conn.nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(codexRpcTimeoutMessage(method, timeoutMs, ENGINE)));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              // The line splitter may process the ACK and notifications in
              // one read. Bind native identity before resolving the Promise;
              // an await continuation would run after those notifications.
              try {
                onResult?.(v);
              } catch (e) {
                reject(e);
                return;
              }
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      let stopping: Promise<boolean> | undefined;
      const terminate = () => stopping ??= (() => {
        // the process is going away: its credential file goes with it
        cred?.dispose();
        killCliTree(child);
        return awaitCliTreeStopped(child).then((stopped) => {
          if (!stopped) stopping = undefined;
          return stopped;
        });
      })();
      let completeStoppedTurn: (() => void) | undefined;
      let lastProviderError: string | undefined;
      const stop = async () => {
        stopRequested = true;
        stopSignal.abort();
        const stopped = await terminate();
        if (stopped) completeStoppedTurn?.();
        return stopped;
      };

      const settle = async (ok: boolean, stopReason: string | null): Promise<void> => {
        if (state.settled) return;
        if (ok && refusal.refused) return settle(false, incidentRaised ? "gate_incident" : "scope_unavailable");
        // Rule 68c: a refused turn never ends clean. A clean end on a gated process whose hook is not yet proven waits for the proof;
        // unproven, the refusal settles it.
        if (ok && hookGate && !refusal.hookLive) {
          if (!(await proveLiveness())) return;
          if (state.settled) return;
        }
        state.settled = true;
        if (helpers.cap) clearTimeout(helpers.cap);
        if (helpers.grace) clearTimeout(helpers.grace);
        for (const subtask of helpers.tracker.endAll(false)) emit({ ...base(threadId, turnId), type: "turn.subtask", subtask, subtasks: helpers.tracker.snapshot() });
        earlyNotifications.length = 0;
        earlyNotificationBytes = 0;
        hookGate?.disarm(hookToken);
        narrowDenials.endTurn(turnId);
        const approvalsOpen = asks.size;
        for (const finish of [...asks.values()]) finish("deny", "Murage: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const complete = () => {
          if (active.get(threadId)?.stop !== stop) return;
          active.delete(threadId);
          endPrewarm();
          if (state.total) settledTotals.set(threadId, state.total);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
          forgetPrewarm();
        };
        completeStoppedTurn = complete;
        // Keep the app-server for the next turn only when this one ended
        // cleanly and nothing it started is still running. Every other end
        // closes it, and says why.
        let recycle: string | null = refusal.refused ? "turn refused"
          : stopRequested ? "stop"
          : stopReason === "auth_required" ? "auth required"
          : stopReason === "update_required" ? "update required"
          : !ok ? `turn failed: ${stopReason ?? "unknown"}`
          : helpers.open.size > 0 ? "background work alive at settle"
          : approvalsOpen > 0 ? "approval open at settle"
          : conn.buffered() > 0 ? "partial frame at settle"
          : !turn.warmIdentity ? "no warm identity"
          : child.exitCode !== null || child.signalCode !== null ? "process exited"
          : !codexThreadId ? "no conversation to keep"
          : null;
        // The file is emptied before the process is kept; if it cannot be, the
        // process goes through the normal close path instead.
        if (recycle === null) {
          try { cred?.clear(); } catch { recycle = "credential clear failed"; }
        }
        if (recycle === null) {
          retain(complete);
          return;
        }
        console.info(`codex close thread=${threadId} reason=${recycle}`);
        if (!(await stop())) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: `${ENGINE} did not close after Stop. This conversation stays busy until it does; restart Murage if it stays stuck.` });
        }
      };

      /** The process outlives this turn: hand it to the retained map, switch
       * its streams to the idle sink, and probe it for leftover children
       * before the next dispatch may adopt it. */
      const retain = (complete: () => void) => {
        for (const off of unsubscribe.splice(0)) off();
        const kept: Retained = {
          child, warm, cred, conn, codexThreadId: codexThreadId!, closing: false, bot: turn.warmIdentity?.botId ?? null,
          detachIdle: () => {},
          ...(hookGate ? { hookGate } : {}), handed, ...(proof ? { proof } : {}),
        };
        attachIdle(threadId, kept);
        retained.set(threadId, kept);
        armIdle(threadId, kept, turn.prewarm === true);
        // the next intent warm resumes this conversation
        lastTurns.patch(threadId, { resumeCursor: codexThreadId!, sessionReset: false });
        const pid = child.pid;
        // The check fails closed: no baseline, no probe, or a probe error all
        // mean "not proven idle", so the process is recycled.
        if (!pid) void closeRetained(threadId, "process probe has no baseline");
        else {
          const check: Promise<void> = Promise.resolve().then(async () => {
            const baseline = conn.baseline;
            if (!baseline) return void closeRetained(threadId, "process probe has no baseline", kept);
            const fresh = await untrackedDescendants(pid, baseline);
            if (!fresh) void closeRetained(threadId, "process probe unavailable", kept);
            else if (fresh.size) void closeRetained(threadId, `child processes alive at settle (${fresh.size})`, kept);
          }).catch(() => void closeRetained(threadId, "process probe failed", kept)).finally(() => {
            if (kept.settleCheck === check) kept.settleCheck = undefined;
          });
          kept.settleCheck = check;
        }
        // announced only after the decision is in place: a listener that
        // dispatches again inside the emit must already see the settle check
        complete();
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), a card for the computer's own tools carries
      // approvalScope so the harness's local-computer-block backstop applies
      // to remembered always-allows. A shell command, a file change or
      // another MCP server's tool is judged like any other ask, so a stop
      // line card keeps its scoped choices.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      // Murage's Full access still stops before deleting outside its folder,
      // paying and messaging someone new (server/stop-line.ts), which only
      // holds if Codex asks: every thread and turn runs `on-request`, and
      // Murage answers every ask that is not one of the three at once. The
      // retired policy a current Codex refuses to start with is never sent
      // (codex-isolation.ts codexTurnPolicy).
      // paths each fileChange item announced, so its approval can name them
      const fileChangePaths = new Map<string, string[]>();
      const autoAccept = config.fullAuto && !enforceApproval;
      // Spelled for the installed Codex (0.56..0.66 take camelCase), read when the request is written: the
      // version is probed inside launchAttempt, after this line runs. An unprobed version gets the current spelling.
      const policy = () => codexTurnPolicy(codexVersion || undefined, { proposalOnly: turn.proposalOnly === true, fullAuto: config.fullAuto, enforceApproval });
      // ---- Rules 67 and 68: the PreToolUse gate -----------------------------------------------------------------------------------
      // A hook delivery becomes an ordinary ask through the same request.opened path the approval requests use; Murage's answer goes
      // back to the script as allow or deny. The table of what was answered is what the tripwire and the approval path read.
      const hookTable = new HookDecisionTable();
      // Rules 67 and 68c: this turn's one refusal state (turn-refusal.ts). A kept process's valid proof under the same hook
      // configuration starts it proven; every allow, card answer and clean end below asks it first.
      const refusal = new TurnRefusal({ ...(proof ? { proof } : {}), ...(gated ? { hookConfig: hookConfigOf(scopedHome!) } : {}) });
      let sessionSeen: (() => void) | undefined;
      const sessionPost = new Promise<void>((resolveSession) => { sessionSeen = resolveSession; });
      // Rule 68c, held: Codex runs the SessionStart handler only once the turn begins (rig, lane ag103-cx3), so the proof cannot come
      // before turn/start. Until it is proven the turn is held instead: a PreToolUse delivery and an approval request wait for it, a call
      // that starts unproven is an incident, and a clean end waits for it too. No post within the bound refuses the turn, whatever
      // state it reached. Started once per process, just before turn/start.
      let liveness: Promise<boolean> | undefined;
      // The refusal is one-way and said at once (the line names whether an item had started); the interrupt follows, and a turn that
      // completes meanwhile settles refused, never clean.
      const refuseUnproven = () => {
        if (!refusal.refuse((startedFirst) => hookDidNotStartLine(ENGINE, startedFirst))) return;
        const refused = new ScopeUnavailableError(refusal.cause!, false, { engine: ENGINE });
        if (!state.settled && !abandoned) emit({ ...base(threadId, turnId), type: "runtime.error", message: refused.message, localFailure: scopeLocalFailureOf(refused), localFailureEngine: ENGINE });
        void (async () => {
          if (codexThreadId && codexTurnId) await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, 3_000).catch(() => {});
          if (state.settled || abandoned) return;
          await settle(false, "scope_unavailable");
        })();
      };
      const proveLiveness = (): Promise<boolean> => {
        if (refusal.hookLive) return Promise.resolve(true);
        if (refusal.refused) return Promise.resolve(false);
        liveness ??= new Promise<boolean>((resolveLive) => {
          const bound = Number(process.env.MURAGE_CODEX_HOOK_LIVENESS_MS) > 0 ? Number(process.env.MURAGE_CODEX_HOOK_LIVENESS_MS) : HOOK_LIVENESS_MS;
          const timer = setTimeout(() => { refuseUnproven(); resolveLive(false); }, bound);
          timer.unref?.();
          // a proof after the refusal is not taken (acceptProof answers false): late proof cannot revive the turn
          void sessionPost.then(() => { clearTimeout(timer); resolveLive(refusal.acceptProof()); });
        });
        return liveness;
      };
      const openHookAsk = async (route: Extract<HookRoute, { route: "ask" }>, delivery: HookDelivery): Promise<HookAnswer> => {
        const requestId = newId();
        // F12 when the card opens (Rule 74d): a command's after the check of the current generation, any other call the handed map
        const askCwd = route.cwd ?? turn.cwd ?? homedir();
        const execEnv = route.tool === "shell" ? await execEnvNow(threadId, shellForm, handed, askCwd) : execEnvHanded(handed, askCwd, shellForm);
        const toolInput = delivery.tool_input !== null && typeof delivery.tool_input === "object" && route.tool !== "shell" && route.tool !== "edit" ? boundedToolInput(delivery.tool_input) : undefined;
        return new Promise<HookAnswer>((resolveAnswer) => {
          const finish: AskFinish = (behavior, message, source = "user", _answers, extra) => {
            behavior = refusal.verdict(behavior);
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const rewritten = extra?.updatedInput && typeof extra.updatedInput === "object" && !Array.isArray(extra.updatedInput) ? (extra.updatedInput as Record<string, unknown>) : undefined;
            resolveAnswer(behavior === "allow"
              ? refusal.allow({ decision: "allow", ...(rewritten ? { updatedInput: rewritten } : {}) })
              : { decision: "deny", reason: (refusal.cause ?? message?.trim()) || "Murage did not allow this call" });
            emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
          };
          finish.narrowKey = { tool: route.tool, text: JSON.stringify(route.toolCall.input ?? route.summary) };
          // The hook's own timeout is the ask bound plus 30 s and the script gives up at the bound: a card cannot outlive the hook.
          const timer = setTimeout(() => finish("deny", DENY_TIMEOUT_NOTE, "timeout"), HOOK_ASK_BOUND_MS);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            toolEngine: "codex" as const,
            ...(mcpMountRecords ? { mcpMounts: mcpMountRecords } : {}),
            ...(route.toolInputMissing ? { toolInputMissing: route.toolInputMissing } : {}),
            ...(commandShell ? { commandShell } : {}),
            ...(execEnv ? { execEnv } : {}),
            requestType: "permission",
            tool: route.tool,
            summary: route.summary,
            ...(toolInput ? { toolInput } : {}),
            toolCall: route.toolCall as { name: string; input: unknown },
          });
        });
      };
      const onPreTool = async (delivery: HookDelivery): Promise<HookAnswer> => {
        // Rule 68c: no call is answered before the SessionStart proof, and none after a refusal; unproven, it is denied and the turn is refused.
        const proven = !refusal.refused && (refusal.hookLive || await proveLiveness());
        const toolUseId = typeof delivery.tool_use_id === "string" ? delivery.tool_use_id : "";
        const hookTurnId = typeof delivery.turn_id === "string" ? delivery.turn_id : undefined;
        const name = typeof delivery.tool_name === "string" ? delivery.tool_name : undefined;
        if (!proven || refusal.refused) {
          hookTable.record({ toolUseId, ...(hookTurnId ? { turnId: hookTurnId } : {}), decision: "deny", final: true, ...(name ? { name } : {}) });
          return { decision: "deny", reason: refusal.cause ?? `${ENGINE}'s pre-execution hook did not start.` };
        }
        const route = routeDelivery(delivery, { mounts: mcpMountRecords, project: turn.cwd ?? homedir() });
        const issue = (decision: "allow" | "deny", final: boolean, more: { command?: string; cwd?: string; destinations?: string[] } = {}) =>
          hookTable.record({ toolUseId, ...(hookTurnId ? { turnId: hookTurnId } : {}), decision, final, ...(name ? { name } : {}), ...more });
        if (route.route === "deny") { issue("deny", true); return { decision: "deny", reason: route.reason }; }
        if (route.route === "allow") {
          const answer = refusal.allow({ decision: "allow" as const });
          issue(answer.decision, route.final, { ...(route.destinations ? { destinations: route.destinations } : {}), ...(route.cwd ? { cwd: route.cwd } : {}) });
          // Rule 63: an ordinary in-project file call runs with no card; the decision log records it.
          if (answer.decision === "allow" && route.why === "own-workspace") appendDecision(DATA_DIR, { threadId, tool: name === "apply_patch" ? "edit" : name, summary: name, decision: "auto-approved", source: "own-workspace" });
          return answer;
        }
        const answer = await openHookAsk(route, delivery);
        issue(answer.decision, true, { ...(route.command ? { command: route.command } : {}), ...(route.cwd ? { cwd: route.cwd } : {}), ...(route.destinations ? { destinations: route.destinations } : {}) });
        return answer;
      };
      /** Rule 67: Codex ran a call no allowing hook decision covers. The turn is stopped, the line is shown and carried to the next turn. */
      let incidentRaised = false;
      const incident = (command: string) => {
        if (state.settled || incidentRaised) return;
        incidentRaised = true;
        const line = tripwireLine(command);
        // the turn is refused with the line, and the process's proof is void: its next turn runs the Rule 68 handshake again
        refusal.refuse(line);
        proof?.void();
        incidentNotes.set(threadId, line);
        appendDecision(DATA_DIR, { threadId, tool: "shell", summary: command, decision: "auto-denied", source: "observed" });
        emit({ ...base(threadId, turnId), type: "runtime.error", message: line });
        // the interrupt is asked for first (the turn stops at once on a build that honours it), and the process goes with the turn
        void (async () => {
          if (codexThreadId && codexTurnId) await request("turn/interrupt", { threadId: codexThreadId, turnId: codexTurnId }, 3_000).catch(() => {});
          await settle(false, "gate_incident");
        })();
      };
      if (hookGate) hookGate.arm({ token: hookToken, onSession: () => sessionSeen?.(), onPreTool });
      const handleServerRequest = (msg: any) => {
        if (refusal.refused) return send({ jsonrpc: "2.0", id: msg.id, ...idleRefusal(String(msg.method)) });
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isMcpElicitation =
          method === "mcpServer/elicitation/request" &&
          params?._meta?.codex_approval_kind === "mcp_tool_call";
        const isUserInput = method === "item/tool/requestUserInput";
        // Any other MCP elicitation is a form asking the OWNER for input, not
        // a tool approval: the MCP server's message and schema become a
        // question card (0.1.52 ASK3), answered with the MCP result shape
        // `{action:"accept", content}` / `decline` / `cancel`. It used to
        // fall through as "shell" — auto-accepted in fullAuto and by the
        // harness's auto mode, with a {decision} reply that is not even the
        // elicitation result shape.
        const isFormElicitation = method === "mcpServer/elicitation/request" && !isMcpElicitation;
        const isQuestion = isUserInput || isFormElicitation;
        // Rule 12: the tool is named by a structured field, never by the
        // message prose. None present: `mcp__<server>__` with an empty tool
        // part, which resolves unproven. No "mcp" or "tool" stand-in.
        const structuredTool = isMcpElicitation && typeof params?._meta?.tool_name === "string" && params._meta.tool_name !== ""
          ? (params._meta.tool_name as string)
          : undefined;
        const mcpCallName = `mcp__${typeof params.serverName === "string" ? params.serverName : ""}__${structuredTool ?? ""}`;
        const tool =
          isMcpElicitation
            ? (structuredTool ?? mcpCallName)
            : isFormElicitation
            ? "elicitation"
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isUserInput
              ? "request_user_input"
              : "shell";
        // A call that came through the hook and then arrives again on the approval path is answered with the hook's decision, by
        // tool_use_id (item id): one card, never two. A hook allow that judged nothing here (a custom or external MCP mount) is not final.
        const approvalItem = String(params.itemId ?? params.callId ?? params.call_id ?? "");
        const issuedHere = !isQuestion && approvalItem ? hookTable.get(approvalItem) : undefined;
        if (issuedHere?.final) {
          const accept = issuedHere.decision === "allow";
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? { action: accept ? "accept" : "decline", ...(accept ? { content: {} } : {}) }
              : { decision: accept ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
          });
        }
        if (autoAccept && !isQuestion) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? { action: "accept", content: {} }
              : { decision: legacy ? "approved" : "accept" },
          });
        }
        // Engine-controlled input becomes a card only once it is bounded and
        // well formed. A question the owner cannot be shown is answered at
        // once with the engine's own honest no-answer, and the owner sees why.
        let questions: QuestionSpec[] | undefined;
        if (isQuestion) {
          const normalized = isUserInput
            ? fromCodex(params)
            : params?.mode === "url"
              ? { ok: false as const, error: "Codex forwarded a URL elicitation, which Murage does not open on the owner's behalf" }
              : fromElicitationForm(params.message, params.requestedSchema);
          if (!normalized.ok) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${ENGINE} asked a question Murage could not show (${normalized.error}); it was told nobody answered`,
            });
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isUserInput ? { answers: {} } : { action: "cancel" },
            });
          }
          questions = normalized.questions;
        }
        const shellOrEdit = method === "execCommandApproval" || method === "applyPatchApproval" ||
          method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval";
        const otherMcpServer = isMcpElicitation && typeof params.serverName === "string" && params.serverName !== "" && params.serverName !== "computer";
        // An ask that names no server, or a method this does not know, stays
        // a computer action: a name it cannot read is never widened.
        const computerAsk = controlsHost && !shellOrEdit && !otherMcpServer;
        const requestId = newId();
        // F12: the environment the call runs in, from the delivery's own cwd; the ask opens once the check has answered.
        const approvalCwd = typeof params.cwd === "string" && params.cwd ? params.cwd : turn.cwd ?? homedir();
        const execEnvP = tool === "shell" && !questions ? execEnvNow(threadId, shellForm, handed, approvalCwd).catch(() => undefined) : undefined;
        // F5: which field the Rule 55 contract needed and the wire lacked.
        const inputMissing: string | undefined = questions
          ? undefined
          : isMcpElicitation
            ? params?._meta?.tool_params === undefined ? "_meta.tool_params" : undefined
            : tool === "shell"
              ? Array.isArray(params.command) || typeof params.command === "string" ? undefined : "command"
              : undefined;
        // The headline is the real target (the command, the files); the
        // model's own `reason` rides apart and is labelled on the card. It
        // used to win whenever the command was an argv array (legacy
        // execCommandApproval) or the request named no command (edits).
        const target = questions || isMcpElicitation
          ? undefined
          : codexApprovalText(method, params, tool, fileChangePaths.get(String(params.itemId ?? "")));
        const summary = questions
          ? questions[0]!.question
          : isMcpElicitation && typeof params.message === "string"
            ? params.message
            : target?.summary ?? tool;
        // the first question's labels keep voice and older clients working
        const choices = questions ? questions[0]!.options.map((option) => option.label) : undefined;
        const finish: AskFinish = (behavior, _message, source = "user", answers) => {
          behavior = refusal.verdict(behavior);
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (questions) {
            // Only the owner's validated answers reach Codex. A skip, the
            // timeout or the turn ending is the honest no-answer — empty
            // answer arrays, or an elicitation decline/cancel — never a
            // sentence presented as the owner's.
            const answered = behavior === "answer" && answers?.length ? answers : null;
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isUserInput
                ? { answers: answered ? toCodexAnswers(questions, answered) : codexNoAnswers(questions) }
                : answered
                  ? { action: "accept", content: toElicitationContent(params.requestedSchema, questions, answered) }
                  : { action: source === "user" ? "decline" : "cancel" },
            });
            emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior: answered ? "answer" : "deny", source });
            return;
          }
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? behavior === "allow"
                ? { action: "accept", content: {} }
                : { action: "decline" }
              : { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
          });
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        // A question waits for the owner up to 30 minutes (the shared
        // question timeout); a permission keeps its 15-minute deny, except in
        // a routine run, whose cards wait until answered or the turn stops
        // (SendTurnInput.holdPermissionAsks).
        const timer = turn.holdProjectAsks || (!questions && turn.holdPermissionAsks) ? undefined : setTimeout(
          () => (questions ? finish("deny", undefined, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          questions ? QUESTION_TIMEOUT_MS : 15 * 60_000,
        );
        timer?.unref?.();
        asks.set(requestId, finish);
        const openCard = (execEnv?: ExecEnv) => emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          toolEngine: "codex" as const,
          ...(mcpMountRecords ? { mcpMounts: mcpMountRecords } : {}),
          ...(inputMissing ? { toolInputMissing: inputMissing } : {}),
          ...(commandShell ? { commandShell } : {}),
          ...(execEnv ? { execEnv } : {}),
          requestType: questions ? "question" : "permission",
          tool,
          summary,
          ...(target?.reason ? { reason: target.reason } : {}),
          // an MCP tool's own arguments, so the card shows more than the question
          ...(isMcpElicitation && boundedToolInput(params?._meta?.tool_params) ? { toolInput: boundedToolInput(params._meta.tool_params) } : {}),
          choices,
          ...(questions ? { questions } : {}),
          approvalScope: computerAsk ? "local-computer" : undefined,
          // the engine's own call, for the stop line: a command with the
          // folder Codex runs it in, or the MCP tool with its arguments
          // F5: a field the contract needs that is absent is never replaced
          // (no `?? {}`, no `?? summary`); the input is left out.
          ...(questions ? {} : isMcpElicitation
            ? { toolCall: inputMissing ? ({ name: mcpCallName } as { name: string; input: unknown }) : { name: mcpCallName, input: params._meta.tool_params } }
            : tool === "shell"
              ? { toolCall: inputMissing ? ({ name: "shell" } as { name: string; input: unknown }) : { name: "shell", input: { command: params.command, ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}) } } }
              : {}),
        });
        // F12: a shell call's environment is checked once per (generation, shell, cwd, map) when its card opens; any other call reports the handed map.
        if (execEnvP) void execEnvP.then((execEnv) => { if (asks.has(requestId)) openCard(execEnv); });
        else openCard(questions ? undefined : execEnvHanded(handed, approvalCwd, shellForm));
      };

      const emitSubtask = (subtask: ReturnType<SubtaskTracker["end"]>) => {
        if (subtask) emit({ ...base(threadId, turnId), type: "turn.subtask", subtask, subtasks: helpers.tracker.snapshot() });
      };
      const noteHelperState = (id: string, status: unknown, label?: string) => {
        emitSubtask(helpers.tracker.start(id, label ?? "Helper"));
        if (status === "pendingInit" || status === "running") {
          helpers.open.add(id);
          emitSubtask(helpers.tracker.progress(id, { toolCount: helpers.tools.get(id) ?? 0 }));
        } else if (status === "completed" || status === "errored" || status === "interrupted" || status === "shutdown" || status === "notFound") {
          helpers.open.delete(id);
          emitSubtask(helpers.tracker.end(id, status === "completed"));
        }
      };
      const noteCollabItem = (item: any) => {
        if (item?.type !== "collabAgentToolCall") return;
        const label = typeof item.prompt === "string" ? item.prompt : undefined;
        if (item.tool === "spawnAgent" && Array.isArray(item.receiverThreadIds)) {
          for (const id of item.receiverThreadIds) if (typeof id === "string") noteHelperState(id, "running", label);
        }
        for (const [id, st] of Object.entries(item.agentsStates ?? {})) noteHelperState(id, (st as any)?.status, label);
      };
      /** Settle a held turn: every helper is done and the parent did not
       * start a reply to them within the grace. */
      const settleHeld = () => {
        if (!helpers.holding || state.settled || helpers.open.size > 0) return;
        if (helpers.woken) { void settle(true, null); return; }
        if (helpers.grace) return;
        helpers.grace = setTimeout(() => { helpers.grace = undefined; if (helpers.open.size === 0 && !helpers.woken) void settle(true, null); }, HELPER_WAKE_GRACE_MS);
        helpers.grace.unref?.();
      };
      const holdForHelpers = () => {
        if (!helpers.holding) {
          helpers.holding = true;
          helpers.cap = setTimeout(() => {
            if (state.settled) return;
            const note = backgroundCapNote(backgroundWaitCapMs());
            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: note });
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "murage", text: note });
            void settle(true, "background_wait_cap");
          }, backgroundWaitCapMs());
          helpers.cap.unref?.();
        }
        helpers.woken = false;
        settleHeld();
      };

      const handleNotification = (msg: any) => {
        // After a tripwire incident nothing more of this turn is taken up: the interrupt is on its way and the turn ends as stopped.
        if (incidentRaised) return;
        const p = msg.params ?? {};
        // A helper's own thread: progress and its end are the helper's, never the turn's.
        if (typeof p.threadId === "string" && p.threadId !== codexThreadId && helpers.tracker.has(p.threadId)) {
          if (state.settled) return;
          if (msg.method === "item/started" && ["commandExecution", "mcpToolCall", "fileChange", "webSearch"].includes(p.item?.type)) {
            const count = (helpers.tools.get(p.threadId) ?? 0) + 1;
            helpers.tools.set(p.threadId, count);
            emitSubtask(helpers.tracker.progress(p.threadId, { toolCount: count }));
          } else if (msg.method === "turn/completed") {
            helpers.open.delete(p.threadId);
            emitSubtask(helpers.tracker.end(p.threadId, p.turn?.status === "completed"));
            settleHeld();
          }
          return;
        }
        // While held, the parent answering its helpers is a new turn of the same thread: adopt it.
        if (helpers.holding && !state.settled && msg.method === "turn/started" && p.threadId === codexThreadId && typeof p.turn?.id === "string") {
          codexTurnId = p.turn.id;
          helpers.woken = true;
          if (helpers.grace) { clearTimeout(helpers.grace); helpers.grace = undefined; }
          return;
        }
        // Server requests are dispatched separately and retain approval
        // handling, including requests from helpers. Only unscoped errors
        // are connection diagnostics; scoped errors belong to their turn.
        const connectionError = msg.method === "error" && p.threadId === undefined && p.turnId === undefined;
        if (!connectionError) {
          const scopedMethods = [
            "item/agentMessage/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta",
            "item/started", "item/completed", "thread/tokenUsage/updated", "turn/completed", "error",
          ];
          if (!scopedMethods.includes(msg.method)) return;
          const eventTurnId = msg.method === "turn/completed" ? p.turn?.id : p.turnId;
          if (!codexThreadId || p.threadId !== codexThreadId || typeof eventTurnId !== "string" || !eventTurnId) return;
          if (!codexTurnId && awaitingTurnStart && adoptFirstTurn) {
            codexTurnId = eventTurnId;
            awaitingTurnStart = false;
          }
          if (!codexTurnId) {
            if (!awaitingTurnStart) return;
            // Ordering is not promised by the protocol. Retain only bounded,
            // identified candidates until the ACK establishes the parent.
            const bytes = Buffer.byteLength(JSON.stringify(msg));
            if (earlyNotifications.length >= 256 || earlyNotificationBytes + bytes > 32 * 1024 * 1024) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: `${ENGINE} sent more updates before the turn started than Murage can hold, so the turn was stopped.` });
              void settle(false, "early_notification_overflow");
              return;
            }
            earlyNotifications.push(msg);
            earlyNotificationBytes += bytes;
            return;
          }
          if (eventTurnId !== codexTurnId) return;
        }
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            refusal.noteStarted();
            const item = p.item ?? {};
            noteCollabItem(item);
            // Rule 67: a call Codex STARTED is matched against what the hook answered; a gated turn only.
            if (hookGate && ["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
              // Rule 68c: a call that starts before the hook is proven ran without the gate, whatever the table holds
              const matched = hookTable.match(item, codexTurnId ?? undefined);
              // and a call that starts after the turn was refused is an incident too
              if (refusal.refused || !refusal.hookLive) { incident(matched.ok ? String(item.command ?? item.tool ?? item.type) : matched.command); break; }
              if (!matched.ok) { incident(matched.command); break; }
            }
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell")
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (item.type === "fileChange" && item.id && Array.isArray(item.changes)) {
              const paths = item.changes.map((c: any) => (typeof c?.path === "string" ? c.path : "")).filter(Boolean);
              if (paths.length) fileChangePaths.set(String(item.id), paths);
            }
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "engine", itemId: item.id, title, toolIdentity: { name: item.type === "commandExecution" ? "shell" : title }, input: item.arguments });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            noteCollabItem(item);
            if (item.type === "exitedReviewMode") {
              // A /review turn's findings arrive as the review item, not as
              // an agent message; they are this turn's answer.
              const review = typeof item.review === "string" ? item.review : "";
              if (review.trim()) {
                state.lastText = review;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: review });
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: review });
              }
            } else if (item.type === "contextCompaction") {
              // /compact: the only visible trace is a finished step.
              emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "murage", itemId: item.id, title: "compact" });
              emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: item.id, ok: true });
            } else if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: item.text });
              }
            } else if (item.type === "imageGeneration" && item.status !== "failed") {
              // Current Codex app-server returns the generated raster as
              // base64 `result` and may also expose a local `savedPath`. Use
              // the bytes, never the provider-owned path: the harness will
              // validate them and copy them into its private attachment
              // store, and a path we did not write is not ours to read.
              if (typeof item.result === "string" && item.result.trim()) {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  itemId: item.id,
                  data: item.result,
                  alt: typeof item.revisedPrompt === "string" ? item.revisedPrompt : undefined,
                });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined" && (item.type !== "commandExecution" || typeof item.exitCode !== "number" || item.exitCode === 0),
                result: item.type === "commandExecution" ? { exitCode: item.exitCode } : item.result,
              });
              // `imageGeneration` above was the only raster this driver kept.
              // An MCP tool's own image came back inside `result` and was read
              // for nothing but the ok flag. Qualify the tool with its server
              // so Murage's own screen surfaces keep the preview path they
              // already have instead of becoming files.
              if (item.type === "mcpToolCall") {
                const tool = typeof item.tool === "string" ? item.tool : typeof item.name === "string" ? item.name : undefined;
                const qualified = tool && typeof item.server === "string" ? `${item.server}__${tool}` : tool;
                for (const image of extractMcpImages(item.result, qualified)) {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_image", data: image.data, alt: qualified });
                }
              }
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `last` is the most recent turn when the server sends it;
            // `total` is the thread so far — a fresh app-server per turn
            // makes that this turn's figure too
            const turnUsage = p.tokenUsage?.last;
            // codex's inputTokens already includes cachedInputTokens; the
            // cached share is carried alongside so the UI can say how much
            // of a turn was context re-read rather than new text
            if (turnUsage) {
              state.usage = {
                input: turnUsage.inputTokens ?? 0,
                output: turnUsage.outputTokens ?? 0,
                ...(typeof turnUsage.cachedInputTokens === "number"
                  ? { cachedInput: turnUsage.cachedInputTokens }
                  : {}),
              };
            }
            const t = p.tokenUsage?.total;
            if (t) {
              state.total = { input: t.inputTokens ?? 0, output: t.outputTokens ?? 0, cachedInput: t.cachedInputTokens ?? 0 };
              if (!turnUsage) {
                const total = state.total;
                state.usage = baseline && total.input >= baseline.input && total.output >= baseline.output && total.cachedInput >= baseline.cachedInput
                  ? { input: total.input - baseline.input, output: total.output - baseline.output, cachedInput: total.cachedInput - baseline.cachedInput }
                  : undefined;
              }
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
                ...(typeof t.cachedInputTokens === "number"
                  ? { cachedInput: t.cachedInputTokens }
                  : {}),
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            const terminalMessage = typeof t.error?.message === "string" ? t.error.message.slice(0, 400) : undefined;
            if (t.status === "failed" && terminalMessage && terminalMessage !== lastProviderError) {
              emit({ ...base(threadId, turnId), type: "runtime.error", message: terminalMessage });
            }
            if (t.status === "completed" && !stopRequested && helpers.open.size > 0) { holdForHelpers(); break; }
            if (helpers.holding && t.status === "completed") { void settle(true, null); break; }
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) {
                lastProviderError = String(message).slice(0, 400);
                emit({ ...base(threadId, turnId), type: "runtime.error", message: lastProviderError });
              }
            }
            break;
        }
      };

      conn.onOverflow = (overflow) => {
        if (abandoned) return;
        appendNative(threadId, { dir: "in", source: "codex.app-server", msg: { frameOverflow: overflow } });
        if (state.settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: frameOverflowMessage("Codex", overflow) });
        void settle(false, FRAME_TOO_LARGE);
      };
      const handleStdoutLine = (line: string) => {
        // a completion earlier in the same read ends the turn: later lines
        // from that read are not this turn's output
        if (abandoned || state.settled) return;
        if (!line.trim()) return;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        stderrSinceOutput = "";
        // The native tee is a plain file people paste into issues. A
        // generated image would put megabytes of base64 in it and the
        // provider's own filesystem path beside them; keep the SHAPE and
        // lose both, the same trade server/redact.ts makes for secrets.
        const loggedMessage = msg.method === "item/completed" && msg.params?.item?.type === "imageGeneration"
          ? {
              ...msg,
              params: {
                ...msg.params,
                item: {
                  ...msg.params.item,
                  result: `[generated image omitted · ${String(msg.params.item.result ?? "").length} base64 chars]`,
                  savedPath: undefined,
                },
              },
            }
          : msg;
        appendNative(threadId, { dir: "in", source: "codex.app-server", msg: loggedMessage });
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const pend = rpcPending.get(msg.id);
          if (pend) {
            rpcPending.delete(msg.id);
            msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
          }
        } else if (msg.id !== undefined && msg.method) {
          // Rule 68c: an approval request on a gated process waits for the hook's proof; unproven, it is never answered (the refusal
          // closes the process with the turn)
          if (hookGate && !refusal.hookLive) void proveLiveness().then(() => { if (!abandoned) handleServerRequest(msg); });
          else handleServerRequest(msg);
        } else if (msg.method) {
          handleNotification(msg);
        }
      };

      conn.onLine = handleStdoutLine;
      let stderr = "";
      // Stderr received after the last parsed protocol message. The lifetime
      // buffer's tail can name a long-past event (a websocket 426 logged at
      // turn start, echoed when something else later kills the process), so
      // only this slice may explain or classify an exit (U07).
      let stderrSinceOutput = "";
      on(child.stderr, "data", (c: Buffer) => {
        stderr += c;
        stderrSinceOutput += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
        if (stderrSinceOutput.length > 2048) stderrSinceOutput = stderrSinceOutput.slice(-2048);
      });
      on(child, "error", (e: Error) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });
      on(child, "close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (abandoned) return;
        if (state.settled) { void stop(); return; }
        if (!state.settled && !stopRequested && helpers.holding) { settle(true, null); return; }
        if (!state.settled && stopRequested) {
          // Murage killed the app-server to stop this turn: a cancellation,
          // not an engine crash — no runtime error card, same terminal state
          // as the ACP and Pi drivers (STOP1).
          settle(true, "cancelled");
          return;
        }
        if (!state.settled) {
          const recentStderr = stderrSinceOutput.trim();
          // A signal exit is terminal whatever stderr says: something killed
          // the process, and the classifier cannot see a signal behind a null
          // code. Otherwise classify only this generation's recent stderr.
          const verdict = signal !== null
            ? { transient: false, reason: "interrupted" }
            : classifyError({ exitCode: code, stderr: recentStderr });
          // Relaunch only a crash proven to precede the turn: turn/start was
          // never written, nothing streamed or was buffered, and no approval
          // is open. Anything later may already have acted (U-17).
          if (
            ownsProcess && !turn.prewarm && !turnStartSent && codexTurnId === null && earlyNotifications.length === 0 &&
            !state.sawStreamDelta && asks.size === 0 &&
            verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // Retire this attempt first, so its late handshake rejections can
            // neither report nor relaunch on top of the replacement.
            abandoned = true;
            void (async () => {
              // The root exited, but its owned group must be confirmed gone
              // before a replacement launches (owned teardown).
              if (!(await terminate())) {
                await settle(false, "shutdown_timeout");
                return;
              }
              if (stopRequested) {
                await settle(true, "cancelled");
                return;
              }
              const delayMs = computeBackoff(attempt);
              attempt++;
              emit({ ...base(threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: verdict.reason });
              await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
              if (!stopRequested) {
                void launchAttempt(attempt).catch(() => {});
              } else {
                // a Stop during the backoff is a user cancellation (STOP1)
                await settle(true, "cancelled");
              }
            })().catch(() => {});
            return;
          }
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            // Shown in the chat: the engine, the exit and its last words, never
            // the app-server's protocol names.
            message: engineClosedLine(ENGINE, code, signal, recentStderr ? acpEngineExitStderrText(recentStderr.slice(-300)) : undefined),
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });
      if (warmPool.consumeColdWake(threadId)) {
        // the warm engine was released while idle: say so instead of waiting silently
        console.info(`codex wake thread=${threadId} cold=true`);
        emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", origin: "murage", itemId: `wake-${turnId}`, title: "Waking up: starting a fresh engine after a quiet spell" });
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: `wake-${turnId}`, ok: true });
      }

      // Stop may land at any await below. The kill can fail, so the flag, not
      // the process, decides: nothing is submitted after a Stop.
      const cancelledBeforeStart = () => {
        if (!stopRequested) return false;
        if (!state.settled) void settle(true, "cancelled");
        return true;
      };
      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        let startedModel: string | null = null;
        if (reuse) {
          // The connection is initialized and the conversation is loaded in it:
          // this turn goes straight to turn/start.
          codexThreadId = reuse.codexThreadId;
        } else {
          await request("initialize", { clientInfo: { name: "murage", version: "1" } });
          if (cancelledBeforeStart()) return;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
        }
        // Rule 68b: both handlers listed, trusted and enabled before anything is asked of the model; any other listing refuses the
        // turn before a model request. Checked again on a retained process (the trust record lives in the scope's config).
        if (hookGate && hookFiles) {
          const shake = await trustHooks(request, hookFiles.hooksJson, turn.cwd ?? homedir());
          if (cancelledBeforeStart()) return;
          if (!shake.ok) {
            throw shake.why.startsWith("hooks/list")
              ? engineUpdateRequired(ENGINE, codexVersion || undefined, CODEX_GATE_MIN)
              : new ScopeUnavailableError(`${ENGINE}'s pre-execution hook could not be trusted (${shake.why}), so this turn did not start.`, false, { engine: ENGINE });
          }
        }
        const cursor = !reuse && !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        // The cursor named a thread this app-server's state root does not hold (real Codex 0.162: -32600
        // "no rollout found for thread id …"; a 1.0.1 or earlier cursor lives in another root): ONE new
        // thread starts and the conversation the harness sent is replayed into it.
        let replayHistory = false;
        if (cursor) {
          try {
            // A resumed Flux thread names its table again: the headers belong to the
            // table, and the audience may have changed since the thread started.
            const resumeSelection = !providerBinding ? decodeCodexSelection(turn.model) : null;
            const resumeFlux = flux?.applied && resumeSelection?.modelProvider === FLUX_CODEX_PROVIDER;
            // A resumed thread is pinned again: it may have started under another policy or sandbox. Off a home the policy is the
            // one spelled for the installed Codex (gated: on-request behind the gate; legacy: the policy the driver always sent); a
            // Cloud home names the same codexPolicy the launcher renders as the effective one.
            const resumePolicy = process.env.MURAGE_CLOUD_ROLE === "home" ? { sandbox: codexPolicy.sandbox, approvalPolicy: codexPolicy.approval } : policy();
            const resumed = await request("thread/resume", { threadId: cursor, ...resumePolicy, ...(resumeFlux ? { modelProvider: fluxProvider } : {}) });
            if (cancelledBeforeStart()) return;
            codexThreadId = resumed?.thread?.id ?? cursor;
          } catch {
            /* The replacement session has no settled total baseline. */
            settledTotals.delete(threadId);
            baseline = undefined;
            replayHistory = true;
          }
        }
        if (!codexThreadId) {
          const selection = providerBinding ? { model: providerBinding.model, modelProvider: providerBinding.modelProvider } : decodeCodexSelection(turn.model);
          // A Flux thread starts under the table whose headers match its audience.
          if (flux?.applied && !providerBinding && selection.modelProvider === FLUX_CODEX_PROVIDER) {
            selection.modelProvider = fluxProvider;
            logFluxMemoryHeaders(DRIVER_KIND, fluxMemory);
          }
          const started = await request("thread/start", {
            cwd: turn.cwd ?? (process.env.MURAGE_CLOUD_ROLE === "home" ? cloudEngineHome("codex") : homedir()),
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
            ...(process.env.MURAGE_CLOUD_ROLE === "home" ? { sandbox: codexPolicy.sandbox, approvalPolicy: codexPolicy.approval } : policy()),
            // the Chief's proposal turn leaves no session in the owner's Codex home
            ephemeral: turn.proposalOnly === true,
          });
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        if (cancelledBeforeStart()) return;
        if (typeof codexThreadId !== "string" || !codexThreadId) throw new Error(`${ENGINE} did not open a conversation.`);
        // Intent warm: the app-server is up with the conversation loaded. Park it idle
        // (held for one window); no turn starts and nothing is announced.
        if (turn.prewarm) {
          if (conn.baseline === undefined && child.pid) {
            conn.baseline = null;
            try { conn.baseline = await descendantPids(child.pid); } catch { /* stays null: fails closed */ }
          }
          if (cancelledBeforeStart()) return;
          // The app-server has started from its credential file: empty it before it idles, as a
          // settled turn does (the next send writes a fresh token). If it cannot be emptied the
          // process is closed instead of parked.
          try { cred?.clear(); } catch {
            console.info(`codex close thread=${threadId} reason=credential clear failed`);
            if (!(await stop())) {
              // Not confirmed closed: the child stays owned, in the stuck-process registry,
              // which Stop, dispose and the next dispatch of this thread retry and wait on.
              stuck.set({ child, warm, cred, conn, codexThreadId, closing: true, detachIdle: () => {} }, threadId);
              console.warn(`codex close thread=${threadId} confirmed=false reason=credential clear failed`);
            }
            if (active.get(threadId)?.stop === stop) active.delete(threadId);
            endPrewarm(); forgetPrewarm();
            return;
          }
          console.info(`codex prewarm thread=${threadId} parked=true`);
          retain(() => {});
          if (active.get(threadId)?.stop === stop) active.delete(threadId);
          endPrewarm(); forgetPrewarm();
          return;
        }
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
        // Codex has no command list of its own to report. Its skills are the
        // live part of the "/" menu (skills/list, codex-cli 0.156); the
        // built-in pair is fixed. Reported only on a real answer, and never
        // waited on unless this turn IS a skill.
        const listedSkills = (result: any) => Array.isArray(result?.data)
          ? result.data.flatMap((entry: any) => Array.isArray(entry?.skills) ? entry.skills : [])
            .filter((skill: any) => skill && skill.enabled !== false && typeof skill.name === "string")
          : null;
        const skills = request("skills/list", { cwds: [turn.cwd ?? (process.env.MURAGE_CLOUD_ROLE === "home" ? cloudEngineHome("codex") : homedir())] }, 10_000, (result) => {
          // Publish an accepted response while its frame is being handled:
          // completion later in the same read may settle before Promise jobs.
          const found = listedSkills(result);
          if (!found || state.settled || abandoned) return;
          emit({
            ...base(threadId, turnId),
            type: "engine.commands",
            commands: normalizeEngineCommands([
              ...CODEX_BUILTIN_COMMANDS,
              ...found.map((skill: any) => ({
                name: skill.name,
                description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
              })),
            ]),
          });
        }).then(listedSkills, () => null);
        // A command turn becomes the app-server call it names: /review is
        // review/start (inline, on this thread), /compact is
        // thread/compact/start, and a skill is turn/start carrying the skill
        // as a `skill` input beside "$name args", the way Codex's own
        // composer sends one. Anything else is an ordinary turn.
        const command = turn.engineCommand;
        let method = "turn/start";
        let commandParams: Record<string, unknown> | null = null;
        let skillInput: { type: "skill"; name: string; path: string } | null = null;
        if (command?.name === "review") {
          method = "review/start";
          commandParams = {
            threadId: codexThreadId,
            target: command.args ? { type: "custom", instructions: command.args } : { type: "uncommittedChanges" },
            delivery: "inline",
          };
        } else if (command?.name === "compact") {
          method = "thread/compact/start";
          commandParams = { threadId: codexThreadId };
          adoptFirstTurn = true;
        } else if (command) {
          const skill = (await skills)?.find((candidate: any) => candidate.name.toLowerCase() === command.name.toLowerCase());
          if (cancelledBeforeStart()) return;
          if (skill && typeof skill.path === "string") skillInput = { type: "skill", name: skill.name, path: skill.path };
        }
        const latestText = replayHistory && !command && turn.transcript?.length
          ? ["[Your previous session could not be restored. Continue from this conversation history:]", "",
            renderDriverReplay(turn.transcript, turn.replayMetadata), "", "[Latest message:]", turn.text].join("\n")
          : turn.text;
        // Rule 67: what the last stopped turn found out about a call that ran unchecked rides on this turn's prompt.
        const incidentLine = incidentNotes.get(threadId);
        const baseSystem = incidentLine ? (turn.system ? `${incidentLine}\n\n${turn.system}` : incidentLine) : turn.system;
        const turnText = skillInput
          ? `$${skillInput.name}${command?.args ? ` ${command.args}` : ""}`
          : baseSystem ? `${baseSystem}\n\n${latestText}` : latestText;
        if (incidentLine) incidentNotes.delete(threadId);
        // The engine's own MCP servers are up: take the baseline NOW and wait
        // for it, so nothing this turn launches can become baseline.
        if (conn.baseline === undefined && child.pid) {
          conn.baseline = null;
          try { conn.baseline = await descendantPids(child.pid); } catch { /* stays null: fails closed at settle */ }
        }
        if (cancelledBeforeStart()) return;
        // The submission fence (SendTurnInput.beforeSubmit), on every
        // attempt: no await separates it from the turn/start write below. A
        // refusal writes nothing. Before sendTurn resolved the harness stops
        // the turn by its id; after, the turn settles failed here and the
        // harness re-runs it on a reset session.
        try {
          turn.beforeSubmit?.();
        } catch {
          if (handedBack && !state.settled) void settle(false, "submission_refused");
          return;
        }
        awaitingTurnStart = true;
        turnStartSent = true;
        // Rule 68c: the bound runs from before turn/start, so nothing the turn starts is answered before the hook is proven
        if (hookGate && !refusal.hookLive && (method === "turn/start" || method === "review/start")) void proveLiveness();
        // The turn is written to the engine: the memory worker's hold for it ends (turn-hold.ts).
        queueMicrotask(() => notePromptSent(turn.threadId));
        await request(method, commandParams ?? {
          threadId: codexThreadId,
          // `{type:"image", url}` is the app-server's own UserInput variant,
          // read out of codex-cli 0.154.0's generated protocol schema
          // (`codex app-server generate-json-schema`: TextUserInput,
          // ImageUserInput {url}, LocalImageUserInput {path}, …). Murage holds
          // the validated BYTES, never a path a driver resolves itself, so the
          // data URL is the variant that fits — `localImage` would hand codex
          // a path to re-open under its own sandbox, which is the read-tool
          // detour this change exists to remove.
          input: [
            { type: "text", text: turnText },
            ...(skillInput ? [skillInput] : []),
            ...(turn.images ?? []).map((image) => ({ type: "image", url: `data:${image.mimeType};base64,${image.data}` })),
          ],
          // Spread, not `effort: turn.effort ?? null`. Probed against
          // codex-cli 0.146.0: null is indistinguishable from an absent key
          // — both leave the thread's current effort alone, emitting no
          // thread/settings/updated, and thread/resume reads the old value
          // back. The app-server offers no way to clear a level either:
          // "" is rejected outright and thread/start takes no effort at
          // all. So a thread keeps the last level it was sent until it is
          // sent another, and choosing Default lands on the bot's next new
          // thread rather than the current one.
          ...(turn.effort ? { effort: turn.effort } : {}),
          // a gated turn names its policy every time; below the retirement a resumed thread keeps the policy it started with, so the stop
          // line holds on this turn only by naming it
          // (a Cloud home names codexPolicy's approval, as its thread/start and the launcher's render do)
          ...(process.env.MURAGE_CLOUD_ROLE === "home" ? (enforceApproval ? { approvalPolicy: codexPolicy.approval } : {})
            : gatePlan.mode === "gated" || enforceApproval ? { approvalPolicy: policy().approvalPolicy } : {}),
        }, 60_000, (result) => {
          // compaction answers `{}`; its first notification names the turn
          if (adoptFirstTurn) return;
          awaitingTurnStart = false;
          if (typeof result?.turn?.id !== "string" || !result.turn.id) {
            earlyNotifications.length = 0;
            earlyNotificationBytes = 0;
            throw new Error(`${ENGINE} did not start the turn.`);
          }
          codexTurnId = result.turn.id;
          const buffered = earlyNotifications.splice(0);
          earlyNotificationBytes = 0;
          for (const notification of buffered) {
            if (abandoned || state.settled) break;
            handleNotification(notification);
          }
        });
        // Rule 68c, as the rig has it (lane ag103-cx3, Codex 0.129.0 and 0.163.0): Codex runs the SessionStart handler when the turn begins,
        // after the turn/start answer and before the first model request. The proof was started before turn/start (above) and holds every
        // call, approval and clean end until it lands; here the attempt only waits for it, and an unproven hook has already refused the turn.
        if (hookGate && !refusal.hookLive && (method === "turn/start" || method === "review/start")) {
          if (!(await proveLiveness())) return;
        }
      } catch (e) {
        // A retired attempt's late rejection (an RPC timer after a close-path
        // relaunch) must neither report an error nor relaunch again.
        if (abandoned) return;
        // The gate could not be established (Rule 68): a structured owner-facing failure and no retry; the process goes with the turn.
        if (e instanceof ScopeUnavailableError) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: e.message, localFailure: scopeLocalFailureOf(e), ...(e.engine ? { localFailureEngine: e.engine } : {}) });
            void settle(false, "scope_unavailable");
          }
          return;
        }
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        // A Stop already asked for wins over whatever the handshake reported:
        // never announce or run a relaunch after it, and settle as the user's
        // Stop rather than an engine failure (U06, STOP1).
        if (stopRequested) {
          if (!state.settled) void settle(true, "cancelled");
          return;
        }
        if (!state.settled && ownsProcess && !turn.prewarm && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // This app-server never exits by itself. Retire the failed attempt
          // and silence its late handlers before the replacement launches.
          abandoned = true;
          if (!await terminate()) {
            await settle(false, "shutdown_timeout");
            return;
          }
          await interruptibleDelay(Math.max(1, Math.round(delayMs * retryScale)), stopSignal.signal).promise;
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            // a Stop during the backoff is a user cancellation (STOP1)
            settle(true, "cancelled");
          }
          return;
        }
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          settle(false, needsAuth ? "auth_required" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(() => {
      // a launch that died before its turn took over must not hold the thread
      if (active.get(threadId) === slot) active.delete(threadId);
      endPrewarm(); forgetPrewarm();
    });
    handedBack = true;
    return { turnId };
  };

  /** Intent warm: start this thread's app-server the way its next turn would (the last
   * real turn's cwd, env, MCP config, settings and warm key), with the conversation
   * loaded, and park it idle, held for one window. A no-op without remembered inputs,
   * when an engine is already live, or when the thread is busy. The next real turn
   * still runs the warm-key check, so changed settings or MCP config recycle it. */
  const prewarm = async (threadId: string): Promise<boolean> => {
    const mem = lastTurns.get(threadId);
    if (idleHeld > 0 || !mem?.warmIdentity || active.has(threadId) || retained.has(threadId) || !prewarming.begin(threadId)) return false;
    try {
      await sendTurn({ ...mem, prewarm: true, background: false, sessionReset: false });
    } catch {
      prewarming.end(threadId);
      return false;
    }
    await prewarming.wait(threadId);
    return retained.has(threadId);
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    const env = childEnv();
    const probed = await cachedCliVersion(config.cli, env, execCli);
    const version = probed.error ? null : probed.stdout.trim();
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // childEnv drops OPENAI_API_KEY on purpose: off a home turns run on the ChatGPT login. On a home
    // the launcher knows whether an API key (C store) or a ChatGPT sign-in pays for the turns.
    return { state: "available", version, authenticated, billing: await codexCloudBilling() };
  };

  return withCliMemoryLearning({
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
      mcpToolSurface: CODEX_TOOL_SURFACE,
      capabilities: {
        sessionModelSwitch: "unsupported",
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
        memoryMcp: true,
      customMcp: true,
        phoneMcp: true,
        browserMcp: true,
        images: true,
        // turn/start takes the app-server's ImageUserInput {type,url}; the
        // bytes ride a data: URL. See the input builder above.
        imagesInline: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      prewarm,
      holdIdle: async () => {
        idleHeld++;
        let confirmed = true;
        // A prewarm already starting meets the hold at its spawn, or parks and is closed on the spot (armIdle): let it end first.
        for (const threadId of [...new Set([...retained.keys(), ...active.keys()])]) {
          if (prewarming.has(threadId) && !(await prewarming.wait(threadId))) confirmed = false;
        }
        // An engine whose shutdown is not confirmed (false) is not idle: its files stay alone.
        const closed = await Promise.all([...retained.keys()].filter((threadId) => !active.has(threadId)).map((threadId) => closeRetained(threadId, "deletion-hold")));
        if (closed.some((ok) => ok === false)) confirmed = false;
        // A close still in flight, or a process that would not stop, means the engine may still be writing: not idle.
        if (!(await drainClosing()) || stuck.size > 0 || closingProcs.size > 0) confirmed = false;
        let released = false;
        return { confirmed, release: () => { if (!released) { released = true; idleHeld = Math.max(0, idleHeld - 1); } } };
      },
      interruptTurn: async (threadId) => {
        // a process that survived an earlier Stop is retried here, and Stop reports failure until it is gone
        if (!active.has(threadId) && (!(await closeRetained(threadId, "stop")) || !(await retryStuck(threadId)))) throw new Error("codex shutdown is still pending; the process remains owned");
        if (await active.get(threadId)?.stop() === false) throw new Error("codex shutdown is still pending; the process remains owned");
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        // Rule 72: the third identical narrowing denial in a turn is not delivered; the ask stays pending as the owner's card.
        const extra = decision as { source?: unknown; updatedInput?: unknown };
        if (extra.source === "narrow" && decision.behavior === "deny" && finish.narrowKey && narrowDenials.raiseCard(turn!.turnId, finish.narrowKey.tool, finish.narrowKey.text)) return "card" as never;
        finish(decision.behavior, decision.message, "user", decision.answers, extra);
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const stopped = await Promise.all([
          ...[...active.values()].map(({ stop }) => stop()),
          ...[...retained.keys()].map((threadId) => closeRetained(threadId, "shutdown")),
        ]);
        if (!(await drainClosing())) stopped.push(false);
        if (stopped.includes(false)) throw new Error("codex shutdown is still pending; the processes remain owned");
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      const stopped = await Promise.all([
        ...[...active.values()].map(({ stop }) => stop()),
        ...[...retained.keys()].map((threadId) => closeRetained(threadId, "shutdown")),
      ]);
      if (!(await drainClosing())) stopped.push(false);
      if (stopped.includes(false)) throw new Error("codex shutdown is still pending; listeners remain attached");
      listeners.clear();
    },
  });
},
};
