// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { applyProviderRoute, validateProviderTurnRoute } from "../../provider-routing.ts";
import { isQuestionTool } from "../../auto-approve.ts";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { ProviderStopUnconfirmedError, providerCloseDeadlineMs, TurnTeardowns, type TeardownWait } from "../child-teardown.ts";
import {
  createLifecycleRecorder,
  errnoCategory,
  type LifecycleFields,
  type LifecycleStopReason,
} from "../lifecycle-diagnostic.ts";

/** Lifecycle facts of a JSON-RPC error: validated numbers only, and a method
 * only when the response matched a pending request (R1-T8). */
function lifecycleRejection(error: unknown, rpcId: unknown, method?: string): LifecycleFields {
  const fields: LifecycleFields = {};
  if (typeof rpcId === "number" && Number.isSafeInteger(rpcId) && rpcId >= 0) fields.rpcId = rpcId;
  if (method !== undefined) fields.method = method;
  const { code, data } = (error && typeof error === "object" ? error : {}) as { code?: unknown; data?: unknown };
  if (typeof code === "number" && Number.isSafeInteger(code)) fields.rpcCode = code;
  const status = data && typeof data === "object" && !Array.isArray(data) ? (data as { http_status?: unknown }).http_status : undefined;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields.httpStatus = status;
  return fields;
}
import { classifyProviderError } from "../../../shared/provider-error.ts";
import { redactSecretsInText } from "../../redact.ts";

/** Some ACP providers wrap actionable billing failures in "Internal error".
 * Classify only the observed shape; never copy nested provider data or URLs
 * into the transcript, where they may contain credentials or request text. */
export function acpRpcErrorMessage(error: { message?: unknown; data?: unknown }): string {
  const info = classifyProviderError(error);
  if (info?.kind === "credits") {
    if (info.provider === "flux-router") {
      return "Flux Router is out of credits. Add credits in Flux Router, then retry—or choose another configured provider.";
    }
    return "Your model provider's credit balance is exhausted (HTTP 402). Review billing with your provider or choose another configured engine.";
  }
  return typeof error.message === "string" && error.message ? error.message : "ACP request failed";
}

const ACP_DIAGNOSTIC_METHODS = new Set([
  "initialize", "authenticate", "session/new", "session/load", "session/prompt",
  "session/set_mode", "session/set_model", "session/set_config_option",
]);

/** Preserve diagnostic facts without copying response bodies, requests or URLs. */
export function acpRpcErrorDetails(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  const { code, data, acpMethod } = error as { code?: unknown; data?: unknown; acpMethod?: unknown };
  const status = data && typeof data === "object" && !Array.isArray(data)
    ? (data as { http_status?: unknown }).http_status : undefined;
  const facts: string[] = [];
  if (typeof acpMethod === "string" && ACP_DIAGNOSTIC_METHODS.has(acpMethod)) facts.push(`ACP request: ${acpMethod}`);
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) facts.push(`Provider response: HTTP ${status}`);
  if (typeof code === "number" && Number.isSafeInteger(code)) facts.push(`Engine error code: ${code}`);
  return facts.length ? facts.join("\n") : undefined;
}

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

/** Never copy CLI stderr/error.message: a version failure can contain secrets. */
export function acpVersionFailureDetail(error: Error | null): string {
  if (!error) return "returned no version from --version";
  const { code, killed, signal } = error as Error & { code?: string | number; killed?: boolean; signal?: string };
  if (killed && signal === "SIGTERM") return "--version timed out after 8 seconds";
  if (code === "ENOENT") return "CLI not found (ENOENT)";
  if (code === "EACCES" || code === "EPERM") return `is not executable (${code}); check its file permissions`;
  if (typeof code === "number") return `--version failed (exit ${code})`;
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return `--version failed (${code})`;
  return "--version failed; check the engine installation";
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";
import { isHarnessOwnedMcpEnvName } from "../../mcp-registry.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "../bounded-lines.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** Add engine-specific repair guidance after a failed version probe. */
  versionFailure?(
    env: Record<string, string | undefined>, config: AcpConfig, detail: string,
  ): { reason: string; setupAction?: "repair" } | undefined;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput): string[];
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig): void;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
}

/** Handshake budgets, overridable per box. A cold `npx`-shaped agent, a slow
 *  disk or a first run that downloads its own runtime blows the old 20s ceiling
 *  and the turn dies before the agent ever speaks; these are generous enough to
 *  cover that and still short enough that a genuinely wedged CLI surfaces as an
 *  error instead of a hang. A non-numeric or non-positive override is ignored
 *  rather than passed through as NaN, which would disarm the timeout entirely. */
