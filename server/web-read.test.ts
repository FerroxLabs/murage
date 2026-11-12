import { describe, expect, it, vi } from "vitest";
import { WebDocuments, validateWebRange } from "./web-documents.ts";
import { readWebPage } from "./web-read.ts";
import { readWithBrowserAuthority } from "./browser-extension-engine-read.ts";

function fixture() {
  let text = "Start café 中文 😀\n";
  for (const boundary of [12000, 16000, 24000, 128 * 1024]) {
    text = text.padEnd(boundary - 30, "x") + `BEFORE_${boundary}`;
    text = text.padEnd(boundary + 1, "y") + `AFTER_${boundary}\n`;
  }
  return text + "GUARANTEE Fine print Checkout THE_END";
}
const scope = "bot/thread";
describe("complete saved web documents", () => {
  it("reconstructs every range including all historical boundaries and long lines", () => {
    const store = new WebDocuments(), text = fixture();
    let page = store.save(scope, text, "https://example.test/page");
    const handle = page.handle;
    let rebuilt = "";
    for (;;) {
      expect(page.text.length).toBeLessThanOrEqual(16000);
      rebuilt += page.text;
      if (page.eof) { expect(page.next_offset).toBeNull(); break; }
      page = store.read(scope, { handle, offset: page.next_offset! });
    }
    expect(rebuilt).toBe(text);
    expect(store.read(scope, { handle, offset: text.length }).eof).toBe(true);
    expect(() => store.read("other", { handle })).toThrow();
    for (const offset of [-1, 1.5, NaN, Infinity, text.length + 1]) expect(() => store.read(scope, { handle, offset })).toThrow();
    expect(() => validateWebRange({ offset: 12000 })).toThrow();
    expect(() => validateWebRange({ handle, start_index: 12000 })).toThrow();
  });
  it("honors explicit offsets and requested range lengths", () => {
    const store = new WebDocuments();
    const first = store.save(scope, "0123456789", "https://example.test", { length: 3 });
    expect(first.text).toBe("012");
    expect(store.read(scope, { handle: first.handle, offset: 6, length: 2 })).toMatchObject({ text: "67", offset: 6, next_offset: 8, eof: false });
  });
  it("refuses storage exhaustion without discarding an accepted tail", () => {
    const store = new WebDocuments(50);
    const first = store.save(scope, "small", "https://example.test");
    expect(() => store.save(scope, fixture(), "https://example.test")).toThrow();
    expect(store.read(scope, { handle: first.handle }).text).toBe("small");
  });
  it("fetches and converts once, and keeps a sales page over 13k complete", async () => {
    const text = "Sales page ".repeat(1250) + "Guarantee. Fine print. Checkout.";
    const fetcher = vi.fn(async () => new Response(`<html><body><p>${text}</p></body></html>`, { headers: { "content-type": "text/html" } }));
    const store = new WebDocuments();
    const ctx = { documents: store, scope, fetch: fetcher as typeof fetch, admitUrl: async () => {}, authorize: () => true };
    const first = await readWebPage({ url: "https://example.test/sales" }, ctx);
    expect(first.text).toBe(text);
    expect(first.eof).toBe(true);
    expect(first.total_length).toBeGreaterThan(13000);
    expect((await readWebPage({ handle: first.handle, offset: 13000 }, ctx)).text).toContain("Checkout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("Chrome saves complete active text and reads an immutable copy", async () => {
    const text = fixture(), activeHtml = vi.fn(async () => `<p>${text}</p>`);
    const ctx = { documents: new WebDocuments(), scope, currentUrl: "https://example.test", activeHtml, authorize: () => true, admitUrl: async () => {}, fenceOrigin: "https://example.test" };
    const first = await readWithBrowserAuthority({}, ctx);
    const saved = first.structuredContent;
    expect(saved.eof).toBe(false);
    activeHtml.mockResolvedValue("changed");
    const tail = await readWithBrowserAuthority({ handle: saved.handle, offset: 128 * 1024 }, ctx);
    expect(tail.structuredContent.content).toContain("Checkout THE_END");
    expect(tail.structuredContent.eof).toBe(true);
    expect(activeHtml).toHaveBeenCalledTimes(1);
  });
  it("keeps the full source behind a filtered view without returning it to context", async () => {
    const text = fixture();
    const ctx = { documents: new WebDocuments(), currentUrl: "https://example.test", activeHtml: vi.fn(async () => `<p>${text}</p>`), authorize: () => true, admitUrl: async () => {} };
    const view = await readWithBrowserAuthority({ outline: true }, ctx);
    expect(view.structuredContent.content).toBe("No headings found");
    const handle = view.structuredContent.source_handle!;
    expect(handle).toMatch(/^w-/);
    const tail = await readWithBrowserAuthority({ handle, offset: 128 * 1024 }, ctx);
    expect(tail.structuredContent.content).toContain("Checkout THE_END");
    expect(ctx.activeHtml).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized transport instead of accepting truncated content", async () => {
    const ctx = { documents: new WebDocuments(), scope, fetch: vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as typeof fetch, admitUrl: async () => {}, authorize: () => true };
    await expect(readWebPage({ url: "https://example.test" }, ctx)).rejects.toThrow();
  });
});
