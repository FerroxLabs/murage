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
import { classifyProviderError, isEndpointUnreachable, unreachableEndpointMessage } from "../../shared/provider-error.ts";

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
  /** Longest wait without provider progress, renewed by each progress frame.
   * Bounds connecting, headers and first progress; not a total deadline. */
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  /** A model this runtime serves from a Local models server instead of
   *  apiUrl: that server's endpoint, key and API model id. The request body is
   *  the same either way, so no tools are ever sent. */
  localEndpoint?: (model: string) => LocalChatEndpoint | null;
}

export interface LocalChatEndpoint {
  baseUrl: string;
  apiKey: string;
  /** The id the server knows the model by (without the host prefix). */
  model: string;
  /** Names the server in errors, e.g. "Ollama on gpu-box". */
  label: string;
}

/** Where one request goes: a provider connection route or a local server. */
type ChatEndpoint = Pick<ProviderTurnRoute, "baseUrl" | "apiKey"> & { preset: string };

/** Why a streamed reply is not a successful completion. `invalid_body`
 * separates "the address answered with something that is not a completion"
 * from `incomplete`, "the stream stopped early" — before, a reverse proxy's
 * HTML page and a model that simply said nothing were reported identically
 * (F8). `cancelled` is the user's Stop, which now carries its partial text
 * out of the reader instead of discarding it (F6). */
type FailedStreamStop = "incomplete" | "provider_error" | "empty_response" | "invalid_body" | "cancelled";

/** A streamed reply that missed the terminal contract, reported an in-band
 * provider error, produced nothing, or was stopped. It carries whatever output
 * did arrive, so the turn keeps it marked failed instead of dropping it or
 * calling it complete (A3).
 *
 * `message` is the plain sentence the chat card shows; `details` is the
 * engine-shaped line that belongs in its Technical details disclosure. The two
 * are separate so a user never reads transport vocabulary as the headline. */
class StreamOutcomeError extends Error {
  readonly partial: Completion;
  readonly stopReason: FailedStreamStop;
  readonly details?: string;

  constructor(message: string, partial: Completion, stopReason: FailedStreamStop, cause?: unknown, details?: string) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StreamOutcomeError";
    this.partial = partial;
    this.stopReason = stopReason;
    if (details) this.details = details;
  }
}

/** A non-2xx answer from the model server. `data.http_status` is exactly the
 * shape `classifyProviderError` reads, so the reviewed provider copy in
 * shared/provider-error.ts is reachable from this driver too; before, every
 * status took one branch that pasted the provider's raw JSON body — another
 * vendor's branding and URLs included — into the chat bubble (F5). The body is
 * kept as `details` for the Technical details disclosure. */
class ProviderHttpError extends Error {
  readonly data: { http_status: number; message: string };
  readonly details: string;

  constructor(status: number, body: string, label: string) {
    super(providerHttpMessage(status));
    this.name = "ProviderHttpError";
    this.data = { http_status: status, message: body };
    this.details = `${label} HTTP ${status}${body ? `: ${body}` : ""}`;
  }
}

/** Plain copy for a non-2xx status. No status numbers, no provider body: both
 * are in the technical details. */
const providerHttpMessage = (status: number): string => {
  if (status === 401) return "The model server did not accept this engine's key. Check the key for this engine in App Settings.";
  if (status === 402) return "The model provider needs payment or account access before it will answer.";
  if (status === 403) return "The model server refused access for this account or this model.";
  if (status === 404) return "The model server does not have the model this bot is set to. Choose another model for this bot.";
  if (status === 408 || status === 504) return "The model server took too long to answer. Try again.";
  if (status === 429) return "The model server's request limit was reached. Wait a moment, then try again.";
  if (status === 400 || status === 422) return "The model server would not accept this request.";
  if (status >= 500) return "The model server hit a problem on its side. Try again in a moment.";
  return "The model server could not answer this request.";
};

