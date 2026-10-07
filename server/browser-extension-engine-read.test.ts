import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectReadHtml, readWithBrowserAuthority, type EngineReadContext, type EngineReadOptions } from "./browser-extension-engine-read.ts";

const ORIGIN = "https://docs.test";
type Resource = { body?: string; type?: string; status?: number; location?: string };
function fixture(routes: Record<string, Resource> = {}) {
  const events: string[] = [], calls: { url: string; options: RequestInit }[] = [];
  let authorized = true;
  const admitUrl = vi.fn(async (url: string) => { events.push("admit " + url); });
  const activeHtml = vi.fn(async () => "<h1>Active page</h1><p>Current document</p>");
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input); events.push("fetch " + url); calls.push({ url, options: options! });
    const route = routes[url] ?? { status: 404, body: "missing", type: "text/plain" };
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: { "content-type": route.type ?? "text/markdown", ...(route.location ? { location: route.location } : {}) } });
  });
  const context: EngineReadContext = { currentUrl: ORIGIN + "/docs", activeHtml, admitUrl, authorize: () => authorized, fetch: fetcher as typeof fetch };
  return { context, calls, events, fetcher, admitUrl, activeHtml, revoke: () => { authorized = false; }, read: (options: EngineReadOptions) => readWithBrowserAuthority(options, context) };
}
afterEach(() => vi.useRealTimers());

