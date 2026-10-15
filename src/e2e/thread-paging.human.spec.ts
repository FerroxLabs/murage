// The desktop loads a conversation a page at a time (upstream #1527,
// 08b479d7). A 1,000-message thread opens on its newest page, reaching the
// top of the transcript brings the page before it in without moving the rows
// the reader is looking at, and a search hit far older than the page walks
// back to it and lands on it.
import { test, expect, type Page, type Request } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const TOTAL = 1000;
const PAGE = 100;
const NEEDLE = 12;
const BOT = "Paging fixture";

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let ids: string[];

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:${JSON.stringify(BOT)}},{seedMessages:false});
    store.patchBot(bot.id,{computer:'off',browser:false,composio:false});
    const ids=[];
    for(let i=0;i<${TOTAL};i++){
      const n=String(i).padStart(4,'0');
      ids.push(store.appendMessage(bot.threadId,{role:i%2?'bot':'user',kind:'text',text:(i===${NEEDLE}?'needle-'+n+' ':'')+'Paging row '+n+'. '+'Filler so each row has some height. '.repeat(1+i%3)}).id);
    }
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'paging-ids.json'),JSON.stringify(ids));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "paging-ids.json"), "utf8"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

/** Index of the oldest seeded row that is mounted. The transcript mounts only
 * the rows on screen (05683e461), so a count of mounted rows is no longer the
 * held count; with the view at the top of the held page, TOTAL minus this index
 * is. Matched by id: the harness may add a live message of its own (a greeting
 * card) while the spec runs. */
const oldestMounted = (page: Page) =>
  page.getByTestId("chat-scroll").evaluate((el, seeded) => {
    const known = new Map(seeded.map((id, index) => [id, index] as const));
    const found = [...el.querySelectorAll("[data-mid]")].map((node) => known.get(node.getAttribute("data-mid")!)).filter((index): index is number => index !== undefined);
    return found.length ? Math.min(...found) : Number.POSITIVE_INFINITY;
  }, ids);

/** The oldest mounted seeded row once the view is at the top of the held page
 * and the mount has stopped changing (two reads 300 ms apart agree). */
async function settledOldest(page: Page) {
  await wheelToHeldTop(page);
  let last = await oldestMounted(page);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const next = await oldestMounted(page);
    if (next === last) return next;
    last = next;
  }
  return last;
}

/** Wheel up to the top of the held page, short of the earlier-page trigger
 * (SCROLLBACK_TRIGGER_PX, 200), so the oldest held row is mounted and no
 * older page has been asked for yet. */
async function wheelToHeldTop(page: Page) {
  const scroller = page.getByTestId("chat-scroll");
  await scroller.hover();
  // aim for ~300 px from the top, in steps that cannot overshoot the trigger
  for (let i = 0; i < 120; i++) {
    const top = await scroller.evaluate((el) => el.scrollTop);
    if (top <= 450) break;
    await page.mouse.wheel(0, -Math.min(500, top - 300));
    await page.waitForTimeout(80);
  }
}

/** The rendered bubble of a message: rows are `display: contents` wrappers. */
const row = (page: Page, index: number) => page.locator(`[data-mid="${ids[index]}"] > :last-child`);

async function open(page: Page, requests: string[]) {
  page.on("request", (request: Request) => { if (request.url().includes("/api/")) requests.push(new URL(request.url()).pathname + new URL(request.url()).search); });
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText(BOT, { exact: true }).click();
  const invitation = page.getByRole("complementary", { name: "Let your bots pick the right model", exact: true });
  if (await invitation.count()) await invitation.getByRole("button", { name: "Not now", exact: true }).last().click();
  await expect(row(page, TOTAL - 1)).toBeVisible();
}

