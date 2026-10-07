// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room reached at its top brings the earlier messages in without moving
// the message the reader is looking at. A room row opens with the speaker's
// name only where a turn starts, so when the earlier page ends with the same
// speaker the name leaves the row that used to be the oldest. Holding that
// row's top still moved the message up by the label's height (0.1.61 CI
// audit on d851c9c4, which fixed the same thing for the day separator).
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";

const TOTAL = 400;
const ROOM = "Paging room";
const SPEAKER = "Room paging speaker";

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let ids: string[];

test.beforeAll(async () => {
  // Every message from one bot, in one turn, on one day: only the oldest
  // mounted row starts the turn, so only it carries the day separator and
  // the name.
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:${JSON.stringify(SPEAKER)}},{seedMessages:false});
    store.patchBot(bot.id,{computer:'off',browser:false,composio:false});
    const group=store.createGroup(${JSON.stringify(ROOM)},[bot.id],false,undefined,{completed:true});
    const ids=[];
    for(let i=0;i<${TOTAL};i++){
      const n=String(i).padStart(4,'0');
      ids.push(store.appendMessage(group.threadId,{role:'bot',kind:'text',text:'Room row '+n+'. '+'Filler so each row has some height. '.repeat(1+i%3),turnId:'room-paging-turn',from:{botId:bot.id,name:${JSON.stringify(SPEAKER)}}}).id);
    }
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'room-paging-ids.json'),JSON.stringify(ids));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "room-paging-ids.json"), "utf8"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

/** Mounted seeded rows, oldest first, by id. */
const mounted = (page: Page) =>
  page.getByTestId("chat-scroll").evaluate((el, seeded) => {
    const known = new Set(seeded);
    return [...el.querySelectorAll("[data-row]")].map((node) => node.getAttribute("data-row")!).filter((id) => known.has(id));
  }, ids);

test("an earlier page keeps the message still when the speaker's name leaves its row", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText(ROOM, { exact: true }).click();
  await expect(page.locator(`[data-row="${ids[TOTAL - 1]}"]`)).toBeAttached();
  await expect.poll(async () => (await mounted(page)).length).toBeGreaterThan(1);
  const held = await mounted(page);
  expect(held.length).toBeLessThan(TOTAL);
  const firstHeld = held[0]!;
  // The oldest mounted row starts the turn: it carries the name.
  await expect(page.locator(`[data-row="${firstHeld}"] [data-testid="room-speaker"]`)).toHaveCount(1);

  // Scroll to the top the way a reader does, and measure the message (the
  // row's last child), not the row.
  const before = await page.getByTestId("chat-scroll").evaluate((el, id) => {
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true }));
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
    const target = document.querySelector(`[data-row="${id}"]`)!.lastElementChild!;
    return target.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, firstHeld);
  await expect.poll(async () => (await mounted(page)).indexOf(firstHeld)).toBeGreaterThan(0);
  // The earlier page ends with the same speaker: the name has left the row.
  await expect(page.locator(`[data-row="${firstHeld}"] [data-testid="room-speaker"]`)).toHaveCount(0);
  const after = await page.getByTestId("chat-scroll").evaluate((el, id) => {
    const target = document.querySelector(`[data-row="${id}"]`)!.lastElementChild!;
    return { top: target.getBoundingClientRect().top - el.getBoundingClientRect().top, scrollTop: el.scrollTop };
  }, firstHeld);
  expect(Math.abs(after.top - before), `message moved from ${before} to ${after.top}`).toBeLessThanOrEqual(2);
  expect(after.scrollTop).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("room-paging-earlier-page.png") });
});