describe("authorized engine read compatibility", () => {
  it("reads the current protected-checked HTML and emits only the public metadata", async () => {
    const f = fixture();
    const result = await f.read({});
    expect(result.structuredContent).toEqual({ url: ORIGIN + "/docs", finalUrl: ORIGIN + "/docs", contentType: "text/html", source: "active-tab-html", truncated: false, content: "# Active page\n\nCurrent document" });
    expect(result.content).toEqual([{ type: "text", text: result.structuredContent.content }]);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it("preserves raw active HTML while honoring outline/filter source suffixes", async () => {
    const f = fixture();
    expect((await f.read({ raw: true })).structuredContent.source).toBe("active-tab-raw");
    const outline = await f.read({ outline: true, filter: "active" });
    expect(outline.structuredContent.source).toBe("active-tab-html-outline");
    expect(outline.structuredContent.content).toBe(`# Outline\n\nSource: ${ORIGIN}/docs\n\n- Active page`);
    expect((await f.read({ filter: "absent" })).structuredContent).toMatchObject({ source: "active-tab-html-filtered", content: "No matching page sections" });
  });
  it("prefers negotiated markdown and never leaks internal body/tree/ok fields", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "# Kept\n\nSelected\n\n# Omitted\n\nRAW_BODY_SECRET", type: "Text/Markdown; charset=utf-8" } });
    const result = await f.read({ url: ORIGIN + "/docs", filter: "Kept" });
    expect(result.structuredContent).toMatchObject({ source: "accept-markdown-filtered", contentType: "Text/Markdown; charset=utf-8", status: 200, content: "# Kept\n\nSelected" });
    expect(Object.keys(result.structuredContent).sort()).toEqual(["content", "contentType", "finalUrl", "source", "status", "truncated", "url"]);
    expect(JSON.stringify(result)).not.toContain("RAW_BODY_SECRET");
    expect(f.calls).toHaveLength(1);
  });
  it("normalizes fetched URL shorthand and strips its fragment after admission", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "# Docs" } });
    const result = await f.read({ url: "docs.test/docs#section" });
    expect(f.admitUrl).toHaveBeenCalledWith(ORIGIN + "/docs#section");
    expect(f.calls[0].url).toBe(ORIGIN + "/docs");
    expect(result.structuredContent.url).toBe(ORIGIN + "/docs");
  });
  it("tries .md before primary text and preserves the requested query", async () => {
    const url = ORIGIN + "/guide/?lang=en";
    const f = fixture({ [url]: { body: "primary", type: "text/plain" }, [ORIGIN + "/guide.md?lang=en"]: { body: "# Fallback\n", type: "text/plain" } });
    expect((await f.read({ url })).structuredContent).toMatchObject({ source: "path-markdown", finalUrl: ORIGIN + "/guide.md?lang=en", content: "# Fallback\n" });
    expect(f.calls.map(call => call.url)).toEqual([url, ORIGIN + "/guide.md?lang=en"]);
  });
  it("returns primary text after unusable .md without scanning llms", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "plain", type: "text/plain" } });
    expect((await f.read({ url: ORIGIN + "/docs" })).structuredContent).toMatchObject({ source: "text", content: "plain" });
    expect(f.calls).toHaveLength(2);
  });
  it("preserves primary HTTP failure without inventing a fallback response", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "no", status: 503, type: "text/markdown" } });
    await expect(f.read({ url: ORIGIN + "/docs" })).rejects.toThrow("Read failed with HTTP 503");
    expect(f.calls.some(call => call.url.endsWith("docs.md"))).toBe(false);
  });
  it("returns unknown MIME bodies as raw and raw mode never negotiates fallbacks", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: '{"answer":42}', type: "application/json" } });
    expect((await f.read({ url: ORIGIN + "/docs", raw: true })).structuredContent).toMatchObject({ source: "raw", content: '{"answer":42}' });
    expect(f.calls).toHaveLength(1);
  });
  it("requires exact markdown MIME even for raw responses", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "# Almost", type: "text/x-markdown" } });
    await expect(f.read({ url: ORIGIN + "/docs", raw: true, requireMd: true })).rejects.toThrow("Expected text/markdown, got text/x-markdown");
    expect(f.calls).toHaveLength(1);
  });
  it("keeps a matched heading subtree but excludes its next sibling", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { body: "# Intro\n\n## Setup\nInstall\n\n## Rendering\nRender\n\n### Child\nNested\n\n## Other\nIgnore" } });
    expect((await f.read({ url: ORIGIN + "/docs", filter: "Rendering" })).structuredContent.content).toBe("## Rendering\nRender\n\n### Child\nNested");
  });
  it("walks llms ancestors, filters and deduplicates list links", async () => {
    const f = fixture({ [ORIGIN + "/docs/llms.txt"]: { body: "- [Intro](/intro)\n- [Auth](<./auth.md> \"title\")\n- [AUTH](./auth.md)\n![Image](/image)\nParagraph [Hidden](/hidden)", type: "text/plain" } });
    const result = await f.read({ url: ORIGIN + "/docs/intro?lang=en", llms: "index", filter: "auth", outline: true, raw: true });
    expect(result.structuredContent.source).toBe("llms-index");
    expect(result.structuredContent.content).toBe(`# llms.txt\n\nSource: ${ORIGIN}/docs/llms.txt\n\n- [Auth](${ORIGIN}/docs/auth.md)`);
    expect(f.calls.map(call => call.url)).toEqual([ORIGIN + "/docs/intro/llms.txt", ORIGIN + "/docs/llms.txt"]);
  });
  it("filters llms-full by body sections, not a parent's heading subtree", async () => {
    const f = fixture({ [ORIGIN + "/docs/llms-full.txt"]: { body: "# Intro\nWelcome\n\n## Auth\nUse token auth\n\n### Other\nNo match" } });
    const result = await f.read({ llms: "full", filter: "token", outline: true });
    expect(result.structuredContent).toMatchObject({ source: "llms-full", content: "## Auth\nUse token auth" });
  });
  it("rejects llms text/plain immediately when requireMd is set", async () => {
    const f = fixture({ [ORIGIN + "/docs/llms-full.txt"]: { body: "# Docs", type: "text/plain" } });
    await expect(f.read({ llms: "full", requireMd: true })).rejects.toThrow("Expected text/markdown, got text/plain");
    expect(f.calls).toHaveLength(1);
  });
  it("follows only the matching llms document through admission", async () => {
    const f = fixture({
      [ORIGIN + "/docs/intro"]: { body: "<h1>HTML</h1>", type: "text/html" },
      [ORIGIN + "/docs/llms.txt"]: { body: "- [Intro](/markdown/intro.md)\n- [Other](/other)" },
      [ORIGIN + "/markdown/intro.md"]: { body: "# Linked" },
    });
    expect((await f.read({ url: ORIGIN + "/docs/intro" })).structuredContent).toMatchObject({ source: "llms-link", content: "# Linked" });
    for (const call of f.calls) expect(f.events.indexOf("admit " + call.url)).toBeLessThan(f.events.indexOf("fetch " + call.url));
    expect(f.calls.some(call => call.url === ORIGIN + "/other")).toBe(false);
  });
  it("does not choose an ambiguous llms title match", async () => {
    const f = fixture({
      [ORIGIN + "/intro"]: { body: "<h1>Original</h1>", type: "text/html" },
      [ORIGIN + "/llms.txt"]: { body: "- [Intro](/a/intro.md)\n- [Intro](/b/intro.md)" },
    });
    expect((await f.read({ url: ORIGIN + "/intro" })).structuredContent).toMatchObject({ source: "html-fallback", content: "# Original" });
    expect(f.calls.some(call => /\/[ab]\/intro/.test(call.url))).toBe(false);
  });
});

