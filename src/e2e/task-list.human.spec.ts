// The task switcher as a person meets it: dated groups, routine runs folded,
// handoffs from other bots readable, filters, the remembered sort, and a
// keyboard path through all of it — at desktop and phone width, light and
// dark, against a real harness and the real store.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { axeScriptPath } from "./axe";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string;
let ids: { bot: string; active: string; runs: string[]; peer: string; legacyPeer: string; lastWeek: string; empty: string; pinned: string; older: string };

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const now=Date.now(),H=3600e3,D=24*H;const sod=new Date();sod.setHours(0,0,0,0);const today=sod.getTime();
    const bot=store.createBot({name:'Task list fixture'},{seedMessages:false});
    // every thread ends on a reply: boot marks a thread ending on a user message as interrupted, which is new activity
    const talk=(threadId,text,at)=>{store.appendMessage(threadId,{role:'user',kind:'text',text,at:at-1000});store.appendMessage(threadId,{role:'bot',kind:'text',text:'Done.',at});};
    const make=(title,createdAt,lastAt)=>{const t=store.createTask(bot.id,title,false);t.createdAt=createdAt;if(lastAt!==undefined)talk(t.threadId,title,lastAt);return t;};
    const active=bot.threadId;store.renameTask(bot.id,active,'Plan the launch');
    const first=store.tasks(bot.id).find(t=>t.threadId===active);first.createdAt=today-20*D;
    talk(active,'Plan the launch',now-60e3);
    store.addTaskUsage(bot.id,active,{input:600000,output:74000,costUsd:null});
    const pinned=make('Quarterly budget',today-70*D,today-70*D+H);pinned.pinned=true;
    const older=make('Supplier contract notes',today-45*D,today-45*D+H);
    const lastWeek=make('Tax receipts',today-8*D+6*60e3,today-8*D+6*60e3);
    const run1=make('Morning brief',today-3*D+7*H,today-3*D+7*H+60e3);
    const run2=make('Morning brief',today-2*H,today-2*H+60e3);
    const run3=make('Morning brief',now-3*60e3,now-2*60e3);run3.unread=true;
    const peer=store.createTask(bot.id,undefined,false);peer.createdAt=today-10*H;
    talk(peer.threadId,'[Delegated by @Kessler, another bot in this Murage workspace. Do the work and reply directly.]\\n\\nCheck the March invoices',today-10*H);
    store.titleTaskFromFirstMessage(bot.id,'[Delegated by @Kessler, another bot in this Murage workspace. Do the work and reply directly.]\\n\\nCheck the March invoices',peer.threadId);peer.unread=true;
    const legacyPeer=make('[Message from @Sable, another bot in this Murag…',today-10*H-60e3,today-10*H-60e3);
    const empty=make('New task',now-30*60e3);
    store.switchTask(bot.id,active);store.saveBots();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'task-list-fixture.json'),JSON.stringify({bot:bot.id,active,runs:[run3.threadId,run2.threadId,run1.threadId],peer:peer.threadId,legacyPeer:legacyPeer.threadId,lastWeek:lastWeek.threadId,empty:empty.threadId,pinned:pinned.threadId,older:older.threadId}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "task-list-fixture.json"), "utf8"));
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "task-list-vite-cache"), resolve: { alias: { "@": join(root, "src") } },
      server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } }, plugins: [react(), tailwindcss(), {
        name: "task-list-fixture", resolveId(id) { if (id === "/__tasks.js") return "\0task-list"; },
        load(id) { if (id !== "\0task-list") return; return `
          import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {TaskPicker} from '/src/components/TaskPicker.tsx';import '/src/styles.css';
          function Surface(){const {state}=useStore();const bot=state.bots.find(b=>b.id==='${ids.bot}');return React.createElement('section',{'aria-label':'Bot conversation',style:{display:'flex',justifyContent:'flex-end',alignItems:'center',gap:12,minHeight:640}},React.createElement('h1',{style:{marginRight:'auto',fontSize:15}},'Task list fixture'),bot&&React.createElement(TaskPicker,{bot}));}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Surface)));`; },
        configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== "/__tasks") return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:760px;margin:0 auto;padding:12px 16px"></main><script type="module" src="/__tasks.js"></script>'); }); },
      }] });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No task list fixture port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

