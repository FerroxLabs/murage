import { describe, expect, it, vi } from "vitest";
import { searchWeb } from "./web-search.ts";

const input = { provider: "tavily" as const, apiKey: "fake-secret-canary", query: "fixture query" };
const response = (results: unknown) => Response.json({ results });
describe("bounded provider-neutral web search", () => {
  it("sends the exact Tavily basic request and normalizes bounded untrusted results", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(Array.from({ length: 12 }, () => ({ title: "T".repeat(400), url: "https://example.com/source", content: "S".repeat(3000) }))));
    const result = await searchWeb({ ...input, maxResults: 10 }, { fetch: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.tavily.com/search");
    const init = fetcher.mock.calls[0][1]!;
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: "Bearer fake-secret-canary" } });
    expect(JSON.parse(init.body as string)).toEqual({ query: input.query, max_results: 10, search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false });
    expect(result.results).toHaveLength(10); expect(result.results[0].title).toHaveLength(300); expect(result.results[0].snippet).toHaveLength(2000);
    expect(result.untrusted).toBe(true); expect(result.privacyNotice).toContain("Tavily"); expect(result.costNotice).toContain("separate charges");
  });
  it("uses Exa Bearer search with bounded highlights, not full source retrieval", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([{ title: "Source", url: "https://example.com/", highlights: ["First excerpt", "Second excerpt"] }]));
    const result = await searchWeb({ ...input, provider: "exa", maxResults: 2 }, { fetch: fetcher });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.exa.ai/search");
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({ query: input.query, numResults: 2, type: "auto", contents: { highlights: { maxCharacters: 2000 } } });
    expect(result.results[0].snippet).toBe("First excerpt\nSecond excerpt");
  });
  it("does not fetch without explicit provider/key or valid inputs", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(searchWeb({ ...input, provider: undefined }, { fetch: fetcher })).rejects.toMatchObject({ code: "missing-config" });
    await expect(searchWeb({ ...input, apiKey: "" }, { fetch: fetcher })).rejects.toMatchObject({ code: "missing-config" });
    await expect(searchWeb({ ...input, maxResults: 11 }, { fetch: fetcher })).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401, "auth"], [403, "auth"], [402, "quota"], [429, "rate-limit"], [432, "quota"], [433, "quota"], [503, "unavailable"]])("classifies HTTP %s without exposing provider response", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("fake-secret-canary fixture query", { status: status as number }));
    const error = await searchWeb(input, { fetch: fetcher }).catch(error => error);
    expect(error).toMatchObject({ code, status });
    expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(/fake-secret-canary|fixture query/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed schemas and unsafe or credential-bearing result URLs", async () => {
    for (const value of [null, {}, [{ title: "x", url: "file:///private/data", content: "x" }], [{ title: "x", url: "https://user:secret@example.com/", content: "x" }], [{ title: "x", url: "https://example.com/", content: 42 }]]) {
      await expect(searchWeb(input, { fetch: vi.fn<typeof fetch>().mockResolvedValue(response(value)) })).rejects.toMatchObject({ code: "invalid-response" });
    }
    await expect(searchWeb(input, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("not JSON fake-secret-canary")) })).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("cancels oversized bodies including undeclared streamed bytes", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel });
    await expect(searchWeb(input, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) })).rejects.toMatchObject({ code: "invalid-response" });
    expect(cancel).toHaveBeenCalled();
    await expect(searchWeb(input, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } })) })).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("applies the deadline to a stalled response body and cancels the stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(searchWeb(input, { timeoutMs: 20, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) })).rejects.toMatchObject({ code: "timeout" });
    expect(cancel).toHaveBeenCalled();
  });
  it("handles external abort and offline errors without leaking their reason", async () => {
    const controller = new AbortController(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = searchWeb({ ...input, signal: controller.signal }, { fetch: fetcher });
    controller.abort("fake-secret-canary");
    await expect(pending).rejects.toMatchObject({ code: "cancel" });
    await expect(searchWeb(input, { fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("fake-secret-canary")) })).rejects.toMatchObject({ code: "offline", message: "Could not connect to the search provider." });
  });
  it("never follows a redirect or retries with the credential", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.invalid" } }));
    await expect(searchWeb(input, { fetch: fetcher })).rejects.toMatchObject({ code: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.redirect).toBe("error");
  });
});
