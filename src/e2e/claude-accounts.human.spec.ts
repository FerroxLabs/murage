import { expect, test as base } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeAccount } from "../components/ClaudeAccountsSettings";

type Fixture = { info: { url: string; dataDir: string }; fixtureDumpPath: string; close(): Promise<void> };
let fixture: Fixture, vite: ViteDevServer | undefined, origin: string, headers: Record<string, string>;
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
}
async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const response = await request(path, method, body); expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true); return response.json();
}
async function launch() {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href) as { launchVerificationServer(): Promise<Fixture> };
  fixture = await launchVerificationServer(); vite = undefined;
  try {
    const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
    const root = fileURLToPath(new URL("../../", import.meta.url));
    // `?component=engines` mounts the real EnginesSettings (the section under
    // every Claude engine row, onChanged={refreshInstances}) over a store whose
    // refreshInstances is the real GET /api/instances against this harness.
    const ui = vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "accounts-vite"), resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", hmr: false, watch: null, proxy: { "/api": { target: fixture.info.url, headers } } }, plugins: [react(), tailwindcss(), {
      name: "accounts-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__accounts.js") return "\0accounts-fixture"; if (id === "@/state/store" || id.endsWith("/src/state/store")) return "\0accounts-store"; },
      load(id) {
        if (id === "\0accounts-store") return `export * from '/src/state/store.tsx?original';import {useSyncExternalStore} from 'react';export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore)}`;
        if (id !== "\0accounts-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {api} from '/src/state/store.tsx?original';import {ClaudeAccountsSettings} from '/src/components/ClaudeAccountsSettings.tsx';import '/src/styles.css';
document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'light';window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.copied.push(value)},configurable:true});
const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};window.dispatched=[];window.fleetRefreshes=0;
const state={config:{profile:{name:'Fixture',email:'fixture@example.com'},composio:{mode:'unavailable',configured:false},features:{},browserProfiles:[],rooms:{turnTimeoutMinutes:5}},bots:[],groups:[],routines:[],routineRuns:[],webhooks:[],appSettingsSection:'general',instances:[]};
const publish=()=>{window.fixtureStore={state:{...state},dispatch,refreshInstances,flushBotPatches:async()=>{}};listeners.forEach(fn=>fn())};
function dispatch(action){window.dispatched.push(action);publish()}
async function refreshInstances(){window.fleetRefreshes++;const {instances}=await api('/api/instances');state.instances=instances;publish()}
publish();
let element=React.createElement(ClaudeAccountsSettings);
if(new URLSearchParams(location.search).get('component')==='engines'){await refreshInstances();const {EnginesSettings}=await import('/src/components/EnginesSettings.tsx');element=React.createElement(EnginesSettings)}
createRoot(document.getElementById('root')).render(element);`; },
      configureServer(server) { server.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/__accounts?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:760px;height:calc(100dvh - 48px);overflow-y:auto;margin:24px auto;padding:16px"></main><script type="module" src="/__accounts.js"></script>'); }); },
    }] });
    await ui.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0); const address = ui.httpServer!.address(); if (!address || typeof address === "string") throw Error("Accounts UI fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
}
// Each test owns a fresh verification server and UI fixture. One beforeAll
// server let the held-refresh test see the CRUD test's "Work renamed" account
// and its bound bot, so one test's outcome or order changed what the next saw
// (CLAC1 verifier, CLAC2). The setup keeps its own budget, as beforeAll had.
const test = base.extend<{ isolatedAccounts: void }>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright reads fixture dependencies from this destructuring
  isolatedAccounts: [async ({}, use) => {
    await launch();
    try { await use(); } finally { try { await vite?.close(); } finally { await fixture.close(); } }
  }, { auto: true, timeout: 60_000 }],
});
/** Isolation proof: every test starts with no named account on its own server. */
async function expectNoNamedAccounts() {
  expect(((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).filter(account => account.managed || account.displayName !== "Verification fixture")).toEqual([]);
}

test("owner account CRUD preserves credentials, selected identity and active work", async ({ page }, info) => {
  expect((await fetch(fixture.info.url + "/api/claude-accounts")).status).toBe(404);
  await expectNoNamedAccounts();
  await page.goto(origin + "/__accounts?skin=" + (info.project.name === "narrow" ? "dark" : "light"));
  await expect(page.getByText("Verification fixture", { exact: true })).toBeVisible();
  for (const name of ["Work", "Personal"]) {
    await page.getByRole("button", { name: "Add Claude account", exact: true }).click();
    await page.getByLabel("Account name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Sign in explicitly");
  }
  const list = (await api("/api/claude-accounts")).accounts as ClaudeAccount[];
  const work = list.find(account => account.displayName === "Work")!, personal = list.find(account => account.displayName === "Personal")!;
  expect(work.configDir).not.toBe(personal.configDir);
  const roster = (await api("/api/instances")).instances;
  expect(roster.find((entry: any) => entry.instanceId === work.instanceId).install.signInCommand).toBe(work.signInCommand);
  expect((await api("/api/engine-setup-command", "POST", { instanceId: work.instanceId, action: "connect" })).command).toBe(work.signInCommand);
  expect((await api("/api/engine-setup-command", "POST", { instanceId: "verification", action: "connect" })).command).toBe("claude");
  await page.getByText("Sign-in instructions for Work", { exact: true }).click();
  await page.getByRole("button", { name: "Copy sign-in command for Work", exact: true }).click();
  expect(await page.evaluate(() => (window as any).copied)).toEqual([work.signInCommand]);
  expect(work.signInCommand).toContain("auth");
  const bot = (await api("/api/bots", "POST", { name: "Account selection proof", modelSelection: { instanceId: work.instanceId, model: "sonnet" } })).bot;
  expect(bot.modelSelection.instanceId).toBe(work.instanceId);
  await page.getByRole("button", { name: "Edit Work account", exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill("Work renamed");
  await page.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByText("Work renamed", { exact: true })).toBeVisible();
  expect((await request("/api/claude-accounts", "POST", { displayName: "Alias", configDir: work.configDir })).status).toBe(409);
  expect((await request(`/api/claude-accounts/${work.instanceId}`, "DELETE")).status).toBe(409);
  await api(`/api/bots/${bot.id}/messages`, "POST", { text: "__fixture_hold_authority__", threadId: bot.threadId });
  await expect.poll(() => { try { return JSON.stringify(JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).prompt).includes("__fixture_hold_authority__"); } catch { return false; } }, { timeout: 15000 }).toBe(true);
  const pid = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).pid as number;
  const rejected = await request("/api/claude-accounts", "POST", { displayName: "Must wait" }); expect(rejected.status).toBe(409);
  process.kill(pid, 0);
  await api(`/api/bots/${bot.id}/interrupt`, "POST", { threadId: bot.threadId });
  await expect.poll(async () => Boolean((await api("/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).busy)).toBe(false);
  mkdirSync(personal.configDir, { recursive: true }); const marker = join(personal.configDir, "synthetic-credential-marker"); writeFileSync(marker, "preserve-original");
  await page.getByRole("button", { name: "Remove Personal account", exact: true }).click();
  await expect(page.getByText(/does not revoke its login or delete credential files/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm removal of Personal", exact: true }).click();
  await expect(page.locator(`[data-claude-account="${personal.instanceId}"]`)).toHaveCount(0);
  expect(readFileSync(marker, "utf8")).toBe("preserve-original");
  expect((await api("/api/bots?messages=0")).bots.find((entry: any) => entry.id === bot.id).modelSelection.instanceId).toBe(work.instanceId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("accounts-" + info.project.name + ".png"), fullPage: true });
});

// POST/PATCH already answer with the account after a full engine probe, yet the
// section used to wait for a second full probe (GET re-runs every engine's
// snapshot) before drawing the change. On a loaded machine that GET outlived
// the create: "Account added. Sign in explicitly below" pointed at a row that
// was not there (CLAC1, RED2F verifier trace: POST 3.5 s, GET still pending
// after 5 s). Holding that GET makes the wait deterministic instead of load-bound.
test("a created, renamed or removed account shows before the engine re-probe answers", async ({ page }, info) => {
  let gate: Promise<void> | undefined, open = () => {}, held = 0;
  await page.route(url => url.pathname === "/api/claude-accounts", async route => {
    if (route.request().method() === "GET" && gate) { held++; await gate; }
    await route.continue();
  });
  const holdNextRefresh = () => { held = 0; gate = new Promise(resolve => { open = () => { gate = undefined; resolve(); }; }); };
  const releaseRefresh = () => open();
  await expectNoNamedAccounts();
  await page.goto(origin + "/__accounts?skin=" + (info.project.name === "narrow" ? "dark" : "light"));
  await expect(page.getByText("Verification fixture", { exact: true })).toBeVisible();
  const add = page.getByRole("button", { name: "Add Claude account", exact: true });

  await add.click();
  await page.getByLabel("Account name", { exact: true }).fill("Held refresh");
  holdNextRefresh();
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByText("Held refresh", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Sign in explicitly");
  await expect.poll(() => held).toBe(1);
  await expect(add).toBeDisabled();
  await page.screenshot({ path: info.outputPath("accounts-held-refresh-" + info.project.name + ".png"), fullPage: true });
  releaseRefresh();
  await expect(add).toBeEnabled();
  const created = ((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).find(account => account.displayName === "Held refresh")!;
  await expect(page.locator(`[data-claude-account="${created.instanceId}"]`)).toHaveCount(1);

  await page.getByRole("button", { name: "Edit Held refresh account", exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill("Held renamed");
  holdNextRefresh();
  await page.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByText("Held renamed", { exact: true })).toBeVisible();
  await expect(page.getByText("Held refresh", { exact: true })).toHaveCount(0);
  await expect.poll(() => held).toBe(1);
  releaseRefresh();
  await expect(add).toBeEnabled();

  await page.getByRole("button", { name: "Remove Held renamed account", exact: true }).click();
  holdNextRefresh();
  await page.getByRole("button", { name: "Confirm removal of Held renamed", exact: true }).click();
  await expect(page.locator(`[data-claude-account="${created.instanceId}"]`)).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Login and credential files were retained");
  await expect.poll(() => held).toBe(1);
  releaseRefresh();
  await expect(add).toBeEnabled();
  expect(((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).some(account => account.instanceId === created.instanceId)).toBe(false);
  await expect(page.locator(`[data-claude-account="${created.instanceId}"]`)).toHaveCount(0);
});

// The section takes a change before its first list arrives, and Refresh does
// not lock it. A list response that left before a change's receipt used to
// land after it and redraw the older list over the receipt's row (CLAC1
// verifier). Each held GET is answered by the server first and delivered to the
// page only after the change is drawn, so the late body is genuinely older.
test("a list that left before a change cannot redraw over it", async ({ page }, info) => {
  await expectNoNamedAccounts();
  const late: Array<() => void> = []; let holdNext = true;
  await page.route(url => url.pathname === "/api/claude-accounts", async route => {
    if (route.request().method() !== "GET" || !holdNext) return route.continue();
    holdNext = false;
    const response = await route.fetch();
    await new Promise<void>(resolve => late.push(resolve));
    await route.fulfill({ response });
  });
  const deliverLate = async () => {
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === "/api/claude-accounts" && response.request().method() === "GET");
    late.shift()!();
    await (await answered).finished();
    // Let the page read the late body and commit whatever it does with it.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const accountNamed = async (name: string) => ((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).find(account => account.displayName === name)!;

  await page.goto(origin + "/__accounts?skin=" + (info.project.name === "narrow" ? "dark" : "light"));
  await expect.poll(() => late.length).toBe(1);
  await expect(page.getByText("Loading accounts...", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Claude account", exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill("Early");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sign in explicitly" })).toBeVisible();
  const early = await accountNamed("Early"), earlyRow = page.locator(`[data-claude-account="${early.instanceId}"]`);
  await expect(earlyRow).toHaveCount(1);
  await expect(page.getByText("Verification fixture", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("accounts-late-first-list-" + info.project.name + ".png"), fullPage: true });
  await deliverLate();
  await expect(earlyRow).toHaveCount(1);
  await expect(earlyRow).toContainText("Early");
  await expect(page.getByText("Verification fixture", { exact: true })).toBeVisible();

  holdNext = true;
  await page.getByRole("button", { name: "Refresh accounts", exact: true }).click();
  await expect.poll(() => late.length).toBe(1);
  await page.getByRole("button", { name: "Edit Early account", exact: true }).click();
  await page.getByLabel("Account name", { exact: true }).fill("Early renamed");
  await page.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Account settings saved." })).toBeVisible();
  await expect(page.getByText("Early renamed", { exact: true })).toBeVisible();
  await deliverLate();
  await expect(page.getByText("Early renamed", { exact: true })).toBeVisible();
  await expect(page.getByText("Early", { exact: true })).toHaveCount(0);

  // A list requested after the change still draws what the server holds now.
  await api(`/api/claude-accounts/${early.instanceId}`, "PATCH", { displayName: "Early outside" });
  await page.getByRole("button", { name: "Refresh accounts", exact: true }).click();
  await expect(page.getByText("Early outside", { exact: true })).toBeVisible();
  await expect(page.getByText("Early renamed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Claude account", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// In the Engines settings the section's onChanged is the store's
// refreshInstances: GET /api/instances refreshes every catalog and snapshots
// every engine. Awaiting that inside `busy` greyed every account button for
// one full-fleet probe per create, rename or remove (CLAC2 verifier). Holding
// /api/instances makes the probe last as long as the test needs: the section
// must be usable while it is held, and the engine list must still show the
// change once it answers.
test("the accounts section stays usable while the engine list re-probes", async ({ page }, info) => {
  let gate: Promise<void> | undefined, open = () => {}, held = 0;
  await page.route(url => url.pathname === "/api/instances", async route => {
    if (route.request().method() === "GET" && gate) { held++; await gate; }
    await route.continue();
  });
  const holdFleet = () => { held = 0; gate = new Promise(resolve => { open = () => { gate = undefined; resolve(); }; }); };
  const releaseFleet = () => open();
  const fleetRefreshes = () => page.evaluate(() => (window as any).fleetRefreshes as number);
  await expectNoNamedAccounts();
  await page.goto(origin + "/__accounts?component=engines&skin=" + (info.project.name === "narrow" ? "dark" : "light"));
  const section = page.getByRole("region", { name: "Claude accounts" });
  const engineRow = (name: string) => page.locator(`span[title="${name}"]`);
  await expect(engineRow("Verification fixture")).toBeVisible();
  await expect(section.getByText("Verification fixture", { exact: true })).toBeVisible();
  const others = page.getByText(/^Other accounts and installations/);
  await expect(others).toHaveCount(0);
  const add = section.getByRole("button", { name: "Add Claude account", exact: true });
  const refreshesBefore = await fleetRefreshes();

  await add.click();
  await section.getByLabel("Account name", { exact: true }).fill("Work");
  holdFleet();
  await section.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(section.getByText("Work", { exact: true })).toBeVisible();
  await expect(section.getByRole("status")).toContainText("Sign in explicitly");
  await expect.poll(() => held).toBe(1);
  expect(await fleetRefreshes()).toBe(refreshesBefore + 1);
  // Interactive while the fleet probe is held: every button, and a whole rename.
  await expect(add).toBeEnabled();
  await expect(section.getByRole("button", { name: "Refresh accounts", exact: true })).toBeEnabled();
  const edit = section.getByRole("button", { name: "Edit Work account", exact: true });
  await expect(edit).toBeEnabled();
  await expect(section.getByRole("button", { name: "Remove Work account", exact: true })).toBeEnabled();
  await edit.click();
  await section.getByLabel("Account name", { exact: true }).fill("Work renamed");
  await section.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("Account settings saved.");
  await expect(section.getByText("Work renamed", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "Edit Work renamed account", exact: true })).toBeEnabled();
  // The rename's own fleet refresh waits for the held one: still one probe out.
  expect(held).toBe(1);
  expect(await fleetRefreshes()).toBe(refreshesBefore + 1);
  await expect(others).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("accounts-held-fleet-" + info.project.name + ".png"), fullPage: true });

  releaseFleet();
  // Both probes answer in turn; the engine list then lists the renamed account.
  await expect.poll(fleetRefreshes).toBe(refreshesBefore + 2);
  await expect(others).toHaveText(/Other accounts and installations · 1/);
  await others.click();
  await expect(engineRow("Work renamed")).toBeVisible();
  await expect(engineRow("Work")).toHaveCount(0);
  const created = ((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).find(account => account.displayName === "Work renamed")!;
  expect(created).toBeTruthy();

  await section.getByRole("button", { name: "Remove Work renamed account", exact: true }).click();
  holdFleet();
  await section.getByRole("button", { name: "Confirm removal of Work renamed", exact: true }).click();
  await expect(section.locator(`[data-claude-account="${created.instanceId}"]`)).toHaveCount(0);
  await expect(section.getByRole("status")).toContainText("Login and credential files were retained");
  await expect.poll(() => held).toBe(1);
  await expect(add).toBeEnabled();
  await expect(engineRow("Work renamed")).toBeVisible();
  releaseFleet();
  await expect(engineRow("Work renamed")).toHaveCount(0);
  await expect(others).toHaveCount(0);
  expect(((await api("/api/instances")).instances as Array<{ instanceId: string }>).some(entry => entry.instanceId === created.instanceId)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// The store's refreshInstances used to swallow its own failure, so the
// section's "could not refresh" message for the engine list was unreachable
// from the Engines settings: a change whose fleet probe failed left the page
// silent with an engine list that did not show it (CLAC3 verifier, FOLLOW4).
// The probe is failed by the browser here; the harness itself is healthy, so
// the change is saved and the section's own list is drawn regardless.
test("reports an engine list that could not refresh, without greying the section", async ({ page }, info) => {
  let failFleet = false, failed = 0;
  await page.route(url => url.pathname === "/api/instances", async route => {
    if (route.request().method() === "GET" && failFleet) { failed++; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Engine probe failed" }) }); return; }
    await route.continue();
  });
  await expectNoNamedAccounts();
  await page.goto(origin + "/__accounts?component=engines&skin=" + (info.project.name === "narrow" ? "dark" : "light"));
  const section = page.getByRole("region", { name: "Claude accounts" });
  await expect(section.getByText("Verification fixture", { exact: true })).toBeVisible();
  const others = page.getByText(/^Other accounts and installations/);
  const add = section.getByRole("button", { name: "Add Claude account", exact: true });

  await add.click();
  await section.getByLabel("Account name", { exact: true }).fill("Work");
  failFleet = true;
  await section.getByRole("button", { name: "Create account", exact: true }).click();
  // Saved and drawn: the row and the notice are there; the alert says what
  // did not refresh and the buttons are not greyed.
  await expect(section.getByText("Work", { exact: true })).toBeVisible();
  await expect(section.getByRole("status")).toContainText("Sign in explicitly");
  await expect(section.getByRole("alert")).toHaveText("Saved, but the engine list could not refresh. Switch to another window and back to probe the engines again.");
  expect(failed).toBe(1);
  await expect(add).toBeEnabled();
  await expect(section.getByRole("button", { name: "Edit Work account", exact: true })).toBeEnabled();
  await expect(section.getByRole("button", { name: "Remove Work account", exact: true })).toBeEnabled();
  // The engine list did not refresh: no second Claude row yet.
  await expect(others).toHaveCount(0);
  const created = ((await api("/api/claude-accounts")).accounts as ClaudeAccount[]).find(account => account.displayName === "Work")!;
  expect(created).toBeTruthy();
  await page.screenshot({ path: info.outputPath("accounts-fleet-failed-" + info.project.name + ".png"), fullPage: true });

  // The next change clears the alert as it starts, and its own probe, now
  // answering, brings the engine list up to date.
  failFleet = false;
  await section.getByRole("button", { name: "Edit Work account", exact: true }).click();
  await section.getByLabel("Account name", { exact: true }).fill("Work renamed");
  await section.getByRole("button", { name: "Save account", exact: true }).click();
  await expect(section.getByRole("status")).toContainText("Account settings saved.");
  await expect(section.getByRole("alert")).toHaveCount(0);
  await expect(others).toHaveText(/Other accounts and installations · 1/);
  await others.click();
  await expect(page.locator('span[title="Work renamed"]')).toBeVisible();
  expect(failed).toBe(1);

  await section.getByRole("button", { name: "Remove Work renamed account", exact: true }).click();
  await section.getByRole("button", { name: "Confirm removal of Work renamed", exact: true }).click();
  await expect(section.locator(`[data-claude-account="${created.instanceId}"]`)).toHaveCount(0);
  await expect(others).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
