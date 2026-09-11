// CTA1 (Sean 2026-09-11): the connected-apps panel is locked until a
// FluxRouter key or a Composio key of the person's own exists, and the lock
// sells what a key buys. The real PluginsPanel and SettingsModal render under
// the real store against a controlled fixture backend that counts every
// connector request. What is proven here and nowhere else: the locked panel
// sends nothing to the connector routes, the primary button lands the cursor
// in the Flux key field in Settings → Models, the secondary link lands it in
// the Composio key field, keyboard order starts at the primary and skips the
// showcase, a saved key flips the panel open without a reopen, and how it
// looks narrow and wide, light and dark.
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigStatus } from "../state/store";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

type Keys = "none" | "flux" | "composio";
let server: ViteDevServer, origin: string, cache: string;
let keys: Keys = "none";
let configDelayMs = 0;
let connectorHits: string[] = [];
let pageErrors: string[] = [];
const proof = "ab".repeat(32);

function configFor(which: Keys): ConfigStatus {
  return {
    composio: which === "composio" ? { configured: true, mode: "self-hosted" } : { configured: false, mode: "unavailable" },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 15 },
    localVm: { mode: "shared", maxInstances: 1 },
    flux: { configured: which === "flux" },
    profile: { name: "", email: "" },
  };
}
const CARDS = [
  { slug: "slack", label: "Slack", blurb: "Team chat", logo: null, domain: null },
  { slug: "github", label: "GitHub", blurb: "Code hosting", logo: null, domain: null },
];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-apps-lock-vite-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "apps-lock-fixture",
      resolveId(id) { if (id === "/__apps-lock.js") return "\0apps-lock-fixture"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== "\0apps-lock-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider,useStore} from '/src/state/store.tsx';import {PluginsPanel} from '/src/components/PluginsPanel.tsx';import {SettingsModal} from '/src/components/SettingsModal.tsx';import {focusSettingsField} from '/src/components/ConnectedAppsLock.tsx';import '/src/styles.css';
          const query=new URLSearchParams(location.search);document.documentElement.dataset.skin=query.get('skin')||'dark';
          window.focusSettingsField=focusSettingsField;
          function Fixture(){const store=useStore();window.fixtureStore=store;React.useEffect(()=>{store.dispatch({type:'togglePlugins',open:true});},[]);return React.createElement(React.Fragment,null,store.state.appSettingsOpen&&React.createElement(SettingsModal),store.state.pluginsOpen&&React.createElement(PluginsPanel));}
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Fixture)));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://fixture").pathname;
        const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (path.startsWith("/api/connectors")) connectorHits.push(`${req.method} ${path}`);
        if (path === "/__apps-lock") { res.setHeader("content-type", "text/html"); res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connected apps lock fixture</title></head><body style="margin:0;background:var(--color-app)"><div id="root"></div><script type="module" src="/__apps-lock.js"></script></body></html>'); }
        else if (path === "/api/desktop-secret") json({ secret: proof });
        else if (path === "/api/config" && req.method === "GET") setTimeout(() => json({ ...configFor(keys), surface: req.headers["x-murage-surface-secret"] === proof ? "desktop" : "remote" }), configDelayMs);
        else if (path === "/api/instances") json({ instances: [] });
        else if (path === "/api/bots") json({ bots: [], groups: [] });
        else if (path === "/api/flux-connection") json({ configured: keys === "flux", revision: "fixture", conflict: false, choices: [] });
        else if (path === "/api/provider-connections" && req.method === "GET") json({ connections: [], storage: "local-config" });
        else if (path === "/api/connectors/catalog") json({ cards: CARDS, source: "curated", configured: keys !== "none", mode: keys === "composio" ? "self-hosted" : keys === "flux" ? "managed" : "unavailable", broker: keys === "flux" ? "flux" : null, migration: { state: "none", legacyUntil: null }, fluxConfigured: keys === "flux", fluxBrokerEnabled: true, freeRunsRemainingToday: null });
        else if (path === "/api/connectors/connected") json({ configured: keys !== "none", credentialStore: "ok", services: {} });
        else if (path === "/api/connectors") json({ configured: keys !== "none", services: {} });
        else if (path.startsWith("/api/") && !["GET", "HEAD"].includes(req.method ?? "GET")) json({ error: "Unexpected fixture write" }, 409);
        else if (path.startsWith("/api/")) json({ error: "Unused fixture read" }, 404);
        else next();
      }); },
    }],
  });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(async ({ page }) => { keys = "none"; configDelayMs = 0; connectorHits = []; pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message)); await page.route("https://**/*", (route) => route.abort()); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

