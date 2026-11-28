// SPDX-License-Identifier: AGPL-3.0-or-later
// PAYFULL A6/A7/A9 (owner q1024-paybuild): the Full-access pay card on the real extension path. Every row enters through
// service.dispatch (browser-extension-service.ts dispatch -> executor call -> S4 floor -> S5 decision -> engine -> beforeCommand ->
// the CDP Input command the broker receives = the page's click), or through BrowserExtensionIntegration's constructor (startup).
// The card module is loaded dynamically: on a base without it the service gets no flow and the step hands off, so a base run
// reaches the behavioural assertion (card shown, one click, record state) instead of failing at import.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { classifyFloor } from "./browser-floor.ts";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import { BrowserExtensionIntegration } from "./browser-extension-integration.ts";
import type { FloorFacts } from "./browser-floor.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const brokerSlot = vi.hoisted(() => ({ value: undefined as unknown }));
// Only BrowserExtensionIntegration.start() (W-LIVE-OFF) opens the broker module; the service fixture passes its broker in directly.
vi.mock("./browser-extension-broker.ts", () => ({ startBrowserExtensionBroker: async () => brokerSlot.value }));
const PAY_PAGE_SOURCE = (await import("./pay-card.ts").catch(() => ({ PAY_PAGE_EXPRESSION: "" }))).PAY_PAGE_EXPRESSION;
const payModule = await import("./pay-card.ts").catch(() => undefined) as undefined | typeof import("./pay-card.ts");
const payNow: FloorFacts = { operation: "click", tag: "button", role: "button", name: "Pay now" };
const OWNER = "buy the USB-C cable on fixture.test";
type Page = { title: string; order: string; amounts: { label: string; value: string }[]; digest: string };
const cartPage = (): Page => ({ title: "Fixture Shop", order: "USB-C cable Qty: 1,000", amounts: [{ label: "Total due today", value: "$42.99" }], digest: "d1" });

const cleanup: string[] = [];
const services: { close(): Promise<void> }[] = [];
const integrations: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const integration of integrations.splice(0)) await integration.close().catch(() => {}); for (const service of services.splice(0)) await service.close().catch(() => {}); for (const directory of cleanup.splice(0)) await removeTempDir(directory); });

