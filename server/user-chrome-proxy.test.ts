// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage's one connection to the owner's Chrome (user-chrome-proxy.ts), against
// a stand-in Chrome that, like the real one, answers nothing until Allow.
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { UserChromeProxy } from "./user-chrome-proxy.ts";

type Sent = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fakeChrome() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const chrome = { connections: 0, received: [] as Sent[], allowed: false, waiting: [] as (() => void)[], socket: undefined as WebSocket | undefined };
  wss.on("connection", (socket) => {
    chrome.connections++; chrome.socket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Sent; chrome.received.push(message);
      const answer = (result: Record<string, unknown>) => socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
      if (message.method === "Browser.getVersion") { const go = () => answer({ product: "Chrome/144" }); if (chrome.allowed) go(); else chrome.waiting.push(go); return; }
      if (message.method === "Target.attachToTarget") {
        const sessionId = `S-${message.params!.targetId}-${chrome.received.length}`;
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId: message.params!.targetId, type: "page" }, waitingForDebugger: false } }));
        answer({ sessionId }); return;
      }
      answer({});
    });
  });
  const port = (wss.address() as { port: number }).port;
  closers.push(() => new Promise<void>((resolve) => { for (const client of wss.clients) client.terminate(); wss.close(() => resolve()); }));
  return { ...chrome, get state() { return chrome; }, url: `ws://127.0.0.1:${port}/devtools/browser/4c1b0f0e-9a2d-4e8f-b1c3-5d6e7f8a9b0c`, allow() { chrome.allowed = true; for (const go of chrome.waiting.splice(0)) go(); } };
}
async function proxyFor(url: string, waitMs = 5000) {
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
  const proxy = await UserChromeProxy.start(url, waitMs); closers.push(() => proxy.close()); return proxy;
}
function client(url: string) {
  const socket = new WebSocket(url); const inbox: Sent[] = [];
  socket.on("message", (raw) => inbox.push(JSON.parse(raw.toString())));
  socket.on("error", () => {});
  closers.push(() => { socket.terminate(); });
  const opened = new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("close", () => reject(new Error("closed"))); socket.once("error", reject); });
  opened.catch(() => {});
  return { socket, inbox, opened, send: (message: Sent) => socket.send(JSON.stringify(message)) };
}
const until = async (check: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); } };

describe("Murage's one connection to the owner's Chrome", () => {
  it("asks Chrome once for the engine and the page check, and holds both until Allow", async () => {
    const chrome = await fakeChrome(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl);
    let open = false; void Promise.all([engine.opened, guard.opened]).then(() => { open = true; });
    await until(() => chrome.state.received.some((item) => item.method === "Browser.getVersion"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(open).toBe(false); expect(proxy.state).toBe("waiting");
    chrome.allow(); await Promise.all([engine.opened, guard.opened]);
    expect(chrome.state.connections).toBe(1); expect(proxy.state).toBe("allowed");
  });
  it("gives each client its own answers under its own ids", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl); await Promise.all([engine.opened, guard.opened]);
    engine.send({ id: 1, method: "Target.getTargets" }); guard.send({ id: 1, method: "Target.getTargets" });
    await until(() => engine.inbox.length === 1 && guard.inbox.length === 1);
    expect(engine.inbox[0]!.id).toBe(1); expect(guard.inbox[0]!.id).toBe(1);
    const upstreamIds = chrome.state.received.filter((item) => item.method === "Target.getTargets").map((item) => item.id);
    expect(new Set(upstreamIds).size).toBe(2);
  });
  it("announces a page-check session to the page check only, and keeps its traffic there", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl); await Promise.all([engine.opened, guard.opened]);
    guard.send({ id: 7, method: "Target.attachToTarget", params: { targetId: "T1", flatten: true } });
    await until(() => guard.inbox.some((item) => item.id === 7));
    const sessionId = (guard.inbox.find((item) => item.id === 7) as { result: { sessionId: string } }).result.sessionId;
    expect(guard.inbox.findIndex((item) => item.method === "Target.attachedToTarget")).toBeLessThan(guard.inbox.findIndex((item) => item.id === 7));
    chrome.state.socket!.send(JSON.stringify({ method: "Page.javascriptDialogOpening", params: { type: "alert" }, sessionId }));
    engine.send({ id: 2, method: "Runtime.evaluate", sessionId });
    await until(() => engine.inbox.some((item) => item.id === 2) && guard.inbox.some((item) => item.method === "Page.javascriptDialogOpening"));
    expect(engine.inbox.some((item) => item.method === "Target.attachedToTarget" || item.method === "Page.javascriptDialogOpening")).toBe(false);
    expect((engine.inbox.find((item) => item.id === 2) as { error?: unknown }).error).toBeTruthy();
  });
  it("sends Chrome-level events to the engine", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl); await Promise.all([engine.opened, guard.opened]);
    chrome.state.socket!.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { targetId: "T9" } } }));
    chrome.state.socket!.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: "AUTO", targetInfo: { targetId: "T9" } } }));
    await until(() => engine.inbox.length === 2);
    expect(guard.inbox).toHaveLength(0);
  });
  it("when the engine leaves, frees the owner's tabs and keeps Chrome's Allow for the next start", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl); await engine.opened;
    engine.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "T2", flatten: true } });
    await until(() => engine.inbox.some((item) => item.id === 1));
    engine.socket.close();
    await until(() => chrome.state.received.some((item) => item.method === "Target.setAutoAttach"));
    await until(() => chrome.state.received.some((item) => item.method === "Target.detachFromTarget"));
    expect(chrome.state.received.find((item) => item.method === "Target.setAutoAttach")!.params).toMatchObject({ autoAttach: false, waitForDebuggerOnStart: false });
    const again = client(proxy.engineUrl); await again.opened;
    expect(chrome.state.connections).toBe(1);
    expect(chrome.state.received.filter((item) => item.method === "Browser.getVersion")).toHaveLength(1);
  });
  it("refuses any other address on its port, and a second client in a role", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const wrong = client(proxy.engineUrl.replace(/[0-9a-f]{48}$/u, "0".repeat(48)));
    await expect(wrong.opened).rejects.toThrow();
    const first = client(proxy.engineUrl); await first.opened;
    const second = client(proxy.engineUrl); await expect(second.opened).rejects.toThrow();
    expect(chrome.state.connections).toBe(1);
  });
  it("gives up after the Allow wait, says so without any address, and asks again only when tried again", async () => {
    const chrome = await fakeChrome(); const proxy = await proxyFor(chrome.url, 200);
    const engine = client(proxy.engineUrl); await expect(engine.opened).rejects.toThrow();
    expect(proxy.state).toBe("failed");
    const said = [...(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls, ...(console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls].map((call) => String(call[0])).join("\n");
    expect(said).toContain("[browser] user-chrome attach failed");
    expect(said).not.toMatch(/ws:\/\/|devtools|127\.0\.0\.1/);
    chrome.allow();
    const retry = client(proxy.engineUrl); await retry.opened;
    expect(chrome.state.connections).toBe(2);
  });
});
