// SPDX-License-Identifier: AGPL-3.0-or-later
// MONEY #1 (MAIN, 1.0.24), real-browser proof: a Stripe test-mode style checkout page is served on loopback and driven in a REAL Chromium (Playwright). The
// spawned built-in unified proxy (unified-browser-proxy.ts, the one the built-in browser mounts) reads the page's real accessibility snapshot and decides each step
// through the real floor gate; a step the gate lets through is executed on the page. The host answers murage/floor-lift from the real decision
// (browser-floor-lift.ts builtinFloorLift on the decision fixture and the real outside-mark store), so the owner at No limits pays, and a guest turn and an
// email-triggered turn do not (the pay click never reaches the page: the checkout server counts zero payments). A CAPTCHA control stays a hand-off for the owner.
// Needs a Chromium: the offline test container has none, so this runs only with MURAGE_REAL_BROWSER=1 on a host with the Playwright browsers
// (PLAYWRIGHT_BROWSERS_PATH set) and a node 24 (the decision fixture's sqlite); the gate lists it as extended. Owners: lane q1024-paynl (witness), MAIN (policy).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture } from "./decision/fixture.ts";
import { builtinFloorLift } from "./browser-floor-lift.ts";
import { markTurnOutside } from "./email/external-marks.ts";
import { runBoundBridge } from "./testing/bound-proxy-fixture.ts";
import { useOutsideStoreFixture } from "./testing/outside-store-fixture.ts";

useOutsideStoreFixture();
const REAL = process.env.MURAGE_REAL_BROWSER === "1";
const turn = { threadId: "t", generation: "g", botId: "b" };
// A Stripe test-mode Payment Element page (test card 4242 4242 4242 4242): card number, expiry, CVC, terms, a Pay button, and a human check.
const PAGE = `<!doctype html><title>Test mode checkout</title><h1>Test mode checkout, Acme Ltd</h1>
<label>Card number <input id="card" autocomplete="cc-number"></label><label>MM / YY <input id="exp" autocomplete="cc-exp"></label><label>CVC <input id="cvc" autocomplete="cc-csc"></label>
<label><input id="terms" type="checkbox"> I agree to the terms and conditions</label>
<button id="pay" onclick="fetch('/pay',{method:'POST'})">Pay $19.00</button><button id="human" onclick="fetch('/human',{method:'POST'})">I'm not a robot</button>`;

type Driver = { snapshot(): Promise<string>; act(tool: string, args: Record<string, unknown>): Promise<string>; state(): Promise<{ card: string; terms: boolean }>; close(): Promise<void> };
let site: Server; let siteUrl = ""; const hits = { pay: 0, human: 0 };

async function openPage(): Promise<Driver> {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(siteUrl);
  const ref = (selector: unknown) => `aria-ref=${String(selector).replace(/^@/, "")}`;
  return {
    snapshot: async () => (await (page as unknown as { _snapshotForAI(): Promise<{ full: string }> })._snapshotForAI()).full,
    act: async (tool, args) => {
      if (tool === "agent_browser_click") await page.locator(ref(args.selector)).click({ timeout: 5_000 });
      else if (tool === "agent_browser_fill") await page.locator(ref(args.selector)).fill(String(args.text), { timeout: 5_000 });
      await page.waitForTimeout(150);
      return "ok";
    },
    state: async () => ({ card: await page.inputValue("#card"), terms: await page.isChecked("#terms") }),
    close: () => browser.close(),
  };
}

