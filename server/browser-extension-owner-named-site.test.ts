// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-OWNER-NAMED-SITE (1.0.19, design rev 4): Part 1 (an owner-named bare origin skips I1 on the first step of the turn),
// B1 (a no-values reason for a failed recipient scan) and B5 (the checker's verdict on the activity line). Row numbers are the
// design's test matrix. PASS rows and B1/B5 rows fail on the base; every CARD/refuse row passes on base and head.
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { createBrowserExtensionService, ownerNamedBareOrigin, ownerTurnText, OWNER_NAMED_TEXT_MAX } from "./browser-extension-service.ts";
import { MESSAGE_TEXT_MAX_BYTES } from "../shared/message-limits.ts";
import { GOOGLE_HOME_FORM_HTML } from "./testing/google-home-form.ts";
import { BrowserActivityStore, configureBrowserActivity, type BrowserActivityLine } from "./browser-extension-activity.ts";
import { INTENT_LINES } from "./browser-intent.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { duckduckgoHome, googleHome, h, page, pageFromHtml, realCollectFacts, runRecipientScan, type FakeNode } from "./testing/chat-dom-fixture.ts";

const cleanup: string[] = [];
const services: Awaited<ReturnType<typeof createBrowserExtensionService>>[] = [];
afterEach(async () => { configureBrowserActivity(undefined); for (const s of services.splice(0)) await s.close().catch(() => {}); for (const d of cleanup.splice(0)) await removeTempDir(d); });
type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
const VISIBLE = { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null };
const SEARCH_BOX = { tag: "input", type: "text", role: "combobox", name: "Search" };

type Opts = { ownerText?: string; turn?: { id: string; text: string } | null; startUrl?: string; mode?: "full" | "task" | "step"; routine?: boolean;
  history?: string[]; collectFacts?: unknown; checker?: () => string; allow?: boolean; siteSetting?: unknown; redirectTo?: string;
  /** Row 48c: what the target describes as (changed by the test after the card), and a hook run while the card is up. */ describe?: () => string; onCard?: () => void;
  /** Site cards answered Allow for exactly these origins (others: Never); action cards answered by `allowAction` when given. */
  allowSites?: string[]; allowAction?: (summary: string) => boolean;
  /** A fill that reaches the page writes its text into the fixture's field, as a real page would. */ onFill?: (text: string) => void;
  /** A click whose page navigates (a link): the engine asks for the new address as a synthetic admission, then navigates. */ clickNavigatesTo?: string;
  /** M1: the owner-instruction lookup throws once the call is running (after its fence is built). */ lookupFailsDuringCall?: boolean;
  /** Astra cons6 M2: the owner-instruction lookup finds no instruction once the call is running. */ lookupNoneDuringCall?: boolean;
  /** SEC-03: run while the checker is thinking (the owner changes the mode). */ duringCheck?: () => void;
  /** GrokBuild r3: run when admission reads the checker wiring: after the pre-decision recheck, before the decision (the wiring is not read on a prediction). */ onAdmission?: () => void;
  /** Astra cons10: run at the first command to the browser after admission read the wiring: the executor's wait before the navigate goes out. */ afterAdmission?: () => void };
