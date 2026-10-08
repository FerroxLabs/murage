// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests (lane 0162-chromereal): service authority, redirects, Ask, notices, deadlines.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";
const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const service of services.splice(0)) await service.close(); for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
type Runtime = { generation: number; state: string; tabs: Tab[] };
async function fixture(overrides: Record<string, unknown> = {}) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".service-")); cleanup.push(directoryRoot);
  const stateFile = path.join(directory, "state.json");
  const bindings = new Map<string, Runtime>(); const calls: BrowserExtensionCommand[] = []; const timeouts: (number | undefined)[] = [];
  let connected = true, approve: () => Promise<boolean> = async () => true;
  let onCdp: ((method: string, params: any, b: Runtime, bindingId: string) => Promise<void>) | undefined;
  let onRequest: ((command: BrowserExtensionCommand) => BrowserExtensionResponse | undefined) | undefined;
  const asked: string[] = []; let answer: (origin: string) => Promise<"allow" | "ask" | "never"> = async () => "allow";
  const broker = {
    profiles: (): BrowserExtensionHello[] => connected ? [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }] : [],
    async request(_profile: string, command: BrowserExtensionCommand, timeoutMs?: number): Promise<BrowserExtensionResponse> {
      calls.push(command); timeouts.push(timeoutMs);
      const forced = onRequest?.(command); if (forced) return forced;
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/" }] }; bindings.set(command.bindingId, b); }
      let result: any = b;
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ tag: "BUTTON", text: "Post" }) } };
        if (method === "Accessibility.getFullAXTree") value = { nodes: [] };
        const before = { ...b.tabs[0] };
        await onCdp?.(method, params, b, command.bindingId);
        result = { result: value, ...before };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const options = {
    createEngine: (engine: import("./browser-extension-engine.ts").BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_open") { await engine.beforeDestination(String(args.url), document); await engine.transport.send("Page.navigate", { url: args.url }, document); return { content: [{ type: "text", text: "opened" }] }; }
        const method = name === "agent_browser_fill" ? "Input.insertText" : "Accessibility.getFullAXTree"; const params = name === "agent_browser_fill" ? { text: args.text } : {};
        await engine.beforeCommand(document, method, params); await engine.transport.send(method, params, document); return { content: [{ type: "text", text: "ok" }] };
      },
    }), collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never, broker, workspaceId: "workspace", stateFile,
    askSite: async (_context: unknown, origin: string) => { asked.push(origin); return answer(origin); }, askAction: async () => approve(), ...overrides,
  };
  const service = await createBrowserExtensionService(options as never); services.push(service);
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const event = (name: string, data: Record<string, unknown>) => service.handleMessage("profile", { version: 1, type: "event", bindingId: binding.bindingId, generation: bindings.get(binding.bindingId)!.generation, event: name as never, data: data as never });
  return { service, binding, calls, timeouts, bindings, asked, event, options, setApproval: (fn: typeof approve) => { approve = fn; }, onCdp: (hook: typeof onCdp) => { onCdp = hook; }, onRequest: (hook: typeof onRequest) => { onRequest = hook; }, answer: (fn: typeof answer) => { answer = fn; }, offline: () => { connected = false; } };
}
const dispatch = (f: Awaited<ReturnType<typeof fixture>>, name: string, args: Record<string, unknown> = {}) => f.service.dispatch(f.binding.bindingId, name, args, () => true);
const outcome = (value: Promise<unknown>) => value.then(v => JSON.stringify(v), e => `rejected ${e.code ?? ""} ${e.message}`);
const inputs = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(call => String((call.params as any).method).startsWith("Input."));