beforeAll(async () => {
  if (!REAL) return;
  site = createServer((req, res) => {
    if (req.method === "POST") { hits[req.url === "/pay" ? "pay" : "human"]++; res.end("ok"); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
afterAll(() => { site?.close(); });

const rpc = (id: number, name: string, args: object) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const refOf = (snapshot: string, role: string, name: RegExp) => `@${new RegExp(`${role} "[^"]*${name.source}[^"]*"[^\\n]*\\[ref=(e\\d+)\\]`, "i").exec(snapshot)?.[1] ?? "none"}`;
const refused = (text: string | undefined) => /^YOUR TURN:/.test(text ?? "");

/** The host the spawned proxy talks to: the real page for every step, the real decision for murage/floor-lift. */
async function host(driver: Driver) {
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      const call = JSON.parse(body || "{}") as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      res.writeHead(200, { "content-type": "application/json" });
      if (call.method === "murage/floor-lift") { res.end(JSON.stringify({ lift: builtinFloorLift(turn) })); return; }
      const name = call.params?.name ?? "";
      const text = name === "agent_browser_snapshot" ? await driver.snapshot() : await driver.act(name, call.params?.arguments ?? {}).catch((e: Error) => `engine error: ${e.message}`);
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

type Mode = { who: string; setup: () => void; mountFlag: boolean; pays: boolean };
const MODES: Mode[] = [
  { who: "owner typed turn at No limits", setup: () => fixture("unlimited", { k: "owner-typed" }), mountFlag: true, pays: true },
  { who: "guest turn (no flag at the mount)", setup: () => fixture("unlimited", { k: "guest" } as Parameters<typeof fixture>[1]), mountFlag: false, pays: false },
  { who: "owner turn at Full access (no flag at the mount)", setup: () => fixture("ask", { k: "owner-typed" }), mountFlag: false, pays: false },
  { who: "email-triggered turn: the owner's turn is marked by an email before the mount", setup: () => { fixture("unlimited", { k: "owner-typed" }); markTurnOutside("t", "email"); }, mountFlag: false, pays: false },
  { who: "an email arrives after the mount: the flag is set but the live answer is lift:false", setup: () => { fixture("unlimited", { k: "owner-typed" }); markTurnOutside("t", "email"); }, mountFlag: true, pays: false },
];

describe.skipIf(!REAL)("real Chromium on a Stripe test-mode checkout page, through the spawned built-in proxy", () => {
  for (const { who, setup, mountFlag, pays } of MODES) it(`${who}: ${pays ? "completes the payment" : "is refused at the pay button"}`, async () => {
    setup();
    hits.pay = 0; hits.human = 0;
    const driver = await openPage();
    const h = await host(driver);
    try {
      const snapshot = await driver.snapshot();
      const card = refOf(snapshot, "textbox", /card number/), terms = refOf(snapshot, "checkbox", /terms/), pay = refOf(snapshot, "button", /pay/), human = refOf(snapshot, "button", /not a robot/);
      expect([card, terms, pay, human].some((r) => r === "@none"), `the page's real snapshot shows every control: ${snapshot}`).toBe(false);
      const env = { MURAGE_CONTROL_URL: h.url, MURAGE_CONTROL_TOKEN: "fixture-token", MURAGE_BOT_ID: "b", MURAGE_THREAD_ID: "t", ...(mountFlag ? { MURAGE_BROWSER_NO_LIMITS: "1" } : {}) };
      const lines = [JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }), rpc(1, "agent_browser_snapshot", {}), rpc(2, "agent_browser_fill", { selector: card, text: "4242424242424242" }), rpc(3, "agent_browser_click", { selector: terms }), rpc(4, "agent_browser_click", { selector: pay }), rpc(5, "agent_browser_click", { selector: human })];
      const script = "const m=await import('./server/drivers/unified-browser-proxy.ts');void m.runUnifiedBrowserProxy();";
      const frames = await runBoundBridge(script, lines, lines.length, false, { role: "unifiedBrowser", env, owner: true, delays: [0, 1_000, 1_000, 1_000, 1_000, 1_000], timeoutMs: 90_000 });
      const reply = (id: number) => (frames.map((f) => JSON.parse(f) as { id?: number; result?: { content?: Array<{ text?: string }> } }).find((r) => r.id === id))?.result?.content?.[0]?.text;
      expect(refused(reply(4)), `${who}: the Pay click answer`).toBe(!pays);
      expect(hits.pay, `${who}: payments the checkout server received`).toBe(pays ? 1 : 0);
      expect((await driver.state()).card, `${who}: the card number on the page`).toBe(pays ? "4242424242424242" : "");
      expect(refused(reply(5)), `${who}: the human check is a hand-off at every level`).toBe(true);
      expect(hits.human, `${who}: the human-check control was never pressed`).toBe(0);
    } finally { h.close(); await driver.close(); }
  }, 180_000);
});
