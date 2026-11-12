// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PHONE-UI-1019: the Door UI at two phone widths (a Galaxy S25, 412x915, and an
// iPhone 15, 393x852) with a touch screen, plus one desktop-width check that
// the desktop did not change. Against the real app on a real harness with its
// own data dir, seeded with a long chat, a settled approval, a waiting
// approval and a team big enough that the Today chips overflow.
//
// Pins (1.0.18 phone pass, S25 screenshots 123982-123987):
//  - no element past the screen's right edge on Today, Chats, a chat and Settings;
//  - a touch screen keeps its own overlay scroll bars (the styled 8px bars are
//    for a mouse) and the Today chip rows show none;
//  - no floating "?" tab below 768px, and Help is still one tap away (You menu);
//  - the transcript's left and right gaps match, and the waiting approval card
//    sits on the same edges as the other cards;
//  - the composer's placeholder is centred in its pill, and the field still grows.
import { test, expect, type Page } from "./page-error-guard";
import { chromium, webkit } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures";
import { accountMenuTrigger } from "./sidebar-nav";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> };
let vite: ViteDevServer;
let origin: string;

const BUSY = "Phone busy";
const QUIET = "Phone quiet";

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const now=Date.now();
    const busy=store.createBot({name:${JSON.stringify(BUSY)}},{seedMessages:false});
    const quiet=store.createBot({name:${JSON.stringify(QUIET)}},{seedMessages:false});
    for(const n of ['Atlas','Birch','Cedar','Delta','Ember','Fjord','Grove','Harbor']) store.createBot({name:n+' team member'},{seedMessages:false});
    const long='This is a long reply that wraps over several lines on a phone so the transcript has real text to measure. '.repeat(6);
    for(let i=0;i<4;i++){
      store.appendMessage(busy.threadId,{role:'user',kind:'text',text:'Question number '+i+' with enough words to wrap on a phone screen.',at:now-(20-i*3)*60000});
      store.appendMessage(busy.threadId,{role:'bot',kind:'text',text:long,at:now-(19-i*3)*60000});
    }
    store.appendMessage(busy.threadId,{role:'bot',kind:'options',at:now-60000,card:{requestId:'req-done',title:'Approval needed',subtitle:'write notes.txt',options:['Allow','Deny'],tool:'Write',answered:'allow'}});
    store.appendMessage(busy.threadId,{role:'bot',kind:'options',at:now-30000,card:{requestId:'req-wait',title:'Approval needed',subtitle:'rm -rf ./scratch',wants:'Remove the scratch folder',options:['Allow','Deny'],tool:'Bash'}});
    store.appendMessage(quiet.threadId,{role:'bot',kind:'text',text:'Ready when you are.',at:now-60000});
    store.saveBots();
  ` });
  try {
    const { secret } = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json();
    const named = await fetch(`${fixture.info.url}/api/config`, { method: "PUT", body: JSON.stringify({ profile: { name: "Phone owner" } }),
      headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" } });
    if (!named.ok) throw new Error(`Could not name the fixture owner: ${named.status}`);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "phone-ui-vite-cache"),
      resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("No fixture UI port");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function open(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toBeAttached({ timeout: 60_000 });
}
async function openToday(page: Page) {
  const sidebar = await openSidebar(page);
  await sidebar.locator('[data-door="today"]').first().click();
  await expect(page.locator("[data-view=today]")).toBeVisible({ timeout: 30_000 });
}
async function openChat(page: Page, name: string) {
  const sidebar = await openSidebar(page);
  const row = sidebar.getByText(name, { exact: true }).first();
  // The team list shows eight bots and folds the rest behind "N more".
  if (!(await row.isVisible())) await sidebar.getByRole("button", { name: /\d+ more/ }).first().click();
  try { await row.click({ timeout: 10_000 }); } catch (error) { throw new Error(`no sidebar row "${name}"; sidebar says: ${(await sidebar.innerText()).replace(/\s+/g, " ").slice(0, 600)}`, { cause: error }); }
  await expect(page.locator("[data-testid=chat-scroll]")).toBeVisible({ timeout: 30_000 });
}

/** Elements that reach past the screen's right edge and are not clipped by a scroller that stays on screen. */
function pastTheEdge(page: Page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX !== "visible" && p.getBoundingClientRect().right <= vw + 1) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || s.position === "fixed" && r.left >= vw) continue;
      if (el.closest("[inert],[hidden],[aria-hidden=true]")) continue;
      if (clipped(el)) continue;
      out.push(`${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${String(el.getAttribute("class") ?? "").slice(0, 60)} right=${Math.round(r.right)}`);
    }
    return { scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: vw, out: out.slice(0, 8) };
  });
}
async function expectNoOverflow(page: Page, where: string) {
  const found = await pastTheEdge(page);
  expect(found.scrollWidth, `${where}: page scrollWidth`).toBeLessThanOrEqual(found.innerWidth);
  expect(found.out, `${where}: elements past the right edge`).toEqual([]);
}


/** The top fade is exactly the transparent-to-opaque 16px gradient, not just any gradient. */
const TOP_FADE = /linear-gradient\((to bottom, )?(rgba\(0, 0, 0, 0\)|transparent), (rgb\(0, 0, 0\)|#000|black) 16px\)/;
const maskOf = (page: Page) => page.evaluate(() => { const s = getComputedStyle(document.querySelector("[data-testid=chat-scroll]")!); return s.maskImage || s.webkitMaskImage || "none"; });
const scrollChat = (page: Page, top: number) => page.evaluate((y) => { document.querySelector("[data-testid=chat-scroll]")!.scrollTop = y; }, top);

/** The waiting approval panel, the waiting strip, the settled card and a bubble: all must exist; edges must agree. */
async function expectApprovalAligned(page: Page) {
  await expect(page.locator("[data-approval-queue]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-approval-waiting]")).toBeVisible();
  const settled = page.locator("[data-testid=chat-scroll] .max-w-\\[840px\\]:not([data-approval-waiting])").first();
  await expect(settled, "the settled approval card").toBeVisible();
  await expect(page.getByTestId("msg-bubble").first(), "a message bubble").toBeVisible();
  const edges = await page.evaluate(() => {
    const box = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
    return { vw: innerWidth,
      waiting: box(document.querySelector("[data-approval-waiting]")!),
      settled: box(document.querySelector("[data-testid=chat-scroll] .max-w-\\[840px\\]:not([data-approval-waiting])")!),
      queue: box(document.querySelector("[data-approval-queue]")!),
      bubble: box(document.querySelector("[data-testid=msg-bubble]")!) };
  });
  expect(Math.abs(edges.waiting.left - (edges.vw - edges.waiting.right)), "equal side gaps").toBeLessThanOrEqual(2);
  expect(Math.abs(edges.queue.left - edges.waiting.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(edges.queue.right - edges.waiting.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(edges.queue.left - edges.settled.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(edges.queue.right - edges.settled.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(edges.bubble.left - edges.settled.left), "the bubble's left edge meets the cards'").toBeLessThanOrEqual(2);
  expect(Math.abs(edges.bubble.left - edges.queue.left), "the bubble's left edge meets the approval panel's").toBeLessThanOrEqual(2);
}
/** Placeholder centre vs pill centre, and how far the field's height is from what its words need (0 unless at the cap). */
const fieldShape = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLTextAreaElement>("[data-composer-pill] textarea")!;
  const pill = document.querySelector("[data-composer-pill]")!.getBoundingClientRect();
  const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || 24;
  const textCentre = r.top + parseFloat(cs.paddingTop) + line / 2;
  const shown = el.clientHeight;
  const keep = el.style.height; el.style.height = "auto"; const natural = el.scrollHeight; el.style.height = keep;
  const cap = line * 6 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  return { off: Math.abs(textCentre - (pill.top + pill.height / 2)), height: r.height, shown, natural, cap, stale: natural < cap - 1 ? Math.abs(natural - shown) : 0, clipped: el.scrollHeight - el.clientHeight };
});

for (const [width, height] of [[412, 915], [393, 852]] as const) {
  test.describe(`phone ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2.6 });

    test("nothing is wider than the screen on Today, Chats, a chat and Settings", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openToday(page);
      await expectNoOverflow(page, "Today");
      const sidebar = await openSidebar(page);
      await sidebar.locator('[data-door="chats"]').first().click();
      await expect(page.getByRole("heading", { name: /chats/i }).first()).toBeVisible({ timeout: 30_000 });
      await expectNoOverflow(page, "Chats");
      await openChat(page, BUSY);
      await expectNoOverflow(page, "a chat");
      const side = await openSidebar(page);
      await accountMenuTrigger(side).click();
      await page.getByRole("menu", { name: "Your menu" }).getByRole("menuitem", { name: /^Settings/ }).click();
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
      await expectNoOverflow(page, "Settings");
    });

    test("a touch screen keeps its own scroll bars, and the Today chip rows show none", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openToday(page);
      const chips = await page.evaluate(() => [...document.querySelectorAll("[data-today-status]")].map((el) => ({
        width: getComputedStyle(el).scrollbarWidth, webkit: getComputedStyle(el, "::-webkit-scrollbar").display })));
      expect(chips.length, "Today status chip rows").toBeGreaterThanOrEqual(1);
      for (const row of chips) expect(row.width === "none" || row.webkit === "none").toBe(true);
      const team = await page.evaluate(() => [...document.querySelectorAll("ul.no-scrollbar-phone")].map((el) => getComputedStyle(el).scrollbarWidth));
      expect(team.length, "Today status and team chip rows").toBeGreaterThanOrEqual(2);
      for (const width of team) expect(width).toBe("none");
      await openChat(page, BUSY);
      const bar = await page.evaluate(() => {
        const el = document.querySelector("[data-testid=chat-scroll]")!;
        return { coarse: matchMedia("(pointer: coarse)").matches, width: getComputedStyle(el).scrollbarWidth, webkit: getComputedStyle(el, "::-webkit-scrollbar").width };
      });
      expect(bar.coarse).toBe(true);
      expect(bar.width).not.toBe("thin");
      expect(bar.webkit).not.toBe("8px");
    });

    test("no help tab on a phone, and Help opens from the You menu", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openToday(page);
      await expect(page.locator("[data-help-launcher]")).toBeHidden();
      const sidebar = await openSidebar(page);
      await accountMenuTrigger(sidebar).click();
      await page.getByRole("menu", { name: "Your menu" }).getByRole("menuitem", { name: "Help", exact: true }).click();
      await expect(page.locator("[data-help-panel]")).toBeVisible();
    });

    test("the transcript sits evenly and the waiting approval card shares the other cards' edges", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openChat(page, BUSY);
      await expectApprovalAligned(page);
      // the fade: none at the top edge (the first message is not dimmed), present once scrolled
      const mask = () => maskOf(page);
      await scrollChat(page, 0);
      await expect.poll(mask).not.toMatch(TOP_FADE);
      await expect.poll(mask).toBe("none");
      await scrollChat(page, 300);
      await expect.poll(mask).toMatch(TOP_FADE);
    });

    test("Help opened from the You menu by keyboard returns focus to something visible", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openChat(page, BUSY);
      const sidebar = await openSidebar(page);
      await accountMenuTrigger(sidebar).focus();
      await page.keyboard.press("Enter");
      const item = page.getByRole("menu", { name: "Your menu" }).getByRole("menuitem", { name: "Help", exact: true });
      await item.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("[data-help-panel]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-help-panel]")).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return Boolean(el && el !== document.body && !el.closest("[inert]") && el.checkVisibility() && el.getBoundingClientRect().width > 0);
      })).toBe(true);
    });

    test("a modal window keeps its Help on a phone as a labelled button; the floating tab stays hidden", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openToday(page);
      const side = await openSidebar(page);
      await accountMenuTrigger(side).click();
      await page.getByRole("menu", { name: "Your menu" }).getByRole("menuitem", { name: /^Keyboard shortcuts/ }).click();
      await expect(page.locator("dialog[open]")).toBeVisible();
      await expect(page.locator("[data-help-launcher]")).toBeHidden();
      const button = page.locator("[data-help-modal-button]");
      await expect(button).toBeVisible();
      await expect(button).toHaveText("Help");
      await button.click();
      await expect(page.locator("[data-help-panel]")).toBeVisible();
    });

    test("the Today box stays at its compact height", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openToday(page);
      const box = page.locator("[data-composer-compact] textarea").first();
      await expect(box, "the Today tell box").toBeVisible();
      await box.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
      const h = await box.evaluate((el) => el.getBoundingClientRect().height);
      expect(h).toBeLessThanOrEqual(97);
    });

    test("the composer placeholder is centred in its pill and the field still grows", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openChat(page, QUIET);
      const field = page.getByPlaceholder(/^Message /).first();
      await expect(field).toBeVisible();
      const rest = await fieldShape(page);
      expect(rest.off).toBeLessThanOrEqual(2);
      await field.fill("one\ntwo\nthree");
      const grown = await fieldShape(page);
      expect(grown.height).toBeGreaterThan(rest.height + 30);
      // six lines and more: the field stops at six lines of text and scrolls inside
      await field.fill(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"));
      const capped = await fieldShape(page);
      expect(capped.height).toBeLessThanOrEqual(capped.cap + 1);
      expect(capped.height).toBeGreaterThanOrEqual(capped.cap - 2);
      expect(capped.clipped, "text beyond six lines scrolls inside the field").toBeGreaterThan(0);
      expect(await field.evaluate((el) => { el.scrollTop = 1000; return el.scrollTop; })).toBeGreaterThan(0);
      await field.fill("");
      expect((await fieldShape(page)).off).toBeLessThanOrEqual(2);
    });

    test("an unchanged draft is re-measured when the phone rotates and back", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await openChat(page, QUIET);
      const field = page.getByPlaceholder(/^Message /).first();
      await field.fill("word ".repeat(26));
      expect((await fieldShape(page)).stale).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width: height, height: width });
      await expect.poll(async () => (await fieldShape(page)).stale).toBeLessThanOrEqual(1);
      expect((await fieldShape(page)).clipped).toBeLessThanOrEqual(1);
      await page.setViewportSize({ width, height });
      await expect.poll(async () => (await fieldShape(page)).stale).toBeLessThanOrEqual(1);
      expect((await fieldShape(page)).clipped).toBeLessThanOrEqual(1);
    });

    test("right-to-left: nothing past the edge and the approval panel still meets the cards", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own phone viewport");
      await open(page);
      await page.evaluate(() => { document.documentElement.dir = "rtl"; });
      await openChat(page, BUSY);
      await expectApprovalAligned(page);
      await expectNoOverflow(page, "a chat (rtl)");
    });
  });
}