/** A body that is a whole (non-streamed) completion rather than a stream. Some
 * gateways answer a streaming request this way; reading it is the difference
 * between "the model returned nothing" and "that was not a completion" (F8). */
const wholeCompletionFrom = (body: string, reasoning: boolean | undefined): Completion | null => {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const json = parsed as CompletionJson;
  if (!Array.isArray(json.choices)) return null;
  const choice = json.choices[0];
  const message = choice?.message;
  return {
    text: typeof message?.content === "string" ? message.content : "",
    reasoning: reasoning && typeof message?.reasoning_content === "string" ? message.reasoning_content : "",
    usage: usageFrom(json.usage),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
  };
};

/** How much of a non-streamed body is held while judging it. A completion
 * envelope is small; anything larger is not one. */
const RAW_BODY_MAX = 64_000;

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

/** The renewable idle budget for one provider request (U02, upstream 1083).
 * It is armed before the request, so connecting, response headers and the wait
 * for first progress are all bounded; only provider progress renews it. Expiry
 * aborts with a TimeoutError, never an AbortError: an idle provider is a
 * failure, not the user's Stop. */
interface IdleBudget {
  readonly signal: AbortSignal;
  readonly expired: boolean;
  readonly message: string;
  renew(): void;
  clear(): void;
}

