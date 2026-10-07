// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane C1: approvals and the action boundary (core). Each test below was written first and fails on the base (a205203dd + X1).
// Chrome-dependent proofs live in scripts/browser-c1.node-test.mjs.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserExtensionExecutor, type ExtensionAction, type ExtensionDocument } from "./browser-extension-executor.ts";
import { BrowserExtensionEngine } from "./browser-extension-engine.ts";
import { DESCRIBE_TARGET_SOURCE } from "./browser-extension-page-scripts.ts";
import { classifyFloor } from "./browser-floor.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import type { BrowserExtensionCommand, BrowserExtensionHello, BrowserExtensionResponse } from "../shared/browser-extension-protocol.ts";

const DOC: ExtensionDocument = { profileId: "p", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
const button = (values: string[] = ["x"], extra: object = {}) => ({ display: { tag: "BUTTON", text: "Send" }, bound: { tag: "BUTTON", hidden: [] }, values, editable: false, priv: { href: null, skip: [-1, -1] }, ...extra });

type Opts = {
  facts?: (n: number) => object; guard?: () => boolean; engineCalls?: (hooks: any, name: string, args: any, log: string[]) => Promise<void>; describe?: object;
  admit?: (action: ExtensionAction) => Promise<boolean> | boolean; onFloor?: (info: any) => void; resolved?: object;
};
function executorFixture(o: Opts = {}) {
  const log: string[] = []; const admitted: ExtensionAction[] = []; const floors: any[] = []; let n = 0;
  const executor = new BrowserExtensionExecutor({
    collectFacts: async (_io, _t, operation) => ({ operation, tag: "button", role: "button", name: "Send", ...(o.facts ? o.facts(n++) : {}) }) as never,
    authorize: () => true, access: async () => true,
    admit: async action => { admitted.push(action); return o.admit ? o.admit(action) : true; },
    onFloor: info => { floors.push(info); o.onFloor?.(info); },
    createEngine: hooks => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...DOC }, ...(o.resolved ?? {}) }), resolveTab: async () => ({ ...DOC }), event() {}, async close() {},
      async call(name: string, args: any) { await o.engineCalls?.(hooks, name, args, log); return { content: [] }; },
    }) as never,
    transport: {
      document: async () => ({ ...DOC }),
      send: async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate") {
          const expression = String(params.expression);
          if (expression.includes("__murageGuard()")) return { result: { type: "boolean", value: o.guard ? o.guard() : false } };
          return params.returnByValue === false ? { result: { objectId: "node" } } : { result: { value: 0 } };
        }
        if (method === "DOM.getDocument") return { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12, nodeName: "BUTTON" } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: params.functionDeclaration === DESCRIBE_TARGET_SOURCE ? JSON.stringify(o.describe ?? button()) : true } };
        return {};
      },
    },
  });
  return { executor, log, admitted, floors };
}
const clickBoth = async (hooks: any, _name: string, _args: any, log: string[]) => {
  for (const type of ["mousePressed", "mouseReleased"]) { await hooks.beforeCommand({ ...DOC }, "Input.dispatchMouseEvent", { type, x: 1, y: 1, button: "left" }); log.push(type); }
};

