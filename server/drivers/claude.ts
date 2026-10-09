import { CLAUDE_TOOL_SURFACE, renderMurageTurn } from "../murage-tool-surface.ts";
// Claude driver — upstream ClaudeDriver skeleton over agentcal's
// drivers/claude.js runtime (stream-json both directions, prompt over
// stdin, completion from a real `result` event — verified against
// claude 2.1.211 by agentcal). Per-turn CLI process; the conversation
// continues across turns via --resume <sessionId> (the resumeCursor).
//
// Integrations become MCP servers on the CLI:
//   - Composio Sessions (connected apps → tools) over streamable HTTP
//   - the bot's cloud computer (box.ascii.dev) via server/computer-proxy.ts
//     — screenshot/exec/open_url, the CUA-on-the-box bridge
import { applyProviderRoute, type ProviderTurnRoute } from "../provider-routing.ts";
import { claudeTextOnlyTurn } from "./headless-text-only.ts";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { backgroundCapNote, backgroundWaitCapMs, SubtaskTracker } from "../subtasks.ts";

import { DATA_DIR, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { writeFileAtomic } from "../atomic.ts";
import { augmentedPath } from "../env-path.ts";
import { claudeAccountEnvironment,resolveClaudeConfigDir } from "../claude-accounts.ts";
import { customMountEntries } from "../custom-mcp-mounts.ts";
import { toolFilePaths } from "../own-workspace-approval.ts";
import { fluxKey } from "../flux-config.ts";
import { applyFluxSurface, isFluxModel } from "../flux-routing.ts";
import { claudeCustomHeadersValue, fluxMemoryContextForTurn, fluxMemoryDecision, logFluxMemoryHeaders, type FluxMemoryDecision } from "../flux-memory-headers.ts";
import { mergeFluxCatalog } from "../flux-surface.ts";
import { awaitCliTreeStopped, brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { bindCredentialPath, createTurnCredentialStore, splitTurnSecrets, type TurnCredentialStore } from "./turn-credentials.ts";
import { descendantBaseline, untrackedDescendants, processNames } from "./process-tree.ts";
import { createPrewarmGate, createTurnMemory, spawnInputsOf, warmPool, pastWarmMaxAge, spawnedAtOf } from "./warm-pool.ts";
import { credentialDigest, diffWarmKey, warmKey, type WarmKey } from "./warm-key.ts";
import { approvalSummary } from "../../shared/approval-summary.ts";
import { boundedToolInput } from "../approval-text.ts";

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
import { computerProxyEnv } from "../container-computer.ts";
import { newEventId, newId } from "../contracts.ts";
import {
  QUESTION_NOTES,
  answersFromMessage,
  fromClaude,
  fromMuragebox,
  toClaudeAnswers,
  toMessageText,
  validateAnswers,
  type QuestionAnswer,
  type QuestionSpec,
} from "../question-normalize.ts";
import { QUESTION_TIMEOUT_MS } from "../../shared/questions.ts";
import { extractMcpImages } from "../mcp-tool-images.ts";
import { providerCloseDeadlineMs } from "./child-teardown.ts";
import {
  classifyError,
  computeBackoff,
  createAttemptBoundary,
  interruptibleDelay,
  isPreAcceptFailure,
  RETRY_MAX_ATTEMPTS,
  type AttemptBoundary,
} from "./retry.ts";
import {
  applyClaudeInject,
  decodeInjectId,
  mergeLocalInject,
  probeLocalInjects,
  resolveInjectId,
} from "./local-inject.ts";
import { appendNative } from "./native.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "./bounded-lines.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { normalizeEngineCommands } from "../engine-commands.ts";
import { engineCommandText } from "../../shared/engine-commands.ts";
import { engineClosedLine } from "./stop-copy.ts";
import { acpEngineExitStderrText } from "./acp/core.ts";

/** Whether `claude` has been signed in.
 *
 * Credential storage is deliberately not inspected here. Claude Code uses the
 * macOS Keychain for OAuth, a JSON file on some platforms, and may gain other
 * backends over time. Presence checks also accept stale credentials. The CLI's
 * own machine-readable auth command is the source of truth for every backend.
 */
export function claudeSignedIn(
  cli: string,
  env: NodeJS.ProcessEnv,
  run: typeof execCli = execCli,
): Promise<boolean> {
  return new Promise((resolve) => {
    run(cli, ["auth", "status", "--json"], { timeout: 8000, maxBuffer:65536, env }, (_error, stdout) => {
      try {
        const status: unknown = JSON.parse(stdout);
        resolve(
          typeof status === "object" && status !== null && "loggedIn" in status && status.loggedIn === true,
        );
      } catch {
        resolve(false);
      }
    });
  });
}

/** Adapted from OpenMausBot1d777ff7 (Apache-2.0). Match auth text only
 * after the CLI flags an API error; ordinary model discussion stays text. */
export function claudeAuthFailure(frame: { error?: unknown; is_api_error_message?: unknown }, text: string): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return frame.error === "authentication_failed" || classifyError({ text }).reason === "auth";
}

/** Adapted from OpenMausBot 95a94daa (#1840, Apache-2.0). A model newer
 * than the installed Claude Code: the API refuses it and the CLI relays that
 * as an api-error frame ("Claude Code 2.1.268 does not support this model;
 * version 2.1.280 or newer is required. Run 'claude update'…"). It names no
 * model, so it covers every model it happens for. Like a signed-out turn, it
 * is fixed by changing the install, not by a retry. */
export function claudeVersionTooOld(frame: { error?: unknown; is_api_error_message?: unknown }, text: string): boolean {
  if (frame.is_api_error_message !== true && typeof frame.error !== "string") return false;
  return /\bClaude Code v?\d+(?:\.\d+)+ does not support this model\b/i.test(text);
}

/** The CLI environment shared by auth probes and real turns.
 *
 * Subscription users can be billed pay-as-you-go if an inherited API key
 * leaks through, and a nested CLI must not inherit this session's identity.
 * Keeping the probe and turn environments identical prevents setup from
 * claiming an API-key login that the turn itself would deliberately remove.
 */
function claudeEnvironment(
  model?: string | null,
  source: NodeJS.ProcessEnv = process.env,
  providerRoute?: ProviderTurnRoute,
  // Flux Memory headers for this process. A caller with no turn (a reflection,
  // a catalog probe) gets the unknown-purpose default: off/off.
  fluxMemory: FluxMemoryDecision = fluxMemoryDecision(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The harness process may hold workspace credentials (xai/box/voice keys,
  // env-injected at boot); none of them are this CLI's to see.
  stripWorkspaceCredentialEnv(env);
  // A leftover `ANTHROPIC_BASE_URL`/`_AUTH_TOKEN`/`_MODEL` from a provider
  // switcher in the user's shell would redirect this turn off the CLI's own
  // login without a word — and `ANTHROPIC_AUTH_TOKEN` is the same Bearer
  // identity as the API key deleted below, so that guard needs this to hold.
  // Must run before applyClaudeInject: the inject re-sets what it means to.
  stripRoutingEnv(env);
  // ANTHROPIC_CUSTOM_HEADERS is set AFTER the account strip and the routing
  // strip, only for a Flux route (the headers mean nothing to another host),
  // and it replaces whatever the user's shell held: those belonged to a
  // different endpoint. It is part of the spawn contract (see the warm key).
  if (providerRoute) {
    applyProviderRoute(DRIVER_KIND, env, providerRoute);
    if (providerRoute.preset === "flux") env.ANTHROPIC_CUSTOM_HEADERS = claudeCustomHeadersValue(fluxMemory.headers);
  } else if (claudeRouting(env, model).flux) {
    env.ANTHROPIC_CUSTOM_HEADERS = claudeCustomHeadersValue(fluxMemory.headers);
  }
  return env;
}

/** How long a settle check waits for the init-time baseline probe. */
const BASELINE_WAIT_MS = 5_000;

/** How long a prewarmed CLI gets to confirm its startup (its first stdout frame: the answer to
 * the `initialize` control request, or `init`). Its MCP config and prompt files are removed only
 * once it has; one that has not by then is retired first, and they go with its close. */
const prewarmFileGraceMs = (): number => {
  const v = Number(process.env.MURAGE_PREWARM_FILE_GRACE_MS);
  return Number.isFinite(v) && v >= 0 && process.env.MURAGE_PREWARM_FILE_GRACE_MS !== undefined ? v : 15_000;
};

const DRIVER_KIND = "claudeAgent";
/** Thrown inside a dispatch whose Stop landed before its process launched. */
/** Errors thrown by a turn's submission fence (SendTurnInput.beforeSubmit):
 * nothing was written, so a relaunch refused by one shows no engine error. */
const submissionRefusals = new WeakSet<object>();
class StoppedBeforeLaunch extends Error {
  constructor() { super("the turn was stopped before it launched"); }
}

/** Point one ALREADY-STRIPPED claude env at whatever backend `model` names,
 * and report the model id the CLI itself should be asked for.
 *
 * Flux Router and a local-host inject both write the same four `ANTHROPIC_*`
 * vars, so they are mutually exclusive by construction here: Flux is tried
 * first and `applyClaudeInject` only runs when Flux declined. (`decodeInjectId`
 * returns null for a `flux-` id — local-inject.ts:73-81 — so the inject would
 * no-op anyway, but the spec asks for the exclusion to be explicit rather than
 * inherited: flux-router-spec.md §4.1.)
 *
 * Flux uses the Anthropic Messages surface, `POST /anthropic/v1/messages`
 * (spec §1.1) — Claude Code appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so
 * the base carries `/anthropic`. Both `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` are set: the gateway accepts either header, and setting
 * both is what stops the `delete env.ANTHROPIC_API_KEY` guard below from
 * half-routing the env.
 *
 * MUST run after `stripWorkspaceCredentialEnv`: `FLUX_API_KEY` is a workspace
 * credential (config.ts:551) and is already gone from `env` by the time this
 * runs, which is exactly why the key comes from `fluxKey()` — config and
 * `process.env` — and is never read back off `env` (flux-config.ts:3-9).
 */
function claudeRouting(
  env: NodeJS.ProcessEnv,
  model: string | null | undefined,
): { model: string | null; injected: boolean; flux?: boolean } {
  const flux = applyFluxSurface(DRIVER_KIND, env, model, fluxKey());
  if (flux.applied) return { model: flux.model, injected: true, flux: true };
  const applied = applyClaudeInject(env, model);
  // Neither routed: the CLI runs on its own login, and an inherited API key
  // would silently bill a subscription account pay-as-you-go.
  if (!applied.injected) delete env.ANTHROPIC_API_KEY;
  return applied;
}

export interface ClaudeConfig {
  cli: string;
  /** Named native account; absence preserves the user's default CLI namespace. */
  configDir?: string;
  permissionMode: "default" | "acceptEdits" | "auto" | "bypassPermissions";
  /** How long a turn stays open for the engine's background sub agents after
   * its first result before it ends with a note. Default 30 minutes, bounded
   * to 1 minute through 2 hours. */
  backgroundTaskCapMs?: number;
  /** Available Claude built-ins. An empty list passes `--tools ""`. */
  tools?: string[];
  /** Claude tool patterns to deny after the available set is selected. */
  disallowedTools?: string[];
  /** How long an AskUserQuestion waits for the owner before Claude is told
   * nobody answered (default 30 min, clamped to 1 s – 24 h). */
  questionTimeoutMs?: number;
}

// model catalog ported from upstream packages/contracts/src/model.ts
export const STATIC_CLAUDE_MODELS: ModelCatalog = {
  default: "claude-sonnet-5",
  options: [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1_000_000 },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1_000_000 },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", contextWindow: 1_000_000 },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
};

const CLAUDE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Rewrite a leftover API slug (`orcarouter/Qwen…`) to `host::model` when a
 *  local host is serving it, so the turn injects instead of asking for /login.
 *  Official cloud ids, Flux ids and already-encoded inject ids skip the probe.
 *
 *  The Flux guard is not an optimization. A `flux-*` id is neither static nor
 *  inject-encoded, so without it every Flux turn would pay a five-host loopback
 *  probe AND `resolveInjectId` (local-inject.ts:103-105) could silently rewrite
 *  it into a `host::model` inject id if some local host happened to serve a
 *  model of that name — routing the turn at localhost instead of Flux.
 *  Prefix-based on purpose (spec §4.1): `flux-pinned-*` must be caught too. */
async function resolveClaudeTurnModel(
  model: string | null | undefined,
  env: Record<string, string | undefined>,
): Promise<string | null | undefined> {
  if (!model || isFluxModel(model) || decodeInjectId(model) || STATIC_CLAUDE_MODELS.options.some((option) => option.id === model)) {
    return model;
  }
  return resolveInjectId(model, await probeLocalInjects(env)) ?? model;
}

function claudeConfigDir(env: Record<string, string | undefined>): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME || env.USERPROFILE || homedir(), ".claude");
}

function extrasFromUnknown(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return CLAUDE_MODEL_ID.test(item) ? [{ id: item, label: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as { id?: unknown; model?: unknown; slug?: unknown; name?: unknown; displayName?: unknown; label?: unknown };
    const id = [row.id, row.model, row.slug].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !CLAUDE_MODEL_ID.test(id)) return [];
    const label = [row.name, row.displayName, row.label].find((candidate): candidate is string => typeof candidate === "string");
    return [{ id, label: label || id }];
  });
}

/** Extra ids from ~/.claude/settings.json. Official cloud rows stay untagged.
 *  `model` is Claude Code's last-used slug, not a catalog — listing it as
 *  Custom put a non-inject id in the picker and the turn then had no
 *  ANTHROPIC_API_KEY ("Not logged in · Please run /login"). Live injects
 *  come from mergeLocalInject. */
