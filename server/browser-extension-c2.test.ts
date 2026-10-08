// SPDX-License-Identifier: AGPL-3.0-or-later
// Lane C2: recovery, Your turn and Stop / new task (core). Each test was written first and fails on the base (938dea4a7).
// Layers: the broker is covered in browser-extension-broker.test.ts (d); the integration and service here.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserExtensionService, handoffContinueText } from "./browser-extension-service.ts";
import type { BrowserExtensionCommand, BrowserExtensionHello, BrowserExtensionResponse } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory, writePrivateTestFile } from "./testing/private-test-dir.ts";

const A = "https://fixture.test";
const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const service of services.splice(0)) await service.close(); for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

type RuntimeBinding = { generation: number; state: string; tabs: object[]; pausedReason?: string };
async function world() {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".c2-")); cleanup.push(directoryRoot);
  const bindings = new Map<string, RuntimeBinding>();
  const calls: BrowserExtensionCommand[] = [];
  let nextTab = 1; let guard = false; let pauseFails = 0; let uncertainBind = false;
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      if (pauseFails > 0 && command.operation === "pause") { pauseFails--; throw new Error("the extension did not answer"); }
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: nextTab++, navigationEpoch: 1, origin: A, url: A + "/" }] }; bindings.set(command.bindingId, b); }
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
      void uncertainBind;
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const handoffs: any[] = []; const failures: any[] = []; const recovered: any[] = []; const continued: any[] = []; const cards: any[] = [];
  const open = (extra: Record<string, unknown> = {}) => createBrowserExtensionService({
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, tag: "button", role: "button", name: "Save draft", visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: any) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") { for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); } }
        if (name === "agent_browser_snapshot") { await engine.transport.selected(); return { content: [{ type: "text", text: "- heading" }] }; }
        return { content: [{ type: "text", text: "ok" }] };
      },
    }) as never,
    broker: broker as never, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    askSite: async () => "allow" as const, askAction: async (_c: unknown, a: unknown) => { cards.push(a); return true; },
    ownerInstruction: () => ({ id: "m1", text: "please tidy my drafts" }), approvalMode: () => "task" as const,
    onHandoff: (info: unknown) => { handoffs.push(info); },
    onHandoffFailed: (info: unknown) => { failures.push(info); },
    onStateRecovered: (info: unknown) => { recovered.push(info); },
    onContinue: (info: unknown) => { continued.push(info); },
    ...extra,
  } as never).then(service => { services.push(service); return service; });
  const bind = async (service: Awaited<ReturnType<typeof open>>) => service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  return { directory, stateFile: path.join(directory, "state.json"), bindings, calls, open, bind, handoffs, failures, recovered, continued, cards,
    setGuard: (v: boolean) => { guard = v; }, failPause: (n: number) => { pauseFails = n; } };
}
const click = (service: any, id: string) => service.dispatch(id, "agent_browser_click", { selector: "button" }, () => true);
const statusOf = (service: any, id: string) => service.status().bindings.find((b: any) => b.bindingId === id) as any;

describe("C2 RES-002: an uncertain restart report reaches the service", () => {
  it("pauses the binding, keeps an outcome-unknown mark in status, and clears it when the owner resumes", async () => {
    const w = await world(); const service = await w.open(); const { bindingId, generation } = await w.bind(service);
    await service.handleMessage("profile", { version: 1, type: "response", id: "old_9", bindingId, generation, error: { code: "uncertain", message: "The browser restarted during the last action." } } as never);
    const status = statusOf(service, bindingId);
    expect(status.state).toBe("paused"); expect(status.pausedReason).toBe("uncertain"); expect(status.outcomeUnknown).toBe(true);
    // The owner resumes in the browser: the runtime reports it and the mark goes.
    const runtime = w.bindings.get(bindingId)!; runtime.generation++; runtime.state = "active";
    await service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: runtime.generation, event: "resumed", data: {} } as never);
    expect(statusOf(service, bindingId).outcomeUnknown).toBeUndefined();
  });
  it("a late uncertain report on a binding that is already stopped does not revive or mark it", async () => {
    const w = await world(); const service = await w.open(); const { bindingId, generation } = await w.bind(service);
    await service.stop(bindingId);
    await service.handleMessage("profile", { version: 1, type: "response", id: "old_9", bindingId, generation, error: { code: "uncertain", message: "x" } } as never);
    expect(statusOf(service, bindingId).state).toBe("stopped"); expect(statusOf(service, bindingId).outcomeUnknown).toBeUndefined();
  });
});