type Turn = { generation: string; ownerTyped: boolean; ownerAudience: boolean; notOwnerAudience: boolean; emailMark: boolean };
async function fixture(opts: { owner?: string; turn?: Partial<Turn>; mode?: "full" | "task" | "step"; page?: Page; facts?: FloorFacts; answer?: (card: { summary: string }, f: { page: Page; setLoader(v: string): void; setMode(v: "full" | "task" | "step"): void; turn: Turn; stop(): Promise<void> }) => Promise<"allow" | "deny" | "waiting" | "cancelled"> | "allow" | "deny" | "waiting" | "cancelled"; engineClicks?: number; beforeSave?: () => void; siteRule?: "allow" | "ask" | "never"; onHitTest?: (f: { setPage(p: Page): void }, n: number) => void; routine?: boolean; throwAfterClick?: boolean; onGuardInstall?: (f: { setMode(v: "full" | "task" | "step"): void; turn: Turn }) => void; onPageRead?: (n: number, f: { setMode(v: "full" | "task" | "step"): void; turn: Turn }) => void; factsAt?: (n: number) => FloorFacts | "throw" | undefined; pageText?: string; engineTouch?: boolean; hitClear?: (n: number) => boolean } = {}) {
  const { root, directory } = await privateTestDirectory(path.resolve(".pay-card-")); cleanup.push(root);
  const bindings = new Map<string, { generation: number; state: string; tabs: { tabId: number; navigationEpoch: number; origin: string; url: string }[] }>();
  let page: Page = opts.page ?? cartPage();
  let loader = "L1"; let mode = opts.mode ?? "full";
  const turn: Turn = { generation: "7", ownerTyped: true, ownerAudience: true, notOwnerAudience: false, emailMark: false, ...opts.turn };
  let pageReads = 0; let hitTests = 0; let factCollects = 0; let hitN = 0; const releases: number[] = [];
  const pageClicks: number[] = []; const cards: string[] = []; const rows: string[] = []; const handoffs: string[] = []; let actionCards = 0;
  const payFile = path.join(directory, "pay-cards.json");
  const stateAtInput: (string | undefined)[] = [];
  let service!: Awaited<ReturnType<typeof createBrowserExtensionService>>;
  const control = { page, setLoader: (v: string) => { loader = v; }, setMode: (v: typeof mode) => { mode = v; }, turn, stop: async () => { await service.stop?.((service.status().bindings[0] as { bindingId: string }).bindingId); } };
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "pay_hold_v1", "pay_hold_v2"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/checkout" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: any = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: loader } } };
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === "DOM.getDocument") value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-page")) opts.onPageRead?.(++pageReads, control);
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("murage-pay-page") ? (opts.pageText !== undefined ? runPayPage(String(params.expression), opts.pageText) : JSON.stringify(page)) : String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        const pressGuard = method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("murage-pay-press-guard");
        if (method === "Runtime.callFunctionOn" && !pressGuard && String(params.functionDeclaration).includes("elementFromPoint")) { hitN++; opts.onHitTest?.({ setPage: (p: Page) => { page = p; } }, ++hitTests); }
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? (opts.hitClear ? opts.hitClear(hitN) : true) : JSON.stringify({ display: { tag: "BUTTON", role: "button", text: "Pay now", label: "Pay now" }, bound: null }) } };
        // J16 (q1024-payguard-fable): this fixture has no page, so the press guard is stood in for: it holds the page read and the description of
        // the moment, arms, and reports the click it was sent. The guard itself is witnessed in real Chromium (pay-press-guard-realbrowser-1024).
        if (pressGuard) opts.onGuardInstall?.(control);
        if (pressGuard) value = { result: { value: JSON.stringify({ ok: true, page: opts.pageText !== undefined ? runPayPage(PAY_PAGE_SOURCE, opts.pageText) : JSON.stringify(page), shape: JSON.stringify({ display: { tag: "BUTTON", role: "button", text: "Pay now", label: "Pay now" }, bound: null }) }) } };
        if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-press-arm")) value = { result: { value: true } };
        if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-press-report")) value = { result: { value: JSON.stringify({ state: releases.length ? "pressed" : "armed", passed: pageClicks.length + releases.length }) } };
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") releases.push(1);
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
          pageClicks.push(1);
          try { stateAtInput.push((JSON.parse(readFileSync(payFile, "utf8")).records as { state: string }[]).at(-1)?.state); } catch { stateAtInput.push(undefined); }
        }
        result = { result: value, ...b.tabs[0] };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const flow = payModule ? new payModule.PayCardFlow({ file: payFile, row: (_record, text) => { rows.push(text); }, ...(opts.beforeSave ? { beforeSave: opts.beforeSave } : {}) }) : undefined;
  service = await createBrowserExtensionService({
    broker: broker as never, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    collectFacts: async () => { const swapped = opts.factsAt?.(++factCollects); if (swapped === "throw") throw new Error("the page could not be read"); return { ...((swapped ?? opts.facts ?? payNow) as object), visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } } as never; },
    onHandoff: (info: { text: string }) => { handoffs.push(info.text); },
    createEngine: (engine: any) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") {
          if (opts.engineTouch) { const params = { objectId: "target", functionDeclaration: "function(){this.click()}" }; await engine.beforeCommand(document, "Runtime.callFunctionOn", params); await engine.transport.send("Runtime.callFunctionOn", params, document); }
          for (let i = 0; i < (opts.engineClicks ?? 1); i++) {
            for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); }
          }
          if (opts.throwAfterClick) throw new Error("the engine died after the click");
          return { content: [{ type: "text", text: "clicked" }] };
        }
        return { content: [] };
      },
    }) as never,
    askSite: async () => "allow" as const, askAction: async () => { actionCards++; return true; },
    approvalMode: () => mode,
    ...(opts.routine ? { routine: () => true } : {}),
    ...(opts.siteRule ? { siteSetting: () => ({ rule: opts.siteRule }) } : {}),
    ownerInstruction: () => ({ id: "m1", text: opts.owner ?? OWNER }),
    ownerTurnInstruction: () => ({ id: "m1", text: opts.owner ?? OWNER }),
    ...(flow ? { payFlow: flow } : {}),
    payTurn: () => ({ ...turn }),
    askPay: async (_context: unknown, card: { summary: string }) => { cards.push(card.summary); return opts.answer ? await opts.answer(card, control) : "allow"; },
  } as never);
  services.push(service);
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const click = () => service.dispatch(binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, text: error.message }));
  const records = () => existsSync(payFile) ? JSON.parse(readFileSync(payFile, "utf8")).records as { state: string; summary: string; rowWritten?: boolean }[] : [];
  const dblclick = () => service.dispatch(binding.bindingId, "agent_browser_dblclick", { selector: "button" }, () => true).then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, text: error.message }));
  return { releases, service, dblclick, control, click, pageClicks, cards, rows, handoffs, records, stateAtInput, actionCards: () => actionCards, setPage: (p: Page) => { page = p; control.page = p; } };
}
const YOUR_TURN = /^YOUR TURN:/;
/** The executor's own in-page read (PAY_PAGE_EXPRESSION, as sent over CDP) run on a minimal document: body text, title, one visible order summary. */
function runPayPage(expression: string, text: string): unknown {
  const shown = { innerText: "USB-C cable Qty: 1", getClientRects: () => [{}] };
  const document = { body: { innerText: text }, title: "Fixture Shop", querySelectorAll: (selector: string) => (selector === "a[href]" ? [] : [shown]) };
  return runInNewContext(expression, { document, getComputedStyle: () => ({ display: "block", visibility: "visible" }) });
}

