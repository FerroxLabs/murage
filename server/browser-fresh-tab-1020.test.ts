// Sean 1.0.20 ruling (binding): the owner is never asked to hand a browser back. When a bot's page is protected
// (a sensitive page, or the owner's input), that tab is left untouched and the bot gets a new blank tab of its own,
// silently. The protected tab is never read, typed into or closed for the bot.
//
// The controller runs for real (UnifiedBrowserController); the native browser is a small tab model, and the page
// check is the real BrowserDocumentGuard against a fake CDP endpoint, so "never looked at" is what Chrome would see.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { UnifiedBrowserController } from "./browser-control.ts";
import { BrowserDocumentGuard } from "./browser-document-guard.ts";
import type { NativeBrowser } from "./browser-native-relay.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const directories: string[] = [];
const servers: WebSocketServer[] = [];
const guards: BrowserDocumentGuard[] = [];
afterEach(() => {
  for (const g of guards.splice(0)) g.close();
  for (const s of servers.splice(0)) s.close();
  for (const path of directories.splice(0)) removeTempDirSync(path);
});

/** A fake Chrome: its pages, which of them hold a private field, and every target the guard attached to. */
async function fakeChrome() {
  const pages: { targetId: string; url: string }[] = [{ targetId: "tab-a", url: "https://bank.example/sign-in" }];
  const privatePages = new Set<string>(["tab-a"]);
  const attached: string[] = [];
  const sessions = new Map<string, string>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ id: m.id, ...(m.sessionId ? { sessionId: m.sessionId } : {}), result }));
      switch (m.method) {
        case "Target.getTargets": return reply({ targetInfos: pages.map((p) => ({ ...p, type: "page" })) });
        case "Target.attachToTarget": { attached.push(m.params.targetId); const sessionId = `s-${m.params.targetId}`; sessions.set(sessionId, m.params.targetId); return reply({ sessionId }); }
        case "Page.getFrameTree": return reply({ frameTree: { frame: { id: "f1" } } });
        case "Page.createIsolatedWorld": return reply({ executionContextId: 7 });
        case "Runtime.evaluate": return reply({ result: { type: "boolean", value: privatePages.has(sessions.get(m.sessionId) ?? "") } });
        case "DOM.getDocument": return reply({ root: { children: [] } });
        default: return reply({});
      }
    });
  });
  const port = (wss.address() as { port: number }).port;
  return { endpoint: `ws://127.0.0.1:${port}/devtools/browser/x`, pages, privatePages, attached };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-fresh-tab-test-")); directories.push(dir);
  const chrome = await fakeChrome();
  const guard = new BrowserDocumentGuard(async () => { throw new Error("the engine is not asked"); }, { endpoint: chrome.endpoint });
  guards.push(guard);
  // The engine acts on its active tab. Every call records which tab it reached.
  let active = "tab-a"; let serial = 0;
  const reached: { tool: string; tab: string }[] = [];
  const native: NativeBrowser = {
    protected: (armed, skip) => guard.protected(armed, skip),
    pages: () => guard.pages(),
    request: async (method, call) => {
      if (method === "tools/list") return { tools: [{ name: "agent_browser_snapshot" }, { name: "agent_browser_open" }] };
      const tool = String(call?.name);
      if (tool === "agent_browser_tab_new") { active = `tab-new-${++serial}`; chrome.pages.push({ targetId: active, url: "about:blank" }); }
      if (tool === "agent_browser_open") { const page = chrome.pages.find((p) => p.targetId === active)!; page.url = String((call!.arguments as { url: string }).url); if (page.url.includes("popup.example")) chrome.pages.push({ targetId: "tab-pop", url: "about:blank" }); }
      reached.push({ tool, tab: active });
      return { content: [{ type: "text", text: `observation of ${active}` }] };
    },
    command: async () => ({}), connect: async () => "fixture-stream", input: () => {}, resetStream: () => {}, close: async () => {},
  };
  const stateFile = join(dir, "control.json");
  const controller = new UnifiedBrowserController({ stateFile, createNative: () => native });
  await controller.register("bot-tab", { command: "fixture", args: [], env: {} });
  const call = (name: string, args: Record<string, unknown> = {}) => controller.dispatch("bot-tab", "tools/call", { name, arguments: args }, () => true);
  // A page script: opens a popup (a second bot tab; the engine stays where it is), or closes the engine's current tab, after
  // which the engine falls back to the first tab Chrome lists, as agent-browser does by index.
  const popup = (id: string) => { chrome.pages.push({ targetId: id, url: "about:blank" }); };
  const closeCurrent = () => { chrome.pages.splice(chrome.pages.findIndex((p) => p.targetId === active), 1); active = chrome.pages[0].targetId; };
  // The server restarts on the same state file; the browser (and its tabs) stays up.
  const restart = async () => {
    const again = new UnifiedBrowserController({ stateFile, createNative: () => native });
    await again.register("bot-tab", { command: "fixture", args: [], env: {} });
    return (name: string, args: Record<string, unknown> = {}) => again.dispatch("bot-tab", "tools/call", { name, arguments: args }, () => true);
  };
  return { controller, chrome, reached, stateFile, call, active: () => active, popup, closeCurrent, restart };
}
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error as Error & { code?: string }; } throw new Error("expected a refusal"); };