test.describe("composer width change inside one breakpoint", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  test("re-fits a wrapping draft with no ResizeObserver loop error", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "sets its own viewport");
    await page.addInitScript(() => {
      const W = window as unknown as { __roErrors: string[]; __roSync: string[]; ResizeObserver: typeof ResizeObserver };
      W.__roErrors = []; W.__roSync = [];
      // Root cause of the loop error: a callback that resizes its own target. Record any textarea whose height changes inside its own observer callback.
      const Orig = W.ResizeObserver;
      W.ResizeObserver = class extends Orig {
        constructor(cb: ResizeObserverCallback) {
          super((entries, observer) => {
            const areas = entries.map((e) => e.target).filter((t): t is HTMLTextAreaElement => t instanceof HTMLTextAreaElement);
            const before = areas.map((t) => t.offsetHeight);
            cb(entries, observer);
            areas.forEach((t, i) => { if (t.offsetHeight !== before[i]) W.__roSync.push(`${before[i]} -> ${t.offsetHeight}`); });
          });
        }
      };
      window.addEventListener("error", (e) => { if (/ResizeObserver/.test(e.message)) (window as unknown as { __roErrors: string[] }).__roErrors.push(e.message); });
    });
    await open(page);
    await openChat(page, QUIET);
    await page.getByPlaceholder(/^Message /).first().fill("word ".repeat(60));
    const fieldWidth = () => page.evaluate(() => document.querySelector<HTMLTextAreaElement>("[data-composer-pill] textarea")!.clientWidth);
    const widths = new Set<number>(), heights = new Set<number>();
    for (const w of [1280, 1000, 800, 1200, 780, 1280]) {
      await page.setViewportSize({ width: w, height: 800 });
      await expect.poll(async () => (await fieldShape(page)).stale, { message: `width ${w}` }).toBeLessThanOrEqual(1);
      expect((await fieldShape(page)).clipped).toBeLessThanOrEqual(1);
      widths.add(await fieldWidth()); heights.add(Math.round((await fieldShape(page)).shown));
    }
    expect(widths.size, "the field's own width really changed").toBeGreaterThan(2);
    expect(heights.size, "and the same words needed different heights").toBeGreaterThan(1);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { __roErrors: string[] }).__roErrors), "no ResizeObserver loop error").toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __roSync: string[] }).__roSync), "the field is not resized inside its own observer callback").toEqual([]);
  });
});

