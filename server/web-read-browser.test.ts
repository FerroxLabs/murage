import { createContext, runInContext } from "node:vm";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";
import { HTML_LENGTH_EXPRESSION } from "./browser-extension-page-scripts.ts";
import { describe, expect, it, vi } from "vitest";
import { callTool } from "./drivers/browser-proxy.ts";
import { createHeadlessBrowserProxy, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { validateHeadlessBrowserCall, listHeadlessBrowserTools } from "./browser-engine-policy.ts";
import { WebDocuments } from "./web-documents.ts";

const text = "A😀中 long line ".repeat(11000) + "Guarantee Fine print Checkout END";
describe("browser saved-document parity", () => {
  it("built-in browser uses handle offsets without reading a changed page again", async () => {
    const request = vi.fn(async (_operation: string) => ({ url: "https://example.test", title: "Sales", text, truncated: false }));
    const read = async (args: unknown) => {
      const reply = await callTool("browser_read", args, request);
      return JSON.parse((reply.content[0] as { text: string }).text);
    };
    let page = await read({}), rebuilt = "";
    const handle = page.handle;
    request.mockResolvedValue({ url: "https://example.test", title: "Changed", text: "changed", truncated: false });
    while (true) { rebuilt += page.text; if (page.eof) break; page = await read({ handle, offset: page.next_offset }); }
    expect(rebuilt).toBe(text);
    expect(request.mock.calls.filter(call => call[0] === "read")).toHaveLength(1);
    await expect(read({ offset: 12000 })).rejects.toThrow();
    await expect(read({ start_index: 12000 })).rejects.toThrow();
    await expect(read({ handle, offset: text.length + 1 })).rejects.toThrow();
  });
  it("built-in browser refuses upstream truncation", async () => {
    await expect(callTool("browser_read", {}, async () => ({ text: "prefix", truncated: true }))).rejects.toThrow("incomplete");
  });
  it("headless captures full HTML and never calls native read, even for continuation", async () => {
    const request = vi.fn(async (_method: string, params?: Record<string, unknown>) => {
      if (params?.name === "agent_browser_get_url") return { structuredContent: { response: { success: true, data: { url: "https://example.test" } } } };
      if (params?.name === "agent_browser_eval") return { structuredContent: { response: { success: true, data: { result: `<p>${text}</p>` } } } };
      return {};
    });
    const client: EngineClient = { request, close: async () => {} };
    const proxy = createHeadlessBrowserProxy({ authorize: async () => ({ spec: { command: "/fixture", args: [], env: {} }, held: false }), start: () => client, closeSession: async () => {} });
    const read = async (args: Record<string, unknown>) => {
      const reply = await proxy.handle({ id: 1, method: "tools/call", params: { name: "agent_browser_read", arguments: args } }) as any;
      expect(reply.result.isError).not.toBe(true);
      return reply.result.structuredContent;
    };
    try {
      let page = await read({});
      const handle = page.handle;
      let rebuilt = "";
      for (;;) {
        // The saved range is fenced; remove only the fixed wrapper, not page text.
        const start = page.content.indexOf("\n") + 1, end = page.content.lastIndexOf("\n");
        rebuilt += page.content.slice(start, end);
        if (page.eof) break;
        page = await read({ handle, offset: page.next_offset });
      }
      expect(rebuilt).toBe(text);
      expect(request.mock.calls.filter(([, p]) => p?.name === "agent_browser_eval")).toHaveLength(1);
      expect(request.mock.calls.some(([, p]) => p?.name === "agent_browser_read")).toBe(false);
    } finally { await proxy.close(); }
  });
  it("Chrome transport captures once and refuses missing slices or oversized pages", async () => {
    const doc: ExtensionDocument = { profileId: "fixture", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test" };
    for (const mode of ["complete", "missing", "oversized"]) {
      const html = mode === "oversized" ? "x".repeat(2 * 1024 * 1024 + 1) : `<p>${text}</p>`;
      const world = createContext({ document: { documentElement: { outerHTML: html } } });
      const executor = new BrowserExtensionExecutor({ authorize: () => true, access: async () => true, admit: async () => true,
        transport: { document: async () => doc, send: async (method, params) => {
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          if (method === "Runtime.evaluate") {
            const expression = String(params.expression);
            const value = mode === "missing" && expression.includes(".slice(120000,") ? "short" : runInContext(expression, world);
            if (expression === HTML_LENGTH_EXPRESSION) world.document.documentElement.outerHTML = "changed";
            return { result: { value } };
          }
          throw Error("Unexpected transport request");
        } },
      });
      const capture = (executor as unknown as { activeHtml(document: ExtensionDocument): Promise<string> }).activeHtml(doc);
      if (mode === "complete") expect(await capture).toBe(html);
      else await expect(capture).rejects.toThrow(mode === "missing" ? "in full" : "transport limit");
      expect(world.__murageSavedReadHtml).toBeUndefined();
    }
  });
  it("exposes strict range arguments on both Chrome and headless schemas", () => {
    const [tool] = listHeadlessBrowserTools([{ name: "agent_browser_read", description: "old capped reader" }]);
    expect((tool.inputSchema as any).properties).toHaveProperty("handle");
    expect(validateHeadlessBrowserCall("agent_browser_read", { handle: "w-123", offset: 24000 }).arguments.offset).toBe(24000);
    expect(() => validateHeadlessBrowserCall("agent_browser_read", { start_index: 12000 })).toThrow();
  });
  it("handles Unicode boundary pairs and expiry explicitly", () => {
    let now = 1;
    const store = new WebDocuments(1024 * 1024, () => now);
    const saved = store.save("scope", "a".repeat(15999) + "😀TAIL", "https://example.test");
    expect(saved.next_offset).toBe(15999);
    expect(store.read("scope", { handle: saved.handle, offset: saved.next_offset! }).text).toBe("😀TAIL");
    expect(() => store.read("scope", { handle: saved.handle, offset: 16000 })).toThrow("Unicode");
    now += 3600001;
    expect(() => store.read("scope", { handle: saved.handle })).toThrow("expired");
  });
});
