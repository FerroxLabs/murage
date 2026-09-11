import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../../server/testing/ports";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import type { ConnectorStatus } from "../components/PluginsPanel";

let server: ViteDevServer;
let origin: string;
let cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-capabilities-vite-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "desktop-capability-fixture", enforce: "pre",
      resolveId(id) {
        if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0fixture-store";
        if (id === "/__capabilities.js") return "\0fixture-capabilities";
      },
      load(id) {
        if (id === "\0fixture-store") return `
          export * from '/src/state/store.tsx?original';
          import { useSyncExternalStore } from 'react';
          export function useStore() { return useSyncExternalStore(window.subscribeFixture, () => window.fixtureStore); }
        `;
        if (id !== "\0fixture-capabilities") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { api } from '/src/state/store.tsx?original';
          import '/src/styles.css';
          window.dispatched = [];
          const listeners = new Set();
          window.subscribeFixture = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
          const bot = { id:'bot-a', name:'Fixture bot', color:'blue', modelSelection:{instanceId:'fixture',model:'fixture'}, threadId:'thread-a', tasks:[], description:'', title:'' };
          const at = Date.now() + 3600000;
          const routine = { id:'routine-a', name:'Fixture routine', botId:bot.id, prompt:'Fixture instructions', enabled:true, schedule:{type:'once',at}, durationMinutes:30, runOn:'ember', createdAt:1, updatedAt:1, nextRunAt:at };
          const state = { config:{ profile:{name:'Fixture name',email:'fixture@example.com'}, composio:{mode:'unavailable',configured:false}, features:{}, browserProfiles:[], rooms:{turnTimeoutMinutes:5} }, bots:[bot], groups:[], routines:[routine], routineRuns:[], webhooks:[], appSettingsSection:'general', instances:[{instanceId:'engine-fixture',driverKind:'claudeAgent',displayName:'Fixture engine',enabled:false,snapshot:{state:'unavailable',reason:'disabled'},models:{default:'',options:[]}}] };
          async function refreshInstances() {
            const response = await api('/api/instances');
            state.instances = response.instances;
            dispatch({type:'fixture-refresh'});
          }
          function dispatch(action) {
            window.dispatched.push(action);
            if (action.type === 'configStatus') state.config = action.config;
            window.fixtureStore = { state: {...state}, dispatch, refreshInstances };
            listeners.forEach(fn => fn());
          }
          window.fixtureStore = {state,dispatch,refreshInstances};
          const which = new URL(location.href).searchParams.get('component');
          // CTA1: the connected-apps panel is locked until a key exists; the OAuth fixtures run on the person's own Composio key.
          if (new URL(location.href).searchParams.get('composio') === 'own') state.config.composio = {mode:'self-hosted',configured:true};
          if (which === 'engines-api') state.instances[0].driverKind = 'openai-compat';
          let element;
          if (which === 'engines' || which === 'engines-api') {
            const { EnginesSettings } = await import('/src/components/EnginesSettings.tsx');
            element = React.createElement(EnginesSettings);
          } else if (which === 'settings') {
            const { SettingsModal } = await import('/src/components/SettingsModal.tsx');
            element = React.createElement(SettingsModal);
          } else if (which === 'plugins') {
            const { PluginsPanel } = await import('/src/components/PluginsPanel.tsx');
            element = React.createElement(PluginsPanel);
          } else if (which === 'inspector') {
            const { InspectorPanel } = await import('/src/components/InspectorPanel.tsx');
            element = React.createElement(InspectorPanel,{bot});
          } else if (which === 'approval' || which.startsWith('routine-')) {
            const { PendingApprovalActions, PendingApprovalPanel } = await import('/src/components/PendingApproval.tsx');
            const card = {title:'Review command',subtitle:'git status',tool:'Bash',requestId:'request-a',options:['Allow','Deny']};
            if (which.startsWith('routine-')) {
              card.routineRequest = {version:1,requestId:'request-a',botId:'bot-a',threadId:'thread-a',createdAt:1,operation:{action:'create',routine:{name:'Review routine',instructions:'Fixture only',schedule:{type:'daily',time:'09:00',weekdays:[1]},runOn:'ember',durationMinutes:30}}};
              if (which === 'routine-ready') card.routineProposalDigest = 'a'.repeat(64);
              if (which === 'routine-invalid') card.routineProposalDigest = 'incorrect';
            }
            const pending = {requestId:'request-a',tool:card.tool,allowKey:'Bash:git',detail:card.subtitle,message:{id:'message-a',role:'bot',kind:'options',at:1,card}};
            element = React.createElement(React.Fragment,{},React.createElement(PendingApprovalPanel,{pending,count:1,index:0}),React.createElement(PendingApprovalActions,{bot,threadId:'thread-a',onCancelTurn:()=>{},pending}));
          } else {
            const { RoutinesPage } = await import('/src/components/RoutineCalendarPage.tsx');
            element = React.createElement(RoutinesPage,{onBack:()=>{},onOpenRoom:()=>{}});
          }
          createRoot(document.getElementById('root')).render(element);
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/__capabilities?")) return next();
          res.setHeader("content-type", "text/html");
          res.end('<div id="root"></div><script type="module" src="/__capabilities.js"></script>');
        });
      },
    }],
  });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { await server?.close(); if (cache) rmSync(cache, { recursive: true, force: true }); });

