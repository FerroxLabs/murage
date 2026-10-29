import { NO_TOOL_SURFACE, PI_TOOL_SURFACE, renderMurageTurn, type McpToolSurface } from "../murage-tool-surface.ts";
import { KEY_REJECTED_REASON, keyRejected, noteKeyAccepted, noteKeyRejected, rejectsKey } from "../key-rejections.ts";
import { httpErrorDetail, providerSentence } from "./provider-error-body.ts";
import { awaitIntake, isIntakeOpen } from "../harness/intake.ts";
import { readFluxMemoryResponse } from "../flux-memory-envelope.ts";
import { fluxMemoryAtSend, fluxMemoryContextForTurn, fluxMemorySend, isFluxUrl, type FluxMemorySend } from "../flux-memory-headers.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  SteerDelivery,
} from "../contracts.ts";
import { validateProviderTurnRoute, type ProviderTurnRoute } from "../provider-routing.ts";
import type { AgentPlanEntry } from "../../shared/agent-plan.ts";
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { classifyProviderError, isEndpointUnreachable, neverConnected, unreachableEndpointMessage } from "../../shared/provider-error.ts";
import { checkLocalServerUrl } from "../local-address-guard.ts";
import { providerDispatcher } from "../provider-dispatcher.ts";
import { httpTextOnlyTurn } from "./http-text-only.ts";
import { createTodoBlockFilter, extractTodoBlocks } from "../../shared/todo-block.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { buildMcpServers, piMountRecords } from "./mcp-mounts.ts";
import { ChatMcpError, mountSecrets, openChatMcpServers, type ChatMcpSession } from "./chat-mcp-client.ts";
import { ProviderStopUnconfirmedError, stopBudget } from "./child-teardown.ts";
import { CLI_TERM_GRACE_MS } from "../procs.ts";
import { approvalSummary } from "../../shared/approval-summary.ts";
import { boundedToolInput } from "../approval-text.ts";
import {
  announcesAction, capUtf8, chatToolCatalog, FENCE_AFTER_TOOLS, isLocalModelUrl, MAX_ANNOUNCEMENT_NUDGES, MAX_CHAT_ROUNDS,
  MAX_TURN_TOOL_CALLS, McpTurnTeardowns, NATIVE_TOOL_RESULT_MAX_BYTES, NUDGE_ANNOUNCED_ACTION, PERMISSION_DENIED,
  providerArguments, refusedToolCall, rejectsReasoningReplay, rejectsToolsParameter, SCREENSHOT_NOT_SHOWN, scrubKnown, scrubKnownLeaves,
  SecretStreamFilter, secretList,
  STEPS_ALREADY_RAN, stoppedAfter, TEXT_ONLY_NOTICE, TextOnlyModels, TOOL_CALLS_TO_HELPER, TOOL_INTERRUPTED, TOOL_RESULT_MAX_BYTES,
  type ChatToolCatalog,
} from "./openai-chat-tools.ts";

/** The tool names these engines advertise (OPENAI-TOOLS-109 s1.3): Pi's direct `${server}_${tool}` form, so persona and how-to
 *  text name each tool exactly as the `tools` field does. */
export const CHAT_TOOL_SURFACE: McpToolSurface = PI_TOOL_SURFACE;

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** null only on an assistant message that carries tool calls. */
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  /** Replayed on a tool-call message for DeepSeek-style servers, unless the server refused it once. */
  reasoning_content?: string;
  /** OpenRouter's opaque reasoning blocks, replayed in order. */
  reasoning_details?: Record<string, unknown>[];
}

interface Usage {
  charge?: number;
  input: number;
  output: number;
}

interface Completion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  /** The provider's finish_reason, when a choice carried one. */
  finishReason: string | null;
  /** Structured tool calls of this reply, validated by ChatToolCalls.finish (never parsed from text). */
  toolCalls?: ChatToolCall[];
  reasoningDetails?: Record<string, unknown>[];
}

/** Servers disagree on the reasoning field's name. llama.cpp, DeepSeek and
 * vLLM up to 0.11.0 send `reasoning_content`; vLLM 0.11.1 to 0.15.x send the
 * same text under both names; vLLM 0.16.0 and later send only `reasoning`
 * (DeltaMessage and ChatMessage in vLLM's protocol modules). */
interface ReasoningFields {
  reasoning?: unknown;
  reasoning_content?: unknown;
}

/** The reasoning text of one message or delta, under either name. `reasoning`
 * wins when both are present, so text a server sends twice is counted once. */
const reasoningOf = (part: ReasoningFields | undefined): string =>
  typeof part?.reasoning === "string" && part.reasoning !== ""
    ? part.reasoning
    : typeof part?.reasoning_content === "string"
      ? part.reasoning_content
      : "";

interface CompletionJson {
  choices?: Array<{
    message?: ReasoningFields & { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown };
    delta?: ReasoningFields & { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost_usd?: number; cost?: number };
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
   * Bounds connecting, headers and first progress; not a total deadline.
   * Absent (the shipped engines, 0.1.61): no idle cut of the runtime's own.
   * The thread's silence watch, on the owner's setting, decides when a quiet
   * turn stops, and Stop always works. */
  timeoutMs?: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  /** PIP reflection: send response_format json_schema (endpoints that accept it). */
  jsonSchemaResponse?: boolean;
  retryScale?: number;
  /** A model this runtime serves from a Local models server instead of
   *  apiUrl: that server's endpoint, key and API model id. The request body is
   *  the same either way, tools included: a local model gets the mounted tools
   *  like any other (and the announced-action nudge, nudgeOn below). */
  localEndpoint?: (model: string) => LocalChatEndpoint | null;
  /** OPENAI-TOOLS-109 s2: real tool calling (default true). False keeps today's text-only turns. */
  tools?: boolean;
  /** A catalog hint: true when the provider's model metadata says it takes no `tools` (OpenRouter supported_parameters). */
  textOnlyHint?: (model: string) => boolean;
}

export interface LocalChatEndpoint {
  baseUrl: string;
  apiKey: string;
  /** The id the server knows the model by (without the host prefix). */
  model: string;
  /** Names the server in errors, e.g. "Ollama on gpu-box". */
  label: string;
}

interface ParkedSteer {
  text: string;
  beforeWrite?: () => void;
  interjectionId?: string;
  resolve(delivery: SteerDelivery): void;
}

interface TurnState {
  threadId: string;
  turnId: string;
  abort: AbortController;
  /** The turn mounted MCP servers: its stop waits for its settle and for every child's confirmed close. */
  mounted: boolean;
  /** s5.4: the last allowed step; a steer is refused. */
  ending: boolean;
  settled: boolean;
  /** s5.3: steers waiting for the next request write. */
  steers: ParkedSteer[];
  /** The steers the current write carries, with the exact message objects appended for them. */
  staged: Array<{ steer: ParkedSteer; message: OpenAIChatMessage }>;
  /** Steers that resolved "uncertain"; a later answered request of this turn confirms them. */
  uncertain: ParkedSteer[];
  /** s6: open permission asks, registered before their request.opened. */
  pending: Map<string, (decision: Parameters<ProviderInstance["adapter"]["respondToRequest"]>[2]) => void>;
  scoped: Set<string>;
  /** Resolves when the turn settled. */
  done: Promise<void>;
}

/** Where one request goes: a provider connection route or a local server. */
type ChatEndpoint = Pick<ProviderTurnRoute, "baseUrl" | "apiKey"> & { preset: string };

/** Why a request was never sent. Names the host so the user can fix it, and
 *  nothing else: the URL's own text never reaches the message, so a key that
 *  somehow rode in the path cannot leak through the refusal. */
function addressRefusal(label: string, endpoint: string, code: "https-required" | "unresolved-address"): string {
  let host = "that address";
  try {
    host = new URL(endpoint).host;
  } catch {
    // keep the placeholder
  }
  return code === "https-required"
    ? `${label}: refusing to send the API key to ${host} over plain http. Use https, or an address on this machine or your own network: a cloud metadata address is never a model server.`
    : `${label}: ${host} no longer resolves to an address on this network, so the request was not sent.`;
}

/** Why a streamed reply is not a successful completion. `invalid_body`
 * separates "the address answered with something that is not a completion"
 * from `incomplete`, "the stream stopped early". Before, a reverse proxy's
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
 * status took one branch that pasted the provider's raw JSON body, including
 * another vendor's branding and URLs, into the chat bubble (F5). The body is
 * kept as `details` for the Technical details disclosure. */
class ProviderHttpError extends Error {
  readonly data: { http_status: number; message: string };
  readonly details: string;

