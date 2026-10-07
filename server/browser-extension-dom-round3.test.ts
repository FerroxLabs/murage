// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { inspectClosedRoots } from "./browser-extension-dom-inspection.ts";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";
// @ts-ignore shared in-memory Chrome transport fixture
import { fixture as runtimeFixture } from "../scripts/browser-extension-test-fixture.mjs";

// Model native descriptors separately from page properties, including named form controls.
const children = new WeakMap<object, NativeNode[]>();
const lists = new WeakMap<object, NativeNode[]>();
class NativeList {
  constructor(nodes: NativeNode[]) { lists.set(this, nodes); }
  get length() { return lists.get(this)!.length; }
  item(i: number) { return lists.get(this)![i] ?? null; }
}
let id = 0;
class NativeNode {
  backendNodeId = ++id;
  constructor(public nodeName = "DIV", kids: NativeNode[] = [], public closed = false) { children.set(this, kids); }
  get childNodes() { return new NativeList(children.get(this)!); }
  get children() { return children.get(this)!; }
}
class OverrideNode extends NativeNode {
  override get children() { return []; }
  override get childNodes() { return new NativeList([]); }
  get firstChild() { return null; }
  get length() { return 0; }
}
const DOC: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "main-frame", navigationEpoch: 2, origin: "https://fixture.test", url: "https://fixture.test/" };

async function fixture(shadow: string, count = 12000, closed = true, corrupt = "", failLooks = 0) {
  const control = new NativeNode("INPUT");
  const kids = [control, new NativeNode("DIV", [], closed), ...Array.from({ length: count }, () => new NativeNode("SPAN"))];
  const root = shadow === "custom" ? new OverrideNode("X-WIDGET", kids) : new NativeNode("FORM", kids);
  if (shadow !== "custom") Object.defineProperty(root, shadow, { value: control });
  const nodes = new Map([root, ...kids].map(n => [n.backendNodeId, n]));
  const objects = new Map<string, any>();
  let serial = 0, oversized = 0;
  const hold = (value: any) => { const objectId = `object-${++serial}`; objects.set(objectId, value); return { objectId }; };
  const cdp = (n: NativeNode, depth: number): any => ({ nodeType: 1, backendNodeId: n.backendNodeId, nodeName: n.nodeName, localName: n.nodeName.toLowerCase(),
    attributes: n.nodeName === "SPAN" ? ["data-murage-presence", ""] : [], childNodeCount: children.get(n)!.length,
    ...(depth > 0 ? { children: children.get(n)!.map(c => cdp(c, depth - 1)) } : {}),
    ...(n.closed ? { shadowRoots: [{ nodeType: 11, backendNodeId: ++id, shadowRootType: "closed", childNodeCount: 0 }] } : {}) });
  const runtime = runtimeFixture(); await runtime.init(); await runtime.navigate();
  runtime.api.debugger.sendCommand.mockImplementation(async (_s: unknown, method: string, params: any) => {
    if (method !== "DOM.getDocument" && method !== "DOM.describeNode") return runtime.sendCommand(_s, method, params);
    const n = method === "DOM.getDocument" ? root : params.objectId ? objects.get(params.objectId) : nodes.get(params.backendNodeId);
    const value = cdp(n, params.depth);
    return method === "DOM.getDocument" ? { root: value } : { node: value };
  });
  let looks = 0;
  const send = async (method: string, params: any = {}): Promise<any> => {
    // A page mid-change: the first `failLooks` looks at the browser's tree lose their execution context.
    if (method === "DOM.getDocument" && looks++ < failLooks) throw Error("Execution context was destroyed.");
    if (method === "DOM.getDocument" || method === "DOM.describeNode") {
      const result = await runtime.command("cdp", { method, params, tabId: 1, navigationEpoch: 2 });
      if (result.error) { if (result.error.code === "response_too_large") oversized++; throw Object.assign(Error(result.error.message), { code: result.error.code }); }
      return result.result.result;
    }
    if (method === "DOM.resolveNode") return { object: hold(nodes.get(params.backendNodeId)) };
    if (method === "Runtime.callFunctionOn") {
      const fn = new Function("Node", "NodeList", `return (${params.functionDeclaration});`)(NativeNode, NativeList);
      const value = fn.apply(objects.get(params.objectId), (params.arguments ?? []).map((a: any) => a.value));
      if (Array.isArray(value)) {
        if (corrupt === "slice") return { result: { value: null } };
        if (corrupt === "empty") value.length = 0;
        if (corrupt === "missing") delete value[0];
        if (corrupt === "total") delete (value as any).total;
        if (corrupt === "shorttotal") (value as any).total--;
        if (corrupt === "changed" && params.arguments[0].value > 0) (value as any).total++;
      }
      return { result: hold(value) };
    }
    if (method === "Runtime.getProperties") return { result: Object.getOwnPropertyNames(objects.get(params.objectId)).map(name => {
      const value = objects.get(params.objectId)[name];
      return { name, value: typeof value === "object" && value !== null ? hold(value) : { value } };
    }) };
    if (method === "Runtime.releaseObject") objects.delete(params.objectId);
    if (method === "Runtime.releaseObjectGroup") objects.clear();
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: DOC.frameId } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
    if (method === "Runtime.evaluate") return { result: { value: false } };
    return {};
  };
  const handoffs: unknown[] = [];
  const executor = new BrowserExtensionExecutor({ authorize: () => true, access: async () => true, admit: async () => true,
    onFloor: info => { handoffs.push(info); }, transport: { document: async () => ({ ...DOC }), send } });
  return { send, executor, handoffs, objects, oversized: () => oversized, looks: () => looks };
}