describe("PAYFULL S4: the owner's own purchase gets the one-tap card, and Approve presses once", () => {
  it("W-CARD-PRESS: card with merchant, item, quantity 1,000 = 1000, total; one click; record pressed; one owner row", async () => {
    const f = await fixture();
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toContain("Pay $42.99 at fixture.test?");
    expect(f.cards[0]).toContain("Merchant (from the page): Fixture Shop");
    expect(f.cards[0]).toContain("Item (from the page): USB-C cable Qty: 1,000");
    expect(f.cards[0]).toContain("Quantity: 1000\n");
    expect(f.cards[0]).toContain("Total: $42.99");
    expect(out.ok).toBe(true);
    expect(f.handoffs).toHaveLength(0);
    expect(f.actionCards()).toBe(0);
    expect(f.pageClicks).toHaveLength(1);
    expect(f.records().map(r => r.state)).toEqual(["pressed"]);
    expect(f.rows).toEqual(['Pressed "Pay now" on fixture.test. Check the site for its confirmation.']);
  });
  // Guard row (green on a build that skips nothing): a card the decision still wants is asked as it is today (r5 DECISIONS #17: no unwitnessed skip).
  it("W-ONECARD-S5: on an ask-every-step site the approved pay card answers the step: no second (action) card, one click", async () => {
    const f = await fixture({ siteRule: "ask" });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.actionCards()).toBe(0);
    expect(out.ok).toBe(true);
    expect(f.pageClicks).toHaveLength(1);
  });
  it("W-SPENT-FIRST: the record is spent on disk before the click reaches the page", async () => {
    const f = await fixture();
    await f.click();
    expect(f.stateAtInput).toEqual(["spent"]);
  });
  it("W-ONCE-IN-CALL: an engine that clicks twice under one approval reaches the page once", async () => {
    const f = await fixture({ engineClicks: 2 });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.pageClicks).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("A second press needs a new approval") });
  });
  it("W-ONCE: after one press, the next click on Pay asks again; Deny leaves the page at one click", async () => {
    let n = 0;
    const f = await fixture({ answer: () => (++n === 1 ? "allow" : "deny") });
    await f.click();
    const second = await f.click();
    expect(f.cards).toHaveLength(2);
    expect(f.pageClicks).toHaveLength(1);
    expect(second).toMatchObject({ ok: false, text: expect.stringContaining("the owner said no") });
  });
  it("W-QTY: the quantity row reads grouped digits in the page's other forms", async () => {
    for (const [order, qty] of [["1,000 x USB-C cable", "1000"], ["USB-C cable × 12 500", "12500"], ["Quantity: 3", "3"]] as const) {
      const f = await fixture({ page: { ...cartPage(), order } });
      await f.click();
      expect(f.cards, order).toHaveLength(1);
      expect(f.cards[0], order).toContain(`Quantity: ${qty}\n`);
    }
  });
});

