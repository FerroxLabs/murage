// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";
import type { ProjectRead } from "../lib/project-client";

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
let ids: { group: string; thread: string; bot: string; pair: string };
const ROOM = "U1 project fixture";
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bot=store.createBot({name:'Finch fixture'},{seedMessages:false});
    store.patchBot(bot.id,{computer:'off',browser:false,composio:false});
    const group=store.createGroup(${JSON.stringify(ROOM)},[bot.id],false,undefined,{completed:true});
    store.patchGroup(group.id,{channelProject:{goal:'Launch a very long project with a title that must fit on a phone',status:'active',startedAt:1,updatedAt:1}});
    const pair=store.createGroup('U1 pair fixture',[bot.id],true,undefined,{completed:true});
    store.appendMessage(group.threadId,{role:'bot',kind:'text',text:'The result needs another attempt.',actorKind:'murage',requestId:'request-old',murage:{kind:'failure',retry:{requestId:'request-old'},reassign:{workItemId:'card-one'}}});
    store.appendMessage(group.threadId,{role:'bot',kind:'activity',tool:{name:'Messaged Finch',ok:true},comm:{groupId:pair.id,withBotId:bot.id,withName:bot.name,withColor:'orange'}});
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'u1-ids.json'),JSON.stringify({group:group.id,thread:group.threadId,bot:bot.id,pair:pair.id}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "u1-ids.json"), "utf8"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function open(page: Page, width: number, options: { flags?: boolean; missing?: boolean; readOnly?: boolean; closed?: boolean; changed?: boolean; missingBoard?: boolean; limited?: boolean; workSettings?: boolean } = {}) {
  const errors: string[] = [], calls: Array<{ path: string; body: unknown }> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("https://**/*", (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.setViewportSize({ width, height: 900 });
  const project: ProjectRead = {
    lifecycle: options.closed ? "closed" : "open",
    settings: { groupId: ids.group, mode: "ongoing", leadBotId: ids.bot, parts: { board: true }, runState: "running", closedAt: options.closed ? 1 : null, endedAt: null, revision: 1 },
    brief: { version: 1, summary: "Launch" }, goal: { id: "goal", title: "Launch a very long project with a title that must fit on a phone", state: "working", revision: 1 },
    budgets: [{ id: "budget", state: options.limited ? "paused" : "ok", revision: 1, maxWorkMinutes: 60 }],
    strip: { line: "Finch answering · Dax queued", needsYou: 2, usage: { workMs: 600000, input: 120, output: 80, tokensReported: true, charge: null } },
    sinceYouLeft: { messages: 2, cards: 1, decisions: 2 }, revision: 1,
  };
  if(options.workSettings){
    project.settings.workRoots=[{path:"/fixture/work",label:"Work"}];project.settings.workProfile="ask";project.settings.effectiveProfiles={[ids.bot]:"engine"};
    project.budgets[0]!.maxTokens=3000000;
    await page.addInitScript(()=>Object.defineProperty(window,"muragebox",{value:{pickFolder:async()=>"/fixture/second"},configurable:true}));
  }
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch(); const config = await response.json();
    await route.fulfill({ response, json: { ...config, features: { ...config.features, showToolCalls: false, ...(options.flags === false ? {} : { projectsLead: true, projectsAutonomy: true, roomsQueue: true, projectsBoard: true }) } } });
  });
  await page.route("**/api/bots?*", async (route) => {
    const response = await route.fetch(); const data = await response.json();
    for (const group of data.groups ?? []) {
      if (group.id === ids.pair && options.readOnly) group.readOnlyReason = "This is a channel person's delegated conversation. Start an owner room to send a message.";
      if (group.id === ids.group) group.tasks = [...(group.tasks ?? []), { threadId: "unread-task", title: "Another task", createdAt: 2, unreadCount: 3, unread: true }];
    }
    await route.fulfill({ response, json: data });
  });
  let cardRevision = 7;
  let conflict = !!options.changed;
  await page.route(`**/api/groups/${ids.group}/**`, async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!/\/(project|requests|usage|board)(\/|$)/.test(path)) return route.continue();
    calls.push({ path, body: request.postDataJSON() });
    if (options.missing) return route.fulfill({ status: 404, json: { error: "no such route" } });
    if (path.includes("/board") && options.missingBoard) return route.fulfill({ status: 404, json: { error: "no such route" } });
    if (path.endsWith("/board")) return route.fulfill({ json: { lifecycle: project.lifecycle, columns: [], columnsRevision: 1, cards: [{ id: "card-one", title: "Check the result", state: "doing", revision: cardRevision }] } });
    if (path.endsWith("/board/cards/card-one")) {
      if (conflict) { conflict = false; cardRevision = 8; return route.fulfill({ status: 409, json: { error: "changed", card: { id: "card-one", revision: cardRevision } } }); }
      return route.fulfill({ json: { card: { id: "card-one", revision: ++cardRevision } } });
    }
    if(path.endsWith("/project/budget")){const body=request.postDataJSON();Object.assign(project.budgets[0]!,body,{revision:project.budgets[0]!.revision+1,state:"ok"});return route.fulfill({json:{budget:project.budgets[0]}});}
    if(path.endsWith("/project/work-roots")){project.settings.workRoots=request.postDataJSON().roots;project.settings.revision++;return route.fulfill({json:{settings:project.settings}});}
    if(path.endsWith("/project/work-profile")){project.settings.workProfile=request.postDataJSON().workProfile;project.settings.revision++;return route.fulfill({json:{settings:project.settings}});}
    if (path.endsWith("/project")) return route.fulfill({ json: project });
    if (path.endsWith("/viewed")) return route.fulfill({ json: { ok: true } });
    if (path.endsWith("/usage")) return route.fulfill({ json: { lifecycle: project.lifecycle, totals: project.strip.usage, byBot: [], notReported: [], budgets: project.budgets } });
    if (path.endsWith("/requests")) return route.fulfill({ json: { lifecycle: project.lifecycle, requests: [
      { id: "owner-wait", verb: "owner_send", state: "waiting_owner", fromKind: "owner", toBotId: null, refusalLine: null, createdAt: 1, workItemId: null, outcomeNote: null },
      { id: "ask-queued", verb: "ask", state: "queued", fromKind: "bot", toBotId: ids.bot, refusalLine: null, createdAt: 2, workItemId: null, outcomeNote: null },
    ] } });
    if (/control\/(pause|resume|stop)$/.test(path)) {
      project.settings.runState = path.endsWith("resume") ? "running" : "paused";
      return route.fulfill({ json: path.endsWith("stop") ? { stopped: { requests: 1, turns: 1 } } : { settings: project.settings, goal: project.goal } });
    }
    if (path.endsWith("/redirect")) return route.fulfill({ json: { requestId: "redirect-new" } });
    if (path.endsWith("/retry")) return route.fulfill({ json: { request: { id: "request-new", state: "queued" } } });
    return route.fulfill({ status: 404, json: { error: "no such route" } });
  });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText(ROOM, { exact: true }).click();
  if (width < 768) {
    await expect(page.getByRole("button", { name: "Open bot list", exact: true })).toHaveAttribute("aria-expanded", "false");
    const drawer = page.getByRole("complementary", { name: "Bots and navigation", includeHidden: true });
    await expect(drawer).toHaveAttribute("inert", "");
    await expect.poll(async () => {
      const bounds = await drawer.boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    }).toBeLessThanOrEqual(0);
  }
  await expect(page.getByTestId("chat-scroll")).toBeVisible();
  return { errors, calls, project };
}

