import { describe, expect, it, vi } from "vitest";
import { searchFreeWeb } from "./free-web-search.ts";
const ddg = '<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=abc" class="result__a">Example &amp; guide</a><a class="result__snippet">A <b>useful</b> source.</a>';
function primary() {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ jsonrpc: "2.0", id: "init-1", result: { capabilities: {} } }, { headers: { "mcp-session-id": "fixture" } }))
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "call-1", result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Source", url: "https://example.com", excerpts: ["Evidence"] }] }) }] } })}\n\n`));
}
describe("anonymous search fallback", () => {
  it("completes the anonymous MCP handshake and parses SSE results", async () => {
    const fetcher = primary(); const result = await searchFreeWeb({ query: "fixture" }, { fetch: fetcher });
    expect(result).toMatchObject({ provider: "parallel", fallbackUsed: false, untrusted: true, results: [{ title: "Source", url: "https://example.com", snippet: "Evidence" }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) { expect(init?.redirect).toBe("error"); expect(init?.headers).not.toHaveProperty("authorization"); }
    expect(JSON.parse(fetcher.mock.calls[2][1]!.body as string).params).toEqual({ name: "web_search", arguments: { objective: "fixture", search_queries: ["fixture"] } });
  });
  it("falls back once on primary failure and unwraps DDG citations", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("private-canary")).mockResolvedValueOnce(new Response(ddg));
    expect(await searchFreeWeb({ query: "fixture" }, { fetch: fetcher })).toMatchObject({ provider: "duckduckgo", fallbackUsed: true, results: [{ title: "Example & guide", url: "https://example.com/guide", snippet: "A useful source." }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not fall back after cancellation or total deadline", async () => {
    const controller = new AbortController(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = searchFreeWeb({ query: "fixture", signal: controller.signal }, { fetch: fetcher }); controller.abort("private-canary");
    await expect(pending).rejects.toMatchObject({ code: "cancel" }); expect(fetcher).toHaveBeenCalledTimes(1);
    const timeoutFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    await expect(searchFreeWeb({ query: "fixture" }, { fetch: timeoutFetch, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" }); expect(timeoutFetch).toHaveBeenCalledTimes(1);
  });
  it("refuses malformed or empty providers without leaking response errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("bad-json-private-canary")).mockResolvedValueOnce(new Response("captcha-private-canary"));
    const error = await searchFreeWeb({ query: "fixture" }, { fetch: fetcher }).catch(error => error);
    expect(error.code).toBe("unavailable"); expect(error.message).not.toContain("private-canary"); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects oversized primary responses and credential URLs in fallback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("x", { headers: { "content-length": "1048577" } })).mockResolvedValueOnce(new Response('<a class="result__a" href="https://secret:password@example.com">Bad</a>'));
    await expect(searchFreeWeb({ query: "fixture" }, { fetch: fetcher })).rejects.toMatchObject({ code: "unavailable" });
  });
});