describe("Astra 2: a change of site access revokes in-flight authority and stale consent", () => {
  it("Never while a fetched destination is pending: the fetched content is not returned", async () => {
    const f = await fixture(); let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const pending = outcome(dispatch(f, "agent_browser_read", { url: "https://sink.test/doc" }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"), { timeout: 10000 });
    await f.service.setSiteAccess(f.binding.bindingId, "https://sink.test", "never");
    release(new Response("AFTER-REVOCATION-CANARY", { headers: { "content-type": "text/plain" } }));
    expect(await pending).not.toContain("AFTER-REVOCATION-CANARY");
  });
  it("a stale consent answer never overwrites a newer setting", async () => {
    const f = await fixture(); let resolveCard!: (value: "allow") => void; f.answer(() => new Promise(resolve => { resolveCard = resolve; }));
    const pending = outcome(dispatch(f, "agent_browser_snapshot"));
    await vi.waitFor(() => expect(resolveCard).toBeTypeOf("function"), { timeout: 10000 });
    await f.service.setSiteAccess(f.binding.bindingId, "https://fixture.test", "never");
    resolveCard("allow");
    expect(await pending).toMatch(/rejected/);
    expect(f.service.status().bindings[0].sites["https://fixture.test"]).toBe("never");
    expect(f.calls.some(call => call.operation === "cdp")).toBe(false);
  });
  it("any setSiteAccess bumps the authority revision synchronously, so an approved in-flight action never reaches Input", async () => {
    const f = await fixture();
    let change: Promise<unknown> = Promise.resolve();
    f.setApproval(async () => { change = f.service.setSiteAccess(f.binding.bindingId, "https://unrelated.test", "never"); return true; });
    expect(await outcome(dispatch(f, "agent_browser_fill", { selector: "textarea", text: "hello" }))).toMatch(/rejected/);
    await change; expect(inputs(f)).toHaveLength(0);
  });
});

describe("Fable M2: a refused bind rolls the persisted Allow back", () => {
  it("setSiteAccess rejects, the site is not stored, and the binding still works", async () => {
    const f = await fixture();
    f.onRequest(command => command.operation === "bind" && (command.params.approvedOrigins as string[]).includes("https://roll.test") ? { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, error: { code: "human_handover", message: "human_handover" } } : undefined);
    await expect(f.service.setSiteAccess(f.binding.bindingId, "https://roll.test", "allow")).rejects.toMatchObject({ code: "human_handover" });
    expect(f.service.status().bindings[0].sites["https://roll.test"]).toBeUndefined();
    expect(await fs.readFile((f.options as any).stateFile, "utf8")).not.toContain("roll.test");
    await expect(f.service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" })).resolves.toBeDefined();
  });
});

describe("Fable H2: a redirect or replaceState during an action is a refresh, not a fence", () => {
  it("a redirected open on the approved site completes and the binding stays usable", async () => {
    const f = await fixture();
    f.onCdp(async (method, _params, b, bindingId) => {
      if (method !== "Page.navigate") return;
      const tab = b.tabs[0]; tab.navigationEpoch++; tab.url = "https://fixture.test/home";
      await f.service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: b.generation, event: "navigation", data: { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url } });
    });
    const result = await outcome(dispatch(f, "agent_browser_open", { url: "https://fixture.test/login" }));
    expect(result).not.toMatch(/rejected/); expect(result).toContain("opened");
    expect(await outcome(dispatch(f, "agent_browser_snapshot"))).not.toMatch(/rejected/);
  });
  it("https://host versus the committed https://host/ does not fence either", async () => {
    const f = await fixture();
    f.onCdp(async (method, _params, b, bindingId) => {
      if (method !== "Page.navigate") return;
      const tab = b.tabs[0]; tab.navigationEpoch++; tab.url = "https://fixture.test/";
      await f.service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: b.generation, event: "navigation", data: { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url } });
    });
    expect(await outcome(dispatch(f, "agent_browser_open", { url: "https://fixture.test" }))).not.toMatch(/rejected/);
  });
  it("a snapshot during which the page calls history.replaceState completes", async () => {
    const f = await fixture();
    f.onCdp(async (method, _params, b, bindingId) => {
      if (method !== "Accessibility.getFullAXTree") return;
      const tab = b.tabs[0]; tab.navigationEpoch++; tab.url = "https://fixture.test/?ref=spa";
      await f.service.handleMessage("profile", { version: 1, type: "event", bindingId, generation: b.generation, event: "navigation", data: { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url } });
    });
    expect(await outcome(dispatch(f, "agent_browser_snapshot"))).not.toMatch(/rejected/);
  });
  it("an input still cannot reach a document that changed after its approval", async () => {
    const f = await fixture();
    f.setApproval(async () => { const b = f.bindings.values().next().value!; const tab = b.tabs[0]; tab.navigationEpoch++; tab.url = "https://fixture.test/changed"; await f.event("navigation", { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url }); return true; });
    expect(await outcome(dispatch(f, "agent_browser_fill", { selector: "textarea", text: "hello" }))).toMatch(/rejected/);
    expect(inputs(f)).toHaveLength(0);
  });
});