export function readClaudeModelCatalog(env: Record<string, string | undefined> = process.env) {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(join(claudeConfigDir(env), "settings.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return STATIC_CLAUDE_MODELS;
  }

  const extras = [
    ...extrasFromUnknown(settings.availableModels),
    ...extrasFromUnknown(settings.customModels),
    ...extrasFromUnknown(settings.extraModels),
  ];
  const nestedEnv = settings.env && typeof settings.env === "object" ? (settings.env as Record<string, unknown>) : {};
  const envModel = nestedEnv.ANTHROPIC_MODEL ?? env.ANTHROPIC_MODEL;
  if (typeof envModel === "string") extras.push(...extrasFromUnknown([envModel]));

  const options = STATIC_CLAUDE_MODELS.options.map((option) => ({ ...option }));
  const seen = new Set(options.map((option) => option.id));
  for (const extra of extras) {
    if (seen.has(extra.id)) continue;
    seen.add(extra.id);
    options.push({ id: extra.id, label: extra.label, custom: true });
  }
  return { default: STATIC_CLAUDE_MODELS.default, options };
}

// Resolved from the server root, never relative to this file: bundling inlines
// this module into an entry one directory up, so a `".."` here would climb too
// far. See server/proxy-paths.ts.
const PROXY_PATH = SPAWNED_PROXIES.computer;
const PERM_PROXY_PATH = SPAWNED_PROXIES.permission;
const DWEB_PROXY_PATH = SPAWNED_PROXIES.dweb;
// in the packaged app process.execPath is the Electron binary — this env
// makes it behave as plain node for the spawned MCP proxies (harmless in dev)
const NODE_ENV_FLAG = { ELECTRON_RUN_AS_NODE: "1" };

function removePrivateTempDir(filePath: string | null | undefined): boolean {
  if (!filePath) return true;
  try {
    rmSync(dirname(filePath), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
  } catch {
    return false;
  }
}

// ── permission broker (ported from agentcal drivers/claude.js) ─────────
// A headless run that hits a permission acceptEdits doesn't cover should
// neither stall silently NOR get blanket-denied — it should ask the user.
// The broker is a net server on a per-turn socket; the proxy (spawned by
// the claude CLI) forwards asks over it and waits. Unanswered permission
// asks deny after timeoutMs with a keep-moving note. Unanswered questions
// wait up to 30 minutes and then receive an honest "nobody answered" —
// never an invented answer presented as the owner's (0.1.52 ASK2).
interface Ask {
  id: string;
  kind: "permission" | "question";
  tool: string;
  input: Record<string, unknown>;
  at: number;
  /** question asks: what the card shows and what answers are checked against */
  questions?: QuestionSpec[];
}
type AskBehavior = "allow" | "deny" | "answer";
type AskResolutionSource = "user" | "timeout" | "system";

const DENY_TIMEOUT_NOTE =
  "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";
/** The engine wait for a question, overridable per instance
 * (`config.questionTimeoutMs`) and bounded so a typo cannot hold a turn for
 * days or expire a card before a person could read it. */
function questionTimeoutFor(value: unknown): number {
  const ms = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : QUESTION_TIMEOUT_MS;
  return Math.min(Math.max(ms, 1_000), 24 * 60 * 60_000);
}
const DUPLICATE_ASK_ID_NOTE = "Murage: duplicate ask id, so this request is skipped.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "Murage: the turn is ending, so wrap up." }
    : { behavior: "deny", message: "Murage: the turn ended" };
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (ask.questions?.length) return ask.questions[0]!.question.slice(0, 300);
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return approvalSummary(input.command);
  if (typeof input.url === "string") return input.url.slice(0, 200);
  const text = JSON.stringify(input);
  return text === "{}" ? (ask.tool ?? "tool") : text.slice(0, 200);
}

export function permissionSocketPath(threadId: string) {
  // A readable prefix alone is not unique: ids that agree on their first
  // characters ("t-perm-dup-1", "t-perm-dup-2") would share a socket. POSIX
  // hides that — a new broker's listen replaces the socket FILE, so the name
  // always points at the fresh server — but Windows named pipes live in a
  // global namespace that is never unlinked, and a reused name races the
  // previous broker's async teardown. Half the tag is a digest of the FULL
  // id so distinct threads get distinct sockets; the tag stays at 8 chars
  // total because the POSIX path already brushes the 104-byte sun_path
  // limit under deep tmp home dirs.
  const prefix = threadId.replace(/[^\w-]/g, "").slice(0, 4);
  const digest = createHash("sha256").update(threadId).digest("hex").slice(0, 4);
  return brokerSocketPath(DATA_DIR, `${prefix}${digest}`);
}

/** Paths the broker may bind, tried in order. Windows named pipes are never
 * unlinkable, and a hung CLI child from an earlier server process can hold a
 * name for minutes, so fresh suffixes let the new broker bind immediately.
 * POSIX gets a short temp fallback because macOS rejects Unix socket paths
 * longer than its small `sun_path` limit; a deep test HOME or long username
 * can otherwise make every approval silently unavailable. The proxy learns
 * the actual bound path from its argv, so either fallback is transparent. */
export function brokerSocketCandidates(threadId: string): string[] {
  const base = permissionSocketPath(threadId);
  if (process.platform !== "win32") {
    const scope = createHash("sha256")
      .update(`${DATA_DIR}\0${process.pid}\0${threadId}`)
      .digest("hex")
      .slice(0, 16);
    return [base, join(tmpdir(), `murage-perm-${scope}.sock`)];
  }
  return [
    base,
    `${base}-${randomBytes(3).toString("hex")}`,
    `${base}-${randomBytes(3).toString("hex")}`,
  ];
}

export async function createPermissionBroker(opts: {
  /** Candidate bind paths, tried in order; the first that listens wins. */
  socketPaths: string[];
  onAsk: (ask: Ask) => void;
  onResolve: (resolved: Ask & { behavior: AskBehavior; source: AskResolutionSource }) => void;
  isActive?: () => boolean;
  timeoutMs?: number;
  /** How long a question waits for the owner (default 30 min). */
  questionTimeoutMs?: number;
  /** Read when a permission ask arrives: true for a routine run's turn,
   * whose cards wait until answered or the turn stops instead of the
   * timeoutMs deny (SendTurnInput.holdPermissionAsks). */
  holdPermissionAsks?: () => boolean;
  holdProjectAsks?: () => boolean;
}) {
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const questionTimeoutMs = questionTimeoutFor(opts.questionTimeoutMs);
  const pending = new Map<
    string,
    {
      ask: Ask;
      finish: (
        behavior: AskBehavior,
        message: string | undefined,
        source: AskResolutionSource,
        answers?: Record<string, string | string[]>,
      ) => void;
    }
  >();
  // server.close() only stops accepting NEW connections — it does not touch
  // a connection that's already open. A still-alive child's MCP proxy can
  // keep sending asks on such a connection after the turn has ended, and
  // this handler stays fully wired to it. Without this flag those asks would
  // become new `pending` entries and `request.opened` cards for a turn the
  // driver already forgot (`active.delete(threadId)` already ran), which can
  // never be answered — the "zombie card" in issue #211.
  let closed = false;
  let boundPath = opts.socketPaths[0] ?? "";
  const connectionHandler = (conn: import("node:net").Socket) => {
    conn.on("error", () => {});
    // The ask proxy runs in the engine's process tree, so its socket is
    // engine-controlled ingress too (A4). An oversized ask is never parsed:
    // dropping the connection makes permission-proxy answer every ask on it
    // with a deny.
    const askLines = createBoundedLineSplitter({
      onLine: (line) => handleAskLine(line),
      onOverflow: () => conn.destroy(),
    });
    conn.on("data", (chunk: Buffer) => askLines.push(chunk));
    const handleAskLine = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.t !== "ask") return;
      const askId = String(msg.id ?? newId());
      const kind = msg.kind === "question" ? ("question" as const) : ("permission" as const);
      if (closed) {
        // Closure is terminal and takes precedence over every active-turn
        // rule, including duplicate-id rejection. Never register a pending
        // entry or notify onAsk, but always answer an existing connection:
        // permission-proxy.ts only resolves on an explicit answer (or a
        // connection error/close), so a silent drop would hang the tool.
        try {
          conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
        } catch {}
        return;
      }
      // A retained Claude process keeps its proxy connection between
      // turns. Late/background asks must still fail closed without opening
      // a card for a turn that has already settled.
      if (opts.isActive && !opts.isActive()) {
        try {
          conn.write(JSON.stringify({ t: "answer", id: askId, ...systemEndedReply(kind) }) + "\n");
        } catch {}
        return;
      }
      // `pending` is server-scoped, not per-connection: two asks with the
      // same id — a buggy/adversarial client, never a legitimate retry
      // (permission-proxy mints a fresh randomUUID per ask) — would
      // otherwise let the second `pending.set` silently overwrite the
      // first, orphaning it as an unanswerable card once the first
      // resolves and deletes the shared key. Reject before either ask
      // becomes visible to onAsk.
      if (pending.has(askId)) {
        // askId is client-controlled; JSON.stringify escapes newlines and
        // control characters so it can't corrupt the log line or terminal.
        console.error(`permission broker on ${boundPath}: duplicate ask id ${JSON.stringify(askId)} — denying`);
        try {
          conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: DUPLICATE_ASK_ID_NOTE }) + "\n");
        } catch {}
        return;
      }
      const ask: Ask = { id: askId, kind, tool: msg.tool ?? "tool", input: msg.input ?? {}, at: Date.now() };
      if (kind === "question") {
        // Engine-controlled input becomes a card only once it is bounded and
        // well formed. A question the owner cannot be shown is answered at
        // once with why, instead of opening a card nobody can answer.
        const normalized = ask.tool === "AskUserQuestion" ? fromClaude(ask.input) : fromMuragebox(ask.input);
        if (!normalized.ok) {
          try {
            conn.write(JSON.stringify({ t: "answer", id: askId, behavior: "deny", message: QUESTION_NOTES.unshowable(normalized.error) }) + "\n");
          } catch {}
          return;
        }
        ask.questions = normalized.questions;
      }
      const finish = (
        behavior: AskBehavior,
        message: string | undefined,
        source: AskResolutionSource,
        answers?: Record<string, string | string[]>,
      ) => {
        if (!pending.delete(askId)) return;
        clearTimeout(timer);
        try {
          conn.write(JSON.stringify({ t: "answer", id: askId, behavior, message, ...(answers ? { answers } : {}) }) + "\n");
        } catch {}
        opts.onResolve({ ...ask, behavior, source });
      };
      // A question left unanswered gets an honest non-answer: Claude sees a
      // deny whose note says nobody answered, never a guess in the owner's
      // name. The card stays behind as Expired with "Send as a message".
      const timer = opts.holdProjectAsks?.() || (kind === "permission" && opts.holdPermissionAsks?.()) ? undefined : setTimeout(
        () =>
          kind === "question"
            ? finish("deny", QUESTION_NOTES.timeout(Math.max(1, Math.round(questionTimeoutMs / 60_000))), "timeout")
            : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
        kind === "question" ? questionTimeoutMs : timeoutMs,
      );
      timer?.unref?.();
      pending.set(askId, { ask, finish });
      opts.onAsk(ask);
    };
  };
  // Bind the first candidate that will take a listener. A broker that
  // never came up used to be silent — every approval then timed out into a
  // deny nobody could explain. Keep the turn fail-closed on total failure,
  // but leave an actionable diagnostic either way.
  let server: ReturnType<typeof createNetServer> | null = null;
  for (const [index, candidate] of opts.socketPaths.entries()) {
    const attempt = createNetServer(connectionHandler);
    try {
      unlinkSync(candidate);
    } catch {}
    let outcome = await new Promise<"listening" | (Error & { code?: string })>((resolve) => {
      attempt.once("listening", () => resolve("listening"));
      // SAFETY: net 'error' events carry syscall errors; the optional
      // `code` is only read defensively below.
      attempt.once("error", (error) => resolve(error as Error & { code?: string }));
      attempt.listen(candidate);
    });
    // A fallback under the shared OS temp root must not be connectable by
    // another local account. DATA_DIR is private already, but applying the
    // same mode to every POSIX socket keeps the rule simple and fail-closed.
    if (outcome === "listening" && process.platform !== "win32") {
      try {
        chmodSync(candidate, 0o600);
      } catch (error) {
        try {
          attempt.close();
        } catch {}
        try {
          unlinkSync(candidate);
        } catch {}
        outcome = error as Error & { code?: string };
      }
    }
    if (outcome === "listening") {
      if (index > 0) {
        console.error(`permission broker: ${opts.socketPaths[0]} is still held — bound fallback ${candidate}`);
      }
      boundPath = candidate;
      server = attempt;
      attempt.on("error", (error) => {
        console.error(`permission broker error on ${candidate}: ${error.message}`);
      });
      break;
    }
    try {
      attempt.close();
    } catch {}
    if (index === opts.socketPaths.length - 1) {
      console.error(`permission broker unavailable on ${candidate}: ${outcome.message}`);
      break;
    }
  }
  // Never hand the proxy an occupied candidate when every bind failed. That
  // could connect it to a stale (or unrelated) listener instead of this
  // broker, defeating the fail-closed boundary.
  if (!server) throw new Error("claude: permission broker could not bind a local socket");
  const drain = () => {
    for (const p of [...pending.values()]) {
      const { behavior, message } = systemEndedReply(p.ask.kind);
      p.finish(behavior, message, "system");
    }
  };
  return {
    /** Settle one ask. A question takes `answer` (with the owner's picks)
     * or `deny` — an explicit skip, delivered immediately. Before 0.1.52 a
     * deny on a question was refused, so closing a question card left
     * Claude waiting out the whole timeout. */
    answer(askId: string, behavior: AskBehavior, message?: string, answers?: QuestionAnswer[]): boolean {
      const p = pending.get(askId);
      if (!p) return false;
      if (p.ask.kind === "question") {
        if (behavior === "allow") return false;
        if (behavior === "deny") {
          p.finish("deny", message || QUESTION_NOTES.skipped, "user");
          return true;
        }
        const questions = p.ask.questions ?? [];
        const given = answers?.length ? answers : answersFromMessage(questions, message);
        if (!given) return false;
        const checked = validateAnswers(questions, given);
        if (!checked.ok) return false;
        if (p.ask.tool === "AskUserQuestion") {
          p.finish("answer", undefined, "user", toClaudeAnswers(questions, checked.answers));
        } else {
          p.finish("answer", toMessageText(questions, checked.answers), "user");
        }
        return true;
      }
      if (behavior === "answer") return false;
      p.finish(behavior, message, "user");
      return true;
    },
    pause() {
      drain();
    },
    close() {
      closed = true;
      drain();
      try {
        server?.close();
      } catch {}
      try {
        unlinkSync(boundPath);
      } catch {}
    },
    /** Where the broker actually listens — argv for the proxy child must
     * use this, not the deterministic base, when a fallback was bound. */
    socketPath: boundPath,
  };
}

function decodeToolList(value: unknown, field: "tools" | "disallowedTools"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`claude: ${field} must be an array of non-empty strings`);
  const decoded: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`claude: ${field} must be an array of non-empty strings`);
    }
    const normalized = entry.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    decoded.push(normalized);
  }
  return decoded;
}

function decodeConfig(raw: unknown): ClaudeConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = o.permissionMode;
  if (mode !== undefined && mode !== "default" && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
    throw new Error(`claude: invalid permissionMode ${JSON.stringify(mode)}`);
  }
  const tools = decodeToolList(o.tools, "tools");
  const disallowedTools = decodeToolList(o.disallowedTools, "disallowedTools");
  if(o.configDir!==undefined&&typeof o.configDir!=="string")throw new Error("claude: configDir must be a string");
  const configDir=typeof o.configDir==="string"?o.configDir.trim():undefined;
  if(configDir)resolveClaudeConfigDir(configDir);
  const questionTimeoutMs = o.questionTimeoutMs;
  if (questionTimeoutMs !== undefined && (typeof questionTimeoutMs !== "number" || !Number.isFinite(questionTimeoutMs) || questionTimeoutMs <= 0)) {
    throw new Error("claude: questionTimeoutMs must be a positive number of milliseconds");
  }
  const backgroundTaskCapMs = o.backgroundTaskCapMs;
  if (backgroundTaskCapMs !== undefined && (typeof backgroundTaskCapMs !== "number" || !Number.isFinite(backgroundTaskCapMs) || backgroundTaskCapMs <= 0)) {
    throw new Error("claude: backgroundTaskCapMs must be a positive number of milliseconds");
  }
  return {
    ...(typeof questionTimeoutMs === "number" ? { questionTimeoutMs } : {}),
    ...(typeof backgroundTaskCapMs === "number" ? { backgroundTaskCapMs } : {}),
    cli: typeof o.cli === "string" ? o.cli : "claude",
    ...(configDir?{configDir}:{}),
    permissionMode: (mode as ClaudeConfig["permissionMode"]) ?? "acceptEdits",
    ...(tools !== undefined ? { tools } : {}),
    ...(disallowedTools !== undefined ? { disallowedTools } : {}),
  };
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** A turn's own cost from the CLI's total_cost_usd, which is not a per-turn
 * figure: it is "cumulative across turns in streaming-input sessions — each
 * result carries the running total so far" (2.1.282), and a retained process
 * runs turn after turn. So a turn costs the growth since the total its
 * process reported for the turn before — or, for a process's first turn,
 * since the total the CLI restored on --resume (see restoredCostBase). With
 * no known start (null) the turn keeps its whole figure. A total that went
 * down is not the same count, so it is taken whole too rather than booked as
 * a negative cost. Rounding to 1e-10 USD removes only the float noise of the
 * subtraction. */