describe("read authority and bounded I/O", () => {
  it("authorizes redirects before request and never passes browser credentials", async () => {
    const f = fixture({ [ORIGIN + "/docs"]: { status: 302, location: "/final#section" }, [ORIGIN + "/final"]: { body: "# Final" } });
    const result = await f.read({ url: ORIGIN + "/docs" });
    expect(result.structuredContent.finalUrl).toBe(ORIGIN + "/final");
    expect(f.events.indexOf("admit " + ORIGIN + "/final#section")).toBeLessThan(f.events.indexOf("fetch " + ORIGIN + "/final"));
    for (const call of f.calls) {
      expect(call.options).toMatchObject({ credentials: "omit", redirect: "manual", referrerPolicy: "no-referrer" });
      const headers = new Headers(call.options.headers);
      expect([...headers.keys()].sort()).toEqual(["accept", "user-agent"]);
    }
  });
  it.each(["redirect", "path", "llms", "linked"])("a denied %s destination cannot be fetched or hidden by fallback", async kind => {
    const denied = kind === "redirect" ? "https://private.test/secrets" : kind === "path" ? ORIGIN + "/intro.md" : kind === "llms" ? ORIGIN + "/intro/llms.txt" : ORIGIN + "/markdown/intro.md";
    const f = fixture({
      [ORIGIN + "/intro"]: kind === "redirect" ? { status: 302, location: denied } : { body: "<h1>Primary</h1>", type: "text/html" },
      [ORIGIN + "/llms.txt"]: { body: "- [Intro](/markdown/intro.md)" },
    });
    f.admitUrl.mockImplementation(async url => { if (url === denied) throw Error("denied"); });
    await expect(f.read({ url: ORIGIN + "/intro" })).rejects.toThrow("destination was not approved");
    expect(f.calls.some(call => call.url === denied)).toBe(false);
  });
  it.each(["file:///private", "javascript:alert(1)", "https://name:password@docs.test/"])("rejects unsupported or credential-bearing URL %s", async url => {
    const f = fixture(); await expect(f.read({ url })).rejects.toThrow("URL refused"); expect(f.calls).toHaveLength(0);
  });
  it("rechecks authority after admission before any I/O", async () => {
    const f = fixture(); f.admitUrl.mockImplementation(async () => f.revoke());
    await expect(f.read({ url: ORIGIN + "/docs" })).rejects.toThrow("authority changed");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.activeHtml).not.toHaveBeenCalled();
  });
  it("drops active HTML when authority is revoked while it is being read", async () => {
    const f = fixture(); f.activeHtml.mockImplementation(async () => { f.revoke(); return "<h1>PRIVATE</h1>"; });
    await expect(f.read({})).rejects.toThrow("authority changed");
  });
  it("drops a streamed response when authority changes before output", async () => {
    const f = fixture();
    f.context.fetch = (async () => new Response(new ReadableStream({ pull(controller) { f.revoke(); controller.enqueue(new TextEncoder().encode("PRIVATE")); controller.close(); } }), { headers: { "content-type": "text/markdown" } })) as typeof fetch;
    await expect(f.read({ url: ORIGIN + "/docs" })).rejects.toThrow("authority changed");
  });
  it.each(["admission", "active HTML", "fetch", "stream"])("whole-call timeout bounds stalled %s", async stage => {
    vi.useFakeTimers(); const f = fixture(), never = () => new Promise<never>(() => {});
    if (stage === "admission") f.admitUrl.mockImplementation(never);
    if (stage === "active HTML") f.activeHtml.mockImplementation(never);
    if (stage === "fetch") f.context.fetch = never;
    if (stage === "stream") f.context.fetch = (async () => new Response(new ReadableStream({ pull: never }), { headers: { "content-type": "text/markdown" } })) as typeof fetch;
    const work = f.read({ ...(stage === "active HTML" ? {} : { url: ORIGIN + "/docs" }), readTimeoutMs: 20 });
    const refused = expect(work).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(21); await refused;
  });
  it("does not start I/O after a late admission outlives its deadline", async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: () => void;
    f.admitUrl.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const refused = expect(f.read({ url: ORIGIN + "/docs", readTimeoutMs: 20 })).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(21); await refused; finish(); await Promise.resolve();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("enforces one aggregate byte budget across fallback requests", async () => {
    const body = "x".repeat(1100000);
    const f = fixture({ [ORIGIN + "/docs"]: { body, type: "text/html" }, [ORIGIN + "/docs.md"]: { body } });
    await expect(f.read({ url: ORIGIN + "/docs" })).rejects.toThrow("response limit");
    expect(f.calls).toHaveLength(2);
  });
  it("bounds recursive redirects and ancestor requests", async () => {
    const f = fixture(); f.context.fetch = (async () => new Response(null, { status: 302, headers: { location: "/docs" } })) as typeof fetch;
    await expect(f.read({ url: ORIGIN + "/docs" })).rejects.toThrow("redirect limit");
    const ancestors = fixture();
    await expect(ancestors.read({ url: ORIGIN + "/" + Array(40).fill("deep").join("/"), llms: "index" })).rejects.toThrow("request limit");
    expect(ancestors.calls).toHaveLength(32);
  });
  it.each([
    '<INPUT TYPE="pass&#x77;ord">',
    '<textarea aria-label="API&#32;key"></textarea>',
    '<select autocomplete="cc-number"></select>',
    '<div contenteditable placeholder="recovery&#32;code"></div>',
    '<template><input autocomplete="one-time-code"></template>',
  ])("refuses parsed protected content even in raw/mislabelled responses: %s", async body => {
    const f = fixture({ [ORIGIN + "/docs"]: { body, type: "text/plain" } });
    await expect(f.read({ url: ORIGIN + "/docs", raw: true })).rejects.toThrow(/protected|embedded/);
  });
  // Replaced requirement (Fable H3, Astra 9): a frame or a shadow template in fetched HTML is opaque, not a reason
  // to refuse the whole page. Only a target or focus inside one is refused, and a fetch has neither.
  it.each([
    '<p>Visible</p><iframe src="https://private.test/"></iframe>',
    '<p>Visible</p><template shadowrootmode="closed"><p>Hidden</p></template>',
    '<p>Visible</p><object data="x"></object><embed src="y">',
  ])("reads the page around a frame or shadow template: %s", async body => {
    const f = fixture({ [ORIGIN + "/docs"]: { body, type: "text/html" } });
    const result = await f.read({ url: ORIGIN + "/docs" }) as { content: { text: string }[] };
    expect(result.content[0].text).toContain("Visible"); expect(result.content[0].text).not.toContain("Hidden");
  });
  it("does not mistake escaped prose for an active protected element", () => {
    expect(() => inspectReadHtml("<p>&lt;input type=password&gt; is documentation</p>")).not.toThrow();
  });
});