async function harness(o: Opts = {}) {
  const { root, directory } = await privateTestDirectory(path.resolve(".service-")); cleanup.push(root);
  const activity = new BrowserActivityStore(path.join(directory, "activity")); configureBrowserActivity(activity);
  const start = new URL(o.startUrl ?? "about:blank");
  const tabs: Tab[] = [{ tabId: 1, navigationEpoch: 1, origin: o.startUrl ? start.origin : "null", url: o.startUrl ?? "about:blank" }];
  const calls: BrowserExtensionCommand[] = []; const cards: string[] = []; const sites: string[] = []; let turnCalls = 0;
  let generation = 1, state = "active", lookupFails = false, lookupNone = false, messageId = "m1", mode: "full" | "task" | "step" = o.mode ?? "full";
  const shownActions: Record<string, unknown>[] = []; let lookupThrew = 0, lookupMissed = 0, admissionSeen = false;
  /** Astra cons6 M1: run once while the site grant is being bound (the first open waits there). */ let onBind: (() => Promise<unknown>) | undefined;
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] }],
    async request(_p: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      if (admissionSeen && o.afterAdmission) { admissionSeen = false; o.afterAdmission(); }
      if (o.lookupFailsDuringCall && command.operation === "cdp") lookupFails = true;
      if (o.lookupNoneDuringCall && command.operation === "cdp") lookupNone = true;
      if (command.operation === "bind" && onBind) { const hook = onBind; onBind = undefined; await hook(); }
      let result: any = { generation, state, tabs };
      if (command.operation === "stop" || command.operation === "pause") { generation++; state = command.operation === "stop" ? "stopped" : "paused"; result = { generation, state, tabs }; }
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1, url: tabs[0]!.url }] };
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L" } } };
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === "DOM.getDocument") value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Page.getNavigationHistory") value = { currentIndex: 1, entries: [{ url: o.history?.[0] ?? "about:blank" }, { url: tabs[0]!.url }, { url: o.history?.[1] ?? "about:blank" }] };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : o.describe?.() ?? JSON.stringify({ tag: "INPUT", text: "" }) } };
        if (method === "Accessibility.getFullAXTree") value = { nodes: [] };
        const before = { ...tabs[0] };
        if (method === "Page.navigate") {
          const tab = tabs[0]!; const to = new URL(String(params.url)); tab.navigationEpoch++; tab.origin = to.origin; tab.url = to.href;
          await service.handleMessage("profile", { version: 1, type: "event", bindingId: command.bindingId, generation, event: "navigation", data: { tabId: 1, navigationEpoch: tab.navigationEpoch, origin: tab.origin, url: tab.url } });
        }
        result = { result: value, ...before };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const ownerText = o.ownerText ?? "open google.com";
  // Stage 1 answers ALLOW or FLAG; stage 2 answers the JSON verdict (as browser-extension-modes.test.ts fakes it).
  const transport = async (request: { model: string }) => {
    o.duringCheck?.();
    const r = o.checker?.() ?? '{"decision":"allow","reason":"Fine."}'; if (r === "down") throw new Error("engine busy");
    return request.model === "s1" ? (JSON.parse(r).decision === "allow" ? "ALLOW" : "FLAG") : r;
  };
  const options = {
    createEngine: (engine: import("./browser-extension-engine.ts").BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_open") {
          await engine.beforeDestination(String(args.url), document);
          if (o.redirectTo) await engine.beforeDestination(o.redirectTo, document);
          await engine.transport.send("Page.navigate", { url: o.redirectTo ?? args.url }, document); return { content: [{ type: "text", text: "opened" }] };
        }
        // Back as the real engine does it (browser-extension-engine.ts): the history entry is admitted as a destination, then navigated to.
        if (name === "agent_browser_back") {
          await engine.beforeDestination(o.history?.[0] ?? "about:blank", document); await engine.beforeCommand(document, "Runtime.evaluate", { expression: "history.back()" } as never);
          await engine.transport.send("Page.navigateToHistoryEntry", { entryId: 0 } as never, document); return { content: [{ type: "text", text: "went back" }] };
        }
        if (name === "agent_browser_click" && o.clickNavigatesTo) {
          await engine.beforeCommand(document, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 } as never); await engine.transport.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 } as never, document);
          await engine.beforeDestination(o.clickNavigatesTo, document); await engine.transport.send("Page.navigate", { url: o.clickNavigatesTo }, document);
          return { content: [{ type: "text", text: "clicked" }] };
        }
        const [method, params] = name === "agent_browser_fill" ? ["Input.insertText", { text: args.text }] : name === "agent_browser_press" ? ["Input.dispatchKeyEvent", { type: "keyDown", key: String(args.key) }] : name === "agent_browser_click" ? ["Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 1 }] : ["Accessibility.getFullAXTree", {}];
        await engine.beforeCommand(document, method as string, params as never); await engine.transport.send(method as string, params as never, document);
        if (name === "agent_browser_fill") o.onFill?.(String(args.text));
        return { content: [{ type: "text", text: "ok" }] };
      },
    }),
    collectFacts: o.collectFacts ?? (async (_io: unknown, _t: unknown, operation: string) => ({ operation, ...(operation === "press" ? { key: "Enter" } : {}), ...SEARCH_BOX, visibility: VISIBLE }) as never),
    broker, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    approvalMode: () => mode,
    ...(o.routine ? { routine: () => true } : {}),
    ...(o.siteSetting ? { siteSetting: o.siteSetting } : {}),
    // GrokBuild r3: not "busy", so a row matching a busy refusal can only match the real one; the counts prove the lookup really ran in its failing state.
    ownerInstruction: () => { if (lookupFails) { lookupThrew++; throw new Error("instruction store down"); } if (lookupNone) { lookupMissed++; return undefined; } return { id: messageId, text: ownerText }; },
    ownerTurnInstruction: () => { turnCalls++; return o.turn === null ? undefined : o.turn ?? { id: messageId, text: ownerText }; },
    checker: () => { o.onAdmission?.(); admissionSeen = true; return { deps: { transport, models: { stage1: "s1", stage2: "s2" } } }; },
    askSite: async (_c: unknown, origin: string) => { sites.push(origin); return (o.allowSites ? o.allowSites.includes(origin) : o.allow) ? "allow" as const : "never" as const; },
    askAction: async (_c: unknown, a: { summary: string }) => { cards.push(a.summary); shownActions.push({ ...a }); o.onCard?.(); return o.allowAction ? o.allowAction(a.summary) : o.allow === true; },
  };
  let service = await createBrowserExtensionService(options as never); services.push(service);
  let binding = await service.ensureBinding({ botId: "sable", threadId: "thread", profileId: "profile" });
  const dispatch = (name: string, args: Record<string, unknown> = {}) => service.dispatch(binding.bindingId, name, args, () => true);
  const tried = async (name: string, args: Record<string, unknown> = {}) => { try { await dispatch(name, args); return "done"; } catch (e) { return String((e as Error).message); } };
  /** M1 (restore): a restart of the same state file while the lookup throws, then the lookup works again. */
  const restart = async (failLookup: boolean) => {
    await service.close(); lookupFails = failLookup;
    service = await createBrowserExtensionService(options as never); services.push(service); lookupFails = false;
    binding = await service.ensureBinding({ botId: "sable", threadId: "thread", profileId: "profile" });
  };
  const navigated = () => calls.some(c => (c.params as any)?.method === "Page.navigate");
  const sent = (method: string) => calls.filter(c => (c.params as any)?.method === method).length;
  const log = (): BrowserActivityLine[] => activity.list({ botId: "sable" });
  // SABLE-B 1/4 (K1): under attended Full a new site's one ask is its site card, raised because the prediction saw the step would
  // card (here: I1). The site card's words are generic; an action card carrying the I1 line counts the same. Either way the owner
  // is asked, never a pass. (Astra rb2 Low 3: these rows prove an ask, not the I1 wording.)
  const i1Carded = (origin: string) => cards.some(c => c.includes(INTENT_LINES.I1)) || sites.includes(origin);
  return { get service() { return service; }, dispatch, tried, cards, sites, navigated, sent, log, i1Carded, turnCalls: () => turnCalls, carded: () => cards.length + sites.length,
    restart, newMessage: (id: string) => { messageId = id; },
    /** After a restart the binding is paused (connection_lost); the owner resumes it in Chrome, which reports `resumed` at a newer generation. */
    resume: async () => { generation++; state = "active"; await service.handleMessage("profile", { version: 1, type: "event", bindingId: binding.bindingId, generation, event: "resumed", data: { resumedAt: generation } } as never); }, shownActions, setMode: (next: typeof mode) => { mode = next; }, endLookupFailure: () => { lookupFails = false; lookupNone = false; }, startLookupFailure: () => { lookupFails = true; }, startLookupNone: () => { lookupNone = true; }, lookupThrew: () => lookupThrew, lookupMissed: () => lookupMissed,
    setOnBind: (hook: () => Promise<unknown>) => { onBind = hook; } };
}

