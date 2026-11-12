// SETTINGS-SHELL-CONTRACT-1019 (slice B, the shell): the real SettingsModal on the real store with seven bots.
// What a person sees: Simple by default with nine pages, Each bot's five rows and Browse bots, the one Advanced mode
// switch on General's first card, the breadcrumb with its one Copy link, and the same shell on a phone-width window.
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { freePortBlock } from "../../server/testing/ports";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer;
let origin: string;
let cache: string;
const shots = process.env.SHOTS_DIR ?? "";
// The sidebar cases own the documented desktop viewport. The phone-width
// shell case below explicitly switches to 390px.
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, color: "blue", threadId: `thread-${id}`, modelSelection: { instanceId: "fixture", model: "fixture" },
  tasks: [], messages: [], description: "", title: "", ...extra,
});
const BOTS = [
  bot("nova", "Nova", { chiefOfStaff: true, chiefScope: "workspace" }),
  bot("ada", "Ada"), bot("bea", "Bea"), bot("cleo", "Cleo"), bot("yan", "Yan"), bot("zed", "Zed"), bot("dina", "Dina"),
];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-settings-shell-vite-"));
  if (shots) mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "settings-shell-fixture",
      resolveId(id) { if (id === "/__settingsshell.js") return "\0settings-shell-fixture"; },
      load(id) {
        if (id !== "\0settings-shell-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { StoreProvider, useStore } from '/src/state/store.tsx';
          import { SettingsModal } from '/src/components/SettingsModal.tsx';
          import { BotSettingsDialog } from '/src/components/BotSettingsDialog.tsx';
          import '/src/styles.css';
          function Probe() {
            const { state, dispatch } = useStore();
            window.__settings = { open: (section, anchor) => dispatch({ type: 'toggleAppSettings', open: true, section, anchor }), section: () => state.appSettingsSection };
            if (!state.bots.length) return React.createElement('output', {}, 'loading');
            // The app mounts the bot opener when a bot's page is asked for (App.tsx), and the app window otherwise.
            const settingsBot = state.settingsOpen ? state.bots.find((each) => each.id === state.settingsBotId) : undefined;
            return React.createElement(React.Fragment, {}, React.createElement('output', {}, 'ready'), settingsBot ? React.createElement(BotSettingsDialog, { key: settingsBot.id, bot: settingsBot }) : React.createElement(SettingsModal));
          }
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          if (path !== "/__settingsshell") return next();
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__settingsshell.js"></script>');
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

async function mount(page: Page, mode?: "simple" | "advanced") {
  if (mode) await page.addInitScript((value) => { localStorage.setItem("murage.settings.mode", value); }, mode);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/desktop-secret") return json({ secret: "fixture-proof" });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path === "/api/bots") return json({ bots: BOTS, groups: [] });
    if (path === "/api/config") return json({ surface: "desktop", features: {}, rooms: { turnTimeoutMinutes: 5 }, profile: { name: "Sean", email: "sean@example.com" } });
    if (path === "/api/instances") return json({ instances: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    if (path === "/api/provider-connections") return json({ connections: [] });
    if (path === "/api/about-me") return json({ text: "", saved: false, chars: 0, maxChars: 4000, suggestion: "" });
    return json({});
  });
  await page.goto(`${origin}/__settingsshell`);
  await expect(page.locator("output")).toHaveText("ready");
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const nav = (page: Page) => dialog(page).getByRole("navigation", { name: "Settings sections" });
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const labels = (scope: ReturnType<Page["locator"]>) => scope.getByRole("button").allInnerTexts();

test("Simple is the start: nine pages, Each bot's rows and Browse bots, the mode card first on General", async ({ page }) => {
  await mount(page);
  await expect(dialog(page)).toBeVisible();
  const groups = nav(page).getByRole("group");
  await expect(groups).toHaveCount(5);
  expect(await labels(nav(page).getByRole("group", { name: "You" }))).toEqual(["General"]);
  expect(await labels(nav(page).getByRole("group", { name: "Models and tools" }))).toEqual(["Models & engines"]);
  expect(await labels(nav(page).getByRole("group", { name: "Connections" }))).toEqual(["Connected apps", "Computer & browser", "Phone and other devices"]);
  expect(await labels(nav(page).getByRole("group", { name: "App" }))).toEqual(["Backups", "Usage", "About & help"]);
  await expect(nav(page).locator("[data-settings-bot]")).toHaveCount(5);
  await expect(nav(page).locator("[data-settings-bot]").first()).toContainText("Nova");
  await expect(nav(page).getByRole("button", { name: "Browse bots (7)", exact: true })).toBeVisible();
  await expect(nav(page).locator("[data-set-in-advanced]")).toBeVisible();
  // General: the mode card is the first card, Off
  const mode = dialog(page).getByRole("switch", { name: "Advanced mode" });
  await expect(mode).toHaveAttribute("aria-checked", "false");
  const first = await dialog(page).locator("[data-settings-page-body] > div").first().getAttribute("id");
  expect(first).toBe("advanced-mode-heading");
  await expect(dialog(page).getByText("Nothing is deleted either way.")).toBeVisible();
  await shot(page, "simple-general-1280x800");
});

test("the mode switch shows all 13 sidebar pages and the footer line brings a person back to it", async ({ page }) => {
  await mount(page);
  await dialog(page).getByRole("switch", { name: "Advanced mode" }).click();
  await expect(nav(page).getByRole("group")).toHaveCount(6);
  await expect(nav(page).locator("[data-settings-section]:not([data-settings-section='browseBots'])")).toHaveCount(13);
  await expect(nav(page).getByRole("button", { name: "Calls", exact: true })).toBeVisible();
  await expect(nav(page).locator("[data-settings-mode-footer]")).toContainText("Advanced mode is on");
  await nav(page).getByRole("button", { name: "Usage", exact: true }).click();
  await nav(page).locator("[data-settings-mode-footer]").click();
  await expect(dialog(page).getByRole("switch", { name: "Advanced mode" })).toHaveAttribute("aria-checked", "true");
  await shot(page, "adv-general-1280x800");
  await dialog(page).getByRole("switch", { name: "Advanced mode" }).click();
  await expect(nav(page).getByRole("group")).toHaveCount(5);
});

test("a link to a page Simple does not list turns Advanced on and lands there", async ({ page }) => {
  await mount(page);
  await expect(nav(page).getByRole("button", { name: "Memory", exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open("memory"));
  await expect(nav(page).getByRole("button", { name: "Memory", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav(page).getByRole("group")).toHaveCount(6);
  await shot(page, "adv-memory-1280x800");
});

test("Browse bots lists every bot, filters, and opens one", async ({ page }) => {
  await mount(page);
  await nav(page).getByRole("button", { name: "Browse bots (7)", exact: true }).click();
  const crumbs = dialog(page).getByRole("navigation", { name: "Where you are" });
  await expect(crumbs).toContainText("Settings");
  await expect(crumbs).toContainText("Each bot");
  await expect(crumbs.locator("[aria-current='page']")).toHaveText("Browse bots");
  await expect(dialog(page).locator("[data-settings-browse-row]")).toHaveCount(7);
  // Browse bots is a route, not a page: only it is marked in the sidebar, never General.
  await expect(nav(page).locator("[aria-current='page']")).toHaveCount(1);
  await shot(page, "simple-browse-bots-1280x800");
  await dialog(page).getByRole("textbox", { name: "Find a bot" }).fill("ze");
  await expect(dialog(page).locator("[data-settings-browse-row]")).toHaveCount(1);
  await dialog(page).getByRole("button", { name: "Open Zed" }).click();
  await shot(page, "simple-bot-zed-opened-1280x800");
  // One window: Zed's page opens inside Settings, and the open bot is always one of Each bot's five rows.
  const botWindow = page.getByRole("dialog", { name: "Bot settings: Zed" });
  await expect(botWindow).toBeVisible();
  await expect(botWindow.locator("[data-settings-bot='zed']")).toHaveAttribute("aria-current", "page");
  await expect(botWindow.locator("[data-settings-bot]")).toHaveCount(5);
  await shot(page, "simple-bot-zed-1280x800");
});

test("the breadcrumb ends in the one Copy link, and says so when it copied", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await mount(page, "advanced");
  await nav(page).getByRole("button", { name: "Memory", exact: true }).click();
  const crumbs = dialog(page).getByRole("navigation", { name: "Where you are" });
  await expect(crumbs).toContainText("All bots");
  await expect(crumbs.locator("[aria-current='page']")).toHaveText("Memory");
  await expect(dialog(page).locator("[data-settings-copy-link]")).toHaveCount(1);
  await dialog(page).locator("[data-settings-copy-link]").click();
  await expect(dialog(page).locator("[data-settings-copy-status]")).toHaveText("Link copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("murage://settings/app/memory");
  await shot(page, "adv-memory-breadcrumb-1280x800");
});

test("a phone-width window keeps the shell: a strip of pages, nothing wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page);
  await expect(dialog(page)).toBeVisible();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(wide).toBe(false);
  const select = nav(page).getByRole("combobox", { name: "Settings page", exact: true });
  await expect(select).toHaveValue("general");
  expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(nav(page).locator("#settings-search")).toBeInViewport();
  await expect(nav(page).getByRole("button", { name: "General", exact: true })).toBeHidden();
  await shot(page, "simple-general-390x844");
});
