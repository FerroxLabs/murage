// SPDX-License-Identifier: AGPL-3.0-or-later
// Regression cases authored before the Chrome proof fixes. No browser or engine process.
import { describe, expect, it } from "vitest";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";

const DOC: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" };
function fixture(options: { closed?: boolean; broken?: boolean; paged?: boolean } = {}) {
  const depths: number[] = [], commands: string[] = [];
  const handoffs: unknown[] = [];
  const node = (id: number): any => ({ backendNodeId: id, nodeType: 1, nodeName: "DIV", localName: "div", childNodeCount: id < 6 ? 1 : 0,
    ...(options.closed && id === 6 ? { shadowRoots: [{ nodeType: 11, shadowRootType: "closed" }] } : {}) });
  const executor = new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async () => true,
    onFloor: info => { handoffs.push(info); },
    transport: {
      document: async () => ({ ...DOC }),
      async send(method, params) {
        commands.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate") return { result: { value: String(params.expression).includes("__murageGuard()") ? false : null } };
        if (method === "DOM.getDocument" || method === "DOM.describeNode") {
          const depth = Number(params.depth); depths.push(depth);
          if (depth === -1 || (options.paged && depth > 0)) throw Object.assign(Error("response_too_large"), { code: "response_too_large" });
          const id = method === "DOM.getDocument" ? 1 : Number(params.backendNodeId ?? String(params.objectId).replace("node-", ""));
          if (options.broken && id > 1) throw Error("detached during inspection");
          const value = node(id);
          if (depth > 0 && id < 6) value.children = [node(id + 1)];
          return method === "DOM.getDocument" ? { root: value } : { node: value };
        }
        if (method === "DOM.resolveNode") return { object: { objectId: `node-${params.backendNodeId}` } };
        if (method === "Runtime.callFunctionOn") return { result: { objectId: params.arguments ? `children-${String(params.objectId).replace("pager-", "")}` : `pager-${String(params.objectId).replace("node-", "")}` } };
        if (method === "Runtime.getProperties") {
          const id = Number(String(params.objectId).replace("children-", ""));
          return { result: [{ name: "total", value: { value: 1 } }, { name: "length", value: { value: 1 } }, { name: "0", value: { objectId: `node-${id + 1}` } }] };
        }
        return {};
      },
    },
  });
  return { executor, depths, commands, handoffs };
}

describe("Chrome proof: bounded closed-root inspection", () => {
  it("reads a large ordinary document in pieces instead of refusing its size", async () => {
    const f = fixture();
    expect(await f.executor.protectedDocument(DOC)).toBe(false);
    expect(f.depths).not.toContain(-1);
    expect(f.commands.filter(c => c === "DOM.describeNode").length).toBeGreaterThan(0);
  });
  it("pages the children of a branch wider than the response limit", async () => {
    const f = fixture({ paged: true });
    expect(await f.executor.protectedDocument(DOC)).toBe(false);
    expect(f.commands).toContain("Runtime.getProperties");
    expect(f.commands).toContain("Runtime.releaseObjectGroup");
  });
  it("hands back for an ordinary div with a closed root in a later piece", async () => {
    const f = fixture({ closed: true });
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/YOUR TURN/);
    expect(f.handoffs).toHaveLength(1);
    expect(f.depths.length).toBeGreaterThan(1);
  });
  it("hands back if inspection cannot finish", async () => {
    const f = fixture({ broken: true });
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/YOUR TURN/);
    expect(f.handoffs).toHaveLength(1);
  });
});
