// SETTINGS-P-LAZY-FAILURE-1019 section 4 "Mounted" (Astra r3 fix 3, r4 gaps 1 and 2): what a person sees and where focus
// lands when a lazy chunk fails to load inline. The chunk failure is real: the module request is aborted with page.route
// (isChunkLoadError matches "Failed to fetch dynamically imported module"). Retry is never clicked: it reloads the page.
// The real StoreProvider and the real components are mounted on a Vite fixture; every /api call is routed here.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { freePortBlock } from "../../server/testing/ports";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer;
let origin: string;
let cache: string;

const RETRY = "Couldn't open this. Tap to retry.";
const BOT = {
  id: "lazy-bot", name: "Lazy fixture", color: "blue", threadId: "thread-a",
  modelSelection: { instanceId: "fixture", model: "fixture" }, tasks: [], messages: [], description: "", title: "",
};

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-lazy-close-vite-"));
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "lazy-close-fixture",
      resolveId(id) { if (id === "/__lazyclose.js") return "\0lazy-close-fixture"; },
      load(id) {
        if (id !== "\0lazy-close-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { StoreProvider, useStore } from '/src/state/store.tsx';
          import { ModelPicker } from '/src/components/ModelPicker.tsx';
          import { PermissionModeMenu } from '/src/components/PermissionModeMenu.tsx';
          import { ImageSettingsView } from '/src/components/ImageSettings.tsx';
          import { PendingApprovalActions, PendingApprovalPanel } from '/src/components/PendingApproval.tsx';
          import { Composer } from '/src/components/Composer.tsx';
          import '/src/styles.css';
          const which = new URL(location.href).searchParams.get('c');
          // The composer draws a decorative backdrop (aria-hidden, bg-app) under its card; in the app the page layout keeps it
          // behind the controls. The bare fixture has no such layout, so the backdrop must not take clicks.
          const decor = document.createElement('style');
          decor.textContent = '[aria-hidden="true"].bg-app { pointer-events: none; }';
          document.head.append(decor);
          function Phone({ bot }) {
            const more = React.useRef(null);
            return React.createElement('div', { style: { position: 'relative', padding: '12px' } },
              React.createElement('button', { ref: more, id: 'more-button', type: 'button' }, 'More'),
              React.createElement(ModelPicker, { bot, hideTrigger: true, returnFocusRef: more }));
          }
          function Probe() {
            const { state } = useStore();
            if (!state.bots[0] || !state.instances.length) return React.createElement('output', {}, 'loading');
            const bot = state.bots[0];
            let body;
            if (which === 'picker') body = React.createElement('div', { style: { padding: '12px', maxWidth: '360px' } }, React.createElement(ModelPicker, { bot }));
            else if (which === 'picker-phone') body = React.createElement(Phone, { bot });
            else if (which === 'permission') body = React.createElement(PermissionModeMenu, { botName: bot.name, current: 'ask', desktop: true, onPick: () => {} });
            else if (which === 'image') body = React.createElement(ImageSettingsView, { snapshot: { enabled: false, connections: [], selected: null, catalog: null, catalogError: null, dailyProbe: false }, busy: null, error: '', notice: '', onChange: () => {}, onRefresh: () => {}, onProbe: () => {}, showLibrary: true });
            else if (which === 'approval') {
              const card = { title: 'Review command', subtitle: 'git status', tool: 'Bash', requestId: 'request-a', options: ['Allow', 'Deny'], allowKey: 'Bash:git' };
              const pending = { requestId: 'request-a', tool: 'Bash', allowKey: 'Bash:git', detail: 'git status', message: { id: 'message-a', role: 'bot', kind: 'options', at: 1, card } };
              body = React.createElement(React.Fragment, {}, React.createElement(PendingApprovalPanel, { pending, count: 1, index: 0 }), React.createElement(PendingApprovalActions, { bot, threadId: 'thread-a', onCancelTurn: () => {}, pending }));
            } else if (which === 'composer') body = React.createElement(Composer, { bot });
            // Both menus open upward (bottom-full), as they do above the composer: pin them to the bottom of the page.
            if (which === 'permission' || which === 'composer') body = React.createElement('div', { style: { position: 'fixed', left: '12px', right: '12px', bottom: '12px' } }, body);
            return React.createElement(React.Fragment, {}, React.createElement('output', {}, 'ready'), body);
          }
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          if (path !== "/__lazyclose") return next();
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__lazyclose.js"></script>');
        });
      },
    }],
  });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

/** Mount one component on the fixture. `abort` lists the lazy modules whose request fails (a real chunk load failure). */
async function mount(page: Page, component: string, abort: readonly string[] = []) {
  for (const module of abort) await page.route(`**/${module}*`, (route) => route.abort());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/desktop-secret") return json({ secret: "fixture-proof" });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path === "/api/bots") return json({ bots: [BOT], groups: [] });
    if (path === "/api/config") return json({ surface: "desktop", features: {}, rooms: { turnTimeoutMinutes: 5 } });
    if (path === "/api/instances") return json({ instances: [{
      instanceId: "fixture", driverKind: "fixture", displayName: "Fixture",
      snapshot: { state: "available", authenticated: true },
      models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] },
    }] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    if (path === "/api/provider-connections") return json({ connections: [] });
    return json({});
  });
  await page.goto(`${origin}/__lazyclose?c=${component}`);
  await expect(page.locator("output")).toHaveText("ready");
}

