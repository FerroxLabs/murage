// Transport only. No routing, cursor persistence, webhook deletion or retries.
export type TelegramTransportErrorCode = "invalid-config" | "invalid-request" | "auth" | "forbidden" | "conflict" | "rate-limit" | "unavailable" | "offline" | "timeout" | "cancel" | "invalid-response";
const messages: Record<TelegramTransportErrorCode, string> = {
  "invalid-config": "Telegram transport configuration is invalid.", "invalid-request": "The Telegram request is invalid.",
  auth: "Telegram rejected the bot token.", forbidden: "Telegram denied access to this chat or operation.",
  conflict: "Telegram reports a polling or webhook conflict. Review the existing receiver; no webhook was changed.",
  "rate-limit": "Telegram is limiting requests. Observe the reported retry delay.", unavailable: "Telegram is unavailable.",
  offline: "Could not connect to Telegram.", timeout: "The Telegram request timed out.", cancel: "The Telegram request was cancelled.",
  "invalid-response": "Telegram returned an invalid or oversized response.",
};
export class TelegramTransportError extends Error {
  readonly code: TelegramTransportErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly uncertain: boolean;
  constructor(code: TelegramTransportErrorCode, options: { status?: number; retryAfterSeconds?: number; uncertain?: boolean } = {}) {
    super(messages[code]); this.name = "TelegramTransportError"; this.code = code;
    this.status = options.status; this.retryAfterSeconds = options.retryAfterSeconds; this.uncertain = options.uncertain === true;
  }
}
type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const chatId = (value: unknown): value is string => typeof value === "string" && /^-?[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const MAX_BODY = 2 * 1024 * 1024;
function guarded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) { promise.catch(() => {}); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BODY || !response.body) {
    void response.body?.cancel().catch(() => {}); throw new TelegramTransportError("invalid-response");
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", done = false;
  try {
    for (;;) {
      const chunk = await guarded(reader.read(), signal);
      if (chunk.done) { done = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY) throw new TelegramTransportError("invalid-response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { if (!done) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class TelegramTransport {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  constructor(options: { token: string; fetch?: typeof fetch; timeoutMs?: number }) {
    if (typeof options.token !== "string" || !/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/.test(options.token)
      || !integer(options.timeoutMs ?? 5000, 1) || (options.timeoutMs ?? 5000) > 30_000) throw new TelegramTransportError("invalid-config");
    this.#token = options.token; this.#fetch = options.fetch ?? fetch; this.#timeoutMs = options.timeoutMs ?? 5000;
  }
  async getMe(signal?: AbortSignal): Promise<{ id: string; username?: string }> {
    const result = await this.request("getMe", {}, false, signal);
    if (!object(result) || !integer(result.id, 1) || result.is_bot !== true || (result.username !== undefined && (typeof result.username !== "string" || result.username.length > 64))) throw new TelegramTransportError("invalid-response");
    return { id: String(result.id), ...(typeof result.username === "string" ? { username: result.username } : {}) };
  }
  async getUpdates(input: { offset?: number; limit?: number; timeoutSeconds?: number; signal?: AbortSignal } = {}): Promise<Array<{ update_id: number; message?: unknown; callback_query?: unknown }>> {
    const limit = input.limit ?? 100, timeout = input.timeoutSeconds ?? 0;
    if ((input.offset !== undefined && !integer(input.offset)) || !integer(limit, 1) || limit > 100 || !integer(timeout) || timeout > 25) throw new TelegramTransportError("invalid-request");
    const result = await this.request("getUpdates", { ...(input.offset === undefined ? {} : { offset: input.offset }), limit, timeout, allowed_updates: ["message", "callback_query"] }, false, input.signal, timeout * 1000);
    if (!Array.isArray(result) || result.length > limit || result.some(update => !object(update) || !integer(update.update_id))) throw new TelegramTransportError("invalid-response");
    return result.map(update => ({ update_id: update.update_id, ...(Object.hasOwn(update, "message") ? { message: update.message } : {}), ...(Object.hasOwn(update, "callback_query") ? { callback_query: update.callback_query } : {}) }));
  }
  async sendMessage(input: { chatId: string; text: string; parseMode?: "HTML"; buttons?: Array<{ text: string; data: string }>; topicId?: number; replyToMessageId?: number; signal?: AbortSignal }): Promise<{ chatId: string; messageId: number }> {
    if (!chatId(input.chatId) || typeof input.text !== "string" || input.text.length < 1 || input.text.length > (input.parseMode === "HTML" ? 32768 : 4096)
      || (input.parseMode !== undefined && input.parseMode !== "HTML")
      || (input.buttons !== undefined && (!Array.isArray(input.buttons) || input.buttons.length > 2 || input.buttons.some(button => typeof button.text !== "string" || !button.text || button.text.length > 64 || typeof button.data !== "string" || !button.data || Buffer.byteLength(button.data) > 64)))
      || (input.topicId !== undefined && !integer(input.topicId, 1)) || (input.replyToMessageId !== undefined && !integer(input.replyToMessageId, 1))) throw new TelegramTransportError("invalid-request");
    const result = await this.request("sendMessage", { chat_id: input.chatId, text: input.text,
      ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
      ...(input.buttons ? { reply_markup: { inline_keyboard: [input.buttons.map(button => ({ text: button.text, callback_data: button.data }))] } } : {}),
      ...(input.topicId === undefined ? {} : { message_thread_id: input.topicId }),
      ...(input.replyToMessageId === undefined ? {} : { reply_parameters: { message_id: input.replyToMessageId } }),
    }, true, input.signal);
    if (!object(result) || !integer(result.message_id, 1) || !object(result.chat) || typeof result.chat.id !== "number" || !Number.isSafeInteger(result.chat.id) || String(result.chat.id) !== input.chatId) throw new TelegramTransportError("invalid-response", { uncertain: true });
    return { chatId: input.chatId, messageId: result.message_id };
  }
  async answerCallbackQuery(input: { id: string; text: string; signal?: AbortSignal }): Promise<void> {
    if (!input.id || input.id.length > 200 || !input.text || input.text.length > 200) throw new TelegramTransportError("invalid-request");
    const result = await this.request("answerCallbackQuery", { callback_query_id: input.id, text: input.text }, false, input.signal);
    if (result !== true) throw new TelegramTransportError("invalid-response");
  }
  private async request(method: "getMe" | "getUpdates" | "sendMessage" | "answerCallbackQuery", body: Json, sending: boolean, signal?: AbortSignal, pollMs = 0): Promise<unknown> {
    if (signal?.aborted) throw new TelegramTransportError("cancel");
    const controller = new AbortController(); let dispatched = false;
    const stop = () => controller.abort(new TelegramTransportError("cancel", { uncertain: sending && dispatched }));
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => controller.abort(new TelegramTransportError("timeout", { uncertain: sending && dispatched })), pollMs + this.#timeoutMs);
    try {
      dispatched = true;
      const fetching = this.#fetch(`https://api.telegram.org/bot${this.#token}/${method}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
      void fetching.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await guarded(fetching, controller.signal);
      let parsed: unknown;
      try { parsed = await boundedJson(response, controller.signal); }
      catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!response.ok) throw this.httpError(response.status, undefined, sending);
        throw error instanceof TelegramTransportError ? new TelegramTransportError(error.code, { uncertain: sending }) : new TelegramTransportError("invalid-response", { uncertain: sending });
      }
      if (!response.ok || (object(parsed) && parsed.ok === false)) {
        const status = object(parsed) && integer(parsed.error_code, 100) && parsed.error_code <= 599 ? parsed.error_code : response.status;
        const retry = object(parsed) && object(parsed.parameters) && integer(parsed.parameters.retry_after) ? parsed.parameters.retry_after : undefined;
        throw this.httpError(status, retry, sending);
      }
      if (response.redirected || !object(parsed) || parsed.ok !== true || !Object.hasOwn(parsed, "result")) throw new TelegramTransportError("invalid-response", { uncertain: sending });
      return parsed.result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TelegramTransportError) throw error;
      throw new TelegramTransportError("offline", { uncertain: sending && dispatched });
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  }
  private httpError(status: number, retryAfterSeconds: number | undefined, sending: boolean): TelegramTransportError {
    const code = status === 401 ? "auth" : status === 403 ? "forbidden" : status === 409 ? "conflict" : status === 429 ? "rate-limit" : status >= 500 ? "unavailable" : "invalid-request";
    return new TelegramTransportError(code, { status, retryAfterSeconds, uncertain: sending && status >= 500 });
  }
}
