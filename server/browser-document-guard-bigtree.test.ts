// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BRLOCK19: a long ordinary article (en.wikipedia.org/wiki/Hobart: 3.7 MB of pierced DOM JSON) was locked as "sensitive" because the guard's socket
// cap (2 MB) closed on the closed-shadow read. The cap is raised; password, code, card, frame and closed-root locks are unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { BrowserDocumentGuard, GUARD_MAX_PAYLOAD } from "./browser-document-guard.ts";

const servers: WebSocketServer[] = [];
const guards: BrowserDocumentGuard[] = [];
afterEach(() => { for (const g of guards.splice(0)) g.close(); for (const s of servers.splice(0)) s.close(); });

type Page = { fieldVerdict?: boolean; childFrames?: boolean; closedRoot?: boolean; nodes?: number };
/** A browser whose one page has `nodes` ordinary elements (about 380 bytes each as pierced DOM JSON), and the stated hazards. */
async function guardFor(page: Page) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      switch (m.method) {
        case "Target.getTargets": return reply({ targetInfos: [{ targetId: "t0", type: "page" }] });
        case "Target.attachToTarget": return reply({ sessionId: "s0" });
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "f1" }, ...(page.childFrames ? { childFrames: [{ frame: { id: "f2" } }] } : {}) } });
        case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
        case "Runtime.evaluate": return reply({ result: { type: "boolean", value: page.fieldVerdict === true } });
        case "DOM.getDocument": {
          const children = Array.from({ length: page.nodes ?? 0 }, (_, i) => ({ nodeId: i, backendNodeId: i, nodeType: 1, nodeName: "P", localName: "p", nodeValue: "", childNodeCount: 1, attributes: ["class", "mw-paragraph-" + "x".repeat(200)], children: [{ nodeId: i, nodeType: 3, nodeName: "#text", nodeValue: "ordinary article text" }] }));
          if (page.closedRoot) children.push({ nodeId: 9, backendNodeId: 9, nodeType: 1, nodeName: "X-HOST", localName: "x-host", nodeValue: "", childNodeCount: 0, attributes: [], children: [], shadowRoots: [{ nodeId: 10, nodeType: 11, nodeName: "#document-fragment", shadowRootType: "closed" }] } as never);
          return reply({ root: { nodeId: 1, nodeType: 9, nodeName: "#document", children } });
        }
        default: return reply({});
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  const guard = new BrowserDocumentGuard(async () => { throw new Error("unused"); }, { endpoint: `ws://127.0.0.1:${port}/devtools/browser/x` });
  guards.push(guard);
  return guard;
}

describe("a long ordinary page is not locked, and every real lock still holds", () => {
  it("the cap is finite and well above a long article", () => { expect(GUARD_MAX_PAYLOAD).toBeGreaterThan(8 * 1024 * 1024); expect(GUARD_MAX_PAYLOAD).toBeLessThanOrEqual(256 * 1024 * 1024); });
  it("a page whose pierced tree is over 3 MB (like Hobart on Wikipedia) is NOT locked", async () => {
    const guard = await guardFor({ nodes: 9700 });
    expect(await guard.protected()).toBe(false);
    expect(await guard.protected(false)).toBe(false);
  });
  it("a password, one-time-code or card field (the page's own verdict) still locks a long page", async () => {
    expect(await (await guardFor({ nodes: 9700, fieldVerdict: true })).protected()).toBe(true);
  });
  it("a real embedded frame still locks a long page", async () => {
    expect(await (await guardFor({ nodes: 9700, childFrames: true })).protected()).toBe(true);
  });
  it("a closed shadow root deep in a long page still locks it", async () => {
    expect(await (await guardFor({ nodes: 9700, closedRoot: true })).protected()).toBe(true);
  });
  it("a tree past the cap still fails closed (locked), never read as clean", async () => {
    const guard = await guardFor({ nodes: 200000 });
    expect(await guard.protected()).toBe(true);
  }, 60000);
});