describe("C2 RES-003: Stop is final; the owner starts a new task", () => {
  it("a bot-side ensureBinding never revives a stopped binding, and startNewTask issues a fresh one with no grants", async () => {
    const w = await world(); const service = await w.open(); const first = await w.bind(service);
    await service.dispatch(first.bindingId, "agent_browser_snapshot", {}, () => true);
    expect(service.taskInfo(first.bindingId)?.sites.length).toBeGreaterThan(0);
    await service.stop(first.bindingId);
    const again = await w.bind(service);
    expect(again.bindingId).toBe(first.bindingId); expect(statusOf(service, again.bindingId).state).toBe("stopped");
    const fresh = await service.startNewTask(first.bindingId);
    expect(fresh.bindingId).not.toBe(first.bindingId);
    expect(statusOf(service, fresh.bindingId)).toMatchObject({ state: "active" });
    expect(service.taskInfo(fresh.bindingId)).toBeUndefined();
    // The next bot-side lookup finds the new binding, the old one stays stopped for good.
    expect((await w.bind(service)).bindingId).toBe(fresh.bindingId);
    expect(statusOf(service, first.bindingId).state).toBe("stopped");
    await expect(service.dispatch(first.bindingId, "agent_browser_snapshot", {}, () => true)).rejects.toBeTruthy();
  });
  it("startNewTask refuses a binding that is not stopped", async () => {
    const w = await world(); const service = await w.open(); const first = await w.bind(service);
    await expect(service.startNewTask(first.bindingId)).rejects.toMatchObject({ code: "not_stopped" });
  });
  it("the choice survives a restart: the newest binding is the one the bot finds", async () => {
    const w = await world(); const service = await w.open(); const first = await w.bind(service);
    await service.stop(first.bindingId); const fresh = await service.startNewTask(first.bindingId); await service.close();
    const reopened = await w.open();
    expect((await w.bind(reopened)).bindingId).toBe(fresh.bindingId);
  });
});

describe("C2 RES-004: a damaged state file is set aside, not fatal", () => {
  it("a one-byte { file is quarantined, the service starts clean and the owner hears once", async () => {
    const w = await world(); writePrivateTestFile(w.stateFile, "{");
    const service = await w.open();
    expect(service.status().bindings).toEqual([]);
    expect(w.recovered).toHaveLength(1); expect(w.recovered[0]).toMatchObject({ kind: "damaged" });
    const names = await fs.readdir(w.directory);
    expect(names.some(name => /^state\.json\.damaged-/.test(name))).toBe(true);
    expect(await fs.readFile(path.join(w.directory, names.find(name => /^state\.json\.damaged-/.test(name))!), "utf8")).toBe("{");
    expect((await w.bind(service)).bindingId).toBeTruthy();
    await service.close(); const again = await w.open();
    expect(w.recovered).toHaveLength(1); await again.close();
  });
  it("a newer format is kept as it is and the owner is asked to update", async () => {
    const w = await world(); writePrivateTestFile(w.stateFile, JSON.stringify({ version: 99, bindings: [] }));
    const service = await w.open();
    expect(w.recovered).toHaveLength(1); expect(w.recovered[0]).toMatchObject({ kind: "newer" });
    const names = await fs.readdir(w.directory);
    const kept = names.find(name => /^state\.json\.newer-/.test(name));
    expect(kept).toBeTruthy(); expect(JSON.parse(await fs.readFile(path.join(w.directory, kept!), "utf8")).version).toBe(99);
    await service.close();
  });
});

describe("C2 DSK-001: observations do not rewrite the state file", () => {
  it("repeated snapshots of an unchanged page make no further state writes", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    await service.dispatch(bindingId, "agent_browser_snapshot", {}, () => true);
    await new Promise(resolve => setTimeout(resolve, 50));
    const rename = vi.spyOn(fs, "rename");
    for (let i = 0; i < 8; i++) await service.dispatch(bindingId, "agent_browser_snapshot", {}, () => true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(rename.mock.calls.filter(call => String(call[1]).endsWith("state.json"))).toHaveLength(0);
  });
  it("a real change (Stop) is still written", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    await service.dispatch(bindingId, "agent_browser_snapshot", {}, () => true);
    await service.stop(bindingId);
    const saved = JSON.parse(await fs.readFile(w.stateFile, "utf8"));
    expect(saved.bindings.find((b: any) => b.context.bindingId === bindingId).state).toBe("stopped");
  });
});