describe("Astra 15: Ask each time stays Ask", () => {
  it("T20: an allowed card is Allow for this task: the setting stays Ask, the site is not asked again in the task", async () => {
    const f = await fixture(); await f.service.setSiteAccess(f.binding.bindingId, "https://fixture.test", "ask");
    await dispatch(f, "agent_browser_snapshot");
    expect(f.asked).toEqual(["https://fixture.test"]);
    expect(f.service.status().bindings[0].sites["https://fixture.test"]).toBe("ask");
    await dispatch(f, "agent_browser_snapshot");
    expect(f.asked).toEqual(["https://fixture.test"]);
    const binds = f.calls.filter(call => call.operation === "bind"); expect((binds.at(-1)!.params.approvedOrigins as string[])).toContain("https://fixture.test");
    await f.service.endTask(f.binding.bindingId);
    expect((f.calls.filter(call => call.operation === "bind").at(-1)!.params.approvedOrigins as string[])).not.toContain("https://fixture.test");
  });
  it("T20: a site that was never set becomes a task grant, not a remembered Allow always", async () => {
    const f = await fixture(); await dispatch(f, "agent_browser_snapshot");
    expect(f.service.status().bindings[0].sites["https://fixture.test"]).toBeUndefined();
    expect(f.service.taskInfo(f.binding.bindingId)?.sites.map(site => site.origin)).toContain("https://fixture.test");
  });
});

describe("Fable M3 (partial): scroll is free", () => {
  it("raises no action card for a scroll on an allowed site", async () => {
    let cards = 0; const f = await fixture({ askAction: async () => { cards++; return true; } });
    await dispatch(f, "agent_browser_scroll", { direction: "down" });
    expect(cards).toBe(0);
  });
});

describe("Fable M4, M6, M7: what the page did is told to the bot, in plain words", () => {
  const text = (value: string) => JSON.parse(value).content.map((item: { text: string }) => item.text).join(" ");
  it("a dialog is reported on the next result, labelled as the page's words, and never fences the action", async () => {
    const f = await fixture();
    await f.event("notice", { kind: "dialog", tabId: 1, origin: "https://fixture.test", dialogType: "confirm", text: "Delete everything?" });
    const said = text(await outcome(dispatch(f, "agent_browser_snapshot")));
    expect(said).toContain("confirm dialog"); expect(said).toContain("Delete everything?"); expect(said).toMatch(/comes from the page/i); expect(said).not.toMatch(/—/);
    expect(text(await outcome(dispatch(f, "agent_browser_snapshot")))).not.toContain("confirm dialog");
    f.onCdp(async method => { if (method === "Accessibility.getFullAXTree") await f.event("notice", { kind: "dialog", tabId: 1, origin: "https://fixture.test", dialogType: "alert", text: "hi" }); });
    expect(await outcome(dispatch(f, "agent_browser_snapshot"))).not.toMatch(/rejected/);
  });
  it("a blocked download is reported as blocked", async () => {
    const f = await fixture(); await f.event("notice", { kind: "download_blocked", tabId: 1, origin: "https://fixture.test", name: "update.exe" });
    const said = text(await outcome(dispatch(f, "agent_browser_snapshot")));
    expect(said).toMatch(/blocked/i); expect(said).toContain("update.exe"); expect(said).toMatch(/nothing was saved/i);
  });
  it("a new tab is reported, adopted or not", async () => {
    const f = await fixture(); await f.event("notice", { kind: "tab_opened", tabId: 5, origin: "https://fixture.test", adopted: true });
    expect(text(await outcome(dispatch(f, "agent_browser_snapshot")))).toMatch(/new tab/i);
    await f.event("notice", { kind: "tab_opened", tabId: 6, origin: "https://elsewhere.test", adopted: false });
    const said = text(await outcome(dispatch(f, "agent_browser_snapshot"))); expect(said).toContain("https://elsewhere.test"); expect(said).toMatch(/not approved|stays private/i);
  });
});

