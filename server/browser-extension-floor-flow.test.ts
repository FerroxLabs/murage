// SPDX-License-Identifier: AGPL-3.0-or-later
// T03: the hard floor wired into the executor and the service, the hand-off, the loaderId fence, unbind and activity.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserExtensionExecutor, type ExtensionDocument, type ExtensionAction } from "./browser-extension-executor.ts";
import { BrowserExtensionPolicy } from "./browser-extension-policy.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import { BrowserActivityStore, configureBrowserActivity } from "./browser-extension-activity.ts";
import type { FloorFacts } from "./browser-floor.ts";
import { BROWSER_APP_PROTOCOL } from "../shared/browser-extension-protocol.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";

const agreeBox: FloorFacts = { operation: "click", tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the terms and conditions" };
const benign: FloorFacts = { operation: "click", tag: "button", role: "button", name: "Save draft" };
const payNow: FloorFacts = { operation: "click", tag: "button", role: "button", name: "Pay now" };

function executorFixture(opts: { facts?: () => Promise<FloorFacts> | FloorFacts } = {}) {
  const current: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
  let loaderId = "L1";
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const admits: ExtensionAction[] = [];
  const floors: { rule: string; floor: string | null; text: string; unsure?: boolean }[] = [];
  const activity: { decision: string; outcome: string; operation: string }[] = [];
  let facts: () => Promise<FloorFacts> | FloorFacts = opts.facts ?? (() => benign);
  let collect: ((operation: string, extra?: { dialog?: { kind: string; text: string } }) => FloorFacts) | undefined;
  let onAdmit: () => void = () => {};
  let onInput: () => void = () => {};
  const executor = new BrowserExtensionExecutor({
    authorize: () => true,
    access: async () => true,
    admit: async action => { admits.push(action); onAdmit(); return true; },
    collectFacts: async (_io, _target, operation, extra) => (collect ? collect(operation, extra) : facts()) as never,
    onFloor: async info => { floors.push({ rule: info.result.rule, floor: info.result.floor, text: info.text, unsure: info.result.unsure }); },
    activity: event => { activity.push({ decision: event.decision, outcome: event.outcome, operation: event.operation }); },
    createEngine: hooks => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: { ...current } }), resolveTab: async () => ({ ...current }), event() {}, async close() {},
      async call(name, args) {
        if (name === "agent_browser_click") { onInput(); await hooks.beforeCommand({ ...current }, "Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 30 }); calls.push({ method: "Input.dispatchMouseEvent", params: {} }); return { content: [] }; }
        if (name === "agent_browser_fill") { await hooks.beforeCommand({ ...current }, "Input.insertText", { text: args.text }); calls.push({ method: "Input.insertText", params: {} }); return { content: [] }; }
        return { content: [] };
      },
    }),
    transport: {
      document: async () => ({ ...current }),
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId } } };
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === 'DOM.getDocument') return { root: { nodeType: 9, children: [] } };
        if (method === "Runtime.evaluate") {
          if (String(params.expression).includes("__murageGuard()")) return { result: { type: "boolean", value: false } };
          if (params.returnByValue === false) return { result: { objectId: "node" } };
          return { result: { value: "Example" } };
        }
        if (method === "DOM.describeNode") return { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") return { object: { objectId: "node" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ display: { tag: "BUTTON", text: "Save", label: "Save" }, bound: null }) } };
        return {};
      },
    },
  });
  return { executor, calls, admits, floors, activity, setFacts: (fn: typeof facts) => { facts = fn; }, setCollect: (fn: NonNullable<typeof collect>) => { collect = fn; }, setLoader: (v: string) => { loaderId = v; }, onAdmit: (fn: () => void) => { onAdmit = fn; }, onInput: (fn: () => void) => { onInput = fn; } };
}
const inputs = (calls: { method: string }[]) => calls.filter(call => call.method.startsWith("Input."));

