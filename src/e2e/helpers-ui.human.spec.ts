// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rendered proof of the helpers (sub agents) display. The fake Claude CLI plays
// its scripted background run (__fixture_background__ with
// FAKE_CLAUDE_BG_STAGGER_DIR): the real frames for three helpers that finish at
// different times, on the real server, through the real UI. Checked at phone
// and desktop width, in a bot chat and in a room: the quiet live line, the
// expanded rows, the folded "Worked for" summary, the same summary after a
// reload (stored with the turn), no horizontal scroll, a visible focus ring.
//
// Headless only. Own data folder, own port; MURAGE_E2E_SHOTS names where the
// pictures go.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openSidebar, SEND_KEY } from "./fixtures.ts";
import { laneDataDir } from "./lane-data-dir.ts";

interface VerificationServer { info: { url: string; dataDir: string }; close(): Promise<void> }
type LaunchVerificationServer = (environment: NodeJS.ProcessEnv, signal?: AbortSignal, options?: {
  instrumentationSource?: string; env?: Record<string, string>;
}) => Promise<VerificationServer>;

let fixture: VerificationServer, vite: ViteDevServer, origin: string, gateDir: string;
const SHOTS = process.env.MURAGE_E2E_SHOTS ?? "";
const WIDTHS = [390, 1440] as const;

test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as
    { launchVerificationServer: LaunchVerificationServer };
  gateDir = join(laneDataDir("helpers-ui gates"), "helpers-gates");
  mkdirSync(gateDir, { recursive: true });
  const names = WIDTHS.flatMap((w) => [`Scout ${w}`, `Roomie ${w}`]);
  fixture = await launchVerificationServer(process.env, undefined, {
    env: { FAKE_CLAUDE_BG_STAGGER_DIR: gateDir },
    instrumentationSource: `
      const {Store}=await import(${JSON.stringify(new URL("../../server/store.ts", import.meta.url).href)});
      const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
      for(const name of ${JSON.stringify(names)}){
        const bot=store.createBot({name},{seedMessages:false});
        if(name.startsWith('Roomie')) store.createGroup('Room '+name.split(' ')[1],[bot.id],false,undefined,{completed:true});
      }
    ` });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "helpers-ui-vite-cache"),
    resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()],
    server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
  await vite.listen(0);
  const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("helpers-ui fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });

const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) }); };
const noSideScroll = async (page: Page, where: string) => {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `${where}: no horizontal scroll`).toBeLessThanOrEqual(inner);
};
const release = (n: number) => writeFileSync(join(gateDir, `finish-${n}`), "");

async function open(page: Page, width: number, entry: string) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.route("**/api/whats-new?*", (route) => route.fulfill({ json: { show: false } }));
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-setup-seen", "1"); });
  await page.goto(origin);
  const sidebar = await openSidebar(page);
  await sidebar.getByText(entry, { exact: true }).first().click();
}

/** Tab until the control has focus, then say whether a ring is drawn on it. */
async function focusRing(page: Page, name: RegExp | string) {
  const control = page.getByRole("button", { name }).first();
  await control.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab"); // keyboard focus, so :focus-visible applies
  await expect(control).toBeFocused();
  const ring = await control.evaluate((el) => { const s = getComputedStyle(el); return { shadow: s.boxShadow, outline: s.outlineStyle }; });
  expect(ring.shadow !== "none" || ring.outline !== "none", `focus ring on ${String(name)}: ${JSON.stringify(ring)}`).toBe(true);
}

for (const width of WIDTHS) {
  for (const kind of ["bot", "room"] as const) {
    test(`${kind}: three helpers finishing at different times, ${width}px`, async ({ page }) => {
      const entry = kind === "bot" ? `Scout ${width}` : `Room ${width}`;
      const tag = `${kind}-${width}`;
      await open(page, width, entry);
      const composer = page.getByRole("textbox").last();
      await composer.fill("go __fixture_background__");
      await page.keyboard.press(SEND_KEY);

      // live: one quiet line, closed
      const line = page.getByTestId("helpers-line");
      await expect(line).toContainText("3 helpers working");
      await expect(line.getByRole("button")).toHaveAttribute("aria-expanded", "false");
      await noSideScroll(page, "live line");
      await shot(page, `${tag}-1-live-line`);

      // expanded: a row per helper with its own label and tool count
      await focusRing(page, /helpers working/);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("helper-row")).toHaveCount(3);
      await expect(page.getByTestId("helper-rows")).toContainText("Check the billing logs");
      await noSideScroll(page, "expanded rows");
      await shot(page, `${tag}-2-expanded-rows-3-working`);

      // finish one at a time
      release(1);
      await expect(line).toContainText("2 helpers working");
      await page.waitForTimeout(1200);
      release(2);
      await expect(line).toContainText("1 helper working");
      await page.waitForTimeout(1200);
      await shot(page, `${tag}-3-expanded-rows-mixed`);
      release(3);

      // settled: folds into Worked for
      const worked = page.getByRole("button", { name: /^Worked/ }).first();
      await expect(worked).toBeVisible();
      await expect(page.getByTestId("helpers-line")).toHaveCount(0);
      await noSideScroll(page, "folded");
      await shot(page, `${tag}-4-folded-worked-for`);
      await focusRing(page, /^Worked/);
      await shot(page, `${tag}-5-folded-focus-ring`);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("helper-row")).toHaveCount(3);
      await expect(page.getByTestId("helper-rows")).toContainText("Compare the pricing pages");
      await noSideScroll(page, "settled rows");
      await shot(page, `${tag}-6-settled-expanded`);

      // reload: the same summary comes back from the server, with no live state
      await page.reload();
      const sidebar = await openSidebar(page);
      await sidebar.getByText(entry, { exact: true }).first().click();
      const again = page.getByRole("button", { name: /^Worked/ }).first();
      await expect(again).toBeVisible();
      await again.click();
      await expect(page.getByTestId("helper-row")).toHaveCount(3);
      await expect(page.getByTestId("helper-rows")).toContainText("Check the billing logs");
      await expect(page.getByTestId("helper-rows")).toContainText("6 tools");
      await noSideScroll(page, "after reload");
      await shot(page, `${tag}-7-after-reload`);
    });
  }
}
