// The routine editor and the event dialog, read the way a screen reader
// reads them.
//
// The editor's "Starts" date and time were bare inputs — the same two
// controls have accessible names in the interval form right below them, and
// none at the top — and the event dialog had icon-only controls whose only
// name was a `title`. axe over each open dialog, plus the accessible names
// themselves, because an unnamed control looks fine in a screenshot.
//
// Real harness, real UI, no model call.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSidebar } from "./fixtures.ts";
import { axeScriptPath } from "./axe.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: { instrumentationSource?: string }) => Promise<VerificationServer>;

let fixture: VerificationServer, vite: ViteDevServer, origin: string;
const botId = "routine-a11y-bot";
const WCAG = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } } as const;

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const at=Date.now();
    writeFileSync(join(process.env.MURAGE_DATA_DIR,'bots.json'),JSON.stringify([{id:'${botId}',threadId:'routine-a11y-task',name:'Routine a11y bot',title:'Briefings',description:'Fixture only',color:'green',notifications:false,unread:false,createdAt:at,modelSelection:{instanceId:'verification',model:'sonnet'},resumeCursors:{},tasks:[{threadId:'routine-a11y-task',title:'Routine task',createdAt:at,resumeCursors:{}}],composio:false,browser:false,computer:'off'}]));
  ` });
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "routine-a11y-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
      server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("Routine a11y fixture did not bind");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

async function openRoutines(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  // the first-run setup checklist is another lane's surface; this spec is
  // about the routine editor, so it starts from a machine that has seen it
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.locator("[data-sidebar-more-trigger]").click();
  await sidebar.getByRole("menuitem", { name: "Routines", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Routines", exact: true })).toBeVisible();
}

/** axe over one open dialog, with the violations kept as evidence. */
async function auditDialog(page: import("@playwright/test").Page, name: string, info: import("@playwright/test").TestInfo) {
  await page.addScriptTag({ path: axeScriptPath });
  const result = await page.evaluate(async ([label, options]) => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => node.getAttribute("aria-label") === label);
    if (!dialog) throw new Error(`no open dialog labelled ${label}`);
    return (window as any).axe.run(dialog, options);
  }, [name, WCAG] as const);
  writeFileSync(info.outputPath(`axe-${name.replace(/\s+/g, "-")}.json`), JSON.stringify(result.violations, null, 2));
  return result.violations as Array<{ id: string; impact: string; nodes: Array<{ html: string }> }>;
}

test("the routine editor's date and time say what they are", async ({ page }, info) => {
  await openRoutines(page);
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Quick create" })).toBeVisible();
  await page.getByRole("button", { name: "More options", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New routine" });
  await expect(editor).toBeVisible();

  await page.screenshot({ path: info.outputPath("routine-editor.png"), fullPage: true });
  const violations = await auditDialog(page, "New routine", info);
  expect(violations.map(v => `${v.impact}:${v.id}`)).toEqual([]);

  // the two controls that decide WHEN, named — the interval form below them
  // has named its own pair all along
  await expect(editor.getByLabel("Start date", { exact: true })).toBeVisible();
  await expect(editor.getByLabel("Start time", { exact: true })).toBeVisible();
});

test("the event dialog's controls are named, not just titled", async ({ page }, info) => {
  await openRoutines(page);
  await page.keyboard.press("c");
  const quick = page.getByRole("dialog", { name: "Quick create" });
  await expect(quick).toBeVisible();
  await quick.getByPlaceholder("Add title").fill("Accessible briefing");
  await quick.getByPlaceholder("What should the bot do?").fill("Say what changed.");
  await quick.getByRole("button", { name: "Save", exact: true }).click();
  await expect(quick).toHaveCount(0);

  const card = page.locator("[data-event-card]").filter({ hasText: "Accessible briefing" }).first();
  await expect(card).toBeVisible();
  await card.click();
  const details = page.getByRole("dialog", { name: "Routine details" });
  await expect(details).toBeVisible();

  await page.screenshot({ path: info.outputPath("event-dialog.png"), fullPage: true });
  const violations = await auditDialog(page, "Routine details", info);
  expect(violations.map(v => `${v.impact}:${v.id}`)).toEqual([]);

  // every control in it answers to a name of its own, not a `title` a screen
  // reader may never announce
  const unnamed = await details.evaluate(node =>
    [...node.querySelectorAll("button")]
      .filter(button => !(button.getAttribute("aria-label") || button.textContent || "").trim())
      .map(button => button.outerHTML));
  expect(unnamed).toEqual([]);
  await expect(details.getByRole("button", { name: "Pause routine", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Delete routine", exact: true })).toBeVisible();
});
