// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NEEDSYOU-FULLWIDTH-1019 (Sean 11-09, packaged 1.0.18 on a ~2000px window: the Needs you page "stops at 1140px, black to
// the right"). The real app over a real verification server. Every lazy page of the main slot must fill the main area at
// every width: its box starts where the rail ends and runs to the window's right edge, and nothing scrolls sideways.
// Screenshots land in NEEDSYOU_SHOTS_DIR when set.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string;

async function bring() {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env);
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "nyfw-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0);
    const address = vite.httpServer!.address();
    if (!address || typeof address === "string") throw Error("No fixture port");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
}
async function leave() { try { await vite?.close(); } finally { await fixture?.close(); } }
test.beforeAll(bring);
test.afterAll(leave);

const shotDir = (fallback: string) => { const dir = process.env.NEEDSYOU_SHOTS_DIR || fallback; mkdirSync(dir, { recursive: true }); return dir; };

async function start(page: Page, width: number, height: number) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(origin);
  await expect(page.getByRole("complementary", { name: "Bots and navigation" })).toBeAttached({ timeout: 60_000 });
}

/** The page box against the rail and the window. A lazy wrapper that shrinks to its content leaves `right` short. */
async function fills(page: Page, label: string) {
  const main = page.getByRole("main", { name: label, exact: true });
  await expect(main).toBeVisible({ timeout: 30_000 });
  const m = await main.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const rail = document.querySelector('aside[aria-label="Bots and navigation"]')?.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, innerWidth, railRight: rail && rail.width > 0 && rail.right > 0 ? rail.right : 0, sideScroll: document.documentElement.scrollWidth > innerWidth };
  });
  expect(Math.abs(m.right - m.innerWidth), `${label} runs to the window right edge (${JSON.stringify(m)})`).toBeLessThanOrEqual(1);
  expect(m.sideScroll, "no sideways scroll").toBe(false);
  return m;
}

async function openDoor(page: Page, door: "today" | "needs-you" | "routines", phone: boolean) {
  const sidebar = phone ? await openSidebar(page) : page.getByRole("complementary", { name: "Bots and navigation" });
  await sidebar.locator(`[data-door="${door}"]`).first().click();
}

for (const [width, height] of [[1280, 900], [1600, 1000], [2000, 1100], [2560, 1300], [390, 844]] as const) {
  test(`Needs you fills the main area at ${width}px`, async ({ page }, info) => {
    const dir = shotDir(info.outputPath("shots"));
    await start(page, width, height);
    await openDoor(page, "needs-you", width < 768);
    await expect(page.getByRole("main", { name: "Needs you", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /^Needs you/ }).first()).toBeVisible();
    // the picture first, so a failing run still leaves it (the before shots)
    await page.screenshot({ path: join(dir, `needsyou-${width}.png`) });
    const m = await fills(page, "Needs you");
    // one background across the whole main area: the reading column is not a lighter island on a darker void
    const bgs = await page.evaluate(() => [document.querySelector('main[aria-label="Needs you"]'), document.querySelector('section[aria-labelledby="inbox-title"]')].map((el) => (el ? getComputedStyle(el).backgroundColor : "")));
    expect(bgs[0], "page and reading column share one background").toBe(bgs[1]);
    expect(m.railRight === 0 || Math.abs(m.left - m.railRight) <= 1, `starts at the rail edge (${JSON.stringify(m)})`).toBe(true);
  });
}

/** Two approvals waiting, written the way the Inbox projection reads them (as function-sweep-fixture.ts does). */
async function seedApprovals() {
  const { DatabaseSync } = await import("node:sqlite");
  const secret = (await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string }).secret;
  const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const bots = await (await fetch(fixture.info.url + "/api/bots", { headers })).json() as { bots?: Array<{ id: string; threadId: string }> };
  const botId = bots.bots![0]!.threadId;
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=10000");
  const at = Date.now() - 3_600_000;
  // Written twice: the server notices a row rewritten behind its back, not always the first insert.
  for (const pass of [0, 1]) for (const [i, subtitle] of ["git push origin main", "fly deploy --app launch-site"].entries()) {
    if (pass === 1 && i === 0) await new Promise((done) => setTimeout(done, 2_000));
    const card = { requestId: `req-${i}`, title: "Approval needed", subtitle, options: ["Allow", "Deny"], tool: "Bash", lowRisk: true, wants: `Run ${subtitle}`, cardClass: { reason: "no-grant", unattended: false, origin: "owner" } };
    db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,'bot','options',NULL,?)").run(botId, `ny-${i}`, at + i * 1000, JSON.stringify({ id: `ny-${i}`, role: "bot", kind: "options", at: at + i * 1000, card }));
  }
  db.close();
}

// A fresh server, seeded before its first Inbox read (it keeps that first answer for a while).
test.describe("with two approvals waiting", () => {
test.beforeAll(async () => { await leave(); await bring(); await seedApprovals(); });
for (const width of [1280, 2000, 2560, 390]) {
  test(`Needs you with two approvals waiting keeps every row control inside the page at ${width}px`, async ({ page }, info) => {
    const dir = shotDir(info.outputPath("shots"));
    await start(page, width, 1000);
    await openDoor(page, "needs-you", width < 768);
    const rows = page.locator("[data-needs-row]");
    // rows written behind the server's back reach it on its own poll; Refresh re-reads until they do
    await expect(async () => { await page.getByRole("button", { name: "Refresh" }).click(); await expect(rows).toHaveCount(2, { timeout: 4_000 }); }).toPass({ timeout: 100_000, intervals: [1_000] });
    await page.screenshot({ path: join(dir, `needsyou-rows-${width}.png`) });
    await fills(page, "Needs you");
    const boxes = await page.getByRole("main", { name: "Needs you", exact: true }).evaluate((main) => {
      const m = main.getBoundingClientRect();
      return Array.from(main.querySelectorAll("[data-needs-row] button")).map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent || "").trim().slice(0, 24), shown: r.width > 0 && r.height > 0, inside: r.left >= m.left - 1 && r.right <= m.right + 1 }; });
    });
    expect(boxes.length, "each row has its buttons").toBeGreaterThanOrEqual(2);
    for (const b of boxes) { expect(b.shown, `${b.text} is drawn`).toBe(true); expect(b.inside, `${b.text} is inside the page`).toBe(true); }
  });
}
});

for (const width of [1600, 2560]) {
  test(`Routines fills the main area at ${width}px (the shared lazy wrapper)`, async ({ page }, info) => {
    const dir = shotDir(info.outputPath("shots"));
    await start(page, width, 1000);
    await openDoor(page, "routines", false);
    await page.screenshot({ path: join(dir, `routines-${width}.png`) });
    const main = page.locator("main").first();
    await expect(main).toBeVisible({ timeout: 30_000 });
    const right = await main.evaluate((el) => el.getBoundingClientRect().right);
    expect(Math.abs(right - width)).toBeLessThanOrEqual(1);
  });
}