async function open(page: Page, { which = "none" as Keys, skin = "dark", width = 1100 } = {}) {
  keys = which;
  await page.setViewportSize({ width, height: 860 });
  await page.goto(`${origin}/__apps-lock?skin=${skin}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog", { name: "Plugins" })).toBeVisible();
}
const lock = (page: Page) => page.locator("[data-connected-apps-lock]");
const primary = (page: Page) => page.getByRole("button", { name: "Add FluxRouter key", exact: true });
const settle = (page: Page) => page.waitForTimeout(600);

for (const [skin, width] of [["dark", 1100], ["light", 1100], ["dark", 390], ["light", 390]] as const) test(`locked with no key: the offer over a dimmed showcase, and not one connector request (${skin}, ${width}px)`, async ({ page }, info) => {
  await open(page, { skin, width });
  await expect(lock(page)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect 500+ apps", exact: true })).toBeVisible();
  await expect(page.getByText("Gmail, Slack, Notion, GitHub, Google Calendar and 500+ more — your bots can use them all. Add your FluxRouter key to unlock, with a free daily allowance included.", { exact: true })).toBeVisible();
  await expect(primary(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Have your own Composio key? Add it under Advanced.", exact: true })).toBeVisible();
  // The live panel's controls are not there to be found.
  await expect(page.getByRole("textbox", { name: "Search apps" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Marketplace" })).toHaveCount(0);
  await expect(page.getByTitle("Refresh connection status")).toHaveCount(0);
  // The showcase: painted, hidden from assistive tech, inert, no pointer.
  const showcase = lock(page).locator("[aria-hidden='true'][inert]");
  await expect(showcase).toHaveCount(1);
  await expect(showcase.getByText("Gmail", { exact: true })).toHaveCount(1);
  await expect(showcase.getByText("Todoist", { exact: true })).toHaveCount(1);
  expect(await showcase.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  expect(await showcase.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeLessThan(0.5);
  // Nothing behind the glass is an image or a link: no request could leave it.
  await expect(showcase.locator("img, a, button, input")).toHaveCount(0);
  // One headline, one line, one primary action.
  await expect(lock(page).getByRole("heading")).toHaveCount(1);
  await expect(lock(page).locator("[data-connected-apps-lock-primary]")).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await settle(page);
  expect(connectorHits).toEqual([]);
  await page.screenshot({ path: info.outputPath(`locked-${skin}-${width}.png`) });
});

test("keyboard: the offer's button is the first tab stop and the showcase is skipped", async ({ page }) => {
  await open(page);
  await expect(primary(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Have your own Composio key? Add it under Advanced.", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  // Wrapped inside the dialog: the next stop is the dialog's first control,
  // never anything inside the showcase.
  const focusedInsideShowcase = () => page.evaluate(() => Boolean(document.activeElement?.closest("[data-connected-apps-lock] [aria-hidden='true']")));
  expect(await focusedInsideShowcase()).toBe(false);
  await expect(page.getByRole("button", { name: "Close plugins", exact: true })).toBeFocused();
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); expect(await focusedInsideShowcase()).toBe(false); }
  expect(connectorHits).toEqual([]);
});

test("the button opens Settings → Models with the cursor in the Flux key field", async ({ page }, info) => {
  await open(page);
  await primary(page).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Plugins" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Flux Router", exact: true })).toBeVisible();
  const field = page.getByLabel("Flux Router key", { exact: true });
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => (window as any).fixtureStore.state.appSettingsSection)).toBe("models");
  await page.screenshot({ path: info.outputPath("after-add-key-models.png") });
  expect(connectorHits).toEqual([]);
});

test("the link opens Tools & Connections with the cursor in the Composio key field", async ({ page }, info) => {
  await open(page);
  await page.getByRole("button", { name: "Have your own Composio key? Add it under Advanced.", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  const field = page.getByLabel("Composio project key", { exact: true });
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();
  expect(await page.evaluate(() => (window as any).fixtureStore.state.appSettingsSection)).toBe("connections");
  await page.screenshot({ path: info.outputPath("after-own-key-connections.png") });
  expect(connectorHits).toEqual([]);
});

test("a late config answer holds the panel, fetches nothing, then locks", async ({ page }) => {
  configDelayMs = 1500;
  await open(page);
  await expect(page.getByText("Checking your connected-apps setup…", { exact: true })).toBeVisible();
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search apps" })).toHaveCount(0);
  expect(connectorHits).toEqual([]);
  await expect(lock(page)).toBeVisible({ timeout: 10_000 });
  await expect(primary(page)).toBeFocused();
  await settle(page);
  expect(connectorHits).toEqual([]);
});

for (const which of ["flux", "composio"] as const) test(`with a ${which} key the panel is the normal one and loads the catalog`, async ({ page }, info) => {
  await open(page, { which });
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search apps" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search apps" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Marketplace" })).toBeVisible();
  await expect(page.getByTitle("Refresh connection status")).toBeVisible();
  await expect(page.locator('[data-connector-action="slack"]')).toBeVisible();
  await expect.poll(() => connectorHits).toContain("GET /api/connectors/catalog");
  expect(connectorHits).toContain("GET /api/connectors/connected");
  if (which === "composio") await expect(page.getByText("Connected with your own Composio key.", { exact: false })).toBeVisible();
  await page.screenshot({ path: info.outputPath(`unlocked-${which}.png`) });
});

test("saving a key flips the locked panel open without a reopen", async ({ page }) => {
  await open(page);
  await expect(lock(page)).toBeVisible();
  await settle(page);
  expect(connectorHits).toEqual([]);
  // What the config frame does after a save: the store learns the key exists.
  keys = "flux";
  await page.evaluate((config) => (window as any).fixtureStore.dispatch({ type: "configStatus", config }), configFor("flux"));
  await expect(lock(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Search apps" })).toBeVisible();
  await expect.poll(() => connectorHits).toContain("GET /api/connectors/catalog");
});

test("focusSettingsField waits for a field that is still disabled", async ({ page }) => {
  await open(page, { which: "flux" });
  const focused = await page.evaluate(async () => {
    const input = document.createElement("input");
    input.name = "flux-router-key";
    input.disabled = true;
    document.body.append(input);
    const win = window as any;
    win.focusSettingsField('input[name="flux-router-key"]:not([disabled])');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = document.activeElement === input;
    input.disabled = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = document.activeElement === input;
    input.remove();
    return { before, after };
  });
  expect(focused).toEqual({ before: false, after: true });
});
