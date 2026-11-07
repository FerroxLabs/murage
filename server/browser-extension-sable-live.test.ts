// SPDX-License-Identifier: AGPL-3.0-or-later
// SABLE-LIVE-B: Sean's Sable at service level. A Grok bot on Full access, the action check on the bot's own engine
// (here: one that fails or is unsure), opens google.com from a blank tab, types a search and presses Enter.
// Full access means it does not ask: no site card, no action card, and the binding never pauses.
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close().catch(() => {}); for (const directory of cleanup.splice(0)) await removeTempDir(directory); });
type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
type Runtime = { generation: number; state: string; tabs: Tab[] };
const VISIBLE = { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null };
// The Google search box, as Murage's own facts describe it.
const SEARCH_BOX = { tag: "input", type: "text", role: "combobox", name: "Search" };

async function sable(overrides: Record<string, unknown> = {}) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve(".service-")); cleanup.push(directoryRoot);
  const stateFile = path.join(directory, "state.json");
  const bindings = new Map<string, Runtime>(); const calls: BrowserExtensionCommand[] = [];
  const siteCards: string[] = []; const actionCards: string[] = []; const handoffs: string[] = [];
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: "null", url: "about:blank" }] }; bindings.set(command.bindingId, b); }
      let result: any = b;
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === "DOM.getDocument") value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ tag: "INPUT", text: "" }) } };
        if (method === "Accessibility.getFullAXTree") value = { nodes: [] };
        const before = { ...b.tabs[0] };
        if (method === "Page.navigate") {
          const tab = b.tabs[0]!; const to = new URL(String(params.url)); tab.navigationEpoch++; tab.origin = to.origin; tab.url = to.href;
          await service.handleMessage("profile", { version: 1, type: "event", bindingId: command.bindingId, generation: b.generation, event: "navigation", data: { tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url } });
        }
        result = { result: value, ...before };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  // The bot's own engine as the action check: it fails half the time and is unsure the other half.
  let n = 0;
  const transport = async () => { n++; if (n % 2) throw new Error("engine busy"); return '{"decision":"ask","reason":"Not sure."}'; };
  const options = {
    createEngine: (engine: import("./browser-extension-engine.ts").BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_open") { await engine.beforeDestination(String(args.url), document); await engine.transport.send("Page.navigate", { url: args.url }, document); return { content: [{ type: "text", text: "opened" }] }; }
        const [method, params] = name === "agent_browser_fill" ? ["Input.insertText", { text: args.text }] : name === "agent_browser_press" ? ["Input.dispatchKeyEvent", { type: "keyDown", key: String(args.key) }] : ["Accessibility.getFullAXTree", {}];
        await engine.beforeCommand(document, method as string, params as never); await engine.transport.send(method as string, params as never, document);
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, ...(operation === "press" ? { key: "Enter" } : {}), ...SEARCH_BOX, ...(overrides.scanFailed ? { recipientScanFailed: true } : {}), visibility: VISIBLE }) as never,
    broker, workspaceId: "workspace", stateFile,
    approvalMode: () => "full" as const,
    // The owner names the address, so the open is in the task (I1 stays exactly as on base: a host-only "google.com" still cards).
    ownerInstruction: () => ({ id: "m1", text: String(overrides.ownerText ?? "open https://www.google.com and search for murage") }),
    checker: () => ({ deps: { transport, models: { stage1: "s1", stage2: "s2" } } }),
    onHandoff: (info: { text: string }) => { handoffs.push(info.text); },
    askSite: async (_context: unknown, origin: string) => { siteCards.push(origin); return "allow" as const; },
    askAction: async (_c: unknown, a: { summary: string }) => { actionCards.push(a.summary); return true; },
    ...overrides,
  };
  const service = await createBrowserExtensionService(options as never); services.push(service);
  const binding = await service.ensureBinding({ botId: "sable", threadId: "thread", profileId: "profile" });
  const dispatch = (name: string, args: Record<string, unknown> = {}) => service.dispatch(binding.bindingId, name, args, () => true);
  return { service, binding, calls, siteCards, actionCards, handoffs, dispatch, checks: () => n };
}