test.describe("desktop 1280x800 is unchanged", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  test("the help tab still shows and scroll bars are still styled", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "sets its own viewport");
    await open(page);
    await openChat(page, BUSY);
    await expect(page.locator("[data-help-launcher]")).toBeVisible();
    const bar = await page.evaluate(() => {
      const el = document.querySelector("[data-testid=chat-scroll]")!;
      return { fine: matchMedia("(hover: hover) and (pointer: fine)").matches, width: getComputedStyle(el).scrollbarWidth,
        webkit: getComputedStyle(el, "::-webkit-scrollbar").width };
    });
    expect(bar.fine).toBe(true);
    expect(bar.width, "the transcript's bar is the styled thin one").toBe("thin");
    expect(bar.webkit, "and the 8px webkit track").toBe("8px");
  });
});

// Not phones: a tablet and a phone on its side are 768px and wider, so they keep the desktop layout, the "?" tab and
// (with a touch screen) their own scroll bars.
for (const [name, width, height] of [["tablet 820x1180", 820, 1180], ["phone landscape 915x412", 915, 412]] as const) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });
    test("keeps the help tab, has nothing past the edge and does not clip a draft", async ({ page }, info) => {
      test.skip(info.project.name === "mobile", "sets its own viewport");
      await open(page);
      await openChat(page, QUIET);
      await expect(page.locator("[data-help-launcher]")).toBeVisible();
      await expectNoOverflow(page, name);
      const bar = await page.evaluate(() => getComputedStyle(document.querySelector("[data-testid=chat-scroll]")!).scrollbarWidth);
      expect(bar).not.toBe("thin");
      const field = page.getByPlaceholder(/^Message /).first();
      await field.fill("one\ntwo\nthree");
      const shape = await fieldShape(page);
      expect(shape.clipped).toBeLessThanOrEqual(1);
    });
  });
}

