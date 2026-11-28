// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MIC-CENTER (1.0.22): on the phone composer every in-pill button (the mic, and Send once there is text) shares a
// centre with the text line it sits beside: the first line while the field is one line, the LAST line as it grows.
// Measured with getBoundingClientRect on the real Composer in the real app (same harness as phone-ui-1019).
// Tell rows: the compact Today Tell box (the Chief's own Composer) at 390: its buttons share the text line's centre.
// Busy row: Stop, Call me and the mic in a running turn share it too; the Call-me alert's own buttons get no margin.
// Row (d): at a desktop width and at a narrow fine-pointer window the pill, field and buttons keep their base boxes.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "./scoped-tailwind";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> };
let vite: ViteDevServer;
let origin: string;
const BOT = "Mic quiet";
const CHIEF = "Tell chief";
const BUSY = "Mic busy";
const OUT = process.env.MIC_OUT_DIR ?? "";
const log = (tag: string, value: unknown) => {
  const line = `MIC-MEASURE ${tag} ${JSON.stringify(value)}`;
  console.log(line);
  if (OUT) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, `${tag.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(value, null, 1)); }
};

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const quiet=store.createBot({name:${JSON.stringify(BOT)}},{seedMessages:false});
    store.appendMessage(quiet.threadId,{role:'bot',kind:'text',text:'Ready when you are.',at:Date.now()-60000});
    const chief=store.createBot({name:${JSON.stringify(CHIEF)}},{seedMessages:false});
    chief.chiefOfStaff=true;chief.chiefScope='workspace';
    store.saveBots();
    store.createBot({name:${JSON.stringify(BUSY)}},{seedMessages:false});
  `, env: {} });
  try {
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json();
    const named = await fetch(`${fixture.info.url}/api/config`, { method: "PUT", body: JSON.stringify({ profile: { name: "Mic owner" } }),
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" } });
    if (!named.ok) throw new Error(`Could not name the fixture owner: ${named.status}`);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "mic-center-vite-cache"),
      resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No fixture UI port");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openChat(page: Page, bot = BOT) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("help.seen.chat.level-chip", "1"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toBeAttached({ timeout: 60_000 });
  const sidebar = await openSidebar(page);
  await sidebar.getByText(bot, { exact: true }).first().click();
  await expect(page.locator("[data-testid=chat-scroll]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-composer-pill] textarea")).toBeVisible();
}

/** Every box in the composer pill plus where its text lines sit (all numbers rounded to 0.01). */
const measure = (page: Page, scope = "[data-composer-pill]") => page.evaluate((scope) => {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const box = (el: Element): { x: number; y: number; w: number; h: number } => { const r = el.getBoundingClientRect(); return { x: r2(r.left), y: r2(r.top), w: r2(r.width), h: r2(r.height) }; };
  const pillEl = document.querySelector(scope)!;
  const ta = pillEl.querySelector("textarea")!;
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 24, pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const t = ta.getBoundingClientRect();
  const buttons = [...pillEl.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.closest("[role=alert]"); })
    .map((b) => ({ label: b.getAttribute("aria-label") ?? "", ...box(b), cy: r2(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2) }));
  return {
    pill: box(pillEl), textarea: box(ta), buttons, lineHeight: lh, padTop: pt, padBottom: pb,
    firstLineCy: r2(t.top + pt + lh / 2), lastLineCy: r2(t.bottom - pb - lh / 2), scrolls: ta.scrollHeight > ta.clientHeight + 1,
  };
}, scope);
type M = Awaited<ReturnType<typeof measure>>;

function expectCentred(m: M, which: "firstLineCy" | "lastLineCy", where: string) {
  expect(m.buttons.length, `${where}: a button in the pill`).toBeGreaterThan(0);
  for (const b of m.buttons) {
    expect.soft(Math.abs(b.cy - m[which]), `${where}: "${b.label}" centre ${b.cy} vs ${which} ${m[which]}`).toBeLessThanOrEqual(1);
    expect(b.y, `${where}: "${b.label}" inside the pill (top)`).toBeGreaterThanOrEqual(m.pill.y - 0.5);
    expect(b.y + b.h, `${where}: "${b.label}" inside the pill (bottom)`).toBeLessThanOrEqual(m.pill.y + m.pill.h + 0.5);
  }
}

