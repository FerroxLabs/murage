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
  const chrome = { connections: 0, received: [] as Sent[], allowed: false, waiting: [] as (() => void)[], socket: undefined as WebSocket | undefined,
    // The owner's tabs, and the tabs created through the connection (announced before the answer, as real Chrome does).
    targets: [{ targetId: "OWNER1", type: "page" }, { targetId: "OWNER2", type: "page" }, { targetId: "SW", type: "service_worker" }] as Record<string, unknown>[], created: 0, duringCreate: [] as Record<string, unknown>[], failCreate: false };
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
      if (message.method === "Target.getTargets") { answer({ targetInfos: chrome.targets }); return; }
      if (message.method === "Target.createTarget" && chrome.failCreate) {
        for (const event of chrome.duringCreate.splice(0)) socket.send(JSON.stringify(event));
        socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: "Failed to open a new tab" } })); return;
      }
      if (message.method === "Target.createTarget") {
        const targetId = `BOT${++chrome.created}`, info = { targetId, type: "page" }; chrome.targets.push(info);
        socket.send(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: info } }));
        socket.send(JSON.stringify({ method: "Target.attachedToTarget", params: { sessionId: `AUTO-${targetId}`, targetInfo: info, waitingForDebugger: true } }));
        for (const event of chrome.duringCreate.splice(0)) socket.send(JSON.stringify(event));
        answer({ targetId }); return;
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
  it("sends Chrome-level events about the bot's own tabs to the engine", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl); await Promise.all([engine.opened, guard.opened]);
    engine.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    await until(() => engine.inbox.some((item) => item.id === 1));
    // Held until the answer named the tab, then delivered ahead of it.
    expect(engine.inbox.map((item) => item.method ?? "answer")).toEqual(["Target.targetCreated", "Target.attachedToTarget", "answer"]);
    expect(guard.inbox).toHaveLength(0);
    expect([...proxy.botTargets()]).toEqual(["BOT1"]);
  });
  it("when the engine leaves, frees the owner's tabs and keeps Chrome's Allow for the next start", async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl); await engine.opened;
    engine.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    await until(() => engine.inbox.some((item) => item.id === 1));
    engine.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "BOT1", flatten: true } });
    await until(() => engine.inbox.some((item) => item.id === 2));
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