const envOr = (key: string, fallback: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const INIT_TIMEOUT = envOr("MURAGE_ACP_INIT_MS", 60_000);
const SESSION_CONFIG_TIMEOUT = envOr("MURAGE_ACP_SESSION_CONFIG_MS", 60_000); // configureSession's per-request default
const NEW_SESSION_TIMEOUT = envOr("MURAGE_ACP_SESSION_NEW_MS", 90_000);
const LOAD_SESSION_TIMEOUT = envOr("MURAGE_ACP_SESSION_LOAD_MS", 120_000); // history replay on a long thread is slow
/** After session/cancel the agent may still answer the prompt; past this the
 * turn settles as cancelled and the child is terminated. */
const ACP_CANCEL_GRACE_MS = 5_000;
/** A stop that starts with session/cancel reaches the kill only after the
 * grace period, so its close budget is measured from there. */
const acpStopBudget = (): TeardownWait => {
  const closeMs = providerCloseDeadlineMs();
  return { closeMs, maxMs: ACP_CANCEL_GRACE_MS + closeMs };
};

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        // Routing switches are a third list, stripped unconditionally: a
        // `credentialEnv` allowlist grants a driver a key, never the right to
        // be pointed at someone else's endpoint, so this must not be folded
        // into the loop above. Before transformEnv so a driver that sets its
        // own routing (kimi) still wins.
        stripRoutingEnv(env);
        support.transformEnv?.(env, config);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: (reason: LifecycleStopReason) => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>;
      }
      const active = new Map<string, Turn>();
      // Settlement removes a turn from `active` before its child has exited.
      // Ownership of that child lasts until close is observed (A2).
      const teardowns = new TurnTeardowns();

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };

      // ACP content blocks may carry a complete raster image inline. Keep the
      // bytes available to the normalizer, but never duplicate megabytes of
      // base64 into the provider-native diagnostic log.
      const nativeLogMessage = (msg: any): unknown => {
        const content = msg?.params?.update?.content;
        if (
          msg?.method !== "session/update" ||
          msg?.params?.update?.sessionUpdate !== "agent_message_chunk" ||
          content?.type !== "image" ||
          typeof content.data !== "string"
        ) return msg;
        return {
          ...msg,
          params: {
            ...msg.params,
            update: {
              ...msg.params.update,
              content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
            },
          },
        };
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput) => {
        const servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const memory = turn.integrations?.memory;
        if (memory) {
          servers.push({ name: "murage-memory", command: memory.command, args: memory.args, env: acpEnv(memory.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does.
        // Cloud boxes use the REST adapter; host and sandbox Cua connections
        // expose Cua Driver's official MCP server directly.
        const computer = turn.integrations?.computer;
        if (computer) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        // user-configured servers, after the built-ins: a residual name
        // collision keeps the built-in (reserved names are filtered at the
        // config boundary; this is defense in depth).
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (name === "murage-memory") continue;
          if (servers.some((existing) => existing.name === name)) continue;
          if (Object.keys(server.env).some(isHarnessOwnedMcpEnvName)) continue;
          servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
        }
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && config.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        if (
          support.requireAuthenticationBeforeSpawn
          && !turn.providerRoute
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, config))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        if (turn.providerRoute) validateProviderTurnRoute(support.driverKind, turn.providerRoute);
        const providerBinding = turn.providerRoute ? applyProviderRoute(support.driverKind, env, turn.providerRoute) : null;
        const resolvedModel = providerBinding?.model ?? support.resolveTurnModel?.(turn.model, env);
        if (!providerBinding) support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const mcpServers = acpMcpServers(turn);

        // R1-T8: one bounded, allowlisted lifecycle trace per child generation.
        const lifecycle = createLifecycleRecorder({ threadId, driver: DRIVER_KIND, instanceId, turnId });
        lifecycle.record("spawn_requested");
        const child = (() => {
          try {
            return spawnCli(config.cli, support.spawnArgs(config, cliTurn), {
              cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (error) {
            lifecycle.record("spawn_failed", { errno: errnoCategory(error) });
            throw error;
          }
        })();
        let spawned = false;
        child.once("spawn", () => {
          spawned = true;
          lifecycle.record("spawned", { pid: child.pid ?? null });
        });

        child.once("close", () => providerBinding?.cleanup());
        const teardown = teardowns.track(threadId, turnId, child);
        const state = { settled: false, promptSent: false, cancelRequested: false, text: "" };
        const asks = new Map<string, (behavior: string, source?: "user" | "timeout" | "system") => void>();
        let nextId = 1;
        let sessionId: string | null = null;
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          { method: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> | null }
        >();

        const send = (obj: unknown) => {
          try {
            child.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: obj });
        };
        const request = (method: string, params: unknown, timeoutMs?: number) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            rpcPending.set(id, { method, resolve, reject, timer });
            lifecycle.record("rpc_requested", { rpcId: id, method });
            send({ jsonrpc: "2.0", id, method, params });
          });

        // Requesting termination is not closure; the teardown observes close.
        const stop = (reason: LifecycleStopReason) => {
          lifecycle.record("stop_requested", {
            reason,
            pid: child.pid ?? null,
            settled: state.settled,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          teardown.markStopRequested();
          killCliTree(child, lifecycle.observeStopRoute);
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        const settle = (
          ok: boolean,
          stopReason: string | null,
          cause: LifecycleStopReason = ok ? "turn_complete" : "turn_failure",
        ) => {
          if (state.settled) return;
          state.settled = true;
          lifecycle.record("turn_settled", {
            reason: cause,
            settled: true,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          if (interruptTimer) clearTimeout(interruptTimer);
          for (const finish of [...asks.values()]) finish("cancel", "system");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop(cause); // the agent process does not exit on its own
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          const optionFor = (want: "allow" | "reject") =>
            options.find((o) => String(o.kind ?? "").startsWith(want) && typeof o.optionId === "string")?.optionId ?? null;
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const kind = String(toolCall.kind ?? "");
          // An agent that routes its question tool (e.g. AskUserQuestion)
          // through request_permission names it in the tool call. That tool
          // asks the OWNER, so fullAuto must not select "allow" for it — that
          // would answer the question with nothing — and the harness receives
          // the tool's own name so its policy recognizes it too.
          const title = String(toolCall.title ?? "");
          const questionTool = isQuestionTool(title) ? title : isQuestionTool(kind) ? kind : undefined;
          if (config.fullAuto && !questionTool) {
            const allow = optionFor("allow");
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const tool = questionTool ?? (kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool");
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish = (behavior: string, source: "user" | "timeout" | "system" = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? { outcome: { outcome: "selected", optionId } } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            approvalScope: controlsHost ? "local-computer" : undefined,
            ...(questionTool ? { questionTool: true as const } : {}),
          });
        };

        const handleNotification = (msg: any) => {
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                flushAssistantText();
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "tool_call": {
              flushAssistantText();
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: String(u.rawInput?.command ?? u.title ?? "tool").slice(0, 80),
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                });
              }
              break;
            }
          }
        };

        // Byte-bounded framing (A4): the splitter decodes UTF-8 only for
        // complete lines, so multibyte characters that straddle two reads stay
        // intact, and one frame can never hold more than ENGINE_FRAME_MAX_BYTES
        // of this shared process's memory.
        const stdoutLines = createBoundedLineSplitter({
          onLine: (line) => handleStdoutLine(line),
          onOverflow: (overflow) => {
            appendNative(threadId, { dir: "in", source: SOURCE, msg: { frameOverflow: overflow } });
            if (state.settled) return;
            emit({ ...base(threadId, turnId), type: "runtime.error", message: frameOverflowMessage(support.displayName, overflow) });
            settle(false, FRAME_TOO_LARGE);
          },
        });
        child.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));
        const handleStdoutLine = (line: string) => {
          if (!line.trim()) return;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(msg) });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (!pend && msg.error) {
              // No pending request matches: never attach a method to it.
              lifecycle.record("rpc_rejected", lifecycleRejection(msg.error, msg.id));
            }
            if (pend) {
              rpcPending.delete(msg.id);
              if (pend.timer) clearTimeout(pend.timer);
              if (msg.error) {
                lifecycle.record("rpc_rejected", lifecycleRejection(msg.error, msg.id, pend.method));
                const error = new Error(acpRpcErrorMessage(msg.error));
                Object.assign(error, { code: msg.error.code, data: msg.error.data, acpMethod: pend.method });
                pend.reject(error);
              } else {
                pend.resolve(msg.result);
              }
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        };

        let stderr = "";
        child.stderr.on("data", (c) => {
          stderr += c;
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (e) => {
          if (!spawned) lifecycle.record("spawn_failed", { errno: errnoCategory(e) });
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
          settle(false, "spawn_error");
        });
        child.on("close", (code, signal) => {
          // Observed before settle() clears pending RPC state. A close with no
          // earlier stop_requested is unsolicited; its initiator stays unknown.
          lifecycle.record("closed", {
            code,
            signal,
            pid: child.pid ?? null,
            pendingMethods: [...rpcPending.values()].map((pending) => pending.method),
            pendingCount: rpcPending.size,
            settled: state.settled,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          if (!state.settled) {
            if (state.cancelRequested) {
              settle(true, "cancelled");
              return;
            }
            const detail = redactSecretsInText(stripVTControlCharacters(stderr)).trim().slice(-300);
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${detail ? `: ${detail}` : ""}`,
            });
            settle(false, "exit_before_result");
          }
        });

        // interruptTurn cannot tell a user's Stop from a watchdog or a settings
        // change, so the requested stop is recorded as `unspecified`.
        const interrupt = () => {
          if (state.settled) return;
          state.cancelRequested = true;
          if (sessionId) {
            lifecycle.record("stop_requested", {
              reason: "unspecified",
              pid: child.pid ?? null,
              settled: false,
              cancelRequested: true,
              promptSent: state.promptSent,
            });
            send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          } else stop("unspecified");
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled", "cancel_timeout"), ACP_CANCEL_GRACE_MS);
          interruptTimer.unref?.();
        };
        active.set(threadId, { stop, interrupt, turnId, asks });
        emit({ ...base(threadId, turnId), type: "turn.started" });

        (async () => {
          try {
            const init = await request(
              "initialize",
              { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
              INIT_TIMEOUT,
            );
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!skipSubscriptionAuthForLocalInject(turn.model)) {
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  if (support.authFailure === "fail") throw new Error(support.loginNote);
                  // else: proceed on an ambient login
                }
              } else if (support.authFailure === "fail") {
                throw new Error(support.loginNote);
              }
            }

            const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            if (cursor) {
              try {
                sessionResult = await request(
                  "session/load",
                  { sessionId: cursor, cwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                // An agent is allowed to ANSWER session/load with null when the
                // session is gone. Taking the cursor on that answer pinned
                // sessionId to a dead id, skipped the session/new below, and
                // prompted a session the agent had already forgotten.
                if (sessionResult) sessionId = cursor;
              } catch {
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                const currentOf = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.id === configId)
                    ?.currentValue ?? null;
                selectedModel = currentOf(sessionResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  selectedModel = currentOf(
                    await request(
                      "session/set_config_option",
                      { sessionId, configId, value: cliTurn.model },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default (grok-4.6),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            state.promptSent = true;
            const text = support.buildPromptText
              ? support.buildPromptText(turn)
              : turn.system
                ? `${turn.system}\n\n${turn.text}`
                : turn.text;
            const result = await request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text }],
            });
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            if (reason === "end_turn") settle(true, null);
            else if (reason === "cancelled") settle(true, "cancelled");
            else {
              const errorMessage = typeof result?.error === "string" && result.error
                ? result.error
                : typeof result?.message === "string" && result.message
                  ? result.message
                  : `Model turn failed: ${reason ?? "unknown error"}`;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message: errorMessage,
              });
              settle(false, reason ?? "failed");
            }
          } catch (e) {
            if (!state.settled) {
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              const providerError = classifyProviderError(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              emit({
                ...base(threadId, turnId),
                type: "runtime.error",
                message,
                details: acpRpcErrorDetails(e),
                ...(providerError ? { providerError } : {}),
                ...(needsAuth ? { setup: true } : {}),
              });
              settle(false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();

        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const probe = await new Promise<{ error: Error | null; version: string }>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (error, stdout) =>
            resolve({ error, version: stdout.trim() }),
          );
        });
        if (probe.error || !probe.version) {
          const detail = acpVersionFailureDetail(probe.error);
          return { state: "unavailable", ...(support.versionFailure?.(env, config, detail)
            ?? { reason: `\`${config.cli}\` ${detail}` }) };
        }
        return { state: "available", version: probe.version, authenticated: await support.isAuthenticated(env, config) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
            memoryMcp: true,
        customMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: !config.fullAuto,
          },
          sendTurn,
          // Close-confirmed stop (A2): resolve only once the child that served
          // this thread has closed; reject at the bounded deadline while the
          // process stays owned. A thread with no live child is already closed.
          interruptTurn: async (threadId, turnId) => {
            active.get(threadId)?.interrupt();
            const result = await teardowns.wait(threadId, turnId, acpStopBudget());
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
            return result;
          },
          awaitTurnTeardown: (threadId, turnId) => teardowns.wait(threadId, turnId, acpStopBudget()),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            finish(decision.behavior === "allow" ? "allow" : "deny", "user");
            return decision.behavior === "allow" ? "allowed-once" : "rejected";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop("driver_dispose");
            const result = await teardowns.waitAll({ closeMs: providerCloseDeadlineMs(), maxMs: providerCloseDeadlineMs() });
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { stop } of active.values()) stop("driver_dispose");
          const result = await teardowns.waitAll({ closeMs: providerCloseDeadlineMs(), maxMs: providerCloseDeadlineMs() });
          // Same as codex: an unconfirmed close keeps listeners attached so
          // the owned child's late events are still accounted for.
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          listeners.clear();
        },
      };
    },
  };
}
