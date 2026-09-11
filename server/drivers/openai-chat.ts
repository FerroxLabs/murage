import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { validateProviderTurnRoute, type ProviderTurnRoute } from "../provider-routing.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface Usage {
  input: number;
  output: number;
}

interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  /** The provider's finish_reason, when a choice carried one. */
  finishReason: string | null;
}

interface CompletionJson {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: unknown;
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string): unknown;
  incoming(completion: Completion): unknown;
}

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string;
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
}

/** Why a streamed reply is not a successful completion. */
type FailedStreamStop = "incomplete" | "provider_error" | "empty_response";

/** A streamed reply that missed the terminal contract, reported an in-band
 * provider error, or produced nothing. It carries whatever output did arrive,
 * so the turn keeps it marked failed instead of dropping it or calling it
 * complete (A3). */
class StreamOutcomeError extends Error {
  readonly partial: Completion;
  readonly stopReason: FailedStreamStop;

  constructor(message: string, partial: Completion, stopReason: FailedStreamStop, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StreamOutcomeError";
    this.partial = partial;
    this.stopReason = stopReason;
  }
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** The provider's in-band error envelope, when a body is one. OpenAI-style
 * endpoints send `{"error": {...}}` with HTTP 200 once streaming has begun. */
const inBandErrorDetail = (body: CompletionJson): string | null => {
  const { error } = body;
  if (error === undefined || error === null || error === false) return null;
  if (typeof error === "string") return error.trim() || "unspecified error";
  if (typeof error === "object") {
    const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
    const parts = [
      typeof message === "string" ? message.trim() : "",
      typeof code === "string" || typeof code === "number" ? `code ${code}` : "",
      typeof type === "string" ? type.trim() : "",
    ].filter(Boolean);
    return parts.join(", ") || "unspecified error";
  }
  return "unspecified error";
};

/** Shared runtime for the three providers that speak OpenAI chat completions. */
export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, AbortController>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    providerRoute?: ProviderTurnRoute,
  ): Promise<Completion> => {
    const label = providerRoute?.preset ?? options.httpErrorLabel;
    const secret = providerRoute?.apiKey ?? options.apiKey;
    const redact = (value: string) => (secret ? value.replaceAll(secret, "[redacted]") : value);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const response = await fetch(`${providerRoute?.baseUrl ?? options.apiUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(options.requestBody(model, messages, stream)),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const body = redact(rawBody);
      throw new Error(`${label} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    if (!stream) {
      const json = ((await response.json()) ?? {}) as CompletionJson;
      const errorDetail = inBandErrorDetail(json);
      if (errorDetail !== null) throw new Error(redact(`${label} error: ${errorDetail}`).slice(0, 300));
      const choice = json.choices?.[0];
      const message = choice?.message;
      return {
        text: typeof message?.content === "string" ? message.content : "",
        reasoning: options.reasoning && typeof message?.reasoning_content === "string"
          ? message.reasoning_content
          : "",
        usage: usageFrom(json.usage),
        finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      };
    }

    if (!response.body) {
      throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
    }
    let text = "";
    let reasoning = "";
    let usage: Usage | null = null;
    let finishReason: string | null = null;
    let sawDone = false;
    let unreadableFrames = 0;
    const partial = (): Completion => ({ text, reasoning, usage, finishReason });
    const failure = (why: string, stopReason: FailedStreamStop, cause?: unknown) =>
      new StreamOutcomeError(redact(`${label} ${why}`).slice(0, 300), partial(), stopReason, cause);

    /** Folds one SSE line. Returns true once the [DONE] marker arrives. */
    const consumeLine = (rawLine: string): boolean => {
      const line = rawLine.trim();
      // comments (": keep-alive") and event/id/retry fields carry no payload
      if (!line.startsWith("data:")) return false;
      const data = line.slice(5).trim();
      if (!data) return false;
      if (data === "[DONE]") {
        sawDone = true;
        return true;
      }
      let chunk: CompletionJson;
      try {
        chunk = JSON.parse(data) as CompletionJson;
      } catch {
        unreadableFrames++;
        return false;
      }
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
        unreadableFrames++;
        return false;
      }
      const errorDetail = inBandErrorDetail(chunk);
      if (errorDetail !== null) throw failure(`stream error: ${errorDetail}`, "provider_error");
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const reasoningDelta = options.reasoning && typeof delta?.reasoning_content === "string"
        ? delta.reasoning_content
        : "";
      const contentDelta = typeof delta?.content === "string" ? delta.content : "";
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        onDelta?.(reasoningDelta, "reasoning_text");
      }
      if (contentDelta) {
        text += contentDelta;
        onDelta?.(contentDelta, "assistant_text");
      }
      if (chunk.usage) usage = usageFrom(chunk.usage);
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        if (choice.finish_reason === "error") {
          throw failure('stream ended with finish_reason "error"', "provider_error");
        }
        // Keep reading: usage and [DONE] commonly follow the finish frame.
        finishReason = choice.finish_reason;
      }
      return false;
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      readLoop: for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (value) {
          const cause = asError(value);
          if (cause.name === "AbortError") throw cause;
          throw failure(`stream failed: ${cause.message}`, "incomplete", cause);
        }
        if (result.done) {
          // A final frame can arrive without its trailing newline. Flush the
          // decoder and fold what is left before judging the stream.
          buffer += decoder.decode();
          if (buffer) consumeLine(buffer);
          buffer = "";
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (consumeLine(line)) break readLoop;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    // A dropped frame may have carried reply text, so the output is uncertain.
    if (unreadableFrames > 0) {
      throw failure(
        `stream contained ${unreadableFrames} unreadable frame${unreadableFrames === 1 ? "" : "s"}`,
        "incomplete",
      );
    }
    // The terminal contract: [DONE], or a finish frame followed by clean EOF.
    if (!sawDone && finishReason === null) {
      throw failure("stream ended before the provider signalled completion", "incomplete");
    }
    return partial();
  };

  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => [
    ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
    ...(turn.transcript ?? []).map((message) => ({
      role: message.role,
      content: message.text,
    })),
    { role: "user", content: turn.text },
  ];

  const sendTurn = async (turn: SendTurnInput) => {
    if (turn.providerRoute) validateProviderTurnRoute(options.driverKind, turn.providerRoute);
    if (!turn.providerRoute?.apiKey && !options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const model = turn.providerRoute?.model || turn.model || options.models().default;
    const label = turn.providerRoute?.preset ?? options.httpErrorLabel;
    active.set(turn.threadId, abort);
    appendNative(turn.threadId, {
      dir: "out",
      source: options.nativeLog.source,
      msg: options.nativeLog.outgoing(turn, messages, model),
    });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let attempt = 0;
      // One-way: once text or reasoning has streamed, a replay would repeat
      // output the user already saw. Never reset across attempts.
      let sawOutput = false;
      for (;;) {
        try {
          const completion = await complete(messages, model, true, abort.signal, (delta, streamKind) => {
            sawOutput = true;
            emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind, delta });
          }, turn.providerRoute);
          const reply = completion.text.trim() ? completion.text : completion.reasoning;
          if (!reply.trim()) {
            const finish = completion.finishReason && completion.finishReason !== "stop"
              ? ` (finish_reason "${completion.finishReason}")`
              : "";
            throw new StreamOutcomeError(`${label} returned an empty reply${finish}`, completion, "empty_response");
          }
          appendNative(turn.threadId, {
            dir: "in",
            source: options.nativeLog.source,
            msg: options.nativeLog.incoming(completion),
          });
          emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: reply });
          if (completion.usage) {
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...completion.usage });
          }
          active.delete(turn.threadId);
          const completed: RuntimeEvent = {
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: true,
            stopReason: null,
            cost: null,
          };
          emit(options.includeUsageInCompleted && completion.usage
            ? { ...completed, usage: completion.usage }
            : completed);
          return;
        } catch (value) {
          const error = asError(value);
          const aborted = error.name === "AbortError";
          const outcome = error instanceof StreamOutcomeError ? error : null;
          const verdict = classifyError(error);
          if (
            options.retryScale !== undefined &&
            !aborted &&
            !sawOutput &&
            verdict.transient &&
            attempt < RETRY_MAX_ATTEMPTS - 1
          ) {
            const delayMs = computeBackoff(attempt++);
            emit({
              ...base(turn.threadId, turnId),
              type: "turn.retrying",
              attempt,
              delayMs,
              reason: verdict.reason,
            });
            const outcome = await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
            if (outcome === "elapsed" && !abort.signal.aborted) continue;
            // Stopped during the backoff: the user's Stop, not a failure —
            // the shared cancelled state every driver uses (STOP1).
            active.delete(turn.threadId);
            emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok: true, stopReason: "cancelled", cost: null });
            return;
          }
          if (outcome) {
            appendNative(turn.threadId, {
              dir: "in",
              source: options.nativeLog.source,
              msg: options.nativeLog.incoming(outcome.partial),
            });
            // Keep what the provider did send. The failed terminal below marks
            // that reply failed; it is never presented as a completed answer.
            const kept = outcome.partial.text.trim() ? outcome.partial.text : outcome.partial.reasoning;
            if (kept.trim()) {
              emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: kept });
            }
            if (outcome.partial.usage) {
              emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...outcome.partial.usage });
            }
          }
          active.delete(turn.threadId);
          if (!aborted) emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: error.message });
          // An abort is Murage stopping the turn (interruptTurn, stopAll):
          // settle as cancelled like every other driver's user Stop (STOP1).
          emit({
            ...base(turn.threadId, turnId),
            type: "turn.completed",
            ok: aborted,
            stopReason: aborted ? "cancelled" : outcome?.stopReason ?? "error",
            cost: null,
          });
          return;
        }
      }
    })();
    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    snapshot: async () => options.apiKey
      ? { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : { state: "unavailable", reason: options.unavailableReason },
    adapter: {
      provider: options.driverKind,
      capabilities: { sessionModelSwitch: "in-session" },
      sendTurn,
      interruptTurn: async (threadId) => active.get(threadId)?.abort(),
      respondToRequest: async () => "unavailable" as const,
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        for (const abort of active.values()) abort.abort();
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning } = await complete([{ role: "user", content: prompt }], model, false);
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      for (const abort of active.values()) abort.abort();
      listeners.clear();
    },
  };
}
