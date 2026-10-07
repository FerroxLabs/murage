// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { inspectClosedRoots } from "./browser-extension-dom-inspection.ts";
// @ts-ignore -- shared in-memory runtime fixture has no declaration file
import { fixture as runtimeFixture } from "../scripts/browser-extension-test-fixture.mjs";

describe("Chrome proof: inspection transport carries structure, not page text", () => {
  it("keeps root and editable markers even when one node has oversized text and attributes", async () => {
    const f = runtimeFixture(); await f.init(); await f.navigate();
    const huge = "x".repeat(2 * 1024 * 1024);
    const root = { nodeType: 1, backendNodeId: 4, nodeName: "DIV", localName: "div", childNodeCount: 0, nodeValue: huge,
      attributes: ["title", huge, "role", huge + "textbox", "data-murage-presence", huge, "contenteditable", "true"],
      shadowRoots: [{ nodeType: 11, backendNodeId: 5, shadowRootType: "closed", childNodeCount: 0 }] };
    let sent: any;
    f.api.debugger.sendCommand.mockImplementation(async (source: any, method: string, params: any) => {
      if (method === "DOM.describeNode") {
        sent = params;
        return { node: root };
      }
      return f.sendCommand(source, method, params);
    });
    const response = await f.command("cdp", { method: "DOM.describeNode", params: { backendNodeId: 4, depth: 2, pierce: true, murageInspection: true }, tabId: 1, navigationEpoch: 2 });
    expect(response.error).toBeUndefined();
    expect(sent).not.toHaveProperty("murageInspection"); expect(sent.depth).toBeLessThanOrEqual(4);
    expect(JSON.stringify(response).length).toBeLessThan(4096);
    expect(response.result.result.node).toMatchObject({ backendNodeId: 4, attributes: expect.arrayContaining(["role", "textbox", "contenteditable", "true"]), shadowRoots: [{ shadowRootType: "closed" }] });
    const raw = await f.command("cdp", { method: "DOM.describeNode", params: { backendNodeId: 4, depth: 0 }, tabId: 1, navigationEpoch: 2 });
    expect(raw.error?.code).toBe("response_too_large");
  });
  it("omits completed plain branches but retains an ordinary closed-root host and an unfinished branch", async () => {
    const f = runtimeFixture(); await f.init(); await f.navigate();
    const plain = { nodeType: 1, nodeName: "TD", localName: "td", childNodeCount: 0 };
    const root = { nodeType: 9, backendNodeId: 1, childNodeCount: 5002, children: [
      ...Array.from({ length: 5000 }, (_, i) => ({ ...plain, backendNodeId: i + 10 })),
      { nodeType: 1, backendNodeId: 2, nodeName: "DIV", childNodeCount: 0, shadowRoots: [{ nodeType: 11, shadowRootType: "closed", backendNodeId: 3 }] },
      { nodeType: 1, backendNodeId: 4, childNodeCount: 20000 },
    ] };
    f.api.debugger.sendCommand.mockImplementation(async (source: any, method: string, params: any) => method === "DOM.getDocument" ? { root } : f.sendCommand(source, method, params));
    const response = await f.command("cdp", { method: "DOM.getDocument", params: { depth: 4, murageInspection: true }, tabId: 1, navigationEpoch: 2 });
    expect(response.error).toBeUndefined();
    expect(response.result.result.root.children.length).toBe(2);
    expect(response.result.result.root).toMatchObject({ childNodeCount: 2, children: [{ backendNodeId: 2, shadowRoots: [{ shadowRootType: "closed" }] }, { backendNodeId: 4, childNodeCount: 20000 }] });
    expect(JSON.stringify(response).length).toBeLessThan(4096);
  });
  it("still clamps an explicit deep AX request", async () => {
    const f = runtimeFixture(); await f.init(); await f.navigate();
    f.api.debugger.sendCommand.mockImplementation(async (source: any, method: string, params: any) => {
      if (method === "Accessibility.getFullAXTree") { expect(params.depth).toBe(48); return { nodes: [] }; }
      return f.sendCommand(source, method, params);
    });
    const response = await f.command("cdp", { method: "Accessibility.getFullAXTree", params: { depth: 9999 }, tabId: 1, navigationEpoch: 2 });
    expect(response.error).toBeUndefined();
  });
});


describe("bounded DOM inspection pieces", () => {
  it.each([false, true])("pages all 129 children and finds a closed root on the last one: %s", async closed => {
    const offsets: number[] = [], released: string[] = [];
    const send = async (method: string, params: any = {}): Promise<any> => {
      if (method === "DOM.getDocument" || method === "DOM.describeNode") {
        if (params.objectId) return { node: { nodeType: 1, backendNodeId: Number(params.objectId), childNodeCount: 0,
          ...(closed && params.objectId === "130" ? { shadowRoots: [{ shadowRootType: "closed", nodeType: 11 }] } : {}) } };
        if (params.depth > 0) throw Object.assign(Error("response_too_large"), { code: "response_too_large" });
        const node = { nodeType: 1, backendNodeId: 1, childNodeCount: 129 };
        return method === "DOM.getDocument" ? { root: node } : { node };
      }
      if (method === "DOM.resolveNode") return { object: { objectId: "parent" } };
      if (method === "Runtime.callFunctionOn") {
        if (!params.arguments) return { result: { objectId: "pager" } };
        const offset = params.arguments[0].value; offsets.push(offset);
        expect(params.arguments[1].value).toBe(64);
        return { result: { objectId: `page-${offset}` } };
      }
      if (method === "Runtime.getProperties") {
        const offset = Number(params.objectId.replace("page-", "")), count = Math.min(64, 129 - offset);
        return { result: [{ name: "total", value: { value: 129 } }, { name: "length", value: { value: count } }, ...Array.from({ length: count }, (_, i) => ({ name: String(i), value: { objectId: String(offset + i + 2) } }))] };
      }
      if (method === "Runtime.releaseObjectGroup") released.push(params.objectGroup);
      return {};
    };
    expect(await inspectClosedRoots(send, async () => 7, async () => undefined)).toBe(closed);
    expect(offsets).toEqual([0, 64, 128]); expect(released).toHaveLength(1);
  });
  it.each(["plain", "editable", "nested", "impostor"])("retains the overlay exception boundary: %s", async kind => {
    const host = { nodeType: 1, backendNodeId: 5, localName: "murage-presence", attributes: ["data-murage-presence", ""], shadowRoots: [
      { nodeType: 11, shadowRootType: "closed", children: kind === "editable" ? [{ nodeType: 1, nodeName: "INPUT" }] : kind === "nested" ? [{ nodeType: 1, shadowRoots: [{ nodeType: 11, shadowRootType: "closed" }] }] : [] },
    ] };
    expect(await inspectClosedRoots(async () => ({ root: host }), async () => 7, async () => kind === "impostor" ? 6 : 5)).toBe(kind !== "plain");
  });
  it("does not convert a failed inspection into a completed answer", async () => {
    await expect(inspectClosedRoots(async () => { throw Error("detached"); }, async () => 7, async () => undefined)).rejects.toThrow("detached");
  });
});