describe("PAYFULL A7: failure paths end with nothing pressed and one row", () => {
  it("W-DENY: Deny presses nothing, says so, and the same turn gets no new card (E8)", async () => {
    const f = await fixture({ answer: () => "deny" });
    const first = await f.click();
    expect(first).toMatchObject({ ok: false, text: expect.stringContaining("the owner said no to this payment") });
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["denied"]);
    expect(f.rows).toEqual(["Not paid: you said no"]);
    const again = await f.click();
    expect(again).toMatchObject({ ok: false, text: expect.stringContaining("the owner said no") });
    expect(f.cards).toHaveLength(1);
  });
  it("W-EXPIRE: a wait that runs out presses nothing", async () => {
    const f = await fixture({ answer: () => "waiting" });
    const out = await f.click();
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("did not answer in time") });
    expect(f.cards).toHaveLength(1);
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["expired"]);
  });
  const changedRows: [string, (f: { page: Page; setLoader(v: string): void }) => void, (f: Awaited<ReturnType<typeof fixture>>) => void][] = [
    ["total raised after the card", () => {}, f => f.setPage({ ...cartPage(), amounts: [{ label: "Total due today", value: "$99.00" }], digest: "d2" })],
    ["page text swapped in place (same total)", () => {}, f => f.setPage({ ...cartPage(), digest: "d3" })],
    ["page reloaded after the card", c => c.setLoader("L2"), () => {}],
  ];
  for (const [name, inCard, afterCard] of changedRows) {
    it(`W-CHANGED: ${name}: nothing pressed, changed text and row`, async () => {
      let f!: Awaited<ReturnType<typeof fixture>>;
      f = await fixture({ answer: (_card, c) => { inCard(c); afterCard(f); return "allow"; } });
      const out = await f.click();
      expect(f.cards).toHaveLength(1);
      expect(out).toMatchObject({ ok: false });
      expect(f.pageClicks).toHaveLength(0);
      expect(f.records().map(r => r.state)).toEqual(["changed"]);
      expect(f.rows).toEqual(["Not paid: the page changed"]);
    });
  }
  it("W-RACE: the total changes in place after the final check, before the click: nothing pressed, record changed", async () => {
    const f = await fixture({ onHitTest: c => c.setPage({ ...cartPage(), amounts: [{ label: "Total due today", value: "$99.00" }], digest: "d9" }) });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("the page changed after the owner approved") });
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["changed"]);
  });
  it("W-RACE-RELEASE: the total changes between the press and the release: the release (the click) never reaches the page, record uncertain", async () => {
    const f = await fixture({ onHitTest: (c, n) => { if (n === 2) c.setPage({ ...cartPage(), amounts: [{ label: "Total due today", value: "$99.00" }], digest: "d8" }); } });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("the page changed after the owner approved") });
    // ASTRA 15482d2311: the press half went out, so the bot is told the button may have been pressed, never "nothing was pressed, try again".
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("The pay button may have been pressed") });
    expect(out.ok === false && out.text).not.toContain("Nothing was pressed");
    expect(f.releases).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["uncertain"]);
  });
  const staleRows: [string, (c: { setMode(v: "full" | "task" | "step"): void; turn: Turn }) => void][] = [
    ["level set to Ask after Approve", c => c.setMode("step")],
    ["an email reached the turn after Approve", c => { c.turn.emailMark = true; }],
    ["a non-owner audience joined after Approve", c => { c.turn.notOwnerAudience = true; }],
    ["a newer turn is running at the final check", c => { c.turn.generation = "8"; }],
  ];
  // The change lands at the final check's own live read. Since J16 that read is the press guard's (taken as the guard is installed, after S5
  // admitted the step and right before the input), so the change is made at the guard install, not at a numbered page read.
  for (const [name, change] of staleRows) {
    it(`W-STALE: ${name}: closed, nothing pressed`, async () => {
      let installs = 0;
      const f = await fixture({ onGuardInstall: c => { installs++; change(c); } });
      const out = await f.click();
      expect(f.cards).toHaveLength(1);
      expect(installs).toBe(1);
      expect(out).toMatchObject({ ok: false, text: expect.stringContaining("Nothing was pressed") });
      expect(f.pageClicks).toHaveLength(0);
      expect(f.records().map(r => r.state)).toEqual(["closed"]);
    });
  }
  it("W-STALE-S5: level set to Ask while the card is open: the settings fence refuses at S5, the card is closed, nothing pressed", async () => {
    const f = await fixture({ answer: (_card, c) => { c.setMode("step"); return "allow"; } });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("changed this browser's approval settings") });
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["closed"]);
  });
  it("W-TURNS: a Deny in one owner turn does not refuse the next owner turn (turn ids are opaque strings)", async () => {
    let n = 0;
    const f = await fixture({ turn: { generation: "c0ffee00-0000-4000-8000-000000000001" }, answer: () => (++n === 1 ? "deny" : "allow") });
    await f.click();
    f.control.turn.generation = "c0ffee00-0000-4000-8000-000000000002";
    const next = await f.click();
    expect(f.cards).toHaveLength(2);
    expect(next.ok).toBe(true);
    expect(f.pageClicks).toHaveLength(1);
  });
  it("W-STOP-IN-CARD: the owner stops the task while the card is open, then Approve: nothing pressed, the record is closed", async () => {
    const f = await fixture({ answer: async (_card, c) => { await c.stop(); return "allow" as const; } });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["closed"]);
  });
  it("W-UNCERTAIN: the click went out and the engine gave no result: uncertain, never repeated, owner told to check", async () => {
    const f = await fixture({ throwAfterClick: true });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(f.pageClicks).toHaveLength(1);
    expect(f.records().map(r => r.state)).toEqual(["uncertain"]);
    expect(f.rows).toEqual(["The pay button may have been pressed. Check the page before anything else is done."]);
  });
  it("W-AFTER-PRESS (OPUS 3efce241d5 H2): another check refuses the release after the press went out: the bot is told the button may have been pressed, record uncertain", async () => {
    const f = await fixture({ hitClear: n => n !== 2 });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.pageClicks).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("The pay button may have been pressed") });
    expect(f.releases).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["uncertain"]);
  });
  it("W-TOUCH (FABLE 15482d2311): the engine acts on the approved pay button with a function call and no input event: uncertain, never 'nothing was pressed'", async () => {
    const f = await fixture({ engineTouch: true, engineClicks: 0 });
    await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.records().map(r => r.state)).toEqual(["uncertain"]);
    expect(f.rows).toEqual(["The pay button may have been pressed. Check the page before anything else is done."]);
  });
  it("W-TOUCH-REFUSED (OPUS 3efce241d5): the engine acted on the button, then the press is refused (covered): uncertain, and the bot is told it may have been pressed", async () => {
    const f = await fixture({ engineTouch: true, hitClear: n => n !== 1 });
    const out = await f.click();
    expect(f.cards).toHaveLength(1);
    expect(f.pageClicks).toHaveLength(0);
    expect(f.records().map(r => r.state)).toEqual(["uncertain"]);
    expect(out).toMatchObject({ ok: false, text: expect.stringContaining("The pay button may have been pressed") });
  });
  it("W-ROW-ONCE (ASTRA 15482d2311 F2c): a crash after the owner's row was written but before that was saved writes the same row again, under the same id", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pay-row-")); cleanup.push(directory);
    mkdirSync(path.join(directory, "browser-extension"), { recursive: true });
    const file = path.join(directory, "browser-extension", "pay-cards.json");
    const binding = { thread: "t", bot: "b", tab: "1:1:https://fixture.test", loader: "L1", address: "https://fixture.test/checkout", node: 12, control: "c", floor: "payment:pay-name", agreed: "a" };
    const saved = JSON.stringify({ version: 1, records: [{ id: "r1", thread: "t", bot: "b", generation: "7", kind: "pay", binding, summary: "Pay $42.99 at fixture.test?\nSite: fixture.test\nButton (from the page): Pay now", createdAt: 1, expiresAt: 2, state: "denied" }] });
    writeFileSync(file, saved);
    const rows: { text: string; id: unknown }[] = [];
    const make = () => new BrowserExtensionIntegration({ dataDir: directory, socketDir: directory, workspaceId: "workspace", approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never, bot: () => undefined, protectedOrigins: [], payRow: (_t: string, _b: string, text: string, id?: string) => { rows.push({ text, id }); } } as never);
    make();
    writeFileSync(file, saved); // the process stopped after the row, before rowWritten reached the disk
    make();
    expect(rows.map(r => r.text)).toEqual(["Not paid: you said no", "Not paid: you said no"]);
    expect(rows[0]!.id).toEqual(expect.stringContaining("r1"));
    expect(rows[1]!.id).toBe(rows[0]!.id);
  });
  // Guard rows: these refusals come before any floor on the extension path (no dblclick tool; a routine never gets site consent), so the pay
  // gate's own double-click and routine checks are defence in depth here (r5 DECISIONS #26).
  it("W-DOUBLE: a double click on a pay button is refused before anything, no card, no click", async () => {
    const f = await fixture();
    const out = await f.dblclick();
    expect(out).toMatchObject({ ok: false, text: "This browser operation is unavailable through the extension." });
    expect(f.cards).toHaveLength(0);
    expect(f.pageClicks).toHaveLength(0);
  });
  it("W-ROUTINE: an unattended routine run is refused before the floor, no card, no click", async () => {
    const f = await fixture({ routine: true });
    const out = await f.click();
    expect(out.ok).toBe(false);
    expect(f.cards).toHaveLength(0);
    expect(f.pageClicks).toHaveLength(0);
  });
  it("W-RESTART: startup closes an open or approved card, makes a spent one uncertain, and writes each row once", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "pay-restart-")); cleanup.push(directory);
    mkdirSync(path.join(directory, "browser-extension"), { recursive: true });
    const file = path.join(directory, "browser-extension", "pay-cards.json");
    const binding = { thread: "t", bot: "b", tab: "1:1:https://fixture.test", loader: "L1", address: "https://fixture.test/checkout", node: 12, control: "c", floor: "payment:pay-name", agreed: "a" };
    const record = (id: string, state: string) => ({ id, thread: "t", bot: "b", generation: 7, kind: "pay", binding, summary: "Pay $42.99 at fixture.test?\nSite: fixture.test\nButton (from the page): Pay now", createdAt: 1, expiresAt: 2, state });
    writeFileSync(file, JSON.stringify({ version: 1, records: [record("w", "waiting"), record("a", "allowed"), record("s", "spent"), record("p", "pressed")] }));
    const rows: string[] = [];
    const make = () => new BrowserExtensionIntegration({ dataDir: directory, socketDir: directory, workspaceId: "workspace", approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never, bot: () => undefined, protectedOrigins: [], payRow: (_t: string, _b: string, text: string) => { rows.push(text); } } as never);
    make();
    const states = () => Object.fromEntries((JSON.parse(readFileSync(file, "utf8")).records as { id: string; state: string }[]).map(r => [r.id, r.state]));
    expect(states()).toEqual({ w: "closed", a: "closed", s: "uncertain", p: "pressed" });
    expect(rows.sort()).toEqual(["Not paid: your settings changed while this was open", "Not paid: your settings changed while this was open", 'Pressed "Pay now" on fixture.test. Check the site for its confirmation.', "The pay button may have been pressed. Check the page before anything else is done."].sort());
    make();
    expect(rows).toHaveLength(4);
  });
});