const PICKER_CHUNK = "src/components/ModelPickerDialog.tsx";
const chip = (page: Page) => page.locator('button[aria-haspopup="dialog"]');
const frame = (page: Page) => page.locator("[data-model-picker-load-error]");
const closeButton = (scope: ReturnType<Page["locator"]>) => scope.getByRole("button", { name: "Close", exact: true });

test.describe("the model picker's load-failure frame", () => {
  test("opens in a frame with Retry focused and a Close, kept 12px inside a phone viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mount(page, "picker", [PICKER_CHUNK]);
    await chip(page).click();
    await expect(frame(page)).toBeVisible();
    await expect(frame(page).getByRole("alert")).toBeVisible();
    await expect(frame(page).getByRole("button", { name: RETRY })).toBeFocused();
    await expect(closeButton(frame(page))).toBeVisible();
    const box = (await frame(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(11.5);
    expect(box.x + box.width).toBeLessThanOrEqual(390 - 11.5);
  });

  test("Close closes the frame and focus returns to the chip", async ({ page }) => {
    await mount(page, "picker", [PICKER_CHUNK]);
    await chip(page).click();
    await closeButton(frame(page)).click();
    await expect(frame(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("one Escape closes the frame and focus returns to the chip", async ({ page }) => {
    await mount(page, "picker", [PICKER_CHUNK]);
    await chip(page).click();
    await expect(frame(page).getByRole("button", { name: RETRY })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(frame(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("opened by the open-picker event with a model in the query: still ONE Escape, focus on the chip (Astra r4 gap 1)", async ({ page }) => {
    await mount(page, "picker", [PICKER_CHUNK]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("murage:open-model-picker", { detail: { model: "gpt-fixture" } })));
    await expect(frame(page)).toBeVisible();
    await expect(frame(page).getByRole("button", { name: RETRY })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(frame(page)).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });

  test("on the phone (no chip) Close returns focus to the header's ... button", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await mount(page, "picker-phone", [PICKER_CHUNK]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("murage:open-model-picker", { detail: {} })));
    await expect(frame(page)).toBeVisible();
    await closeButton(frame(page)).click();
    await expect(frame(page)).toHaveCount(0);
    await expect(page.locator("#more-button")).toBeFocused();
  });

  test("the normal dialog (chunk served): the first Escape clears the query, the second closes", async ({ page }) => {
    await mount(page, "picker");
    await chip(page).click();
    const dialog = page.locator("[data-model-picker-content]");
    await expect(dialog).toBeVisible();
    await expect(frame(page)).toHaveCount(0);
    const search = dialog.getByLabel("Search models");
    await search.fill("zzz");
    await expect(search).toHaveValue("zzz");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(search).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(chip(page)).toBeFocused();
  });
});

test.describe("the other inline Close owners", () => {
  test("PermissionModeMenu: Close shuts the <details>, focuses its <summary>, and reopening shows the alert again", async ({ page }) => {
    await mount(page, "permission", ["src/components/approval/LevelExamples.tsx"]);
    const details = page.locator("details[data-level-table]");
    const summary = details.locator("summary");
    await summary.click();
    await expect(details.getByRole("alert")).toBeVisible();
    await closeButton(details).click();
    await expect(details).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
    await summary.click();
    await expect(details.getByRole("alert")).toBeVisible();
    await expect(closeButton(details)).toBeVisible();
  });

  test("ImageSettings: Close focuses the library opener, and the opener works again", async ({ page }) => {
    await mount(page, "image", ["src/components/ImageLibrary.tsx"]);
    const opener = page.getByRole("button", { name: "Saved prompt blocks and reference packs" });
    await opener.click();
    const section = page.locator("#image-settings-heading").locator("xpath=ancestor::section");
    await expect(section.getByRole("alert")).toBeVisible();
    await closeButton(section).click();
    await expect(section.getByRole("alert")).toHaveCount(0);
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(section.getByRole("alert")).toBeVisible();
  });

  test("PendingApproval fold: Close focuses the caret, aria-expanded goes false, and reopening shows the alert again", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mount(page, "approval", ["src/components/approval/GrantFold.tsx"]);
    const caret = page.locator("[data-fold-caret]");
    await caret.click();
    const group = page.locator('[role="group"][aria-label="Approval"]');
    await expect(group.getByRole("alert")).toBeVisible();
    await expect(caret).toHaveAttribute("aria-expanded", "true");
    await closeButton(group).click();
    await expect(group.getByRole("alert")).toHaveCount(0);
    await expect(caret).toHaveAttribute("aria-expanded", "false");
    await expect(caret).toBeFocused();
    await caret.click();
    await expect(group.getByRole("alert")).toBeVisible();
  });

  test("Composer level confirm: Close focuses the level chip, and picking Full access again shows the alert again", async ({ page }) => {
    await mount(page, "composer", ["src/components/approval/LevelConfirmCard.tsx"]);
    const levelChip = page.locator('[data-coach="level-chip"]');
    await levelChip.click();
    await page.locator('[data-level-option="full"]').click();
    const alert = page.getByRole("alert").filter({ hasText: RETRY });
    await expect(alert).toBeVisible();
    await closeButton(alert).click();
    await expect(alert).toHaveCount(0);
    await expect(levelChip).toBeFocused();
    await levelChip.click();
    await page.locator('[data-level-option="full"]').click();
    await expect(alert).toBeVisible();
  });
});