function createIdleBudget(ms: number): IdleBudget {
  const controller = new AbortController();
  const message = `timed out after ${ms}ms without provider progress`;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cleared = false;
  const arm = () => {
    if (cleared || controller.signal.aborted) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      controller.abort(new DOMException(message, "TimeoutError"));
    }, ms);
  };
  arm();
  return {
    signal: controller.signal,
    get expired() {
      return controller.signal.aborted;
    },
    message,
    renew: arm,
    clear: () => {
      cleared = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Whether a parsed stream frame proves the model is still producing. Only
 * generated text or reasoning, a finish frame or usage counts. Keepalive
 * comments, blank or role-only deltas and unreadable frames never renew the
 * idle budget, so keepalive traffic alone cannot hold a request open. */
const isProgress = (chunk: CompletionJson): boolean => {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  return (typeof delta?.content === "string" && delta.content !== "")
    || (typeof delta?.reasoning_content === "string" && delta.reasoning_content !== "")
    || (typeof choice?.finish_reason === "string" && choice.finish_reason !== "")
    || (chunk.usage !== undefined && chunk.usage !== null);
};

/** One body read that settles as soon as the request is aborted, even when a
 * transport fails to propagate the abort into its body stream. */
const readUnlessAborted = <T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<T>["read"]> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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
    const local = providerRoute ? null : options.localEndpoint?.(model) ?? null;
    const endpoint: ChatEndpoint | undefined = local
      ? { baseUrl: local.baseUrl, apiKey: local.apiKey, preset: local.label }
      : providerRoute;
    if (local) model = local.model;
    const label = endpoint?.preset ?? options.httpErrorLabel;
    const idle = createIdleBudget(options.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    // Whether this request ever heard back from the address. Set the instant
    // `fetch` resolves — a response object is proof the endpoint answered —
    // and read only by the unreachable-endpoint branch below. It has to be
    // carried out of `completeWithin` explicitly: the error alone cannot say
    // it, because a connect failure and a socket that dies mid-body raise the
    // same errno.
    const reached = { value: false };
    try {
      return await completeWithin(requestSignal, idle, reached, messages, model, stream, onDelta, endpoint);
    } catch (value) {
      // An idle expiry outside the stream reader (connect, headers, or a
      // non-streamed body) is the provider's timeout failure. The caller's own
      // Stop always wins and stays an AbortError (STOP1).
      if (idle.expired && !signal?.aborted && asError(value).name === "TimeoutError") {
        // The reader's own expiry is handled in completeWithin; this is the
        // wait for a connection, headers or a first token. The millisecond
        // figure reads like a stack trace, so it stays in the details.
        const timedOut: Error & { details?: string } = new Error(
          "The model server did not answer in time. If a large model is still loading, try again in a moment.",
          { cause: value },
        );
        timedOut.details = `${label} ${idle.message}`;
        throw timedOut;
      }
      // F3 — a connect failure is the ONE error on this path that reached the
      // chat bubble unlabelled. `label` is applied at five places, every one of
      // them after a response exists, so undici's `TypeError("fetch failed")`
      // rethrown here arrived at the transcript as the literal two words
      // "fetch failed": no host, no engine, no next step. It is also the
      // commonest local-model failure there is — the box is off, or the tailnet
      // dropped. Say which address and what to check instead. The Stop path is
      // untouched: an aborted turn is never rewritten.
      //
      // F11 guard — `reached.value` is the whole distinction. The codes
      // `isEndpointUnreachable` matches (ECONNRESET, EPIPE, UND_ERR_SOCKET,
      // ETIMEDOUT) are raised both by a connection that never opened AND by
      // one that died halfway through a reply, so the error's shape cannot
      // tell them apart. Without this guard a server that streamed half an
      // answer and then dropped had that answer thrown away — the
      // StreamOutcomeError carrying the partial was replaced by a plain Error,
      // so the turn loop found no `.partial` to keep and no `.stopReason`, and
      // the person was told the endpoint "could not be reached" while its
      // words were still on their screen. Once anything has been received the
      // endpoint was plainly reachable; the failure is a dropped stream and
      // the reader's own reporting is the honest one.
      if (!signal?.aborted && !reached.value && isEndpointUnreachable(value)) {
        throw new Error(unreachableEndpointMessage(providerRoute?.baseUrl ?? options.apiUrl), { cause: value });
      }
      throw value;
    } finally {
      idle.clear();
    }
  };

  const completeWithin = async (
    requestSignal: AbortSignal,
    idle: IdleBudget,
    /** Flipped the moment the endpoint answers, so a later failure is never
     *  mistaken for one that never connected. See `complete`. */
    reached: { value: boolean },
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    providerRoute?: ChatEndpoint,
  ): Promise<Completion> => {
    const label = providerRoute?.preset ?? options.httpErrorLabel;
    const secret = providerRoute?.apiKey ?? options.apiKey;
    const redact = (value: string) => (secret ? value.replaceAll(secret, "[redacted]") : value);
    const response = await fetch(`${providerRoute?.baseUrl ?? options.apiUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(options.requestBody(model, messages, stream)),
      signal: requestSignal,
    });
    // Headers are back: something is listening at that address. Everything
    // after this point is a server that answered, however badly.
    reached.value = true;
    if (!response.ok) {
      const rawBody = await response.text().catch(() => "");
      const body = redact(rawBody);
      throw new ProviderHttpError(response.status, body.slice(0, 200), label);
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
    let dataFrames = 0;
    let body = "";
    /** `plain` is the sentence the chat card shows; `why` is the engine-shaped
     * line that belongs under Technical details. */
    const failure = (plain: string, why: string, stopReason: FailedStreamStop, cause?: unknown) =>
      new StreamOutcomeError(plain, partial(), stopReason, cause, redact(`${label} ${why}`).slice(0, 300));

    /** Folds one SSE line. Returns true once the [DONE] marker arrives. */
    const consumeLine = (rawLine: string): boolean => {
      const line = rawLine.trim();
      // comments (": keep-alive") and event/id/retry fields carry no payload
      if (!line.startsWith("data:")) return false;
      const data = line.slice(5).trim();
      if (!data) return false;
      if (data === "[DONE]") {
        dataFrames++;
        sawDone = true;
        return true;
      }
      dataFrames++;
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
      if (errorDetail !== null) {
        throw failure("The model server reported an error part-way through the answer.", `stream error: ${errorDetail}`, "provider_error");
      }
      if (isProgress(chunk)) idle.renew();
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
          throw failure("The model server ended this answer with an error.", 'stream ended with finish_reason "error"', "provider_error");
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
          result = await readUnlessAborted(reader, requestSignal);
        } catch (value) {
          const cause = asError(value);
          // F6: a Stop used to rethrow the bare AbortError, which carries no
          // partial, so every streamed word the user had already read was
          // dropped. Carry it out the same way a dropped connection does.
          if (cause.name === "AbortError") throw failure("You stopped this answer.", "stopped by the user", "cancelled", cause);
          if (idle.expired && cause.name === "TimeoutError") {
            throw failure("The model server stopped sending this answer before it was finished.", `stream ${idle.message}`, "incomplete", cause);
          }
          // F11: `cause.message` is the transport's own word (undici says
          // "terminated"), which means nothing to a reader. It stays in the
          // technical details.
          throw failure("The connection to the model server dropped before the answer finished.", `stream failed: ${cause.message}`, "incomplete", cause);
        }
        if (result.done) {
          // A final frame can arrive without its trailing newline. Flush the
          // decoder and fold what is left before judging the stream.
          const tail = decoder.decode();
          if (body.length < RAW_BODY_MAX) body += tail;
          buffer += tail;
          if (buffer) consumeLine(buffer);
          buffer = "";
          break;
        }
        const chunk = decoder.decode(result.value, { stream: true });
        // Kept only so a body that is not a stream at all can be recognised
        // (F8). Bounded: a real stream never needs to be held whole.
        if (body.length < RAW_BODY_MAX) body += chunk;
        buffer += chunk;
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
        "Part of this answer arrived damaged, so some of it may be missing.",
        `stream contained ${unreadableFrames} unreadable frame${unreadableFrames === 1 ? "" : "s"}`,
        "incomplete",
      );
    }
    // The terminal contract: [DONE], or a finish frame followed by clean EOF.
    if (!sawDone && finishReason === null) {
      // F8: nothing in the body was a server-sent event. Either something in
      // front of the model server answered with a page of its own, or the
      // server sent one whole completion instead of a stream. Reporting both
      // as a truncated stream pointed people at the network when the model had
      // simply said nothing.
      // An empty body is a stream that carried nothing, not a body of the
      // wrong shape, and keeps the truncated-stream reading.
      if (dataFrames === 0 && body.trim()) {
        const whole = wholeCompletionFrom(body, options.reasoning);
        if (whole) return whole;
        throw failure(
          "That address answered, but not with a model reply. Check that it points at your model server.",
          "response body was not a completion",
          "invalid_body",
        );
      }
      throw failure(
        "The model server stopped before it finished this answer.",
        "stream ended before the provider signalled completion",
        "incomplete",
      );
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
    const local = turn.providerRoute ? null : options.localEndpoint?.(turn.model || options.models().default) ?? null;
    if (!turn.providerRoute?.apiKey && !options.apiKey && !local) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const model = turn.providerRoute?.model || turn.model || options.models().default;
    const label = turn.providerRoute?.preset ?? local?.label ?? options.httpErrorLabel;
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
            throw new StreamOutcomeError(
              "The model returned an empty answer. Try sending the message again, or choose another model.",
              completion,
              "empty_response",
              undefined,
              `${label} returned an empty reply${finish}`,
            );
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
          const outcome = error instanceof StreamOutcomeError ? error : null;
          // A Stop now arrives wrapped so its partial text survives (F6); it
          // is still the user's Stop, never a failure.
          const aborted = error.name === "AbortError" || outcome?.stopReason === "cancelled";
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
          const details = (error as { details?: unknown }).details;
          const providerError = classifyProviderError(error);
          if (!aborted) {
            emit({
              ...base(turn.threadId, turnId),
              type: "runtime.error",
              message: error.message,
              ...(typeof details === "string" && details ? { details } : {}),
              ...(providerError ? { providerError } : {}),
            });
          }
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
    // A runtime with no key still answers for the Local models servers it serves.
    snapshot: async () => options.apiKey || options.models().options.some((option) => options.localEndpoint?.(option.id))
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