export function turnCostFromRunningTotal(total: number | null, previous: number | null): number | null {
  if (total === null) return null;
  if (previous === null || total < previous) return total;
  return Number((total - previous).toFixed(10));
}

/** One running cost state, read from a `result`: total_cost_usd and, per
 * model, the [input, cache read, cache write, output] tokens of modelUsage.
 * Both count the whole session so far, including anything --resume restored. */
export interface ClaudeCostSnapshot {
  total: number;
  models: Record<string, [number, number, number, number]>;
}

export function claudeCostSnapshot(total: unknown, modelUsage: unknown): ClaudeCostSnapshot | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const models: ClaudeCostSnapshot["models"] = {};
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const u = raw as Record<string, unknown>;
      models[model] = [count(u.inputTokens), count(u.cacheReadInputTokens), count(u.cacheCreationInputTokens), count(u.outputTokens)];
    }
  }
  return { total, models };
}

/** The running total a resumed session already carried before this
 * process's first turn. On --resume the CLI (2.1.282) restores the session's
 * cost from an earlier state — not always the latest one this driver saw —
 * so that turn's total_cost_usd and modelUsage include the earlier turns.
 * The restored state is the earlier state that sits inside the new counts
 * and leaves exactly this turn's own usage: in one model (usage leaves out
 * side calls such as a Haiku title) or summed over all models (a turn split
 * between two); nothing restored is 0. When no state fits exactly — the CLI
 * saved work that never reported a result, like an interrupted turn — the
 * latest state inside the new counts stands, so that work is booked once,
 * with this turn. Either way the latest state wins, not the highest total:
 * a resume that went back to an older state leaves later, lower totals. */
export function restoredCostBase(
  earlier: readonly ClaudeCostSnapshot[],
  current: ClaudeCostSnapshot,
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
): number {
  const turn = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  const nothing: ClaudeCostSnapshot = { total: 0, models: {} };
  let exact: number | null = null;
  let inside = 0;
  // oldest first: the session's states in the order they were recorded
  for (const state of [nothing, ...earlier]) {
    const within = Object.entries(state.models).every(([model, counts]) =>
      counts.every((n, i) => n <= (current.models[model]?.[i] ?? 0)));
    if (!within) continue;
    inside = state.total;
    const growth = Object.entries(current.models).map(([model, counts]) =>
      counts.map((n, i) => n - (state.models[model]?.[i] ?? 0)));
    const isTurn = (counts: number[]) => counts.every((n, i) => n === turn[i]);
    const summed = turn.map((_, i) => growth.reduce((sum, counts) => sum + counts[i]!, 0));
    if (growth.some(isTurn) || isTurn(summed)) exact = state.total;
  }
  return exact ?? inside;
}

/** Each Claude session's latest cost states, so the first turn after a
 * --resume can tell what the CLI restored — after an app restart too. Small
 * by design: a few states for the most recent sessions. */
const COST_HISTORY_FILE = join(DATA_DIR, "claude-cost-history.json");
const COST_HISTORY_SESSIONS = 100;
const COST_HISTORY_STATES = 8;

function isCostSnapshot(value: unknown): value is ClaudeCostSnapshot {
  if (!value || typeof value !== "object") return false;
  const { total, models } = value as { total?: unknown; models?: unknown };
  return typeof total === "number" && !!models && typeof models === "object" &&
    Object.values(models).every((counts) => Array.isArray(counts) && counts.length === 4 && counts.every((n) => typeof n === "number"));
}

/** Session ids come from files and from the CLI; the names every object
 * already has are never a key. */
const FORBIDDEN_COST_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readCostHistory(): Record<string, ClaudeCostSnapshot[]> {
  const history: Record<string, ClaudeCostSnapshot[]> = Object.create(null);
  try {
    const parsed: unknown = JSON.parse(readFileSync(COST_HISTORY_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return history;
    for (const [id, states] of Object.entries(parsed)) {
      if (FORBIDDEN_COST_KEYS.has(id)) continue;
      history[id] = Array.isArray(states) ? states.filter(isCostSnapshot) : [];
    }
  } catch {
    return Object.create(null);
  }
  return history;
}

function recordCostState(sessionId: string, state: ClaudeCostSnapshot): void {
  if (FORBIDDEN_COST_KEYS.has(sessionId)) return;
  const history = readCostHistory();
  const states = [...(history[sessionId] ?? []), state].slice(-COST_HISTORY_STATES);
  // most recent session last, so the oldest ones are dropped first
  delete history[sessionId];
  history[sessionId] = states;
  const ids = Object.keys(history);
  for (const id of ids.slice(0, Math.max(0, ids.length - COST_HISTORY_SESSIONS))) delete history[id];
  try {
    writeFileAtomic(COST_HISTORY_FILE, JSON.stringify(history), { mode: 0o600 });
  } catch {
    // a lost state only means a later resume keeps its whole figure
  }
}

// Idle warm children are held by the shared adaptive pool (warm-pool.ts): no
// fixed count, memory-aware, least recently used evicted first, never a busy one.
/** The managed (policy) settings files Claude Code reads on this platform, each with its
 * `managed-settings.d` drop-in directory beside it. */
export function managedClaudeSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") return ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  if (platform === "win32") return ["C:\\Program Files\\ClaudeCode\\managed-settings.json", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"];
  return ["/etc/claude-code/managed-settings.json"];
}
function fileStamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}
function dropInStamp(dir: string): string {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => `${name}=${fileStamp(join(dir, name))}`).join(",") || "-";
  } catch {
    return "-";
  }
}
const gitRootsByCwd = new Map<string, string[]>();
/** The git roots whose `.claude/settings.local.json` Claude Code resolves for `cwd`: the
 * repository root (`--show-toplevel`) and, for a linked worktree, the main checkout's root
 * (the parent of `--git-common-dir`). Cached per cwd; empty outside git or without git. */
export function claudeGitRoots(cwd: string): string[] {
  const cached = gitRootsByCwd.get(cwd);
  if (cached) return cached;
  let roots: string[] = [];
  try {
    const [top, common] = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, windowsHide: true }).split(/\r?\n/).map((line) => line.trim());
    // git prints forward slashes and long names on Windows while join() of a relative answer keeps
    // the caller's separators and 8.3 names, so one root could appear twice in two spellings
    const canonical = (path: string): string => {
      try {
        return realpathSync.native(path);
      } catch {
        return resolve(path);
      }
    };
    if (top) roots.push(canonical(top));
    if (common) {
      const commonDir = isAbsolute(common) ? common : join(cwd, common);
      const main = canonical(dirname(commonDir));
      if (/[\\/]\.git$|^\.git$/.test(commonDir) && !roots.includes(main)) roots.push(main);
    }
  } catch {
    roots = [];
  }
  gitRootsByCwd.set(cwd, roots);
  return roots;
}
/** mtime+size (never contents) of every settings file the CLI loads once per process: the
 * global config dir's, the project's `<cwd>/.claude/settings.json` and `settings.local.json`,
 * the local file at the repository root and the main checkout's root (as Claude Code resolves
 * it from a subdirectory or a worktree), and the managed policy files. A change to any (hooks,
 * MCP servers, permissions, effort) ends reuse. */
export function claudeSettingsRevision(env: NodeJS.ProcessEnv, cwd: string, managed: string[] = managedClaudeSettingsPaths()): string {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const project = join(cwd, ".claude");
  const local = [...new Set([project, ...claudeGitRoots(cwd).map((root) => join(root, ".claude"))])];
  return [
    ...["settings.json", "settings.local.json"].map((name) => fileStamp(join(dir, name))),
    fileStamp(join(project, "settings.json")),
    ...local.map((path) => fileStamp(join(path, "settings.local.json"))),
    ...managed.flatMap((path) => [fileStamp(path), dropInStamp(join(dirname(path), "managed-settings.d"))]),
  ].join("|");
}