test("opens on the newest page and loads older ones in place when scrolled to the top", async ({ page }, info) => {
  const requests: string[] = [];
  await open(page, requests);
  // hydration asked for the sidebar roster (no rows, desktop and phone
  // alike), and the store fetched the open conversation's first page
  // (scrollback loadFirstPage, the switch page); only that page is on screen.
  expect(requests.some((path) => path === "/api/bots?view=sidebar")).toBe(true);
  expect(requests.some((path) => path === "/api/bots" || /^\/api\/bots\?messages=[1-9]/.test(path))).toBe(false);
  expect(requests.some((path) => /^\/api\/threads\/[\w-]+\/messages\?view=switch&limit=100$/.test(path))).toBe(true);
  // the harness may have added a live message of its own, which then
  // counts toward the newest page
  const oldest = await settledOldest(page);
  const held = TOTAL - oldest;
  expect(held).toBeGreaterThanOrEqual(PAGE - 2);
  // the first page is one page
  expect(held).toBeLessThanOrEqual(PAGE + 1);
  await expect(row(page, oldest)).toBeAttached();
  await expect(row(page, oldest - 1)).toHaveCount(0);
  await expect(page.getByTestId("load-earlier")).toBeAttached();

  // Scroll up the way a reader does: a wheel gesture breaks bottom-follow,
  // then the top of the transcript is reached. Measure where the oldest held
  // row sits at that moment, before the page is on the wire.
  const firstHeld = ids[oldest]!;
  const before = await page.getByTestId("chat-scroll").evaluate((el, id) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    const target = document.querySelector(`[data-mid="${id}"]`)!.lastElementChild!;
    return target.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, firstHeld);
  // the page lands above the reader: its newest row sits right above the old top
  await expect(row(page, oldest - 1)).toBeAttached();
  expect(requests.some((path) => path.includes(`limit=${PAGE}&before=${firstHeld}`))).toBe(true);
  // The prepended page went in above the reader: the row that was at the top
  // is exactly where it was, so the view did not jump.
  const after = await page.getByTestId("chat-scroll").evaluate((el, id) => {
    const target = document.querySelector(`[data-mid="${id}"]`)!.lastElementChild!;
    return { top: target.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
  }, firstHeld);
  expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2);
  expect(after.scrollTop).toBeGreaterThan(0);
  await expect(row(page, oldest)).toBeInViewport();
  // the held page is now two pages: back at the top of it, the oldest mounted
  // row is exactly one page older
  await wheelToHeldTop(page);
  await expect.poll(() => oldestMounted(page)).toBe(oldest - PAGE);
  await page.screenshot({ path: info.outputPath("thread-paging-older-page.png") });
});

test("a search hit older than the held page walks back to it and lands on it", async ({ page }, info) => {
  const requests: string[] = [];
  await open(page, requests);
  await expect(row(page, NEEDLE)).toHaveCount(0);
  // The store fetches the open conversation's first page on its own
  // (scrollback loadFirstPage). Let that settle, and count only the requests
  // the search makes.
  const oldest = await settledOldest(page);
  const searchFrom = requests.length;
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in this conversation", exact: true });
  await find.fill(`needle-${String(NEEDLE).padStart(4, "0")}`);
  await expect(row(page, NEEDLE)).toBeInViewport({ timeout: 20_000 });
  await expect(row(page, NEEDLE)).toContainText(`Paging row ${String(NEEDLE).padStart(4, "0")}`);
  // One existence probe, then contiguous pages from the oldest held row, so
  // the transcript between the hit and the newest message has no hole.
  expect(requests.slice(searchFrom).some((path) => path.includes(`around=${ids[NEEDLE]}&limit=1`))).toBe(true);
  const walk = requests.slice(searchFrom).filter((path) => /\/messages\?limit=\d+&before=/.test(path));
  expect(walk.length).toBeGreaterThan(0);
  expect(walk[0]).toContain(`before=${ids[oldest]}`);
  // the rows either side of the hit are mounted, and so is the reader's way
  // back to the newest message
  await expect(row(page, NEEDLE + 1)).toBeAttached();
  await expect(page.getByRole("button", { name: /Show later messages/ })).toBeAttached();
  await page.screenshot({ path: info.outputPath("thread-paging-search-jump.png") });
});