  constructor(status: number, rawBody: string, label: string) {
    // rawBody is already redacted. The Technical details carry the provider's
    // own sentence (and its machine code), not the first bytes of its JSON.
    const body = httpErrorDetail(rawBody, 500);
    // A payment or access refusal says why in the provider's words; show that
    // one sentence under our line so the person knows what to do next.
    const why = status === 402 || status === 403 ? providerSentence(rawBody) : undefined;
    super(why ? `${providerHttpMessage(status)} The provider says: ${why}` : providerHttpMessage(status));
    this.name = "ProviderHttpError";
    this.data = { http_status: status, message: body };
    this.details = `${label} HTTP ${status}${body ? `: ${body}` : ""}`;
  }
}

/** Plain copy for a non-2xx status. No status numbers, no provider body: both
 * are in the technical details. */
/** The provider refused the `tools` parameter itself: this model is text-only (s2). */
class UnsupportedToolsError extends ProviderHttpError {}
/** The provider refused a replayed `reasoning_content` (s5.1). */
class UnsupportedReasoningReplayError extends ProviderHttpError {}
/** Groq `tool_use_failed`: the call the model generated was refused by the provider; nothing ran (s5.2). */
class RejectedToolCallError extends ProviderHttpError {}

/** What one round of a tool turn adds to a request (OPENAI-TOOLS-109 s5). */
interface RoundOptions {
  /** The `tools` field; absent sends none. */
  tools?: unknown[];
  /** Run after the address check and the fence, in the same synchronous block, immediately before the first hop's body is
   *  serialized (s5.3: the steer splice point). Redirect hops reuse the same body. */
  prepareWrite?: () => void;
  /** Called the instant any hop gets a response object: a server received this request. */
  onResponse?: () => void;
  /** Leave `reasoning_content` off replayed messages (the server refused it once). */
  noReasoningReplay?: boolean;
}

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
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
  return {
    text: typeof message?.content === "string" ? message.content : "",
    reasoning: reasoning ? reasoningOf(message) : "",
    usage: usageFrom(json.usage),
    finishReason,
    ...wholeToolCalls(message, finishReason),
  };
};

/** A non-streamed reply's tool calls and reasoning blocks (`content: null` is valid beside calls). Throws ChatProtocolError. */
const wholeToolCalls = (message: NonNullable<CompletionJson["choices"]>[number]["message"], finishReason: string | null) => {
  const calls = new ChatToolCalls();
  calls.add(message?.tool_calls, false);
  const details = new ChatReasoningDetails();
  details.add(message?.reasoning_details);
  return { toolCalls: calls.finish(finishReason, false), reasoningDetails: details.blocks };
};

/** Maximum diagnostic prefix retained when judging a stream's body. */
const RAW_BODY_MAX = 64_000;
export const MAX_SSE_LINE_BYTES = 1024 * 1024;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REPLY_TOO_LARGE = "The model server sent a reply too large to read, so Murage kept what arrived before it.";

/** Keep only a bounded prefix, including when text contains multibyte letters. */
export function appendBounded(body: string, chunk: string, max: number): string {
  if (body.length >= max) return body;
  const remaining = Math.max(0, max - Buffer.byteLength(body, "utf8"));
  if (!remaining) return body;
  const bytes = Buffer.from(chunk.slice(0, remaining), "utf8");
  return body + new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(0, remaining), { stream: true });
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0,
      ...(Number.isFinite(usage.cost_usd ?? usage.cost) && (usage.cost_usd ?? usage.cost)! >= 0 ? { charge: usage.cost_usd ?? usage.cost } : {}) }
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
  /** Stops the clock without ending the budget (our own wait for room on the event bus); renew() re-arms it. */
  suspend(): void;
  clear(): void;
}

function createIdleBudget(ms: number | undefined): IdleBudget {
  const controller = new AbortController();
  if (!ms || ms <= 0) {
    // No budget: nothing ever expires here, and progress has nothing to renew.
    return { signal: controller.signal, expired: false, message: "", renew: () => {}, suspend: () => {}, clear: () => {} };
  }
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
    suspend: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
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
    || reasoningOf(delta) !== ""
    || (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0)
    || (typeof choice?.finish_reason === "string" && choice.finish_reason !== "")
    || (chunk.usage !== undefined && chunk.usage !== null);
};