describe("a bot whose page is protected gets a new blank tab, and the owner is never asked", () => {
  it("sensitive page: the first look locks it; the next step moves the bot to a new blank tab and the protected tab is left alone", async () => {
    const f = await fixture();
    expect((await refusal(f.call("agent_browser_snapshot"))).code).toBe("browser_protected_sensitive_page");
    expect(f.controller.status("bot-tab")).toMatchObject({ protectedDocument: true, protectedReason: "sensitive-page" });
    expect(f.reached).toEqual([]);
    const attachedBefore = f.chrome.attached.length;

    // The next step: the bot is in a new blank tab, told so, and the step meant for the protected page did not run.
    const moved = await refusal(f.call("agent_browser_snapshot"));
    expect(moved.code).toBe("browser_fresh_tab");
    expect(moved.message).not.toMatch(/Reopen blank page|Take control|ask the owner/i);
    expect(f.controller.status("bot-tab")).toMatchObject({ protectedDocument: false, protectedReason: null });
    expect(f.reached).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-1" }]);
    // Privacy: since the lock, only the new tab was looked at; the protected tab was never attached again.
    expect(f.chrome.attached.slice(attachedBefore)).toEqual(["tab-new-1"]);

    // The bot works on in its own tab; the protected tab is still open, untouched, and never looked at.
    expect(await f.call("agent_browser_open", { url: "https://news.example/" })).toMatchObject({ content: [{ text: "observation of tab-new-1" }] });
    expect(await f.call("agent_browser_snapshot")).toMatchObject({ content: [{ text: "observation of tab-new-1" }] });
    expect(f.reached.every((r) => r.tab !== "tab-a")).toBe(true);
    expect(f.chrome.pages.map((p) => p.targetId)).toContain("tab-a");
    expect(f.chrome.attached.slice(attachedBefore)).not.toContain("tab-a");
  });

  it("owner input: after the owner hands control back, the bot is moved to a new tab and the owner's tab is never read, typed into or closed", async () => {
    const f = await fixture();
    f.chrome.privatePages.clear(); // the owner's page holds no private field: only the owner's typing protects it
    const held = await f.controller.take("bot-tab", "owner");
    await f.controller.input("bot-tab", "owner", held.generation, { type: "input_keyboard", eventType: "char", text: "x" });
    await f.controller.release("bot-tab", "owner", f.controller.status("bot-tab").generation);
    expect(f.controller.status("bot-tab")).toMatchObject({ protectedDocument: true, protectedReason: "owner-input" });

    // A step that opens an address goes on in the new tab, in one call.
    expect(await f.call("agent_browser_open", { url: "https://maps.example/" })).toMatchObject({ content: [{ text: "observation of tab-new-1" }] });
    expect(f.controller.status("bot-tab").protectedDocument).toBe(false);
    expect(f.chrome.attached).not.toContain("tab-a");
    // Every tool that could reach the owner's tab is off while it is open; nothing reached it.
    for (const tool of ["agent_browser_tab_list", "agent_browser_tab_switch", "agent_browser_tab_close", "agent_browser_close"]) {
      expect((await refusal(f.call(tool, tool === "agent_browser_tab_switch" ? { tab: "0" } : {}))).code).toBe("browser_protected_tab");
    }
    expect(f.reached.map((r) => r.tab)).toEqual(["tab-new-1", "tab-new-1"]);
    // The record survives a restart of Murage: the owner's tab stays off limits.
    expect(JSON.parse(readFileSync(f.stateFile, "utf8"))[0][1].ownerTabs).toEqual([{ id: "tab-a", reason: "owner-input" }]);

    // The owner closes their tab: the record goes, and the tab tools are back.
    f.chrome.pages.splice(f.chrome.pages.findIndex((p) => p.targetId === "tab-a"), 1);
    await expect(f.call("agent_browser_tab_list")).resolves.toBeTruthy();
  });

  it("the owner holding control: nothing moves and no tab is opened", async () => {
    const f = await fixture();
    await refusal(f.call("agent_browser_snapshot"));
    await f.controller.take("bot-tab", "owner");
    await expect(f.controller.freshTab("bot-tab")).resolves.toBe(false);
    expect(f.reached).toEqual([]);
    expect(f.controller.status("bot-tab").protectedDocument).toBe(true);
  });

  it("a new tab that is itself protected keeps the lock (fail closed)", async () => {
    const f = await fixture();
    await refusal(f.call("agent_browser_snapshot"));
    f.chrome.privatePages.add("tab-new-1");
    await expect(f.controller.freshTab("bot-tab")).resolves.toBe(false);
    expect(f.controller.status("bot-tab").protectedDocument).toBe(true);
  });
});