describe("Part 1: ownerNamedBareOrigin (A2-A5)", () => {
  const rows: [string, string, string, boolean][] = [
    ["1", "open google.com", "https://google.com", true], ["2", "open google.com", "https://google.com/", true],
    ["3", "open Google", "https://google.com", false], ["4", "open google.com", "https://www.google.com", false],
    ["5", "open www.google.com", "https://google.com", false], ["6", "open notgoogle.com", "https://google.com", false],
    ["7", "open google.com.evil.net", "https://google.com", false], ["8", "open google.com", "https://google.com/search?q=murage", false],
    ["9", "open google.com", "https://google.com/#q=hunter2", false], ["10", "open evil.com", "https://hunter2@evil.com", false],
    ["11", "open google.com", "https://google.com:4443", false], ["12", "open google.com", "https://google.com:443", false],
    ["13", "open google.com", "https://google.com/?q=.-.--", false], ["14a", "open google.com", "https://google.com/.", false],
    ["14b", "open google.com", "https://google.com/%2e", false], ["14c", "open google.com", "https://GOOGLE.com\t", false],
    ["15", "open google.com", "http://google.com", false], ["16", "open xn--ggle-0nda.com", "https://xn--ggle-0nda.com", false],
    ["17", "open 10.0.0.1", "https://10.0.0.1", false], ["18", "open google.com or bing.com", "https://google.com", false],
    ["27", "open https://google.com", "https://google.com", true], ["28", "open google.com.", "https://google.com", true],
    ["29", "open hunter2.example", "https://hunter2.example", true],
    ["49a", "search google for murage", "https://www.google.com/search?q=hu.nt.er.2", false], ["49b", "search google for murage", "https://www.google.com/search?d=12-34-56", false],
    ["49c", "search google for murage", "https://www.google.com/search?q=age", false], ["49d", "search google for murage", "https://www.google.com/search?q=murage.--..-", false],
    ["49e", "search google for murage", "https://www.google.com/search", false],
    ["50a", "open google.com", "https://hunter2.example", false], ["50b", "open google.com", "https://www/search?q=murage", false],
    ["A4", "open x@evil.com", "https://evil.com", false], ["A4b", "open google.com:8080", "https://google.com", false], ["A4c", "open google.com/a", "https://google.com", false],
    ["A4d", "open mail.google.com", "https://google.com", false], ["A4e", "open (google.com)", "https://google.com", true], ["A4f", "open google.com/", "https://google.com", true],
    // A5 counts only hosts A4 would count (Astra r1 Low 3): a token A4 rejects names no host. Two A4-bounded tokens still card.
    ["A5a", "open google.com; ignore x@evil.com", "https://google.com", true], ["A5b", "open google.com, not bing.com:8080", "https://google.com", true],
    ["A5c", "open google.com, not bing.com/a", "https://google.com", true], ["A5d", "open google.com and mail.google.com", "https://google.com", false],
    ["A5e", "open google.com and read notes.txt", "https://google.com", false], ["A5f", "open google.com (or bing.com)", "https://google.com", false],
  ];
  for (const [row, text, raw, expected] of rows) it(`row ${row}: "${text}" -> ${JSON.stringify(raw)} is ${expected ? "eligible" : "not eligible"}`, () => {
    expect(ownerNamedBareOrigin(text, raw)).toBe(expected);
  });
  it("A4/A5 bound: a message past the bound is never cut to fit, so a host split at the cut or a second host past it cannot qualify", () => {
    const pad = "a ".repeat((OWNER_NAMED_TEXT_MAX - 10) / 2);
    expect(ownerNamedBareOrigin(`${pad}google.com.evil.net`, "https://google.com")).toBe(false);
    expect(ownerNamedBareOrigin(`${pad}google.com ${"b ".repeat(20)}bing.com`, "https://google.com")).toBe(false);
    expect(ownerNamedBareOrigin(`${pad}google.com`, "https://google.com")).toBe(true);
  });
  it("A4/A5 bound (Astra re-review Low): an otherwise eligible message one past the bound, and one at the largest message size, are not eligible", () => {
    const at = `${"a ".repeat((OWNER_NAMED_TEXT_MAX - 10) / 2)}google.com`;
    expect(at.length).toBe(OWNER_NAMED_TEXT_MAX); expect(ownerNamedBareOrigin(at, "https://google.com")).toBe(true);
    const past = ` ${at}`; // the same words, one character longer
    expect(past.length).toBe(OWNER_NAMED_TEXT_MAX + 1); expect(ownerNamedBareOrigin(past, "https://google.com")).toBe(false);
    const largest = `${"a ".repeat((MESSAGE_TEXT_MAX_BYTES - 10) / 2)}google.com`;
    expect(Buffer.byteLength(largest)).toBe(MESSAGE_TEXT_MAX_BYTES); expect(ownerNamedBareOrigin(largest, "https://google.com")).toBe(false);
  });
});

describe("A6: ownerTurnText, the production callback's rule (index.ts runs this function)", () => {
  type Msg = { id: string; role?: string; kind?: string; origin?: { kind: string }; text?: string };
  const owner = (o: { kind: string }) => o.kind === "desktop" || o.kind === "phone";
  const run = (message: Msg | undefined, turn: { triggerMessageId?: string; generation: unknown } | undefined = { triggerMessageId: "m1", generation: 4 }, active: unknown = 4) =>
    ownerTurnText(turn, active, id => (message && message.id === id ? message : undefined), owner);
  const good: Msg = { id: "m1", role: "user", kind: "text", origin: { kind: "desktop" }, text: "open google.com" };
  it("the owner's own text with an owner origin, from the running turn, is returned", () => { expect(run(good)).toEqual({ id: "m1", text: "open google.com" }); });
  it("row 23 / A6: a legacy message with no origin does not count", () => { expect(run({ ...good, origin: undefined })).toBeUndefined(); });
  it("A6: a message from another origin (a bot, a channel) does not count", () => { expect(run({ ...good, origin: { kind: "channel" } })).toBeUndefined(); });
  it("A6: a bot row, a non-text row and a blank text do not count", () => {
    expect(run({ ...good, role: "bot" })).toBeUndefined(); expect(run({ ...good, kind: "activity" })).toBeUndefined(); expect(run({ ...good, text: "   " })).toBeUndefined();
  });
  it("row 22 / A6: no running turn, no trigger id, a stale generation, or a missing row: undefined", () => {
    // Called directly: `run(good, undefined)` would take run's default turn (a default parameter replaces an explicit undefined).
    expect(ownerTurnText(undefined, 4, () => good, owner)).toBeUndefined(); expect(run(good, { generation: 4 })).toBeUndefined();
    expect(run(good, { triggerMessageId: "m1", generation: 3 })).toBeUndefined(); expect(run(undefined)).toBeUndefined();
  });
  it("A4/A5: the whole message is returned, never cut, so a host split at 20000 characters cannot qualify", () => {
    const text = `${"a ".repeat((OWNER_NAMED_TEXT_MAX - 10) / 2)}google.com.evil.net`;
    const out = run({ ...good, text });
    expect(out?.text).toBe(text);
    expect(ownerNamedBareOrigin(text.slice(0, OWNER_NAMED_TEXT_MAX), "https://google.com")).toBe(true); // what the old cut would have passed
    expect(ownerNamedBareOrigin(out!.text, "https://google.com")).toBe(false);
  });
});