async function mount(page: Page, component: string, desktop = false, { claudeAccounts = { accounts: [] } as unknown } = {}) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/desktop-secret") return route.fulfill({ json: { secret: "fixture-proof" } });
    // Engines settings list Claude accounts (538629bc). The server answers
    // { accounts } on the desktop and 404 elsewhere (server/index.ts).
    if (path === "/api/claude-accounts") return desktop
      ? route.fulfill({ json: claudeAccounts })
      : route.fulfill({ status: 404, json: { error: "no such route" } });
    if (path === "/api/config") return route.fulfill({ json: { surface: desktop ? "desktop" : "remote", profile: { name: "Fixture name", email: "fixture@example.com" } } });
    if (path === "/api/connectors/catalog") return route.fulfill({ json: { cards: [], configured: false, mode: "unavailable" } });
    if (path === "/api/connectors/connected") return route.fulfill({ json: { services: {} } });
    if (path === "/api/mcp/servers") return route.fulfill({ json: { servers: [] } });
    return route.fulfill({ json: { calls: [] } });
  });
  await page.goto(`${origin}/__capabilities?component=${component}`);
}

async function mountPendingOAuth(page: Page, initial: ConnectorStatus) {
  const fixture = {
    service: initial,
    unreadable: false,
    statusReads: 0,
    authorizations: 0,
    aliases: [] as unknown[],
    url: "https://oauth.example.invalid/fixture-existing-account",
  };
  await page.addInitScript(() => {
    const opened: string[] = [];
    Object.defineProperty(window, "pendingOAuthOpened", { value: opened });
    Object.defineProperty(window, "muragebox", {
      value: { openExternal: async (url: string) => { opened.push(url); } },
    });
  });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/desktop-secret") return route.fulfill({ json: { secret: "fixture-proof" } });
    if (url.pathname === "/api/config") return route.fulfill({ json: { surface: "desktop" } });
    if (url.pathname === "/api/connectors/catalog") return route.fulfill({ json: {
      configured: true, mode: "self-hosted", source: "api",
      cards: [{ slug: "gmail", label: "Gmail", blurb: "Fixture mail", logo: null, domain: null }],
    } });
    if (url.pathname === "/api/connectors/gmail/authorize") {
      fixture.authorizations++;
      const body = route.request().postData();
      fixture.aliases.push(body ? JSON.parse(body).alias : undefined);
      return route.fulfill({ json: { url: fixture.url } });
    }
    if (url.pathname === "/api/connectors" || url.pathname === "/api/connectors/connected") {
      if (url.pathname === "/api/connectors") {
        fixture.statusReads++;
        expect(url.searchParams.get("services")).toBe("gmail");
      }
      return route.fulfill({ json: {
        credentialStore: fixture.unreadable ? "unavailable" : "ok",
        services: fixture.unreadable ? {} : { gmail: fixture.service },
      } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__capabilities?component=plugins&composio=own`);
  await expect(page.getByRole("dialog", { name: "Plugins", exact: true })).toBeVisible();
  return fixture;
}

test("Inspector marks bounded counts as incomplete without hiding recent records", async ({ page }, testInfo) => {
  let fullyCounted = false;
  await page.setViewportSize({ width: 390, height: 760 });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/desktop-secret") return route.fulfill({ json: { secret: "fixture-proof" } });
    if (path === "/api/config") return route.fulfill({ json: { surface: "desktop" } });
    if (path === "/api/events") return route.fulfill({ status: 204, body: "" });
    if (path === "/api/threads/thread-a/events") return route.fulfill({ json: {
      entries: [
        { kind: "runtime", at: "2026-09-06T00:00:00Z", data: {
          eventId: "fixture-event", provider: "claudeAgent", threadId: "thread-a",
          createdAt: "2026-09-06T00:00:00Z", type: "turn.started", turnId: "fixture-turn",
        } },
        { kind: "native", at: "2026-09-06T00:00:00Z", data: {
          at: "2026-09-06T00:00:00Z", dir: "out", source: "fixture", msg: { method: "initialize" },
        } },
      ],
      total: { runtime: 999, native: 1 }, totalComplete: { runtime: fullyCounted, native: true },
    } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__capabilities?component=inspector`);
  const notice = page.getByText("1 recent records; total not fully counted", { exact: true });
  await expect(notice).toBeVisible();
  await expect(page.getByText("turn started · fixture-", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("inspector-incomplete-count.png") });
  await page.getByRole("button", { name: "raw", exact: true }).click();
  await expect(page.getByText("1 entries", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "events", exact: true }).click();
  await expect(notice).toBeVisible();
  fullyCounted = true;
  await page.getByTitle("Reload from disk").click();
  await expect(page.getByText("last 1 of 999", { exact: true })).toBeVisible();
});

const pendingOAuthAccounts: ConnectorStatus = {
  connected: true, pending: true, status: "INITIATED",
  accounts: [
    { id: "fixture-active", alias: "work", status: "ACTIVE" },
    { id: "fixture-pending", alias: "personal", status: "INITIATED" },
  ],
};

test("pending OAuth without a cached URL checks and polls without authorizing another account", async ({ page }, testInfo) => {
  await page.clock.install();
  const fixture = await mountPendingOAuth(page, pendingOAuthAccounts);
  const check = page.getByRole("button", { name: "Check status", exact: true });
  await expect(check).toBeEnabled();
  await expect(page.getByText("Finish setup in your browser, or disconnect the pending account below to start again", { exact: true })).toBeVisible();
  for (let count = 1; count <= 3; count++) {
    await check.click();
    await expect.poll(() => fixture.statusReads).toBe(count);
  }
  await expect(page.getByRole("textbox", { name: "Label for another Gmail account" })).toHaveCount(0);
  expect(fixture.authorizations).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("pending-oauth-check-status.png") });
  fixture.service = { ...pendingOAuthAccounts, pending: false, status: "ACTIVE", accounts: pendingOAuthAccounts.accounts!.map(account => ({ ...account, status: "ACTIVE" })) };
  await page.clock.fastForward(5_000);
  await expect(page.getByRole("button", { name: "Add account", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect work from Gmail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect personal from Gmail" })).toBeVisible();
  const finalReads = fixture.statusReads;
  await page.clock.fastForward(10_000);
  expect(fixture.statusReads).toBe(finalReads);
  expect(fixture.authorizations).toBe(0);
});

test("pending OAuth Continue reopens the cached URL without creating another account", async ({ page }, testInfo) => {
  const fixture = await mountPendingOAuth(page, { connected: false, pending: false, accounts: [] });
  // a73d3346 (F3-T4, OpenMausBot #758): Connect labels the first account
  // before any authorization starts; the form's Continue is what authorizes.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const label = page.getByRole("textbox", { name: "Label for the new Gmail account", exact: true });
  await expect(label).toBeFocused();
  expect(fixture.authorizations).toBe(0);
  await label.fill("work");
  await page.screenshot({ path: testInfo.outputPath("pending-oauth-label.png") });
  await page.locator("form").getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => page.evaluate("window.pendingOAuthOpened")).toEqual([fixture.url]);
  await expect(label).toHaveCount(0);
  const resume = page.getByRole("button", { name: "Continue", exact: true });
  await expect(resume).toBeEnabled();
  await expect(page.getByText("Finish setup in your browser", { exact: true })).toBeVisible();
  await resume.click();
  await resume.click();
  await expect.poll(() => page.evaluate("window.pendingOAuthOpened")).toEqual([fixture.url, fixture.url, fixture.url]);
  expect(fixture.authorizations).toBe(1);
  expect(fixture.aliases).toEqual(["work"]);
  await expect(page.getByRole("textbox", { name: "Label for the new Gmail account" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Label for another Gmail account" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("pending-oauth-continue.png") });
});

test("pending OAuth hides an open alias form and preserves accounts when status is unreadable", async ({ page }, testInfo) => {
  const fixture = await mountPendingOAuth(page, { connected: true, pending: false, status: "ACTIVE", accounts: [pendingOAuthAccounts.accounts![0]] });
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const alias = page.getByRole("textbox", { name: "Label for another Gmail account" });
  await expect(alias).toBeVisible();
  fixture.service = pendingOAuthAccounts;
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  await expect(alias).toHaveCount(0);
  fixture.unreadable = true;
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("credential store is unavailable");
  await expect(page.getByRole("button", { name: "Unavailable", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Disconnect work from Gmail" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect personal from Gmail" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh connection status" }).click();
  await expect(page.getByText("Showing the previous account inventory", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unavailable", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Disconnect work from Gmail" })).toBeVisible();
  expect(fixture.authorizations).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("pending-oauth-unreadable.png") });
});

for (const terminal of ["EXPIRED", "FAILED"]) {
  test(`pending OAuth ${terminal.toLowerCase()} reports the terminal status and stops polling`, async ({ page }) => {
    await page.clock.install();
    const fixture = await mountPendingOAuth(page, { connected: false, pending: true, status: "INITIATED", accounts: [] });
    await page.getByRole("button", { name: "Check status", exact: true }).click();
    await expect.poll(() => fixture.statusReads).toBe(1);
    fixture.service = { connected: false, pending: false, status: terminal, accounts: [] };
    await page.clock.fastForward(5_000);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
    await expect(page.getByText(`Authorization ${terminal.toLowerCase()} — try again`, { exact: true })).toBeVisible();
    const finalReads = fixture.statusReads;
    await page.clock.fastForward(10_000);
    expect(fixture.statusReads).toBe(finalReads);
    expect(fixture.authorizations).toBe(0);
  });
}

test("remote approvals retain once and deny without persistent grants", async ({ page }) => {
  await mount(page, "approval");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Always allow", exact: true })).toHaveCount(0);
});

test("engine enablement requires confirmation, stays pending, then reflects verified status", async ({ page }, testInfo) => {
  await mount(page, "engines-api", true);
  let writes = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const enabled = { instanceId:"engine-fixture", driverKind:"openai-compat", displayName:"Fixture engine", enabled:true, snapshot:{state:"available"}, models:{default:"",options:[]} };
  await page.route("**/api/instances/engine-fixture", async route => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ enabled: true });
    await gate;
    await route.fulfill({ json: { instances: [enabled] } });
  });
  await page.route("**/api/instances", route => route.fulfill({ json: { instances: [enabled] } }));
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toBe(0);
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await page.getByRole("button", { name: "Confirm enable", exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  await expect(page.getByRole("button", { name: "Saving...", exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath("engine-enable-pending.png") });
  release();
  await expect(page.getByRole("status")).toHaveText("Engine enabled.");
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set CLI…", exact: true })).toHaveCount(0);
  expect(writes).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("engine-enabled.png") });
});

test("engine enablement failure stays actionable without claiming success", async ({ page }, testInfo) => {
  await mount(page, "engines", true);
  await page.route("**/api/instances/engine-fixture", route => route.fulfill({ status: 409, json: { error: "Provider settings are busy. Try again." } }));
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await page.getByRole("button", { name: "Confirm enable", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Provider settings are busy. Try again.");
  await expect(page.getByRole("button", { name: "Confirm enable", exact: true })).toBeEnabled();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("engine-enable-failed.png") });
});

test("engine settings stay usable when the Claude account list cannot be read", async ({ page }, testInfo) => {
  // Before RED2F this body blanked the whole page: ClaudeAccountsSettings threw
  // on an undefined list and the Enable button detached under the click.
  await mount(page, "engines", true, { claudeAccounts: { error: "Unexpected success body" } });
  await expect(page.getByRole("alert")).toHaveText("Could not read the Claude account list. Use Refresh accounts to try again.");
  await expect(page.getByRole("button", { name: "Refresh accounts", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm enable", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("engine-accounts-unreadable.png") });
});

test("remote Plugins omits the unavailable MCP tab", async ({ page }) => {
  await mount(page, "plugins");
  await expect(page.getByRole("dialog", { name: "Plugins", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "MCP servers" })).toHaveCount(0);
});

test("remote profile is readable and does not submit a configuration write", async ({ page }) => {
  let writes = 0;
  await mount(page, "settings");
  await page.route("**/api/config", (route) => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({ json: { surface: "remote", profile: { name: "Fixture name", email: "fixture@example.com" } } });
  });
  const name = page.getByPlaceholder("Your name");
  await expect(name).toHaveValue("Fixture name");
  await expect(name).toHaveAttribute("readonly", "");
  await name.focus();
  await name.blur();
  expect(writes).toBe(0);
});

test("remote calendar preserves Run now while hiding schedule administration", async ({ page }, testInfo) => {
  await mount(page, "calendar");
  await expect(page.getByRole("heading", { name: "Calendar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create event", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-event-card]").first()).toHaveAttribute("draggable", "false");
  await page.keyboard.press("c");
  await expect(page.getByPlaceholder("Add title")).toHaveCount(0);
  await page.locator("[data-event-card]").first().click();
  const details = page.getByRole("dialog", { name: "Calendar event details" });
  await expect(details.getByRole("button", { name: "Run now", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Pause routine" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  for (const skin of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.dataset.skin = value, skin);
    await page.screenshot({ path: testInfo.outputPath(`remote-calendar-${skin}.png`) });
  }
});

test("desktop profile reports pending, failed and successful saves without dispatching error JSON", async ({ page }, testInfo) => {
  await mount(page, "settings", true);
  const name = page.getByPlaceholder("Your name");
  await expect(name).toBeEditable();
  let release!: () => void;
  let writes = 0;
  let proof = "";
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { surface: "desktop" } });
    writes++;
    proof = route.request().headers()["x-murage-surface-secret"] ?? "";
    if (writes === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      return route.fulfill({ status: 503, json: { error: "Fixture save unavailable" } });
    }
    return route.fulfill({ json: { profile: { name: "Edited profile", email: "fixture@example.com" }, composio: { mode: "unavailable", configured: false }, rooms: { turnTimeoutMinutes: 5 }, features: {} } });
  });
  await name.fill("Edited profile");
  await name.blur();
  await expect(page.getByRole("status").filter({ hasText: "Saving" })).toBeVisible();
  release();
  await expect(page.getByRole("alert").filter({ hasText: "Fixture save unavailable" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("desktop-profile-error.png") });
  expect(await page.evaluate("window.dispatched.filter(action => action.type === 'configStatus')")).toEqual([]);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  expect(proof).toBe("fixture-proof");
  expect(writes).toBe(2);
  expect(await page.evaluate("window.dispatched.filter(action => action.type === 'configStatus').map(action => action.config.profile.name)")).toEqual(["Edited profile"]);
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("desktop-profile-saved.png") });
});

test("confirmed desktop retains persistent approvals, MCP and routine editing", async ({ page }) => {
  await mount(page, "approval", true);
  await page.getByRole("button", { name: "Always allow", exact: true }).click();
  expect(await page.evaluate("window.dispatched.find(action => action.type === 'decideRequest').alwaysAllow")).toEqual({ botId: "bot-a", key: "Bash:git" });
  await mount(page, "plugins", true);
  await page.getByRole("tab", { name: "MCP servers" }).click();
  await expect(page.getByRole("tab", { name: "MCP servers" })).toHaveAttribute("aria-selected", "true");
  await mount(page, "calendar", true);
  await expect(page.getByRole("button", { name: /^Create(?: event)?$/ })).toBeVisible();
  await page.locator("[data-event-card]").first().click();
  const details = page.getByRole("dialog", { name: "Calendar event details" });
  await expect(details.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Pause routine" })).toBeVisible();
  await expect(details.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
});

test("desktop profile rejects malformed success payloads", async ({ page }) => {
  await mount(page, "settings", true);
  const name = page.getByPlaceholder("Your name");
  await expect(name).toBeEditable();
  await page.route("**/api/config", (route) => route.fulfill({ json: { error: "Unexpected success body" } }));
  await name.fill("Keep this draft");
  await name.blur();
  await expect(page.getByRole("alert")).toContainText("profile save could not be confirmed");
  await expect(name).toHaveValue("Keep this draft");
  expect(await page.evaluate("window.dispatched.filter(action => action.type === 'configStatus')")).toEqual([]);
});

test("desktop routine pause reports API failure and retains the event", async ({ page }) => {
  await mount(page, "calendar", true);
  await page.locator("[data-event-card]").first().click();
  const details = page.getByRole("dialog", { name: "Calendar event details" });
  await page.route("**/api/routines/routine-a", (route) => route.fulfill({ status: 503, json: { error: "Fixture pause unavailable" } }));
  await details.getByRole("button", { name: "Pause routine" }).click();
  await expect(details.getByRole("alert")).toHaveText("Fixture pause unavailable");
  await expect(details.getByRole("button", { name: "Pause routine" })).toBeEnabled();
  expect(await page.evaluate("window.dispatched.filter(action => action.type === 'routinePatched')")).toEqual([]);
});

for (const variant of ["legacy", "invalid", "ready"]) {
  test(`remote routine ${variant} card keeps the appropriate confirmation choices`, async ({ page }) => {
    await mount(page, `routine-${variant}`);
    const confirm = page.getByRole("button", { name: "Confirm", exact: true });
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toBeEnabled();
    if (variant === "ready") {
      await expect(confirm).toBeEnabled();
      await confirm.click();
      expect(await page.evaluate("window.dispatched.at(-1).behavior")).toBe("allow");
    } else {
      await expect(confirm).toBeDisabled();
      await expect(page.getByText("This older routine request needs a fresh review.", { exact: false })).toBeVisible();
      await cancel.click();
      expect(await page.evaluate("window.dispatched.at(-1).behavior")).toBe("deny");
    }
  });
}