test.describe("phone 390x844, touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("the mic (and Send) share a centre with the text line, at one line and at three", async ({ page }) => {
    await openChat(page);
    const field = page.getByPlaceholder(/^Message /).first();
    const shot = async (tag: string) => { if (OUT) await page.locator("[data-composer-pill]").locator("xpath=../..").screenshot({ path: join(OUT, `phone-${tag}.png`) }); };

    const a = await measure(page); log("phone-a-empty", a); await shot("a-empty");
    expect(a.scrolls).toBe(false);
    expectCentred(a, "firstLineCy", "(a) empty placeholder");

    await field.fill("hello there");
    const b = await measure(page); log("phone-b-one-line", b); await shot("b-one-line");
    expect(b.textarea.h).toBe(a.textarea.h);
    expectCentred(b, "firstLineCy", "(b) one typed line");

    await field.fill("one\ntwo\nthree");
    const c = await measure(page); log("phone-c-three-lines", c); await shot("c-three-lines");
    expect(c.textarea.h).toBeGreaterThan(a.textarea.h + 40);
    expect(c.scrolls).toBe(false);
    expectCentred(c, "lastLineCy", "(c) three lines");
  });
});

// Baselines (composer-mic-center.base.json): measured on base 7ad605ec88 with this same spec.
const BASE: Record<string, M | undefined> = JSON.parse(readFileSync(fileURLToPath(new URL("./composer-mic-center.base.json", import.meta.url)), "utf8"));
for (const [tag, width, height] of [["desktop-1280x800", 1280, 800], ["narrow-700x800", 700, 800]] as const) {
  test.describe(`(d) ${tag}, fine pointer`, () => {
    test.use({ viewport: { width, height }, hasTouch: false, isMobile: false });
    test(`composer boxes at ${tag}`, async ({ page }) => {
      await openChat(page);
      const field = page.getByPlaceholder(/^Message /).first();
      const rest = await measure(page); log(`${tag}-empty`, rest);
      await field.fill("hello there");
      const typed = await measure(page); log(`${tag}-typed`, typed);
      await field.fill("one\ntwo\nthree");
      const three = await measure(page); log(`${tag}-three`, three);
      for (const [name, got] of [["empty", rest], ["typed", typed], ["three", three]] as const) {
        const base = BASE[`${tag}-${name}`];
        expect(base, `baseline ${tag}-${name} supplied`).toBeTruthy();
        expect(got.pill, `${tag}/${name} pill`).toEqual(base!.pill);
        expect(got.textarea, `${tag}/${name} textarea`).toEqual(base!.textarea);
        expect(got.buttons.length, `${tag}/${name} button count`).toBe(base!.buttons.length);
        got.buttons.forEach((g, i) => {
          const o = base!.buttons[i];
          expect({ x: g.x, w: g.w, h: g.h, label: g.label }, `${tag}/${name} button ${i} x/size`).toEqual({ x: o.x, w: o.w, h: o.h, label: o.label });
          // 700px is the phone layout (width, not pointer, picks it): a button moves exactly 6px UP, the margin the fix adds.
          // At 1280 nothing moves.
          if (width < 768) { expect(g.y - o.y, `${tag}/${name} button ${i} y`).toBeGreaterThanOrEqual(-6.5); expect(g.y - o.y, `${tag}/${name} button ${i} y`).toBeLessThanOrEqual(-5.5); }
          else expect(g.y, `${tag}/${name} button ${i} y`).toBe(o.y);
        });
      }
    });
  });
}

const tellBox = '[data-today="tell"]';
async function openToday(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("help.seen.chat.level-chip", "1"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toBeAttached({ timeout: 60_000 });
  const box = page.locator(tellBox);
  if (!(await box.isVisible({ timeout: 8_000 }).catch(() => false))) {
    const sidebar = await openSidebar(page);
    await sidebar.getByRole("button", { name: "Today", exact: true }).click();
  }
  await expect(box.locator("textarea")).toBeVisible({ timeout: 30_000 });
}

test.describe("Today Tell box, phone 390x844, touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("its buttons share a centre with the text line, empty and typed", async ({ page }) => {
    await openToday(page);
    const a = await measure(page, tellBox); log("tell-phone-empty", a);
    expectCentred(a, "lastLineCy", "(tell a) empty placeholder");
    await page.locator(`${tellBox} textarea`).fill("hello there");
    const b = await measure(page, tellBox); log("tell-phone-typed", b);
    expect(b.buttons.length, "typed: Send joins the mic").toBeGreaterThanOrEqual(2);
    expectCentred(b, "lastLineCy", "(tell b) one typed line");
  });
});