describe("Round 3: native paging and fail-closed completeness", () => {
  it.each(["children", "childNodes", "firstChild", "length", "custom"])("review form with %s override hands back for its ordinary closed-root div", async shadow => {
    const f = await fixture(shadow);
    expect(await inspectClosedRoots(f.send, async () => 7, async () => undefined)).toBe(true);
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/YOUR TURN/);
    expect(f.handoffs).toHaveLength(1);
    expect(f.oversized()).toBeGreaterThan(0);
    expect(f.objects.size).toBe(0);
  });
  it.each(["children", "childNodes", "firstChild", "length", "custom"])("fully inspects an open page despite a %s override", async shadow => {
    const f = await fixture(shadow, 12000, false);
    expect(await inspectClosedRoots(f.send, async () => 7, async () => undefined)).toBe(false);
    expect(f.oversized()).toBeGreaterThan(0);
    expect(f.objects.size).toBe(0);
  });
  it.each(["slice", "empty", "missing", "total", "shorttotal", "changed"])("a %s slice fails inspection and hands back", async corrupt => {
    const f = await fixture("length", 12000, false, corrupt);
    await expect(inspectClosedRoots(f.send, async () => 7, async () => undefined)).rejects.toThrow();
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/YOUR TURN/);
    expect(f.handoffs).toHaveLength(1);
    expect(f.objects.size).toBe(0);
  });
  it.each([{}, [], { childNodeCount: null }, { childNodeCount: 2, children: {} }, { childNodeCount: 0, children: [{}] }, { childNodeCount: -1 }, { childNodeCount: "2" }])("rejects an unexpected CDP child shape: %j", async node => {
    await expect(inspectClosedRoots(async () => ({ root: node }), async () => 7, async () => undefined)).rejects.toThrow();
  });
  it("a page that fails one look while it settles is read normally, with no handoff", async () => {
    const f = await fixture("length", 50, false, "", 1);
    // Past the protection check the call reaches the engine, which this fixture does not connect: no handoff on the way.
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/engine adapter is not connected/);
    expect(f.handoffs).toHaveLength(0);
    expect(f.looks()).toBeGreaterThanOrEqual(2);
  });
  it("a page that fails both looks still goes to the owner", async () => {
    const f = await fixture("length", 50, false, "", 2);
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/YOUR TURN/);
    expect(f.handoffs).toHaveLength(1);
    expect(f.looks()).toBe(2);
  });
});
