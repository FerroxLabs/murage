// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BRLOCK19 / packet 0 (OOPIF lock): a cross-site iframe is an out-of-process frame. Page.getFrameTree on the page
// never lists it, so the page used to stay unlocked. The guard now asks Chrome for the page's child targets
// (Target.setAutoAttach, flatten) and locks when one exists, or when that question fails or times out.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";

const servers: WebSocketServer[] = [];
const guards: BrowserDocumentGuard[] = [];
afterEach(() => { for (const g of guards.splice(0)) g.close(); for (const s of servers.splice(0)) s.close(); });

type Mode = "none" | "oopif" | "hang" | "error";
let childFails = false;
async function fakeBrowser(options: { mode: Mode; passwordPage?: boolean; closedShadow?: boolean; attachDuringLook?: boolean; guardOptions?: { oopifTimeoutMs?: number } }) {
  let attachedDuringLook = false;
  const seen: Array<{ method: string; sessionId?: string }> = [];
  let peer: WebSocket | undefined;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      seen.push({ method: m.method, ...(m.sessionId ? { sessionId: m.sessionId } : {}) });
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      switch (m.method) {
        case "Target.getTargets": return reply({ targetInfos: [{ targetId: "t1", type: "page" }] });
        case "Target.attachToTarget": return reply({ sessionId: "s1" });
        case "Target.setAutoAttach":
          if (m.sessionId === "c1" && childFails) return socket.send(JSON.stringify({ id: m.id, sessionId: m.sessionId, error: { message: "nope" } }));
          if (options.mode === "hang") return;
          if (options.mode === "error") return socket.send(JSON.stringify({ id: m.id, sessionId: m.sessionId, error: { message: "nope" } }));
          if (options.mode === "oopif" && m.sessionId === "s1") socket.send(JSON.stringify({ method: "Target.attachedToTarget", sessionId: "s1", params: { sessionId: "c1", waitingForDebugger: false, targetInfo: { targetId: "i1", type: "iframe", url: "https://other.example/" } } }));
          return reply({});
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "f1" } } });
        case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
        case "Runtime.evaluate":
          if (options.attachDuringLook && !attachedDuringLook) { attachedDuringLook = true; socket.send(JSON.stringify({ method: "Target.attachedToTarget", sessionId: "s1", params: { sessionId: "c9", waitingForDebugger: false, targetInfo: { targetId: "i9", type: "iframe" } } })); }
          return reply({ result: { type: "boolean", value: options.passwordPage === true } });
        case "DOM.getDocument": return reply({ root: options.closedShadow ? { children: [{ shadowRoots: [{ shadowRootType: "closed" }] }] } : { children: [] } });
        default: return reply({});
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const guard = new BrowserDocumentGuard(async () => ({ cdpUrl: `ws://127.0.0.1:${port}/devtools/browser/x` }), options.guardOptions ?? {});
  guards.push(guard);
  const event = (method: string, params: unknown, sessionId = "s1") => peer!.send(JSON.stringify({ method, sessionId, params }));
  return { guard, seen, event };
}

describe("an out-of-process frame locks the page", () => {
  it("a page with a cross-site iframe target LOCKS", async () => {
    const { guard } = await fakeBrowser({ mode: "oopif" });
    expect(await guard.protected()).toBe(true);
  });
  it("an ordinary page with no iframe target stays unlocked (Hobart)", async () => {
    const { guard } = await fakeBrowser({ mode: "none" });
    expect(await guard.protected()).toBe(false);
  });
  it("an iframe that attaches while the page is being looked at LOCKS this look, not the next", async () => {
    const { guard } = await fakeBrowser({ mode: "none", attachDuringLook: true });
    expect(await guard.protected()).toBe(true);
  });
  it("a password page still locks", async () => {
    const { guard } = await fakeBrowser({ mode: "none", passwordPage: true });
    expect(await guard.protected()).toBe(true);
  });
  it("a closed shadow root still locks", async () => {
    const { guard } = await fakeBrowser({ mode: "none", closedShadow: true });
    expect(await guard.protected()).toBe(true);
  });
  it("a detection timeout LOCKS", async () => {
    const { guard } = await fakeBrowser({ mode: "hang", guardOptions: { oopifTimeoutMs: 60 } });
    expect(await guard.protected()).toBe(true);
  });
  it("a detection error LOCKS", async () => {
    const { guard } = await fakeBrowser({ mode: "error" });
    expect(await guard.protected()).toBe(true);
  });
  it("an iframe that appears after the first look locks the next one, and leaving unlocks it", async () => {
    const { guard, event } = await fakeBrowser({ mode: "none" });
    expect(await guard.protected()).toBe(false);
    event("Target.attachedToTarget", { sessionId: "c1", waitingForDebugger: false, targetInfo: { targetId: "i1", type: "iframe" } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await guard.protected()).toBe(true);
    event("Target.detachedFromTarget", { sessionId: "c1" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await guard.protected()).toBe(false);
  });
  it("a frame inside the frame is looked for too: auto-attach is turned on in the child session", async () => {
    const { guard, seen } = await fakeBrowser({ mode: "oopif" });
    await guard.protected();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(seen.some((s) => s.method === "Target.setAutoAttach" && s.sessionId === "c1")).toBe(true);
  });
  it("a worker target is not a frame", async () => {
    const { guard, event } = await fakeBrowser({ mode: "none" });
    await guard.protected();
    event("Target.attachedToTarget", { sessionId: "w1", waitingForDebugger: false, targetInfo: { targetId: "w1", type: "worker" } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await guard.protected()).toBe(false);
  });
  it("doubt is not sticky: a frame whose own look failed locks, and the next clean look after it leaves unlocks", async () => {
    childFails = true;
    try {
      const { guard, event } = await fakeBrowser({ mode: "none" });
      expect(await guard.protected()).toBe(false);
      event("Target.attachedToTarget", { sessionId: "c1", waitingForDebugger: false, targetInfo: { targetId: "i1", type: "iframe" } });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await guard.protected()).toBe(true);
      event("Target.detachedFromTarget", { sessionId: "c1" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(await guard.protected()).toBe(false);
      expect(await guard.protected()).toBe(false);
    } finally { childFails = false; }
  });
});