test.describe("Today Tell box, 764x800, touch (761-767px band)", () => {
  test.use({ viewport: { width: 764, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("its buttons share a centre with the text line, empty and typed", async ({ page }) => {
    await openToday(page);
    const a = await measure(page, tellBox); log("tell-764-empty", a);
    expectCentred(a, "lastLineCy", "(tell 764 a) empty placeholder");
    await page.locator(`${tellBox} textarea`).fill("hello there");
    const b = await measure(page, tellBox); log("tell-764-typed", b);
    expect(b.buttons.length, "typed: Send joins the mic").toBeGreaterThanOrEqual(2);
    expectCentred(b, "lastLineCy", "(tell 764 b) one typed line");
  });
});

test.describe("Today Tell box, 1280x800, fine pointer", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  test("boxes are unchanged from base", async ({ page }) => {
    await openToday(page);
    const rest = await measure(page, tellBox); log("tell-1280x800-empty", rest);
    await page.locator(`${tellBox} textarea`).fill("hello there");
    const typed = await measure(page, tellBox); log("tell-1280x800-typed", typed);
    for (const [name, got] of [["empty", rest], ["typed", typed]] as const) {
      const base = BASE[`tell-1280x800-${name}`];
      expect(base, `baseline tell-1280x800-${name} supplied`).toBeTruthy();
      // The Today head above the box (greeting, lead line, status tags) follows the clock and the day, so the box sits at a different page y each run: x, w, h stay exact, y is taken relative to the pill.
      const rel = (m: M) => { const dy = <T extends { y: number }>(b: T) => ({ ...b, y: Math.round((b.y - m.pill.y) * 100) / 100 }); return { pill: { x: m.pill.x, w: m.pill.w, h: m.pill.h }, textarea: dy(m.textarea), buttons: m.buttons.map(({ cy: _cy, ...b }) => dy(b)) }; };
      const want = rel(base!), have = rel(got);
      expect(have.pill, `tell/${name} box`).toEqual(want.pill);
      expect(have.textarea, `tell/${name} textarea`).toEqual(want.textarea);
      expect(have.buttons, `tell/${name} buttons`).toEqual(want.buttons);
    }
  });
});

test.describe("busy turn, phone 390x844, touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  test("Stop, Call me and the mic share the text line's centre; the Call-me alert buttons carry no margin", async ({ page }) => {
    // The server has no running turn to show, so the roster the client reads says this one bot is mid-turn.
    const working = (o: unknown, depth = 0): void => {
      if (!o || typeof o !== "object" || depth > 4) return;
      const rec = o as Record<string, unknown>;
      if (rec.name === BUSY && typeof rec.id === "string") {
        rec.busy = true; rec.activity = "working";
        for (const task of (rec.tasks as Array<Record<string, unknown>> | undefined) ?? []) { task.busy = true; task.activity = "working"; } // the viewed task carries busy
      }
      for (const v of Object.values(rec)) working(v, depth + 1);
    };
    await page.route((url) => url.pathname.startsWith("/api/bots"), async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json().catch(() => null);
      if (!body) return route.fulfill({ response });
      working(body);
      await route.fulfill({ response, json: body });
    });
    await page.route("**/api/calls/turn-end", (route) => route.fulfill({ status: 409, json: { error: "no_voice" } }));
    await openChat(page, BUSY);
    await expect(page.locator("[data-composer-pill]").getByRole("button", { name: "Stop this turn" })).toBeVisible({ timeout: 15_000 });
    const call = page.locator("[data-composer-pill]").getByRole("button", { name: /call me/i });
    await expect(call).toBeVisible();
    const m = await measure(page); log("phone-busy", m);
    expect(m.buttons.length, "busy: Stop, Call me and the mic").toBeGreaterThanOrEqual(3);
    expectCentred(m, "firstLineCy", "(busy) one line");
    await call.click();
    const alert = page.locator("[role=alert]");
    await expect(alert).toBeVisible();
    const margins = await alert.locator("button").evaluateAll((els) => els.map((el) => getComputedStyle(el).marginBottom));
    expect(margins.length, "alert has its Close button").toBeGreaterThan(0);
    expect(margins, "alert buttons carry no margin").toEqual(margins.map(() => "0px"));
  });
});