const styledRules = (page: Page) => page.evaluate(() => {
  const rules: string[] = [];
  for (const sheet of document.styleSheets) {
    let list: CSSRuleList; try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list) if (rule instanceof CSSMediaRule && rule.cssText.includes("scrollbar-width: thin")) rules.push(rule.conditionText);
  }
  const el = document.querySelector("[data-testid=chat-scroll]")!;
  return { rules, matches: rules.map((r) => matchMedia(r).matches), anyCoarse: matchMedia("(any-pointer: coarse)").matches,
    fine: matchMedia("(pointer: fine)").matches, width: getComputedStyle(el).scrollbarWidth };
});
// Scroll bar styling follows the PRIMARY pointer (ruling): a laptop whose mouse/trackpad is primary and whose touch
// screen is secondary (any-pointer: coarse) keeps the styled bars; a device whose primary pointer is coarse does not.
test.describe("scroll bars follow the primary pointer", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false, isMobile: false });
  test("fine primary + coarse secondary (a touch laptop) => styled", async ({}, info) => {
    test.skip(info.project.name === "mobile", "sets its own viewport");
    // Blink's device settings (PointerType: coarse 2, fine 4; HoverType: hover 2): a mouse is primary, a finger is also there.
    const browser = await chromium.launch({ args: ["--blink-settings=primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=2"] });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await open(page);
      await openChat(page, BUSY);
      const seen = await styledRules(page);
      expect(seen.anyCoarse, "a finger is also there").toBe(true);
      expect(seen.fine, "but the primary pointer is fine").toBe(true);
      expect(seen.rules.length).toBeGreaterThan(0);
      expect(seen.matches, "every styled-bar rule applies").toEqual(seen.rules.map(() => true));
      expect(seen.width).toBe("thin");
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
});
test.describe("coarse primary pointer", () => {
  test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true, isMobile: false });
  test("is not styled", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "sets its own viewport");
    await open(page);
    await openChat(page, BUSY);
    const seen = await styledRules(page);
    expect(seen.fine, "the emulated touch screen is the primary pointer").toBe(false);
    expect(seen.rules.length).toBeGreaterThan(0);
    expect(seen.matches).toEqual(seen.rules.map(() => false));
    expect(seen.width).not.toBe("thin");
  });
});

// WebKit (the iPhone's engine) in the Playwright image: the same centring, Help and overflow pins on an iPhone-size screen.
test.describe("webkit iPhone 393x852", () => {
  test("composer centred, no help tab, nothing past the edge", async ({}, info) => {
    test.skip(info.project.name === "mobile", "sets its own viewport");
    const browser = await webkit.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
      const page = await context.newPage();
      await open(page);
      await openChat(page, QUIET);
      await expect(page.locator("[data-help-launcher]")).toBeHidden();
      await expectNoOverflow(page, "webkit chat");
      await expect(page.getByPlaceholder(/^Message /).first()).toBeVisible();
      expect((await fieldShape(page)).off).toBeLessThanOrEqual(2);
      // the top fade appears only once there is text above the edge: none on a chat that fits the screen (nothing scrolled),
      // present after the long chat is scrolled. (WebKit follows the live tail, so a jump to scrollTop 0 is not a stable state there.)
      expect(await maskOf(page), "a chat with nothing above the edge has no fade").toBe("none");
      await openChat(page, BUSY);
      await scrollChat(page, 300);
      await expect.poll(() => maskOf(page)).toMatch(TOP_FADE);
    } finally { await browser.close(); }
  });
});