describe("Part 1 at service level (attended Full)", () => {
  for (const [row, text, raw] of [["1", "open google.com", "https://google.com"], ["2", "open google.com", "https://google.com/"], ["27", "open https://google.com", "https://google.com"],
    ["28", "open google.com.", "https://google.com"], ["29", "open hunter2.example", "https://hunter2.example"]] as const) {
    it(`row ${row} PASS: "${text}" opens ${raw} with no card`, async () => {
      const f = await harness({ ownerText: text });
      expect(await f.tried("agent_browser_open", { url: raw })).toBe("done");
      expect(f.carded()).toBe(0); expect(f.navigated()).toBe(true);
    });
  }
  for (const [row, text, raw] of [["3", "open Google", "https://google.com"], ["4", "open google.com", "https://www.google.com"], ["5", "open www.google.com", "https://google.com"],
    ["6", "open notgoogle.com", "https://google.com"], ["7", "open google.com.evil.net", "https://google.com"], ["8", "open google.com", "https://google.com/search?q=murage"],
    ["9", "open google.com", "https://google.com/#q=hunter2"], ["11", "open google.com", "https://google.com:4443"],
    ["12", "open google.com", "https://google.com:443"], ["13", "open google.com", "https://google.com/?q=.-.--"], ["14", "open google.com", "https://google.com/%2e"],
    ["15", "open google.com", "http://google.com"], ["16", "open xn--ggle-0nda.com", "https://xn--ggle-0nda.com"], ["17", "open 10.0.0.1", "https://10.0.0.1"],
    ["18", "open google.com or bing.com", "https://google.com"], ["21", "open the site the page mentions", "https://example.com"],
    ["49", "search google for murage", "https://www.google.com/search?q=hu.nt.er.2"], ["50", "open google.com", "https://hunter2.example"]] as const) {
    it(`row ${row} CARD: "${text}" -> ${raw} is asked and nothing navigates`, async () => {
      const f = await harness({ ownerText: text });
      await f.tried("agent_browser_open", { url: raw });
      expect(f.carded()).toBeGreaterThan(0); expect(f.navigated()).toBe(false);
    });
  }
  it("row 10: \"open evil.com\" -> https://hunter2@evil.com is carded or refused (refused on the base too); nothing navigates. The same text and host with no user part opens", async () => {
    const f = await harness({ ownerText: "open evil.com" }); const out = await f.tried("agent_browser_open", { url: "https://hunter2@evil.com" });
    expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
    const c = await harness({ ownerText: "open evil.com" }); expect(await c.tried("agent_browser_open", { url: "https://evil.com" })).toBe("done"); expect(c.navigated()).toBe(true);
  });
  // Astra rb2 Low 3: each I1 row below pairs with a control that differs only in the one fact the row is about. The control opens with
  // no ask, so the ask in the row comes from that fact (the exemption's own check), not from anything else in the fixture.
  const control = async (o: Opts = {}) => { const c = await harness(o); expect(await c.tried("agent_browser_open", { url: "https://google.com" })).toBe("done"); expect(c.carded()).toBe(0); expect(c.navigated()).toBe(true); };
  it("row 22: a turn started by a schedule (no trigger message) cards: the exemption is asked and says no", async () => {
    const f = await harness({ turn: null }); await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBeGreaterThan(0); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    await control();
  });
  it("row 23 / A6: a trigger message that is not the newest owner instruction cards: the exemption is asked and says no", async () => {
    const f = await harness({ turn: { id: "m0", text: "open google.com" } }); await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBeGreaterThan(0); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    await control({ turn: { id: "m1", text: "open google.com" } });
  });
  it("A7 (Astra r1 Medium 2): a result delivered while the instruction lookup throws still marks the turn; the next open cards", async () => {
    const f = await harness({ startUrl: "https://example.com/", allowSites: ["https://example.com"], lookupFailsDuringCall: true });
    expect(await f.tried("agent_browser_snapshot")).toBe("done"); expect(f.lookupThrew()).toBeGreaterThan(0); f.endLookupFailure(); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    await control({ startUrl: "https://example.com/", allowSites: ["https://example.com", "https://google.com"] });
  });
  it("A7 (Astra cons6 M2): a result delivered while the instruction lookup finds none still marks the turn the call started under; the next open cards", async () => {
    const f = await harness({ startUrl: "https://example.com/", allowSites: ["https://example.com"], lookupNoneDuringCall: true });
    expect(await f.tried("agent_browser_snapshot")).toBe("done"); expect(f.lookupMissed()).toBeGreaterThan(0); f.endLookupFailure(); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    await control({ startUrl: "https://example.com/", allowSites: ["https://example.com", "https://google.com"] });
  });
  it("A7 (Astra cons6 M1): a result delivered while the first open waits on its site grant (a busy refusal whose lookup throws) ends the exemption; the open is refused, nothing navigates", async () => {
    const f = await harness(); let concurrent = "";
    f.setOnBind(async () => { f.startLookupFailure(); concurrent = await f.tried("agent_browser_snapshot"); f.endLookupFailure(); });
    const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(concurrent).toMatch(/busy/i); expect(f.lookupThrew()).toBeGreaterThan(0); expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
    // The retry is decided afresh: the auto grant never counts as owner-named (H2), so I1 asks.
    await f.tried("agent_browser_open", { url: "https://google.com" }); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    // Control: the same open with no concurrent result is exempt (row 1).
    const c = await harness(); expect(await c.tried("agent_browser_open", { url: "https://google.com" })).toBe("done"); expect(c.carded()).toBe(0);
  });
  it("A7 (Astra cons7 M): a busy refusal delivered while the first open waits on its site grant, whose lookup finds none, ends the exemption too; the open is refused, nothing navigates", async () => {
    const f = await harness(); let concurrent = "";
    f.setOnBind(async () => { f.startLookupNone(); concurrent = await f.tried("agent_browser_snapshot"); f.endLookupFailure(); });
    const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(concurrent).toMatch(/busy/i); expect(f.lookupMissed()).toBeGreaterThan(0); expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
    await f.tried("agent_browser_open", { url: "https://google.com" }); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
  });
  for (const [how, nextId] of [["under the same instruction", undefined], ["under a newer instruction id", "m2"]] as const) it(`A7 (GrokBuild r3 Medium): a result delivered ${how} while the first open is being decided ends the exemption; nothing navigates`, async () => {
    let f: Awaited<ReturnType<typeof harness>>; let fired = false, concurrent: Promise<string> = Promise.resolve("");
    f = await harness({ onAdmission: () => { if (fired) return; fired = true; if (nextId) f.newMessage(nextId); concurrent = f.tried("agent_browser_snapshot"); } });
    const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(fired).toBe(true); expect(await concurrent).toMatch(/busy/i); expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
    // GrokBuild r4: the turn really was marked: the retry is asked, never exempt.
    await f.tried("agent_browser_open", { url: "https://google.com" }); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
  });
  it("A7 (Astra cons10 M): a result delivered in the executor's wait after admission ends the exemption; the navigate never goes out", async () => {
    let f: Awaited<ReturnType<typeof harness>>; let fired = false, concurrent: Promise<string> = Promise.resolve("");
    f = await harness({ afterAdmission: () => { if (fired) return; fired = true; concurrent = f.tried("agent_browser_snapshot"); } });
    const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(fired).toBe(true); expect(await concurrent).toMatch(/busy/i); expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
    await f.tried("agent_browser_open", { url: "https://google.com" }); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
  });
  it("A7 (Astra cons11 M): a result delivered around a later destination's own admission does not refuse that destination: the check is only for the exempt address", async () => {
    // Admission reads the wiring 3 times, so the 4th read is the redirect's own admission, after the exempt open has been admitted.
    let f: Awaited<ReturnType<typeof harness>>; let reads = 0, concurrent: Promise<string> = Promise.resolve("");
    f = await harness({ redirectTo: "https://example.com/", allow: true, onAdmission: () => { if (++reads === 4) concurrent = f.tried("agent_browser_snapshot"); } });
    const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(reads).toBeGreaterThanOrEqual(4); expect(await concurrent).toMatch(/busy/i); expect(out).toBe("done"); expect(f.navigated()).toBe(true);
  });
  it("A7 (Astra cons10 L): a real id clears the unknown mark: a later owner message's first open is exempt again", async () => {
    const f = await harness({ startUrl: "https://example.com/", allowSites: ["https://example.com", "https://google.com"] });
    f.startLookupNone(); await f.tried("agent_browser_snapshot"); f.endLookupFailure();
    f.newMessage("m2"); await f.tried("agent_browser_snapshot");
    f.newMessage("m3"); expect(await f.tried("agent_browser_open", { url: "https://google.com" })).toBe("done");
    expect(f.carded()).toBe(0); expect(f.navigated()).toBe(true);
  });
  it("A7 (GrokBuild r3 High): a result delivered with no instruction at all marks the binding unknown; the first open of the owner's next message cards", async () => {
    const f = await harness({ startUrl: "https://example.com/", allowSites: ["https://example.com"] });
    f.startLookupNone(); expect(await f.tried("agent_browser_snapshot")).toBe("done"); expect(f.lookupMissed()).toBeGreaterThan(0);
    f.endLookupFailure(); f.newMessage("m2"); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
  });
  it("A7 (Astra r1 Medium 2, restore): a restart whose instruction lookup throws assumes the turn has seen outside content; the next open cards", async () => {
    // The restart ends the task, so the same message cannot use the exemption either way. The restore's mark shows on the owner's NEXT
    // message: a lookup that worked at restore recorded m1, so m2's first open is exempt (control); a lookup that threw must leave the
    // binding marked "seen, turn unknown", so m2's first open is asked (shepherd: this row fails on the pre-fix code).
    const run = async (lookupThrows: boolean) => {
      const f = await harness({ startUrl: "https://example.com/", allowSites: ["https://example.com"] });
      await f.tried("agent_browser_snapshot"); await f.restart(lookupThrows); f.newMessage("m2"); await f.resume();
      const out = await f.tried("agent_browser_open", { url: "https://google.com" });
      return { out, navigated: f.navigated(), asked: f.i1Carded("https://google.com") };
    };
    expect(await run(false)).toEqual({ out: "done", navigated: true, asked: false });
    const failed = await run(true);
    expect(failed.out).not.toBe("done"); expect(failed.navigated).toBe(false); expect(failed.asked).toBe(true);
  });
  // Astra cons6 Low 3: "settings save" is the production path (index.ts saves the mode, then calls settingsChanged, which bumps the
  // binding's revision so the call is no longer live); "mode only" is the bare mode change. GrokBuild r3: each arm does only its own
  // change, so the "settings save" arm is refused by the revision bump alone (the mode the fence read is unchanged).
  for (const how of ["mode only", "settings save"] as const) it(`B5 (Astra r1 Low 4, ${how}): a step refused because the owner changed the settings while the checker was thinking is on the activity line with the verdict`, async () => {
    let changed = false; let f: Awaited<ReturnType<typeof harness>>;
    f = await harness({ startUrl: "https://google.com/", allow: true, checker: () => '{"decision":"allow","reason":"Matches the request."}',
      duringCheck: () => { if (!changed) { changed = true; if (how === "settings save") void f.service.settingsChanged("sable"); else f.setMode("task"); } } });
    const out = await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" });
    expect(changed).toBe(true); expect(out).toMatch(/changed this browser's approval settings/);
    const fill = lineFor(f.log(), "fill").at(-1);
    expect(fill).toMatchObject({ decision: "not done", outcome: "denied" }); expect(fill!.checker).toMatchObject({ decision: "allow" });
    expect(f.sent("Input.insertText")).toBe(0);
  });
  it("A2 (Astra rb2 Low 2): the card gets the canonical action; the bot's own spelling (botUrl) never reaches askAction", async () => {
    // An open that carries data always gets an action card (I6), and the open is the one call that carries the bot's spelling.
    const f = await harness({ ownerText: "search google for approved", allowSites: ["https://www.google.com"], allowAction: () => false });
    await f.tried("agent_browser_open", { url: "https://WWW.google.com/search?q=approved" });
    expect(f.shownActions.length).toBeGreaterThan(0); expect(f.cards.some(c => c.includes(I6_GOOGLE_HOST))).toBe(true);
    // GrokBuild r3: not just the key: the bot's spelling is nowhere in what the card is given, under any field.
    for (const shown of f.shownActions) { expect(shown).not.toHaveProperty("botUrl"); expect(JSON.stringify(shown)).not.toContain("WWW.google.com"); }
    expect(f.navigated()).toBe(false);
  });
  it("row 24: a routine is refused or carded as today", async () => {
    const f = await harness({ routine: true }); const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.navigated()).toBe(false); expect(out).not.toBe("done");
  });
  for (const mode of ["step", "task"] as const) it(`row 25: ${mode} mode cards as today`, async () => {
    const f = await harness({ mode }); await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.carded()).toBeGreaterThan(0); expect(f.navigated()).toBe(false);
  });
  it("row 26: a site set to Never is refused as today", async () => {
    const f = await harness({ siteSetting: () => ({ rule: "never" }) }); const out = await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(out).not.toBe("done"); expect(f.navigated()).toBe(false);
  });
  it("rows 19 + 53: the exemption is used once; a second open on the same tab is decided as today, the exemption not consulted", async () => {
    const f = await harness();
    expect(await f.tried("agent_browser_open", { url: "https://google.com" })).toBe("done");
    const used = f.turnCalls();
    expect(await f.tried("agent_browser_open", { url: "https://google.com" })).toBe("done");
    expect(f.turnCalls()).toBe(used); expect(f.carded()).toBe(0);
  });
  it("row 20: after any browser result this turn (a tab list), the exemption is not used and I1 cards", async () => {
    const f = await harness({ startUrl: "https://example.com/" });
    await f.tried("agent_browser_tab_list"); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.i1Carded("https://google.com")).toBe(true); expect(f.navigated()).toBe(false);
    await control({ startUrl: "https://example.com/" });
  });
  it("row 20 (refusal): a refused first step still marks the turn", async () => {
    const f = await harness({ startUrl: "https://example.com/" });
    await f.tried("agent_browser_open", { url: "https://hunter2.example/x" }); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.navigated()).toBe(false);
  });
  it("row 20b: already on google.com, a snapshot then an open keeps today's decision (same origin, no I1); exemption not consulted", async () => {
    const f = await harness({ startUrl: "https://google.com/", allow: true });
    await f.tried("agent_browser_snapshot"); const before = f.turnCalls();
    await f.tried("agent_browser_open", { url: "https://google.com" });
    expect(f.turnCalls()).toBe(before); expect(f.cards.some(c => c.includes(INTENT_LINES.I1))).toBe(false);
  });
  it("row 51 / A0: Back to a bare google.com history entry never qualifies", async () => {
    const f = await harness({ startUrl: "https://example.com/", history: ["https://google.com"] });
    await f.tried("agent_browser_back");
    expect(f.carded()).toBeGreaterThan(0); expect(f.navigated()).toBe(false);
  });
  // Rows 51 and 57 (Astra r1 Medium 5): the site card for www.google.com is answered Allow, so the card the row is about is the action
  // card itself, read by its line; the owner denies it and nothing navigates. The exemption is never consulted (A0).
  const I6_GOOGLE = INTENT_LINES.I6("www.google.com");
  it("row 51b: Back to a search history entry cards with the I6 line; nothing before the owner's Allow", async () => {
    const f = await harness({ ownerText: "search google for approved or denied", startUrl: "https://example.com/", history: ["https://www.google.com/search?q=approved"],
      allowSites: ["https://example.com", "https://www.google.com"], allowAction: () => false });
    await f.tried("agent_browser_back");
    expect(f.cards.some(c => c.includes(I6_GOOGLE))).toBe(true); expect(f.turnCalls()).toBe(0); expect(f.navigated()).toBe(false);
    expect(f.sent("Page.navigateToHistoryEntry")).toBe(0);
    // Control (Astra cons6 M4): the same Back with the card allowed does reach the history entry, so the 0 above is the card.
    const c = await harness({ ownerText: "search google for approved or denied", startUrl: "https://example.com/", history: ["https://www.google.com/search?q=approved"],
      allowSites: ["https://example.com", "https://www.google.com"], allowAction: () => true });
    await c.tried("agent_browser_back"); expect(c.sent("Page.navigateToHistoryEntry")).toBe(1);
  });
  it("row 51a: a click on a page link to a search URL cards with the I6 line; nothing before the owner's Allow", async () => {
    const link = h("a", { href: "https://www.google.com/search?q=approved" }, "results"); page(h("main", {}, link));
    const run = (allowAction: (s: string) => boolean) => harness({ ownerText: "search google for approved or denied", startUrl: "https://example.com/", collectFacts: realCollectFacts(() => link),
      clickNavigatesTo: "https://www.google.com/search?q=approved", allowSites: ["https://example.com", "https://www.google.com"], allowAction,
      // Astra cons6 M4: the target describes itself as the link it is, so the click's own admission sees where it goes.
      describe: () => JSON.stringify({ display: { tag: "A", text: "results", href: "https://www.google.com/search?q=approved" }, priv: { href: "https://www.google.com/search?q=approved" } }) });
    const f = await run(s => !s.includes(I6_GOOGLE));
    await f.tried("agent_browser_click", { selector: "a" });
    expect(f.cards.some(c => c.includes(I6_GOOGLE))).toBe(true); expect(f.turnCalls()).toBe(0); expect(f.navigated()).toBe(false);
    expect(f.sent("Input.dispatchMouseEvent")).toBe(0); // carded before the click reaches the page
    // Control (GrokBuild r3): the same click with the card allowed does reach the page, so the 0 above is the card.
    const c = await run(() => true); await c.tried("agent_browser_click", { selector: "a" }); expect(c.sent("Input.dispatchMouseEvent")).toBe(1);
  });
  it("row 57 / A0: the first step is a click whose page redirects to https://google.com (a synthetic admission): asked as today, the exemption never consulted", async () => {
    const f = await harness({ startUrl: "https://example.com/", clickNavigatesTo: "https://google.com", allowSites: ["https://example.com"], allowAction: s => !/google/i.test(s) });
    await f.tried("agent_browser_click", { selector: "a" });
    expect(f.sites).toContain("https://google.com"); // the redirect reached its own admission and was asked
    expect(f.turnCalls()).toBe(0); expect(f.navigated()).toBe(false);
  });
});

