// SPDX-License-Identifier: AGPL-3.0-or-later
// PAYFULL J16 (owner q1024-payguard-fable): the in-page press guard and the navigation hold, in a REAL Chromium (Playwright).
// Every row enters through service.dispatch (browser-extension-service.ts dispatch -> executor call -> floor -> pay card ->
// final check -> engine -> beforeCommand -> the CDP command), and every CDP command the executor sends is run by a real
// Chromium DevTools session on a checkout page served on loopback: the isolated world, the page read, the description of the
// button, the guard, Fetch.enable and the trusted Input.dispatchMouseEvent are all the browser's own. The loopback shop counts
// what really reached it (POST /pay with the total the page showed at the press, /pay2 from another document, /other from
// any other control).
// `between` is the instant the guard exists for: it runs when the executor has finished every check of its own and hands the
// mouse event to the browser (in the product: after the extension's own look at the tab, before chrome.debugger delivers it).
// Needs a Chromium: the offline test container has none, so this runs only with MURAGE_REAL_BROWSER=1 on a host with the
// Playwright browsers (as server/paynl-nolimits-realbrowser-1024.test.ts); the gate lists it as extended.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBrowserExtensionService } from "./browser-extension-service.ts";
import type { FloorFacts } from "./browser-floor.ts";
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from "../shared/browser-extension-protocol.ts";
import { privateTestDirectory } from "./testing/private-test-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const REAL = process.env.MURAGE_REAL_BROWSER === "1";
const payModule = await import("./pay-card.ts").catch(() => undefined) as undefined | typeof import("./pay-card.ts");
const payNow: FloorFacts = { operation: "click", tag: "button", role: "button", name: "Pay now" };
const BUTTON = "position:absolute;left:40px;top:200px;width:160px;height:40px";
const checkout = (total: string, post: string) => `<!doctype html><title>Fixture Shop</title><h1>Checkout</h1>
<div data-order-summary>USB-C cable Quantity: 1</div><p>Total due today <span id="total">${total}</span></p>
<button id="pay" style="${BUTTON}" onclick="fetch('${post}',{method:'POST',body:document.getElementById('total').textContent})">Pay now</button>`;

// The same checkout as a plain form post: pressing Pay starts a main-frame navigation (POST /pay-form), as most shops do.
const checkoutForm = `<!doctype html><title>Fixture Shop</title><h1>Checkout</h1>
<div data-order-summary>USB-C cable Quantity: 1</div><p>Total due today <span id="total">$42.99</span></p>
<form method="post" action="/pay-form"><button id="pay" style="${BUTTON}">Pay now</button></form>`;

// Another document that charges on any mouse release, with no click needed: what a release would meet if it landed after a redirect.
const releasePays = `<!doctype html><title>Fixture Shop</title><h1>Checkout</h1><p>Total due today $999.00</p>
<script>addEventListener('mouseup',()=>fetch('/pay2',{method:'POST'}),true)</script>`;

