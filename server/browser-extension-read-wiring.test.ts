// SPDX-License-Identifier: AGPL-3.0-or-later
// T03 wiring of the T40 read layer into the executor.
import { describe, expect, it, vi } from "vitest";
import { BrowserExtensionExecutor, type ExtensionDocument } from "./browser-extension-executor.ts";
import { ReadLayerError } from "./browser-extension-snapshot.ts";

const reads: { fenceOrigin?: string }[] = [];
vi.mock("./browser-extension-engine-read.ts", () => ({ readWithBrowserAuthority: async (_o: unknown, context: { fenceOrigin?: string }) => { reads.push({ fenceOrigin: context.fenceOrigin }); return { content: [{ type: "text", text: "read" }] }; } }));

const doc: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
function fixture(opts: { owns?: boolean; layer?: Record<string, unknown>; hit?: boolean } = {}) {
  const sent: string[] = [];
  const layerCalls: string[] = [];
  let made = 0;
  const layer = {
    snapshot: async () => { layerCalls.push("snapshot"); return { text: "- button \"Save\" [ref=e1]" }; },
    fenced: (s: { text: string }) => `FENCED(${s.text})`,
    resolve: async (ref: string) => { layerCalls.push(`resolve:${ref}`); return { backendNodeId: 12, recovered: false }; },
    diffSince: async () => { layerCalls.push("diff"); return "Changed: a dialog opened."; },
    explainCover: async (_id: number, role: string) => `A cookie banner covers this ${role}.`,
    ...opts.layer,
  };
  const engineCalls: { name: string; args: Record<string, unknown> }[] = [];
  const executor = new BrowserExtensionExecutor({
    authorize: () => true, access: async () => true, admit: async () => true,
    collectFacts: async (_io, _t, operation) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never,
    createEngine: hooks => ({
      actsOnNodes: opts.owns === true,
      readLayer: () => { made++; return layer; },
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...doc } }), resolveTab: async () => ({ ...doc }), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        engineCalls.push({ name, args });
        if (name === "agent_browser_click") { await hooks.beforeCommand({ ...doc }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }); }
        return { content: [{ type: "text", text: "engine" }] };
      },
    } as never),
    transport: {
      document: async () => ({ ...doc }),
      send: async (method, params) => {
        sent.push(method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L1" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === "Runtime.evaluate") return String(params.expression).includes("__murageGuard()") ? { result: { value: false } } : params.returnByValue === false ? { result: { objectId: "node" } } : { result: { value: "x" } };
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? (opts.hit ?? true) : JSON.stringify({ display: { tag: "BUTTON", role: "button", text: "Save", label: "Save" }, bound: null }) } };
        return {};
      },
    },
  });
  return { executor, layerCalls, engineCalls, made: () => made };
}
const text = (output: unknown) => ((output as { content: { text: string }[] }).content).map(item => item.text).join("\n");

describe("T03: read layer wiring", () => {
  it("passes fenceOrigin to the read", async () => {
    reads.length = 0; const f = fixture();
    await f.executor.call("agent_browser_read", {});
    expect(reads).toEqual([{ fenceOrigin: "https://example.test" }]);
  });
  it("keeps one layer per tab", async () => {
    const f = fixture({ owns: true });
    await f.executor.call("agent_browser_snapshot", {}); await f.executor.call("agent_browser_snapshot", {});
    expect(f.made()).toBe(1);
  });
  it("snapshot returns the fenced layer snapshot when the layer owns refs", async () => {
    const f = fixture({ owns: true });
    expect(text(await f.executor.call("agent_browser_snapshot", {}))).toBe("FENCED(- button \"Save\" [ref=e1])");
    expect(f.engineCalls.some(call => call.name === "agent_browser_snapshot")).toBe(false);
  });
  it("an @ref goes through layer.resolve and the engine is told the node", async () => {
    const f = fixture({ owns: true });
    await f.executor.call("agent_browser_click", { selector: "@e1" });
    expect(f.layerCalls).toContain("resolve:@e1");
    expect(f.engineCalls.find(call => call.name === "agent_browser_click")!.args.selector).toBe("node:12");
  });
  it("a dead ref becomes a plain sentence", async () => {
    for (const code of ["unknown_ref", "expired_ref", "gone_ref"] as const) {
      const f = fixture({ owns: true, layer: { resolve: async () => { throw new ReadLayerError(code, `plain ${code}`); } } });
      await expect(f.executor.call("agent_browser_click", { selector: "@e9" })).rejects.toThrow(`plain ${code}`);
      expect(f.engineCalls).toHaveLength(0);
    }
  });
  it("appends the diff after an L2 action, and not after a read", async () => {
    const f = fixture({ owns: true });
    expect(text(await f.executor.call("agent_browser_click", { selector: "@e1" }))).toContain("Changed: a dialog opened.");
    const g = fixture({ owns: true });
    expect(text(await g.executor.call("agent_browser_snapshot", {}))).not.toContain("Changed:");
  });
  it("names the covering element when the hit test fails", async () => {
    const f = fixture({ owns: false, hit: false });
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow("A cookie banner covers this button.");
  });
  it("without engine support for node ids, the engine keeps its own refs and snapshot", async () => {
    const f = fixture({ owns: false });
    await f.executor.call("agent_browser_snapshot", {});
    expect(f.engineCalls.some(call => call.name === "agent_browser_snapshot")).toBe(true);
    expect(f.layerCalls).not.toContain("snapshot");
  });
});