describe("T03 floor in the executor", () => {
  it("an I-agree checkbox is refused before admit, no input, YOUR TURN text", async () => {
    const f = executorFixture({ facts: () => agreeBox });
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.admits).toHaveLength(0);
    expect(inputs(f.calls)).toHaveLength(0);
    expect(f.floors).toHaveLength(1);
    expect(f.floors[0].floor).toBe("consent");
  });
  it("a card approved and then a page that swaps the button to Pay now is refused before dispatch", async () => {
    const f = executorFixture();
    let n = 0; f.setFacts(() => (++n === 1 ? benign : payNow));
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.admits).toHaveLength(1);
    expect(inputs(f.calls)).toHaveLength(0);
    expect(f.floors[0].floor).toBe("payment");
  });
  it("a confirm dialog about updated terms is floor", async () => {
    const f = executorFixture();
    const seen: { operation: string; dialog?: { kind: string; text: string } }[] = [];
    f.setFacts(() => benign);
    f.setCollect((operation, extra) => { seen.push({ operation, dialog: extra?.dialog }); return { operation, ...(extra?.dialog ? { dialog: extra.dialog } : {}) }; });
    f.executor.event(1, 1, "Page.javascriptDialogOpening", { type: "confirm", message: "Do you agree to the updated terms?" });
    (f.executor as any).executing = true;
    await expect((f.executor as any).answerDialog({ profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" }, { accept: true })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.admits).toHaveLength(0);
    expect(f.floors[0]?.floor).toBe("consent");
    expect(seen[0].dialog?.text).toContain("updated terms");
  });
  it("a facts collector that throws is floor with the generic text", async () => {
    const f = executorFixture({ facts: () => { throw new Error("boom"); } });
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.admits).toHaveLength(0);
    expect(f.floors[0].unsure).toBe(true);
    expect(f.floors[0].text).toMatch(/this step needs the owner/i);
    expect(inputs(f.calls)).toHaveLength(0);
  });
  it("the tool text tells the bot to end its turn and wait", async () => {
    const f = executorFixture({ facts: () => agreeBox });
    const error = await f.executor.call("agent_browser_click", { selector: "button" }).catch(e => e as Error);
    expect((error as Error).message).toMatch(/^YOUR TURN: .*End your turn now and wait\. Do not try another way to do this step\.$/s);
  });
  it("L1: a loaderId that changes between admit and the input is refused, no input", async () => {
    const f = executorFixture();
    f.onInput(() => f.setLoader("L2"));
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow("The page changed. Inspect it again before continuing.");
    expect(inputs(f.calls)).toHaveLength(0);
  });
  it("L1 review: a frame tree with no loaderId is unsure, so the input is refused", async () => {
    const f = executorFixture();
    f.setLoader(undefined as unknown as string);
    await expect(f.executor.call("agent_browser_click", { selector: "button" })).rejects.toThrow(/page changed/);
    expect(inputs(f.calls)).toHaveLength(0);
  });
  it("review: input the engine sends outside an admitted action is refused", async () => {
    const f = executorFixture();
    const doc: ExtensionDocument = { profileId: "profile", tabId: 1, frameId: "frame", navigationEpoch: 1, origin: "https://example.test", url: "https://example.test/" };
    await expect((f.executor as unknown as { beforeEngineCommand: (d: ExtensionDocument, m: string, p: Record<string, unknown>) => Promise<void> }).beforeEngineCommand(doc, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 })).rejects.toThrow(/not approved/);
  });
  it("control: an unchanged loaderId lets the click through", async () => {
    const f = executorFixture();
    await f.executor.call("agent_browser_click", { selector: "button" });
    expect(inputs(f.calls).length).toBeGreaterThan(0);
  });
  it("reports one activity decision at refusal and none beyond the floor line", async () => {
    const f = executorFixture({ facts: () => agreeBox });
    await f.executor.call("agent_browser_click", { selector: "button" }).catch(() => {});
    expect(f.activity).toEqual([{ decision: "your turn", outcome: "handed over", operation: "click" }]);
  });
  it("records not done when the loader fence refuses after admit", async () => {
    const f = executorFixture();
    f.onInput(() => f.setLoader("L2"));
    await f.executor.call("agent_browser_click", { selector: "button" }).catch(() => {});
    expect(f.activity).toEqual([{ decision: "not done", outcome: "failed", operation: "click" }]);
  });
});

