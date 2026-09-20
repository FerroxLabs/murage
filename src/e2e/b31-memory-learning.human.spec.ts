import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { openSidebar } from "./fixtures.ts";
interface Fixture { info: { url: string; dataDir: string }; close(): Promise<void> }
let fixture: Fixture, vite: ViteDevServer, origin: string, headers: Record<string, string>;
async function api(path: string, body?: unknown, method = body ? "POST" : "GET") {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true); return response.json();
}
// The verification launcher has no IPC channel, so the existing Slack SDK
// fixture receives events through files in the isolated data dir, re-emitted
// in-process. Test-only module substitution; no live Slack or network.
const slackPreload = new URL("../../server/testing/slack-sdk-preload.mjs", import.meta.url).href;
const slackBridge = `import ${JSON.stringify(slackPreload)};import {mkdirSync,readdirSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
const inbox=join(process.env.MURAGE_DATA_DIR,'slack-fixture-inbox');mkdirSync(inbox,{recursive:true});
setInterval(()=>{for(const name of readdirSync(inbox).filter(item=>item.endsWith('.json')).sort()){const path=join(inbox,name),message=JSON.parse(readFileSync(path,'utf8'));rmSync(path);process.emit('message',message);}},100).unref();`;
let slackSequence = 0;
function slackEvent(id: string, text: string, user = "UOTHER") {
  const inbox = join(fixture.info.dataDir, "slack-fixture-inbox"), name = join(inbox, `${String(++slackSequence).padStart(4, "0")}-${id}`);
  mkdirSync(inbox, { recursive: true });
  writeFileSync(name + ".tmp", JSON.stringify({ kind: "slack-fixture-event", body: { type: "event_callback", team_id: "TEAM", api_app_id: "APP", event_id: id, event_time: Math.floor(Date.now() / 1000), authorizations: [{ team_id: "TEAM", user_id: "UBOT", is_bot: true }], event: { type: "message", channel_type: "im", channel: "DOTHER", user, text } } }));
  renameSync(name + ".tmp", name + ".json");
}
async function openWorkspaceMemory(page: Page) {
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.locator("[data-sidebar-more-trigger]").click();
  await sidebar.getByRole("menuitem", { name: "Team map", exact: true }).click();
  await page.getByRole("button", { name: "Manage memory", exact: true }).click();
  return page.getByRole("region", { name: "Workspace memory", exact: true });
}
async function inspectWidth(page: Page, width: number, panel: ReturnType<Page["getByRole"]>, target: ReturnType<Page["getByRole"]>, focusTarget: ReturnType<Page["getByRole"]>) {
  await page.setViewportSize({ width, height: 1100 });
  const menu=page.getByRole("button",{name:"Open bot list",exact:true});
  if(width<768){
    if(await menu.getAttribute("aria-expanded")==="true"){
      await page.keyboard.press("Escape");
      await expect(menu).toHaveAttribute("aria-expanded","false");
    }
    // The drawer's transform can still overlap after its state changes; wait for its actual geometry.
    const aside=page.getByRole("complementary",{name:"Bots and navigation",exact:true});
    await expect.poll(()=>aside.evaluate(element=>element.getBoundingClientRect().right)).toBeLessThanOrEqual(0.5);
  }
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  // Establish a start point, then reach the control with actual keyboard
  // navigation. Programmatic focus alone does not activate focus-visible.
  await focusTarget.focus();await page.keyboard.press("Shift+Tab");await page.keyboard.press("Tab");
  await expect(focusTarget).toBeFocused();
  expect(await focusTarget.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
}
async function audit(page: Page, info: { attach: (name: string, value: { body: string; contentType: string }) => Promise<void> }, name: string) {
  if (!process.env.MURAGE_B31_AXE_SOURCE) return;
  await page.addScriptTag({ path: process.env.MURAGE_B31_AXE_SOURCE });
  const result = await page.evaluate(async () => (window as any).axe.run(document.querySelector('[data-testid="memory-settings"]')));
  await info.attach(`axe-${name}.json`, { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.violations.filter((issue: any) => ["critical", "serious"].includes(issue.impact))).toEqual([]);
}
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer: (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<Fixture> };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: slackBridge });
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json();
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    await api("/api/bots", { name: "Learning fixture", section: "Memory" });
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "b31-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("B31 fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
test("learning choices persist, stale edits require refresh, and workspace activity remains honest", async ({ page }, info) => {
  const panel = await openWorkspaceMemory(page);
  const controls = panel.getByRole("region", { name: "Workspace automatic learning", exact: true });
  const facts = controls.getByRole("checkbox", { name: /^Learn facts automatically/ });
  const procedures = controls.getByRole("checkbox", { name: /^Learn procedures automatically/ });
  const review = controls.getByRole("checkbox", { name: /^Review new learning before activation/ });
  await expect(facts).toBeChecked(); await expect(procedures).toBeChecked(); await expect(review).not.toBeChecked();
  const before = await api("/api/memory/status");
  await facts.uncheck(); await review.check();
  const saved = page.waitForResponse(response => response.url().endsWith("/api/memory/action") && response.request().postDataJSON()?.action === "configure");
  await controls.getByRole("button", { name: "Save learning settings" }).click(); expect((await saved).ok()).toBe(true);
  await expect.poll(async () => (await api("/api/memory/status")).learning.revision).toBe(before.learning.revision + 1);
  await expect(facts).not.toBeChecked(); await expect(review).toBeChecked();
  const current = await api("/api/memory/status");
  expect(current.configuration).toEqual(before.configuration); expect(current.model.state).toBe(before.model.state);
  expect(current.learning.inputLimit).toBe(before.learning.inputLimit);
  await api("/api/memory/action", { action: "configure", learning: { automaticProcedures: false }, learningRevision: current.learning.revision });
  await controls.getByRole("button", { name: "Save learning settings" }).click();
  await expect(controls.getByRole("alert")).toContainText("changed elsewhere");
  await expect(controls.getByRole("button", { name: "Save learning settings" })).toBeDisabled();
  await controls.getByRole("button", { name: "Refresh learning settings" }).click();
  await expect(procedures).not.toBeChecked(); await expect(controls.getByRole("button", { name: "Save learning settings" })).toBeEnabled();
  await panel.getByText("Workspace learning activity", { exact: true }).click();
  await expect(panel.getByText(/Counts cover the whole workspace/)).toBeVisible();
  await expect(panel.getByText("No activity recorded", { exact: false }).first()).toBeVisible();
  await expect(panel.getByText(/Synthesis: disabled/)).toBeVisible();
  await expect(panel.getByText("Supplied to turns", { exact: true })).toBeVisible();
  for (const width of [390, 820, 1440]) {
    await inspectWidth(page, width, panel, controls, facts);
    await page.keyboard.press("Space"); await expect(facts).toBeChecked(); await page.keyboard.press("Space");
    await audit(page, info, String(width));
    await page.screenshot({ path: info.outputPath(`b31-learning-${width}.png`), fullPage: true });
  }
});
test("owner assigns, conflicts and revokes an actual verified Slack person through the people controls", async ({ page }, info) => {
  test.setTimeout(90000);
  const chief = (await api("/api/bots")).bots[0];
  await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, chiefScope: "workspace", computer: "off", browser: false, composio: false }, "PATCH");
  await api("/api/config?secretStorage=external", { slack: { appToken: "xapp-fixture-not-real", botToken: "xoxb-fixture-not-real", teamId: "TEAM", appId: "APP", ownerUserId: "UOTHER" } }, "PATCH");
  const pairing = await api("/api/slack/pair", { targetBotId: chief.id });
  slackEvent("EvPAIR", "/pair " + pairing.code);
  await expect.poll(async () => (await api("/api/slack/status")).paired, { timeout: 15000 }).toBe(true);
  slackEvent("EvUNLINKED", "B31_UNLINKED_PERSON_CANARY");
  await expect.poll(async () => (await api("/api/slack/status")).humanBindingState, { timeout: 15000 }).toBe("link-required");
  const peer = (await api("/api/bots")).bots.find((bot: any) => bot.id !== chief.id);
  await api("/api/groups", { name: "Harbour room", memberIds: [chief.id, peer.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: chief.id } } });
  await expect.poll(async () => (await api("/api/memory/status")).scopes.some((scope: any) => scope.kind === "room" && scope.label === "Harbour room")).toBe(true);
  const humans = await api("/api/memory/action", { action: "humans" });
  expect(humans.bindings).toHaveLength(1); expect(humans.bindings[0]).toMatchObject({ personId: null, revision: 1, active: true, state: "link-required" });

  const panel = await openWorkspaceMemory(page);
  const people = panel.getByRole("region", { name: "Verified people and accounts", exact: true });
  const account = people.getByRole("group", { name: "Slack account · user ID UOTHER · authority TEAM", exact: true });
  await expect(account).toContainText("Needs an owner decision");
  await expect(people.getByText("1 verified platform account is waiting for an owner decision.", { exact: true })).toBeVisible();
  const separate = account.getByRole("button", { name: "Separate person", exact: true });
  await separate.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  await expect(separate).toBeFocused();
  expect(await separate.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const linked = page.waitForResponse(response => response.url().endsWith("/api/memory/action") && response.request().postDataJSON()?.action === "human-link");
  await page.keyboard.press("Enter"); expect((await linked).ok()).toBe(true);
  await expect(account).toContainText("Separate person");
  await expect(people.getByText(/waiting for an owner decision/)).toHaveCount(0);
  const person = (await api("/api/memory/action", { action: "humans" })).bindings[0];
  expect(person.personId).toBeTruthy(); expect(person.personId).not.toBe(humans.ownerPersonId); expect(person.revision).toBe(2);
  await expect.poll(async () => (await api("/api/slack/status")).humanPersonId).toBe(person.personId);

  // Owner shares a room audience with the separate person; the control shows only what the server reads back.
  const shared = people.getByRole("group", { name: "Shared audiences for Slack account · user ID UOTHER · authority TEAM", exact: true });
  await expect(shared).toContainText("No shared audiences");
  await shared.getByRole("combobox", { name: "Share an audience" }).selectOption({ label: "Channel: Harbour room" });
  const granted = page.waitForResponse(response => response.url().endsWith("/api/memory/action") && response.request().postDataJSON()?.action === "human-share");
  await shared.getByRole("button", { name: "Share audience", exact: true }).click(); expect((await granted).ok()).toBe(true);
  const room = (await api("/api/memory/status")).scopes.find((scope: any) => scope.kind === "room" && scope.label === "Harbour room");
  await expect.poll(async () => (await api("/api/memory/action", { action: "humans" })).shares).toEqual([{ personId: person.personId, scopeId: room.id, granted: true, revision: 1 }]);
  const stop = shared.getByRole("button", { name: "Stop sharing Channel: Harbour room with Slack account · user ID UOTHER · authority TEAM", exact: true });
  await expect(stop).toBeVisible();
  await audit(page, info, "people-share");
  await page.screenshot({ path: info.outputPath("b31-people-share.png"), fullPage: true });
  await stop.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
  expect(await stop.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
  const revoked = page.waitForResponse(response => response.url().endsWith("/api/memory/action") && response.request().postDataJSON()?.action === "human-share");
  await page.keyboard.press("Enter"); expect((await revoked).ok()).toBe(true);
  await expect.poll(async () => (await api("/api/memory/action", { action: "humans" })).shares).toEqual([{ personId: person.personId, scopeId: room.id, granted: false, revision: 2 }]);
  await expect(shared).toContainText("No shared audiences");

  // A concurrent owner decision elsewhere must not be overwritten by the stale card.
  await api("/api/memory/action", { action: "human-link", bindingId: person.id, expectedRevision: person.revision, as: "owner" });
  await account.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(people.getByRole("alert")).toContainText("changed elsewhere");
  expect((await api("/api/memory/action", { action: "humans" })).bindings[0]).toMatchObject({ personId: humans.ownerPersonId, revision: 3 });
  await people.getByRole("button", { name: "Refresh verified accounts", exact: true }).click();
  await expect(account).toContainText("Workspace owner"); await expect(people.getByRole("alert")).toHaveCount(0);

  for (const width of [390, 820, 1440]) {
    await inspectWidth(page, width, panel, people, account.getByRole("button", { name: "Unlink", exact: true }));
    await audit(page, info, `people-${width}`);
    await page.screenshot({ path: info.outputPath(`b31-people-${width}.png`), fullPage: true });
  }

  await api("/api/slack/revoke", {});
  await expect.poll(async () => (await api("/api/memory/action", { action: "humans" })).bindings[0].active, { timeout: 15000 }).toBe(false);
  await panel.getByRole("button", { name: "Refresh memory", exact: true }).click();
  await expect(account).toContainText("Inactive connection");
  await expect(account.getByRole("button")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("b31-people-revoked-1440.png"), fullPage: true });
});