describe("PAYFULL A4 W-SCAN: the card never shows less than the page (ASTRA 15482d2311), read by the executor's own in-page scanner", () => {
  it("W-SCAN control: a plain total read by the in-page scanner gets the card with that total", async () => {
    for (const [text, total] of [["Order summary\nTotal due today $42.99", "$42.99"], ["Total due today: $1,234.56.", "$1,234.56"], ["Total (incl. VAT) 42,99 EUR", "EUR42.99"]] as const) {
      const f = await fixture({ pageText: text });
      await f.click();
      expect(f.cards, text).toHaveLength(1);
      expect(f.cards[0], text).toContain(`Total: ${total}`);
    }
  });
  const understated: [string, string, string][] = [
    ["a total with a dot group and a decimal comma (\u20ac1.234,56)", "Total due today \u20ac1.234,56", "\u20ac1.23"],
    ["the same total with the currency after it (1.234,56 EUR)", "Total due today 1.234,56 EUR", "EUR234.56"],
    ["one unreadable amount next to a readable one", "Subtotal $40.00\nTotal due today \u20ac1.234,56", "$40.00"],
    ["a total grouped with an apostrophe (CHF 1\u2019234.56)", "Total due today CHF 1\u2019234.56", "CHF1"],
    ["a total grouped with a plain apostrophe (CHF 1'234.56)", "Total due today CHF 1'234.56", "CHF1"],
  ];
  for (const [name, text, fragment] of understated) {
    it(`W-SCAN: ${name}: no card shows a part of it, hand-off, nothing pressed`, async () => {
      const f = await fixture({ pageText: text });
      const out = await f.click();
      expect(f.cards.join("\n")).not.toContain(fragment);
      expect(f.cards).toHaveLength(0);
      expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
      expect(f.pageClicks).toHaveLength(0);
    });
  }
});