describe("T03 policy: handoff reason and unbind (L11b)", () => {
  const identity = (n: number) => ({ bindingId: `b${n}`, workspaceId: "w", botId: "bot", threadId: `t${n}`, clientId: "owner", profileId: "p" });
  it("pause with a reason keeps state paused and records the reason; resume clears it", () => {
    const policy = new BrowserExtensionPolicy();
    const context = policy.bind(identity(1));
    const paused = policy.pause(context, "handoff");
    expect(policy.status("b1")).toMatchObject({ state: "paused", pausedReason: "handoff" });
    policy.resume(paused, []);
    expect(policy.status("b1").pausedReason).toBeUndefined();
  });
  it("unbind frees the slot: 257 binds work after unbinding one", () => {
    const policy = new BrowserExtensionPolicy();
    const contexts = Array.from({ length: 256 }, (_, i) => policy.bind(identity(i)));
    expect(() => policy.bind(identity(999))).toThrow("binding_capacity");
    policy.unbind(contexts[0]);
    expect(() => policy.bind(identity(999))).not.toThrow();
    expect(() => policy.status("b0")).toThrow("unknown_binding");
  });
  it("unbind frees the tab owner so another binding can share the tab", () => {
    const policy = new BrowserExtensionPolicy();
    const a = policy.bind(identity(1));
    const document = { profileId: "p", tabId: 5, frameId: 0, navigationEpoch: 1, origin: "https://example.test" };
    policy.share(a, document, "https://example.test/");
    const b = policy.bind(identity(2));
    expect(() => policy.share(b, document, "https://example.test/")).toThrow("tab_already_shared");
    policy.unbind(a);
    expect(() => policy.share(b, document, "https://example.test/")).not.toThrow();
  });
  it("unbind refuses a stale or foreign context", () => {
    const policy = new BrowserExtensionPolicy();
    const a = policy.bind(identity(1));
    expect(() => policy.unbind({ ...a, botId: "other" })).toThrow("stale_binding");
  });
});

// ---------------------------------------------------------------------------- service
const cleanup: string[] = [];
// Close every service before its folder goes: a save still in flight would recreate state.json mid-removal (ENOTEMPTY on macOS).
const services: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(service: T): T => { services.push(service); return service; };
afterEach(async () => { for (const service of services.splice(0)) await service.close().catch(() => {}); configureBrowserActivity(undefined); for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
async function serviceFixture(initialFacts: FloorFacts) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".floor-service-")); cleanup.push(directoryRoot);
  const activityDir = mkdtempSync(path.join(tmpdir(), "floor-activity-")); cleanup.push(activityDir);
  const activityStore = new BrowserActivityStore(activityDir); configureBrowserActivity(activityStore);
  const bindings = new Map<string, { generation: number; state: string; tabs: { tabId: number; navigationEpoch: number; origin: string; url: string }[] }>();
  const calls: BrowserExtensionCommand[] = [];
  let facts = initialFacts; let statusError: string | undefined;
  const handoffs: { site: string; text: string; category: string | null; unsure?: boolean; bindingId: string }[] = [];
  let approvals = 0;
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      if (statusError && command.operation === "status") return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, error: { code: statusError, message: statusError } } as never;
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: any = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L1" } } };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ display: { tag: "BUTTON", text: "x", label: "x" }, bound: null }) } };
        result = { result: value, ...b.tabs[0] };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const service = track(await createBrowserExtensionService({
    broker: broker as never, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    collectFacts: async () => ({ ...(facts as object), visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    onHandoff: info => { handoffs.push({ site: info.site, text: info.text, category: info.category, unsure: info.unsure, bindingId: info.context.bindingId }); },
    createEngine: engine => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") { const params = { type: "mousePressed", x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); return { content: [{ type: "text", text: "clicked" }] }; }
        return { content: [] };
      },
    }) as never,
    askSite: async () => "allow" as const, askAction: async () => { approvals++; return true; },
  }));
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  return { service, binding, calls, handoffs, activityStore, setFacts: (v: FloorFacts) => { facts = v; }, setStatusError: (v: string) => { statusError = v; }, approvals: () => approvals };
}
const lines = (f: Awaited<ReturnType<typeof serviceFixture>>) => f.activityStore.list({ botId: "bot", bindingId: f.binding.bindingId });