const lineFor = (log: BrowserActivityLine[], action: string) => log.filter(l => l.action === action);
const I6_GOOGLE_HOST = INTENT_LINES.I6("www.google.com");
const denyUnknown = (s: string) => !s.includes(INTENT_LINES.I2_UNKNOWN);
describe("B1: the no-values scan reason", () => {
  it("row 30: the saved google.com page fails the scan and names why, with no values", () => {
    const g = googleHome();
    const out = runRecipientScan(g.q, "press", "Enter") as { incomplete: boolean; reason?: Record<string, number> };
    expect(out.incomplete).toBe(true);
    // GrokBuild r3: the whole object, so a page value can never appear as a key.
    expect(out.reason).toEqual({ "unclassified-field": 3 });
  });
  it("row 30 (real markup, Astra r1 Medium 5): google.com's search form as the server sent it fails the scan from its q box and names why, with no values", () => {
    const p = pageFromHtml(GOOGLE_HOME_FORM_HTML);
    const q = p.all().find(n => n.localName === "textarea" && n.attrs.name === "q")!;
    expect(q.form?.attrs.action).toBe("/search");
    const out = runRecipientScan(q, "press", "Enter") as { incomplete: boolean; reason?: Record<string, number> };
    expect(out.incomplete).toBe(true);
    // Astra cons6 Low 5: the cause is pinned (a traversal that threw would show `throw` and fail here).
    expect(out.reason).toEqual({ "select-unread": 1, "unclassified-field": 14 });
    expect(JSON.stringify(out.reason)).not.toMatch(/btnI|iflsig|source|Lucky|google|VALUE|Canvas|Create|\bq\b/i);
    const button = p.all().find(n => n.attrs.name === "btnK")!;
    expect((runRecipientScan(button, "click") as { incomplete: boolean }).incomplete).toBe(true);
  });
  it("row 54 fixture: duckduckgo.com's home page also fails the scan, with a reason", () => {
    const d = duckduckgoHome(); const out = runRecipientScan(d.q, "press", "Enter") as { incomplete: boolean; reason?: Record<string, number> };
    expect(out.incomplete).toBe(true); expect(Object.keys(out.reason ?? {}).length).toBeGreaterThan(0);
  });
  it("row 31: Enter on google.com cards I2_UNKNOWN before any key event; the activity line carries the reason, no values", async () => {
    const g = googleHome(); let current: FakeNode = g.q;
    const f = await harness({ startUrl: "https://google.com/", collectFacts: realCollectFacts(() => current) });
    await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" });
    const out = await f.tried("agent_browser_press", { key: "Enter" });
    expect(out).not.toBe("done"); expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true);
    expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
    const press = lineFor(f.log(), "press").at(-1)!;
    expect(press.recipientScanReason?.reasons).toContain("unclassified-field");
    expect(JSON.stringify(press.recipientScanReason)).not.toMatch(/murage|btn|Lucky|google/i);
  });
  it("row 32: clicking Google Search cards I2_UNKNOWN before the mouse press", async () => {
    const g = googleHome();
    const f = await harness({ startUrl: "https://google.com/", collectFacts: realCollectFacts(() => g.searchButton) });
    expect(await f.tried("agent_browser_click", { selector: "input[name=btnK]" })).not.toBe("done");
    expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true); expect(f.sent("Input.dispatchMouseEvent")).toBe(0);
  });
  it("row 55: I'm Feeling Lucky cards I2_UNKNOWN; nothing submitted", async () => {
    const g = googleHome();
    const f = await harness({ startUrl: "https://google.com/", collectFacts: realCollectFacts(() => g.lucky) });
    expect(await f.tried("agent_browser_click", { selector: "input[name=btnI]" })).not.toBe("done");
    expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true); expect(f.sent("Input.dispatchMouseEvent")).toBe(0);
  });
  // Rows 54, 56, 45+47 (Astra r1 Medium 5): the fill reaches the fixture (onFill writes the field), so the press is decided on the page
  // the bot actually typed into. Only I2_UNKNOWN cards are denied (denyUnknown, module scope: B5 row 46 uses it too).
  it("row 54: duckduckgo !bang Enter cards I2_UNKNOWN; nothing submitted", async () => {
    const d = duckduckgoHome();
    const f = await harness({ startUrl: "https://duckduckgo.com/", collectFacts: realCollectFacts(() => d.q), allowSites: ["https://duckduckgo.com"], allowAction: denyUnknown, onFill: text => { d.q.attrs.value = text; } });
    expect(await f.tried("agent_browser_fill", { selector: "#searchbox_input", text: "!w approved" })).toBe("done");
    expect(d.q.attrs.value).toBe("!w approved");
    expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done");
    expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true); expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
  });
  for (const [kind, tool, args, input] of [["Enter", "agent_browser_press", { key: "Enter" }, "Input.dispatchKeyEvent"], ["mouse", "agent_browser_click", { selector: "input[name=btnK]" }, "Input.dispatchMouseEvent"]] as const) {
    it(`row 48c (${kind}): the owner allows the press card, then the form is replaced before the input: the executor refuses, nothing reaches the page`, async () => {
      const g = googleHome(); let current: FakeNode = kind === "Enter" ? g.q : g.searchButton; let shape = JSON.stringify({ tag: "INPUT", text: "" });
      const f = await harness({ startUrl: "https://google.com/", allow: true, collectFacts: realCollectFacts(() => current), describe: () => shape,
        onCard: () => { const other = googleHome(); const q = h("input", { type: "email", name: "to", "aria-label": "To" }); page(h("form", { action: "/send", method: "POST" }, q, other.searchButton)); current = q; shape = JSON.stringify({ tag: "INPUT", text: "To" }); } });
      const out = await f.tried(tool, args as Record<string, unknown>);
      expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true);
      expect(out).toMatch(/(target|recipients) changed/i); expect(f.sent(input)).toBe(0);
    });
  }
  it("row 56: the bot types murage, the page swaps the value to approved just before the Enter is admitted: decided on the swapped page, I2_UNKNOWN, no key event", async () => {
    const g = googleHome(); const real = realCollectFacts(() => g.q); const seenAtPress: string[] = [];
    const collectFacts = async (io: unknown, target: unknown, operation: string, extra?: Record<string, unknown>) => {
      if (operation === "press") { g.q.attrs.value = "approved"; seenAtPress.push(g.q.value); }
      return real(io, target, operation, extra);
    };
    const f = await harness({ startUrl: "https://google.com/", collectFacts, allowSites: ["https://google.com"], allowAction: denyUnknown, onFill: text => { g.q.attrs.value = text; } });
    expect(await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" })).toBe("done");
    expect(g.q.attrs.value).toBe("murage");
    expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done");
    expect(seenAtPress.length).toBeGreaterThan(0); expect(seenAtPress.every(v => v === "approved")).toBe(true);
    expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true); expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
  });
  // GrokBuild r3 High: on the google form both values fail the scan on structure, so row 56 cannot tell a decision on the swapped page from one on
  // the typed value. Here the value is what the card shows, so a decision on anything but the page as it stands at the Enter shows the wrong address.
  it("row 56b: a value-only swap just before the Enter is what the card is decided on: the card names the swapped recipient, never the earlier one", async () => {
    const run = async (swap: boolean) => {
      const to = h("input", { name: "to", type: "email", value: "friend@ok.example" }); page(h("form", {}, to));
      const real = realCollectFacts(() => to);
      const collectFacts = async (io: unknown, target: unknown, operation: string, extra?: Record<string, unknown>) => {
        if (swap && operation === "press") to.attrs.value = "stranger@evil.example";
        return real(io, target, operation, extra);
      };
      const f = await harness({ startUrl: "https://mail.example/", collectFacts, allowSites: ["https://mail.example"], allowAction: () => false });
      expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done"); expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
      return f.cards;
    };
    const swapped = await run(true);
    expect(swapped.some(c => c.includes("stranger@evil.example"))).toBe(true); expect(swapped.some(c => c.includes("friend@ok.example"))).toBe(false);
    // Control: with no swap the card names the address that was there.
    expect((await run(false)).some(c => c.includes("friend@ok.example"))).toBe(true);
  });
  it("row 44: a named recipient on a send form keeps the I2 named card", async () => {
    const to = h("input", { name: "to", type: "email", value: "stranger@evil.example" }); const send = h("button", { type: "submit", "aria-label": "Send" }, "Send");
    page(h("form", {}, to, send));
    const f = await harness({ startUrl: "https://mail.example/", collectFacts: realCollectFacts(() => send) });
    await f.tried("agent_browser_click", { selector: "button" });
    expect(f.cards.some(c => c.includes("stranger@evil.example"))).toBe(true); expect(f.sent("Input.dispatchMouseEvent")).toBe(0);
  });
  for (const mode of ["step", "task"] as const) it(`row 33: Enter on google.com in ${mode} mode cards as today`, async () => {
    const g = googleHome();
    const f = await harness({ mode, startUrl: "https://google.com/", collectFacts: realCollectFacts(() => g.q) });
    expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done"); expect(f.carded()).toBeGreaterThan(0); expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
  });
  it("row 33: a routine pressing Enter on google.com is refused", async () => {
    const g = googleHome();
    const f = await harness({ routine: true, startUrl: "https://google.com/", collectFacts: realCollectFacts(() => g.q) });
    expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done"); expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
  });
  it("rows 45 + 47: blank tab, open google.com (no card), then Enter four times: card, card, then the I7 refusal (hits latch at 3); no hand-over; the password field is still refused", async () => {
    const g = googleHome(); let current: FakeNode = g.q;
    const f = await harness({ collectFacts: realCollectFacts(() => current), checker: () => "down", allowAction: denyUnknown, onFill: text => { g.q.attrs.value = text; } });
    expect(await f.tried("agent_browser_open", { url: "https://google.com" })).toBe("done"); expect(f.carded()).toBe(0); expect(f.navigated()).toBe(true);
    // Type, then Enter, four times. After each press: how many I2_UNKNOWN cards so far (the hits tally: 1, 2, then I7 latches at 3).
    const outs: string[] = [], unknownCards: number[] = [];
    for (let k = 0; k < 4; k++) {
      const typed = await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: `murage ${k}` });
      if (k === 0) { expect(typed).toBe("done"); expect(g.q.attrs.value).toBe("murage 0"); }
      outs.push(await f.tried("agent_browser_press", { key: "Enter" }));
      unknownCards.push(f.cards.filter(c => c.includes(INTENT_LINES.I2_UNKNOWN)).length);
    }
    expect(outs.every(o => o !== "done")).toBe(true);
    expect(unknownCards).toEqual([1, 2, 2, 2]);
    expect(outs[0]).not.toContain(INTENT_LINES.I7); expect(outs[1]).not.toContain(INTENT_LINES.I7);
    expect(outs[2]).toContain(INTENT_LINES.I7); expect(outs[3]).toContain(INTENT_LINES.I7);
    expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
    expect(f.service.status().bindings[0]!.state).toBe("active");
    // The search fills reached the page; the password fill must add none.
    const typedBefore = f.sent("Input.insertText"); expect(typedBefore).toBeGreaterThan(0);
    const pw = h("input", { type: "password", name: "pw" }); page(h("form", {}, pw)); current = pw;
    expect(await f.tried("agent_browser_fill", { selector: "input[name=pw]", text: "hunter2" })).not.toBe("done");
    expect(f.sent("Input.insertText")).toBe(typedBefore);
  });
  it("row 47 navigation: blank tab, 'open google.com' opens with no card (Part 1)", async () => {
    const f = await harness({ checker: () => "down" });
    expect(await f.tried("agent_browser_open", { url: "https://google.com" })).toBe("done"); expect(f.carded()).toBe(0); expect(f.navigated()).toBe(true);
  });
});