describe("PAYFULL A4 W-SCAN-MANY (OPUS 3efce241d5 H1): a page with more amounts than the old ten-amount cut still shows its total", () => {
  const spaced: [string, string, RegExp | undefined][] = [
    ["spaces between the currency and the total", "Subtotal $40.00\nTotal due: $  1,234.56", /\$1,234\.56/],
    ["a total in full-width digits", "Subtotal $40.00\nTotal due USD \uff11,\uff12\uff13\uff14.\uff15\uff16", /USD1,234\.56/],
    ["a currency sign the scanner cannot pair with a number (hand-off)", "Subtotal $40.00\nTotal due $\u2014 1,234.56", undefined],
  ];
  for (const [name, text, shown] of spaced) {
    it(`W-SCAN-LINE (ASTRA precheck f6e86ecc38): ${name}: the card never shows the subtotal alone`, async () => {
      const f = await fixture({ pageText: text });
      const out = await f.click();
      expect(f.cards.join("\n")).not.toContain("Pay $40.00 at");
      if (shown) { expect(f.cards).toHaveLength(1); expect(f.cards[0]).toMatch(shown); }
      else { expect(f.cards).toHaveLength(0); expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) }); }
    });
  }
  it("W-SCAN-QTY: a quantity written before the price (\u00d72 $43.00) is never read as the amount: the card says $43.00, never $2", async () => {
    const f = await fixture({ pageText: "USB-C cable \u00d72 $43.00\nTotal due today \u00d72 $43.00" });
    await f.click();
    expect(f.cards.join("\n")).not.toContain("Pay $2 ");
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toContain("Total: $43.00");
  });
  it("W-SCAN-MANY: ten item lines at $1.00 and the total after them: the card never says Pay $1.00 alone; the total is on it", async () => {
    const f = await fixture({ pageText: [...Array.from({ length: 10 }, (_, i) => `Item ${"ABCDEFGHIJ"[i]} $1.00`), "Total due today $99.00"].join("\n") });
    await f.click();
    expect(f.cards.join("\n")).not.toContain("Pay $1.00 at");
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toContain("$99.00");
  });
});

describe("PAYFULL A3 W-NARROW (FABLE 15482d2311): only a single mouse click on a payment floor gets the card; the unwitnessed paths hand off as today", () => {
  const narrow: [string, string, Record<string, unknown>, FloorFacts, { floor: string; rule: string }][] = [
    ["Enter pressed on the pay button", "agent_browser_press", { key: "Enter" }, { ...payNow, operation: "press", key: "Enter" } as FloorFacts, { floor: "payment", rule: "pay-name" }],
    ["Space pressed on the pay button", "agent_browser_press", { key: " " }, { ...payNow, operation: "press", key: " " } as FloorFacts, { floor: "payment", rule: "pay-name" }],
    ["a terms box checked (the terms card)", "agent_browser_check", { selector: "input" }, { operation: "check", tag: "input", type: "checkbox", role: "checkbox", name: "I agree to the Terms of Service" } as FloorFacts, { floor: "consent", rule: "checkbox-name" }],
    ["a terms button clicked (the terms card)", "agent_browser_click", { selector: "button" }, { operation: "click", tag: "button", role: "button", name: "I agree to the Terms of Service" } as FloorFacts, { floor: "consent", rule: "control-name" }],
  ];
  for (const [name, tool, args, facts, expected] of narrow) {
    it(`W-NARROW: ${name}: no card, hand-off, nothing pressed`, async () => {
      const shown = classifyFloor(facts);
      expect({ floor: shown.floor, rule: shown.rule }).toEqual(expected);
      const f = await fixture({ facts });
      const out = await f.service.dispatch((f.service.status().bindings[0] as { bindingId: string }).bindingId, tool, args, () => true).then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, text: error.message }));
      expect(f.cards).toHaveLength(0);
      expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
      expect(f.pageClicks).toHaveLength(0);
      expect(f.handoffs).toHaveLength(1);
    });
  }
});

describe("PAYFULL W-PASS-SCOPE: the approved pay card covers its own sure floor only; anything else the page shows later goes back to the owner", () => {
  // S4 collects the floor facts once (call 1: "Pay now" = payment/pay-name, the card). The page changes the control after Approve: the late check
  // (executor floorCheck right before the final check, collect 2) or the input revalidate (collect 3, at the press) reads it again. The S5 decision
  // reads S4's own facts, so a different floor can only meet the pass at those two sites. Each row: hand-off, no click, the record not pressed.
  const scope: [string, FloorFacts | "throw", { floor: string; rule: string; unsure?: true }][] = [
    ["(1) the same pay button, unsure (a label at its read cap)", { ...payNow, description: "x".repeat(500) }, { floor: "payment", rule: "pay-name", unsure: true }],
    ["(4) the same kind with another rule (a submit of a card form)", { operation: "click", tag: "button", role: "button", type: "submit", name: "Send", form: { hasCardFields: true } } as FloorFacts, { floor: "payment", rule: "submit-card-form" }],
    ["(5) another kind (a human check)", { operation: "click", tag: "button", role: "button", name: "Verify you are human" }, { floor: "verification", rule: "verify-name" }],
    ["(1b) the page could not be read (unsure, another kind)", "throw", { floor: "verification", rule: "unsure", unsure: true }],
  ];
  for (const [site, from, state] of [["the late check", 2, "closed"], ["the press", 3, "not-pressed"]] as const) {
    for (const [name, facts, expected] of scope) {
      it(`W-PASS-SCOPE at ${site}: ${name}`, async () => {
        const shown = classifyFloor(facts === "throw" ? { operation: "click", factsFailed: true } : facts);
        expect({ floor: shown.floor, rule: shown.rule, ...(shown.unsure ? { unsure: true } : {}) }).toEqual(expected);
        const f = await fixture({ factsAt: n => (n >= from ? facts : undefined) });
        const out = await f.click();
        expect(f.pageClicks).toHaveLength(0);
        expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
        expect(f.cards).toHaveLength(1);
        expect(f.records().map(r => r.state)).toEqual([state]);
      });
    }
  }
});