let site: Server; let siteUrl = "";
const hits = { pay: [] as string[], pay2: 0, other: 0, form: 0 };
beforeAll(async () => {
  if (!REAL) return;
  site = createServer((req, res) => {
    if (req.method === "POST") {
      let body = ""; req.on("data", c => { body += c; });
      req.on("end", () => { if (req.url === "/pay") hits.pay.push(body); else if (req.url === "/pay2") hits.pay2++; else if (req.url === "/pay-form") hits.form++; else hits.other++; res.end("ok"); });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url === "/checkout2" ? checkout("$999.00", "/pay2") : req.url === "/checkout-form" ? checkoutForm : req.url === "/release-pays" ? releasePays : checkout("$42.99", "/pay"));
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => { site?.close(); });

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step().catch(() => {}); });

type RealPage = { evaluate<T>(fn: string): Promise<T>; waitForURL(url: string, o: { timeout: number }): Promise<void>; waitForTimeout(ms: number): Promise<void>; url(): string };
type Between = (type: string, page: RealPage) => Promise<void>;
async function fixture(opts: { forge?: "world" | "nonce"; between?: Between; slowReadAt?: number; capabilities?: string[]; path?: string; afterReleaseMs?: number; afterPressed?: string } = {}) {
  hits.pay.length = 0; hits.pay2 = 0; hits.other = 0; hits.form = 0;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch(); cleanup.push(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
  const page = await context.newPage();
  await page.goto(`${siteUrl}${opts.path ?? "/checkout"}`);
  const cdp = await context.newCDPSession(page); let wire: { handleMessage(profile: string, message: unknown): Promise<unknown> } | undefined; let armed = { nonce: "", world: 0 }; const push = async (params: unknown) => { const [id, b] = [...bindings.entries()][0]; await wire!.handleMessage("profile", { version: 1, type: "event", bindingId: id, generation: b.generation, event: "cdp", data: { tabId: 1, navigationEpoch: 1, method: "Runtime.bindingCalled", params } }); }; cdp.on("Runtime.bindingCalled", (e: { name: string }) => { if (e.name === "__muragePayReport") void push(e); }); /* the extension forwards this one binding (runtime.mjs debuggerEvent) */
  const { root, directory } = await privateTestDirectory(path.resolve(".pay-guard-")); cleanup.push(() => removeTempDir(root));
  const payFile = path.join(directory, "pay-cards.json");
  const tab = { tabId: 1, navigationEpoch: 1, origin: "https://fixture.test", url: "https://fixture.test/checkout" };
  const bindings = new Map<string, { generation: number; state: string; tabs: typeof tab[] }>();
  const cards: string[] = []; const handoffs: string[] = []; const rows: string[] = []; const sent: string[] = []; let pageReads = 0;
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: "hello", profileId: "profile", browser: "chromium", extensionVersion: "1.0", capabilities: opts.capabilities ?? ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "pay_hold_v1", "pay_hold_v2"] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      let b = bindings.get(command.bindingId);
      if (!b) { b = { generation: 1, state: "active", tabs: [tab] }; bindings.set(command.bindingId, b); }
      if (command.operation === "stop" || command.operation === "pause") { b.generation++; b.state = command.operation === "stop" ? "stopped" : "paused"; }
      let result: unknown = b;
      if (command.operation === "cdp") {
        const { method, params } = command.params as { method: string; params: Record<string, unknown> };
        let value: unknown;
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        else {
          if (method === "Runtime.evaluate") { const m = /murage-pay-press-arm.*\.arm\(\d+,"([^"]*)"\)/.exec(String(params.expression)); if (m) armed = { nonce: m[1], world: Number(params.contextId) }; }  if (method === "Runtime.evaluate" && String(params.expression).includes("murage-pay-page") && ++pageReads === opts.slowReadAt) await page.waitForTimeout(2_200);
          if (method === "Input.dispatchMouseEvent") { await opts.between?.(String(params.type), page as unknown as RealPage); sent.push(String(params.type)); }
          if (opts.forge && method === "Input.dispatchMouseEvent" && params.type === "mousePressed") await push({ name: "__muragePayReport", executionContextId: opts.forge === "world" ? armed.world + 1000 : armed.world, payload: JSON.stringify({ nonce: opts.forge === "nonce" ? "0".repeat(36) : armed.nonce, state: "pressed", passed: 5, why: "" }) });
          const { murageInspection: _inspection, ...real } = params; value = await (cdp.send as (m: string, p: unknown) => Promise<unknown>)(method, real);
          // The round trip through the extension, after the release reached the page (the instant in which a form post becomes a held navigation).
          if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" && opts.afterReleaseMs) await page.waitForTimeout(opts.afterReleaseMs); if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed" && opts.afterPressed) await page.evaluate(opts.afterPressed);
        }
        result = { result: value ?? {}, ...tab };
      }
      return { version: 1, type: "response", id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) } as never;
    },
  };
  const flow = payModule ? new payModule.PayCardFlow({ file: payFile, row: (_record, text) => { rows.push(text); } }) : undefined;
  const node = async () => {
    const doc = await cdp.send("DOM.getDocument", { depth: 0 });
    const found = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#pay" });
    return (await cdp.send("DOM.describeNode", { nodeId: found.nodeId })).node.backendNodeId;
  };
  const service = await createBrowserExtensionService({
    broker: broker as never, workspaceId: "workspace", stateFile: path.join(directory, "state.json"),
    collectFacts: async () => ({ ...payNow, visibility: { box: { x: 40, y: 200, width: 160, height: 40 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null } }) as never,
    onHandoff: (info: { text: string }) => { handoffs.push(info.text); },
    createEngine: (engine: { transport: { selected(): Promise<unknown>; send(method: string, params: unknown, document: unknown): Promise<unknown> }; beforeCommand(document: unknown, method: string, params: unknown): Promise<void> }) => ({
      resolveTarget: async () => ({ backendNodeId: await node(), document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string) {
        const document = await engine.transport.selected();
        if (name === "agent_browser_click") {
          // One real click in the middle of the button: press and release, click count 1 (what the pinned engine sends).
          for (const type of ["mousePressed", "mouseReleased"]) { const params = { type, x: 120, y: 220, button: "left", clickCount: 1 }; await engine.beforeCommand(document, "Input.dispatchMouseEvent", params); await engine.transport.send("Input.dispatchMouseEvent", params, document); }
          return { content: [{ type: "text", text: "clicked" }] };
        }
        return { content: [] };
      },
    }) as never,
    askSite: async () => "allow" as const, askAction: async () => true,
    approvalMode: () => "full",
    ownerInstruction: () => ({ id: "m1", text: "buy the USB-C cable on fixture.test" }),
    ownerTurnInstruction: () => ({ id: "m1", text: "buy the USB-C cable on fixture.test" }),
    ...(flow ? { payFlow: flow } : {}),
    payTurn: () => ({ generation: "7", ownerTyped: true, ownerAudience: true, notOwnerAudience: false, emailMark: false }),
    askPay: async (_context: unknown, card: { summary: string }) => { cards.push(card.summary); return "allow"; },
  } as never);
  cleanup.push(() => service.close()); wire = service as never;
  const binding = await service.ensureBinding({ botId: "bot", threadId: "thread", profileId: "profile" });
  const click = () => service.dispatch(binding.bindingId, "agent_browser_click", { selector: "button" }, () => true).then(value => ({ ok: true as const, value, text: "" }), (error: Error) => ({ ok: false as const, text: error.message }));
  const records = () => existsSync(payFile) ? (JSON.parse(readFileSync(payFile, "utf8")).records as { state: string }[]).map(r => r.state) : [];
  const settle = () => page.waitForTimeout(400);
  return { click, cards, handoffs, rows, records, sent, page, settle };
}
const setTotal = (value: string) => `document.getElementById('total').textContent=${JSON.stringify(value)}`;
const overlay = (text: string) => `(()=>{const o=document.createElement('div');o.id='over';o.style.cssText='${BUTTON};z-index:9';o.textContent=${JSON.stringify(text)};
for(const t of ['mousedown','mouseup','click'])o.addEventListener(t,()=>fetch('/other',{method:'POST'}));document.body.appendChild(o);})()`;

describe.skipIf(!REAL)("PAYFULL J16 in real Chromium: the press guard decides at the event, navigations are held for the press", () => {
  it("W-GUARD-PRESS (control): the owner's approved click on an unchanged page reaches the button once, with the total the card showed", async () => {
    const f = await fixture();
    const out = await f.click(); await f.settle();
    expect(f.cards, `the step answered: ${out.text} ${f.handoffs.join(" / ")}`).toHaveLength(1);
    expect(f.cards[0]).toContain("Pay $42.99 at fixture.test?");
    expect(out.text).toBe("");
    expect(hits.pay).toEqual(["$42.99"]);
    expect(f.records()).toEqual(["pressed"]);
    expect([hits.pay2, hits.other]).toEqual([0, 0]);
  }, 60_000);

  it("W-J16-TOTAL: the page raises the total in the instant between the last check and the press: nothing reaches the shop, `changed`", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") await page.evaluate(setTotal("$4,299.00")); } });
    const out = await f.click(); await f.settle();
    expect(f.cards).toHaveLength(1);
    expect(f.sent).toEqual(["mousePressed"]);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["changed"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.changed);
  }, 60_000);

  it("W-J16-TOTAL-RELEASE: the total changes between the release check and the release: the click is cancelled in the page, never `pressed`", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mouseReleased") await page.evaluate(setTotal("$4,299.00")); } });
    const out = await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["uncertain"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.releaseChanged);
  }, 60_000);

  it("W-J16-OVERLAY: a see-through control laid over the button after the check never gets the click; the approved button does", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") await page.evaluate(overlay("")); } });
    await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.other).toBe(0);
    expect(hits.pay).toEqual(["$42.99"]);
    expect(f.records()).toEqual(["pressed"]);
  }, 60_000);

  it("W-J16-OVERLAY-TEXT: a visible control laid over the button after the check: no control is pressed, `changed`", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") await page.evaluate(overlay("Pay $999.00")); } });
    const out = await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed"]);
    expect(hits.other).toBe(0);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["changed"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.changed);
  }, 60_000);

  it("W-J16-SCRIPT-CLICK: the page's own script click during the press is cancelled with the real one: no payment", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") await page.evaluate("document.getElementById('pay').click()"); } });
    const out = await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["changed"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.changed);
  }, 60_000);

  // Real Chromium answers no page-side command while a main-frame navigation is held, so the release check cannot be made: the release is not
  // sent, the step ends inside the bound (not at the 3 s release), nothing reaches either document, and the record says uncertain (never repeated).
  it("W-J16-NAV: a redirect that starts in the instant before the press is held: no click lands on the old or the new document, and the step does not stall", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") { await page.evaluate("location.href='/checkout2'"); await page.waitForURL("**/checkout2", { timeout: 900 }).catch(() => {}); } } });
    const began = Date.now();
    // A step that stalls under the hold is a failed row at the assertion below, not a test timeout: the wait is the row's own, 8 s.
    const out = await Promise.race([f.click(), new Promise<{ ok: false; text: string }>(resolve => setTimeout(() => resolve({ ok: false, text: "STALLED: the step did not end while the navigation was held" }), 8_000))]);
    const took = Date.now() - began; await f.settle();
    expect(out.text).toBe(payModule!.PAY_TEXT.mayBePressed);
    expect(f.cards).toHaveLength(1);
    expect(f.sent).toEqual(["mousePressed"]);
    expect([hits.pay, hits.pay2, hits.other]).toEqual([[], 0, 0]);
    expect(f.records()).toEqual(["uncertain"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.mayBePressed);
    // 900 ms of the row's own wait for the redirect, one bounded read (700 ms), the card flow: under the 3 s release (a step that waits for it takes over 3 s).
    expect(took).toBeLessThan(2_950);
    // The hold is released with the step: the page's own redirect then goes ahead, and nothing was pressed there.
    await f.page.waitForURL("**/checkout2", { timeout: 5_000 });
    expect(hits.pay2).toBe(0);
  }, 60_000);

  // The row only the hold can pass: the redirect starts after the release check, right before the release. Without the hold the release lands on
  // the new document, which charges on a bare mouse release. With it the release reaches the approved document, whose guard compares at the event.
  it("W-J16-NAV-RELEASE: a redirect that starts right before the release is held: the release never reaches the new document; the approved order is paid once", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mouseReleased") { await page.evaluate("location.href='/release-pays'"); await page.waitForURL("**/release-pays", { timeout: 500 }).catch(() => {}); } } });
    const out = await Promise.race([f.click(), new Promise<{ ok: false; text: string }>(resolve => setTimeout(() => resolve({ ok: false, text: "STALLED: the step did not end while the navigation was held" }), 8_000))]);
    await f.settle();
    expect(hits.pay2).toBe(0);
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.pay).toEqual(["$42.99"]);
    // The report cannot be read back while the redirect is held, and need not be: the guard pushed it at the click. The approved order was pressed once.
    expect([out.text, f.records()]).toEqual(["", ["pressed"]]);
    await f.page.waitForURL("**/release-pays", { timeout: 5_000 });
    expect(hits.pay2).toBe(0);
  }, 60_000);

  // The pay button's own form post is a main-frame navigation too, so it is held, and once it is held the guard's report cannot be read back (the
  // page answers nothing). Whether the report read arrives before the post is held is a race the round trip decides. What is proven in both rows is
  // the money edge: the shop gets the approved order exactly once, the step ends inside the bound, and a step that could not read the report is
  // recorded `pressed`: the guard pushes its report at the click (PAY_REPORT_BINDING), before the post is held, so nothing has to be read back.
  const stalled = (what: string) => new Promise<{ ok: false; text: string }>(resolve => setTimeout(() => resolve({ ok: false, text: `STALLED: the step did not end while ${what} was held` }), 8_000));
  it("W-J16-FORM-POST-SLOW: a form-post checkout whose report read arrives after the post is held: paid once, no stall, recorded pressed", async () => {
    const f = await fixture({ path: "/checkout-form", afterReleaseMs: 300 });
    const began = Date.now();
    const out = await Promise.race([f.click(), stalled("the form post")]);
    const took = Date.now() - began; await f.settle();
    expect([out.text, f.records()]).toEqual(["", ["pressed"]]);
    expect(f.cards).toHaveLength(1);
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.form).toBe(1);
    expect(f.records()).toEqual(["pressed"]);
    expect(took).toBeLessThan(2_950);
    expect([hits.pay, hits.pay2, hits.other]).toEqual([[], 0, 0]);
  }, 60_000);

  it("W-J16-FORM-POST: a form-post checkout with no delay is paid exactly once and the step never says nothing was pressed", async () => {
    const f = await fixture({ path: "/checkout-form" });
    const out = await Promise.race([f.click(), stalled("the form post")]); await f.settle();
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.form).toBe(1);
    // No race is left: whether or not a read would have arrived before the post was held, the pushed report says pressed.
    expect([out.text, f.records()[0]]).toEqual(["", "pressed"]);
    expect(f.records()).toHaveLength(1);
  }, 60_000);

  it("W-J16-LATE-GO: a press that starts more than 2 s after the final check sends nothing", async () => {
    // Page reads: 1 card, 2 guard-free recheck before the press (the final check itself uses the guard's own read).
    const f = await fixture({ slowReadAt: 2 });
    const out = await f.click(); await f.settle();
    expect(f.cards).toHaveLength(1);
    expect(f.sent).toEqual([]);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["not-pressed"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.notPressed);
  }, 60_000);

  it("W-J16-DEADLINE: an input delivered after the guard's own 2 s deadline is cancelled in the page", async () => {
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") await page.waitForTimeout(2_300); } });
    const out = await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed", "mouseReleased"]);
    expect(hits.pay).toEqual([]);
    expect(f.records()).toEqual(["not-pressed"]);
    expect(out.text).toBe(payModule!.PAY_TEXT.notPressed);
  }, 60_000);

  it("W-J16-NO-HOLD: an extension that cannot hold navigations gets no pay card: the step is the owner's, nothing is pressed", async () => {
    const f = await fixture({ capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1"] });
    const out = await f.click(); await f.settle();
    expect(f.cards).toHaveLength(0);
    expect(hits.pay).toEqual([]);
    expect(out.text).toMatch(/^YOUR TURN:/);
  }, 60_000);

  // OPUS 48afad07fb: the error path that reads the guard's report after a refused release. The press half was let through by the guard (one event
  // passed), then the page raised the total and clicked the button itself (the guard cancelled that and says `changed`). A report that says
  // `changed` with something already let through must never become "nothing was pressed": the record stays uncertain and is never repeated.
  it("W-J16-CATCH-PASSED: after the guard let the press half through, a `changed` report never turns the step into `nothing was pressed`", async () => {
    const f = await fixture({ afterPressed: `${setTotal("$4,299.00")};document.getElementById('pay').click()` });
    const out = await f.click(); await f.settle();
    expect(f.sent).toEqual(["mousePressed"]);
    expect(hits.pay).toEqual([]);
    expect([f.records(), out.text]).toEqual([["uncertain"], payModule!.PAY_TEXT.releaseChanged]);
  }, 60_000);

  // The pushed report is trusted only from this press: a call from another world, or without this press's nonce, is not a report. The page's own
  // world has no such function at all (the binding exists only in Murage's isolated world).
  for (const forge of ["world", "nonce"] as const) it(`W-J16-PUSH-FORGED-${forge.toUpperCase()}: a pushed "pressed" with the wrong ${forge} is ignored: the cancelled press stays changed`, async () => {
    const f = await fixture({ forge, between: async (type, page) => { if (type === "mousePressed") await page.evaluate(setTotal("$4,299.00")); } });
    const out = await f.click(); await f.settle();
    expect(hits.pay).toEqual([]);
    expect([f.records(), out.text]).toEqual([["changed"], payModule!.PAY_TEXT.changed]);
  }, 60_000);
  it("W-J16-PUSH-PAGE-BLIND: while the hold is on the page's own world cannot see or call the report binding", async () => {
    let seen = "";
    const f = await fixture({ between: async (type, page) => { if (type === "mousePressed") seen = await page.evaluate<string>("typeof globalThis.__muragePayReport"); } });
    const out = await f.click(); await f.settle();
    expect([out.text, f.records()]).toEqual(["", ["pressed"]]);
    expect(seen).toBe("undefined");
  }, 60_000);
  // ASTRA pre-check d27fe6b957: a build that declares only the first hold (pay_hold_v1: it holds, but refuses the report binding) must not be offered a card it cannot finish.
  it("W-J16-OLD-HOLD: an extension that holds navigations but cannot push the report (pay_hold_v1 only) gets no pay card: the step is the owner's, nothing is pressed", async () => {
    const f = await fixture({ capabilities: ["scoped_cdp", "durable_stop", "explicit_share", "manual_pause", "engine_cdp_v1", "unexpected_input_pause", "ordered_requests_v1", "pay_hold_v1"] });
    const out = await f.click(); await f.settle();
    expect([f.cards.length, hits.pay, /^YOUR TURN:/.test(out.text)]).toEqual([0, [], true]);
  }, 60_000);
});
