import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { conversationExportFilename, downloadConversation } from "./conversation-export";
import { resetNativeShellForTest } from "./native-shell";

const auth = vi.hoisted(() => ({ ensure: vi.fn(), headers: vi.fn(() => ({ "x-murage-surface-secret": "synthetic-proof" })) }));
vi.mock("@/lib/live-events", () => ({ ensureDesktopSurfaceSecret: auth.ensure, desktopSurfaceHeaders: auth.headers }));
let link: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); auth.ensure.mockReset().mockResolvedValue(undefined);
  link = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
  vi.stubGlobal("window", { setTimeout });
  fetchMock = vi.fn().mockResolvedValue(new Response("# Synthetic transcript", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("pins URL and filename before authentication, supplies proof and cleans download resources", async () => {
  let release!: () => void;
  auth.ensure.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = downloadConversation("task/one", "Quarterly report");
  // The native-availability check ahead of `ensure` resolves over a few
  // microtask ticks (no bridge is stubbed in this test); wait for it to
  // reach `ensure` before releasing it, instead of assuming it is synchronous.
  while (!auth.ensure.mock.calls.length) await Promise.resolve();
  expect(fetchMock).not.toHaveBeenCalled(); release();
  expect(await pending).toBe("conversation-quarterly-report.md");
  expect(fetchMock).toHaveBeenCalledWith("/api/threads/task%2Fone/export?format=markdown", { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": "synthetic-proof" } });
  expect(link.download).toBe("conversation-quarterly-report.md"); expect(link.href).toBe("blob:synthetic");
  expect(link.click).toHaveBeenCalledOnce(); expect(link.remove).toHaveBeenCalledOnce();
  vi.runAllTimers(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
});
it.each([404, 500])("does not download a refused response (%s) or reflect its contents", async status => {
  fetchMock.mockResolvedValue(new Response("sensitive-response-canary", { status }));
  await expect(downloadConversation("task", "Report")).rejects.not.toThrow("sensitive-response-canary");
  expect(link.click).not.toHaveBeenCalled(); expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("rejects non-Markdown and cleans resources if browser download activation throws", async () => {
  fetchMock.mockResolvedValueOnce(new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  await expect(downloadConversation("task", "Report")).rejects.toThrow("Markdown");
  link.click.mockImplementation(() => { throw Error("Download unavailable"); });
  await expect(downloadConversation("task", "Report")).rejects.toThrow("Download unavailable");
  expect(link.remove).toHaveBeenCalledOnce(); vi.runAllTimers(); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
});
it("inside the phone app, hands the export route to native by URL instead of reading it here", async () => {
  const saveFile = vi.fn(async () => undefined);
  vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile"] }), saveFile });
  vi.stubGlobal("location", { href: "https://desk.tailexample.ts.net/" });
  try {
    expect(await downloadConversation("task/one", "Quarterly report")).toBe("conversation-quarterly-report.md");
    expect(saveFile).toHaveBeenCalledWith({
      kind: "url",
      url: "https://desk.tailexample.ts.net/api/threads/task%2Fone/export?format=markdown",
      filename: "conversation-quarterly-report.md",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(link.click).not.toHaveBeenCalled();
  } finally {
    resetNativeShellForTest();
  }
});
it("keeps filenames bounded and safe on supported desktop platforms", () => {
  expect(conversationExportFilename("../../CON\u0000: secret\\path")).toBe("conversation-con-secret-path.md");
  expect(conversationExportFilename("💬")).toBe("conversation.md");
  expect(conversationExportFilename("a".repeat(500))).toHaveLength(96);
});
