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
  cache = mkdtempSync(join(tmpdir(), "murage-settings-pages-b-vite-"));
  if (shots) mkdirSync(shots, { recursive: true });
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "settings-pages-b-fixture",
      resolveId(id) { if (id === "/__settingspagesb.js") return "\0settings-pages-b-fixture"; },
      load(id) {
        if (id !== "\0settings-pages-b-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { StoreProvider, useStore } from '/src/state/store.tsx';
          import { SettingsModal } from '/src/components/SettingsModal.tsx';
          import { LazyOverlay } from '/src/components/LazyOverlay.tsx';
          import { BotSettingsDialog } from '/src/components/BotSettingsDialog.tsx';
          import ConnectionsPage from '/src/components/settings/pages/ConnectionsPage.tsx';
          import '/src/styles.css';
          function Probe() {
            const { state, dispatch } = useStore();
            window.__settings = { open: (section, anchor) => dispatch({ type: 'toggleAppSettings', open: true, section, anchor }), section: () => state.appSettingsSection, opened: () => ({ botId: state.settingsBotId, intent: state.botSettingsIntent }) };
            if (!state.bots.length) return React.createElement('output', {}, 'loading');
            // HTTP fixtures cannot use Electron's murage-home: scheme. Exercise its exact page props here.
            if (new URLSearchParams(location.search).has('cloud')) return React.createElement(React.Fragment, {},
              React.createElement('output', {}, 'ready'), React.createElement('div', { role: 'dialog', 'aria-label': 'Settings' },
                React.createElement(ConnectionsPage, { page: 'connections', mode: 'advanced', desktop: true, cloud: true, anchor: null })));
            // The app mounts the bot opener when a bot's page is asked for (App.tsx), and the app window otherwise.
            const settingsBot = state.settingsOpen ? state.bots.find((each) => each.id === state.settingsBotId) : undefined;
            return React.createElement(React.Fragment, {}, React.createElement('output', {}, 'ready'), settingsBot ? React.createElement(BotSettingsDialog, { key: settingsBot.id, bot: settingsBot }) : React.createElement(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', holdFocus: false, onDismiss: () => dispatch({ type: 'toggleAppSettings', open: false }) }, React.createElement(SettingsModal)));
          }
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          if (path !== "/__settingspagesb") return next();
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__settingspagesb.js"></script>');
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

async function mount(page: Page, mode?: "simple" | "advanced", surface: "desktop" | "remote" | "cloud" = "desktop") {
  if (mode) await page.addInitScript((value) => { localStorage.setItem("murage.settings.mode", value); }, mode);
  // Nothing in these pages may reach a real account, catalog, image host or sign-in service.
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const gmail = { slug: "gmail", label: "Gmail", blurb: "Fixture mail", logo: null, domain: null, signIn: "managed" };
  let accounts = [{ id: "gmail-work", alias: "Work", status: "ACTIVE" }, { id: "gmail-personal", alias: "Personal", status: "ACTIVE" }];
  const services = () => ({ gmail: { connected: accounts.length > 0, accounts } });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/desktop-secret") return json({ secret: "fixture-proof" });
    if (path === "/api/events") return route.fulfill({ status: 204 });
    if (path === "/api/bots") return json({ bots: BOTS, groups: [] });
    if (path === "/api/browser-extension/clients") return json({ enabled: false, clients: [], profiles: [] });
    if (path === "/api/config") return json({ surface: surface === "remote" ? "remote" : "desktop", features: {}, rooms: { turnTimeoutMinutes: 5 }, profile: { name: "Sean", email: "sean@example.com" }, composio: { configured: true, mode: "managed", broker: "flux" }, flux: { configured: true }, box: { configured: false }, vps: { configured: false, sshAlias: "" }, localVm: { mode: "shared", maxInstances: 1 }, claudeCodeImport: { enabled: false, lastImportedAt: null, skills: 0, servers: 0, needsKey: 0 } });
    if (path === "/api/connectors/catalog/cached") return json({ held: false });
    if (path === "/api/connectors/catalog") return json({ cards: [gmail], configured: true, mode: "managed", broker: "flux", fluxConfigured: true, fluxBrokerEnabled: true, source: "api", total: 1, revalidating: false, allApps: true });
    if (path === "/api/connectors/catalog/search" || path === "/api/connectors/catalog/page") return json({ items: [gmail], total: 1, source: "api", nextCursor: null });
    if (path === "/api/connectors/connected" || path === "/api/connectors") return json({ services: services(), apps: { gmail }, configured: true, known: true, revalidating: false });
    if (path.startsWith("/api/connectors/gmail/accounts/") && route.request().method() === "DELETE") {
      accounts = accounts.filter((account) => account.id !== path.split("/").pop());
      return json({ ok: true });
    }
    if (path === "/api/mcp/servers") return json({ servers: [{ kind: "stdio", name: "fixture-tool", command: "fixture-command", args: [], envKeys: [], enabled: false }] });
    if (path === "/api/mcp/inspect") return json({ ok: true, drafts: [], notes: [] });
    if (path === "/api/email/status") return json({ enabled: true, accountState: "active", termsVersion: null, limits: {}, removing: [{ botId: "ada", address: "ada@example.test" }], otherSetups: [{ inboxId: "old", address: "old@example.test" }], accountSends: { today: 2, perDay: 10 }, ownerSignedIn: true });
    if (path === "/api/highlevel") return json({ tokenSaved: false, connection: null, bots: [] });
    if (path === "/api/telegram/status") return json({ configured: false, paired: false, enabled: false, connecting: false, pending: 0, uncertain: 0 });
    if (path === "/api/slack/status" || path === "/api/discord/status") return json({ state: "idle", configured: false, appConfigured: false, botConfigured: false, paired: false, enabled: false, requiresRevoke: false, busy: false, pending: 0, uncertain: 0, rejected: 0, needsReview: 0, error: null, nextRetryAt: null });
    if (path === "/api/whatsapp/status") return json({ state: "idle", linked: false, enabled: false, busy: false, error: null, blockedReason: null, nextRetryAt: null, pending: 0, uncertain: 0, rejected: 0, needsReview: 0, number: null, pairing: [], settings: { mode: "self-chat", allowFrom: [], readReceipts: false, quoteReplies: "groups", groups: { policy: "disabled", senders: "members", allow: [] } } });
    if (path === "/api/people") return json({ people: [] });
    if (path === "/api/instances") return json({ instances: [] });
    if (path === "/api/routines") return json({ routines: [], runs: [] });
    if (path === "/api/webhooks") return json({ webhooks: [], attempts: [] });
    if (path === "/api/provider-connections") return json({ connections: [] });
    if (path === "/api/about-me") return json({ text: "", saved: false, chars: 0, maxChars: 4000, suggestion: "" });
    if (path === "/api/storage") return json({ freeBytes: 120e9, floorBytes: 2e9, attachments: { bytes: 3e8, inProgressBytes: 0 }, files: { bytes: 5e8 } });
    return json({});
  });
  await page.goto(`${origin}/__settingspagesb${surface === "cloud" ? "?cloud=1" : ""}`);
  await expect(page.locator("output")).toHaveText("ready");
}

// ---- SETPAGES-B: pages 8 to 13 plus Apps > Messaging, Simple and Advanced, at 1280 and 390 ----
const dialog = (page: Page) => page.getByRole("dialog", { name: "Settings", exact: true });
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
const PAGES: Record<string, { section: string; title: RegExp; simpleCards: string[]; advancedCards: string[] }> = {
  about: { section: "about", title: /About/, simpleCards: ["about-version-heading", "updates-heading", "whats-new-heading"], advancedCards: ["news-heading", "health-heading", "diagnostics-heading", "setup-heading", "shortcuts-heading"] },
  connections: { section: "connections", title: /Connected apps|Apps/, simpleCards: ["connections-heading", "mcp-servers-heading"], advancedCards: ["bot-email-heading", "claude-code-import-heading", "highlevel-heading"] },
  channels: { section: "channels", title: /Connected apps|Apps/, simpleCards: ["telegram-settings-title"], advancedCards: ["slack-app-setup-heading", "whatsapp-allow-heading"] },
  computer: { section: "computer", title: /Computer/, simpleCards: ["browser-settings-heading"], advancedCards: ["computer-settings-heading", "vps-heading", "script-access-heading"] },
  companion: { section: "companion", title: /Phone/, simpleCards: ["companion-heading"], advancedCards: [] },
  backups: { section: "backups", title: /Backups/, simpleCards: ["backups-heading"], advancedCards: ["storage-heading"] },
  usage: { section: "usage", title: /Usage/, simpleCards: ["usage-heading", "spend-limit-heading", "usage-by-routine-heading", "plan-usage-heading"], advancedCards: ["usage-learning-heading", "memory-limit-heading"] },
};
const only = (process.env.SPB_PAGES ?? Object.keys(PAGES).join(",")).split(",");

if (only.includes("computer")) {
  for (const status of [
    { name: "no engine", runtime: null, ready: false, mode: "shared" },
    { name: "unready VM", runtime: "docker", ready: false, mode: "shared" },
    { name: "new private VM", runtime: "docker", ready: true, mode: "per-bot" },
  ]) {
    test(`default computer: ${status.name} cannot be selected as Local VM`, async ({ page }) => {
      await mount(page, "advanced");
      let reads = 0;
      const writes: unknown[] = [];
      page.on("request", (request) => { if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/config") writes.push(request.postDataJSON()); });
      await page.route("**/api/local-computer", (route) => { reads += 1; return route.fulfill({ json: status }); });
      await page.evaluate(() => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open("computer"));
      const choices = dialog(page).getByRole("radiogroup", { name: "Default computer for new bots" });
      await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
      await expect(choices.getByRole("radio", { name: "Local VM", exact: true })).toBeDisabled();
      await expect(choices.getByRole("radio", { name: "This computer", exact: true })).toHaveAttribute("aria-checked", "true");
      expect(writes).toEqual([]);
    });
  }

  test("default computer: a ready VM can be saved, and a failed recheck disables it without rewriting the choice", async ({ page }) => {
    await mount(page, "advanced");
    let unavailable = false;
    const writes: unknown[] = [];
    await page.route("**/api/local-computer", (route) => route.fulfill(unavailable
      ? { status: 500, json: { error: "Fixture status unavailable" } }
      : { json: { runtime: "docker", ready: true, mode: "shared" } }));
    await page.route("**/api/config", (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { surface: "desktop", features: {}, rooms: { turnTimeoutMinutes: 5 }, newBotComputer: "vm", localVm: { mode: "shared", maxInstances: 2 }, composio: { configured: true, mode: "managed", broker: "flux" }, flux: { configured: true }, box: { configured: false }, vps: { configured: false, sshAlias: "" } } });
    });
    await page.evaluate(() => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open("computer"));
    const vm = dialog(page).getByRole("radiogroup", { name: "Default computer for new bots" }).getByRole("radio", { name: "Local VM", exact: true });
    await expect(vm).toBeEnabled();
    await vm.click();
    await expect(vm).toHaveAttribute("aria-checked", "true");
    await expect(vm).toBeEnabled();
    expect(writes).toEqual([{ computer: { defaultForNewBots: "vm" } }]);
    unavailable = true;
    await expect(vm).toBeDisabled({ timeout: 12_000 });
    await expect(vm).toHaveAttribute("aria-checked", "true");
    expect(writes).toEqual([{ computer: { defaultForNewBots: "vm" } }]);
  });

  test("default computer: the per-bot button opens the displayed bot at Access > Computer", async ({ page }) => {
    await mount(page, "advanced");
    // A hidden first bot must not supply either the label or the destination.
    await page.route((url) => url.pathname === "/api/bots", (route) => route.fulfill({ json: { bots: [bot("nova", "Nova", { hidden: true }), bot("ada", "Ada")], groups: [] } }));
    await page.reload();
    await expect(page.locator("output")).toHaveText("ready");
    await page.evaluate(() => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open("computer"));
    await expect(dialog(page).getByRole("radiogroup", { name: "Default computer for new bots" })).toBeVisible();
    await dialog(page).getByRole("button", { name: "Set it per bot under Ada > Access > Computer", exact: true }).click();
    // The fixture frame has no LayerSlot, so the bot window itself cannot mount here; the opener's contract is what the store now holds.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __settings: { opened: () => unknown } }).__settings.opened())).toEqual({ botId: "ada", intent: { section: "access", anchor: "bot-setting-computer" } });
  });
}

for (const id of only) {
  const spec = PAGES[id]!;
  for (const mode of ["simple", "advanced"] as const) {
    for (const size of [{ w: 1280, h: 800 }, { w: 390, h: 844 }]) for (const skin of ["light", "dark"] as const) {
      test(`${id} in ${mode} at ${size.w}${skin === "dark" ? " in dark" : ""}: the cards the lock names, no sideways scroll`, async ({ page }) => {
        await page.setViewportSize({ width: size.w, height: size.h });
        page.on("console", (m) => { if (m.type() === "error") console.log("PAGEERROR", m.text().slice(0, 400)); });
        await mount(page, mode === "advanced" ? "advanced" : undefined);
        await page.evaluate((value) => document.documentElement.setAttribute("data-skin", value), skin);
        await page.evaluate((section) => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open(section), spec.section);
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).locator("[data-settings-page-body]")).toHaveCount(1);
        const body = dialog(page);
        await expect(body.locator("[data-settings-page-body] > div").first()).toBeVisible();
        await shot(page, `${id}-${mode}-${size.w}${skin === "dark" ? "-dark" : ""}`);
        for (const anchor of spec.simpleCards) await expect(body.locator(`#${anchor}`), anchor).toHaveCount(1);
        for (const anchor of spec.advancedCards) await expect(body.locator(`#${anchor}`), anchor).toHaveCount(mode === "advanced" || !spec.simpleCards.length ? 1 : 0);
        if (id === "usage") {
          const anchors = body.locator("[data-settings-page-body] > div[id]");
          const expected = mode === "advanced"
            ? ["usage-heading", "usage-learning-heading", "memory-limit-heading", "spend-limit-heading", "usage-by-routine-heading", "plan-usage-heading"]
            : ["usage-heading", "spend-limit-heading", "usage-by-routine-heading", "plan-usage-heading"];
          await expect(anchors).toHaveCount(expected.length);
          expect(await anchors.evaluateAll((nodes) => nodes.map((node) => node.id))).toEqual(expected);
        }
        if (mode === "simple" && spec.simpleCards.length && spec.advancedCards.length) await expect(body.locator("[data-settings-page-body] [data-set-in-advanced]:visible")).toHaveCount(1);
        if (id === "computer" || id === "companion") {
          await expect(body.locator("[data-settings-page-body] [data-set-in-advanced]")).toHaveCount(mode === "simple" && spec.advancedCards.length ? 1 : 0);
          expect(await page.evaluate(() => localStorage.getItem("murage.settings.mode"))).not.toBe(mode === "simple" ? "advanced" : "simple");
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await shot(page, `${id}-${mode}-${size.w}${skin === "dark" ? "-dark" : ""}`);
      });
    }
  }
}

if (only.includes("usage")) {
  const learning = (revision = 4, input = 100_000_000, output = 15_000_000) => ({
    revision, defaultOn: true,
    settings: { version: 3, automaticFacts: true, automaticProcedures: true, reviewMode: false, perCallOutputTokens: { extraction: 2000, grounding: 64, reflection: 8000 }, ceiling: { input, output }, callsPerMinute: 6, learnFrom: { chats: true, channels: true }, botsPaused: [] },
    ceiling: { month: "2026-11", input, output, inputUsed: 2_000_000, outputUsed: 300_000, paused: input === 0 || output === 0 },
    connection: { instanceId: "fixture", source: "chosen", label: "Fixture" },
  });
  const openUsage = async (page: Page) => {
    await page.evaluate(() => (window as unknown as { __settings: { open: (section: string) => void } }).__settings.open("usage"));
    await expect(dialog(page).locator("#usage-learning-heading")).toBeVisible();
  };
  const mountUsage = async (page: Page) => {
    // All reads and writes stay in the local fixture, including failures and retries.
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    await mount(page, "advanced");
  };

  test("usage: a conflict refresh keeps both drafts, shows saved values and uses the new revision", async ({ page }) => {
    await mountUsage(page);
    let current = learning();
    let failRead = false;
    const writes: unknown[] = [];
    await page.route("**/api/memory/status", (route) => failRead
      ? route.fulfill({ status: 500, json: { error: "Fixture read failure" } })
      : route.fulfill({ json: { learning: current } }));
    await page.route("**/api/memory/action", async (route) => {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) {
        current = learning(5, 120_000_000, 20_000_000);
        return route.fulfill({ status: 409, json: { error: "MEMORY_LEARNING_REVISION_CONFLICT" } });
      }
      current = learning(6, 250_000_000, 30_000_000);
      return route.fulfill({ json: { learning: current } });
    });
    await openUsage(page);
    const card = dialog(page).locator("#memory-limit-heading");
    await card.getByRole("button", { name: "Change limit", exact: true }).click();
    const read = card.getByLabel("Read limit (millions of tokens)", { exact: true });
    const written = card.getByLabel("Written limit (millions of tokens)", { exact: true });
    await read.fill("250"); await written.fill("30");
    expect(writes).toEqual([]);
    await card.getByRole("button", { name: "Save limit", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("Learning settings changed elsewhere.");
    await expect(read).toHaveValue("250"); await expect(written).toHaveValue("30");
    await expect(card.getByRole("button", { name: "Save limit", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    failRead = true;
    await card.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card.getByText("Could not load memory settings. Refresh settings to try again.", { exact: true })).toBeVisible();
    await expect(read).toHaveValue("250"); await expect(written).toHaveValue("30");
    failRead = false;
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(card.locator("#memory-limit-read-current")).toHaveText("Current saved limit: 120 million tokens.");
    await expect(card.locator("#memory-limit-written-current")).toHaveText("Current saved limit: 20 million tokens.");
    await expect(read).toHaveValue("250"); await expect(written).toHaveValue("30");
    expect(writes).toHaveLength(1);
    await card.getByRole("button", { name: "Save limit", exact: true }).click();
    await expect(card.getByRole("button", { name: "Change limit", exact: true })).toBeVisible();
    expect(writes).toEqual([
      { action: "configure", ceiling: { input: 250_000_000, output: 30_000_000 }, learningRevision: 4 },
      { action: "configure", ceiling: { input: 250_000_000, output: 30_000_000 }, learningRevision: 5 },
    ]);
  });

  test("usage: both learning cards recover from failed initial reads", async ({ page }) => {
    await mountUsage(page);
    let failRead = true;
    const writes: unknown[] = [];
    await page.route("**/api/memory/status", (route) => failRead
      ? route.fulfill({ status: 500, json: { error: "Fixture read failure" } })
      : route.fulfill({ json: { learning: learning() } }));
    await page.route("**/api/memory/action", (route) => { writes.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
    await openUsage(page);
    const usage = dialog(page).locator("#usage-learning-heading");
    const limit = dialog(page).locator("#memory-limit-heading");
    await expect(usage.getByRole("alert")).toHaveText("Could not load learning usage. Try again.");
    await expect(limit.getByRole("alert")).toContainText("Could not load memory settings.");
    await expect(usage.getByRole("progressbar")).toHaveCount(0);
    failRead = false;
    await usage.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(usage.getByRole("progressbar")).toHaveCount(2);
    await limit.getByRole("button", { name: "Retry", exact: true }).click();
    await limit.getByRole("button", { name: "Change limit", exact: true }).click();
    await expect(limit.getByLabel("Read limit (millions of tokens)", { exact: true })).toHaveValue("100");
    await expect(limit.getByLabel("Written limit (millions of tokens)", { exact: true })).toHaveValue("15");
    expect(writes).toEqual([]);
  });

  test("usage: loading, unavailable and stale learning readings remain distinct", async ({ page }) => {
    await mountUsage(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let mode: "ready" | "failed" | "unavailable" = "ready";
    await page.route("**/api/memory/status", async (route) => {
      await gate;
      if (mode === "failed") return route.fulfill({ status: 500, json: { error: "Fixture read failure" } });
      return route.fulfill({ json: mode === "unavailable" ? {} : { learning: learning() } });
    });
    await openUsage(page);
    const card = dialog(page).locator("#usage-learning-heading");
    await expect(card.getByRole("status")).toHaveText("Loading…");
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    release();
    await expect(card.getByRole("progressbar", { name: "Read: 2M of 100M", exact: true })).toHaveAttribute("aria-valuenow", "2");
    await expect(card.getByRole("progressbar", { name: "Written: 300k of 15M", exact: true })).toHaveAttribute("aria-valuenow", "2");
    mode = "failed";
    await card.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("Could not load learning usage.");
    await expect(card.getByRole("alert")).toContainText(/Showing last-known values from .+\. They may be out of date\./);
    await expect(card.getByRole("progressbar")).toHaveCount(2);
    await expect(card.getByText(/Runs on Fixture\./)).toBeVisible();
    mode = "ready";
    await card.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    mode = "unavailable";
    await card.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card.getByText("Not available here.", { exact: true })).toBeVisible();
    await expect(card.getByRole("progressbar")).toHaveCount(0);
    await expect(card.getByRole("alert")).toHaveCount(0);
  });
}

if (only.includes("connections")) {
  const openApps = (page: Page) => page.evaluate(() => (window as unknown as { __settings: { open: (s: string) => void } }).__settings.open("connections"));

  test("Apps keeps catalog, account actions and tool editing inside Settings", async ({ page }) => {
    await mount(page, "simple");
    let toolTests = 0;
    await page.route("**/api/mcp/servers/fixture-tool/test", (route) => route.fulfill({ json: ++toolTests === 1
      ? { ok: false, error: "Fixture tool test failed" }
      : { ok: true, tools: [{ name: "fixture_read" }] } }));
    await openApps(page);
    const apps = dialog(page).locator("[data-plugins-embedded]");
    const tools = dialog(page).locator("[data-mcp-embedded]");
    await expect(apps).toBeVisible();
    await expect(tools).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Close connected apps" })).toHaveCount(0);
    await expect(apps.getByText("Work", { exact: true })).toBeVisible();
    await apps.getByRole("tab", { name: "Marketplace", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    const connected = apps.getByRole("tab", { name: /^Connected/ });
    await expect(connected).toBeFocused();
    await expect(connected).toHaveAttribute("aria-selected", "true");
    const panelId = await connected.getAttribute("aria-controls");
    await expect(apps.locator(`[id="${panelId}"]`)).toBeVisible();
    await page.keyboard.press("Home");
    await expect(apps.getByRole("tab", { name: "Marketplace", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(connected).toBeFocused();
    const deleted = page.waitForRequest((request) => request.method() === "DELETE" && request.url().endsWith("/api/connectors/gmail/accounts/gmail-work"));
    page.once("dialog", (confirmation) => confirmation.accept());
    await apps.getByRole("button", { name: "Disconnect Work from Gmail", exact: true }).click();
    await deleted;
    await expect(apps.getByText("Work", { exact: true })).toHaveCount(0);
    await expect(apps.getByText("Personal", { exact: true })).toBeVisible();
    await apps.getByRole("tab", { name: "Marketplace", exact: true }).click();
    await expect(apps.getByText("Work", { exact: true })).toHaveCount(0);
    await expect(apps.getByText("Personal", { exact: true })).toBeVisible();
    await tools.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tools).toContainText("Fixture tool test failed");
    await tools.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tools).toContainText("fixture_read");
    await expect(tools.getByText("Off", { exact: true })).toBeVisible();
    expect(toolTests).toBe(2);
    await tools.getByRole("button", { name: "Add server", exact: true }).click();
    await tools.getByLabel("Paste a link, a command, or a short piece of settings text", { exact: true }).fill("npx -y @fixture/tool");
    await dialog(page).getByRole("tab", { name: "Messaging apps", exact: true }).click();
    await expect(tools).toBeHidden();
    await dialog(page).getByRole("tab", { name: "Apps", exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(tools.getByLabel("Paste a link, a command, or a short piece of settings text", { exact: true })).toHaveValue("npx -y @fixture/tool");
  });

  for (const mode of ["simple", "advanced"] as const) test(`Messaging apps shares the page body in ${mode} and preserves drafts across tabs`, async ({ page }) => {
    await mount(page, mode);
    await openApps(page);
    const apps = dialog(page).getByRole("tab", { name: "Apps", exact: true });
    await apps.focus();
    await page.keyboard.press("End");
    const messaging = dialog(page).getByRole("tab", { name: "Messaging apps", exact: true });
    await expect(messaging).toBeFocused();
    await expect(messaging).toHaveAttribute("aria-selected", "true");
    await expect(dialog(page).locator("[data-plugins-embedded]")).toBeHidden();
    const token = dialog(page).locator('[data-setting-control="telegram-settings-title"]');
    await token.fill("fixture-unsaved-token");
    for (const anchor of ["telegram-settings-title", "slack-settings-title", "discord-settings-title", "whatsapp-settings-title"]) await expect(dialog(page).locator(`#${anchor}`)).toBeVisible();
    await expect(dialog(page).locator("#slack-app-setup-heading")).toHaveCount(mode === "advanced" ? 1 : 0);
    await messaging.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(apps).toBeFocused();
    await expect(token).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(token).not.toBeFocused();
    await apps.focus();
    await page.keyboard.press("ArrowRight");
    await expect(token).toHaveValue("fixture-unsaved-token");
    await messaging.press("Home");
    await expect(apps).toBeFocused();
    await expect(dialog(page)).toBeVisible();
  });

  for (const surface of ["phone", "paired-browser", "cloud"] as const) test(`Apps retains account and email readouts on ${surface}`, async ({ page }) => {
    await page.setViewportSize({ width: surface === "phone" ? 390 : 1280, height: 844 });
    const mutations: string[] = [];
    const computerReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (/^\/api\/(connectors|email|mcp|highlevel)(\/|$)/.test(path) && request.method() !== "GET") mutations.push(path);
      if (/^\/api\/(mcp|highlevel)(\/|$)/.test(path)) computerReads.push(path);
    });
    await mount(page, "advanced", surface === "cloud" ? "cloud" : "remote");
    if (surface !== "cloud") await openApps(page);
    const body = dialog(page);
    const apps = body.locator("[data-plugins-embedded]");
    await apps.getByRole("tab", { name: /^Connected/ }).click();
    await expect(apps.getByText("Work", { exact: true })).toBeVisible();
    await expect(apps.getByText("Personal", { exact: true })).toBeVisible();
    await expect(apps.getByRole("button", { name: "Disconnect Work from Gmail", exact: true })).toBeDisabled();
    const email = body.getByTestId("bot-email-readout");
    await expect(email).toContainText("Bot email is on for this account.");
    await expect(email).toContainText("ada@example.test");
    await expect(email).toContainText("old@example.test");
    await expect(email).toContainText("2 of 10");
    await expect(email.getByRole("switch")).toHaveCount(0);
    for (const anchor of ["connections-heading", "bot-email-heading", "mcp-servers-heading", "highlevel-heading"]) await expect(body.getByTestId(`settings-stub-${anchor}`)).toBeVisible();
    await body.getByRole("tab", { name: "Messaging apps", exact: true }).click();
    await expect(body.getByTestId("settings-stub-telegram-settings-title")).toBeVisible();
    expect(mutations).toEqual([]);
    expect(computerReads).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
}