describe("PAYFULL W-KEEP: outside content, other levels and unreadable pages keep today's hand-off, word for word, with no card", () => {
  const keep: [string, Parameters<typeof fixture>[0]][] = [
    ["a non-owner audience", { turn: { ownerAudience: false, notOwnerAudience: true } }],
    ["a turn the owner did not type", { turn: { ownerTyped: false } }],
    ["an email-derived turn (M1)", { turn: { emailMark: true } }],
    ["level Ask each step", { mode: "step" }],
    ["level task", { mode: "task" }],
    ["an owner message that asks for no purchase (J13)", { owner: "check my order status on fixture.test" }],
    ["a site the owner never named (page-steered)", { owner: "buy the USB-C cable on othershop.test" }],
    ["no readable order summary (E7)", { page: { ...cartPage(), order: "" } }],
    ["no amount on the page (E7)", { page: { ...cartPage(), amounts: [] } }],
    ["nine amounts (E7)", { page: { ...cartPage(), amounts: Array.from({ length: 9 }, (_, i) => ({ label: `Line ${i}`, value: `$${i + 1}.00` })) } }],
    ["a record that cannot be saved (F8)", { beforeSave: () => { throw new Error("disk full"); } }],
  ];
  for (const [name, opts] of keep) {
    it(name, async () => {
      const f = await fixture(opts);
      const out = await f.click();
      expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
      expect(f.cards).toHaveLength(0);
      expect(f.pageClicks).toHaveLength(0);
      expect(f.handoffs).toHaveLength(1);
    });
  }
});

/** The production wiring: BrowserExtensionIntegration.start() with the options index.ts passes (payTurn, payRow, owner turn text), a Full-access
 *  bot, and a broker standing in for Chrome. `payCardLive` is the switch index.ts never sets; the control row turns it on to prove this boot
 *  reaches the card. Every approval the integration asks is answered Allow, so only the wiring decides whether a pay card appears. */
async function liveIntegration(payCardLive: boolean | undefined) {
  let liveReleases = 0;
  const { root, directory } = await privateTestDirectory(path.resolve(".pay-live-")); cleanup.push(root);
  const bindings = new Map<string, { generation: number; state: string; tabs: { tabId: number; navigationEpoch: number; origin: string; url: string }[] }>();
  const pageClicks: number[] = []; const asked: { tool: unknown; summary: string }[] = []; const yourTurns: string[] = [];
  brokerSlot.value = {
    close: async () => {}, drop: () => false,
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "pay_hold_v1", "pay_hold_v2"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [{ tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/checkout" }] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: any = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Page.getFrameTree") value = { frameTree: { frame: { id: "frame", loaderId: "L1" } } };
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        if (method === "Page.createIsolatedWorld") value = { executionContextId: 7 };
        if (method === "DOM.getDocument") value = { root: { nodeType: 9, children: [] } };
        if (method === "DOM.describeNode") value = { node: { backendNodeId: 12 } };
        if (method === "DOM.resolveNode") value = { object: { objectId: "target" } };
        if (method === "Runtime.evaluate") value = { result: { value: String(params.expression).includes("murage-pay-page") ? JSON.stringify(cartPage()) : String(params.expression).includes("__murageGuard()") ? false : "page", objectId: "target" } };
        if (method === "Runtime.callFunctionOn") value = { result: { value: String(params.functionDeclaration).includes("elementFromPoint") ? true : JSON.stringify({ display: { tag: "BUTTON", role: "button", text: "Pay now", label: "Pay now" }, bound: null }) } };
        // J16: this booted fixture has no page either; the press guard is stood in for as in `fixture` above (witnessed in real Chromium).
        if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("murage-pay-press-guard")) value = { result: { value: JSON.stringify({ ok: true, page: JSON.stringify(cartPage()), shape: JSON.stringify({ display: { tag: "BUTTON", role: "button", text: "Pay now", label: "Pay now" }, bound: null }) }) } };
        if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-press-arm")) value = { result: { value: true } };
        if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-press-report")) value = { result: { value: JSON.stringify({ state: liveReleases ? "pressed" : "armed", passed: pageClicks.length + liveReleases }) } };
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") liveReleases++;
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") pageClicks.push(1);
        result = { result: value, ...b.tabs[0] };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const record = { id: "bot", name: "Paybot", browserApproval: "full" } as never;
  const turn = { generation: "7", ownerTyped: true, ownerAudience: true, notOwnerAudience: false, emailMark: false };
  const integration = new BrowserExtensionIntegration({
    dataDir: directory, socketDir: directory, workspaceId: "workspace",
    approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never,
    bot: () => record, protectedOrigins: [],
    collectFacts: async () => ({ ...payNow, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: any) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 1, y: 1, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); }
        return { content: [{ type: "text", text: "clicked" }] };
      },
    }) as never,
    ownerInstruction: () => ({ id: "m1", text: OWNER }),
    ownerTurnInstruction: () => ({ id: "m1", text: OWNER }),
    payTurn: () => ({ ...turn }),
    payRow: () => {},
    yourTurn: (info: { text: string }) => { yourTurns.push(info.text); },
    ...(payCardLive === undefined ? {} : { payCardLive }),
  } as never);
  vi.spyOn(integration.approvals, "ask").mockImplementation(async (input: any) => { asked.push({ tool: input.call?.tool, summary: String(input.summary) }); return "allow"; });
  const service = await integration.start(); integrations.push(integration);
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const out = await service.dispatch(binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).then(value => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, text: error.message }));
  return { out, pageClicks, payCards: asked.filter(a => a.tool === "agent_browser_pay_card"), yourTurns };
}