describe("Fable M4: per-operation deadlines on the broker request", () => {
  it("gives a navigation more time than a plain read, always more than the extension's own deadline", async () => {
    const f = await fixture(); await dispatch(f, "agent_browser_open", { url: "https://fixture.test/x" });
    const navigate = f.calls.findIndex(call => (call.params as any).method === "Page.navigate"); expect(f.timeouts[navigate]).toBeGreaterThanOrEqual(65_000);
    const ax = f.calls.findIndex(call => (call.params as any).method === "Page.createIsolatedWorld"); expect(f.timeouts[ax]).toBeGreaterThanOrEqual(20_000); expect(f.timeouts[ax]).toBeLessThan(65_000);
  });
});

describe("Astra 15: the side panel gets a name, not an id", () => {
  it("binds with the label the host supplies", async () => {
    const f = await fixture({ botLabel: () => "Ada: Booking a table" });
    expect(f.calls.find(call => call.operation === "bind")!.params.botName).toBe("Ada: Booking a table");
  });
});

describe("Astra 8: a retired stopped binding does not break the service", () => {
  it("an unknown_binding answer for a stopped task keeps it stopped and does not throw", async () => {
    const f = await fixture(); await f.service.stop(f.binding.bindingId);
    f.onRequest(command => command.operation === "status" ? { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, error: { code: "unknown_binding", message: "unknown_binding" } } : undefined);
    await expect(f.service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" })).resolves.toMatchObject({ bindingId: f.binding.bindingId });
    expect(f.service.status().bindings[0].state).toBe("stopped");
  });
});

describe("Vultr live bug 4: a stopped task cannot ping-pong between the server and the extension", () => {
  it("stopping twice sends one stop, and a repeated stopped event for a stopped task asks for nothing", async () => {
    const f = await fixture(); await f.service.stop(f.binding.bindingId);
    const before = f.calls.length; await f.service.stop(f.binding.bindingId);
    expect(f.calls.length).toBe(before);
    for (let i = 0; i < 5; i++) await f.event("stopped", {});
    expect(f.calls.length).toBe(before);
    expect(f.service.status().bindings[0].state).toBe("stopped");
  });
  it("a failing reconcile after a stopped event never turns into more stops", async () => {
    const f = await fixture(); f.onRequest(command => command.operation === "status" ? { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, error: { code: "unknown_binding", message: "x" } } : undefined);
    await f.service.stop(f.binding.bindingId).catch(() => {});
    const stops = () => f.calls.filter(call => call.operation === "stop").length; const first = stops();
    for (let i = 0; i < 5; i++) await f.event("stopped", {}).catch(() => {});
    expect(stops()).toBe(first);
  });
});

describe("Fable L1: a share request from the side panel raises the site card", () => {
  it("asks for the site once, and Allow adds it; Never is not asked about", async () => {
    const f = await fixture(); await f.event("notice", { kind: "share_requested", tabId: 9, origin: "https://gmail.test" });
    await vi.waitFor(() => expect(f.asked).toContain("https://gmail.test"));
    await vi.waitFor(() => expect(f.service.taskInfo(f.binding.bindingId)?.sites.map(site => site.origin)).toContain("https://gmail.test"));
    await f.service.setSiteAccess(f.binding.bindingId, "https://nope.test", "never"); const before = f.asked.length;
    await f.event("notice", { kind: "share_requested", tabId: 9, origin: "https://nope.test" }); await new Promise(r => setTimeout(r, 50));
    expect(f.asked.length).toBe(before);
  });
});

describe("Coordinator ruling (0.1.62): the first navigation the owner's task asked for is free; other cross-site paths keep the card", () => {
  const counted = (f: Awaited<ReturnType<typeof fixture>>) => { const cards: string[] = []; f.setApproval(async () => { cards.push("card"); return true; }); return cards; };
  it("a URL in the owner's own instruction opens without an action card, once; another path still asks", async () => {
    const f = await fixture({ ownerInstruction: () => ({ id: "m1", text: "Please read https://news.test/story/42 and summarise it." }) });
    const cards = counted(f);
    expect(await outcome(dispatch(f, "agent_browser_open", { url: "https://news.test/story/42" }))).not.toMatch(/rejected/);
    expect(cards).toHaveLength(0);
    await outcome(dispatch(f, "agent_browser_open", { url: "https://news.test/story/42" }));
    expect(cards).toHaveLength(1); // the free one is used: the same address again asks
    await outcome(dispatch(f, "agent_browser_open", { url: "https://news.test/story/43" }));
    expect(cards).toHaveLength(2);
  });
  it("control: with no owner instruction naming it, the cross-site path asks", async () => {
    const f = await fixture({ ownerInstruction: () => ({ id: "m1", text: "Summarise the news for me." }) });
    const cards = counted(f);
    await outcome(dispatch(f, "agent_browser_open", { url: "https://news.test/story/42" }));
    expect(cards).toHaveLength(1);
  });
  it("opening a result link a search page shows is free (first one only); a link on an ordinary page is not", async () => {
    for (const [pageUrl, expected] of [["https://search.test/results?q=murage+chrome", 0], ["https://blog.test/post", 1]] as const) {
      const f = await fixture({ ownerInstruction: () => ({ id: "m1", text: "Find the Murage for Chrome docs." }) });
      f.onCdp(async (method, params, b) => { if (method === "Page.navigate") b.tabs[0] = { tabId: 1, navigationEpoch: b.tabs[0].navigationEpoch + 1, origin: new URL(params.url).origin, url: params.url }; });
      expect(await outcome(dispatch(f, "agent_browser_open", { url: pageUrl }))).not.toMatch(/rejected/); // the owner's own search, approved
      const tab = f.bindings.get(f.binding.bindingId)!.tabs[0];
      f.onRequest(command => {
        const p = command.params as any;
        if (command.operation === "cdp" && p.method === "Runtime.evaluate" && String(p.params?.expression).includes("a[href],area[href]"))
          return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: { result: { result: { value: true } }, ...tab } } as never;
        return undefined;
      });
      const cards = counted(f);
      const first = await outcome(dispatch(f, "agent_browser_open", { url: "https://docs.test/chrome/start" }));
      expect(first, pageUrl).not.toMatch(/rejected/);
      expect(cards, pageUrl).toHaveLength(expected);
      if (!expected) { await outcome(dispatch(f, "agent_browser_open", { url: "https://other.test/chrome/other" })); expect(cards).toHaveLength(1); }
    }
  });
});


