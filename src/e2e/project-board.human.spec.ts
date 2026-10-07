// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { test, expect, type Page, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";
import { openSidebar } from "./fixtures.ts";
import type { ProjectRead, ProjectBoardRead, ProjectCard, ProjectActivityRow, ProjectCardAction, ProjectColumn, ProjectGoalAction, RoomRequest } from "../lib/project-client";

let fixture: VerificationServer, vite: ViteDevServer, origin: string, headers: Record<string, string>;
let ids: { group: string; thread: string; bots: string[]; live: string; evidence: string; desk: string };
const ROOM = "U2 project fixture", LIVE = "U2 live fixture";
const names = ["Jax with a very long teammate name", "Dax with another long teammate name", "Finch with a long lead name"];
const require = createRequire(import.meta.url), axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
    const {readFileSync,writeFileSync}=await import('node:fs');const {join}=await import('node:path');
    const path=join(process.env.MURAGE_DATA_DIR,'config.json');const config=JSON.parse(readFileSync(path,'utf8'));
    config.features={...config.features,projectsLead:true,projectsGoals:true,projectsBoard:true,projectsDigest:true,roomsQueue:true,projectsAutonomy:false};writeFileSync(path,JSON.stringify(config));
    const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
    const bots=${JSON.stringify(names)}.map(name=>{const bot=store.createBot({name},{seedMessages:false});store.patchBot(bot.id,{computer:'off',browser:false,composio:false});return bot.id;});
    const group=store.createGroup(${JSON.stringify(ROOM)},bots,false,undefined,{completed:true});
    const live=store.createGroup(${JSON.stringify(LIVE)},bots,false,undefined,{completed:true});
    for(const room of [group,live])store.patchGroup(room.id,{channelProject:{goal:'Launch',status:'active',startedAt:1,updatedAt:1}});
    store.appendMessage(group.threadId,{role:'bot',kind:'activity',actorKind:'murage',murage:{kind:'status',digestDay:'2026-09-29'},tool:{name:'Daily digest for 29 Sep: nothing changed since the last digest.',ok:true}});
    const evidence=store.appendMessage(group.threadId,{role:'bot',kind:'text',text:'The fixture result was checked.'});
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'u2-ids.json'),JSON.stringify({group:group.id,thread:group.threadId,bots,live:live.id,evidence:evidence.id,desk:store.bot(bots[0]).threadId}));
  ` });
  ids = JSON.parse(readFileSync(join(fixture.info.dataDir, "u2-ids.json"), "utf8"));
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", port: 0, watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture UI port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

function benchmark() {
  const states = ["todo", "doing", "waiting", "review", "done"] as const;
  const columns: ProjectColumn[] = ["To do", "In progress", "Waiting", "In review", "Done"].map((title, i) => ({ id: states[i], title, state: states[i], position: i }));
  columns.push({ id: "next", title: "A custom column with a forty letter name", state: "todo", position: 5 }, { id: "client", title: "Client review", state: "waiting", position: 6 }, { id: "later", title: "Later", state: "todo", position: 7 });
  const cards: ProjectCard[] = Array.from({ length: 60 }, (_, i) => { const col = columns[i % 8]; return { id: `card-${i + 1}`, number: i + 1, title: `Deliverable ${i + 1}: a long descriptive title that must remain readable inside this card`, description: "The complete description.", state: col.state as ProjectCard["state"], columnId: i % 8 < 5 ? null : col.id, revision: 1, position: i, assigneeBotId: ids.bots[i % 3], goalId: "goal", createdAt: Date.now() - 3600000, deskThreadId: i === 0 ? ids.desk : ids.thread, usage: { workMs: 60000, tokens: 1200, tokensReported: true }, ...(col.state === "waiting" ? { waitingOn: { kind: "blocked", detail: "Waiting for input" } } : {}) }; });
  const board: ProjectBoardRead = { lifecycle: "open", columnsRevision: 3, columns, cards };
  const project: ProjectRead = { lifecycle: "open", settings: { groupId: ids.group, mode: "ongoing", leadBotId: ids.bots[2], parts: { board: true, review: true, digest: false }, runState: "running", closedAt: null, endedAt: null, revision: 3 }, brief: null,
    goal: { id: "goal", title: "Launch", state: "awaiting_signoff", revision: 7, criteria: [{ id: "criterion", text: "Result checked", setBy: "lead", proposed: true, met: true, metBy: ids.bots[0], evidence: { kind: "check", ref: ids.evidence, workItemId: "card-1", attempt: 1, at: 1 } }] },
    budgets: [{ id: "budget", goalId: "goal", period: "goal", state: "warned", revision: 1, maxWorkMinutes: 120, maxTokens: 3000000 }], strip: { line: "Working", needsYou: 0, usage: { workMs: 7080000, input: 2900000, output: 0, tokensReported: true, charge: null } }, sinceYouLeft: { messages: 4, cards: 2, decisions: 1 }, revision: 3 };
  const kinds = ["card_created", "card_moved", "card_reassigned", "card_took_over", "card_failed", "card_result", "brief_version", "goal_state", "criteria", "decision_opened", "decision_closed", "budget_warned", "budget_paused", "budget_raised", "member_error", "routine_run", "settings", "work_roots", "restore", "close", "reopen", "deadline", "unknown_future"];
  const activity: ProjectActivityRow[] = Array.from({ length: 31 }, (_, i) => ({ id: `activity-${i}`, kind: kinds[i % kinds.length], actor: i % 2 ? "server" : "owner", at: 100000 - i * 1000, workItemId: "card-1", goalId: "goal", requestId: null, detail: { from: "doing", to: i === 7 ? "working" : "waiting", version: 4 } }));
  return { board, project, activity };
}
type Call = { path: string; method: string; body: Record<string, unknown> | null; query: string };
async function enter(page: Page, width: number, room = ROOM) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem("murage-email-gate", "skipped"));
  await page.route("https://**/*", route => route.abort());
  await page.goto(origin); const sidebar = await openSidebar(page); await sidebar.getByText(room, { exact: true }).click();
  await expect(page.getByRole("tab", { name: "Board", exact: true })).toBeVisible();
}
async function view(page: Page, width: number, name: "Board" | "Activity" | "Overview" | "Chat") {
  if (width < 768 && name !== "Board" && name !== "Chat") {
    const nav = page.getByRole("navigation", { name: "Project views" });
    await nav.getByRole("button", { name: /More views|Activity|Overview/ }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  } else await page.getByRole("tab", { name, exact: true }).click();
}
async function open(page: Page, width: number) {
  const data = benchmark(), calls: Call[] = [], errors: string[] = [];
  const requests: RoomRequest[] = [];
  const control = { refusal: "" as "" | "not_allowed" | "changed", columnConflict: false, goalConflict: false, digestForbidden: false };
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/config", async route => { const response = await route.fetch(); const config = await response.json(); await route.fulfill({ response, json: { ...config, features: { ...config.features, showToolCalls: false } } }); });
  await page.route(`**/api/groups/${ids.group}/**`, async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname, method = req.method();
    if (!/\/(project|requests|usage|board|activity)(\/|$)/.test(path)) return route.continue();
    const body = req.postDataJSON(); calls.push({ path, method, body, query: url.search });
    if (path.endsWith("/project")) return route.fulfill({ json: data.project });
    if (path.endsWith("/viewed")) { data.project.sinceYouLeft = { messages: 0, cards: 0, decisions: 0 }; return route.fulfill({ json: { ok: true } }); }
    if (path.endsWith("/board")) return route.fulfill({ json: { ...data.board, cards: data.board.cards.filter(c => !url.searchParams.has("goal") || c.goalId === url.searchParams.get("goal")) } });
    if (path.endsWith("/activity")) { const before = Number(url.searchParams.get("before") ?? Infinity), limit = Number(url.searchParams.get("limit") ?? 30); return route.fulfill({ json: { lifecycle: "open", items: data.activity.filter(r => r.at < before).slice(0, limit) } }); }
    if (path.endsWith("/usage")) return route.fulfill({ json: { lifecycle: "open", totals: data.project.strip.usage, byBot: [], notReported: [], budgets: data.project.budgets } });
    if (path.endsWith("/requests")) return route.fulfill({ json: { lifecycle: "open", requests } });
    if (path.includes("/board/cards/")) {
      const card = data.board.cards.find(c => c.id === path.split("/").at(-1))!;
      if (control.refusal) { const error = control.refusal; control.refusal = ""; if (error === "changed") card.revision++; return route.fulfill({ status: 409, json: error === "changed" ? { error, card } : { error, reason: "This run is waiting for its answer." } }); }
      const action = body as ProjectCardAction; expect(action.expectedRevision).toBe(card.revision);
      if (action.action === "reassign") { card.assigneeBotId = action.assigneeBotId; card.state = "todo"; card.columnId = null; }
      else if (action.toState === "doing" || action.action === "start") {
        card.requestId = null;
        requests.push({ id: `queued-${card.id}`, verb: "assign", state: "queued", workItemId: card.id, toBotId: card.assigneeBotId ?? null, threadId: null, fromKind: "owner", createdAt: Date.now(), refusalLine: null, outcomeNote: null, steeringMode: "queue" });
      }
      else if (action.toState) { card.state = action.toState; card.columnId = action.columnId; }
      const before = data.board.cards.find(c => c.id === action.beforeCardId), after = data.board.cards.find(c => c.id === action.afterCardId);
      if (before || after) card.position = before && after ? (before.position! + after.position!) / 2 : before ? before.position! - 1 : after!.position! + 1;
      card.revision++; return route.fulfill({ json: { card } });
    }
    if (path.endsWith("/board/columns")) {
      if (control.columnConflict) { control.columnConflict = false; data.board.columnsRevision++; return route.fulfill({ status: 409, json: { error: "changed" } }); }
      expect(body.expectedRevision).toBe(data.board.columnsRevision);
      data.board.columns = [...data.board.columns.filter(c => ["todo", "doing", "waiting", "review", "done"].includes(c.id)), ...body.columns]; data.board.columnsRevision++;
      return route.fulfill({ json: { columns: body.columns, columnsRevision: data.board.columnsRevision } });
    }
    if (path.endsWith("/project/settings")) {
      if (control.digestForbidden) return route.fulfill({ status: 403, json: { error: "desktop" } });
      expect(body.expectedRevision).toBe(data.project.settings.revision); data.project.settings.parts = body.parts; data.project.settings.revision++;
      return route.fulfill({ json: { settings: data.project.settings } });
    }
    if (path.endsWith("/project/goals/goal")) {
      if (control.goalConflict) { control.goalConflict = false; data.project.goal!.revision++; return route.fulfill({ status: 409, json: { error: "changed", goal: data.project.goal } }); }
      expect(body.expectedRevision).toBe(data.project.goal!.revision);
      const next: Partial<Record<ProjectGoalAction, NonNullable<ProjectRead["goal"]>["state"]>> = { sign_off: "done", send_back: "working", approve_plan: "working", change_plan: "planning", start: "planning", pause: "paused", resume: "working", stop: "stopped" };
      data.project.goal = { ...data.project.goal!, ...(body.action ? { state: next[body.action as ProjectGoalAction]! } : body), revision: data.project.goal!.revision + 1 };
      return route.fulfill({ json: { goal: data.project.goal } });
    }
    return route.fulfill({ status: 404, json: { error: "no such fixture route" } });
  });
  await enter(page, width); await view(page, width, "Board");
  await expect(page.getByRole("region", { name: "Board", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Card 1:/ })).toBeVisible();
  return { ...data, calls, errors, control };
}
const cardButton = (page: Page, number: number) => page.getByRole("button", { name: new RegExp(`^Card ${number}:`) });
const writes = (calls: Call[]) => calls.filter(c => c.method === "PATCH" && c.path.includes("/board/cards/"));
async function drag(page: Page, source: Locator, target: Locator, position: "before" | "inside" = "inside") {
  await source.scrollIntoViewIfNeeded(); const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + Math.min(30, from.height / 2)); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + Math.min(30, from.height / 2), { steps: 3 });
  // Scrolling the board while dragging also exercises its cached-rect offsets.
  const destination = position === "before" ? target : target.getByRole("button", { name: /^Card / }).first();
  await destination.scrollIntoViewIfNeeded(); const to = (await destination.boundingBox())!;
  await page.mouse.move(to.x + to.width / 2, to.y + (position === "before" ? 4 : Math.min(to.height - 4, 100)), { steps: 12 });
  await page.mouse.up();
}
async function axe(page: Page, label: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async region => {
    const result = await (window as unknown as { axe: { run: (context: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: unknown[] }> }> } }).axe.run({ include: [`[aria-label="${region}"]`] });
    return result.violations.filter(v => v.impact === "critical" || v.impact === "serious");
  }, label);
  expect(violations).toEqual([]);
}

for (const width of [390, 820, 1440]) {
  for (const skin of ["light", "dark"] as const) test(`1 benchmark, all columns, readable cards and axe at ${width} ${skin}`, async ({ page }, info) => {
    await page.addInitScript(value => localStorage.setItem("murage-skin", value), skin);
    const { board, errors } = await open(page, width);
    expect(board.columns).toHaveLength(8); expect(board.cards).toHaveLength(60); expect(board.columns[5].title).toHaveLength(40);
    const scroll = page.getByRole("region", { name: "Board columns" });
    for (const column of board.columns) {
      if (width === 390) { const picker = page.getByRole("combobox", { name: "Column picker" }); await expect(picker.getByRole("option")).toHaveCount(8); await expect(picker.getByRole("option", { name: `${column.title} (${board.cards.filter(c => (c.columnId ?? c.state) === column.id).length})`, exact: true })).toHaveCount(1); await picker.selectOption(column.id); }
      const region = page.getByRole("region", { name: column.title, exact: true }); await region.getByRole("heading").scrollIntoViewIfNeeded(); await expect(region.getByRole("heading")).toBeVisible();
      const overflow = await region.getByRole("button", { name: /^Card / }).evaluateAll(buttons => buttons.flatMap(button => {
        const bounds = button.getBoundingClientRect();
        if (button.scrollWidth > button.clientWidth + 1) return [`${button.dataset.boardCard}: scrollWidth ${button.scrollWidth} > ${button.clientWidth}`];
        // Visible text only: the clipped sr-only "Card N:" prefix is laid out
        // off the card on purpose and is not something a reader sees.
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT), nodes: Text[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement?.closest(".sr-only")) nodes.push(node as Text);
        return nodes.flatMap(node => { const text = document.createRange(); text.selectNodeContents(node); return [...text.getClientRects()].filter(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1).map(rect => `${button.dataset.boardCard}: "${(node.textContent ?? "").slice(0, 40)}" ${Math.round(rect.left)}..${Math.round(rect.right)} outside ${Math.round(bounds.left)}..${Math.round(bounds.right)}`); });
      })); expect(overflow).toEqual([]);
      if (width === 390) await expect(scroll.getByRole("region")).toHaveCount(1);
    }
    if (width === 820) { const bounds = (await scroll.boundingBox())!, column = (await page.getByRole("region", { name: "Later", exact: true }).boundingBox())!; expect(column.width).toBeLessThan(bounds.width / 2); expect(column.width).toBeGreaterThan(bounds.width / 2 - 30); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await axe(page, "Board"); await page.screenshot({ path: info.outputPath(`board-${width}-${skin}.png`) }); expect(errors).toEqual([]);
    await view(page, width, "Overview"); await expect(page.getByRole("heading", { name: "Launch", exact: true })).toBeVisible(); await axe(page, "Goal"); await page.screenshot({ path: info.outputPath(`goal-${width}-${skin}.png`) });
    await view(page, width, "Activity"); await expect(page.getByRole("list", { name: "Project activity" }).getByRole("listitem")).toHaveCount(30); await axe(page, "Activity"); await page.screenshot({ path: info.outputPath(`activity-${width}-${skin}.png`) });
  });
  test(`2 pointer reorder, move and done confirmation at ${width}`, async ({ page }) => {
    const { calls } = await open(page, width);
    if (width === 390) { await cardButton(page, 1).click(); await expect(page.getByRole("button", { name: "Move to", exact: true })).toBeVisible(); return; }
    await drag(page, cardButton(page, 9), cardButton(page, 1), "before"); await expect.poll(() => writes(calls).length).toBe(1);
    expect(writes(calls)[0].body).toMatchObject({ action: "reorder", expectedRevision: 1, beforeCardId: "card-1", toState: "todo", columnId: null });
    await drag(page, cardButton(page, 1), page.getByRole("region", { name: "In progress", exact: true })); await expect.poll(() => writes(calls).length).toBe(2);
    expect(writes(calls)[1].body).toMatchObject({ action: "move", toState: "doing", columnId: null, expectedRevision: 1 });
    await expect(page.getByRole("status").filter({ hasText: "Card 1 is queued to start" })).toBeVisible();
    await drag(page, cardButton(page, 9), page.getByRole("region", { name: "Done", exact: true }));
    const confirm = page.getByRole("dialog", { name: "Done without review" }); await expect(confirm).toBeVisible(); expect(writes(calls)).toHaveLength(2);
    await confirm.getByRole("button", { name: "Done without review", exact: true }).click(); await expect.poll(() => writes(calls).length).toBe(3); expect(writes(calls)[2].body).toMatchObject({ toState: "done", confirm: true, expectedRevision: 2 });
  });
  test(`3 keyboard move, focus return and Escape at ${width}`, async ({ page }) => {
    const { calls } = await open(page, width); await cardButton(page, 1).focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space");
    await expect.poll(() => writes(calls).length).toBe(1); expect(writes(calls)[0].body).toMatchObject({ action: "move", expectedRevision: 1, toState: "doing", columnId: null }); await expect(cardButton(page, 1)).toBeFocused();
    await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Escape"); await expect(cardButton(page, 1)).toBeFocused(); expect(writes(calls)).toHaveLength(1);
  });
  test(`4 refusals snap back and changed revisions refetch at ${width}`, async ({ page }) => {
    const { calls, control } = await open(page, width); control.refusal = "not_allowed";
    const move = async () => { await cardButton(page, 1).focus(); await page.keyboard.press("Space"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("Space"); };
    await move(); await expect(page.getByRole("alert").filter({ hasText: "This run is waiting for its answer." })).toBeVisible();
    await expect(page.getByRole("region", { name: "To do", exact: true }).getByRole("button", { name: /^Card 1:/ })).toBeFocused();
    const before = calls.filter(c => c.path.endsWith("/board")).length; control.refusal = "changed"; await move();
    await expect.poll(() => calls.filter(c => c.path.endsWith("/board")).length).toBeGreaterThan(before);
    await expect(page.getByRole("alert").filter({ hasText: "This changed. The board is up to date now." })).toBeVisible();
  });
  test(`5 card Move to and Reassign sheets at ${width}`, async ({ page }) => {
    const { calls } = await open(page, width); if (width === 390) await expect(page.getByRole("button", { name: "By bot", exact: true })).toHaveCount(0);
    await cardButton(page, 1).click(); await page.getByRole("dialog").getByRole("button", { name: "Move to", exact: true }).click();
    await page.getByRole("dialog", { name: "Move to", exact: true }).getByRole("button", { name: "In progress", exact: true }).click();
    await expect.poll(() => writes(calls).length).toBe(1); expect(writes(calls)[0].body).toMatchObject({ action: "move", toState: "doing", expectedRevision: 1 });
    await cardButton(page, 1).click(); await expect(page.getByRole("region", { name: "Current run" })).toContainText("queued"); await expect(page.getByRole("button", { name: "Ask now", exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "Send after this step", exact: true })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Reassign", exact: true }).click(); await page.getByRole("dialog", { name: "Reassign", exact: true }).getByRole("button", { name: names[1], exact: true }).click();
    await expect.poll(() => writes(calls).length).toBe(2); expect(writes(calls)[1].body).toEqual({ action: "reassign", assigneeBotId: ids.bots[1], expectedRevision: 2 });
  });
  test(`6 by-bot reassignment at ${width}`, async ({ page }) => {
    const { calls } = await open(page, width); if (width === 390) { await expect(page.getByRole("button", { name: "By bot", exact: true })).toHaveCount(0); return; }
    await page.getByRole("button", { name: "By bot", exact: true }).click();
    await drag(page, cardButton(page, 1), page.getByRole("region", { name: `To do, ${names[1]}`, exact: true }));
    await expect.poll(() => writes(calls).length).toBe(1); expect(writes(calls)[0].body).toEqual({ action: "reassign", expectedRevision: 1, assigneeBotId: ids.bots[1] });
  });
  test(`7 custom column edits and conflict at ${width}`, async ({ page }) => {
    const { calls, control } = await open(page, width); if (width === 390) { await expect(page.getByRole("button", { name: "Edit columns", exact: true })).toHaveCount(0); return; }
    await page.getByRole("button", { name: "Edit columns", exact: true }).click(); const editor = page.getByRole("dialog", { name: "Edit columns", exact: true });
    await editor.getByRole("textbox", { name: "New column title", exact: true }).fill("Next week"); await editor.getByRole("button", { name: "Add column", exact: true }).click();
    const added = editor.getByRole("group", { name: "Next week (To do)", exact: true }); await added.getByRole("textbox", { name: "Column title", exact: true }).fill("Soon");
    await editor.getByRole("group", { name: "Soon (To do)", exact: true }).getByRole("button", { name: "Move left", exact: true }).click();
    await editor.getByRole("button", { name: "Delete Client review", exact: true }).click(); await page.getByRole("dialog", { name: "Delete column", exact: true }).getByRole("button", { name: "Delete column", exact: true }).click();
    await editor.getByRole("button", { name: "Save columns", exact: true }).click();
    const puts = () => calls.filter(c => c.method === "PUT"); await expect.poll(() => puts().length).toBe(1);
    expect(puts()[0].body).toMatchObject({ expectedRevision: 3 }); const saved = puts()[0].body!.columns as ProjectColumn[]; expect(saved.map(c => c.title)).toEqual(["A custom column with a forty letter name", "Soon", "Later"]); expect(saved.every(c => c.state === "todo")).toBe(true);
    control.columnConflict = true; const reads = calls.filter(c => c.path.endsWith("/board")).length; await page.getByRole("button", { name: "Edit columns", exact: true }).click(); await editor.getByRole("button", { name: "Save columns", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "The columns changed. Your edit was not saved; try again." })).toBeVisible(); await expect.poll(() => calls.filter(c => c.path.endsWith("/board")).length).toBeGreaterThan(reads);
  });
  test(`8 goal sheet evidence, budget and revision-fenced actions at ${width}`, async ({ page }) => {
    const { calls, project, control } = await open(page, width); const sheet = page.getByRole("dialog", { name: "Goal", exact: true });
    const show = async () => { await page.getByRole("button", { name: "Goal: Launch", exact: true }).click(); await expect(sheet.getByRole("button", { name: "Open evidence", exact: true })).toBeVisible(); };
    await show(); await expect(sheet).toContainText("Proposed by the lead"); await expect(sheet.getByRole("img", { name: "Met", exact: true })).toBeVisible(); await expect(sheet).toContainText("1 h 58 min of 2 h"); await expect(sheet).toContainText("2.9M of 3.0M tokens");
    const sourceOpened = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === `/api/groups/${ids.group}/tasks/${ids.thread}`);
    await sheet.getByRole("button", { name: "Open evidence", exact: true }).click(); await sourceOpened;
    await expect(sheet).toHaveCount(0); await expect(page.locator(`[data-mid="${ids.evidence}"]`)).toContainText("The fixture result was checked.");
    await expect(page.locator(`[data-mid="${ids.evidence}"]`)).toBeVisible();
    await view(page, width, "Board"); await show();
    await sheet.getByRole("button", { name: "Sign off", exact: true }).click(); const goalWrites = () => calls.filter(c => c.path.endsWith("/goals/goal")); await expect.poll(() => goalWrites().length).toBe(1); expect(goalWrites()[0].body).toEqual({ action: "sign_off", expectedRevision: 7 });
    await sheet.getByRole("button", { name: "Close Goal", exact: true }).click(); project.goal!.state = "awaiting_signoff";
    // Changing views mounts a fresh goal view; the strip refresh uses the real event bus.
    await page.evaluate(async groupId => { const path = "/src/lib/use-project.ts"; const { refreshProject } = await import(/* @vite-ignore */ path); await refreshProject(groupId); }, ids.group);
    await show(); await sheet.getByRole("button", { name: "Send back", exact: true }).click(); const back = page.getByRole("dialog", { name: "Send back", exact: true }); await back.getByRole("textbox", { name: "Note" }).fill("Check the output again"); await back.getByRole("button", { name: "Send back", exact: true }).click();
    await expect.poll(() => goalWrites().length).toBe(2); expect(goalWrites()[1].body).toEqual({ action: "send_back", expectedRevision: 8, note: "Check the output again" });
    await sheet.getByRole("button", { name: "Close Goal", exact: true }).click(); project.goal!.state = "awaiting_plan_ok";
    await page.evaluate(async groupId => { const path = "/src/lib/use-project.ts"; const { refreshProject } = await import(/* @vite-ignore */ path); await refreshProject(groupId); }, ids.group);
    await show(); control.goalConflict = true; await sheet.getByRole("button", { name: "Approve plan", exact: true }).click(); await expect(sheet.getByRole("alert")).toContainText("This goal changed. Refresh and try again.");
    await sheet.getByRole("button", { name: "Approve plan", exact: true }).click(); await expect.poll(() => goalWrites().length).toBe(4); expect(goalWrites()[3].body).toEqual({ action: "approve_plan", expectedRevision: 10 });
    await sheet.getByRole("button", { name: "Close Goal", exact: true }).click(); await view(page, width, "Overview"); await expect(page.getByRole("region", { name: "Goal", exact: true })).toContainText("Working");
    await page.getByRole("button", { name: /^Card 1:/ }).click(); await expect(page.getByRole("dialog", { name: /^Card 1:/ })).toBeVisible();
  });
  test(`9 Activity paging, digest switch and persistent since-you-left at ${width}`, async ({ page }) => {
    const { calls, control } = await open(page, width); const since = page.getByRole("complementary", { name: "Since you left" }); await expect(since).toContainText("4 messages, 2 cards changed, 1 decision");
    await view(page, width, "Activity"); const activity = page.getByRole("region", { name: "Activity", exact: true }); await expect(activity.getByRole("listitem")).toHaveCount(30); const sentences = [
      "Card 1 'Deliverable 1: a long descriptive title that must remain readable inside this card' was added",
      "Card 1 moved from In progress to Waiting", "Card 1 was reassigned", "Card 1 was taken over by you", "Card 1 failed", "Card 1 has a result",
      "The brief changed (version 4)", "The goal is now Working", "A done criterion changed", "A decision needs you", "A decision was resolved",
      "Usage reached the warning level", "Limit reached: new work is paused", "The usage limit was raised", "A teammate could not continue", "A routine ran",
      "Project settings changed", "Work folders changed", "The project was restored", "The project was closed", "The project was reopened", "The deadline was reached", "Project updated",
    ];
    await expect(activity.getByRole("listitem").locator("p:first-child")).toHaveText([...sentences, ...sentences.slice(0, 7)]); await activity.getByRole("button", { name: "Show older", exact: true }).click(); await expect(activity.getByRole("listitem")).toHaveCount(31);
    expect(calls.some(c => c.path.endsWith("/activity") && c.query.includes("before=71001"))).toBe(true);
    await activity.getByRole("switch", { name: "Daily digest" }).click(); await expect(activity.getByRole("switch", { name: "Daily digest" })).toHaveAttribute("aria-checked", "true");
    expect(calls.find(c => c.path.endsWith("/project/settings"))!.body).toEqual({ expectedRevision: 3, parts: { board: true, review: true, digest: true } });
    await expect(since).toContainText("4 messages, 2 cards changed, 1 decision");
    control.digestForbidden = true; await activity.getByRole("switch", { name: "Daily digest" }).click(); await expect(activity.getByRole("alert")).toContainText("This needs the Murage app on your computer.");
    await since.getByRole("button", { name: "Show board", exact: true }).click(); await expect(page.getByRole("region", { name: "Board", exact: true })).toBeVisible(); await since.getByRole("button", { name: "Dismiss", exact: true }).click(); await expect(since).toHaveCount(0);
    await view(page, width, "Chat"); await expect(page.getByTestId("murage-row").getByText("Daily digest for 29 Sep: nothing changed since the last digest.", { exact: true })).toBeVisible();
  });
  test(`10 real server update within 1 s and replay fallback at ${width}`, async ({ page }) => {
    // No project/API response mocks: the native EventSource receives the real
    // server's frames. Only its reconnect cursor is perturbed for the gap test.
    await page.addInitScript(() => {
      const Native = window.EventSource;
      const sources: EventSource[] = []; let stream = "", gap = false;
      class ObservedSource extends Native {
        constructor(url: string | URL, options?: EventSourceInit) {
          const next = new URL(String(url), location.href);
          if (gap && stream && next.pathname === "/api/events") { next.searchParams.set("since", `${stream}:9007199254740990`); gap = false; }
          super(next, options); sources.push(this);
          this.addEventListener("message", event => { const frame = JSON.parse(event.data); if (frame.kind === "hello" && frame.cursor) stream = frame.cursor.split(":")[0]; });
        }
      }
      window.EventSource = ObservedSource;
      Object.assign(window, { u2ReplayGap: () => { gap = true; for (const source of sources.filter(s => s.readyState !== Native.CLOSED)) { source.dispatchEvent(new Event("error")); source.close(); } } });
    });
    const create = await page.request.post(`${origin}/api/groups/${ids.live}/board/cards`, { headers, data: { clientId: `live-${width}`, title: `Live card ${width}`, writes: false } }); expect(create.ok()).toBe(true);
    const { card } = await create.json() as { card: ProjectCard };
    await enter(page, width, LIVE); await view(page, width, "Board"); const todo = page.getByRole("region", { name: "To do", exact: true }); await expect(todo.getByRole("button", { name: new RegExp(`^Card ${card.number}:`) })).toBeVisible();
    if (width === 390) await page.getByRole("combobox", { name: "Column picker" }).selectOption("done");
    const moved = await page.request.patch(`${origin}/api/groups/${ids.live}/board/cards/${card.id}`, { headers, data: { action: "move", toState: "done", columnId: null, confirm: true, expectedRevision: card.revision } }); expect(moved.ok()).toBe(true);
    const at = Date.now(); await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: new RegExp(`^Card ${card.number}:`) })).toBeVisible({ timeout: 1000 }); expect(Date.now() - at).toBeLessThanOrEqual(1000);
    // Keep this real Start queued deterministically, without racing dispatch.
    const paused = await page.request.post(`${origin}/api/groups/${ids.live}/project/control/pause`, { headers, data: {} }); expect(paused.ok()).toBe(true);
    const queuedCreate = await page.request.post(`${origin}/api/groups/${ids.live}/board/cards`, { headers, data: { clientId: `queued-${width}`, title: `Queued card ${width}`, assigneeBotId: ids.bots[0], writes: false } }); expect(queuedCreate.ok()).toBe(true);
    const { card: queuedCard } = await queuedCreate.json() as { card: ProjectCard };
    if (width === 390) await page.getByRole("combobox", { name: "Column picker" }).selectOption("todo");
    const queuedButton = todo.getByRole("button", { name: new RegExp(`^Card ${queuedCard.number}:`) });
    await queuedButton.click();
    await page.getByRole("region", { name: "Card actions" }).getByRole("button", { name: "Start", exact: true }).click();
    await expect(page.getByRole("region", { name: "Current run" })).toContainText("queued");
    await expect(page.getByRole("region", { name: "Card actions" }).getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(queuedButton.getByText("queued", { exact: true })).toBeVisible();
    const queuedRead = await (await page.request.get(`${origin}/api/groups/${ids.live}/board`, { headers })).json() as ProjectBoardRead;
    expect(queuedRead.cards.find(c => c.id === queuedCard.id)?.requestId).toBeNull();
    const health = async () => (await (await page.request.get(`${origin}/api/health`)).json()).eventStreams.replayFallbacks as number;
    const prior = await health(); const reads = { board: 0, project: 0, requests: 0 };
    page.on("request", request => { const path = new URL(request.url()).pathname; for (const key of ["board", "project", "requests"] as const) if (path === `/api/groups/${ids.live}/${key}`) reads[key]++; });
    // Drain the move's own coalesced frames before attributing reads to the gap.
    let previousReads = JSON.stringify(reads), quietSince = Date.now();
    await expect.poll(() => {
      const current = JSON.stringify(reads);
      if (current !== previousReads) { previousReads = current; quietSince = Date.now(); }
      return Date.now() - quietSince;
    }, { timeout: 10000, intervals: [100] }).toBeGreaterThanOrEqual(1000);
    reads.board = 0; reads.project = 0; reads.requests = 0;
    await page.evaluate(() => (window as unknown as { u2ReplayGap: () => void }).u2ReplayGap());
    await expect.poll(health).toBeGreaterThan(prior); for (const key of ["board", "project", "requests"] as const) await expect.poll(() => reads[key]).toBeGreaterThan(0);
  });
}
