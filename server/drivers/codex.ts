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

import { stripRoutingEnv, stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { isHarnessOwnedMcpEnvName } from "../mcp-registry.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
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
import { fluxKey } from "../flux-config.ts";
import { applyFluxSurface } from "../flux-routing.ts";
import { fluxIdIsRoutable } from "../flux-surface.ts";
import { augmentedPath } from "../env-path.ts";
import { classifyError, computeBackoff, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { appendNative } from "./native.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "./bounded-lines.ts";
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

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";

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
type AskFinish = (
  behavior: "allow" | "deny" | "answer",
  message?: string,
  source?: "user" | "timeout" | "system",
  answers?: QuestionAnswer[],
) => void;

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpServer,
  preApproved = true,
): void {
  Object.assign(env, server.env);
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
  );
  // Harness-owned servers are pre-quieted; a user-configured server keeps
  // codex's on-request policy so its tool calls become approval cards.
  if (preApproved) {
    appServerArgs.push("-c", `${prefix}.default_tools_approval_mode="auto"`);
  }
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
    signInCommand: "codex login",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
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

    const sendTurn = async (turn: SendTurnInput) => {
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
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
        const providerBinding = turn.providerRoute ? applyProviderRoute(DRIVER_KIND, env, turn.providerRoute) : null;
        const appServerArgs = [
          "app-server",
          ...(providerBinding ? [] : codexLocalProviderArgs(env, turn.model)),
          ...(flux?.args ?? []),
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
        ];
        if (turn.integrations?.composio) {
          mountMcpServer(appServerArgs, env, "murage_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
        }
        if (turn.integrations?.memory) {
          mountMcpServer(appServerArgs, env, "murage-memory", turn.integrations.memory);
        }
        if (turn.integrations?.computer) {
          const proxyEnv = computerProxyEnv(turn.integrations.computer);
          mountMcpServer(appServerArgs, env, "computer", {
            command: process.execPath,
            args: [SPAWNED_PROXIES.computer],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              MURAGEBOX_BOX_ID: proxyEnv.MURAGEBOX_BOX_ID ?? "",
              MURAGEBOX_BOX_TOKEN: proxyEnv.MURAGEBOX_BOX_TOKEN ?? "",
              // who-is-driving endpoint, so a person taking the wheel in the
              // panel pauses this bot's hands mid-turn
              MURAGE_CONTROL_URL: proxyEnv.MURAGE_CONTROL_URL ?? "",
              MURAGE_CONTROL_TOKEN: proxyEnv.MURAGE_CONTROL_TOKEN ?? "",
            },
          });
        } else if (turn.integrations?.localComputer) {
          // The host daemon and isolated Local VM both arrive as a direct Cua
          // Driver stdio MCP server. Codex sees the same computer tool surface.
          mountMcpServer(appServerArgs, env, "computer", turn.integrations.localComputer);
        }
        if (turn.integrations?.browser) {
          mountMcpServer(appServerArgs, env, "browser", turn.integrations.browser);
        }
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (name === "murage-memory") continue;
          if (Object.keys(server.env).some(isHarnessOwnedMcpEnvName)) continue;
          mountMcpServer(appServerArgs, env, name, server, false);
        }
        if (turn.integrations?.phone) {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          const prefix = "mcp_servers.murage_phone";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }

        const child = spawnCli(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

      let abandoned = false;
      const state = {
        settled: false,
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running THREAD total; the harness
        // wants this turn's figure, so the last report is banked on settle
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
      };

      const asks = new Map<string, AskFinish>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
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
      const terminate = () => stopping ??= new Promise<boolean>((resolve) => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        const closed = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.off("close", closed);
          resolve(false);
        }, 5_000);
        timer.unref?.();
        child.once("close", closed);
        killCliTree(child);
      });
      const stop = () => {
        stopRequested = true;
        return terminate();
      };

      const settle = async (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "Murage: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        const complete = () => {
          if (active.get(threadId)?.stop !== stop) return;
          active.delete(threadId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        };
        if (await stop()) complete();
        else {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: "codex did not shut down after termination was requested" });
          if (child.exitCode !== null || child.signalCode !== null) complete();
          else child.once("close", complete);
        }
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), every card carries approvalScope so the harness's
      // local-computer-block backstop applies to remembered always-allows.
      const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
      const handleServerRequest = (msg: any) => {
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
        const mcpTool = isMcpElicitation
          ? String(params.message ?? "").match(/tool \"([^\"]+)\"/)?.[1]
          : undefined;
        const tool =
          isMcpElicitation
            ? (mcpTool ?? "mcp")
            : isFormElicitation
            ? "elicitation"
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isUserInput
              ? "request_user_input"
              : "shell";
        if (config.fullAuto && !isQuestion) {
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
              message: `codex asked a question Murage could not show (${normalized.error}); it was told nobody answered`,
            });
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isUserInput ? { answers: {} } : { action: "cancel" },
            });
          }
          questions = normalized.questions;
        }
        const requestId = newId();
        const summary = questions
          ? questions[0]!.question
          : isMcpElicitation && typeof params.message === "string"
            ? params.message
            : typeof params.command === "string"
              ? params.command
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        // the first question's labels keep voice and older clients working
        const choices = questions ? questions[0]!.options.map((option) => option.label) : undefined;
        const finish: AskFinish = (behavior, _message, source = "user", answers) => {
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
        // question timeout); a permission keeps its 15-minute deny.
        const timer = setTimeout(
          () => (questions ? finish("deny", undefined, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          questions ? QUESTION_TIMEOUT_MS : 15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: questions ? "question" : "permission",
          tool,
          summary,
          choices,
          ...(questions ? { questions } : {}),
          approvalScope: controlsHost ? "local-computer" : undefined,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
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
            const item = p.item ?? {};
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
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
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
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `last` is the most recent turn when the server sends it;
            // `total` is the thread so far — a fresh app-server per turn
            // makes that this turn's figure too
            const turnUsage = p.tokenUsage?.last ?? p.tokenUsage?.total;
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
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
            }
            break;
        }
      };

      // Byte-bounded framing (A4): UTF-8 is decoded per complete line, so a
      // multibyte character split across reads stays intact, and one frame
      // never holds more than ENGINE_FRAME_MAX_BYTES of the shared process.
      const stdoutLines = createBoundedLineSplitter({
        onLine: (line) => handleStdoutLine(line),
        onOverflow: (overflow) => {
          if (abandoned) return;
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg: { frameOverflow: overflow } });
          if (state.settled) return;
          emit({ ...base(threadId, turnId), type: "runtime.error", message: frameOverflowMessage("Codex", overflow) });
          void settle(false, FRAME_TOO_LARGE);
        },
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (abandoned || state.settled) return;
        stdoutLines.push(chunk);
      });
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
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (abandoned) return;
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", { clientInfo: { name: "murage", version: "1" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        let codexThreadId: string | null = null;
        let startedModel: string | null = null;
        if (cursor) {
          try {
            const resumed = await request("thread/resume", { threadId: cursor });
            codexThreadId = resumed?.thread?.id ?? cursor;
          } catch {
            /* resume unsupported or thread gone — start fresh below */
          }
        }
        if (!codexThreadId) {
          const selection = providerBinding ? { model: providerBinding.model, modelProvider: providerBinding.modelProvider } : decodeCodexSelection(turn.model);
          const started = await request("thread/start", {
            cwd: turn.cwd ?? homedir(),
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
            sandbox: config.fullAuto ? "danger-full-access" : "workspace-write",
            approvalPolicy: config.fullAuto ? "never" : "on-request",
            ephemeral: false,
          });
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
        }
        emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
        await request("turn/start", {
          threadId: codexThreadId,
          input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
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
        });
      } catch (e) {
        const failure = e instanceof Error ? e : { text: String(e) };
        const message = e instanceof Error ? e.message : String(e);
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(message);
        const verdict = classifyError(failure);
        if (!state.settled && !needsAuth && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
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
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(1, Math.round(delayMs * retryScale)));
            timer.unref?.();
          });
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            settle(false, "interrupted");
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

    void launchAttempt(0).catch(() => {});
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    const env = childEnv();
    const version = await new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    });
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return { state: "available", version, authenticated, billing: "subscription" };
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
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      interruptTurn: async (threadId) => {
        if (await active.get(threadId)?.stop() === false) throw new Error("codex shutdown is still pending; the process remains owned");
      },
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user", decision.answers);
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const stopped = await Promise.all([...active.values()].map(({ stop }) => stop()));
        if (stopped.includes(false)) throw new Error("codex shutdown is still pending; the processes remain owned");
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    dispose: async () => {
      const stopped = await Promise.all([...active.values()].map(({ stop }) => stop()));
      if (stopped.includes(false)) throw new Error("codex shutdown is still pending; listeners remain attached");
      listeners.clear();
    },
  };
},
};