describe("T03 service hand-off", () => {
  it("floor pauses the binding with reason handoff, tells the host, and sends no input", async () => {
    const f = await serviceFixture(agreeBox);
    await expect(f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true)).rejects.toThrow(/^YOUR TURN:/);
    expect(f.calls.some(call => String((call.params as any)?.method ?? "").startsWith("Input."))).toBe(false);
    expect(f.approvals()).toBe(0);
    const status = f.service.status().bindings[0] as any;
    expect(status.state).toBe("paused");
    expect(status.pausedReason).toBe("handoff");
    expect(f.handoffs).toHaveLength(1);
    expect(f.handoffs[0]).toMatchObject({ site: "fixture.test", category: "consent", bindingId: f.binding.bindingId });
    expect(f.handoffs[0].text).toMatch(/stopped at a step only you can do: agreeing to fixture\.test's terms, policies or cookies/);
  });
  it("a second attempt during handoff gets the same YOUR TURN text and no card", async () => {
    const f = await serviceFixture(agreeBox);
    const first = await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).catch(e => e as Error);
    const second = await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).catch(e => e as Error);
    expect((second as Error).message).toBe((first as Error).message);
    expect(f.approvals()).toBe(0);
    expect(f.handoffs).toHaveLength(1);
  });
  it("an unsure floor uses the generic text", async () => {
    const f = await serviceFixture({ operation: "click", factsFailed: true });
    await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).catch(() => {});
    expect(f.handoffs[0].unsure).toBe(true);
    expect(f.handoffs[0].text).toMatch(/needs you/i);
  });
  it("records one activity line per decision: free, you allowed, your turn", async () => {
    const f = await serviceFixture(benign);
    await f.service.dispatch(f.binding.bindingId, "agent_browser_snapshot", {}, () => true);
    await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true);
    f.setFacts(agreeBox);
    await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).catch(() => {});
    const got = lines(f).map(line => `${line.action}:${line.decision}:${line.outcome}`);
    expect(got).toContain("snapshot:free:done");
    expect(got).toContain("click:you allowed:done");
    expect(got).toContain("click:your turn:handed over");
  });
  it("retirement calls deleteBinding and frees the policy slot", async () => {
    const f = await serviceFixture(benign);
    await f.service.dispatch(f.binding.bindingId, "agent_browser_snapshot", {}, () => true);
    expect(lines(f).length).toBeGreaterThan(0);
    await f.service.stop(f.binding.bindingId);
    f.setStatusError("unknown_binding");
    await f.service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
    expect(lines(f)).toHaveLength(0);
    });
});

describe("Batch 2 gate wiring (status, end of task, appProtocol, uncertain)", () => {
  it("a: the status sends handoff true with the reason when the pause is a hand-off", async () => {
    const f = await serviceFixture(agreeBox);
    expect((f.service.status().bindings[0] as any).handoff).toBeUndefined();
    await f.service.dispatch(f.binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).catch(() => {});
    const status = f.service.status().bindings[0] as any;
    expect(status).toMatchObject({ state: "paused", handoff: true, pausedReason: "handoff" });
    await f.service.pause(f.binding.bindingId);
  });
  it("a: a plain owner pause is not a hand-off", async () => {
    const f = await serviceFixture(benign);
    await f.service.pause(f.binding.bindingId);
    const status = f.service.status().bindings[0] as any;
    expect(status.state).toBe("paused"); expect(status.handoff).toBeUndefined();
  });
  it("b: a stopped task is marked taskEnded in the status; a live one is not", async () => {
    const f = await serviceFixture(benign);
    expect((f.service.status().bindings[0] as any).taskEnded).toBeUndefined();
    await f.service.stop(f.binding.bindingId);
    expect((f.service.status().bindings[0] as any).taskEnded).toBe(true);
  });
  it("c: the bind command carries the app protocol", async () => {
    const f = await serviceFixture(benign);
    const bind = f.calls.find(call => call.operation === "bind");
    expect((bind?.params as any)?.appProtocol).toBe(BROWSER_APP_PROTOCOL);
    expect(BROWSER_APP_PROTOCOL).toBeGreaterThanOrEqual(1);
  });
  it("d: an uncertain report from the restarted extension pauses the binding with a reason", async () => {
    const f = await serviceFixture(benign);
    await f.service.handleMessage("profile", { version: 1, type: "response", id: "old_1", bindingId: f.binding.bindingId, generation: 1, error: { code: "uncertain", message: "The browser restarted during the last action." } } as never);
    const status = f.service.status().bindings[0] as any;
    expect(status).toMatchObject({ state: "paused", pausedReason: "uncertain" });
    expect(status.handoff).toBeUndefined();
  });
  it("d: an uncertain report for another profile or an unknown binding changes nothing", async () => {
    const f = await serviceFixture(benign);
    await f.service.handleMessage("other", { version: 1, type: "response", id: "x", bindingId: f.binding.bindingId, generation: 1, error: { code: "uncertain", message: "m" } } as never);
    await f.service.handleMessage("profile", { version: 1, type: "response", id: "x", bindingId: "nope", generation: 1, error: { code: "uncertain", message: "m" } } as never);
    expect((f.service.status().bindings[0] as any).state).toBe("active");
  });
});
