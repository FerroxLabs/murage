// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner's bug: on the phone app and in the mobile web view a "Pending
// approval" card for generate_image showed its whole prompt (about 1,900
// characters) and filled the screen. The owner could not scroll to Approve or
// Deny, or to the send box. The card now collapses long text to a few lines
// behind a Show full prompt toggle, and its own content scrolls inside a
// viewport-bound height so the decisions and the composer stay on screen.
//
// Real harness, real UI, no model call.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
const botId = "approval-long-bot";
const SHOTS = process.env.AC_OUT ?? "";
/** About 2,000 characters of image prompt, the owner's case. */
const PROMPT = Array.from({ length: 11 }, (_, i) =>
  `Scene ${i + 1}: a lighthouse keeper on a cliff at dusk, painted in warm oils with heavy brushwork, long shadows, a small boat returning to harbour, gulls overhead, soft mist, detailed rigging.`).join(" ");

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  const card = { title: "Approve image generation", subtitle: "One image · flux · flux-image-1 · high · 1024x1024. Prompt: 1,988 characters.", options: ["Allow", "Deny"], requestId: "img-long-1", tool: "generate_image", held: PROMPT };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const at=Date.now();
    const db=new DatabaseSync(join(process.env.MURAGE_DATA_DIR,'messages.db'));
    db.exec('CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT)');
    const rows=[
      {id:'u1',role:'user',kind:'text',at:at-3000,text:'Draw the lighthouse keeper.'},
      {id:'b1',role:'bot',kind:'text',at:at-2000,text:'I will make that image now.'},
      {id:'card1',role:'bot',kind:'options',at:at-1000,card:${JSON.stringify(card)}},
    ];
    let parent=null;
    for(const row of rows){const message={...row,parentId:parent};parent=row.id;db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('approval-long-chat',message.id,message.at,message.role,message.kind,message.text??null,JSON.stringify(message));}
    db.prepare('INSERT INTO thread_state VALUES(?,?)').run('approval-long-chat',parent);db.close();
    const level={autoApprove:false,fullAccess:false,noLimits:false};
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'approval-long-chat',name:'Dax',title:'Artist',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},...level,alwaysAllow:[],tasks:[{threadId:'approval-long-chat',title:'Chat',createdAt:at,resumeCursors:{},...level,alwaysAllow:[]}],composio:false,browser:false,computer:'off'}]));
  ` });
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "approval-long-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Approval card fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.route("**/api/whats-new?*", (route) => route.fulfill({ json: { show: false } }));
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Pending approval" })).toBeVisible();
}

/** Fully on screen, not merely present in the DOM. */
async function expectOnScreen(page: Page, name: string, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  const view = page.viewportSize()!;
  expect(box, `${name} has a box`).not.toBeNull();
  expect(box!.y, `${name} top`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${name} bottom within ${view.height}`).toBeLessThanOrEqual(view.height + 1);
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`a ${PROMPT.length}-character image prompt collapses and Approve, Deny and the composer stay reachable at ${width}x${height}`, async ({ page }) => {
    await open(page, width, height);
    await page.waitForTimeout(800); // let the drawer settle
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `on-open-${width}x${height}.png`) });
    const region = page.getByRole("region", { name: "Pending approval" });
    const allow = page.getByRole("button", { name: "Allow once" });
    const composer = page.getByRole("textbox").last();

    // the decisions and the send box are on screen with the long prompt pending
    await expectOnScreen(page, "Allow once", allow);
    await expectOnScreen(page, "Deny", page.getByRole("button", { name: "Deny", exact: true }));
    await expectOnScreen(page, "composer", composer);
    // the card is a few lines, not the whole screen, and the conversation keeps room
    expect((await region.boundingBox())!.height).toBeLessThan(height * 0.5);
    await expect(page.getByText("I will make that image now.")).toBeVisible();

    const toggle = region.getByRole("button", { name: "Show all" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `after-collapsed-${width}x${height}.png`) });

    // expanded: still bounded, still scrolls inside, decisions and composer still on screen
    await toggle.click();
    const less = region.getByRole("button", { name: "Show less" });
    await expect(less).toHaveAttribute("aria-expanded", "true");
    await expectOnScreen(page, "Allow once (expanded)", allow);
    await expectOnScreen(page, "composer (expanded)", page.getByRole("textbox").last());
    const scrolls = await region.evaluate((el) => {
      const pre = el.querySelector("[data-approval-held]") as HTMLElement | null;
      return { panelH: el.getBoundingClientRect().height, innerScrolls: pre ? pre.scrollHeight > pre.clientHeight : false };
    });
    expect(scrolls.panelH).toBeLessThan(height * 0.75);
    if (width < 600) expect(scrolls.innerScrolls).toBe(true); // on a wide window the whole prompt fits inside the bound
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `after-expanded-${width}x${height}.png`) });
    await less.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    // and Approve really is clickable. Answering settles the card for the
    // fixture, so only the phone run (last) does it.
    if (width !== 390) return; // 390 runs last
    const answered = page.waitForRequest((request) => request.method() === "POST" && /respond|approval|decide/i.test(request.url()), { timeout: 10_000 });
    await allow.click({ timeout: 5_000 });
    await answered;
  });
}