/** The routine receipts the client joins on: three runs of one routine. */
async function withRoutineRuns(page: Page) {
  const runs = ids.runs.map((threadId, index) => ({
    id: `run-${index}`, routineId: "brief", routineName: "Morning brief", target: "bot", botId: ids.bot, runOn: "ember",
    scheduledFor: Date.now() - index * 86_400_000, status: "succeeded", manual: false, triggerSource: "schedule", threadId,
  }));
  await page.route(url => url.pathname === "/api/routines", route => route.fulfill({ json: { routines: [], runs } }));
}

async function openPicker(page: Page) {
  await withRoutineRuns(page);
  await page.goto(origin + "/__tasks");
  const picker = page.getByRole("button", { name: "All threads", exact: true });
  await picker.click();
  const list = page.getByRole("group", { name: "Tasks", exact: true });
  await expect(list).toBeVisible();
  return { picker, list };
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const skin of ["light", "dark"]) test(`dated, folded, readable list at ${width}px ${skin}`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem("murage-task-sort", "activity"));
  const { list } = await openPicker(page);
  await page.evaluate(value => { document.documentElement.dataset.skin = value; }, skin);

  // headers are group labels, in time order
  for (const label of ["Pinned", "Today", "Yesterday"]) await expect(list.getByRole("group", { name: label, exact: true })).toBeVisible();
  const labels = await list.locator("[role=group][aria-labelledby]").evaluateAll(groups => groups.map(group => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent));
  expect(labels.slice(0, 3)).toEqual(["Pinned", "Today", "Yesterday"]);
  // one group per month once a task is older than this month
  expect(labels.at(-1)).toMatch(/^[A-Z][a-z]+ \d{4}$/);

  // routine runs fold into one row that carries the latest run's status
  const fold = list.getByRole("button", { name: /^Morning brief · 3 runs/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(fold).toContainText("Unread");
  await expect(list.getByRole("group", { name: "Morning brief runs", exact: true })).toHaveCount(0);

  // handoffs read as their sender; legacy truncated titles too
  await expect(list.getByText("From Kessler: Check the March invoices", { exact: true })).toBeVisible();
  await expect(list.getByText("From Sable", { exact: true })).toBeVisible();
  // tokens carry their unit
  await expect(list.getByText("· 674k tokens", { exact: true })).toBeVisible();
  // an older row shows a date, never a bare time
  const lastWeek = list.getByRole("button", { name: /^Tax receipts/ });
  await expect(lastWeek.locator("time")).toHaveText(/^[A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  // an empty untitled task is not listed
  await expect(list.getByText("New task", { exact: true })).toHaveCount(0);

  // no horizontal overflow: the menu fits the viewport and nothing scrolls sideways
  const menu = page.locator("div.absolute.z-40").first();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await list.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.addScriptTag({ path: axeScriptPath });
  const axe = await page.evaluate(async () => (window as any).axe.run(document.querySelector("div.absolute.z-40"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
  writeFileSync(info.outputPath(`axe-${width}-${skin}.json`), JSON.stringify(axe.violations, null, 2));
  expect(axe.violations.map((violation: { id: string; impact: string }) => `${violation.impact}:${violation.id}`)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`task-list-${width}-${skin}.png`) });
  expect(errors).toEqual([]);
});

test("keyboard walks every group, opens a fold and picks a run", async ({ page }) => {
  const { picker, list } = await openPicker(page);
  const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
  await expect(search).toBeFocused();
  await search.press("ArrowDown");
  await expect(list.getByRole("button", { name: /^Quarterly budget/ })).toBeFocused();
  // down across the Pinned → Today boundary
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("button", { name: /^Plan the launch/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("button", { name: /^Morning brief · 3 runs/ })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const fold = list.getByRole("button", { name: /^Morning brief · 3 runs/ });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const runs = list.getByRole("group", { name: "Morning brief runs", exact: true });
  await expect(runs.getByRole("button", { name: /^Morning brief/ })).toHaveCount(3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(runs.getByRole("button", { name: /^Morning brief/ }).nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(fold).toBeFocused();
  await page.keyboard.press("End");
  await expect(list.getByRole("button", { name: /^Supplier contract notes/ })).toBeFocused();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();
  // pick the middle run with Enter
  await search.press("ArrowDown");
  for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowDown");
  await expect(runs.getByRole("button", { name: /^Morning brief/ }).nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker).toContainText("Morning brief");
  const state = await (await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers: await desktopHeaders() })).json();
  expect(state.bots.find((bot: any) => bot.id === ids.bot).threadId).toBe(ids.runs[1]);
});

test("filters, search across everything, and the remembered sort", async ({ page }) => {
  const { list } = await openPicker(page);
  const chip = (name: string) => page.getByRole("group", { name: "Filter tasks", exact: true }).getByRole("button", { name, exact: true });
  await expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  await chip("Routines").click();
  await expect(chip("Routines")).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("button", { name: /^Morning brief · 3 runs/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^Plan the launch/ })).toHaveCount(0);
  await chip("From other bots").click();
  await expect(list.getByRole("button", { name: /^From / })).toHaveCount(2);
  await chip("Unread").click();
  await expect(list.getByRole("button", { name: /^From Kessler/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^Morning brief/ })).toHaveCount(1);
  await expect(list.getByRole("button", { name: /^Plan the launch/ })).toHaveCount(0);
  await chip("Chats").click();
  // search ignores the filter and matches the stored title as well as the readable one
  const search = page.getByRole("textbox", { name: "Search tasks", exact: true });
  const hits = page.getByRole("group", { name: /^\d+ matching tasks?$/ });
  await search.fill("delegated by");
  await expect(hits).toHaveAccessibleName("1 matching task");
  await expect(hits.getByRole("button", { name: /^From Kessler: Check the March invoices/ })).toBeVisible();
  await search.fill("from sable");
  await expect(hits.getByRole("button", { name: /^From Sable/ })).toBeVisible();
  await search.fill("");

  // sort by creation and keep it across a reload
  await page.getByRole("combobox", { name: "Sort tasks", exact: true }).selectOption("created");
  await chip("All").click();
  const firstUnpinned = list.locator("[role=group][aria-labelledby]").nth(1).locator("[data-task-nav]").first();
  await expect(firstUnpinned).toHaveAccessibleName(/^Morning brief · 3 runs/);
  expect(await page.evaluate(() => localStorage.getItem("murage-task-sort"))).toBe("created");
  await page.reload();
  await page.getByRole("button", { name: "All threads", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Sort tasks", exact: true })).toHaveValue("created");
  // Plan the launch was created 20 days ago: by creation it leaves Today
  await expect(page.getByRole("group", { name: "Today", exact: true }).getByRole("button", { name: /^Plan the launch/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Sort tasks", exact: true }).selectOption("activity");
  await expect(page.getByRole("group", { name: "Today", exact: true }).getByRole("button", { name: /^Plan the launch/ })).toBeVisible();
});

test("pin, unpin and delete still work from the grouped list", async ({ page }) => {
  const { list } = await openPicker(page);
  await list.getByRole("button", { name: "Pin Tax receipts", exact: true }).click();
  await expect(list.getByRole("group", { name: "Pinned", exact: true }).getByRole("button", { name: /^Tax receipts/ })).toBeVisible();
  await list.getByRole("button", { name: "Unpin Tax receipts", exact: true }).click();
  await expect(list.getByRole("group", { name: "Pinned", exact: true }).getByRole("button", { name: /^Tax receipts/ })).toHaveCount(0);
  const row = list.getByRole("button", { name: /^From Sable/ }).locator("xpath=..");
  await row.hover();
  await row.getByRole("button", { name: "Delete task", exact: true }).click();
  await expect(list.getByRole("button", { name: /^From Sable/ })).toHaveCount(0);
  const state = await (await fetch(`${fixture.info.url}/api/bots?messages=0`, { headers: await desktopHeaders() })).json();
  const tasks = state.bots.find((bot: any) => bot.id === ids.bot).tasks;
  expect(tasks.some((task: any) => task.threadId === ids.legacyPeer)).toBe(false);
  // the hidden empty task is still there: hidden, not deleted
  expect(tasks.some((task: any) => task.threadId === ids.empty)).toBe(true);
});

async function desktopHeaders() {
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  return { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}