/** A wait that settles as soon as the request is aborted, whatever the awaited promise is doing. */
const waitUnlessAborted = (wait: Promise<void>, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    wait.then(() => { signal.removeEventListener("abort", onAbort); resolve(); }, (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
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

/** Decoding can widen bytes (an invalid byte becomes a three byte mark), so a
 * truncated body is trimmed again by its decoded size. */
function clipBytes(text: string, max: number, truncate: boolean): string {
  if (!truncate || Buffer.byteLength(text, "utf8") <= max) return text;
  return Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
}

/** Read only the permitted bytes, with the request's abort covering the body. */
async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
  max: number,
  truncate = false,
  onChunk?: () => void,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    for (;;) {
      const result = await readUnlessAborted(reader, signal);
      if (result.done) return clipBytes(body + decoder.decode(), max, truncate);
      onChunk?.();
      const remaining = max - bytes;
      if (result.value.byteLength > remaining && !truncate) {
        const error: Error & { details?: string } = new Error(REPLY_TOO_LARGE);
        error.details = `Response body exceeded ${max} bytes`;
        throw error;
      }
      const accepted = result.value.subarray(0, remaining);
      body += decoder.decode(accepted, { stream: true });
      bytes += accepted.byteLength;
      if (truncate && bytes === max) return clipBytes(body, max, truncate);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** Deadline for a non-streamed helper call when the engine sets no idle budget
 * of its own: the wait for the first byte, then the gap between chunks. */
const GENERATE_IDLE_MS = 120_000;
/** Redirects one provider request may follow, each re-checked as a new request. */
const MAX_PROVIDER_REDIRECTS = 3;

/** Shared runtime for the three providers that speak OpenAI chat completions. */
export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  /** The running turn per thread: its stop, its parked steers and its open permission asks. */
  const active = new Map<string, TurnState>();
  /** s3: every MCP child of every turn, tracked from spawn until its confirmed close. */
  const mcpTeardowns = new McpTurnTeardowns();
  /** s2: models whose provider refused `tools`, and those that refused a replayed reasoning_content. */
  const textOnlyModels = new TextOnlyModels();
  const reasoningReplayRefused = new Set<string>();

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

  /** A submission-fence refusal raised before a request write. */
  class SubmissionRefused extends Error {
    readonly refusal: unknown;
    constructor(refusal: unknown) { super("the submission was refused before it was sent"); this.refusal = refusal; }
  }

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    providerRoute?: ProviderTurnRoute,
    /** The turn's submission fence, run right before every request write
     *  (each redirect hop too) with no await in between. */
    beforeWrite?: () => void,
    /** Flux Memory for this call, decided again at every request write; a caller with no turn is off/off. */
    fluxMemory: FluxMemorySend = fluxMemorySend(),
    /** The thread this stream feeds, so the bus backpressure holds THIS thread at its own allowance. A call with no thread
     *  (a one-off generate) is the only caller that may pass null. */
    threadId: string | null = null,
    /** The turn's `notWritten`: the request the fence released never went out (the connection failed before any answer). */
    notWritten?: () => void,
    /** Shared by every attempt of one turn (ROOM-ORDER-DESIGN r4 S1): set the instant any hop of any attempt gets a response, after which
     *  no later failure may withdraw the stamp, since a server received the request and may have written it. */
    delivered: { value: boolean } = { value: false },
    round: RoundOptions = {},
  ): Promise<Completion> => {
    const local = providerRoute ? null : options.localEndpoint?.(model) ?? null;
    const endpoint: ChatEndpoint | undefined = local
      ? { baseUrl: local.baseUrl, apiKey: local.apiKey, preset: local.label }
      : providerRoute;
    if (local) model = local.model;
    const label = endpoint?.preset ?? options.httpErrorLabel;
    const idle = createIdleBudget(options.timeoutMs ?? (stream ? undefined : GENERATE_IDLE_MS));
    const requestSignal = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    // Whether this request ever heard back from the address. Set the instant
    // `fetch` resolves, since a response object proves the endpoint answered,
    // and read only by the unreachable-endpoint branch below. It has to be
    // carried out of `completeWithin` explicitly: the error alone cannot say
    // it, because a connect failure and a socket that dies mid-body raise the
    // same errno.
    const reached = { value: false };
    try {
      return await completeWithin(requestSignal, idle, reached, messages, model, stream, onDelta, endpoint, beforeWrite, fluxMemory, threadId, notWritten, delivered, round);
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
      // F3: a connect failure is the ONE error on this path that reached the
      // chat bubble unlabelled. `label` is applied at five places, every one of
      // them after a response exists, so undici's `TypeError("fetch failed")`
      // rethrown here arrived at the transcript as the literal two words
      // "fetch failed": no host, no engine, no next step. It is also the
      // commonest local-model failure there is: the box is off, or the tailnet
      // dropped. Say which address and what to check instead. The Stop path is
      // untouched: an aborted turn is never rewritten.
      //
      // F11 guard: `reached.value` is the whole distinction. The codes
      // `isEndpointUnreachable` matches (ECONNRESET, EPIPE, UND_ERR_SOCKET,
      // ETIMEDOUT) are raised both by a connection that never opened AND by
      // one that died halfway through a reply, so the error's shape cannot
      // tell them apart. Without this guard a server that streamed half an
      // answer and then dropped had that answer thrown away because the
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
    beforeWrite?: () => void,
    fluxMemory: FluxMemorySend = fluxMemorySend(),
    threadId: string | null = null,
    notWritten?: () => void,
    delivered: { value: boolean } = { value: false },
    round: RoundOptions = {},
  ): Promise<Completion> => {
    const label = providerRoute?.preset ?? options.httpErrorLabel;
    const secret = providerRoute?.apiKey ?? options.apiKey;
    const redact = (value: string) => (secret ? value.replaceAll(secret, "[redacted]") : value);
    // This request carries the API key in an Authorization header, so it is
    // held to the same address rule as everything else Murage sends to a local
    // server: no plain http to a public address, and a `local-name` is resolved
    // again right here, so a name that has started pointing at a cloud
    // metadata endpoint (DNS rebinding, a changed record) gets no key.
    // https URLs answer from the shared rule without any lookup, so every
    // hosted provider route pays nothing for this.
    const firstEndpoint = `${providerRoute?.baseUrl ?? options.apiUrl}/chat/completions`;
    // Serialized at the first write, after the address check and the fence (s5.3), so a steer spliced there rides this request.
    let requestObject: Record<string, unknown> = {};
    let requestBody = "";
    const wire = (): OpenAIChatMessage[] => round.noReasoningReplay
      ? messages.map(({ reasoning_content: _replay, ...message }) => message)
      : messages;
    // Redirects are followed by hand, and only within the origin the request
    // was configured for: every hop is held to the same address rule as the
    // first URL, and neither the body nor the key ever leaves that origin.
    let endpoint = firstEndpoint;
    let response!: Response;
    for (let redirects = 0; ; redirects++) {
      let target: URL;
      try {
        target = new URL(endpoint);
      } catch {
        throw new Error(addressRefusal(label, endpoint, "unresolved-address"));
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error(`${label} pointed Murage to an address that is not http or https, so the request stopped.`);
      }
      const reach = await checkLocalServerUrl(endpoint);
      if (!reach.ok) throw new Error(addressRefusal(label, endpoint, reach.code));
      const sameOrigin = target.origin === new URL(firstEndpoint).origin;
      if (beforeWrite) {
        try { beforeWrite(); } catch (refusal) { throw new SubmissionRefused(refusal); }
      }
      if (redirects === 0) {
        round.prepareWrite?.();
        requestObject = { ...options.requestBody(model, wire(), stream), ...(round.tools?.length ? { tools: round.tools } : {}) };
        requestBody = JSON.stringify(requestObject);
      }
      // Flux Memory, only on a Flux host (a Flux connection, or a compat URL that is Flux): decided for THIS write from the switch as it
      // stands now, with no await before the fetch, so "Use Flux memory" turned off while an earlier hop or attempt was out reaches it.
      const flux = isFluxUrl(endpoint) ? fluxMemoryAtSend(fluxMemory) : undefined;
      try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...(sameOrigin ? { authorization: `Bearer ${secret}` } : {}),
          "content-type": "application/json",
          ...(flux?.headers ?? {}),
        },
        // the envelope (lane 2.2) rides as request metadata only while capture and inject are still on for this write
        body: flux?.envelope
          ? JSON.stringify({ ...requestObject, metadata: { ...((requestObject as { metadata?: object }).metadata ?? {}), flux_memory: flux.envelope } })
          : requestBody,
        signal: requestSignal,
        redirect: "manual",
        // No transport clock of its own (server/provider-dispatcher.ts).
        dispatcher: providerDispatcher(endpoint),
      } as RequestInit);
      } catch (failure) {
        // The fence released this request and no answer came back. Only a failure that never connected proves the endpoint did not
        // hear it (the name did not resolve, the address refused, the handshake failed): then the words were not delivered
        // (turn-attribution.ts, I14). A connection that broke after it opened (a reset, a broken pipe, a socket that went quiet) may
        // have carried the request before it failed, so the stamp stands (Astra r7, order 2); a Stop or an idle expiry aborts the
        // signal and is neither. And a request that any earlier hop or attempt delivered (a 307 is a server that received it; a retry
        // follows an attempt that was answered) is possibly written whatever this hop did (r4 S1): the stamp stands.
        if (!requestSignal.aborted && !delivered.value && neverConnected(failure)) { try { notWritten?.(); } catch { /* a listener never decides the request */ } }
        throw failure;
      }
      // A response object, whatever its status: a server received this request.
      delivered.value = true;
      try { round.onResponse?.(); } catch { /* a listener never decides the request */ }
      const location = response.headers.get("location");
      if (![301, 302, 307, 308].includes(response.status) || !location) break;
      void response.body?.cancel().catch(() => {});
      if (redirects >= MAX_PROVIDER_REDIRECTS) {
        reached.value = true;
        throw new Error(
          `${label} redirected the request more than ${MAX_PROVIDER_REDIRECTS} times, so Murage stopped. Check the server address in settings.`,
        );
      }
      let next: URL;
      try {
        next = new URL(location, endpoint);
      } catch {
        throw new Error(addressRefusal(label, location, "unresolved-address"));
      }
      // This request carries the conversation: it goes only to the origin it was configured for, with that origin's key, and never on
      // to another address (a redirect into Flux would reach it without the key; one out of Flux would hand the body to a stranger).
      if (next.origin !== new URL(firstEndpoint).origin) {
        reached.value = true;
        throw new Error(
          `${label} tried to send this conversation on to a different address (${next.host}), so Murage stopped and sent nothing there. Check the server address in settings.`,
        );
      }
      endpoint = next.toString();
    }
    // Headers are back: something is listening at that address. Everything
    // after this point is a server that answered, however badly.
    reached.value = true;
    if (fluxMemory.onResponse && isFluxUrl(endpoint)) {
      const answer = readFluxMemoryResponse(response.headers);
      if (answer) { try { fluxMemory.onResponse(answer); } catch { /* recording must not fail the turn */ } }
    }
    if (!response.ok) {
      const rawBody = await readBoundedBody(response, requestSignal, RAW_BODY_MAX, true).catch(() => "");
      const body = redact(rawBody);
      // A refusal that says the key itself is bad is remembered (in memory only), so the engine shows signed out until the key works.
      if (secret && rejectsKey(response.status, body)) noteKeyRejected(providerRoute?.baseUrl ?? options.apiUrl, secret);
      if (round.tools?.length && rejectsToolsParameter(response.status, body)) throw new UnsupportedToolsError(response.status, body, label);
      if (refusedToolCall(response.status, body)) throw new RejectedToolCallError(response.status, body, label);
      if (!round.noReasoningReplay && messages.some((message) => message.reasoning_content !== undefined) && rejectsReasoningReplay(response.status, body)) {
        throw new UnsupportedReasoningReplayError(response.status, body, label);
      }
      throw new ProviderHttpError(response.status, body, label);
    }
    if (secret) noteKeyAccepted(providerRoute?.baseUrl ?? options.apiUrl, secret);

    if (!stream) {
      const json = (JSON.parse(await readBoundedBody(response, requestSignal, MAX_RESPONSE_BYTES, false, idle.renew)) ?? {}) as CompletionJson;
      const errorDetail = inBandErrorDetail(json);
      if (errorDetail !== null) throw new Error(redact(`${label} error: ${errorDetail}`).slice(0, 300));
      const choice = json.choices?.[0];
      const message = choice?.message;
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
      return {
        text: typeof message?.content === "string" ? message.content : "",
        reasoning: options.reasoning ? reasoningOf(message) : "",
        usage: usageFrom(json.usage),
        finishReason,
        ...wholeToolCalls(message, finishReason),
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
    // s5.1: structured calls accumulate by index; a tail the connection cut inside a frame is fatal to a reply carrying calls.
    const toolCalls = new ChatToolCalls();
    const reasoningDetails = new ChatReasoningDetails();
    let sawToolDelta = false;
    let cutTail = false;
    const partial = (): Completion => ({ text, reasoning, usage, finishReason });
    let dataFrames = 0;
    let body = "";
    /** `plain` is the sentence the chat card shows; `why` is the engine-shaped
     * line that belongs under Technical details. */
    const failure = (plain: string, why: string, stopReason: FailedStreamStop, cause?: unknown) =>
      new StreamOutcomeError(plain, partial(), stopReason, cause, redact(`${label} ${why}`).slice(0, 300));

    /** Folds one SSE line. Returns true once the [DONE] marker arrives.
     * `atEof` marks the unterminated tail left when the socket closed: a tail
     * that will not parse is an incomplete frame (the connection ended inside
     * it), not a damaged one, so it is not counted as unreadable. Only a
     * newline-terminated frame that will not parse means the server sent
     * something bad. */
    const consumeLine = (rawLine: string, atEof = false): boolean => {
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
        if (!atEof) unreadableFrames++;
        else cutTail = true;
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
      const reasoningDelta = options.reasoning ? reasoningOf(delta) : "";
      const contentDelta = typeof delta?.content === "string" ? delta.content : "";
      if (delta?.tool_calls !== undefined && delta.tool_calls !== null) sawToolDelta = true;
      try {
        toolCalls.add(delta?.tool_calls, true);
        reasoningDetails.add(delta?.reasoning_details);
      } catch (error) {
        throw failure("The model server sent a tool call Murage could not read, so nothing ran.", `tool call refused: ${asError(error).message}`, "invalid_body", error);
      }
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
    let lineBytes = 0;
    let responseBytes = 0;
    try {
      readLoop: for (;;) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        // Backpressure: while the event bus is at its cap the next chunk is not read (the connection itself stalls); the idle
        // budget restarts when reading resumes, so waiting on our own queue never counts as the provider going quiet.
        try {
          if (!isIntakeOpen(threadId)) {
            // Our own queue, not the provider: the idle clock stands still while we wait, and Stop ends the wait at once.
            idle.suspend();
            await waitUnlessAborted(awaitIntake(threadId), requestSignal);
            idle.renew();
          }
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
          body = appendBounded(body, tail, RAW_BODY_MAX);
          buffer += tail;
          if (buffer) consumeLine(buffer, true);
          buffer = "";
          break;
        }
        responseBytes += result.value.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          throw failure(REPLY_TOO_LARGE, `response exceeded ${MAX_RESPONSE_BYTES} bytes`, "incomplete");
        }
        // Check each line before decoding or appending it. A chunk may hold
        // many short lines, so its total size is not the line size.
        let offset = 0;
        while (offset < result.value.byteLength) {
          const newline = result.value.indexOf(10, offset);
          const end = newline === -1 ? result.value.byteLength : newline;
          const nextLineBytes = lineBytes + end - offset;
          if (nextLineBytes > MAX_SSE_LINE_BYTES) {
            throw failure(REPLY_TOO_LARGE, `stream line exceeded ${MAX_SSE_LINE_BYTES} bytes`, "incomplete");
          }
          const next = newline === -1 ? end : end + 1;
          const chunk = decoder.decode(result.value.subarray(offset, next), { stream: true });
          body = appendBounded(body, chunk, RAW_BODY_MAX);
          buffer += newline === -1 ? chunk : chunk.slice(0, -1);
          lineBytes = nextLineBytes;
          offset = next;
          if (newline !== -1) {
            const line = buffer;
            buffer = "";
            lineBytes = 0;
            if (consumeLine(line)) break readLoop;
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {});
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
        let whole: Completion | null;
        try { whole = wholeCompletionFrom(body, options.reasoning); } catch (error) {
          throw failure("The model server sent a tool call Murage could not read, so nothing ran.", `tool call refused: ${asError(error).message}`, "invalid_body", error);
        }
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
    // s5.1: no call from a possibly truncated stream ever runs, and every refusal of the accumulator is fatal to the reply.
    if (sawToolDelta && cutTail) {
      throw failure("The connection to the model server dropped inside a tool call, so nothing ran.", "stream ended inside a frame of a tool-call reply", "incomplete");
    }
    let calls: ChatToolCall[];
    try { calls = toolCalls.finish(finishReason, unreadableFrames > 0); } catch (error) {
      throw failure("The model server sent a tool call Murage could not read, so nothing ran.", `tool call refused: ${asError(error).message}`, "invalid_body", error);
    }
    return { ...partial(), toolCalls: calls, reasoningDetails: reasoningDetails.blocks };
  };

  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => [
    ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
    ...(turn.transcript ?? []).map((message) => ({
      role: message.role,
      content: message.header ? `${message.header}\n\n${message.text}` : message.text,
    })),
    { role: "user", content: turn.text },
  ];

  type Decision = Parameters<ProviderInstance["adapter"]["respondToRequest"]>[2];

  /** s5.3: a steer resolves only when it is spliced (or refused, or uncertain); never lost, never duplicated. */
  const splice = (state: TurnState, messages: OpenAIChatMessage[]) => {
    state.staged = [];
    if (state.ending) return;
    for (const steer of state.steers.splice(0)) {
      try { steer.beforeWrite?.(); } catch { steer.resolve("rejected"); continue; }
      const message: OpenAIChatMessage = { role: "user", content: steer.text };
      messages.push(message);
      state.staged.push({ steer, message });
    }
  };
  /** The request that carried the staged steers got a response: they are delivered, and every earlier uncertain one rode it too. */
  const stagedAnswered = (state: TurnState) => {
    for (const { steer } of state.staged) steer.resolve("delivered");
    state.staged = [];
    for (const steer of state.uncertain) if (steer.interjectionId) emit({ ...base(state.threadId, state.turnId), type: "steer.confirmed", interjectionId: steer.interjectionId });
    state.uncertain = [];
  };
  /** The write failed after a splice: proved unsent → unstaged and parked again at the front, in order (the next splice renews
   *  each fence); possibly sent → "uncertain", kept in `messages`, confirmed only by a later answered request. */
  const stagedFailed = (state: TurnState, messages: OpenAIChatMessage[], failure: unknown) => {
    if (!state.staged.length) return;
    const staged = state.staged;
    state.staged = [];
    if (!state.abort.signal.aborted && neverConnected(failure)) {
      for (const { message } of staged) {
        const at = messages.indexOf(message);
        if (at !== -1) messages.splice(at, 1);
      }
      state.steers.unshift(...staged.map(({ steer }) => steer));
      return;
    }
    for (const { steer } of staged) {
      steer.resolve("uncertain");
      state.uncertain.push(steer);
    }
  };

  const sendTurn = async (turn: SendTurnInput) => {
    if (turn.providerRoute) validateProviderTurnRoute(options.driverKind, turn.providerRoute);
    const local = turn.providerRoute ? null : options.localEndpoint?.(turn.model || options.models().default) ?? null;
    if (!turn.providerRoute?.apiKey && !options.apiKey && !local) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");

    const model = turn.providerRoute?.model || turn.model || options.models().default;
    const endpointUrl = turn.providerRoute?.baseUrl ?? local?.baseUrl ?? options.apiUrl;
    // s2: tool-less by rule (draft-only, an engine command), remembered text-only, or a catalog that says so.
    const toolLess = options.tools === false || turn.draftOnly === true || turn.engineCommand !== undefined
      || textOnlyModels.has(endpointUrl, model) || options.textOnlyHint?.(model) === true;
    const servers = toolLess ? null : buildMcpServers(turn, { askBeforeCustom: true });
    turn = servers
      ? renderMurageTurn(turn, CHAT_TOOL_SURFACE, { agents: servers.agents ? "agents" : undefined, memory: servers["murage-memory"] ? "murage-memory" : undefined, phone: servers.phone ? "phone" : undefined })
      : renderMurageTurn(turn, NO_TOOL_SURFACE, {});

    const turnId = newId();
    const threadId = turn.threadId;
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const label = turn.providerRoute?.preset ?? local?.label ?? options.httpErrorLabel;
    // s8: the request key and every secret-named env value of every mounted server.
    const secrets = secretList([turn.providerRoute?.apiKey, local?.apiKey, options.apiKey, ...mountSecrets(servers)]);
    const scrub = <T,>(value: T): T => scrubKnown(value, secrets);
    /** s8: the model-bound copy (assistant replay): every known secret removed from each string leaf, nothing else changed. */
    const forModel = <T,>(value: T): T => scrubKnownLeaves(value, secrets, 0, true);
    let markDone!: () => void;
    const state: TurnState = {
      threadId, turnId, abort, mounted: servers !== null, ending: false, settled: false, steers: [], staged: [], uncertain: [], pending: new Map(), scoped: new Set(),
      done: new Promise<void>((resolve) => { markDone = resolve; }),
    };
    active.set(threadId, state);
    // Stop with a card open: the card is resolved as the system's deny and the tool never runs (s5.5).
    abort.signal.addEventListener("abort", () => {
      for (const [requestId, answer] of [...state.pending]) {
        state.pending.delete(requestId);
        const scoped = state.scoped.delete(requestId);
        emit({ ...base(threadId, turnId), requestId, type: "request.resolved", behavior: "deny", source: "system", ...(scoped ? { approvalScope: "local-computer" as const } : {}) });
        answer({ behavior: "deny" });
      }
    }, { once: true });
    const native = (dir: "in" | "out", msg: unknown) => appendNative(threadId, { dir, source: options.nativeLog.source, msg: scrub(msg) });
    /** s7/s8: the outgoing record per round, scrubbed on its parsed values before serialization, tool results capped after. */
    // A call's arguments are JSON text, where escaping changes a secret's bytes (`"` -> `\"`), so they are scrubbed on their
    // parsed values and serialized again; arguments that do not parse are not kept in the log at all.
    const scrubArguments = (text: string): string => {
      try { return JSON.stringify(scrub(JSON.parse(text))); } catch { return "[unreadable arguments omitted]"; }
    };
    const nativeOut = (tools: string[]) => {
      const view = messages.map((message) => message.role === "tool"
        ? { ...message, content: capUtf8(scrub(message.content ?? ""), NATIVE_TOOL_RESULT_MAX_BYTES) }
        : message.tool_calls
        ? { ...scrub(message), tool_calls: message.tool_calls.map((call) => ({ ...call, function: { ...call.function, arguments: scrubArguments(call.function.arguments) } })) }
        : scrub(message));
      const record = options.nativeLog.outgoing(turn, view, model);
      native("out", tools.length && record && typeof record === "object" && !Array.isArray(record) ? { ...record as object, tools } : record);
    };
    emit({ ...base(threadId, turnId), type: "turn.started" });
    emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

    // Flux memory: the turn's context and envelope; the headers and the envelope are decided again at every write (fluxMemoryAtSend).
    const fluxSend = fluxMemorySend(fluxMemoryContextForTurn(turn), {
      ...(turn.fluxMemory ? { envelope: turn.fluxMemory } : {}), ...(turn.onFluxMemory ? { onResponse: turn.onFluxMemory } : {}),
    });
    const notice = (message: string) => emit({ ...base(threadId, turnId), type: "runtime.error", message });

    let sessions: ChatMcpSession[] = [];
    /** s3/s5.5: the turn settles exactly once; its children are asked to stop first, and turn.completed waits for their
     *  confirmed close (no timer). A turn with no MCP child emits at once, as before. */
    const settle = (completed: RuntimeEvent) => {
      if (state.settled) return;
      state.settled = true;
      for (const steer of state.steers.splice(0)) steer.resolve("rejected");
      for (const { steer } of state.staged.splice(0)) steer.resolve("uncertain");
      for (const session of sessions) session.close();
      active.delete(threadId);
      if (!mcpTeardowns.pending(threadId, turnId)) emit(completed);
      else void mcpTeardowns.closed(threadId, turnId).then(() => emit(completed));
      markDone();
    };
    const completedEvent = (ok: boolean, stopReason: string | null, usage: Usage | null, denials: string[]): RuntimeEvent => {
      const completed: RuntimeEvent = {
        ...base(threadId, turnId),
        type: "turn.completed",
        ok,
        stopReason,
        cost: null,
        ...(ok && stopReason === null && usage?.charge !== undefined ? { charge: usage.charge } : {}),
        ...(denials.length ? { denials } : {}),
      };
      return options.includeUsageInCompleted && usage && ok && stopReason === null ? { ...completed, usage } : completed;
    };

    void (async () => {
      // One-way: once text or reasoning has streamed, a replay would repeat output the user already saw. Never reset.
      let sawOutput = false;
      // One-way too: once any attempt's request reached a server, no later attempt's connect failure withdraws the stamp (r4 S1).
      const delivered = { value: false };
      /** s5: ids of every call this turn handled. Once non-empty no round is ever replayed. */
      const seenCalls = new Set<string>();
      const denials: string[] = [];
      let total: Usage | null = null;
      let nudges = 0;
      let deniedAny = false;
      let toolProgress = false;
      const fail = (message: string, details?: string) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", message, ...(details ? { details: scrub(details) } : {}) });
        settle(completedEvent(false, "error", total, denials));
      };
      const cancelled = () => settle(completedEvent(true, "cancelled", total, denials));
      try {
        // s3: one mount per turn; every child is tracked from its spawn, before any await can lose it.
        let catalog: ChatToolCatalog = { definitions: [], routes: new Map(), dropped: [] };
        if (servers) {
          const opened = await openChatMcpServers(servers, { signal: abort.signal, onSpawn: (_server, teardown) => mcpTeardowns.track(threadId, turnId, teardown) });
          sessions = opened.sessions;
          for (const server of opened.failed) notice(`The ${server.slice(0, 64)} tools could not start, so this turn runs without them.`);
          if (abort.signal.aborted) { cancelled(); return; }
          catalog = chatToolCatalog(sessions, secrets);
          for (const { server, why } of catalog.dropped) notice(`The ${server.slice(0, 64)} tools were left out of this turn because ${why}.`);
        }
        let toolsOn = catalog.definitions.length > 0;
        let noReasoningReplay = reasoningReplayRefused.has(TextOnlyModels.key(endpointUrl, model));
        const nudgeOn = Boolean(local) || isLocalModelUrl(endpointUrl);
        const runCall = (call: ChatToolCall) => runToolCall(call, catalog, state, servers, turn, scrub);

        for (let round = 0; round < MAX_CHAT_ROUNDS; round++) {
          if (abort.signal.aborted) { cancelled(); return; }
          // s5.4: the last allowed step takes no steer.
          state.ending = round === MAX_CHAT_ROUNDS - 1;
          if (state.ending) for (const steer of state.steers.splice(0)) steer.resolve("rejected");
          let completion: Completion | undefined;
          let attempt = 0;
          let refusedCalls = 0;
          // These engines have no plan channel, so some models write their to-do list into the answer as a <todo> block
          // (issue #7). It becomes the same plan update a structured plan does and leaves the answer.
          let todo = createTodoBlockFilter();
          let filter = new SecretStreamFilter(secrets);
          // Reasoning holds back a possible secret prefix across deltas exactly as the answer does (s8), in its own filter.
          let reasoningFilter = new SecretStreamFilter(secrets);
          let streamedPlans = 0;
          let streamedText = false;
          const emitPlans = (plans: AgentPlanEntry[][]) => {
            for (const entries of plans) {
              streamedPlans++;
              emit({ ...base(threadId, turnId), type: "plan.updated", entries });
            }
          };
          const emitAnswerDelta = (delta: string) => {
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
          };
          const emitReasoningDelta = (delta: string) => {
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: scrub(delta) });
          };
          while (!completion) {
            todo = createTodoBlockFilter();
            filter = new SecretStreamFilter(secrets);
            reasoningFilter = new SecretStreamFilter(secrets);
            nativeOut(toolsOn ? catalog.definitions.map((tool) => tool.function.name) : []);
            try {
              completion = await complete(messages, model, true, abort.signal, (delta, streamKind) => {
                sawOutput = true;
                if (streamKind !== "assistant_text") {
                  emitReasoningDelta(reasoningFilter.push(delta));
                  return;
                }
                // the reasoning's held tail stays held until the round ends: reasoning may resume after answer text, and a secret split
                // around that answer text must still be caught whole (Astra code-r2)
                streamedText = true;
                const out = todo.push(filter.push(delta));
                emitPlans(out.plans);
                emitAnswerDelta(out.text);
              }, turn.providerRoute, turn.beforeSubmit, fluxSend, threadId, turn.notWritten, delivered, {
                ...(toolsOn ? { tools: catalog.definitions } : {}),
                prepareWrite: () => splice(state, messages),
                onResponse: () => stagedAnswered(state),
                noReasoningReplay,
              });
            } catch (value) {
              stagedFailed(state, messages, value);
              // s2: the provider refused `tools` itself, before anything streamed or ran: remember the model, resend once without.
              if (value instanceof UnsupportedToolsError && toolsOn && !sawOutput && !seenCalls.size) {
                textOnlyModels.add(endpointUrl, model);
                toolsOn = false;
                for (const session of sessions) session.close();
                notice(TEXT_ONLY_NOTICE);
                continue;
              }
              if (value instanceof UnsupportedReasoningReplayError && !noReasoningReplay) {
                reasoningReplayRefused.add(TextOnlyModels.key(endpointUrl, model));
                noReasoningReplay = true;
                continue;
              }
              // Groq tool_use_failed: the provider refused the call it generated, so nothing ran; resend while no answer streamed.
              if (value instanceof RejectedToolCallError && !streamedText && refusedCalls < RETRY_MAX_ATTEMPTS - 1) {
                refusedCalls++;
                native("in", { refused: "tool_use_failed", attempt: refusedCalls });
                emit({ ...base(threadId, turnId), type: "turn.retrying", attempt: refusedCalls, delayMs: 0, reason: "tool_use_failed" });
                continue;
              }
              // The submission fence refused this write: nothing was written. Before any call the harness may re-run the turn on
              // a reset session; after one it never does (s5.2, Astra r1 H1), so the turn ends with the plain line instead.
              if (value instanceof SubmissionRefused) {
                if (!seenCalls.size) settle(completedEvent(false, "submission_refused", total, denials));
                else fail(FENCE_AFTER_TOOLS);
                return;
              }
              const error = asError(value);
              const outcome = error instanceof StreamOutcomeError ? error : null;
              // A Stop now arrives wrapped so its partial text survives (F6); it is still the user's Stop, never a failure.
              const aborted = error.name === "AbortError" || outcome?.stopReason === "cancelled" || abort.signal.aborted;
              const verdict = classifyError(error);
              if (options.retryScale !== undefined && !aborted && !sawOutput && !seenCalls.size && verdict.transient && attempt < RETRY_MAX_ATTEMPTS - 1) {
                const delayMs = computeBackoff(attempt++);
                emit({ ...base(threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: verdict.reason });
                const waited = await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
                if (waited === "elapsed" && !abort.signal.aborted) continue;
                // Stopped during the backoff: the user's Stop, not a failure, the shared cancelled state (STOP1).
                cancelled();
                return;
              }
              if (outcome) {
                native("in", options.nativeLog.incoming(outcome.partial));
                // Keep what the provider did send; the failed terminal below marks that reply failed. A closed to-do block
                // already reached the plan while streaming; an unclosed one is kept as written.
                const kept = outcome.partial.text.trim() ? extractTodoBlocks(scrub(outcome.partial.text)).text : scrub(outcome.partial.reasoning);
                if (kept.trim()) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: kept });
                if (outcome.partial.usage) total = addUsage(total, outcome.partial.usage);
                if (outcome.partial.usage && total) emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...total });
              }
              const details = (error as { details?: unknown }).details;
              const providerError = classifyProviderError(error);
              if (!aborted) {
                // s10: a size refusal after tool rounds says the steps already ran.
                const message = seenCalls.size ? `${error.message} ${STEPS_ALREADY_RAN}` : error.message;
                emit({
                  ...base(threadId, turnId),
                  type: "runtime.error",
                  message: scrub(message),
                  ...(typeof details === "string" && details ? { details: scrub(details) } : {}),
                  ...(providerError ? { providerError } : {}),
                });
              }
              // An abort is Murage stopping the turn (interruptTurn, stopAll): settled as cancelled like every other driver (STOP1).
              settle(completedEvent(aborted, aborted ? "cancelled" : outcome?.stopReason ?? "error", total, denials));
              return;
            }
          }
          emitReasoningDelta(reasoningFilter.flush());
          const rest = todo.flush();
          emitPlans(rest.plans);
          emitAnswerDelta(filter.flush());
          emitAnswerDelta(rest.text);
          native("in", options.nativeLog.incoming(completion));
          if (completion.usage) {
            total = addUsage(total, completion.usage);
            emit({ ...base(threadId, turnId), type: "thread.token-usage.updated", ...total });
          }
          const calls = completion.toolCalls ?? [];
          const answerText = completion.text.trim() ? scrub(completion.text) : "";
          const answer = answerText ? extractTodoBlocks(answerText) : { text: "", plans: [] };
          if (!streamedPlans) emitPlans(answer.plans);
          // s8: the replay is a model-bound copy, scrubbed of every known secret; the calls below run from `calls`, exact.
          const reasoningReplay = completion.reasoning && !noReasoningReplay ? { reasoning_content: forModel(completion.reasoning) } : {};
          const detailsReplay = completion.reasoningDetails?.length ? { reasoning_details: forModel(completion.reasoningDetails) } : {};

          if (!calls.length) {
            const reply = completion.text.trim() ? completion.text : completion.reasoning;
            if (!reply.trim()) {
              const finish = completion.finishReason && completion.finishReason !== "stop" ? ` (finish_reason "${completion.finishReason}")` : "";
              emit({ ...base(threadId, turnId), type: "runtime.error", message: "The model returned an empty answer. Try sending the message again, or choose another model.", details: `${label} returned an empty reply${finish}` });
              settle(completedEvent(false, "empty_response", total, denials));
              return;
            }
            const shown = answer.text.trim() ? answer.text : completion.text.trim() ? "" : scrub(completion.reasoning);
            // A steer that arrived while the model wrote this answer: the answer is kept and one more round runs (s5.3).
            const steered = state.steers.length > 0 && !state.ending;
            // s5.4: announcement nudges, local endpoints only, after tool progress, never after a denial or on the last step.
            const nudge = !steered && nudgeOn && toolsOn && toolProgress && !deniedAny && !state.ending && nudges < MAX_ANNOUNCEMENT_NUDGES && announcesAction(completion.text);
            if (shown.trim()) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: shown });
            if (steered || nudge) {
              messages.push({ role: "assistant", content: forModel(completion.text || completion.reasoning), ...reasoningReplay, ...detailsReplay });
              if (nudge) { nudges++; messages.push({ role: "user", content: NUDGE_ANNOUNCED_ACTION }); }
              continue;
            }
            settle(completedEvent(true, null, total, denials));
            return;
          }

          // s5: tool calls. The whole batch is checked before any of it runs.
          if (!toolsOn) { fail("The model asked for a tool on a turn that offered none, so nothing ran.", `${label} returned ${calls.length} tool call(s) without tools`); return; }
          if (calls.some((call) => seenCalls.has(call.id))) { fail("The model repeated a tool call this turn already handled, so nothing more ran.", `${label} reused a tool call id`); return; }
          if (seenCalls.size + calls.length > MAX_TURN_TOOL_CALLS) { fail(stoppedAfter(`${MAX_TURN_TOOL_CALLS} tool calls`)); return; }
          if (answer.text.trim()) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", origin: "engine", text: answer.text });
          for (const call of calls) seenCalls.add(call.id);
          const replayCalls = calls.map((call) => ({ ...call, function: { ...call.function, arguments: providerArguments(call.function.arguments, secrets) } }));
          messages.push({ role: "assistant", content: completion.text ? forModel(completion.text) : null, tool_calls: replayCalls, ...reasoningReplay, ...detailsReplay });
          for (const call of calls) {
            if (abort.signal.aborted) {
              messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: false, result: TOOL_INTERRUPTED }) });
              continue;
            }
            const outcome = await runCall(call);
            if (outcome.denied) { deniedAny = true; denials.push(outcome.name); }
            if (outcome.ran) toolProgress = true;
            messages.push({ role: "tool", tool_call_id: call.id, content: outcome.content });
          }
          if (abort.signal.aborted) { cancelled(); return; }
        }
        fail(stoppedAfter(`${MAX_CHAT_ROUNDS} steps`));
      } catch (value) {
        // Nothing above should throw; if it does, the turn still settles once and its children are still stopped.
        if (abort.signal.aborted) cancelled();
        else fail("Murage stopped this turn after an unexpected error.", asError(value).message);
      }
    })();
    return { turnId };
  };

  /** s6: one call through the central approval handler. The driver never decides allow or deny. */
  const runToolCall = async (
    call: ChatToolCall, catalog: ChatToolCatalog, state: TurnState, servers: Record<string, unknown> | null, turn: SendTurnInput,
    scrub: <T>(value: T) => T,
  ): Promise<{ content: string; denied: boolean; ran: boolean; name: string }> => {
    const { threadId, turnId } = state;
    const route = catalog.routes.get(call.function.name);
    let args: unknown;
    try { args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {}; } catch { args = undefined; }
    // s6.1: refused without running and without a card.
    if (!route) return { content: JSON.stringify({ ok: false, result: `No tool named ${call.function.name.slice(0, 64)} is available this turn; nothing ran.` }), denied: false, ran: false, name: call.function.name };
    const name = `mcp__${route.server}__${route.tool}`;
    if (!object(args)) return { content: JSON.stringify({ ok: false, result: "The tool arguments were not a JSON object, so nothing ran. Send the arguments as one JSON object." }), denied: false, ran: false, name };
    const input = args as Record<string, unknown>;
    const requestId = newId();
    // Pi's rule (pi.ts controlsHost): the host computer mount, scoped for its own card wording.
    const scoped = route.server === "computer" && !turn.integrations?.computer && turn.integrations?.localComputer?.scope === "local-computer";
    const toolInput = boundedToolInput(scrub(input));
    // s6.3: register BEFORE emitting (the server may answer synchronously inside the emit).
    const decision = await new Promise<Decision>((resolve) => {
      state.pending.set(requestId, resolve);
      if (scoped) state.scoped.add(requestId);
      emit({
        ...base(threadId, turnId),
        requestId,
        type: "request.opened",
        requestType: "permission",
        tool: name,
        summary: approvalSummary(route.tool),
        ...(toolInput ? { toolInput } : {}),
        // the EXACT call the stop line, autoVerdict and grants read; never logged (runtime-event-out.ts loggedRuntimeEvent)
        toolCall: { name, input },
        toolIdentity: { namespace: "mcp", name: `${route.server}__${route.tool}` },
        mcpMounts: piMountRecords(turn, servers),
        toolEngine: "chat" as const,
        ...(scoped ? { approvalScope: "local-computer" as const } : {}),
      });
      // a Stop that landed before the card was registered: the abort listener already ran, so it is answered here
      if (state.abort.signal.aborted && state.pending.delete(requestId)) {
        state.scoped.delete(requestId);
        emit({ ...base(threadId, turnId), requestId, type: "request.resolved", behavior: "deny", source: "system", ...(scoped ? { approvalScope: "local-computer" as const } : {}) });
        resolve({ behavior: "deny" });
      }
    });
    if (decision.behavior !== "allow") {
      // the reason the server gave (a narrowing denial's own text, Rule 72) rides after the plain line
      const reason = decision.behavior === "deny" && decision.message?.trim() ? ` ${scrub(decision.message.trim()).slice(0, 2_000)}` : "";
      return { content: JSON.stringify({ ok: false, result: `${PERMISSION_DENIED}${reason}` }), denied: true, ran: false, name };
    }
    // s6.5: a narrowed call replaces the arguments that run, and the item shows it.
    const runArgs = decision.updatedInput ?? input;
    const preview = scrub(runArgs);
    emit({
      ...base(threadId, turnId),
      type: "item.started",
      itemType: "tool",
      origin: "engine",
      itemId: call.id,
      title: call.function.name.slice(0, 80),
      toolIdentity: { namespace: "mcp", name: `${route.server}__${route.tool}` },
      input: Buffer.byteLength(JSON.stringify(preview)) <= 16 * 1024 ? preview : boundedToolInput(preview),
    });
    let ok = false;
    let result: string;
    try {
      // s8: structured content blocks are scrubbed on their parsed values before the client serializes them
      const answer = await route.session.callTool(route.tool, runArgs, { signal: state.abort.signal, scrub });
      ok = !answer.isError;
      // s8: scrub the complete text, then cap (UTF-8 boundary).
      const text = scrub(answer.text) + (answer.droppedImages ? `${answer.text ? "\n" : ""}${SCREENSHOT_NOT_SHOWN}` : "");
      result = capUtf8(text, TOOL_RESULT_MAX_BYTES);
    } catch (error) {
      result = state.abort.signal.aborted ? TOOL_INTERRUPTED : error instanceof ChatMcpError ? error.message : "MCP request failed; inspect the configured integration";
    }
    emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok, result, ...(ok ? {} : { detail: result.slice(0, 300) }) });
    return { content: JSON.stringify({ ok, result }), denied: false, ran: true, name };
  };

  /** s3/s5.5: bounded stop. Resolves only once every MCP child of the turn is confirmed closed, else rejects. */
  const stopConfirmed = async (threadId: string | undefined, turnId: string | undefined) => {
    const budget = stopBudget(CLI_TERM_GRACE_MS);
    const result = threadId === undefined ? await mcpTeardowns.waitAll(budget) : await mcpTeardowns.wait(threadId, turnId, budget);
    if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(options.driverKind, result);
    return result;
  };
  const stopAndWait = async (all: TurnState[]) => {
    for (const state of all) state.abort.abort();
    // a tool-less turn stops as before (the abort is the whole stop); a turn with mounts is awaited until it settled
    const states = all.filter((state) => state.mounted);
    if (!states.length) return;
    // the turn's own settle requests every child's stop; its wait is bounded by the same budget the children get
    const budget = stopBudget(CLI_TERM_GRACE_MS);
    await Promise.race([Promise.all(states.map((state) => state.done)), new Promise((resolve) => setTimeout(resolve, budget.maxMs).unref?.())]);
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    tracksKeyRejection: true,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    // A runtime with no key still answers for the Local models servers it serves.
    snapshot: async () => options.apiKey && keyRejected(options.apiUrl, options.apiKey)
      ? { state: "available", authenticated: false, reason: KEY_REJECTED_REASON, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : options.apiKey || options.models().options.some((option) => options.localEndpoint?.(option.id))
      ? { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : { state: "unavailable", reason: options.unavailableReason },
    adapter: {
      provider: options.driverKind,
      mcpToolSurface: options.tools === false ? NO_TOOL_SURFACE : CHAT_TOOL_SURFACE,
      capabilities: {
        sessionModelSwitch: "in-session", textOnlyTurn: true, fluxEnvelope: true,
        // s2 (Astra r1 M): the same MCP set Pi declares (no browser: buildMcpServers does not mount it), and steering.
        ...(options.tools === false ? {} : {
          agentsMcp: true, memoryMcp: true, composioMcp: true, customMcp: true, phoneMcp: true, computerMcp: true, localComputerMcp: true,
          queueing: true,
        }),
      },
      // PIP reflection: no tools field, max_tokens, optional json-schema response, capped body.
      textOnlyTurn: async (turn) => {
        // The same route rules as an ordinary turn: the route is validated, and its model (not the turn's) is what is sent.
        if (turn.providerRoute) validateProviderTurnRoute(options.driverKind, turn.providerRoute);
        const local = turn.providerRoute ? null : options.localEndpoint?.(turn.model) ?? null;
        const target = local ?? turn.providerRoute ?? { baseUrl: options.apiUrl, apiKey: options.apiKey };
        const model = local ? local.model : (turn.providerRoute?.model || turn.model);
        return httpTextOnlyTurn({ ...turn, model }, {
          baseUrl: target.baseUrl, apiKey: target.apiKey, jsonSchemaResponse: options.jsonSchemaResponse,
          buildBody: (m, messages) => options.requestBody(m, messages, false),
        });
      },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const state = active.get(threadId);
        if (state) await stopAndWait([state]);
        return stopConfirmed(threadId, turnId);
      },
      awaitTurnTeardown: (threadId, turnId) => mcpTeardowns.wait(threadId, turnId, stopBudget(CLI_TERM_GRACE_MS)),
      awaitTurnClose: (threadId, turnId) => mcpTeardowns.closed(threadId, turnId),
      respondToRequest: async (threadId, requestId, decision) => {
        const state = active.get(threadId);
        const answer = state?.pending.get(requestId);
        if (!state || !answer) return "unavailable";
        state.pending.delete(requestId);
        const scoped = state.scoped.delete(requestId);
        answer(decision);
        emit({
          ...base(threadId, state.turnId),
          requestId,
          type: "request.resolved",
          behavior: decision.behavior,
          source: "user",
          ...(scoped ? { approvalScope: "local-computer" as const } : {}),
        });
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
      ...(options.tools === false ? {} : {
        steer: async (threadId: string, text: string, beforeWrite?: () => void, interjectionId?: string) => {
          const state = active.get(threadId);
          if (!state || state.ending || state.settled || state.abort.signal.aborted) return "rejected" as const;
          return new Promise<SteerDelivery>((resolve) => { state.steers.push({ text, beforeWrite, interjectionId, resolve }); });
        },
      }),
      hasSession: (threadId) => active.has(threadId),
      // Nothing is retained between turns (each turn sends its transcript afresh), so an idle thread has no session to end. Declaring
      // queueing (steer) made the memory reset path require this; a thread with a turn still running is refused, as before.
      resetSession: async (threadId) => {
        if (active.has(threadId)) throw new Error("MEMORY_SESSION_RESET_UNAVAILABLE: this engine must end its retained session before authorized replay");
      },
      stopAll: async () => {
        await stopAndWait([...active.values()]);
        await stopConfirmed(undefined, undefined);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false);
      // s9: a helper never mounts and never sends tools; a reply carrying calls to it is an error.
      if (toolCalls?.length) throw new ChatProtocolError(TOOL_CALLS_TO_HELPER);
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      await stopAndWait([...active.values()]);
      await stopConfirmed(undefined, undefined);
      listeners.clear();
    },
  };
}

const addUsage = (total: Usage | null, usage: Usage): Usage => ({
  input: (total?.input ?? 0) + usage.input,
  output: (total?.output ?? 0) + usage.output,
  ...(total?.charge !== undefined || usage.charge !== undefined ? { charge: (total?.charge ?? 0) + (usage.charge ?? 0) } : {}),
});