// FABLE-REVIEW fix/1020-browserhand 8cb4b8b6e5 (BLOCK, High): while an owner tab is recorded the bot has exactly ONE tab of its own,
// before and after every step; a second agent_browser_tab_new is refused; zero or two-plus -> every listed tab is recorded as the
// owner's, the bot is moved to a new blank tab and the step does not run. The one tab is also pinned by id, so a bot tab that closed
// itself after a popup cannot hand the engine (now on the owner's tab by index) a passing check on the popup.
describe("while a tab is left to the owner, the bot keeps exactly one tab of its own", () => {
  async function moved() {
    const f = await fixture();
    await refusal(f.call("agent_browser_snapshot"));
    expect((await refusal(f.call("agent_browser_snapshot"))).code).toBe("browser_fresh_tab");
    expect(f.active()).toBe("tab-new-1");
    return { ...f, attachedBefore: f.chrome.attached.length, reachedBefore: f.reached.length };
  }

  it("two bot tabs and the current one closes itself: the engine falls back to the owner's tab, the step is refused and that tab is never attached", async () => {
    const f = await moved();
    f.popup("tab-pop");
    f.closeCurrent();
    expect(f.active()).toBe("tab-a"); // the engine is now on the owner's tab
    const refused = await refusal(f.call("agent_browser_snapshot"));
    expect(refused.code).toBe("browser_fresh_tab");
    // The snapshot never ran: the only engine call is the new blank tab, and the owner's tab was never attached.
    expect(f.reached.slice(f.reachedBefore)).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-2" }]);
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
    expect(JSON.parse(readFileSync(f.stateFile, "utf8"))[0][1].ownerTabs.map((t: { id: string }) => t.id)).toEqual(["tab-a", "tab-pop"]);
    // The bot works on in its new tab.
    expect(await f.call("agent_browser_snapshot")).toMatchObject({ content: [{ text: "observation of tab-new-2" }] });
  });

  it("two bot tabs before a step (a popup): the step does not run and the bot is moved to a new blank tab", async () => {
    const f = await moved();
    f.popup("tab-pop");
    expect((await refusal(f.call("agent_browser_snapshot"))).code).toBe("browser_fresh_tab");
    expect(f.reached.slice(f.reachedBefore)).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-2" }]);
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
  });

  it("a popup opened during a step: its result is withheld and the bot is moved to a new blank tab", async () => {
    const f = await moved();
    // The page opens a second tab while the step runs (the fixture's popup.example does that on load).
    expect((await refusal(f.call("agent_browser_open", { url: "https://popup.example/" }))).code).toBe("browser_fresh_tab");
    expect(f.reached.slice(f.reachedBefore).map((r) => r.tool)).toEqual(["agent_browser_open", "agent_browser_tab_new"]);
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
  });

  it("a second agent_browser_tab_new is refused while the bot has its one tab", async () => {
    const f = await moved();
    expect((await refusal(f.call("agent_browser_tab_new"))).code).toBe("browser_protected_tab");
    expect(f.reached.slice(f.reachedBefore)).toEqual([]);
    expect(f.chrome.pages.map((p) => p.targetId)).toEqual(["tab-a", "tab-new-1"]);
  });

  it("no bot tab left (it closed itself): the step does not run and the owner's tab is never attached", async () => {
    const f = await moved();
    f.closeCurrent();
    expect(f.active()).toBe("tab-a");
    expect((await refusal(f.call("agent_browser_snapshot"))).code).toBe("browser_fresh_tab");
    expect(f.reached.slice(f.reachedBefore)).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-2" }]);
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
  });

  // n2b: the pinned tab survives a server restart. Without it the one tab outside the owner's would be taken on trust after the
  // restart, and here that is a page script's popup while the engine has fallen back to the owner's tab.
  it("after a server restart the bot's pinned tab still decides: a popup left alone with the engine on the owner's tab is refused", async () => {
    const f = await moved();
    expect(JSON.parse(readFileSync(f.stateFile, "utf8"))[0][1].botTab).toBe("tab-new-1");
    f.popup("tab-pop");
    f.closeCurrent();
    expect(f.active()).toBe("tab-a");
    const call = await f.restart();
    expect((await refusal(call("agent_browser_snapshot"))).code).toBe("browser_fresh_tab");
    expect(f.reached.slice(f.reachedBefore)).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-2" }]);
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
  });

  // n2b: a step whose tab count broke may have read the owner's tab; nothing it read is kept, even when no new tab can be opened.
  it("a broken tab count drops what the step read, even when the move to a new tab fails", async () => {
    const f = await moved();
    let dropped = false;
    const entry = (f.controller as unknown as { entries: Map<string, { readDocuments?: unknown }> }).entries.get("bot-tab")!;
    entry.readDocuments = { dispose: () => { dropped = true; } };
    f.chrome.privatePages.add("tab-new-2"); // the next new tab is itself protected, so the move fails and the lock stays
    expect((await refusal(f.call("agent_browser_open", { url: "https://popup.example/" }))).code).toBe("browser_protected_owner_input");
    expect(dropped).toBe(true);
    expect(entry.readDocuments).toBeUndefined();
    expect(f.chrome.attached.slice(f.attachedBefore)).not.toContain("tab-a");
  });

  // n2b (Fable Medium): the turn start and a step moving the bot at once both get the one move's outcome, never a false "locked".
  it("two moves at once: both callers see the one new tab, and only one tab is opened", async () => {
    const f = await fixture();
    await refusal(f.call("agent_browser_snapshot"));
    expect(await Promise.all([f.controller.freshTab("bot-tab"), f.controller.freshTab("bot-tab")])).toEqual([true, true]);
    expect(f.reached).toEqual([{ tool: "agent_browser_tab_new", tab: "tab-new-1" }]);
  });
});

describe("the page check with tabs left to the owner", () => {
  it("never attaches to a skipped tab, and with only skipped tabs left it fails closed", async () => {
    const chrome = await fakeChrome();
    chrome.pages.push({ targetId: "tab-b", url: "about:blank" });
    const guard = new BrowserDocumentGuard(async () => { throw new Error("the engine is not asked"); }, { endpoint: chrome.endpoint });
    guards.push(guard);
    await expect(guard.protected(true, new Set(["tab-a"]))).resolves.toBe(false);
    expect(chrome.attached).toEqual(["tab-b"]);
    chrome.pages.splice(1, 1);
    await expect(guard.protected(true, new Set(["tab-a"]))).rejects.toThrow("Browser document inventory unavailable");
    expect(chrome.attached).toEqual(["tab-b"]);
  });
});