describe("PAYFULL r7 W-LIVE-OFF (OPUS 15482d2311/adf932ab28 + ASTRA adf932ab28 High, DECISIONS #42): with no event-time press guard, the live wiring offers no pay card", () => {
  it("W-LIVE-OFF control: the same booted integration with the card switched on reaches the card and the click (this boot is a real pay floor)", async () => {
    const f = await liveIntegration(true);
    expect(f.payCards).toHaveLength(1);
    expect(f.payCards[0]!.summary).toContain("Pay $42.99 at fixture.test?");
    expect(f.pageClicks).toHaveLength(1);
  });
  for (const [name, live] of [["as index.ts boots it (no switch)", undefined], ["the switch set false", false]] as const) {
    it(`W-LIVE-OFF: ${name}: an owner's own Full-access purchase hands off as on dev/1024: no pay card, nothing pressed`, async () => {
      const f = await liveIntegration(live);
      expect(f.payCards).toHaveLength(0);
      expect(f.pageClicks).toHaveLength(0);
      expect(f.out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
      expect(f.yourTurns).toHaveLength(1);
    });
  }
});

describe("PAYFULL A4 W-SCAN-CLASS (FABLE/ASTRA/OPUS adf932ab28 High, DECISIONS #43): a number the scanner leaves on a line is never dropped while a smaller amount is shown", () => {
  const rows: [string, string, string][] = [
    ["a bare-number total under a signed shipping line", "Shipping $5.00\nTotal 1,234.56", "$5.00"],
    ["a code then a colon (USD: 1,234.56)", "Subtotal $40.00\nTotal due: USD: 1,234.56", "$40.00"],
    ["a parenthesised code", "Subtotal $40.00\nTotal (USD) 1,234.56", "$40.00"],
    ["a lowercase code", "Subtotal $40.00\nTotal usd 1,234.56", "$40.00"],
    ["kr with a space group and a decimal comma", "Subtotal $40.00\nTotal 1 234,56 kr", "$40.00"],
    ["z\u0142 after the total", "Subtotal $40.00\nTotal 1,234.56 z\u0142", "$40.00"],
    ["Rs. before the total", "Subtotal $40.00\nTotal Rs. 1,234.56", "$40.00"],
    ["a currency word after the total", "Subtotal $40.00\nTotal: 1,234.56 dollars", "$40.00"],
    ["an unlabelled integer with kr", "Shipping $5.00\n1234 kr", "$5.00"],
    ["an unlabelled two-digit amount after Rs", "Shipping $5.00\nRs 99", "$5.00"],
    ["an unlabelled two-digit amount before a currency word", "Shipping $5.00\n99 dollars", "$5.00"],
    ["a total in Arabic-Indic digits", "Shipping $5.00\nTotal \u0661\u0662\u0663\u0664", "$5.00"],
    ["a yen amount written with the letter \u5186", "Shipping $5.00\n500\u5186", "$5.00"],
    ["a grouped amount by a currency word no list names (marks between digits)", "Shipping $5.00\n1,234.56 bolivianos", "$5.00"],
    ["a two-digit total with no currency (money word on the line)", "Shipping $5.00\nTotal due today 99", "$5.00"],
  ];
  for (const [name, text, smaller] of rows) {
    it(`W-SCAN-CLASS: ${name}: no card shows ${smaller} alone, hand-off, nothing pressed`, async () => {
      const f = await fixture({ pageText: text });
      const out = await f.click();
      expect(f.cards.join("\n")).not.toContain(`Pay ${smaller} at`);
      expect(f.cards).toHaveLength(0);
      expect(out).toMatchObject({ ok: false, text: expect.stringMatching(YOUR_TURN) });
      expect(f.pageClicks).toHaveLength(0);
    });
  }
  it("W-SCAN-CLASS control: a count by a word, a quantity line and \u00d7N on the total line keep the card with the total", async () => {
    for (const [text, total] of [["$42.99\n2 items\nPay now", "$42.99"], ["Quantity: 2\nTotal $42.99", "$42.99"], ["Total due today \u00d72 $43.00", "$43.00"]] as const) {
      const f = await fixture({ pageText: text });
      await f.click();
      expect(f.cards, text).toHaveLength(1);
      expect(f.cards[0], text).toContain(`Total: ${total}`);
    }
  });
});

// q1024-payguard-fable r3: the server runs these files through node's own type stripping, which refuses TypeScript-only syntax that needs code
// generated (constructor parameter properties, enums). The test runner accepts them, so only a real node process shows it: with one in
// pay-card.ts the server did not start at all. Entry: the module the server itself loads (browser-extension-integration.ts), in a child node.
describe("PAYFULL W-BOOT-STRIP: the pay modules load in the server's own node, not only in the test runner", () => {
  it("W-BOOT-STRIP: a plain node process loads the browser integration with the pay card, guard and owner-step modules", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = "await import('./server/browser-extension-integration.ts'); await import('./server/browser-floor-lift.ts'); console.log('LOADED'); process.exit(0);";
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 150_000, env: { ...process.env, NODE_OPTIONS: "" } });
    expect({ status: child.status, loaded: child.stdout.includes("LOADED"), refused: /ERR_[A-Z_]+|SyntaxError|ReferenceError/.exec(child.stderr)?.[0] ?? "" }).toEqual({ status: 0, loaded: true, refused: "" });
  }, 180_000);
});
