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
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { DATA_DIR, stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { claudeAccountEnvironment,resolveClaudeConfigDir } from "../claude-accounts.ts";
import { isHarnessOwnedMcpEnvName } from "../mcp-registry.ts";
import { fluxKey } from "../flux-config.ts";
import { applyFluxSurface, isFluxModel } from "../flux-routing.ts";
import { mergeFluxCatalog } from "../flux-surface.ts";
import { brokerSocketPath, describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";

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
  if (providerRoute) applyProviderRoute(DRIVER_KIND, env, providerRoute);
  else claudeRouting(env, model);
  return env;
}

const DRIVER_KIND = "claudeAgent";

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
): { model: string | null; injected: boolean } {
  const flux = applyFluxSurface(DRIVER_KIND, env, model, fluxKey());
  if (flux.applied) return { model: flux.model, injected: true };
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
  permissionMode: "acceptEdits" | "auto" | "bypassPermissions";
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
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
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
const DUPLICATE_ASK_ID_NOTE = "Murage: duplicate ask id — skipping this request.";

/** The system-source reply for an ask that outlives the turn — used both to
 * drain in-flight `pending` asks on close() and to answer one that arrives
 * on an already-closed broker (see the `closed` branch below). */
function systemEndedReply(kind: Ask["kind"]): { behavior: AskBehavior; message: string } {
  return kind === "question"
    ? { behavior: "answer", message: "Murage: the turn is ending — wrap up." }
    : { behavior: "deny", message: "Murage: the turn ended" };
}

/** One human-readable line for an ask — what the card subtitle shows. */
function askSummary(ask: Ask): string {
  const input = ask.input ?? {};
  if (ask.questions?.length) return ask.questions[0]!.question.slice(0, 300);
  if (typeof input.question === "string") return input.question.slice(0, 300);
  if (typeof input.command === "string") return input.command.slice(0, 200);
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
      const timer = setTimeout(
        () =>
          kind === "question"
            ? finish("deny", QUESTION_NOTES.timeout(Math.max(1, Math.round(questionTimeoutMs / 60_000))), "timeout")
            : finish("deny", DENY_TIMEOUT_NOTE, "timeout"),
        kind === "question" ? questionTimeoutMs : timeoutMs,
      );
      timer.unref?.();
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
  if (mode !== undefined && mode !== "acceptEdits" && mode !== "auto" && mode !== "bypassPermissions") {
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
  return {
    ...(typeof questionTimeoutMs === "number" ? { questionTimeoutMs } : {}),
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
    signInCommand: "claude",
  },
  models: STATIC_CLAUDE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ClaudeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const accountEnvironment=()=>claudeAccountEnvironment({...process.env,...input.environment},config.configDir);
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
    const active = new Map<string, { stop: () => void; turnId: string; broker?: Awaited<ReturnType<typeof createPermissionBroker>> }>();

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
      boundary: AttemptBoundary;
      /** this turn's own user-message write; null until it is attempted */
      submission: Promise<boolean> | null;
      /** Set when Murage stopped this turn (interruptTurn, resetSession,
       * stopAll). Its process exit is then a cancellation, not a crash. */
      stopRequested?: boolean;
    }
    interface Session {
      child: ReturnType<typeof spawnCli>;
      broker?: Awaited<ReturnType<typeof createPermissionBroker>>;
      mcpConfigPath: string | null;
      systemPromptPath: string | null;
      /** the spawn contract — a different one means a fresh process */
      argsKey: string;
      /** the CLI's session id from `init`, what --resume takes later */
      sessionId: string | null;
      /** the running turn, or null between turns */
      turn: SessionTurn | null;
      idleTimer: ReturnType<typeof setTimeout> | null;
      closing: boolean;
      stderr: string;
    }
    const sessions = new Map<string, Session>();
    const configuredIdleMinimum = Number(process.env.MURAGE_CLAUDE_SESSION_IDLE_MIN_MS);
    const sessionIdleMinimum = Number.isFinite(configuredIdleMinimum) && configuredIdleMinimum > 0
      ? configuredIdleMinimum
      : 10_000;
    const SESSION_IDLE_MS = Math.max(sessionIdleMinimum, Number(process.env.MURAGE_CLAUDE_SESSION_IDLE_MS) || 10 * 60_000);

    const closeSession = (threadId: string, why: string) => {
      const s = sessions.get(threadId);
      if (!s || s.closing) return;
      s.closing = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      // Broker ownership belongs to this session. Detach and close it now,
      // before a replacement can bind the same per-thread socket; the old
      // child's later close event must never unlink a new broker.
      const broker = s.broker;
      s.broker = undefined;
      broker?.close();
      appendNative(threadId, { dir: "out", source: "claude.session", msg: { close: why } });
      // stdin EOF is the CLI's exit signal; give it a moment, then insist
      try {
        s.child.stdin.end();
      } catch {}
      const kill = setTimeout(() => {
        if (s.child.exitCode === null) killCliTree(s.child);
      }, 5_000);
      kill.unref?.();
    };
    const armIdle = (threadId: string) => {
      const s = sessions.get(threadId);
      if (!s) return;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => closeSession(threadId, "idle"), SESSION_IDLE_MS);
      s.idleTimer.unref?.();
    };
    /** Writes one user message. With a boundary, the turn's submission state
     * follows the write: in-flight once bytes are handed over, then written or
     * refused when the write reports. A refused write never delivered the
     * trailing newline, so the CLI cannot have read the message whole. */
    const writeUser = (s: Session, threadId: string, text: string, boundary?: AttemptBoundary): Promise<boolean> => {
      const promptMsg = { type: "user", message: { role: "user", content: text } };
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
            appendNative(threadId, { dir: "out", source: "claude.sdk.message", msg: promptMsg });
            resolve(true);
          });
        } catch {
          boundary?.markRefused();
          resolve(false);
        }
      });
    };

    const emit = (event: RuntimeEvent) => {
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
    const sendTurn = async (turn: SendTurnInput, relaunch?: { turnId: string }) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      if (controlsHost && config.permissionMode === "bypassPermissions") {
        throw new Error("local computer control requires the interactive approval broker");
      }
      const turnId = relaunch?.turnId ?? newId();
      const retryAbort = new AbortController();
      const retry = retryState.get(threadId) ?? { attempt: 0, cancelled: false };
      retry.cancelled = false;
      retryState.set(threadId, retry);
      // a retry relaunches the whole CLI; the backoff is scaled down in tests
      // so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CLAUDE_RETRY_SCALE ?? "1");
      const sessionId = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
      const newSessionId = sessionId ? null : newId();

      const args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose", // required by stream-json output
        // token-level streaming: content_block_delta events between the
        // whole-message frames, so the bubble grows as the model writes
        "--include-partial-messages",
        "--permission-mode", config.permissionMode === "auto" ? "acceptEdits" : config.permissionMode,
      ];
      if (config.tools !== undefined) args.push("--tools", config.tools.join(","));
      const disallowedTools = [...new Set([
        ...(config.disallowedTools ?? []),
        // These native tools address provider sessions, not Murage's roster.
        ...(turn.integrations?.agents ? ["ListAgents", "SendMessage"] : []),
      ])];
      if (disallowedTools.length) args.push("--disallowedTools", disallowedTools.join(","));
      const turnEnvironment: NodeJS.ProcessEnv = accountEnvironment();
      const turnModel = turn.providerRoute ? turn.providerRoute.model : await resolveClaudeTurnModel(turn.model, turnEnvironment);
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
        allowed.push("mcp__composio");
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
      for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
        if (name in mcpServers) continue;
        if (Object.keys(server.env).some(isHarnessOwnedMcpEnvName)) continue;
        mcpServers[name] = { ...server };
      }
      // permission broker: anything acceptEdits would silently deny becomes
      // an Allow/Deny card in chat, and the agent gets ask_user. Skipped in
      // bypassPermissions (fullAuto) — nothing would ever ask.
      let broker: Awaited<ReturnType<typeof createPermissionBroker>> | undefined;
      let socketPath: string | null = null;
      if (config.permissionMode !== "bypassPermissions") {
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

      const env = claudeEnvironment(turnModel, turnEnvironment, turn.providerRoute);
      const cwd = turn.cwd ?? homedir();
      // Everything that shapes the process, minus session/turn-specific temp
      // paths. Their contents are represented directly in the key instead.
      const privateFileFlags = new Set(["--mcp-config"]);
      const keyArgs = args.filter((a, i) => !privateFileFlags.has(a) && !privateFileFlags.has(args[i - 1] ?? ""));
      const argsKey = JSON.stringify({
        args: keyArgs,
        system: turn.system ?? null,
        mcpServers,
        cwd,
        model: injected.model ?? null,
        providerConnection: turn.providerRoute ? [turn.providerRoute.connectionId, turn.providerRoute.revision] : null,
        base: env.ANTHROPIC_BASE_URL ?? null,
      });

      // Reuse the live process when it is idle, unchanged, and is the session
      // the harness wants resumed. Anything else: close it and spawn fresh
      // (with --resume, so the conversation continues in the new process).
      const live = sessions.get(threadId);
      if (live && !live.turn && !live.closing && live.child.exitCode === null && live.argsKey === argsKey && (!sessionId || sessionId === live.sessionId)) {
        if (live.idleTimer) clearTimeout(live.idleTimer);
        const liveTurn: SessionTurn = {
          turnId,
          settled: false,
          sawStreamDelta: false,
          boundary: createAttemptBoundary(),
          submission: null,
        };
        live.turn = liveTurn;
        active.set(threadId, {
          stop: () => {
            liveTurn.stopRequested = true;
            killCliTree(live.child);
          },
          turnId,
          broker: live.broker,
        });
        emit({ ...base(threadId, turnId), type: "turn.started" });
        liveTurn.submission = writeUser(live, threadId, turn.text, liveTurn.boundary);
        const written = await liveTurn.submission;
        if (!written) {
          active.delete(threadId);
          live.turn = null;
          closeSession(threadId, "stdin write failed");
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
      if (live) closeSession(threadId, "spawn contract changed");

      // Until sessions.set() below, this turn owns every launch resource.
      // Any bind, private-config or synchronous spawn failure must release
      // them here rather than leave a live listener or credential temp file.
      const cleanupUnownedLaunch = () => {
        broker?.close();
        broker = undefined;
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
            isActive: () => Boolean(sessions.get(threadId)?.turn),
            questionTimeoutMs: config.questionTimeoutMs,
            onAsk: (ask) => {
              const eventTurnId = sessions.get(threadId)?.turn?.turnId ?? turnId;
              askTools.set(ask.id, typeof ask.tool === "string" ? ask.tool : undefined);
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
            mcpServers.muragebox = { command: process.execPath, args: [PERM_PROXY_PATH, broker.socketPath], env: { ...NODE_ENV_FLAG } };
          }
        }

        // Write once, only after the broker has selected its real endpoint.
        if (mcpConfigPath) {
          writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
        }
        if (sessionId) args.push("--resume", sessionId);
        else args.push("--session-id", newSessionId!);
      } catch (error) {
        cleanupUnownedLaunch();
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
      };
      const session: Session = {
        child,
        broker,
        mcpConfigPath,
        systemPromptPath,
        argsKey,
        sessionId: sessionId ?? newSessionId,
        turn: launchTurn,
        idleTimer: null,
        closing: false,
        stderr: "",
      };
      sessions.set(threadId, session);

      // settles the TURN, not the process: the CLI stays for the next
      // message until it has been quiet for SESSION_IDLE_MS
      const settle = (
        ok: boolean,
        stopReason: string | null,
        cost: number | null = null,
        usage?: { input: number; output: number; cachedInput?: number },
      ) => {
        const t = session.turn;
        if (!t || t.settled) return;
        t.settled = true;
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
        active.delete(threadId);
        session.turn = null;
        // A settled turn owns no retry budget. Retained CLI sessions may run
        // many later turns on this thread, and each must start fresh.
        retryState.delete(threadId);
        emit({ ...base(threadId, t.turnId), type: "turn.completed", ok, stopReason, cost, ...(usage ? { usage } : {}) });
        if (session.child.exitCode === null && !session.closing) armIdle(threadId);
      };
      const currentTurnId = () => session.turn?.turnId ?? turnId;

      const handleLine = (line: string) => {
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: "claude.sdk.message", msg: o });
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
              if (typeof o.session_id === "string") session.sessionId = o.session_id;
              emit({ ...base(threadId, currentTurnId()), type: "session.started", sessionId: o.session_id, model: o.model });
            } else if (o.subtype === "thinking_tokens") {
              emit({ ...base(threadId, currentTurnId()), type: "item.updated", itemType: "reasoning", tokens: o.estimated_tokens });
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
            if (text.trim()) {
              // fallback delta for CLIs/paths that never streamed the block
              if (!session.turn?.sawStreamDelta) {
                emit({ ...base(threadId, currentTurnId()), type: "content.delta", streamKind: "assistant_text", delta: text });
              }
              if (session.turn) session.turn.sawStreamDelta = false;
              emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "assistant_text", text });
            }
            for (const b of Array.isArray(msg.content) ? msg.content : []) {
              if (b.type === "tool_use") {
                emit({ ...base(threadId, currentTurnId()), type: "item.started", itemType: "tool", itemId: b.id, title: b.name });
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
                emit({ ...base(threadId, currentTurnId()), type: "item.completed", itemType: "tool", itemId: b.tool_use_id, ok: !b.is_error });
              }
            }
            break;
          case "result":
            // A stopped/completed background task can produce its own
            // synthetic follow-up result before the submitted user's reply.
            // It does not complete that user turn or release its broker/MCP
            // authority. The native protocol marks this result's origin;
            // do not infer ownership from text or reopen an idle turn.
            if (o.origin?.kind === "task-notification") break;
            // result.usage is this invocation's total — one process per turn,
            // so it is the turn's figure. cache reads count as input: they
            // are billed (at the cache rate) and they fill the window — but
            // they are reported separately too, so the UI can show how much
            // of the figure was context re-read rather than new text.
            // An error result for a turn Murage asked to stop (a CLI that
            // reports its own interruption before exiting) is the Stop, not
            // an engine failure: same cancelled state as the close path.
            const stoppedResult = o.is_error === true && session.turn?.stopRequested === true && !session.turn.authFailed;
            if (stoppedResult) retryState.delete(threadId);
            settle(
              stoppedResult || (o.is_error !== true && !session.turn?.authFailed),
              stoppedResult ? "cancelled" : session.turn?.authFailed ? "auth_required" : o.stop_reason ?? o.terminal_reason ?? null,
              o.total_cost_usd ?? null,
              o.usage
                ? {
                    input: (o.usage.input_tokens || 0) + (o.usage.cache_read_input_tokens || 0) + (o.usage.cache_creation_input_tokens || 0),
                    output: o.usage.output_tokens || 0,
                    ...(typeof o.usage.cache_read_input_tokens === "number"
                      ? { cachedInput: o.usage.cache_read_input_tokens }
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
          if (line.trim()) handleLine(line);
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
        if (session.turn && !session.turn.settled && session.turn.stopRequested) {
          // The process ended because Murage stopped the turn. That is the
          // user's Stop (or a reset/shutdown the caller reports itself), not
          // an engine failure: settle as cancelled like the ACP and Pi
          // drivers, with no runtime error card and no Retry. A stopped turn
          // is never replayed (U-17).
          retryState.delete(threadId);
          settle(true, "cancelled");
        } else if (session.turn && !session.turn.settled) {
          const closingTurn = session.turn;
          const message = `claude exited ${code} before result${session.stderr ? `: ${session.stderr.trim().slice(-300)}` : ""}`;
          const verdict = classifyError({ exitCode: code, stderr: message });
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
            const failedBroker = session.broker;
            session.broker = undefined;
            failedBroker?.pause();
            failedBroker?.close();
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
                active.delete(threadId);
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
              // hand the thread back before recursing — the relaunch's own
              // guard would otherwise reject it as "already running"
              active.delete(threadId);
              try {
                const cursor = session.sessionId ?? sessionId ?? undefined;
                await sendTurn({ ...turn, resumeCursor: cursor }, { turnId });
              } catch (e) {
                retryState.delete(threadId);
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: e instanceof Error ? e.message : String(e),
                });
                emit({
                  ...base(threadId, turnId),
                  type: "turn.completed",
                  ok: false,
                  stopReason: "exit_before_result",
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
            message,
          });
          settle(false, closingTurn.boundary.submission === "refused" ? "stdin_write_failed" : "exit_before_result");
        }
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.broker?.close();
        if (session.mcpConfigPath) {
          try {
            rmSync(dirname(session.mcpConfigPath), { recursive: true, force: true });
          } catch {}
        }
        removePrivateTempDir(session.systemPromptPath);
        if (sessions.get(threadId) === session) sessions.delete(threadId);
      };
      child.on("close", (code) => {
        // A user-message write still in flight when the process died has an
        // unknown outcome until its callback reports. Node destroys stdin on
        // exit, so it reports promptly; decide only after it has, so the
        // guard never guesses whether the message was delivered.
        const closingTurn = session.turn;
        if (
          closingTurn &&
          !closingTurn.settled &&
          closingTurn.boundary.submission === "in-flight" &&
          closingTurn.submission
        ) {
          void closingTurn.submission.then(() => onChildClose(code));
          return;
        }
        onChildClose(code);
      });

      const stop = () => {
        launchTurn.stopRequested = true;
        retry.cancelled = true;
        retryAbort.abort();
        killCliTree(child);
      };
      active.set(threadId, { stop, turnId, broker });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // prompt over stdin as a stream-json message — never argv (ARG_MAX).
      // stdin stays OPEN: that is what keeps the session alive for a
      // mid-turn steer or the next turn; closeSession() ends it.
      launchTurn.submission = writeUser(session, threadId, turn.text, launchTurn.boundary);
      if (!(await launchTurn.submission)) {
        // The message never reached the CLI whole. End the session and let
        // its close decide: a transient pre-accept failure may relaunch
        // (U-17), anything else settles as stdin_write_failed. The fallback
        // only settles a child that somehow outlives closeSession's kill.
        closeSession(threadId, "stdin write failed");
        const fallback = setTimeout(() => {
          if (session.turn === launchTurn) settle(false, "stdin_write_failed");
        }, 10_000);
        fallback.unref?.();
      }

      return { turnId };
    };

    /** A user message into the running turn: the CLI delivers it before its
     * next model call. False when nothing is running here to steer. */
    const steer = async (threadId: string, text: string): Promise<boolean> => {
      const s = sessions.get(threadId);
      if (!s || !s.turn || s.turn.settled || s.closing || s.child.exitCode !== null) return false;
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
    const generateReview = (prompt: string, signal?: AbortSignal): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawnCli(
          config.cli,
          ["-p", "--model", "claude-haiku-4-5", "--output-format", "text"],
          {
            stdio: ["pipe", "pipe", "pipe"],
            env: claudeEnvironment("claude-haiku-4-5", accountEnvironment()),
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
          effortLevels: ["low", "medium", "high", "xhigh", "max"],
          queueing: true,
          localComputerMcp: config.permissionMode !== "bypassPermissions",
        },
        sendTurn,
        steer,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        resetSession: async (threadId) => {
          // interruptTurn alone ignores retained idle sessions. Cancel any
          // active retry as well, then await this thread's existing close path.
          const session = sessions.get(threadId);
          active.get(threadId)?.stop();
          if (!session) return;
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              session.child.off("close", closed);
              reject(new Error("CLAUDE_SESSION_RESET_TIMEOUT"));
            }, 10_000);
            const closed = () => { clearTimeout(timeout); resolve(); };
            session.child.once("close", closed);
            closeSession(threadId, "memory context reset");
          });
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
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: (prompt) => generateReview(prompt),
      reviewPermission: generateReview,
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        for (const threadId of [...sessions.keys()]) closeSession(threadId, "dispose");
        listeners.clear();
      },
    };
  },
};