for (const skin of ["light", "dark"] as const) for (const width of [390, 820, 1440]) test(`project strip, controls and phone menu at ${width} in ${skin}`, async ({ page }, info) => {
  await page.addInitScript(value => localStorage.setItem("murage-skin", value), skin);
  const { errors, calls } = await open(page, width);
  const strip = page.getByRole("region", { name: "Project progress" });
  await expect(strip).toBeVisible();
  await expect(strip.getByText("2 needs you")).toBeVisible();
  const toggle = strip.getByRole("button").first();
  expect((await toggle.boundingBox())!.height).toBeLessThanOrEqual(48);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`project-${width}.png`) });
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Finch answering · Dax queued", { exact: true })).toBeVisible();
  await expect(strip.getByText("Your message: waiting for you", { exact: true })).toBeVisible();
  await expect(strip.getByText("Ask to Finch fixture: queued", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(strip.getByText("Paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Stop all", exact: true }).click();
  expect(calls.filter((call) => call.path.endsWith("/stop"))).toHaveLength(0);
  await page.getByRole("button", { name: "Stop all work", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path.endsWith("/stop")).length).toBe(1);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Redirect", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Redirect", exact: true }).click();
  await page.getByRole("textbox", { name: "Note to the lead" }).fill("Check the result first");
  await page.getByRole("button", { name: "Send note", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path.endsWith("/redirect")).length).toBe(1);
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run: (context: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe.run({ include: ['section[aria-label="Project progress"]', 'nav[aria-label="Project views"]'] });
    return result.violations.filter((entry) => entry.impact === "critical" || entry.impact === "serious").map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target, failureSummary }) => ({ target, summary: failureSummary })) }));
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath(`project-expanded-${width}.png`) });
  if (width === 390) {
    await page.getByRole("button", { name: "More views", exact: true }).click();
    await page.getByRole("menuitem", { name: "Memory", exact: true }).click();
    await expect(page.getByRole("region", { name: "Memory", exact: true })).toBeVisible();
  }
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Board", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  expect(errors).toEqual([]);
});