describe("SABLE-LIVE-B: open google.com and search, under Full access", () => {
  it("raises no card, never pauses, and every step reaches the page", async () => {
    const f = await sable();
    await f.dispatch("agent_browser_open", { url: "https://www.google.com" });
    for (let k = 0; k < 4; k++) {
      await f.dispatch("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" });
      await f.dispatch("agent_browser_press", { key: "Enter" });
    }
    expect(f.siteCards).toEqual([]);
    expect(f.actionCards).toEqual([]);
    expect(f.handoffs).toEqual([]);
    expect(f.service.status().bindings[0]!.state).toBe("active");
    expect(f.calls.some((c) => (c.params as any)?.method === "Page.navigate")).toBe(true);
    expect(f.calls.filter((c) => (c.params as any)?.method === "Input.dispatchKeyEvent")).toHaveLength(4);
    // The check still ran; under Full its failures and unsure answers are advice, never a stop.
    expect(f.checks()).toBeGreaterThan(0);
  });
  it("cut (MurageMain ruling): a failed recipient scan on the Search box still cards under Full, as on base", async () => {
    const f = await sable({ scanFailed: true });
    await f.dispatch("agent_browser_open", { url: "https://www.google.com" });
    await f.dispatch("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" });
    await f.dispatch("agent_browser_press", { key: "Enter" }).catch(() => {});
    expect(f.siteCards.length + f.actionCards.length).toBeGreaterThan(0);
  });
  // SABLE-B r8 (row 3b): the bot-chosen destination takes the site card first; after Allow the data-in-the-address card still shows, and its Deny navigates nothing.
  it("a real link-carries-data hit still cards under Full: a search URL opened from a blank tab", async () => {
    const cards: string[] = [];
    const f = await sable({ askSite: async (_c: unknown, origin: string) => { cards.push(origin); return "allow" as const; },
      askAction: async (_c: unknown, a: { summary: string }) => { cards.push(a.summary); return false; } });
    await f.dispatch("agent_browser_open", { url: "https://www.google.com/search?q=murage" }).catch(() => {});
    expect(cards.some((c) => /carries information from your task/.test(c))).toBe(true);
    expect(f.calls.some((c) => (c.params as any)?.method === "Page.navigate")).toBe(false);
    expect(f.handoffs).toEqual([]);
  });
  // SABLE-B r8 (rows 3 and 4): a site the request did not name by address is no longer granted automatically: the site card is asked
  // before anything is granted, and after the owner's Allow the I1 line no longer fires (the site is the owner's grant).
  it("cut (MurageMain ruling): a site the request did not name by address takes the site card under Full, never an automatic grant", async () => {
    const f = await sable({ ownerText: "open google.com and search for murage" });
    await f.dispatch("agent_browser_open", { url: "https://www.google.com" });
    expect(f.siteCards).toContain("https://www.google.com");
    expect(f.actionCards.some((c) => /This site was not part of your request/.test(c))).toBe(false);
    expect(f.handoffs).toEqual([]);
  });
  it("the never-list still asks under Full: a password field cards", async () => {
    const asked: string[] = [];
    const f = await sable({ collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, tag: "input", type: "password", role: "textbox", name: "Password", visibility: VISIBLE }) as never,
      askAction: async (_c: unknown, a: { summary: string }) => { asked.push(a.summary); return false; } });
    await f.dispatch("agent_browser_open", { url: "https://www.google.com" });
    await expect(f.dispatch("agent_browser_fill", { selector: "input[type=password]", text: "hunter2" })).rejects.toThrow();
    expect(f.calls.some((c) => (c.params as any)?.method === "Input.insertText")).toBe(false);
  });
});