describe("B5: the checker's verdict on the activity line", () => {
  it("row 52: with the tally latched by three blocks, an ask and an outage are advisory, never a pause, and both are logged", async () => {
    let verdict = '{"decision":"block","reason":"Not what the owner asked."}';
    // Control (Astra r1 Medium 5): the same three blocks really latch the tally. Outside attended Full nothing makes the next step
    // advisory, so the latched tally pauses it (decide.ts:140) and nothing is typed. Under attended Full (below) the same latch never pauses.
    let controlVerdict = '{"decision":"block","reason":"Not what the owner asked."}';
    const c = await harness({ mode: "task", startUrl: "https://google.com/", allow: true, checker: () => controlVerdict });
    for (let k = 0; k < 3; k++) await c.tried("agent_browser_fill", { selector: "textarea[name=q]", text: `x${k}` });
    controlVerdict = '{"decision":"ask","reason":"Not sure."}'; const typedBefore = c.sent("Input.insertText");
    expect(await c.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" })).not.toBe("done");
    expect(c.sent("Input.insertText")).toBe(typedBefore); expect(c.service.status().bindings[0]!.state).not.toBe("active");
    let judged = 0;
    const f = await harness({ startUrl: "https://google.com/", allow: true, checker: () => { judged++; return verdict; } });
    const blocked: string[] = [];
    for (let k = 0; k < 3; k++) blocked.push(await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: `x${k}` }));
    expect(blocked.every(o => o !== "done")).toBe(true);
    expect(lineFor(f.log(), "fill").map(l => l.checker && { decision: l.checker.decision, outcome: l.checker.outcome, advisory: l.checker.advisory }))
      .toEqual([0, 1, 2].map(() => ({ decision: "block", outcome: "refuse", advisory: false })));
    verdict = '{"decision":"ask","reason":"Not sure."}';
    expect(await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage" })).toBe("done");
    verdict = "down";
    expect(await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage 2" })).toBe("done");
    expect(f.service.status().bindings[0]!.state).toBe("active");
    const fills = lineFor(f.log(), "fill");
    const ask = fills.at(-2)!.checker!, down = fills.at(-1)!.checker!;
    expect(ask).toMatchObject({ decision: "allow", original: "ask", advisory: true, outcome: "pass" });
    expect(down).toMatchObject({ decision: "allow", original: "block", code: "checker_unavailable", advisory: true });
    expect(fills[0]!.checker).toMatchObject({ decision: "block", original: "block", advisory: false, outcome: "refuse" });
    expect(ask.reason.length).toBeLessThanOrEqual(300);
    // Astra cons6 Low 6: this Full binding's own tally is latched and the ask and the outage left it latched: outside attended Full the very
    // next step pauses on it (decide.ts:140) and nothing is typed. Astra cons7 L: the checker would allow this step and is never asked, so the
    // pause can only come from the latch the three Full blocks left, not from a block this probe adds.
    verdict = '{"decision":"allow","reason":"Fine."}'; const judgedAtLatch = judged;
    f.setMode("task"); const typedAtLatch = f.sent("Input.insertText");
    expect(await f.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage 3" })).not.toBe("done");
    expect(judged).toBe(judgedAtLatch);
    expect(f.sent("Input.insertText")).toBe(typedAtLatch); expect(f.service.status().bindings[0]!.state).not.toBe("active");
    // Control (GrokBuild r3): the same Full binding with only two blocks is not latched: flipped to task mode, the checker IS asked, so the
    // refusal above is the third block's latch and not task mode refusing every fill.
    let openVerdict = '{"decision":"block","reason":"Not what the owner asked."}', openJudged = 0;
    const u = await harness({ startUrl: "https://google.com/", allow: true, checker: () => { openJudged++; return openVerdict; } });
    for (let k = 0; k < 2; k++) await u.tried("agent_browser_fill", { selector: "textarea[name=q]", text: `x${k}` });
    openVerdict = '{"decision":"allow","reason":"Fine."}'; const judgedOpen = openJudged; u.setMode("task");
    expect(await u.tried("agent_browser_fill", { selector: "textarea[name=q]", text: "murage 3" })).toBe("done");
    expect(openJudged).toBeGreaterThan(judgedOpen); expect(u.service.status().bindings[0]!.state).toBe("active");
  });
  for (const [kind, answer, original, code] of [["ask", '{"decision":"ask","reason":"Not sure."}', "ask", undefined], ["outage", "down", "block", "checker_unavailable"]] as const) {
    it(`row 46 (${kind}): the checker never lifts the I2_UNKNOWN card on the google press; no pause; its verdict is on the press line`, async () => {
      const g = googleHome();
      const f = await harness({ startUrl: "https://google.com/", collectFacts: realCollectFacts(() => g.q), checker: () => answer, allowSites: ["https://google.com"], allowAction: denyUnknown });
      expect(await f.tried("agent_browser_press", { key: "Enter" })).not.toBe("done");
      expect(f.cards.some(c => c.includes(INTENT_LINES.I2_UNKNOWN))).toBe(true); expect(f.service.status().bindings[0]!.state).toBe("active");
      expect(f.sent("Input.dispatchKeyEvent")).toBe(0);
      const press = lineFor(f.log(), "press").at(-1)!;
      expect(press.checker).toMatchObject({ decision: "allow", advisory: true, original, ...(code ? { code } : {}) });
    });
  }
});