test("Murage retry, reassignment, task count and CA1 link work with tool calls hidden", async ({ page }) => {
  const { calls, errors } = await open(page, 820);
  const row = page.getByTestId("murage-row");
  await expect(row.getByText("Murage", { exact: true })).toBeVisible();
  await expect(row.locator('[data-testid="room-speaker"]')).toHaveCount(0);
  await row.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path.endsWith("/retry")).length).toBe(1);
  await row.getByRole("button", { name: "Reassign", exact: true }).click();
  await row.getByRole("combobox", { name: "Assign to" }).selectOption(ids.bot);
  await row.getByRole("button", { name: "Reassign request", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path.endsWith("/retry")).length).toBe(2);
  expect(calls.filter((call) => call.path.endsWith("/retry"))[1].body).toEqual({ assigneeBotId: ids.bot });
  await page.getByRole("button", { name: "All threads", exact: true }).click();
  await expect(page.getByText("3 unread", { exact: false })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTitle("Open the conversation with Finch fixture").click();
  await expect(page.getByRole("main").locator("span.truncate").filter({ hasText: /^U1 pair fixture$/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("C6 refuses composition before typing from a projected read-only reason", async ({ page }) => {
  await open(page, 390, { readOnly: true });
  await page.getByTitle("Open the conversation with Finch fixture").click();
  await expect(page.getByText("This is a channel person's delegated conversation. Start an owner room to send a message.", { exact: true })).toBeVisible();
  await expect(page.getByRole("main").locator('[contenteditable="true"],textarea')).toHaveCount(0);
});

test("missing routes preserve chat without a retry loop", async ({ page }) => {
  const { calls, errors } = await open(page, 820, { missing: true });
  await expect(page.getByRole("region", { name: "Project progress" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  const before = calls.length;
  await page.waitForTimeout(800);
  expect(calls.length).toBe(before);
  expect(errors).toEqual([]);
});

test("closed projects display their reason and disable controls", async ({ page }) => {
  await open(page, 820, { closed: true });
  await page.getByRole("region", { name: "Project progress" }).getByRole("button").click();
  await expect(page.getByText("This project is closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop all", exact: true })).toBeDisabled();
});


test("feature-off servers keep the existing chat and never call project routes", async ({ page }) => {
  const { calls, errors } = await open(page, 820, { flags: false });
  await expect(page.getByRole("region", { name: "Project progress" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Board", exact: true })).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(errors).toEqual([]);
});

for (const width of [390, 820, 1440]) test(`card controls refetch a changed revision at ${width}`, async ({ page }) => {
  const { calls, errors } = await open(page, width, { changed: true, limited: true });
  const strip = page.getByRole("region", { name: "Project progress" });
  await expect(strip.getByText("Limit reached", { exact: true })).toBeVisible();
  await strip.getByRole("button").click();
  await expect(strip.getByText("This project stops starting new work at your limit.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Reassign", exact: true }).click();
  const picker = page.getByRole("form", { name: "Reassign a card" });
  await expect(picker.getByLabel("Card", { exact: true })).toBeFocused();
  await picker.getByLabel("Card", { exact: true }).selectOption("card-one");
  await picker.getByLabel("Assign to", { exact: true }).selectOption(ids.bot);
  expect(calls.filter(call => call.path.endsWith("/board"))).toHaveLength(1);
  await picker.getByRole("button", { name: "Reassign card", exact: true }).click();
  await expect(page.getByText("This changed. Refresh and try again.")).toBeVisible();
  await expect(picker.getByRole("button", { name: "Reassign card", exact: true })).toBeDisabled();
  await expect.poll(() => calls.filter(call => call.path.endsWith("/board")).length).toBe(2);
  await picker.getByLabel("Card", { exact: true }).selectOption("card-one");
  await picker.getByRole("button", { name: "Reassign card", exact: true }).click();
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeFocused();
  const writes = () => calls.filter(call => call.path.endsWith("/board/cards/card-one"));
  expect(writes().map(call => call.body)).toEqual([
    { action: "reassign", expectedRevision: 7, assigneeBotId: ids.bot },
    { action: "reassign", expectedRevision: 8, assigneeBotId: ids.bot },
  ]);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Take over a card", exact: true }).click();
  const takeover = page.getByRole("form", { name: "Take over a card" });
  await takeover.getByLabel("Card", { exact: true }).selectOption("card-one");
  await takeover.getByRole("button", { name: "Take over card", exact: true }).click();
  await expect.poll(() => writes().length).toBe(3);
  expect(writes()[2].body).toEqual({ action: "take_over", expectedRevision: 9 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("missing board routes disable card actions with a reason", async ({ page }) => {
  const { calls } = await open(page, 390, { missingBoard: true });
  await page.getByRole("region", { name: "Project progress" }).getByRole("button").click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByText("Card controls are not available yet")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Reassign", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Take over a card", exact: true })).toBeDisabled();
  expect(calls.filter(call => call.path.endsWith("/board"))).toHaveLength(1);
});

for(const width of [390,820,1440])test(`lane B settings at ${width}`,async({page},info)=>{
  const {errors,calls}=await open(page,width,{workSettings:true});
  await page.getByRole("region",{name:"Project progress"}).getByRole("button").first().click();
  const settings=page.getByRole("region",{name:"Project work settings"});await expect(settings).toBeVisible();
  await settings.getByLabel("Work minutes",{exact:true}).fill("240");
  await settings.getByRole("button",{name:"Save budget"}).click();
  await expect.poll(()=>calls.filter(call=>call.path.endsWith("/budget")).length).toBe(1);
  await settings.getByRole("button",{name:"Choose folder"}).click();
  await expect(settings.getByText("second: /fixture/second",{exact:true})).toBeVisible();
  await settings.getByLabel("File approvals",{exact:true}).selectOption("auto-in-roots");
  await expect.poll(()=>calls.filter(call=>call.path.endsWith("/work-profile")).length).toBe(1);
  await settings.getByRole("button",{name:"Remove second"}).click();
  await expect(settings.getByText("second: /fixture/second",{exact:true})).toHaveCount(0);
  await settings.getByLabel("Work minutes",{exact:true}).focus();await page.keyboard.press("Tab");
  await expect(settings.getByLabel("Tokens",{exact:true})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.addScriptTag({content:axeSource});
  const serious=await page.evaluate(async()=>{const result=await (window as any).axe.run('section[aria-label="Project work settings"]');return result.violations.filter((entry:any)=>["critical","serious"].includes(entry.impact));});
  expect(serious).toEqual([]);expect(errors).toEqual([]);
  await page.getByRole("region",{name:"Project progress"}).screenshot({path:info.outputPath(`lane-b-${width}.png`)});
});
