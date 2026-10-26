// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.7 Use my Chrome: the page check looks at the bot's own tabs only, so an
// owner with any number of tabs open can still use their Chrome.
import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";

const servers: WebSocketServer[] = [];
const guards: BrowserDocumentGuard[] = [];
afterEach(() => { for (const g of guards.splice(0)) g.close(); for (const s of servers.splice(0)) s.close(); });

async function fakeBrowser(pages: number, privateTargets: string[] = []) {
  const attached: string[] = [];
  const sessions = new Map<string, string>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      switch (m.method) {
        case "Target.getTargets": return reply({ targetInfos: Array.from({ length: pages }, (_, n) => ({ targetId: `t${n}`, type: "page" })) });
        case "Target.attachToTarget": { attached.push(m.params.targetId); const sessionId = `s-${m.params.targetId}`; sessions.set(sessionId, m.params.targetId); return reply({ sessionId }); }
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "f1" } } });
        case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
        // The page's own verdict: a private field only in the listed targets.
        case "Runtime.evaluate": return reply({ result: { type: "boolean", value: privateTargets.includes(sessions.get(m.sessionId) ?? "") } });
        case "DOM.getDocument": return reply({ root: { children: [] } });
        default: return reply({});
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { endpoint: `ws://127.0.0.1:${port}/devtools/browser/x`, attached };
}
type Scope = () => { targets: ReadonlySet<string>; closed: number };
const tabs = (ids: string[], closed = 0): Scope => () => ({ targets: new Set(ids), closed });
const guardFor = (endpoint: string, scope?: Scope) => {
  const guard = new BrowserDocumentGuard(async () => { throw new Error("the engine is not asked"); }, { endpoint, ...(scope ? { scope } : {}) });
  guards.push(guard); return guard;
};

it("checks only the bot's tabs, with 25 of the owner's open", async () => {
  const browser = await fakeBrowser(27);
  const guard = guardFor(browser.endpoint, tabs(["t25", "t26"]));
  await expect(guard.protected()).resolves.toBe(false);
  expect(browser.attached.sort()).toEqual(["t25", "t26"]);
});

it("still finds a private field in the bot's tab, and never looks at the owner's", async () => {
  const browser = await fakeBrowser(25, ["t3", "t24"]);
  const guard = guardFor(browser.endpoint, tabs(["t24"]));
  await expect(guard.protected()).resolves.toBe(true);
  expect(browser.attached).toEqual(["t24"]);
});

it("no bot tab yet: nothing has been opened or read, so nothing is protected and nothing is attached", async () => {
  const browser = await fakeBrowser(30);
  const guard = guardFor(browser.endpoint, tabs([]));
  await expect(guard.protected()).resolves.toBe(false);
  expect(browser.attached).toEqual([]);
});

it("a bot tab that closed may hold what the step read: the check refuses once, then goes on", async () => {
  const browser = await fakeBrowser(3);
  let scope = { targets: new Set(["t1", "t2"]) as ReadonlySet<string>, closed: 0 };
  const guard = guardFor(browser.endpoint, () => scope);
  await expect(guard.protected()).resolves.toBe(false);
  // The step read t1, then t1 closed (window.close, or the owner closed it): even the last tab closing refuses.
  scope = { targets: new Set(), closed: 1 };
  await expect(guard.protected()).rejects.toThrow("Browser document inventory unavailable");
  await expect(guard.protected(false)).resolves.toBe(false);
  // A tab Chrome no longer lists, before its close is counted, refuses too.
  scope = { targets: new Set(["t2", "gone"]), closed: 1 };
  await expect(guard.protected()).rejects.toThrow("Browser document inventory unavailable");
});

it("more than 20 bot tabs still refuse", async () => {
  const many = await fakeBrowser(40);
  await expect(guardFor(many.endpoint, tabs(Array.from({ length: 21 }, (_, n) => `t${n}`))).protected()).rejects.toThrow("Browser document inventory unavailable");
});

it("a scope that cannot answer refuses", async () => {
  const browser = await fakeBrowser(2);
  await expect(guardFor(browser.endpoint, () => { throw new Error("no scope"); }).protected()).rejects.toThrow();
});

it("without a scope (Murage's own browser) every page is checked, as before", async () => {
  const browser = await fakeBrowser(3);
  await expect(guardFor(browser.endpoint).protected()).resolves.toBe(false);
  expect(browser.attached.sort()).toEqual(["t0", "t1", "t2"]);
  const many = await fakeBrowser(21);
  await expect(guardFor(many.endpoint).protected()).rejects.toThrow("Browser document inventory unavailable");
});