describe("C2 T25 server half: Your turn", () => {
  it("a floor stop pauses as a handoff and a restart keeps it a handoff", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    w.setGuard(true); await expect(click(service, bindingId)).rejects.toThrow(/^YOUR TURN:/);
    expect(statusOf(service, bindingId)).toMatchObject({ state: "paused", pausedReason: "handoff" });
    await service.close();
    const reopened = await w.open(); await w.bind(reopened);
    expect(statusOf(reopened, bindingId)).toMatchObject({ state: "paused", pausedReason: "handoff" });
    // Until Continue, every attempt gets the Your turn text, and no tool succeeds.
    await expect(click(reopened, bindingId)).rejects.toThrow(/^YOUR TURN:/);
    expect(w.calls.filter(c => c.operation === "cdp" && String((c.params as any).method).startsWith("Input.")).length).toBe(0);
  });
  it("the owner's Continue (the runtime reports 'resumed') starts the continuation turn once, with the fixed words", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    w.setGuard(true); await expect(click(service, bindingId)).rejects.toThrow();
    const runtime = w.bindings.get(bindingId)!; runtime.generation++; runtime.state = "active";
    await service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: runtime.generation, event: "resumed", data: {} } as never);
    expect(w.continued).toHaveLength(1);
    expect(w.continued[0].text).toBe("The owner finished the step on fixture.test. Take a new snapshot and continue the task.");
    expect(handoffContinueText("fixture.test")).toBe(w.continued[0].text);
    expect(statusOf(service, bindingId).state).toBe("active");
  });
  it("a plain pause and resume (not a handoff) does not start a continuation", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    await service.pause(bindingId);
    const runtime = w.bindings.get(bindingId)!; runtime.generation++; runtime.state = "active";
    await service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: runtime.generation, event: "resumed", data: {} } as never);
    expect(w.continued).toHaveLength(0);
  });
  it("Stop task from a Your turn card stops it, and a stopped task cannot be continued", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    w.setGuard(true); await expect(click(service, bindingId)).rejects.toThrow();
    await service.stop(bindingId);
    expect(statusOf(service, bindingId).state).toBe("stopped");
    await expect(service.continueHandoff(bindingId)).rejects.toMatchObject({ code: "not_handoff" });
  });
  it("when the hand-over pause fails twice, the owner gets one plain line to press Stop", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    w.setGuard(true); w.failPause(2);
    await expect(click(service, bindingId)).rejects.toThrow(/^YOUR TURN:/);
    expect(w.handoffs).toHaveLength(0);
    expect(w.failures).toHaveLength(1);
    expect(w.failures[0].text).toBe("Murage couldn't hand over the tab, press Stop.");
    expect(w.failures[0].text).not.toMatch(/—|safe/i);
  });
});

describe("C2 review fixes", () => {
  it("outcome-unknown and its pause survive another restart until the owner resumes or stops", async () => {
    const w = await world(); const service = await w.open(); const { bindingId, generation } = await w.bind(service);
    await service.handleMessage("profile", { version: 1, type: "response", id: "old_9", bindingId, generation, error: { code: "uncertain", message: "x" } } as never);
    await service.close();
    const reopened = await w.open();
    expect(statusOf(reopened, bindingId)).toMatchObject({ state: "paused", pausedReason: "uncertain", outcomeUnknown: true });
    await reopened.stop(bindingId);
    expect(statusOf(reopened, bindingId).outcomeUnknown).toBeUndefined();
  });
  it("the app's Continue asks the runtime to resume the hand-over, only while one is waiting", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    await expect(service.continueHandoff(bindingId)).rejects.toMatchObject({ code: "not_handoff" });
    w.setGuard(true); await expect(click(service, bindingId)).rejects.toThrow();
    await service.continueHandoff(bindingId);
    const resume = w.calls.filter(c => c.operation === "resume").at(-1)!;
    expect(resume.params).toMatchObject({ reason: "continue" });
  });
  it("the desktop panel is offered the start-task route, and the route is an owner-only desktop route", async () => {
    const source = await fs.readFile(path.resolve("server/index.ts"), "utf8");
    expect(source).toContain("startTaskRoute: `/api/bots/${encodeURIComponent(bot.id)}/browser-extension/start-task`");
    expect(await fs.readFile(path.resolve("server/route-policy.ts"), "utf8")).toMatch(/browser-extension\\\/start-task\$\/, class: "desktop"/);
  });
});

