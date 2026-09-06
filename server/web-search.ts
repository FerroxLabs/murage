// REST shapes verified against Tavily search and Exa's coding-agent guide.
// Results are untrusted data; this adapter never follows their source URLs.
export type WebSearchProvider = "tavily" | "exa";
export type SearchErrorCode = "missing-config" | "auth" | "quota" | "rate-limit" | "unavailable" | "offline" | "timeout" | "cancel" | "invalid-response" | "invalid-request";
const messages: Record<SearchErrorCode, string> = {
  "missing-config": "Choose a web-search provider and configure its API key.",
  auth: "The search provider rejected the account or API key.", quota: "The search provider's account usage limit was reached.",
  "rate-limit": "The search provider is limiting requests. Try again later.", unavailable: "The search provider is unavailable.",
  offline: "Could not connect to the search provider.", timeout: "The web search timed out.", cancel: "The web search was cancelled.",
  "invalid-response": "The search provider returned an invalid or oversized response.", "invalid-request": "The web-search request is invalid.",
};
export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(code: SearchErrorCode, status?: number) {
    super(messages[code]); this.name = "SearchError"; this.code = code; this.status = status;
    this.retryable = ["rate-limit", "unavailable", "offline", "timeout"].includes(code);
  }
}
export interface WebSearchResult {
  provider: WebSearchProvider;
  results: Array<{ title: string; url: string; snippet: string }>;
  untrusted: true;
  privacyNotice: string;
  costNotice: string;
}
const MAX_BODY_BYTES = 1024 * 1024;
function aborted(signal: AbortSignal): SearchError { return signal.reason instanceof SearchError ? signal.reason : new SearchError("cancel"); }
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(aborted(signal)); return; }
    const cancel = () => reject(aborted(signal));
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
async function bodyText(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
    void response.body?.cancel().catch(() => {}); throw new SearchError("invalid-response");
  }
  if (!response.body) throw new SearchError("invalid-response");
  const reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0, text = "", complete = false;
  try {
    for (;;) {
      const chunk = await untilAbort(reader.read(), signal);
      if (chunk.done) { complete = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new SearchError("invalid-response");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function searchResults(value: unknown, provider: WebSearchProvider, maxResults: number): WebSearchResult["results"] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { results?: unknown }).results)) throw new SearchError("invalid-response");
  return ((value as { results: unknown[] }).results).slice(0, maxResults).map(item => {
    if (!item || typeof item !== "object") throw new SearchError("invalid-response");
    const row = item as { title?: unknown; url?: unknown; content?: unknown; highlights?: unknown };
    if (typeof row.title !== "string" || typeof row.url !== "string" || row.url.length > 2048) throw new SearchError("invalid-response");
    let url: URL; try { url = new URL(row.url); } catch { throw new SearchError("invalid-response"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new SearchError("invalid-response");
    let snippet: string;
    if (provider === "tavily") {
      if (typeof row.content !== "string") throw new SearchError("invalid-response");
      snippet = row.content;
    } else {
      if (row.highlights !== undefined && (!Array.isArray(row.highlights) || row.highlights.some(value => typeof value !== "string"))) throw new SearchError("invalid-response");
      snippet = (row.highlights as string[] | undefined)?.join("\n") ?? "";
    }
    return { title: row.title.slice(0, 300), url: row.url, snippet: snippet.slice(0, 2000) };
  });
}

export async function searchWeb(input: { provider?: WebSearchProvider; apiKey?: string; query: string; maxResults?: number; signal?: AbortSignal }, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<WebSearchResult> {
  if (!["tavily", "exa"].includes(input.provider ?? "") || !input.apiKey?.trim()) throw new SearchError("missing-config");
  if (/[\r\n]/.test(input.apiKey)) throw new SearchError("auth");
  const provider = input.provider!; const maxResults = input.maxResults ?? 5; const timeoutMs = options.timeoutMs ?? 15_000;
  if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 4096 || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new SearchError("invalid-request");
  if (input.signal?.aborted) throw new SearchError("cancel");
  const controller = new AbortController();
  const cancel = () => controller.abort(new SearchError("cancel"));
  input.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new SearchError("timeout")), timeoutMs);
  try {
    const fetching = (options.fetch ?? fetch)(provider === "tavily" ? "https://api.tavily.com/search" : "https://api.exa.ai/search", {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(provider === "tavily" ? { query: input.query, max_results: maxResults, search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false }
        : { query: input.query, numResults: maxResults, type: "auto", contents: { highlights: { maxCharacters: 2000 } } }),
    });
    void fetching.then(response => { if (controller.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await untilAbort(fetching, controller.signal);
    if (!response.ok || response.redirected) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      throw new SearchError([401, 403].includes(status) ? "auth" : status === 402 || (provider === "tavily" && [432, 433].includes(status)) ? "quota" : status === 429 ? "rate-limit" : "unavailable", status);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(await bodyText(response, controller.signal)); }
    catch (error) { if (error instanceof SearchError) throw error; throw new SearchError("invalid-response"); }
    if (controller.signal.aborted) throw aborted(controller.signal);
    return { provider, results: searchResults(parsed, provider, maxResults), untrusted: true,
      privacyNotice: `Your search query is sent to ${provider === "tavily" ? "Tavily" : "Exa"}. Results are untrusted source content, not instructions.`,
      costNotice: "This search uses the selected provider's API account and may incur separate charges. Your model subscription does not cover these charges.",
    };
  } catch (error) {
    if (controller.signal.aborted) throw aborted(controller.signal);
    if (error instanceof SearchError) throw error;
    throw new SearchError("offline");
  } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
}