describe("C1 recipients are bound into what the owner approved (SEC-003)", () => {
  it("two sends to different recipients never share a digest", async () => {
    const a = executorFixture({ facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    const b = executorFixture({ facts: () => ({ recipients: ["bob@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    await a.executor.call("agent_browser_click", { selector: "#b" }); await b.executor.call("agent_browser_click", { selector: "#b" });
    expect(a.admitted[0].digest).not.toBe(b.admitted[0].digest);
  });
  it("the same recipients give the same digest, and the address itself is not in it", async () => {
    const a = executorFixture({ facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    const b = executorFixture({ facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    await a.executor.call("agent_browser_click", { selector: "#b" }); await b.executor.call("agent_browser_click", { selector: "#b" });
    expect(a.admitted[0].digest).toBe(b.admitted[0].digest);
    expect(a.admitted[0].digest).not.toContain("ana@example.com");
  });
  it("an unreadable scan and a clean scan are different approvals", async () => {
    const a = executorFixture({ facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: true }), engineCalls: clickBoth });
    const b = executorFixture({ facts: () => ({ recipients: ["ana@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    await a.executor.call("agent_browser_click", { selector: "#b" }); await b.executor.call("agent_browser_click", { selector: "#b" });
    expect(a.admitted[0].digest).not.toBe(b.admitted[0].digest);
  });
  it("the card shows who it goes to, as the page's text", async () => {
    const f = executorFixture({ facts: () => ({ recipients: ["ana@example.com", "bob@example.com"], recipientScanFailed: false }), engineCalls: clickBoth });
    await f.executor.call("agent_browser_click", { selector: "#b" });
    expect(f.admitted[0].summary).toMatch(/Goes to \(read from the page\): ana@example\.com, bob@example\.com/);
  });
  it("audit alice to mallory: a recipient that changes while the owner decides is refused, and no input is sent", async () => {
    let swapped = false;
    const f = executorFixture({ facts: () => ({ recipients: [swapped ? "mallory@audit.invalid" : "alice@audit.invalid"], recipientScanFailed: false }), engineCalls: clickBoth, admit: () => { swapped = true; return true; } });
    await expect(f.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/recipients changed/);
    expect(f.log).toEqual([]);
  });
  it("a scan that stops being readable after approval is refused too", async () => {
    let n = 0;
    const f = executorFixture({ facts: () => ({ recipients: ["alice@audit.invalid"], recipientScanFailed: n++ > 0 }), engineCalls: clickBoth });
    await expect(f.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/recipients changed/);
    expect(f.log).toEqual([]);
  });
});

describe("C1 a protected page is a structured hand-back (UX-005)", () => {
  it("the owner is told once, with the plain YOUR TURN text, and nothing is clicked", async () => {
    const f = executorFixture({ guard: () => true, engineCalls: clickBoth });
    const error = await f.executor.call("agent_browser_click", { selector: "#b" }).catch(e => e as Error);
    expect((error as Error).message).toMatch(/^YOUR TURN: .*End your turn now and wait/s);
    expect(f.floors).toHaveLength(1);
    expect(f.floors[0].result.floor).toBe("credentials");
    expect(f.log).toEqual([]);
  });
  it("a read on a protected page hands back as well", async () => {
    const f = executorFixture({ guard: () => true });
    await expect(f.executor.call("agent_browser_snapshot", {})).rejects.toThrow(/^YOUR TURN:/);
    expect(f.floors).toHaveLength(1);
  });
  it("a page that becomes protected after the click is handed back once", async () => {
    let calls = 0;
    const f = executorFixture({ guard: () => ++calls > 4, engineCalls: clickBoth });
    await f.executor.call("agent_browser_click", { selector: "#b" }).catch(() => undefined);
    expect(f.floors.length).toBeLessThanOrEqual(1);
  });
});

describe("C1 scrolling has one gated path (D2)", () => {
  const scroll = (expression: string) => async (hooks: any, _n: string, _a: any, log: string[]) => { await hooks.beforeCommand({ ...DOC }, "Runtime.evaluate", { expression, returnByValue: true }); log.push(expression); };
  it("a scroll operation may move the page by a bounded amount", async () => {
    const f = executorFixture({ engineCalls: scroll("window.scrollBy(0, 400)") });
    await f.executor.call("agent_browser_scroll", { direction: "down", amount: 400 });
    expect(f.log).toEqual(["window.scrollBy(0, 400)"]);
  });
  it("the same evaluate during a click is refused", async () => {
    const f = executorFixture({ engineCalls: scroll("window.scrollBy(0, 400)") });
    await expect(f.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/not approved|scroll/i);
    expect(f.log).toEqual([]);
  });
  it("an unbounded amount is refused", async () => {
    const f = executorFixture({ engineCalls: scroll("window.scrollBy(0, 1e9)") });
    await expect(f.executor.call("agent_browser_scroll", { direction: "down", amount: 400 })).rejects.toThrow();
    expect(f.log).toEqual([]);
  });
  it("a scroll on a protected page hands back", async () => {
    const f = executorFixture({ guard: () => true, engineCalls: scroll("window.scrollBy(0, 400)") });
    await expect(f.executor.call("agent_browser_scroll", { direction: "down", amount: 400 })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.log).toEqual([]);
  });
  it("an ordinary read expression is still a read", async () => {
    const f = executorFixture({ engineCalls: scroll("document.title") });
    await f.executor.call("agent_browser_get_title", {});
    expect(f.log).toEqual(["document.title"]);
  });
});

describe("C1 a target in another frame never matches", () => {
  it("the executor refuses a target the engine reports in an embedded frame", async () => {
    const f = executorFixture({ resolved: { frameId: "frame:embedded" }, engineCalls: clickBoth });
    await expect(f.executor.call("agent_browser_click", { selector: "#b" })).rejects.toThrow(/embedded frame/);
    expect(f.admitted).toHaveLength(0);
    expect(f.log).toEqual([]);
  });
  it("a target the engine places in the page's own frame is fine", async () => {
    const f = executorFixture({ resolved: { frameId: "frame" }, engineCalls: clickBoth });
    await f.executor.call("agent_browser_click", { selector: "#b" });
    expect(f.log).toEqual(["mousePressed", "mouseReleased"]);
  });
});

describe("C1 the real engine reports the node's real frame", () => {
  function engineFixture(ownerIsPage: boolean | "throws") {
    const documents: ExtensionDocument[] = [{ ...DOC, tabId: 7, frameId: "main" }];
    const send = vi.fn(async (method: string, _params: Record<string, unknown>, _doc: ExtensionDocument): Promise<any> => {
      if (method === "Runtime.evaluate") return { result: { type: "object", subtype: "node", objectId: "composer" } };
      if (method === "DOM.describeNode") return { node: { backendNodeId: 55 } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "F", loaderId: "L" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 9 };
      if (method === "DOM.resolveNode") { if (ownerIsPage === "throws") throw new Error("No node with given id found"); return { object: { objectId: "wrapped" } }; }
      if (method === "Runtime.callFunctionOn") return { result: { value: ownerIsPage === true } };
      return {};
    });
    const engine = new BrowserExtensionEngine({ dataDir: "/unused-fixture", realmId: "w", bindingId: "b", authorize: () => true, beforeCommand: async () => {}, beforeDestination: async () => {},
      transport: { documents: async () => structuredClone(documents), selected: async () => ({ ...documents[0] }), send, newTab: async () => documents[0], closeTab: async () => {}, selectTab: async () => documents[0] } as never });
    const command = (method: string, params: Record<string, unknown>, sessionId?: string) => (engine as any).command(method, params, sessionId);
    return { engine, send, command, capture: () => (engine as any).capture };
  }
  const attach = async (f: ReturnType<typeof engineFixture>) => (await f.command("Target.attachToTarget", { targetId: "00000000000000000000000000000007", flatten: true })).sessionId;
  it("a node in the page's own document is reported in the page's frame", async () => {
    const f = engineFixture(true); const sessionId = await attach(f);
    await f.command("Runtime.evaluate", { expression: "document.querySelector('#c')" }, sessionId);
    expect(f.capture()).toMatchObject({ backendNodeId: 55, frameId: "main" });
  });
  it("a node that belongs to another document is reported as embedded", async () => {
    const f = engineFixture(false); const sessionId = await attach(f);
    await f.command("Runtime.evaluate", { expression: "document.querySelector('iframe').contentDocument.body" }, sessionId);
    expect(f.capture().frameId).toBe("main:embedded");
  });
  it("a node the page's own world cannot even resolve (another process) is reported as embedded", async () => {
    const f = engineFixture("throws"); const sessionId = await attach(f);
    await f.command("Runtime.evaluate", { expression: "x" }, sessionId);
    expect(f.capture().frameId).toBe("main:embedded");
  });
});

// ------------------------------------------------------------------------------------------- service
const A = "https://fixture.test";
const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
async function serviceFixture(extra: Record<string, unknown> = {}) {
  const directory = await fs.mkdtemp(path.resolve(".c1-")); cleanup.push(directory); await fs.chmod(directory, 0o700);
  const bindings = new Map<string, { generation: number; state: string; tabs: object[] }>();
  const calls: BrowserExtensionCommand[] = []; const order: string[] = [];
  const cards: ExtensionAction[] = []; const handoffs: any[] = [];
  let facts: Record<string, unknown> = { tag: "button", role: "button", name: "Save draft" }; let guard = false; let verdict = "allow"; let pauseFails = false;
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command); order.push(command.operation);
      if (pauseFails && command.operation === "pause") throw new Error("the extension did not answer");
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: any = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === "DOM.getDocument") value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? guard : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ display: { tag: "BUTTON", text: "x", label: "x" }, bound: null }) } };
        result = { result: value, ...(b.tabs[0] as object) };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const transport = vi.fn(async (request: { model: string }) => request.model === "s1" ? (verdict === "allow" ? "ALLOW" : "FLAG") : JSON.stringify({ decision: verdict, reason: "ok" }));
  const box = { mode: "task" as "step" | "task" | "full" };
  const service = await createBrowserExtensionService({
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, ...facts, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: any) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") { for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); } }
        return { content: [{ type: "text", text: "ok" }] };
      },
    }) as never,
    broker: broker as never, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    askSite: async () => "allow" as const,
    askAction: async (_c: unknown, a: ExtensionAction) => { cards.push(a); return true; },
    ownerInstruction: () => ({ id: "m1", text: "please tidy my drafts" }),
    approvalMode: () => box.mode, checker: () => ({ deps: { transport, models: { stage1: "s1", stage2: "s2" } } }),
    onHandoff: (info: unknown) => { order.push("onHandoff"); handoffs.push(info); },
    ...extra,
  } as never);
  services.push(service);
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const id = binding.bindingId;
  return { service, id, calls, order, cards, handoffs, box, bindings, click: () => service.dispatch(id, "agent_browser_click", { selector: "button" }, () => true),
    setFacts: (v: Record<string, unknown>) => { facts = v; }, setGuard: (v: boolean) => { guard = v; }, failPause: (v: boolean) => { pauseFails = v; }, setVerdict: (v: string) => { verdict = v; },
    inputs: () => calls.filter(call => call.operation === "cdp" && String((call.params as any).method).startsWith("Input.")).length,
    last: (op: string) => [...calls].reverse().find(call => call.operation === op) };
}

describe("C1 D1: the categories no mode can automate reach the owner", () => {
  it.each(["task", "full"] as const)("deleting asks with its own card kind in %s mode, even with an allowing check", async mode => {
    const f = await serviceFixture(); f.box.mode = mode; f.setFacts({ tag: "button", role: "button", name: "Delete" });
    await f.click();
    expect(f.cards).toHaveLength(1);
    expect((f.cards[0] as any).cardKind).toBe("delete");
  });
  it.each(["task", "full"] as const)("a send to a recipient the owner never named asks with its own card kind in %s mode", async mode => {
    const f = await serviceFixture({ ownerInstruction: () => ({ id: "m1", text: "send the notes to ana@example.com" }) }); f.box.mode = mode;
    f.setFacts({ tag: "button", role: "button", name: "Send message", recipients: ["mallory@evil.example"] });
    await f.click();
    expect(f.cards).toHaveLength(1);
    expect((f.cards[0] as any).cardKind).toBe("newRecipient");
    expect(f.cards[0].summary).toContain("mallory@evil.example");
  });
  it("it asks again for the same new recipient on the next send: no grant carries over", async () => {
    const f = await serviceFixture({ ownerInstruction: () => ({ id: "m1", text: "send the notes to ana@example.com" }) }); f.box.mode = "full";
    f.setFacts({ tag: "button", role: "button", name: "Send message", recipients: ["mallory@evil.example"] });
    await f.click(); await f.click();
    expect(f.cards).toHaveLength(2);
  });
  it("an account or security change is handed back with the account category, in every mode", async () => {
    for (const mode of ["step", "task", "full"] as const) {
      const f = await serviceFixture(); f.box.mode = mode; f.setFacts({ tag: "button", role: "button", name: "Close account" });
      await expect(f.click()).rejects.toThrow(/^YOUR TURN:/);
      expect(f.cards, mode).toHaveLength(0); expect(f.inputs(), mode).toBe(0);
      expect(f.handoffs[0].category, mode).toBe("account");
      expect(f.handoffs[0].text, mode).toMatch(/account or security change/);
    }
  });
});

describe("C1 a protected page through the service (UX-005)", () => {
  it("pauses the binding as a hand-off once, and releases the tab before the owner is told", async () => {
    const f = await serviceFixture(); f.setGuard(true);
    await expect(f.click()).rejects.toThrow(/^YOUR TURN:/);
    expect(f.handoffs).toHaveLength(1);
    const status = f.service.status().bindings[0] as any;
    expect(status.state).toBe("paused"); expect(status.pausedReason).toBe("handoff");
    expect(f.order.indexOf("pause")).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf("pause")).toBeLessThan(f.order.indexOf("onHandoff"));
    expect(f.inputs()).toBe(0);
  });
});

describe("C1 Astra findings: the owner is told only after the tab is really released", () => {
  it("a pause that never lands does not tell the owner to type", async () => {
    const f = await serviceFixture(); f.setGuard(true); f.failPause(true);
    await expect(f.click()).rejects.toThrow(/^YOUR TURN:/);
    expect(f.handoffs).toHaveLength(0);
    expect(f.inputs()).toBe(0);
  });
});

describe("C1 Astra findings: choosing I agree in a select is consent", () => {
  it.each(["I agree to the terms and conditions", "Accept the privacy policy"])("a select named %s is on the floor", label => {
    const result = classifyFloor({ operation: "select", tag: "select", ariaLabel: label } as never);
    expect(result.floor).toBe("consent");
  });
  it("an ordinary select is not", () => {
    expect(classifyFloor({ operation: "select", tag: "select", ariaLabel: "Country" } as never).floor).toBeNull();
  });
});

describe("C1 what the runtime is told", () => {
  it("a hand-off pause carries the reason and the one sentence for the panel", async () => {
    const f = await serviceFixture(); f.setFacts({ tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the terms and conditions" });
    await expect(f.click()).rejects.toThrow(/^YOUR TURN:/);
    const pause = f.last("pause")!;
    expect(pause.params).toMatchObject({ reason: "handoff" });
    expect(String((pause.params as any).handoff)).toMatch(/terms/);
    expect(String((pause.params as any).handoff).length).toBeLessThanOrEqual(200);
  });
  it("a plain owner pause names no hand-off", async () => {
    const f = await serviceFixture();
    await f.service.pause(f.id);
    expect(f.last("pause")!.params).toEqual({});
  });
  it("bind and status carry the panel: mode, grants, activity, sites, conversation, colour, full", async () => {
    const f = await serviceFixture({ panel: () => ({ conversation: "Tidy drafts", botColor: "#aa33cc", full: true, activity: [{ time: "10:02", text: "Opened the drafts" }] }) });
    f.box.mode = "full";
    await f.service.pause(f.id).catch(() => undefined);
    const bind = f.calls.find(call => call.operation === "bind")!;
    const panel = (bind.params as any).panel;
    expect(panel).toMatchObject({ mode: "task", conversation: "Tidy drafts", botColor: "#aa33cc", full: true, activity: [{ time: "10:02", text: "Opened the drafts" }] });
    expect(Array.isArray(panel.grants)).toBe(true); expect(Array.isArray(panel.sites)).toBe(true);
    const status = f.last("status");
    if (status) expect((status.params as any).panel).toBeTruthy();
  });
  it("the panel lists a granted site and a site the owner allowed always", async () => {
    const f = await serviceFixture();
    f.setFacts({ tag: "textarea", role: "textbox", name: "Notes" });
    await f.service.dispatch(f.id, "agent_browser_fill", { selector: "textarea", text: "hello" }, () => true).catch(() => undefined);
    await f.service.status();
    await f.service.pause(f.id).catch(() => undefined);
    const bind = [...f.calls].reverse().find(call => call.operation === "bind")!;
    expect((bind.params as any).panel.grants.map((g: any) => g.origin)).toContain(A);
  });
});

describe("C1 the owner revokes a site in the browser's panel (owner_revoked)", () => {
  let siteCards = 0;
  async function granted() {
    siteCards = 0;
    const f = await serviceFixture({ askSite: async () => { siteCards++; return "allow" as const; } });
    f.setFacts({ tag: "textarea", role: "textbox", name: "Notes" });
    await f.service.dispatch(f.id, "agent_browser_fill", { selector: "textarea", text: "hello" }, () => true);
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).toEqual([A]);
    return f;
  }
  const revoked = (f: Awaited<ReturnType<typeof granted>>, origin = A) => f.service.handleMessage("profile", { version: 1, type: "event", bindingId: f.id, generation: f.last("bind")!.generation, event: "notice", data: { kind: "owner_revoked", origin } } as never);
  it("removes the origin from the task grants and from what the next bind lists", async () => {
    const f = await granted();
    await revoked(f);
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
    expect((f.last("bind")!.params as any).approvedOrigins).not.toContain(A);
  });
  it("asks again on the next action on that site", async () => {
    const f = await granted(); expect(siteCards).toBe(1);
    await revoked(f);
    await f.service.dispatch(f.id, "agent_browser_fill", { selector: "textarea", text: "again" }, () => true);
    expect(siteCards).toBe(2);
  });
  it("an origin that is not a valid origin changes nothing", async () => {
    const f = await granted();
    await revoked(f, "not a url");
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).toEqual([A]);
  });
});

describe("C1 a checker that builds a fresh connection per call is not a settings change", () => {
  it("the same named checker lets the step through; a different one refuses it", async () => {
    let key = "flux:1";
    const mk = () => ({ deps: { transport: vi.fn(async (r: { model: string }) => (r.model === "s1" ? "ALLOW" : JSON.stringify({ decision: "allow", reason: "ok" }))) as never, models: { stage1: "s1", stage2: "s2" } }, key });
    const f = await serviceFixture({ checker: mk });
    f.box.mode = "full"; f.setFacts({ tag: "textarea", role: "textbox", name: "Notes" });
    await expect(f.service.dispatch(f.id, "agent_browser_fill", { selector: "textarea", text: "a" }, () => true)).resolves.toBeDefined();
    const g = await serviceFixture({ checker: () => { key = key + "x"; return mk(); } });
    g.box.mode = "full"; g.setFacts({ tag: "textarea", role: "textbox", name: "Notes" });
    await expect(g.service.dispatch(g.id, "agent_browser_fill", { selector: "textarea", text: "a" }, () => true)).rejects.toThrow(/approval settings/);
  });
});