describe("the bot works in tabs of its own: the owner's tabs are out of the engine's sight", () => {
  const ready = async () => {
    const chrome = await fakeChrome(); chrome.allow(); const proxy = await proxyFor(chrome.url);
    const engine = client(proxy.engineUrl), guard = client(proxy.guardUrl); await Promise.all([engine.opened, guard.opened]);
    let next = 100;
    const ask = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      const id = ++next; engine.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      await until(() => engine.inbox.some((item) => item.id === id));
      return engine.inbox.find((item) => item.id === id) as { result?: any; error?: { message: string } };
    };
    const fromChrome = (message: Record<string, unknown>) => chrome.state.socket!.send(JSON.stringify(message));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    return { chrome, proxy, engine, guard, ask, fromChrome, settle };
  };
  it("lists only the bot's tabs, before and after it opens one", async () => {
    const { proxy, ask } = await ready();
    expect((await ask("Target.getTargets")).result.targetInfos).toEqual([]);
    expect(proxy.botTargets().size).toBe(0);
    await ask("Target.createTarget", { url: "about:blank" });
    expect((await ask("Target.getTargets")).result.targetInfos).toEqual([{ targetId: "BOT1", type: "page" }]);
  });
  it("refuses, unsent, every command naming an owner's tab, a browser session and raw relays", async () => {
    const { chrome, ask } = await ready();
    for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget", "Target.getTargetInfo", "Target.exposeDevToolsProtocol"]) {
      expect((await ask(method, { targetId: "OWNER1", flatten: true })).error?.message).toBe("No target with given id found");
    }
    expect((await ask("Target.attachToBrowserTarget")).error).toBeTruthy();
    expect((await ask("Target.sendMessageToTarget", { message: "{}", sessionId: "X" })).error).toBeTruthy();
    expect(chrome.state.received.some((item) => item.params?.targetId === "OWNER1" || item.method === "Target.attachToBrowserTarget" || item.method === "Target.sendMessageToTarget")).toBe(false);
    // A session it never opened is not its own.
    expect((await ask("Runtime.evaluate", { expression: "document.title" }, "S-OWNER1-1")).error).toBeTruthy();
  });
  it("drops every event about an owner's tab, and resumes and lets go of an auto-attach to one", async () => {
    const { chrome, engine, fromChrome, settle } = await ready();
    fromChrome({ method: "Target.targetCreated", params: { targetInfo: { targetId: "OWNER3", type: "page" } } });
    fromChrome({ method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "OWNER1", type: "page", url: "https://bank.example/reset?token=x" } } });
    fromChrome({ method: "Target.attachedToTarget", params: { sessionId: "AUTO-OWNER3", targetInfo: { targetId: "OWNER3", type: "page" }, waitingForDebugger: true } });
    fromChrome({ method: "Network.requestWillBeSent", sessionId: "AUTO-OWNER3", params: { request: { url: "https://bank.example/" } } });
    fromChrome({ method: "Target.targetDestroyed", params: { targetId: "OWNER2" } });
    await until(() => chrome.state.received.some((item) => item.method === "Target.detachFromTarget"));
    await settle();
    expect(engine.inbox).toHaveLength(0);
    const resumed = chrome.state.received.findIndex((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "AUTO-OWNER3");
    const detached = chrome.state.received.findIndex((item) => item.method === "Target.detachFromTarget" && item.params?.sessionId === "AUTO-OWNER3");
    expect(resumed).toBeGreaterThan(-1); expect(detached).toBeGreaterThan(resumed);
  });
  it("resumes and lets go of any paused target that is not the bot's: a worker as well as a page", async () => {
    const { chrome, engine, fromChrome, settle } = await ready();
    fromChrome({ method: "Target.attachedToTarget", params: { sessionId: "AUTO-SW", targetInfo: { targetId: "SW", type: "service_worker" }, waitingForDebugger: true } });
    await until(() => chrome.state.received.some((item) => item.method === "Target.detachFromTarget" && item.params?.sessionId === "AUTO-SW"));
    await settle();
    expect(chrome.state.received.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "AUTO-SW")).toBe(true);
    expect(engine.inbox).toHaveLength(0);
  });
  it("a paused owner's target held while the bot's open fails is resumed and let go", async () => {
    const { chrome, proxy, engine, ask } = await ready();
    chrome.state.failCreate = true;
    chrome.state.duringCreate.push({ method: "Target.attachedToTarget", params: { sessionId: "AUTO-OWNER6", targetInfo: { targetId: "OWNER6", type: "page" }, waitingForDebugger: true } });
    expect((await ask("Target.createTarget", { url: "about:blank" })).error).toBeTruthy();
    await until(() => chrome.state.received.some((item) => item.method === "Target.detachFromTarget" && item.params?.sessionId === "AUTO-OWNER6"));
    expect(chrome.state.received.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "AUTO-OWNER6")).toBe(true);
    expect(engine.inbox.some((item) => JSON.stringify(item).includes("OWNER6"))).toBe(false);
    expect(proxy.botTargets().size).toBe(0);
  });
  it("a paused frame or worker under a session nobody here holds is resumed and let go, never delivered", async () => {
    const { chrome, engine, guard, fromChrome, settle } = await ready();
    fromChrome({ method: "Target.attachedToTarget", sessionId: "OWNER-UNKNOWN", params: { sessionId: "CHILD-1", targetInfo: { targetId: "IFR", type: "iframe" }, waitingForDebugger: true } });
    await until(() => chrome.state.received.some((item) => item.method === "Target.detachFromTarget" && item.params?.sessionId === "CHILD-1"));
    await settle();
    expect(chrome.state.received.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "CHILD-1")).toBe(true);
    expect(engine.inbox).toHaveLength(0); expect(guard.inbox).toHaveLength(0);
  });
  it("counts the bot's tabs that close, for the page check", async () => {
    const { proxy, ask, fromChrome, settle } = await ready();
    await ask("Target.createTarget", { url: "about:blank" });
    expect(proxy.botScope().closed).toBe(0);
    fromChrome({ method: "Target.targetDestroyed", params: { targetId: "OWNER1" } });
    fromChrome({ method: "Target.targetDestroyed", params: { targetId: "BOT1" } });
    await settle();
    expect(proxy.botScope()).toEqual({ targets: new Set(), closed: 1 });
  });
  it("a paused owner's target held while the bot opens a tab is still resumed when that open fails or the engine leaves", async () => {
    const { chrome, engine, fromChrome } = await ready();
    // Chrome never answers this createTarget before the engine goes.
    chrome.state.socket!.removeAllListeners("message");
    engine.send({ id: 1, method: "Target.createTarget", params: { url: "about:blank" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    fromChrome({ method: "Target.attachedToTarget", params: { sessionId: "AUTO-OWNER5", targetInfo: { targetId: "OWNER5", type: "page" }, waitingForDebugger: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resumed: Sent[] = []; chrome.state.socket!.on("message", (raw) => resumed.push(JSON.parse(raw.toString())));
    engine.socket.close();
    await until(() => resumed.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "AUTO-OWNER5"));
    await until(() => resumed.some((item) => item.method === "Target.detachFromTarget" && item.params?.sessionId === "AUTO-OWNER5"));
  });
  it("an owner's tab created while the bot opens its own still stays the owner's", async () => {
    const { chrome, engine, ask, settle } = await ready();
    // The owner opens a tab while Chrome is still answering the bot's createTarget.
    chrome.state.duringCreate.push({ method: "Target.targetCreated", params: { targetInfo: { targetId: "OWNER4", type: "page" } } }, { method: "Target.attachedToTarget", params: { sessionId: "AUTO-OWNER4", targetInfo: { targetId: "OWNER4", type: "page" }, waitingForDebugger: true } });
    await ask("Target.createTarget", { url: "about:blank" });
    await settle();
    expect(engine.inbox.some((item) => JSON.stringify(item).includes("OWNER4"))).toBe(false);
    expect(engine.inbox.some((item) => JSON.stringify(item).includes("BOT1"))).toBe(true);
    // Held, then resumed and let go, never left waiting on a debugger.
    expect(chrome.state.received.some((item) => item.method === "Runtime.runIfWaitingForDebugger" && item.sessionId === "AUTO-OWNER4")).toBe(true);
  });
  it("a popup the bot's page opened is the bot's; one an owner's tab opened is not", async () => {
    const { proxy, engine, ask, fromChrome, settle } = await ready();
    await ask("Target.createTarget", { url: "about:blank" });
    fromChrome({ method: "Target.targetCreated", params: { targetInfo: { targetId: "POP1", type: "page", openerId: "BOT1" } } });
    fromChrome({ method: "Target.targetCreated", params: { targetInfo: { targetId: "POP2", type: "page", openerId: "OWNER1" } } });
    await settle();
    expect([...proxy.botTargets()].sort()).toEqual(["BOT1", "POP1"]);
    expect(engine.inbox.some((item) => JSON.stringify(item).includes("POP2"))).toBe(false);
    // Closed, it leaves the set.
    fromChrome({ method: "Target.targetDestroyed", params: { targetId: "POP1" } });
    await settle();
    expect([...proxy.botTargets()]).toEqual(["BOT1"]);
  });
  it("keeps the bot's tabs across an engine restart, and forgets them when Chrome's connection closes", async () => {
    const { chrome, proxy, engine, ask } = await ready();
    await ask("Target.createTarget", { url: "about:blank" });
    engine.socket.close();
    await until(() => chrome.state.received.some((item) => item.method === "Target.setAutoAttach"));
    const again = client(proxy.engineUrl); await again.opened;
    again.send({ id: 1, method: "Target.attachToTarget", params: { targetId: "BOT1", flatten: true } });
    await until(() => again.inbox.some((item) => item.id === 1));
    expect((again.inbox.find((item) => item.id === 1) as { result?: { sessionId?: string } }).result?.sessionId).toBeTruthy();
    chrome.state.socket!.close();
    await until(() => proxy.state === "idle");
    expect(proxy.botTargets().size).toBe(0);
  });
  it("leaves the page check's own traffic unfiltered", async () => {
    const { guard } = await ready();
    guard.send({ id: 1, method: "Target.getTargets" });
    guard.send({ id: 2, method: "Target.attachToTarget", params: { targetId: "OWNER1", flatten: true } });
    await until(() => guard.inbox.some((item) => item.id === 1) && guard.inbox.some((item) => item.id === 2));
    expect((guard.inbox.find((item) => item.id === 1) as { result: { targetInfos: unknown[] } }).result.targetInfos).toHaveLength(3);
    expect((guard.inbox.find((item) => item.id === 2) as { result?: { sessionId?: string } }).result?.sessionId).toBeTruthy();
  });
});