export const ClaudeDriver: ProviderDriver<ClaudeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Claude", supportsMultipleInstances: true },
  // npm on all three: the one recipe that is genuinely cross-platform. The
  // native installers differ per OS and would need verifying separately.
  install: {
    command: {
      darwin: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      win32: "npm install -g @anthropic-ai/claude-code",
    },
    needsNode: true,
    docsUrl: "https://claude.com/claude-code",
    signInCommand: "claude auth login",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    // The engine as Settings names this instance, for every line the chat shows.
    const ENGINE = input.displayName?.trim() || "Claude";
    const { instanceId, config } = input;
    const accountEnvironment=()=>claudeAccountEnvironment({...process.env,...input.environment},config.configDir);
    const prepareTextOnlyTurn = (selection: string, providerRoute?: ProviderTurnRoute) => {
      const account = accountEnvironment();
      const env = claudeEnvironment(providerRoute?.model || selection, account, providerRoute);
      const model = providerRoute?.model || claudeRouting({ ...env }, selection).model || selection;
      return { model, turn: (turn: import("../memory/pip-transport.ts").TextOnlyTurnInput) => claudeTextOnlyTurn({ ...turn, model, providerRoute }, {
        cli: config.cli, tmpBase: join(DATA_DIR, "pip-tmp"), env,
        credentialsDir: providerRoute ? undefined : resolveClaudeConfigDir(config.configDir, account),
      }) };
    };
    const catalogEnv: Record<string, string | undefined> = accountEnvironment();
    // readClaudeModelCatalog reads `env.ANTHROPIC_MODEL` into an extra picker
    // row; an ambient one from a provider switcher would offer a phantom model
    // the spawned CLI is never pointed at.
    stripRoutingEnv(catalogEnv);
    let models = STATIC_CLAUDE_MODELS;
    const refreshModels = async () => {
      try {
        // Local rows only after a Local models test proved /v1/messages (spec E3).
        const resolved = await mergeLocalInject(readClaudeModelCatalog(catalogEnv), catalogEnv, fetch, { driver: DRIVER_KIND });
        // Flux rows are gated on claudeAgent having an implemented surface AND
        // a configured key; the key is read from config/process.env, never
        // from catalogEnv, which is frozen at create().
        if (resolved.options.length) models = mergeFluxCatalog(resolved, DRIVER_KIND);
      } catch {
        // Keep the last usable catalog when settings.json is unreadable.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread; a second send while busy is a caller bug
    interface ActiveTurn {
      stop: () => void;
      turnId: string;
      broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
      /** Murage asked this turn to stop (interruptTurn/resetSession/stopAll). */
      stopRequested: () => boolean;
      /** Resolves when the turn is over here: its child closed (or a retry
       * backoff was cancelled) and the thread is free for the next send. */
      closed: Promise<void>;
      close: () => void;
    }
    const active = new Map<string, ActiveTurn>();
    const activeTurn = (turnId: string, broker: ActiveTurn["broker"], stop: () => void, stopRequested: () => boolean): ActiveTurn => {
      let close = () => {};
      const closed = new Promise<void>((resolve) => { close = resolve; });
      return { stop, turnId, broker, stopRequested, closed, close };
    };
    /** The thread's turn is over: forget it and release anyone waiting behind its Stop. */
    const forgetActive = (threadId: string) => {
      const entry = active.get(threadId);
      if (!entry) return;
      active.delete(threadId);
      entry.close();
    };

    // One live CLI process per thread, kept across turns. Under
    // --input-format stream-json the CLI settles a turn with `result` while
    // stdin stays open, takes the next user message on the same stdin as a
    // new turn, and folds a message that arrives MID-turn into the running
    // one before its next model call (verified against 2.1.221 — that fold
    // is what "steer" is). So a session is spawned once, reused while its
    // spawn contract (args, MCP config, cwd, model) is unchanged, closed
    // after SESSION_IDLE_MS of quiet, and resumed by --resume when needed.
    /** One user turn on a session. `sawStreamDelta` is UI de-dup state only
     * and resets after each completed assistant block. `boundary` is the
     * monotonic accepted/output record that the retry guard reads (A1, U-17). */
    interface SessionTurn {
      turnId: string;
      settled: boolean;
      sawStreamDelta: boolean;
      authFailed?: boolean;
      /** the CLI is too old for the model (claudeVersionTooOld) */
      updateRequired?: boolean;
      boundary: AttemptBoundary;
      /** this turn's own user-message write; null until it is attempted */
      submission: Promise<boolean> | null;
      /** Set when Murage stopped this turn (interruptTurn, resetSession,
       * stopAll). Its process exit is then a cancellation, not a crash. */
      stopRequested?: boolean;
      /** One of Claude Code's own "/" commands. A local one (/context,
       * /cost) answers only in `result.result`, with no assistant message,
       * so that text is shown when the turn produced none of its own. */
      engineCommand?: boolean;
      answered?: boolean;
      /** A routine run: its permission cards wait for the owner. */
      holdPermissionAsks?: boolean;
      holdProjectAsks?: boolean;
      /** The engine's background sub agents for this turn (see handleLine). */
      bg?: BackgroundState;
      /** A continuation of an EARLIER turn (a background task's notice, then
       * the model's follow-up) is playing out on this process. Its frames
       * belong to that turn and are dropped until its own result closes it. */
      lateContinuation?: boolean;
      /** A notice for a task this turn does not own arrived: the process
       * carried earlier work into this turn, so it is not kept after it. */
      foreignNotice?: boolean;
    }
    interface BackgroundState {
      tracker: SubtaskTracker;
      /** ids of agent tasks the engine still runs in the background */
      open: Set<string>;
      /** a result arrived while `open` was not empty: the turn is held */
      waiting: boolean;
      cap?: ReturnType<typeof setTimeout>;
      /** token totals of results that did not settle the turn */
      usage: { input: number; output: number; cachedInput: number };
    }
    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
      mcpConfigPath: string | null;
      systemPromptPath: string | null;
      /** the spawn contract — a different one means a fresh process */
      warm: WarmKey;
      /** This process's own credential file (0600, own 0700 dir). Written at
       * each turn's start, emptied at its settle, unlinked on recycle/exit. */
      cred: TurnCredentialStore | null;
      /** Descendants the engine started on its own (MCP servers): an async
       * probe started while the CLI's `init` message is handled, limited to
       * processes that had started by that moment; anything beyond them at
       * settle is background work. undefined until init; resolves null when
       * the probe failed or timed out (the settle check then recycles). */
      childBaseline?: Promise<Set<number> | null>;
      /** `init` has been handled (and the baseline probe started). */
      initHandled?: boolean;
      /** The CLI has written its first stdout frame: it is up and has read its start files. */
      startConfirmed?: boolean;
      /** A prewarm's startup bound; cancelled on confirmation and on close. */
      startupTimer?: ReturnType<typeof setTimeout> | null;
      /** Steers that arrived before `init` was handled; written once it is. */
      queuedSteers?: Array<{ turn: SessionTurn; text: string; beforeWrite?: () => void; resolve: (written: boolean) => void }>;
      /** Which turn started each background task the CLI reported, so a frame
       * about a task is only ever attached to the turn that owns it. */
      taskOwner?: Map<string, string>;
      /** The settle-time process-tree probe; a next dispatch waits for it. */
      settleCheck?: Promise<void> | null;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the running turn, or null between turns */
      turn: SessionTurn | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
      /** The CLI's running total that the next turn's cost is measured from
       * (see turnCostFromRunningTotal): what --resume restored until the
       * first turn settles, then the last settled turn's total_cost_usd.
       * undefined until the first result; null when the start is unknown. */
      costTotal: number | null | undefined;
      finishClose?: () => Promise<void>;
      /** Claude Code's "/" commands. `init` names them (`slash_commands`,
       * and `terminal_slash_commands` for the ones bound to a terminal
       * screen); the `initialize` control response describes them. Either
       * can arrive first, so both are kept and the list is re-reported when
       * it changes. */
      commands?: {
        requestId: string;
        names?: unknown[];
        terminalOnly?: string[];
        details?: Map<string, { description?: unknown; argumentHint?: unknown }>;
        reported?: string;
      };
    }
    const sessions = new Map<string, Session>();
    /** Sessions that were closed or replaced and whose process is not yet
     * CONFIRMED stopped, with the thread each belongs to. `sessions` forgets a
     * session the moment a replacement takes its slot; this registry does not,
     * so Stop, reset and dispose still reach a predecessor whose shutdown is
     * pending or failed, and can report that it could not be stopped. */
    const retiring = new Map<Session, string>();
    const configuredIdleMinimum = Number(process.env.MURAGE_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.MURAGE_CLAUDE_SESSION_IDLE_MS) || 15 * 60_000);

    const backgroundCapMs = backgroundWaitCapMs(config.backgroundTaskCapMs);
    const backgroundOf = (t: SessionTurn): BackgroundState =>
      (t.bg ??= { tracker: new SubtaskTracker(), open: new Set(), waiting: false, usage: { input: 0, output: 0, cachedInput: 0 } });
    /** Only sub agents hold a turn open. A background shell command (a dev
     * server) can run for hours and raises no asks of its own. */
    const isAgentTask = (taskType: unknown, subagentType: unknown) =>
      (typeof taskType === "string" && taskType.endsWith("_agent")) || typeof subagentType === "string";

    const stopSession = (session: Session) => {
      warmPool.release(session);
      killCliTree(session.child);
      void awaitCliTreeStopped(session.child).then((stopped) => {
        if (stopped) void session.finishClose?.();
      });
    };
    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      warmPool.release(s);
      retiring.set(s, threadId);
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = null;
      if (s.startupTimer) clearTimeout(s.startupTimer);
      s.startupTimer = null;
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      // the process is going away: its credential file goes with it
      s.cred?.dispose();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // The reason a warm process was not kept, where diagnostics can see it.
      console.info(`claude close thread=${threadId} reason=${why}`);
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        stopSession(s);
      }, 5_000);
      kill.unref?.();
    };
    /** Kill and confirm every retiring session (of one thread, or all); the
     * number that could NOT be confirmed stopped stay registered. */
    const stopRetiring = async (threadId?: string): Promise<number> => {
      const targets = [...retiring].filter(([, owner]) => threadId === undefined || owner === threadId).map(([session]) => session);
      const confirmed = await Promise.all(targets.map(async (session) => {
        killCliTree(session.child);
        const stopped = await awaitCliTreeStopped(session.child);
        if (stopped) {
          retiring.delete(session);
          void session.finishClose?.();
        }
        return stopped;
      }));
      return confirmed.filter((stopped) => !stopped).length;
    };
    const requireRetiredStopped = async (threadId?: string) => {
      const failed = await stopRetiring(threadId);
      if (failed) throw new Error(`CLAUDE_SESSION_NOT_STOPPED: ${failed} earlier Claude process${failed === 1 ? "" : "es"} could not be confirmed stopped`);
    };
    const armIdle = (threadId: string, hold = false) => {
      const s = sessions.get(threadId);
      if (!s || s.turn || s.closing || s.child.exitCode !== null) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        if (sessions.get(threadId) === s) closeSession(threadId, "idle");
      }, SESSION_IDLE_MS);
      s.idleTimer.unref?.();
      warmPool.release(s);
      void warmPool.markIdle(s, {
        engine: "claude",
        threadId,
        pid: () => s.child.pid,
        spawnedAt: spawnedAtOf(s.child),
        background: backgroundThreads.has(threadId),
        hold,
        close: (reason) => {
          if (sessions.get(threadId) === s) closeSession(threadId, reason);
        },
      });
    };
    /** Writes one user message. With a boundary, the turn's submission state
     * follows the write: in-flight once bytes are handed over, then written or
     * refused when the write reports. A refused write never delivered the
     * trailing newline, so the CLI cannot have read the message whole.
     *
     * `images` makes `content` an array of Anthropic content blocks instead of
     * a bare string — the shape the CLI already reads on this exact stdin path
     * (it counts, compacts and re-sends `{type:"image",source:{type:"base64",
     * media_type,data}}` blocks off a user message's content array). Text
     * first, pictures after, so a prompt that says "the image below" still
     * reads in order. No images means the bare string, byte-for-byte as before:
     * a turn with no attachment must not change shape. */
    const writeUser = (s: Session, threadId: string, text: string, boundary?: AttemptBoundary, images?: SendTurnInput["images"]): Promise<boolean> => {
      const content = images?.length
        ? [
            { type: "text", text },
            ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
          ]
        : text;
      const promptMsg = { type: "user", message: { role: "user", content } };
      if (!s.child.stdin.writable || s.child.stdin.destroyed) {
        boundary?.markRefused();
        return Promise.resolve(false);
      }
      return new Promise((resolve) => {
        try {
          boundary?.markInFlight();
          s.child.stdin.write(JSON.stringify(promptMsg) + "\n", (error) => {
            if (error) {
              boundary?.markRefused();
              return resolve(false);
            }
            boundary?.markWritten();
            // The native log is a debugging transcript a person reads and
            // attaches to a bug report. Ten megabytes of base64 per image
            // would bury it and copy the picture somewhere nobody expects it,
            // so the log keeps the shape and drops the bytes.
            appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: images?.length ? { ...promptMsg, message: { role: "user", content: [{ type: "text", text }, ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: `<${image.data.length} base64 chars elided>` } }))] } } : promptMsg });
            resolve(true);
          });
        } catch {
          boundary?.markRefused();
          resolve(false);
        }
      });
    };

    /** Writes the steers that waited for `init`, each only if its turn is
     * still the live, unstopped one: a Stop or close in between writes nothing. */
    const flushQueuedSteers = (s: Session, threadId: string, written = true) => {
      const queued = s.queuedSteers;
      s.queuedSteers = undefined;
      for (const item of queued ?? []) {
        const live = written && s.turn === item.turn && !item.turn.settled && !item.turn.stopRequested && !s.closing && s.child.exitCode === null;
        if (!live || !steerFenceHolds(item.beforeWrite)) item.resolve(false);
        else void writeUser(s, threadId, item.text).then(item.resolve);
      }
    };
    /** A steer's fence (steer's `beforeWrite`), run right before its write. */
    const steerFenceHolds = (beforeWrite: (() => void) | undefined): boolean => {
      try { beforeWrite?.(); return true; } catch { return false; }
    };

    /** Turn ids that belong to an intent warm: the engine is up but no turn exists, so
     * nothing carrying one of these ids reaches a listener. The init frame's
     * `session.started` is held and replayed on the first real turn that adopts the engine. */
    const prewarmTurns = new Set<string>();
    const heldStarted = new Map<string, RuntimeEvent>();
    const emit = (event: RuntimeEvent) => {
      if (prewarmTurns.has((event as { turnId?: string }).turnId ?? "")) {
        if (event.type === "session.started") heldStarted.set(event.threadId, event);
        return;
      }
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });
    // retry bookkeeping lives PER THREAD, not per sendTurn call: a relaunch
    // is a fresh sendTurn, and the attempt cap must survive across launches
    const retryState = new Map<string, { attempt: number; cancelled: boolean }>();

    /** `relaunch` is the retry path's own: a transient pre-accept exit
     * relaunches the CLI for the SAME turn, so the relaunch keeps the id the
     * caller was given. The harness binds the run, its folder writer lease,
     * its internal capability generation and a channel routine's delivery to
     * that id, and `turn.retrying` already carries it; a fresh id on the
     * relaunch made the eventual turn.completed a stranger's — the run was
     * never released and the bot stayed busy until restart. */
    const backgroundThreads = new Set<string>();
    /** The spawn inputs of each thread's last user turn, memory only (never written to
     * disk): what an intent warm starts the next engine from. The text, images and
     * command are dropped; the resume cursor is refreshed when a turn settles. */
    const lastTurns = createTurnMemory<SendTurnInput>();
    const prewarming = createPrewarmGate();
    const sendTurn = async (turn: SendTurnInput, relaunch?: { turnId: string }) => {
      const { threadId } = turn;
      if (turn.background) backgroundThreads.add(threadId); else backgroundThreads.delete(threadId);
      if (!turn.background && !relaunch) {
        warmPool.noteUserActivity(); warmPool.sent(threadId);
        lastTurns.remember(threadId, spawnInputsOf(turn));
      }
      // An intent warm is still starting this thread's engine: take it over, never fail as busy.
      if (!relaunch && prewarming.has(threadId)) {
        if (!(await prewarming.wait(threadId))) {
          const stuck = active.get(threadId);
          if (stuck) { try { stuck.stop(); } catch {} }
        }
      }
      const running = active.get(threadId);
      // A relaunch runs under its own logical turn's stop handle (U06), which
      // the retry path left in place so Stop stays reachable during setup.
      if (running && !(relaunch && running.turnId === relaunch.turnId)) {
        if (!running.stopRequested()) throw new Error("a turn is already running on this thread");
        // A Stop is "requested, not observed": interruptTurn returns as soon
        // as the kill is sent, the harness reads the thread idle, and the
        // person's next message can arrive while the stopped child is still
        // closing — the real CLI tears down its MCP children and flushes
        // first, and Windows ends it through an asynchronous taskkill. That
        // turn is not "already running": wait for its close, bounded by the
        // same deadline the harness gives a stopped child, then proceed.
        await Promise.race([
          running.closed,
          new Promise<void>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("the stopped turn has not closed yet; wait a moment and send again")), providerCloseDeadlineMs());
            timer.unref?.();
            void running.closed.finally(() => clearTimeout(timer));
          }),
        ]);
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      }
      const turnId = relaunch?.turnId ?? newId();
      // Reserve the thread BEFORE the first await on the dispatch path (model
      // lookup, settle check, broker bind), so a Stop that lands during setup
      // has an entry to reach and a rival dispatch is refused or waits for it.
      // A relaunch already holds its own entry (the retry path's handle).
      let reservation: ActiveTurn | null = null;
      let stoppedBeforeLaunch = false;
      let wake = () => {};
      const stopped = new Promise<void>((resolve) => { wake = resolve; });
      if (!relaunch) {
        reservation = activeTurn(turnId, undefined, () => { stoppedBeforeLaunch = true; wake(); }, () => stoppedBeforeLaunch);
        active.set(threadId, reservation);
      }
      try {
        return await dispatchTurn(turn, relaunch, { turnId, reservation, stopped, isStopped: () => stoppedBeforeLaunch });
      } catch (error) {
        if (error instanceof StoppedBeforeLaunch) {
          // The user's Stop reached this turn during setup: nothing launched.
          if (active.get(threadId)?.turnId === turnId) forgetActive(threadId);
          retryState.delete(threadId);
          if (!relaunch) emit({ ...base(threadId, turnId), type: "turn.started" });
          if (warmPool.consumeColdWake(threadId)) {
            // the warm engine was released while idle: say so instead of waiting silently
            console.info(`claude wake thread=${threadId} cold=true`);
            emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: `wake-${turnId}`, title: "Waking up: starting a fresh engine after a quiet spell" });
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: `wake-${turnId}`, ok: true });
          }
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
          return { turnId };
        }
        // Any other failure before launch releases the reservation it made.
        if (reservation && active.get(threadId) === reservation) forgetActive(threadId);
        throw error;
      }
    };

    const dispatchTurn = async (
      turn: SendTurnInput,
      relaunch: { turnId: string } | undefined,
      ctl: { turnId: string; reservation: ActiveTurn | null; stopped: Promise<void>; isStopped: () => boolean },
    ): Promise<{ turnId: string }> => {
      const { threadId } = turn;
      if (turn.prewarm) prewarmTurns.add(ctl.turnId);
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      // Murage's Full access stops before deleting outside its folder, paying
      // and messaging someone new (server/stop-line.ts). That only holds if
      // the CLI asks, so a bypass instance runs this turn in acceptEdits with
      // the broker: Murage answers everything else at once. File edits stay
      // the CLI's own (acceptEdits), which is fine: an edit is not a delete.
      const permissionMode = (turn.stopLine || turn.routeAsks) && config.permissionMode === "bypassPermissions" ? "acceptEdits" : config.permissionMode;
      if (controlsHost && permissionMode === "bypassPermissions") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = ctl.turnId;
      // A command turn is the command alone: Claude Code runs "/name args"
      // sent as the prompt in stream-json mode (the Agent SDK's documented
      // way to run one), and reads it only when "/" opens the message.
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      // Only a genuinely new user turn starts un-cancelled. A relaunch keeps
      // a Stop that landed while it was being scheduled or set up (U06).
      if (!relaunch) retry.cancelled = false;
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = !turn.sessionReset && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", permissionMode === "auto" ? "acceptEdits" : permissionMode,
      ];
      // Folders the server granted this bot, for reads without an ask. Never
      // in Ask mode ("default"): there the CLI keeps asking for what it asked
      // before. Only an absolute, existing directory is passed, canonicalized.
      if (permissionMode === "acceptEdits" || permissionMode === "auto") {
        const granted = new Set<string>();
        for (const dir of turn.addDirs ?? []) {
          if (typeof dir !== "string" || !isAbsolute(dir)) continue;
          try {
            if (statSync(dir).isDirectory()) granted.add(realpathSync(dir));
          } catch { /* a folder that is gone is not granted */ }
        }
        for (const dir of granted) args.push("--add-dir", dir);
      }
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      const disallowedTools = [...new Set([
        ...(config.disallowedTools ?? []),
        // These native tools address provider sessions, not Murage's roster.
        ...(turn.integrations?.agents ? ["ListAgents", "SendMessage"] : []),
      ])];
      if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
      const turnEnvironment: NodeJS.ProcessEnv = accountEnvironment();
      // Every await on the dispatch path (model lookup, settle check, broker
      // bind) lets a second dispatch on this thread in, or a Stop. The thread
      // is held by this dispatch's reserved `active` entry, so re-check after
      // each await: the entry must still be ours (a rival must never reach the
      // busy-recycle, killing this turn's process, or spawn a second one),
      // and a Stop that reached it means nothing may launch.
      const assertSoleDispatch = () => {
        const raced = active.get(threadId);
        if (ctl.reservation) {
          if (raced !== ctl.reservation) throw new Error("a turn is already running on this thread");
        } else if (raced && !(relaunch && raced.turnId === relaunch.turnId) && !raced.stopRequested()) {
          throw new Error("a turn is already running on this thread");
        }
        if (relaunch ? retry.cancelled : ctl.isStopped()) throw new StoppedBeforeLaunch();
      };
      /** This dispatch takes the thread's entry over from its reservation. */
      const claimActive = (entry: ActiveTurn) => {
        const previous = active.get(threadId);
        active.set(threadId, entry);
        if (previous && previous === ctl.reservation) previous.close();
      };
      const turnModel = turn.providerRoute ? turn.providerRoute.model : await resolveClaudeTurnModel(turn.model, turnEnvironment);
      assertSoleDispatch();
      // argv and the process-reuse key below must come from the SAME routing
      // decision the spawn env gets from `claudeEnvironment`. A throwaway copy
      // is enough — only `.model` is read — but it has to go through
      // `claudeRouting`, not `applyClaudeInject`: for a Flux id the inject
      // returns `{ injected: false }` and argv would then carry no `--model`
      // at all while the env said `flux-auto`, and `argsKey` would match a live
      // natively-routed process and hand it the Flux turn.
      const injected = turn.providerRoute ? { model: turn.providerRoute.model, injected: true } : claudeRouting({ ...turnEnvironment }, turnModel);
      if (injected.model) args.push("--model", injected.model);
      if (turn.effort) args.push("--effort", turn.effort);

      // A room prompt can contain section context, skills, memory, playbooks,
      // and browser/agent instructions. Passing that text directly on argv
      // exceeds Windows' CreateProcess command-line limit and surfaces as
      // `spawn ENAMETOOLONG`. Claude accepts the same prompt from a file, so
      // keep both the text and its potentially sensitive contents off argv.
      let systemPromptPath: string | null = null;

      // integrations → MCP servers; pre-allow their tools (a headless
      // acceptEdits run silently denies anything unlisted)
      const mcpServers: Record<string, unknown> = {};
      const allowed: string[] = [];
      if (turn.integrations?.composio) {
        mcpServers.composio = { ...turn.integrations.composio };
        // Connected apps are where a bot pays, deletes mail and messages
        // people. Under the stop line their calls reach Murage's broker so
        // those three can wait for the owner; every other call is answered
        // at once. Below Full (routeAsks) the same holds: the stop line
        // reads every ask whatever the mode, so a send or a payment from an
        // Ask or Auto bot raises its card instead of being pre-approved.
        if (!turn.stopLine && !turn.routeAsks) allowed.push("mcp__composio");
      }
      if (turn.integrations?.computer) {
        mcpServers.computer = {
          command: process.execPath,
          args: [PROXY_PATH],
          env: { ...NODE_ENV_FLAG, ...computerProxyEnv(turn.integrations.computer) },
        };
        allowed.push("mcp__computer");
      } else if (turn.integrations?.localComputer) {
        const local = turn.integrations.localComputer;
        mcpServers.computer = {
          command: local.command,
          args: local.args,
          env: local.env,
        };
        // The isolated Local VM preserves the established pre-allow behavior.
        // Host tools always route through Murage's permission broker.
        if (!controlsHost) allowed.push("mcp__computer");
      }
      // peer-agent comms (list_bots/ask_bot) — the harness builds the whole
      // spawn contract (command/args/env incl. the boot token) in
      // agentsIntegration(); pre-allowing matters doubly here, or the CLI's
      // own ListAgents look-alike shadows it and "@Bot" asks go nowhere
      if (turn.integrations?.agents) {
        mcpServers.agents = { ...turn.integrations.agents };
        allowed.push("mcp__agents");
      }
      if (turn.integrations?.memory) {
        if (Object.hasOwn(turn.integrations.custom ?? {}, "murage-memory")) throw new Error("MEMORY_MCP_NAME_COLLISION");
        mcpServers["murage-memory"] = { ...turn.integrations.memory };
        allowed.push("mcp__murage-memory");
      }
      // The phone and the browser are mounted just below, under these names.
      turn = renderMurageTurn(turn, CLAUDE_TOOL_SURFACE, { agents: mcpServers.agents ? "agents" : undefined, memory: mcpServers["murage-memory"] ? "murage-memory" : undefined,
        phone: turn.integrations?.phone ? "phone" : undefined, browser: turn.integrations?.browser ? "browser" : undefined });
      const turnPrompt = turn.engineCommand ? engineCommandText(turn.engineCommand) : turn.text;
      if (turn.integrations?.phone) {
        mcpServers.phone = { ...turn.integrations.phone };
        allowed.push("mcp__phone");
      }
      if (turn.integrations?.browser) {
        mcpServers.browser = { ...turn.integrations.browser };
        allowed.push("mcp__browser");
      }
      // dweb network daemon (status / repo / opencode model access) via
      // server/drivers/dweb-proxy.ts — points at the configured dweb instance
      if (turn.integrations?.dweb) {
        mcpServers.dweb = {
          command: process.execPath,
          args: [DWEB_PROXY_PATH],
          env: {
            ...NODE_ENV_FLAG,
            DWEB_URL: turn.integrations.dweb.url,
          },
        };
        allowed.push("mcp__dweb");
      }
      // user-configured servers mount like any integration but are NOT
      // pre-allowed: acceptEdits silently denies unlisted tools, which
      // routes every custom tool call through the muragebox permission broker
      // into an Allow/Deny card. Reserved names were filtered upstream;
      // skip any residual collision instead of clobbering a built-in.
      for (const mount of customMountEntries(turn.integrations?.custom, (name) => name in mcpServers)) {
        mcpServers[mount.name] = { command: mount.command, args: mount.args, env: mount.env };
      }
      // permission broker: anything acceptEdits would silently deny becomes
      // an Allow/Deny card in chat, and the agent gets ask_user. Skipped in
      // bypassPermissions (fullAuto) — nothing would ever ask.
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      let socketPath: string | null = null;
      if (permissionMode !== "bypassPermissions") {
        socketPath = permissionSocketPath(threadId);
        args.push("--permission-prompt-tool", "mcp__muragebox__approve");
        mcpServers.muragebox = { command: process.execPath, args: [PERM_PROXY_PATH, socketPath], env: { ...NODE_ENV_FLAG } };
        allowed.push("mcp__muragebox");
      }
      // The MCP config carries credentials — a Composio consumer key in a
      // header, the box token in the computer proxy's env, the comms token in
      // the agents proxy's env. On argv every one of those is world-readable
      // through `ps` for the life of the turn, to any local process. The CLI
      // accepts a FILE for this flag, so the secrets go in a 0600 file that
      // is removed when the turn settles.
      let mcpConfigPath: string | null = null;
      if (Object.keys(mcpServers).length) {
        mcpConfigPath = join(mkdtempSync(join(tmpdir(), "murage-mcp-")), "mcp.json");
        args.push("--mcp-config", mcpConfigPath);
        args.push("--allowedTools", allowed.join(","));
      }

      // Flux Memory headers are decided per thread audience and are part of the
      // spawn contract: a change of audience, purpose or memory choice differs
      // in the warm key below and forces a respawn.
      const fluxMemory = fluxMemoryDecision(fluxMemoryContextForTurn(turn));
      const env = claudeEnvironment(turnModel, turnEnvironment, turn.providerRoute, fluxMemory);
      const cwd = turn.cwd ?? homedir();
      // Everything that shapes the process, minus session/turn-specific temp
      // paths. Their contents are represented directly in the key instead.
      const privateFileFlags = new Set(["--mcp-config"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      // Per-turn capability tokens leave env for the process's credential
      // file, so the key sees only what is stable. Field order is the order
      // `diffWarmKey` reports: identity first, then the cheap named fields,
      // then the raw argv.
      const { stableServers, secrets } = splitTurnSecrets(mcpServers);
      const warm = warmKey({
        bot: turn.warmIdentity?.botId ?? null,
        thread: threadId,
        audience: turn.warmIdentity ? [turn.warmIdentity.audience, turn.warmIdentity.decidedOwner === true, turn.warmIdentity.humanPrincipal ?? null] : null,
        permissionMode,
        // below-Full asks route to Murage's broker (int3): a permission change, so it recycles
        routeAsks: turn.routeAsks === true,
        model: injected.model ?? null,
        providerRoute: turn.providerRoute ? [turn.providerRoute.connectionId, turn.providerRoute.revision] : null,
        baseUrl: env.ANTHROPIC_BASE_URL ?? null,
        fluxMemory: env.ANTHROPIC_CUSTOM_HEADERS ? fluxMemory.signature : null,
        // The credential the process was launched with, whichever route put it
        // in env (local host, Flux, a provider connection, the CLI's own
        // token): a digest, so a rotated key respawns without the key being
        // kept anywhere. The base URL above stays readable for the reason.
        credentials: credentialDigest(Object.fromEntries(Object.entries(env).filter(([name]) => /^(ANTHROPIC_|CLAUDE_CODE_)/.test(name)))),
        cwd,
        mcp: stableServers,
        system: turn.system ?? null,
        args: keyArgs,
        settingsRev: claudeSettingsRevision(env, cwd),
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Anything else: close it and spawn fresh
      // (with --resume, so the conversation continues in the new process).
      // A missing cursor alone still reuses (legacy callers send none), so a
      // rebuilt conversation says so explicitly: without the reset an edit,
      // branch switch, cwd or engine change replayed the transcript on top
      // of the idle process's old context (upstream 581a740b, #1562).
      const live = sessions.get(threadId);
      // A settle-time process probe may still be deciding whether this process
      // can be kept; the answer comes before this turn picks a process.
      if (live?.settleCheck) {
        // A Stop during the wait ends it at once: nothing is launched for it.
        await Promise.race([live.settleCheck, ctl.stopped]);
        // The await let a Stop or another dispatch on this thread in: neither
        // may go on to recycle or reuse the first turn's process.
        try {
          assertSoleDispatch();
        } catch (error) {
          if (mcpConfigPath) {
            try { rmSync(dirname(mcpConfigPath), { recursive: true, force: true }); } catch {}
          }
          throw error;
        }
      }
      if (turn.prewarm && live && !live.closing && live.child.exitCode === null) {
        // an engine is already live on this thread: nothing to warm
        if (mcpConfigPath) {
          try { rmSync(dirname(mcpConfigPath), { recursive: true, force: true }); } catch {}
        }
        throw new Error("an engine is already live on this thread");
      }
      const spawnReason: string | null = !live
        ? "no-process"
        : turn.sessionReset ? "sessionReset"
        : live.turn ? "busy"
        : live.closing || live.child.exitCode !== null ? "process-exited"
        : pastWarmMaxAge(spawnedAtOf(live.child)) ? "max-age"
        : diffWarmKey(live.warm, warm) ?? (sessionId && sessionId !== live.sessionId ? "cursor" : null);
      const dispatchTrace = `claude dispatch thread=${threadId} process=${spawnReason === null ? "reused reason=unchanged" : `spawned reason=${spawnReason}`}`;
      console.info(dispatchTrace);
      if (spawnReason !== null && env.ANTHROPIC_CUSTOM_HEADERS) logFluxMemoryHeaders(DRIVER_KIND, fluxMemory);
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { dispatch: dispatchTrace } });
      if (live && spawnReason === null) {
        // The submission fence (SendTurnInput.beforeSubmit): no await
        // separates it from the write below. A refusal writes nothing and
        // leaves the idle process in the warm pool as it was; the harness resets it.
        try {
          turn.beforeSubmit?.();
        } catch (error) {
          if (mcpConfigPath) {
            try { rmSync(dirname(mcpConfigPath), { recursive: true, force: true }); } catch {}
          }
          throw error;
        }
        warmPool.release(live);
        try {
          live.cred?.write(secrets);
        } catch (error) {
          closeSession(threadId, "credential write failed");
          throw error;
        }
        if (live.idleTimer) clearTimeout(live.idleTimer);
        live.idleTimer = null;
        const liveTurn: SessionTurn = {
          turnId,
          settled: false,
          sawStreamDelta: false,
          boundary: createAttemptBoundary(),
          submission: null,
          engineCommand: Boolean(turn.engineCommand),
          holdPermissionAsks: turn.holdPermissionAsks === true,
          holdProjectAsks: turn.holdProjectAsks === true,
        };
        live.turn = liveTurn;
        claimActive(activeTurn(turnId, live.broker, () => {
          liveTurn.stopRequested = true;
          stopSession(live);
        }, () => liveTurn.stopRequested === true));
        emit({ ...base(threadId, turnId), type: "turn.started" });
        // an intent-warmed engine's init frame arrived before any turn existed: report it now
        const held = heldStarted.get(threadId);
        if (held) { heldStarted.delete(threadId); emit({ ...held, turnId, eventId: newEventId(), createdAt: new Date().toISOString() } as RuntimeEvent); }
        // A Stop inside the turn.started listeners writes nothing.
        liveTurn.submission = liveTurn.stopRequested ? Promise.resolve(false) : writeUser(live, threadId, turnPrompt, liveTurn.boundary, turn.images);
        const written = await liveTurn.submission;
        // A Stop during the write kills the pipe, so the write fails. That is
        // the Stop, not a broken session: the child's close settles this turn
        // as cancelled once the kill is confirmed (upstream #1701).
        if (!written && !liveTurn.stopRequested) {
          forgetActive(threadId);
          live.turn = null;
          if (sessions.get(threadId) === live) closeSession(threadId, "stdin write failed");
          retryState.delete(threadId);
          if (mcpConfigPath) {
            try {
              rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
            } catch {}
          }
          throw new Error("claude session stdin is not writable");
        }
        // the MCP config was for the first spawn; nothing to clean here
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        return { turnId };
      }
      if (live) closeSession(threadId, turn.sessionReset ? "context reset" : spawnReason === "max-age" ? "max-age" : `spawn contract changed: ${spawnReason}`);
      let cred: TurnCredentialStore | null = null;

      // Until sessions.set() below, this turn owns every launch resource.
      // Any bind, private-config or synchronous spawn failure must release
      // them here rather than leave a live listener or credential temp file.
      const cleanupUnownedLaunch = () => {
        broker?.close();
        broker = undefined;
        cred?.dispose();
        cred = null;
        if (mcpConfigPath) {
          try {
            rmSync(dirname(mcpConfigPath), { recursive: true, force: true });
          } catch {}
          mcpConfigPath = null;
        }
        if (systemPromptPath) {
          removePrivateTempDir(systemPromptPath);
          systemPromptPath = null;
        }
        retryState.delete(threadId);
      };

      try {
        // Create the prompt file only for a new process. A compatible live
        // session has already consumed the same system prompt at launch.
        if (turn.system) {
          systemPromptPath = join(mkdtempSync(join(tmpdir(), "murage-system-")), "prompt.txt");
          writeFileSync(systemPromptPath, turn.system, { mode: 0o600 });
          args.push("--append-system-prompt-file", systemPromptPath);
        }
        // Only create a broker for a new process. A compatible retained
        // process keeps its existing proxy connection and broker across turns.
        if (socketPath) {
          // remembers which tool each pending ask came from, so the resolved
          // event can scope approvals to real desktop-control tools only
          const askTools = new Map<string, string | undefined>();
          broker = await createPermissionBroker({
            socketPaths: brokerSocketCandidates(threadId),
            // never while an earlier turn's continuation is playing: its asks
            // are not this turn's to open a card for
            isActive: () => { const t = sessions.get(threadId)?.turn; return Boolean(t && !t.lateContinuation); },
            holdPermissionAsks: () => sessions.get(threadId)?.turn?.holdPermissionAsks === true,
            holdProjectAsks: () => sessions.get(threadId)?.turn?.holdProjectAsks === true,
            questionTimeoutMs: config.questionTimeoutMs,
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
              // The file this call names, from the CLI's own tool input
              // rather than from `summary` (which is that input stringified
              // and cut at 200 characters, so it stops being readable as data
              // exactly when the edit is long). Policy reads it only to
              // recognize the bot's own workspace and thread folders.
              const filePaths = toolFilePaths(ask.input);
              emit({
                ...base(threadId, eventTurnId),
                type: "request.opened",
                requestId: ask.id,
                requestType: ask.kind,
                tool: ask.tool,
                summary: askSummary(ask),
                approvalScope:
                  typeof ask.tool === "string" && controlsHost && ask.tool.startsWith("mcp__computer")
                    ? "local-computer"
                    : undefined,
                // the first question's labels keep voice and older clients working
                choices: ask.questions?.length
                  ? ask.questions[0]!.options.map((option) => option.label)
                  : Array.isArray(ask.input?.choices) ? (ask.input.choices as string[]).slice(0, 5) : undefined,
                ...(ask.questions?.length ? { questions: ask.questions } : {}),
                ...(filePaths ? { filePaths } : {}),
                // every argument, not just the command or url `summary` keeps
                ...(ask.kind === "permission" && boundedToolInput(ask.input) ? { toolInput: boundedToolInput(ask.input) } : {}),
                // the CLI's own tool name and input, for the stop line
                ...(typeof ask.tool === "string" ? { toolCall: { name: ask.tool, input: ask.input } } : {}),
              });
            },
            onResolve: (resolved) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              emit({
                ...base(threadId, eventTurnId),
                type: "request.resolved",
                requestId: resolved.id,
                behavior: resolved.behavior,
                source: resolved.source,
                approvalScope:
                  controlsHost && typeof askTools.get(resolved.id) === "string" && askTools.get(resolved.id)!.startsWith("mcp__computer") ? "local-computer" : undefined,
              });
              askTools.delete(resolved.id);
            },
          });
          // A fallback bind means the deterministic pipe is still held by an
          // earlier process's child. The proxy learns its path from argv, so
          // point it at the pipe we actually bound. argsKey deliberately keeps
          // the base path: the nonce is not part of the spawn contract, and a
          // retained session keeps its own broker object anyway.
          if (broker.socketPath !== socketPath && mcpConfigPath) {
            stableServers.muragebox = { command: process.execPath, args: [PERM_PROXY_PATH, broker.socketPath], env: { ...NODE_ENV_FLAG } };
          }
        }

        // The broker bind awaited: a second dispatch may have claimed the
        // thread meanwhile. Give up (the catch below closes the broker).
        assertSoleDispatch();
        // Headroom for one more engine: evicts an idle one if needed, never refuses.
        await warmPool.beforeSpawn();
        assertSoleDispatch();

        // This process's credential file, holding the first turn's tokens.
        if (Object.keys(secrets).length) {
          cred = createTurnCredentialStore();
          cred.write(secrets);
        }
        // Write once, only after the broker has selected its real endpoint.
        if (mcpConfigPath) {
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: cred ? bindCredentialPath(stableServers, cred.path) : stableServers }), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }

      // Stop reached this logical turn while it was still setting up (model
      // probe, settle check, broker bind). Settle it as the user's Stop (STOP1)
      // instead of spawning a process nobody wants. No await separates this
      // fence from the spawn below.
      if (relaunch ? retry.cancelled : ctl.isStopped()) {
        cleanupUnownedLaunch();
        throw new StoppedBeforeLaunch();
      }
      // The submission fence (SendTurnInput.beforeSubmit), on every launch
      // (a relaunch too). No await separates it from the spawn and the first
      // write below, so it holds at the write; a refusal spawns nothing.
      try {
        turn.beforeSubmit?.();
      } catch (error) {
        cleanupUnownedLaunch();
        if (typeof error === "object" && error !== null) submissionRefusals.add(error);
        throw error;
      }

      let child: ReturnType<typeof spawnCli>;
      try {
        child = spawnCli(config.cli, args, {
          cwd,
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        cleanupUnownedLaunch();
        throw error;
      }
      const launchTurn: SessionTurn = {
        turnId,
        settled: false,
        sawStreamDelta: false,
        boundary: createAttemptBoundary(),
        submission: null,
        engineCommand: Boolean(turn.engineCommand),
        holdPermissionAsks: turn.holdPermissionAsks === true,
          holdProjectAsks: turn.holdProjectAsks === true,
      };
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        systemPromptPath,
        warm,
        cred,
        sessionId: sessionId ?? newSessionId,
        turn: launchTurn,
        idleTimer: null,
        closing: false,
        stderr: "",
        commands: { requestId: `murage-commands-${newId()}` },
        costTotal: undefined,
      };
      sessions.set(threadId, session);

      /** The files the CLI read at its start (MCP config with its credentials, system prompt):
       * nothing needs them once it is running, so none sits on disk while it is idle. */
      const dropStartFiles = () => {
        if (session.mcpConfigPath) {
          try { rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true }); } catch {}
          session.mcpConfigPath = null;
        }
        if (session.systemPromptPath && removePrivateTempDir(session.systemPromptPath)) session.systemPromptPath = null;
      };
      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        total: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
        // A steer still waiting for `init` belongs to this turn, which has
        // ended: it is dropped now, never carried to another turn.
        flushQueuedSteers(session, threadId, false);
        let backgroundAlive = false;
        // turn N's tokens stop working here; the file is empty until N+1 starts
        let recycleReason: string | null = null;
        try {
          session.cred?.clear();
        } catch {
          // turn N's token may still be in the file: do not keep this process
          recycleReason = "credential clear failed";
        }
        if (t.bg) {
          if (t.bg.cap) clearTimeout(t.bg.cap);
          const stillOpen = t.bg.tracker.endAll(false);
          for (const subtask of stillOpen) emitSubtask(t, subtask);
          // a shell task or helper that never reported done is still running
          if (stillOpen.length || t.bg.open.size) backgroundAlive = true;
        }
        // Resolve any ask still open for this turn, but keep the broker
        // listening for the next turn on the retained process. Between turns
        // isActive() rejects late background asks without creating cards.
        session.broker?.pause();
        // the config file holds live credentials — the CLI read it at start;
        // it must not sit on disk for the life of the session
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
          session.mcpConfigPath = null;
        }
        if (session.systemPromptPath) {
          if (removePrivateTempDir(session.systemPromptPath)) session.systemPromptPath = null;
        }
        forgetActive(threadId);
        session.turn = null;
        // the next intent warm resumes this conversation, not the one the turn began with
        if (session.sessionId) lastTurns.patch(threadId, { resumeCursor: session.sessionId, sessionReset: false });
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        // Updating the executable cannot update code this pooled child has
        // already loaded. Retire it before the turn completes so a retry
        // resumes on a fresh process; other threads' sessions stay warm.
        if (stopReason === "update_required") closeSession(threadId, "update required");
        // Background work from this turn must not ride into the next one inside
        // a process we keep: recycle instead of reusing.
        if (backgroundAlive) closeSession(threadId, "background work alive at settle");
        // A notice for another turn's task reached this one: earlier work was
        // still running on this process, so it is not carried any further.
        if (t.foreignNotice) recycleReason ??= "late task notification";
        // Sign-in state is loaded once per process: after an auth failure the
        // process may hold stale credentials, so the next turn gets a fresh one.
        if (stopReason === "auth_required") recycleReason ??= "auth required";
        // `total` is the CLI's running total for this process; the harness
        // books turn.completed.cost as this turn's own spend
        const cost = turnCostFromRunningTotal(total, session.costTotal ?? null);
        if (total !== null) session.costTotal = total;
        // Decide whether this process stays BEFORE announcing the turn: a
        // listener that dispatches again inside the emit must already see the
        // settle check. The check fails closed: no baseline, no probe, or a
        // probe error all mean "not proven idle", so the process is recycled.
        if (session.child.exitCode === null && !session.closing) {
          const pid = session.child.pid;
          if (recycleReason) {
            closeSession(threadId, recycleReason);
          } else if (!pid || !session.childBaseline) {
            closeSession(threadId, "process probe has no baseline");
          } else {
            armIdle(threadId);
            const pending = session.childBaseline;
            // The check awaits: by the time it answers, this session may have
            // been closed or reset and a replacement spawned for the same
            // thread. It only ever closes the session it was started for.
            const closeThis = (why: string) => {
              if (sessions.get(threadId) === session && !session.closing) closeSession(threadId, why);
            };
            const stillCurrent = () => sessions.get(threadId) === session && !session.closing;
            const check = Promise.resolve().then(async () => {
              // Bounded wait: no baseline within 5 s means not proven idle.
              let timer: ReturnType<typeof setTimeout> | undefined;
              const baseline = await Promise.race([
                pending,
                new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), BASELINE_WAIT_MS); }),
              ]).finally(() => clearTimeout(timer));
              if (!stillCurrent()) return;
              if (!baseline) return closeThis("process probe has no baseline");
              const fresh = await untrackedDescendants(pid, baseline);
              if (!stillCurrent()) return;
              if (!fresh) closeThis("process probe unavailable");
              else if (fresh.size) {
                closeThis(`child processes alive at settle (${fresh.size})`);
                // Which programs, so a leftover that is really an MCP server's own
                // helper can be told from a tool's background job (names only).
                void processNames(fresh).then((names) => console.info(`claude leftover processes thread=${threadId} names=${names.join(",") || "gone"}`), () => {});
              }
            }).catch(() => closeThis("process probe failed")).finally(() => {
              if (session.settleCheck === check) session.settleCheck = null;
            });
            session.settleCheck = check;
          }
        }
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;
      const emitSubtask = (t: SessionTurn, subtask: ReturnType<SubtaskTracker["end"]>) => {
        if (!subtask || !t.bg) return;
        emit({ ...base(threadId, t.turnId), type: "turn.subtask", subtask, subtasks: t.bg.tracker.snapshot() });
      };
      // The turn has been held past the engine's first result for longer than
      // the cap: end it with a plain note (shown to the owner, and kept in the
      // thread the bot reads next turn), then stop the helpers.
      const endAtCap = () => {
        const t = session.turn;
        if (!t || t.settled || !t.bg?.waiting) return;
        const note = backgroundCapNote(backgroundCapMs);
        emit({ ...base(threadId, t.turnId), type: "content.delta", streamKind: "assistant_text", delta: note });
        emit({ ...base(threadId, t.turnId), type: "item.completed", itemType: "assistant_text", text: note });
        t.answered = true;
        settle(true, "background_wait_cap");
        closeSession(threadId, "background wait cap");
        stopSession(session);
      };
      // The process's first result with a cost says what --resume restored,
      // which its turns are measured from; every result is kept for a later
      // resume. A result without one (an API error) decides nothing yet.
      const noteCostState = (total: unknown, modelUsage: unknown, usage: Parameters<typeof restoredCostBase>[2]) => {
        const state = claudeCostSnapshot(total, modelUsage);
        if (!state) return;
        if (session.costTotal === undefined) {
          session.costTotal = session.sessionId
            ? restoredCostBase(readCostHistory()[session.sessionId] ?? [], state, usage)
            : null;
        }
        if (session.sessionId) recordCostState(session.sessionId, state);
      };
      // A tool_result names only the id it answers, and whether an image it
      // carries is a deliverable or one of Murage's own screen frames turns
      // on the tool's name. Remembered from the tool_use block and dropped
      // as the result consumes it, so nothing accumulates across a turn.
      const toolNameByUse = new Map<string, string>();

      /** Report the command list when it changed. Names come from `init`;
       * descriptions join them once the `initialize` answer is in. */
      const reportEngineCommands = () => {
        const known = session.commands;
        if (!known?.names) return;
        const raw = known.names.map((name) => {
          const detail = typeof name === "string" ? known.details?.get(name.replace(/^\//, "")) : undefined;
          return detail ? { name, ...detail } : name;
        });
        const commands = normalizeEngineCommands(raw, known.terminalOnly);
        const key = JSON.stringify(commands);
        if (key === known.reported) return;
        known.reported = key;
        emit({ ...base(threadId, currentTurnId()), type: "engine.commands", commands });
      };

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        // Startup is confirmed only by a validated signal: the `system`/`init` event, or the
        // control_response that carries OUR initialize request id and succeeded. A banner,
        // keep_alive, any other system frame and an unmatched control_response never count,
        // so the start files stay (under the retirement timer) until Claude itself says so.
        const startupSignal = !!o && typeof o === "object" && !Array.isArray(o) && (
          (o.type === "system" && o.subtype === "init")
          || (o.type === "control_response" && !!session.commands
            && o.response?.request_id === session.commands.requestId && o.response?.subtype === "success"));
        if (!session.startConfirmed && startupSignal) {
          // the CLI is up and has read its start files: an idle one (a prewarm) drops them
          session.startConfirmed = true;
          if (session.startupTimer) clearTimeout(session.startupTimer);
          session.startupTimer = null;
          if (!session.turn) dropStartFiles();
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
        const contentFrame = o.type === "stream_event" || o.type === "assistant" || o.type === "user";
        const taskFrame = o.type === "system" && typeof o.subtype === "string" && (o.subtype.startsWith("task_") || o.subtype === "background_tasks_changed");
        // Frames with no open turn were not asked for: a background task's
        // notice or the model's follow-up to it, from a turn that is over.
        // They belong to no turn, and must never be read as the next one's.
        // The process is running work nobody owns, so it is not kept.
        if ((!session.turn || session.turn.settled) && (contentFrame || taskFrame)) {
          if (!session.closing && sessions.get(threadId) === session) closeSession(threadId, "late frames while idle");
          return;
        }
        // The rest of an earlier turn's continuation, inside this one.
        if (session.turn?.lateContinuation && contentFrame) return;
        // Any model or tool frame (text, reasoning, a completed block, tool
        // use, tool result) proves the CLI took up the turn. Record it on the
        // one-way boundary; sawStreamDelta below stays UI de-dup state only.
        if (
          session.turn &&
          (o.type === "stream_event" ||
            o.type === "assistant" ||
            o.type === "user" ||
            (o.type === "system" && o.subtype === "thinking_tokens"))
        ) {
          session.turn.boundary.markOutput();
        }
        switch (o.type) {
          case "system":
            if (o.subtype === "init") {
              // The descendant baseline. `initAt` is recorded synchronously
              // here; the probe itself is async (a loaded machine can take
              // seconds to list processes, and the event loop serves every
              // thread) and keeps only processes that had started by initAt,
              // so a late probe never absorbs this turn's own work. Only the
              // first init of a process counts. A failed or timed out probe
              // resolves null: the settle check then fails closed.
              if (!session.initHandled) {
                session.initHandled = true;
                const initAt = Date.now();
                const childPid = session.child.pid;
                session.childBaseline = childPid
                  ? descendantBaseline(childPid, initAt).catch(() => null)
                  : Promise.resolve(null);
                flushQueuedSteers(session, threadId);
              }
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model });
              if (Array.isArray(o.slash_commands) && session.commands) {
                session.commands.names = o.slash_commands;
                session.commands.terminalOnly = Array.isArray(o.terminal_slash_commands)
                  ? o.terminal_slash_commands.filter((name: unknown): name is string => typeof name === "string")
                  : [];
                reportEngineCommands();
              }
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
            } else if (session.turn && !session.turn.settled && typeof o.subtype === "string") {
              // Sub agents and background tasks (frame shapes: the 2026-10-02
              // native.ndjson). Tracked for the turn they belong to.
              const t = session.turn;
              const bg = backgroundOf(t);
              const id = typeof o.task_id === "string" ? o.task_id : null;
              const owners = (session.taskOwner ??= new Map<string, string>());
              // This turn's own tasks only. An id another turn started is its
              // frame (a stale list entry, a late notice); one nobody here
              // started was begun by work that outlived its turn.
              const claim = (taskId: string, mayStart: boolean) => {
                const owner = owners.get(taskId);
                if (owner === t.turnId) return true;
                if (owner !== undefined || !mayStart) return false;
                if (owners.size >= 1024) owners.delete(owners.keys().next().value!);
                owners.set(taskId, t.turnId);
                return true;
              };
              if (o.subtype === "background_tasks_changed" && Array.isArray(o.tasks)) {
                // authoritative list of what runs in the background right now
                bg.open = new Set();
                for (const task of o.tasks) {
                  if (!task || typeof task.task_id !== "string" || !claim(task.task_id, true)) continue;
                  emitSubtask(t, bg.tracker.start(task.task_id, task.description));
                  if (isAgentTask(task.task_type, undefined)) bg.open.add(task.task_id);
                }
              } else if (o.subtype === "task_started" && id) {
                if (claim(id, true)) {
                  emitSubtask(t, bg.tracker.start(id, o.description));
                  if (o.is_backgrounded === true && isAgentTask(o.task_type, o.subagent_type)) bg.open.add(id);
                }
              } else if (o.subtype === "task_progress" && id) {
                if (claim(id, false)) emitSubtask(t, bg.tracker.progress(id, { label: o.description, toolCount: o.usage?.tool_uses }));
              } else if ((o.subtype === "task_notification" || o.subtype === "task_updated") && id) {
                if (!claim(id, false)) {
                  // a notice for another turn's task: its follow-up (model
                  // narration, asks) is coming and is not this turn's
                  if (o.subtype === "task_notification") {
                    t.lateContinuation = true;
                    t.foreignNotice = true;
                  }
                } else {
                  const status = o.subtype === "task_notification" ? o.status : o.patch?.status;
                  if (status === "completed" || status === "failed" || status === "killed" || status === "stopped") {
                    bg.open.delete(id);
                    emitSubtask(t, bg.tracker.end(id, status === "completed"));
                  }
                }
              }
            }
            break;
          case "stream_event": {
            // subagent narration is dropped — N parallel Tasks would
            // interleave their prose into one bubble (upstream-verified bug)
            if (o.parent_tool_use_id) break;
            const ev = o.event ?? {};
            if (ev.type !== "content_block_delta") break;
            const d = ev.delta ?? {};
            if (d.type === "text_delta" && typeof d.text === "string" && d.text) {
              if (session.turn) session.turn.sawStreamDelta = true;
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: d.text });
            } else if (d.type === "thinking_delta" && typeof d.thinking === "string" && d.thinking) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "reasoning_text", delta: d.thinking });
            }
            break;
          }
          case "assistant": {
            const msg = o.message ?? {};
            const text = firstText(msg.content);
            if (claudeAuthFailure(o, text)) {
              if (session.turn) session.turn.authFailed = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error",
                message: injected.injected ? "The selected model provider could not authenticate. Review its saved connection in Settings." : text || "Claude needs you to sign in. Open engine setup to continue.",
                setup: !injected.injected, ...(!injected.injected ? { authRequired: true } : { details: text }),
              });
              break;
            }
            if (claudeVersionTooOld(o, text)) {
              if (session.turn) session.turn.updateRequired = true;
              emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: text, setup: true, claudeUpdate: true });
              break;
            }
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) {
                session.turn.sawStreamDelta = false;
                session.turn.answered = true;
              }
              emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                if (typeof b.id === "string" && typeof b.name === "string" && toolNameByUse.size < 512) toolNameByUse.set(b.id, b.name);
                emit({ ...base(threadId, currentTurnId()), type: "item.started", itemType: "tool", itemId: b.id, title: b.name, input: b.input });
              }
            }
            if (msg.usage) {
              emit({
                ...base(threadId, currentTurnId()),
                type: "thread.token-usage.updated",
                input: (msg.usage.input_tokens || 0) + (msg.usage.cache_read_input_tokens || 0),
                output: msg.usage.output_tokens || 0,
                ...(typeof msg.usage.cache_read_input_tokens === "number"
                  ? { cachedInput: msg.usage.cache_read_input_tokens }
                  : {}),
              });
            }
            break;
          }
          case "user":
            for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
              if (b.type === "tool_result") {
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error, result: b.content });
                // The chip above was all this branch ever read. An image the
                // tool answered with was dropped here, never reaching the
                // attachment pipeline that has always been waiting for it.
                const toolName = typeof b.tool_use_id === "string" ? toolNameByUse.get(b.tool_use_id) : undefined;
                if (typeof b.tool_use_id === "string") toolNameByUse.delete(b.tool_use_id);
                for (const image of extractMcpImages(b.content, toolName)) {
                  emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_image", data: image.data, alt: toolName });
                }
              }
            }
            break;
          case "control_response": {
            // Only the answer to our own `initialize` is read, and only its
            // command descriptions: nothing else rides on it.
            const response = o.response ?? {};
            if (!session.commands || response.request_id !== session.commands.requestId) break;
            const described = response.response?.commands;
            if (response.subtype === "success" && Array.isArray(described)) {
              session.commands.details = new Map(
                described
                  .filter((entry: any) => entry && typeof entry.name === "string")
                  .map((entry: any) => [entry.name.replace(/^\//, ""), { description: entry.description, argumentHint: entry.argumentHint }]),
              );
              reportEngineCommands();
            }
            break;
          }
          case "result":
            // A stopped/completed background task can produce its own
            // synthetic follow-up result before the submitted user's reply.
            // It does not complete that user turn or release its broker/MCP
            // authority. The native protocol marks this result's origin;
            // do not infer ownership from text or reopen an idle turn.
            // While the turn is held for background sub agents, the
            // notification results ARE the turn's continuation (below).
            // A result that closes another turn's continuation belongs to that
            // turn, never to this one, even while this turn is held for its
            // own background agents: dropped here, and the process is
            // recycled at settle (foreignNotice).
            const foreignResult = session.turn?.lateContinuation === true && o.origin?.kind === "task-notification";
            if (session.turn) session.turn.lateContinuation = false;
            if (foreignResult) break;
            if (o.origin?.kind === "task-notification" && !session.turn?.bg?.waiting) break;
            // result.usage is this turn's own figure, "per-turn in
            // streaming-input sessions" even on a retained process. cache
            // reads count as input: they are billed (at the cache rate) and
            // they fill the window — but they are reported separately too, so
            // the UI can show how much of the figure was context re-read
            // rather than new text. total_cost_usd is instead the process's
            // running total; settle() books this turn's share.
            noteCostState(o.total_cost_usd, o.modelUsage, {
              input: o.usage?.input_tokens || 0,
              cacheRead: o.usage?.cache_read_input_tokens || 0,
              cacheWrite: o.usage?.cache_creation_input_tokens || 0,
              output: o.usage?.output_tokens || 0,
            });
            // An error result for a turn Murage asked to stop (a CLI that
            // reports its own interruption before exiting) is the Stop, not
            // an engine failure: same cancelled state as the close path.
            const stoppedResult = o.is_error === true && session.turn?.stopRequested === true && !session.turn.authFailed && !session.turn.updateRequired;
            // Stop owns the whole group; a result emitted while stopping is
            // not permission to release this turn before close finalization.
            if (session.turn?.stopRequested) return;
            if (stoppedResult) retryState.delete(threadId);
            // A local command (/context, /cost) answers here and nowhere else.
            if (session.turn?.engineCommand && !session.turn.answered && o.is_error !== true && typeof o.result === "string" && o.result.trim()) {
              emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: o.result });
              emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text: o.result });
            }
            // Background sub agents still run: this result is not the end of
            // the turn. Keep the broker active (their asks take the normal
            // approval path for the bot's mode), keep streaming, and wait for
            // the open count to reach 0 and the engine's closing result, a
            // Stop, or the cap.
            if (session.turn && !session.turn.settled && o.is_error !== true && !session.turn.authFailed && !session.turn.updateRequired && !stoppedResult && session.turn.bg && session.turn.bg.open.size > 0) {
              const bg = session.turn.bg;
              bg.usage.input += (o.usage?.input_tokens || 0) + (o.usage?.cache_read_input_tokens || 0) + (o.usage?.cache_creation_input_tokens || 0);
              bg.usage.output += o.usage?.output_tokens || 0;
              bg.usage.cachedInput += o.usage?.cache_read_input_tokens || 0;
              if (!bg.waiting) {
                bg.waiting = true;
                bg.cap = setTimeout(endAtCap, backgroundCapMs);
                bg.cap.unref?.();
              }
              break;
            }
            const heldUsage = session.turn?.bg?.waiting ? session.turn.bg.usage : null;
            settle(
              stoppedResult || (o.is_error !== true && !session.turn?.authFailed && !session.turn?.updateRequired),
              stoppedResult ? "cancelled" : session.turn?.authFailed ? "auth_required" : session.turn?.updateRequired ? "update_required" : o.stop_reason ?? o.terminal_reason ?? null,
              o.total_cost_usd ?? null,
              o.usage
                ? {
                    input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0) + (heldUsage?.input ?? 0),
                    output: (o.usage.output_tokens || 0) + (heldUsage?.output ?? 0),
                    ...(typeof o.usage.cache_read_input_tokens === "number"
                      ? { cachedInput: o.usage.cache_read_input_tokens + (heldUsage?.cachedInput ?? 0) }
                      : {}),
                  }
                : undefined,
            );
            break;
        }
      };

      // Byte-bounded framing (A4): UTF-8 is decoded per complete line, so a
      // multibyte character split across reads stays intact, and one frame
      // never holds more than ENGINE_FRAME_MAX_BYTES of the shared process.
      const stdoutLines = createBoundedLineSplitter({
        onLine: (line) => {
          if (!line.trim()) return;
          handleLine(line);
        },
        onOverflow: (overflow) => {
          appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: { frameOverflow: overflow } });
          // The stream is unrecoverable: fail the turn it belongs to (never a
          // replay — settle() clears the retry budget and the turn), then end
          // this retained process so no later frame is read out of context.
          if (session.turn && !session.turn.settled) {
            emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: frameOverflowMessage("Claude", overflow) });
            settle(false, FRAME_TOO_LARGE);
          }
          if (sessions.get(threadId) === session) closeSession(threadId, FRAME_TOO_LARGE);
          if (child.exitCode === null) killCliTree(child);
        },
      });
      child.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));

      child.stderr.on("data", (c) => {
        session.stderr += c;
        if (session.stderr.length > 8192) session.stderr = session.stderr.slice(-8192);
      });

      child.on("error", (e) => {
        emit({ ...base(threadId, currentTurnId()), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });

      // a turn still running when the process died is a failed turn; a
      // process that exited between turns (idle close, contract change)
      // is just a session ending
      const onChildClose = (code: number | null) => {
        warmPool.release(session);
        prewarmTurns.delete(turnId);
        if (sessions.get(threadId) === session) heldStarted.delete(threadId);
        if (session.turn && !session.turn.settled && session.turn.stopRequested) {
          // The process ended because Murage stopped the turn. That is the
          // user's Stop (or a reset/shutdown the caller reports itself), not
          // an engine failure: settle as cancelled like the ACP and Pi
          // drivers, with no runtime error card and no Retry. A stopped turn
          // is never replayed (U-17).
          retryState.delete(threadId);
          settle(true, "cancelled");
        } else if (session.turn?.updateRequired && !session.turn.settled) {
          // The CLI already said it is too old for the model and then exited
          // with no result frame: that is the whole answer. A second, generic
          // error card would contradict the update offer (audit round 1, Kimi 2).
          retryState.delete(threadId);
          settle(false, "update_required");
        } else if (session.turn && !session.turn.settled) {
          const closingTurn = session.turn;
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
          // The classifier reads the raw exit above; the chat reads plain words.
          const shown = engineClosedLine(ENGINE, code, undefined, session.stderr ? acpEngineExitStderrText(session.stderr.trim().slice(-300)) : undefined);
          if (
            !retry.cancelled &&
            code !== 0 &&
            verdict.transient &&
            // Only the turn that launched this process owns its relaunch. A
            // later turn on the retained session must never replay this
            // launch's text.
            closingTurn.turnId === turnId &&
            // U-17: replay only a proven pre-accept failure. Once the user
            // message was written, or any output or tool activity was seen,
            // the CLI may already have acted, so the turn fails visibly.
            isPreAcceptFailure(closingTurn.boundary) &&
            retry.attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            // the CLI is gone but the TURN continues: keep the thread busy,
            // emit no terminal event, and relaunch after the backoff. The
            // `active` entry STAYS — it is what makes an interrupt during
            // the backoff reach this turn's stop() and cancel the retry.
            // Steers queued for the dead launch's init are dropped here: the
            // relaunch never saw them and the early return below skips the
            // close path's cleanup.
            flushQueuedSteers(session, threadId, false);
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
            // the relaunch gets its own file; this one holds the in-flight turn's token
            session.cred?.dispose();
            if (session.mcpConfigPath) {
              try {
                rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
              } catch {}
              session.mcpConfigPath = null;
            }
            if (session.systemPromptPath) {
              removePrivateTempDir(session.systemPromptPath);
              session.systemPromptPath = null;
            }
            sessions.delete(threadId);
            session.turn = null;
            retry.attempt++;
            const delayMs = computeBackoff(retry.attempt - 1);
            emit({
              ...base(threadId, turnId),
              type: "turn.retrying",
              attempt: retry.attempt,
              delayMs,
              reason: verdict.reason,
            });
            void (async () => {
              const wait = interruptibleDelay(delayMs * retryScale, retryAbort.signal);
              await wait.promise;
              // an interrupt during the backoff landed here via stop(); the
              // turn settles as cancelled and no zombie relaunch happens
              if (retry.cancelled) {
                forgetActive(threadId);
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: true,
                  stopReason: "cancelled",
                  cost: null,
                });
                return;
              }
              // The logical turn continues across the relaunch (U06): its
              // setup has no process yet, so this handle only records the
              // Stop and the relaunched sendTurn honours it before spawning.
              // Keeping the entry also keeps the thread busy, so no other
              // send can start beside the relaunch. Nobody waits behind the
              // old entry (a stopped turn never reaches this branch).
              const previous = active.get(threadId);
              active.set(threadId, activeTurn(turnId, undefined, () => {
                retry.cancelled = true;
              }, () => retry.cancelled));
              previous?.close();
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                // The reset was consumed by the first launch. The retry
                // resumes the new session, never the context it replaced.
                await sendTurn({ ...turn, sessionReset: false, resumeCursor: cursor }, { turnId });
              } catch (e) {
                if (active.get(threadId)?.turnId === turnId) forgetActive(threadId);
                retryState.delete(threadId);
                // A refused relaunch wrote nothing: the harness re-runs the
                // turn on a reset session, so there is no engine error to show.
                const refused = typeof e === "object" && e !== null && submissionRefusals.has(e);
                if (!refused) emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: refused ? "submission_refused" : "exit_before_result",
                  cost: null,
                });
              }
            })();
            return;
          }
          retryState.delete(threadId);
          emit({
            ...base(threadId, currentTurnId()),
            type: "runtime.error",
            message: shown,
          });
          // the process died before the prompt was even attempted (the baseline
          // wait) or its write was refused: the prompt never reached the CLI
          settle(false, closingTurn.boundary.submission === "refused" || closingTurn.submission === null ? "stdin_write_failed" : "exit_before_result");
        }
        flushQueuedSteers(session, threadId, false);
        if (session.idleTimer) clearTimeout(session.idleTimer);
        if (session.startupTimer) clearTimeout(session.startupTimer);
        session.startupTimer = null;
        session.broker?.close();
        session.cred?.dispose();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        removePrivateTempDir(session.systemPromptPath);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      };
      let closeFinalized = false;
      child.on("close", (code) => {
        warmPool.release(session);
        // A user-message write still in flight when the process died has an
        // unknown outcome until its callback reports. Node destroys stdin on
        // exit, so it reports promptly; decide only after it has, so the
        // guard never guesses whether the message was delivered.
        session.finishClose = async () => {
          if (closeFinalized) return;
          const closingTurn = session.turn;
          if (closingTurn && !closingTurn.settled && closingTurn.boundary.submission === "in-flight" && closingTurn.submission) {
            await closingTurn.submission;
          }
          if (!(await awaitCliTreeStopped(child))) {
            emit({ ...base(threadId, currentTurnId()), type: "runtime.error", message: `${ENGINE} has not finished closing yet, so this conversation stays busy until it does. Restart Murage if it stays stuck.` });
            return;
          }
          if (closeFinalized) return;
          closeFinalized = true;
          retiring.delete(session);
          onChildClose(code);
        };
        void session.finishClose();
      });

      const stop = () => {
        launchTurn.stopRequested = true;
        retry.cancelled = true;
        retryAbort.abort();
        flushQueuedSteers(session, threadId, false);
        stopSession(session);
      };
      // The pool let this thread's engine go while it was idle: this send starts a fresh one,
      // so say why the wait is longer (a prewarm or a retry's relaunch announces nothing).
      const coldWake = warmPool.consumeColdWake(threadId);
      if (!turn.prewarm) {
        claimActive(activeTurn(turnId, broker, stop, () => launchTurn.stopRequested === true || retry.cancelled));
        emit({ ...base(threadId, turnId), type: "turn.started" });
        if (coldWake && !relaunch) {
          console.info(`claude wake thread=${threadId} cold=true`);
          emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: `wake-${turnId}`, title: "Waking up: starting a fresh engine after a quiet spell" });
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: `wake-${turnId}`, ok: true });
        }
      }

      // The descendant baseline is NOT taken here: it is taken synchronously
      // when the CLI's `init` message is handled (see handleLine), once its MCP
      // servers are connected. No await separates this point from the first
      // write below, so a Stop that reached the turn during setup is the only
      // cancellation to recheck, and it is rechecked right before any byte is
      // written: a stopped launch writes nothing and settles as cancelled when
      // the killed child closes.
      const cancelledBeforeWrite = () => launchTurn.stopRequested === true || retry.cancelled;

      // Ask for the command descriptions before the first message, as the
      // Agent SDK does (control_request `initialize`; its answer carries
      // `commands: [{name, description, argumentHint}]`). Nothing waits on
      // it: `init` names the commands either way, and a CLI that does not
      // answer only leaves them without descriptions.
      if (session.commands && !cancelledBeforeWrite()) {
        const ask = { type: "control_request", request_id: session.commands.requestId, request: { subtype: "initialize" } };
        try {
          child.stdin.write(JSON.stringify(ask) + "\n");
          appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: ask });
        } catch { /* the prompt write below reports a dead stdin */ }
      }

      // Intent warm: the engine is up and waits for the first real send. No turn
      // exists, nothing is written, and the engine is held for one activity window.
      if (turn.prewarm) {
        session.turn = null;
        session.broker?.pause();
        if (ctl.reservation && active.get(threadId) === ctl.reservation) forgetActive(threadId);
        retryState.delete(threadId);
        // The same idle clearing a settled turn gets: its token is not kept while the engine
        // waits (the next send writes a fresh one). The config and prompt files go once the
        // CLI has started from them (its init), or after a short grace if it never says.
        try {
          session.cred?.clear();
        } catch {
          closeSession(threadId, "credential clear failed");
          return { turnId };
        }
        // The config and prompt files go once the CLI confirms it started from them. One that
        // does not within its bound is retired first; its close then removes them.
        if (session.startConfirmed) dropStartFiles();
        else {
          session.startupTimer = setTimeout(() => {
            session.startupTimer = null;
            if (session.startConfirmed || session.closing || session.turn || sessions.get(threadId) !== session) return;
            closeSession(threadId, "startup not confirmed");
          }, prewarmFileGraceMs());
          session.startupTimer.unref?.();
        }
        armIdle(threadId, true);
        console.info(`claude prewarm thread=${threadId} parked=true`);
        return { turnId };
      }
      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      if (cancelledBeforeWrite()) {
        // Stop already killed the child; its close settles the turn as cancelled.
        launchTurn.submission = Promise.resolve(false);
        return { turnId };
      }
      launchTurn.submission = writeUser(session, threadId, turnPrompt, launchTurn.boundary, turn.images);
      if (!(await launchTurn.submission)) {
        // The message never reached the CLI whole. End the session and let
        // its close decide: a transient pre-accept failure may relaunch
        // (U-17), anything else settles as stdin_write_failed. The fallback
        // only settles a child that somehow outlives closeSession's kill.
        // Only THIS launch's session: its child may already have died and a
        // retry relaunched a successor on the thread while the write settled.
        if (sessions.get(threadId) === session) closeSession(threadId, "stdin write failed");
        const fallback = setTimeout(() => {
          if (session.turn === launchTurn) settle(false, "stdin_write_failed");
        }, 10_000);
        fallback.unref?.();
      }

      return { turnId };
    };

    /** Intent warm: start this thread's engine the way its next turn would (the last real
     * turn's cwd, env, MCP config, settings and warm key) and park it idle, held for one
     * window. A no-op without remembered inputs (after a restart, say), when an engine is
     * already live, or when the thread is busy. The next real turn still runs the warm-key
     * check, so changed settings, routeAsks or MCP config recycle this process. */
    const prewarm = async (threadId: string): Promise<boolean> => {
      const mem = lastTurns.get(threadId);
      const held = sessions.get(threadId);
      if (!mem || active.has(threadId) || (held && !held.closing && held.child.exitCode === null) || !prewarming.begin(threadId)) return false;
      const turnId = newId();
      let stoppedBeforeLaunch = false;
      let wake = () => {};
      const stopped = new Promise<void>((resolve) => { wake = resolve; });
      const reservation = activeTurn(turnId, undefined, () => { stoppedBeforeLaunch = true; wake(); }, () => stoppedBeforeLaunch);
      active.set(threadId, reservation);
      try {
        await dispatchTurn({ ...mem, prewarm: true, background: false, sessionReset: false }, undefined, { turnId, reservation, stopped, isStopped: () => stoppedBeforeLaunch });
        return sessions.get(threadId)?.turn === null;
      } catch (error) {
        if (!(error instanceof StoppedBeforeLaunch)) console.info(`claude prewarm thread=${threadId} failed=${error instanceof Error ? error.message : String(error)}`);
        if (active.get(threadId) === reservation) forgetActive(threadId);
        prewarmTurns.delete(turnId);
        return false;
      } finally {
        prewarming.end(threadId);
      }
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. False when nothing is running here to steer. */
    const steer = async (threadId: string, text: string, beforeWrite?: () => void): Promise<boolean> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return false;
      // Nothing is written before the CLI's `init` has been handled (and the
      // descendant baseline taken); the steer waits for it and is dropped
      // if the turn was stopped or the process closed meanwhile.
      if (!s.initHandled) return new Promise<boolean>((resolve) => (s.queuedSteers ??= []).push({ turn: s.turn!, text, beforeWrite, resolve }));
      if (!steerFenceHolds(beforeWrite)) return false;
      return writeUser(s, threadId, text);
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = claudeEnvironment(undefined, accountEnvironment());
      const version = await new Promise<string | null>((resolve) => {
        execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      const authenticated = await claudeSignedIn(config.cli, env);
      // claudeEnvironment strips ANTHROPIC_API_KEY, so turns run on the
      // CLI's own login (Pro/Max): the cost it reports is what the call
      // WOULD bill, not a charge
      return { state: "available", version, authenticated, billing: "subscription" };
    };

    /** One-shot Claude call with the prompt on stdin, never argv. Approval
     * summaries can contain paths, commands, or secrets, so the generic
     * `claude -p "prompt"` shape is not safe for review. No tools or MCP
     * servers are mounted in this isolated process. */
    const generateReview = (prompt: string, signal?: AbortSignal, proposalModel?: string): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawnCli(
          config.cli,
          ["-p", "--model", proposalModel ?? "claude-haiku-4-5", "--output-format", "text",
            ...(proposalModel ? ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--no-session-persistence", "--settings", '{"disableAllHooks":true}'] : [])],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeEnvironment(proposalModel ?? "claude-haiku-4-5", accountEnvironment()),
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(stdout.trim());
        };
        const onAbort = () => {
          killCliTree(child);
          finish(new Error("Claude review aborted"));
        };
        const timer = setTimeout(() => {
          killCliTree(child);
          finish(new Error("Claude review timed out"));
        }, 60_000);
        timer.unref?.();
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.length > 1_000_000) {
            killCliTree(child);
            finish(new Error("Claude review output exceeded 1 MB"));
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr = (stderr + chunk).slice(-8_192);
        });
        child.on("error", (error) => finish(error));
        child.on("close", (code) => {
          if (code === 0) finish();
          else finish(new Error(stderr.trim() || `Claude review exited ${code}`));
        });
        if (signal?.aborted) onAbort();
        else {
          signal?.addEventListener("abort", onAbort, { once: true });
          child.stdin.end(prompt);
        }
      });

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
        mcpToolSurface: CLAUDE_TOOL_SURFACE,
        capabilities: {
          sessionModelSwitch: "in-session",
          agentsMcp: true,
          memoryMcp: true,
        customMcp: true,
          computerMcp: true,
          composioMcp: true,
          phoneMcp: true,
          browserMcp: true,
          images: true,
          // The prompt is a stream-json user message whose `content` may be an
          // array of Anthropic content blocks; claude 2.1.276 reads
          // {type:"image",source:{type:"base64",media_type,data}} off it.
          imagesInline: true,
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          localComputerMcp: config.permissionMode !== "bypassPermissions",
          textOnlyTurn: true,
        },
        // PIP reflection: one tool-free structured call in a temp root with a reduced env.
        textOnlyExecutable: () => config.cli,
        prepareTextOnlyTurn,
        textOnlyTurn: turn => prepareTextOnlyTurn(turn.model, turn.providerRoute).turn(turn),
        sendTurn,
        prewarm,
        steer,
        interruptTurn: async (threadId) => {
          active.get(threadId)?.stop();
          // A replaced predecessor still shutting down is this thread's too.
          if ([...retiring.values()].includes(threadId)) await requireRetiredStopped(threadId);
        },
        resetSession: async (threadId) => {
          // interruptTurn alone ignores retained idle sessions. Cancel any
          // active retry as well, then await this thread's existing close path.
          const session = sessions.get(threadId);
          active.get(threadId)?.stop();
          if (!session) return;
          // The child already closed (it exited, or an earlier close is still
          // confirming its tree stopped before the session leaves the map):
          // its "close" has fired and never fires again, so waiting for it
          // only timed out 10 s later and failed the next send. Confirm the
          // tree instead, and finish the close so the thread is free.
          if (session.finishClose) {
            closeSession(threadId, "memory context reset");
            if (!(await awaitCliTreeStopped(session.child))) throw new Error("CLAUDE_SESSION_RESET_TIMEOUT");
            await session.finishClose();
            await requireRetiredStopped(threadId);
            return;
          }
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              session.child.off("close", closed);
              reject(new Error("CLAUDE_SESSION_RESET_TIMEOUT"));
            }, 10_000);
            const closed = () => {
              void awaitCliTreeStopped(session.child).then((stopped) => {
                clearTimeout(timeout);
                if (stopped) resolve();
                else reject(new Error("CLAUDE_SESSION_RESET_TIMEOUT"));
              });
            };
            session.child.once("close", closed);
            closeSession(threadId, "memory context reset");
          });
          await requireRetiredStopped(threadId);
        },
        respondToRequest: async (threadId, requestId, decision) => {
          // fail-closed by construction: no broker, or an ask that already
          // timed out / settled, is `unavailable` — the caller denies
          const broker = sessions.get(threadId)?.broker ?? active.get(threadId)?.broker;
          if (!broker) return "unavailable";
          const behavior = decision.behavior === "answer" ? "answer" : decision.behavior;
          if (!broker.answer(requestId, behavior, decision.message, decision.answers)) return "unavailable";
          return behavior === "allow" ? "allowed-once" : behavior === "answer" ? "answered" : "rejected";
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
          for (const threadId of [...sessions.keys()]) closeSession(threadId, "stopAll");
          await requireRetiredStopped();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt) => generateReview(prompt),
      reviewPermission: generateReview,
      proposeProject: (prompt, signal, model) => generateReview(prompt, signal, model),
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        for (const threadId of [...sessions.keys()]) closeSession(threadId, "dispose");
        listeners.clear();
        await requireRetiredStopped();
      },
    };
  },
};