describe("Chrome proof: dialog answers have facts but no DOM target", () => {
  it.each(["alert", "confirm", "prompt"].flatMap(kind => [true, false].map(accept => ({ kind, accept }))))("admits $kind accept=$accept, retaining the card and asking again", async ({ kind, accept }) => {
    const cards: any[] = [];
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      collectFacts: async (_io: unknown, _target: unknown, operation: string, extra?: object) => ({ operation, ...extra, visibility: {} }),
      askAction: async (_context: unknown, action: any) => { cards.push(action); return true; },
      createEngine: (engine: any) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }),
        resolveTab: () => engine.transport.selected(), event() {}, async close() {},
        async call() {
          const document = await engine.transport.selected();
          await f.event("cdp", { tabId: 1, navigationEpoch: 1, method: "Page.javascriptDialogOpening", params: { type: kind, message: "Page question" } });
          await engine.beforeCommand(document, "Page.handleJavaScriptDialog", { accept, ...(kind === "prompt" ? { promptText: "owner-visible answer" } : {}) });
          await engine.transport.send("Page.handleJavaScriptDialog", { accept }, document);
          await f.event("cdp", { tabId: 1, navigationEpoch: 1, method: "Page.javascriptDialogClosed", params: { result: accept } });
          return { content: [{ type: "text", text: "answered" }] };
        },
      }),
    });
    try {
      // A read supplies the running tool scope without requiring an unrelated DOM target.
      await dispatch(f, "agent_browser_get_title");
      await dispatch(f, "agent_browser_get_title");
      const answers = cards.filter(a => a.name === `agent_browser_dialog_${accept ? "accept" : "dismiss"}`);
      expect(answers).toHaveLength(2);
      expect(answers[0].summary).toContain("Page question");
      expect(answers[0].summary).toContain("https://fixture.test");
      if (kind === "prompt" && accept) expect(answers[0].summary).toContain("owner-visible answer");
      expect(f.calls.filter(c => (c.params as any).method === "Page.handleJavaScriptDialog")).toHaveLength(2);
    } finally { await f.service.close(); }
  });

  it("keeps a terms confirmation on the consent handoff path", async () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      collectFacts: async (_io: unknown, _target: unknown, operation: string, extra?: object) => ({ operation, ...extra, visibility: {} }),
      createEngine: (engine: any) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }),
        resolveTab: () => engine.transport.selected(), event() {}, async close() {},
        async call() {
          const document = await engine.transport.selected();
          await f.event("cdp", { tabId: 1, navigationEpoch: 1, method: "Page.javascriptDialogOpening", params: { type: "confirm", message: "Do you agree to the terms and conditions?" } });
          await engine.beforeCommand(document, "Page.handleJavaScriptDialog", { accept: true });
          await engine.transport.send("Page.handleJavaScriptDialog", { accept: true }, document);
          return { content: [] };
        },
      }),
    });
    try {
      await expect(dispatch(f, "agent_browser_get_title")).rejects.toThrow(/YOUR TURN/);
      expect(f.service.status().bindings[0]).toMatchObject({ state: "paused", pausedReason: "handoff" });
      expect(f.calls.some(c => (c.params as any).method === "Page.handleJavaScriptDialog")).toBe(false);
    } finally { await f.service.close(); }
  });
});


describe("Chrome proof: authority invalidation retains its cause", () => {
  it.each(["revision", "generation", "uncertain"])("reports %s instead of a generic authorisation failure", async reason => {
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      createEngine: (engine: any) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }),
        resolveTab: () => engine.transport.selected(), event() {}, async close() {},
        async call() {
          if (reason === "revision") await f.service.settingsChanged("bot");
          else if (reason === "generation") {
            f.bindings.get(f.binding.bindingId)!.generation++;
            await f.event("status", {});
          } else await f.service.handleMessage("profile", { version: 1, type: "response", id: "uncertain-fixture", bindingId: f.binding.bindingId, generation: f.binding.generation, error: { code: "uncertain" } } as never);
          return { content: [{ type: "text", text: "stale result" }] };
        },
      }),
    });
    try {
      await expect(dispatch(f, "agent_browser_get_title")).rejects.toMatchObject({ code: reason === "revision" ? "stale_binding" : reason === "generation" ? "stale_generation" : "uncertain" });
    } finally { await f.service.close(); }
  });
});
