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

/** How many of the seeded rows are mounted. Counted by id: the harness may
 * add a live message of its own (a greeting card) while the spec runs. */
const mountedSeeded = (page: Page) =>
  page.getByTestId("chat-scroll").evaluate((el, seeded) => {
    const known = new Set(seeded);
    return [...el.querySelectorAll("[data-mid]")].filter((node) => known.has(node.getAttribute("data-mid")!)).length;
  }, ids);

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
  // hydration asked for a page, and only that page is on screen
  expect(requests.some((path) => path === `/api/bots?messages=${PAGE}`)).toBe(true);
  expect(requests.some((path) => path === "/api/bots")).toBe(false);
  // the harness may have added a live message of its own, which then
  // counts toward the newest page
  const held = await mountedSeeded(page);
  expect(held).toBeGreaterThanOrEqual(PAGE - 2);
  expect(held).toBeLessThanOrEqual(PAGE);
  const oldest = TOTAL - held;
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
  await expect(row(page, oldest - PAGE)).toBeAttached();
  expect(requests.some((path) => path.includes(`limit=${PAGE}&before=${firstHeld}`))).toBe(true);
  await expect.poll(() => mountedSeeded(page)).toBe(held + PAGE);
  // The prepended page went in above the reader: the row that was at the top
  // is exactly where it was, so the view did not jump.
  const after = await page.getByTestId("chat-scroll").evaluate((el, id) => {
    const target = document.querySelector(`[data-mid="${id}"]`)!.lastElementChild!;
    return { top: target.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
  }, firstHeld);
  expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2);
  expect(after.scrollTop).toBeGreaterThan(0);
  await expect(row(page, oldest)).toBeInViewport();
  await page.screenshot({ path: info.outputPath("thread-paging-older-page.png") });
});

test("a search hit older than the held page walks back to it and lands on it", async ({ page }, info) => {
  const requests: string[] = [];
  await open(page, requests);
  await expect(row(page, NEEDLE)).toHaveCount(0);
  const oldest = TOTAL - await mountedSeeded(page);
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find in this conversation", exact: true });
  await find.fill(`needle-${String(NEEDLE).padStart(4, "0")}`);
  await expect(row(page, NEEDLE)).toBeInViewport({ timeout: 20_000 });
  await expect(row(page, NEEDLE)).toContainText(`Paging row ${String(NEEDLE).padStart(4, "0")}`);
  // One existence probe, then contiguous pages from the oldest held row, so
  // the transcript between the hit and the newest message has no hole.
  expect(requests.some((path) => path.includes(`around=${ids[NEEDLE]}&limit=1`))).toBe(true);
  const walk = requests.filter((path) => /\/messages\?limit=\d+&before=/.test(path));
  expect(walk.length).toBeGreaterThan(0);
  expect(walk[0]).toContain(`before=${ids[oldest]}`);
  // the rows either side of the hit are mounted, and so is the reader's way
  // back to the newest message
  await expect(row(page, NEEDLE + 1)).toBeAttached();
  await expect(page.getByRole("button", { name: /Show later messages/ })).toBeAttached();
  await page.screenshot({ path: info.outputPath("thread-paging-search-jump.png") });
});