describe("C2 DRV: the production mount", () => {
  it("the extension mount sets the extension transport and shares one deadline with the external MCP client", async () => {
    const source = await fs.readFile(path.resolve("server/index.ts"), "utf8");
    const mount = source.slice(source.indexOf("extensionBrowserThreads.set(threadId"), source.indexOf("extensionBrowserThreads.set(threadId") + 1500);
    expect(mount).toContain('MURAGE_BROWSER_TRANSPORT: "extension"');
    expect(mount).toContain("MURAGE_BROWSER_CALL_TIMEOUT_MS: String(BROWSER_EXTENSION_CALL_TIMEOUT_MS)");
    const mcp = await fs.readFile(path.resolve("server/drivers/browser-extension-mcp.ts"), "utf8");
    expect(mcp).toContain("AbortSignal.timeout(BROWSER_EXTENSION_CALL_TIMEOUT_MS)");
  });
  it("both browser HTTP routes return the refusal code in the error body", async () => {
    const source = await fs.readFile(path.resolve("server/index.ts"), "utf8");
    const mcpRoute = source.slice(source.indexOf('path === "/api/browser-extension/mcp"'), source.indexOf('/browser-extension\\/mode$/'));
    expect(mcpRoute).toContain("extensionRefusal(error)"); expect(mcpRoute).toContain("code: reason.code");
    expect(source).toContain("if (extension) { const reason = extensionRefusal(error); if (reason) return json(res, reason.status, { error: reason.error, code: reason.code }); }");
  });
});

describe("C2b SEC-006: deliver() output goes through OUT's redactor", () => {
  const CARD = "4111 1111 1111 1111", SSN = "123-45-6789", OTP = "Your code is 48291637";
  it("a page read never returns a card number, SSN or one-time code to the bot, and keeps the ordinary text", async () => {
    const w = await world();
    const service = await w.open({ createEngine: () => ({ resolveTab: async () => undefined, event() {}, async close() {}, async call() { return { content: [{ type: "text", text: `Card on file: ${CARD}\nSSN ${SSN}\n${OTP}\nOrder 2026 shipped to Lisbon.` }] }; } }) as never });
    const { bindingId } = await w.bind(service);
    const out: any = await service.dispatch(bindingId, "agent_browser_snapshot", {}, () => true);
    const text = JSON.stringify(out);
    for (const needle of ["4111", "1111 1111", "123-45-6789", "48291637"]) expect(text).not.toContain(needle);
    expect(text).toContain("Order 2026 shipped to Lisbon.");
  });
});

describe("C2b panel phase: waiting for the owner", () => {
  const panelOf = (w: any, op: string) => (w.calls.filter((c: any) => c.operation === op).at(-1)?.params as any)?.panel;
  it("a hand-over reports phase waiting; an active task with no card reports none", async () => {
    const w = await world(); const service = await w.open(); const { bindingId } = await w.bind(service);
    expect(panelOf(w, "bind").phase).toBeUndefined();
    w.setGuard(true); await expect(click(service, bindingId)).rejects.toThrow(/^YOUR TURN:/);
    await service.pause(bindingId).catch(() => undefined);
    await w.bind(service);
    const panel = w.calls.filter((c: any) => (c.operation === "bind" || c.operation === "status")).map((c: any) => c.params.panel).at(-1);
    expect(panel.phase).toBe("waiting");
  });
  it("an unanswered card (the app's panel hook says so) reports phase waiting, and clears when the card is answered", async () => {
    let waiting = true;
    const w = await world(); const service = await w.open({ panel: () => (waiting ? { phase: "waiting" } : {}) });
    await w.bind(service);
    expect(panelOf(w, "bind").phase).toBe("waiting");
    waiting = false; await service.stop((await w.bind(service)).bindingId);
    expect(w.calls.filter((c: any) => c.operation === "status" && c.params?.panel).every((c: any) => c.params.panel.phase === undefined)).toBe(true);
  });
});
