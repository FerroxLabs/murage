// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The Images setting in Bot settings, and the record an image made without
// asking leaves in the conversation, at a desktop and a phone size. Real
// harness, real UI, no model call: the record is a seeded message.
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

let fixture: VerificationServer, vite: ViteDevServer, origin: string, owner: Record<string, string>;
const botId = "image-setting-bot";
const SHOTS = process.env.IA_OUT ?? "";
const PROMPT = Array.from({ length: 6 }, (_, i) => `Scene ${i + 1}: a lighthouse keeper on a cliff at dusk, painted in warm oils, long shadows, a small boat returning to harbour.`).join(" ");

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: LaunchVerificationServer };
  const record = { name: "Making an image without asking (Full access)", ok: true, imageRecord: { summary: "One image · flux · flux-image-1 · high · 1024x1024.", prompt: PROMPT } };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
    const at=Date.now();
    const db=new DatabaseSync(join(process.env.MURAGE_DATA_DIR,'messages.db'));
    db.exec('CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);');
    const rows=[
      {id:'u1',role:'user',kind:'text',at:at-3000,text:'Draw the lighthouse keeper.'},
      {id:'r1',role:'bot',kind:'activity',at:at-2000,tool:${JSON.stringify(record)}},
      {id:'b1',role:'bot',kind:'text',at:at-1000,text:'The picture is on its way.'},
    ];
    let parent=null;
    for(const row of rows){const message={...row,parentId:parent};parent=row.id;db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('image-setting-chat',message.id,message.at,message.role,message.kind,message.text??null,JSON.stringify(message));}
    db.prepare('INSERT INTO thread_state VALUES(?,?)').run('image-setting-chat',parent);db.close();
    const level={autoApprove:true,fullAccess:true,noLimits:false};
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'image-setting-chat',name:'Dax',title:'Artist',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},...level,fullAccessAcknowledgedAt:at,alwaysAllow:[],tasks:[{threadId:'image-setting-chat',title:'Chat',createdAt:at,resumeCursors:{},...level,alwaysAllow:[]}],composio:false,browser:false,computer:'off'}]));
  ` });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    owner = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "image-setting-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Image setting fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openChat(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.route("**/api/whats-new?*", (route) => route.fulfill({ json: { show: false } }));
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText("Dax", { exact: true }).first().click();
}
const bot = async () => ((await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: owner })).json()) as { bots: Array<Record<string, unknown>> }).bots.find((entry) => entry.id === botId)!;

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`the record of an image made without asking folds its prompt, and the Images setting works at ${width}x${height}`, async ({ page }) => {
    await openChat(page, width, height);
    await page.waitForTimeout(800); // let the drawer settle
    // the record: what was made, the folded prompt, nothing to approve
    const row = page.getByTestId("image-record-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("Making an image without asking (Full access)");
    await expect(row.getByRole("button", { name: "Show all" })).toHaveAttribute("aria-expanded", "false");
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `record-${width}x${height}.png`) });
    await row.getByRole("button", { name: "Show all" }).click();
    await expect(row.getByRole("button", { name: "Show less" })).toBeVisible();

    // the setting, in Bot settings, Permissions
    await page.getByTitle("Bot settings", { exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Bot settings", exact: true });
    await expect(dialog).toBeVisible();
    if (width < 640) await dialog.locator("select").first().selectOption("permissions");
    else await dialog.getByRole("button", { name: "Permissions", exact: true }).click();
    const group = dialog.getByRole("radiogroup", { name: "Image approval" });
    const card = group.locator("..");
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(group.getByRole("radio", { name: "Follow permission level" })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Follow permission level", "Ask before each image", "Make images without asking"]) {
      const radio = group.getByRole("radio", { name });
      expect((await radio.boundingBox())!.height, `${name} is a 44px target`).toBeGreaterThanOrEqual(43);
      const box = await radio.boundingBox();
      expect(box!.x + box!.width, `${name} inside the screen`).toBeLessThanOrEqual(width);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `setting-follow-${width}x${height}.png`) });

    // choosing saves, and the server keeps it
    await group.getByRole("radio", { name: "Make images without asking" }).click();
    await expect.poll(async () => (await bot()).imageApproval, { timeout: 15_000 }).toBe("allow");
    await expect(dialog.getByText("Contacts and anyone else still get the card.")).toBeVisible();
    await expect(card.getByText(/always allow/i)).toHaveCount(0);
    // the guard: blank is no limit, a number saves, nonsense is refused
    const field = dialog.getByLabel("Ask again after this many images in one turn");
    await field.fill("3"); await field.blur();
    await expect.poll(async () => (await bot()).imageAskAfter, { timeout: 15_000 }).toBe(3);
    await field.fill("0"); await field.blur();
    await expect(dialog.getByText("Enter a whole number from 1 to 50, or leave it blank.")).toBeVisible();
    expect((await bot()).imageAskAfter).toBe(3);
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `setting-allow-${width}x${height}.png`) });
    await field.fill(""); await field.blur();
    await expect.poll(async () => (await bot()).imageAskAfter, { timeout: 15_000 }).toBeUndefined();
    await group.getByRole("radio", { name: "Follow permission level" }).click();
    await expect.poll(async () => (await bot()).imageApproval, { timeout: 15_000 }).toBeUndefined();
  });
}
