import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-starter-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/starter-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "starter-profiles-fixture",
      resolveId(id) { if (id === "/__starters.js") return "\0starter-profiles"; if (id === "/starter-fixture-store") return "\0starter-store"; },
      load(id) {
        if (id === "\0starter-store") return "import {useSyncExternalStore} from 'react';let state={instances:[]};const listeners=new Set();export async function api(path,init){const r=await fetch(path,init);const data=await r.json();if(!r.ok)throw Object.assign(new Error(data.error),{status:r.status});return data;}function dispatch(action){(window.fixtureActions??=[]).push(action);if(action.type==='instances'){state={...state,instances:action.instances};listeners.forEach(fn=>fn())}}export function useStore(){return {state:useSyncExternalStore(fn=>{listeners.add(fn);return ()=>listeners.delete(fn)},()=>state),dispatch}}";
        if (id !== "\0starter-profiles") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {StarterProfiles} from '/src/components/StarterProfiles.tsx';import {Onboarding} from '/src/components/Onboarding.tsx';import '/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';window.fixtureActions=[];function Fixture(){const [done,setDone]=React.useState(false);return done?React.createElement('p',null,'Workspace open'):React.createElement(Onboarding,{onDone:()=>setDone(true)})}createRoot(document.getElementById('root')).render(React.createElement(location.search.includes('onboarding')?Fixture:StarterProfiles));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__starters?") && req.url !== "/__starters") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:620px;margin:16px auto"></main><script type="module" src="/__starters.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
const profiles = [
  { id: "starter-personal-home", name: "Personal and home", summary: "Organize tasks using your own notes.", outcomes: ["Prioritize your next actions"], members: 2, agents: [{ key: "planner", name: "Planner" }, { key: "helper", name: "Helper" }], routines: [{ key: "review", name: "Weekly review" }], connectionsRequired: false },
  { id: "starter-solo-business", name: "Solo business", summary: "Plan your work using information you provide.", outcomes: ["Choose a practical next step"], members: 1, agents: [{ key: "operator", name: "Operator" }], routines: [], connectionsRequired: false },
  { id: "starter-business-team", name: "Business team", summary: "Clarify team work and responsibilities.", outcomes: ["Identify owners and questions"], members: 1, agents: [{ key: "coordinator", name: "Coordinator" }], routines: [], connectionsRequired: false },
];
const importedBot = { id: "new-bot", threadId: "new-thread", name: "Planner", chiefOfStaff: false, composio: false, computer: "off", browser: false };
const draftId = "bot:new-bot:new-thread";
async function fixture(page: Page, options: { stale?: boolean; fail?: boolean } = {}) {
  const requests: any[] = [];
  let stale = options.stale ?? false;
  await page.route("**/api/starter-profiles", route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.action === "catalog") return route.fulfill({ json: { profiles } });
    if (body.action === "preview") return route.fulfill({ json: { archiveSha256: "archive-sha", reviewHash: "review-hash", summary: { name: "Personal and home", agents: 2, routines: body.selection.routines.length }, missingDependencies: [], scan: { blocked: false, reviewRequired: false, findings: [] } } });
    if (stale) { stale = false; return route.fulfill({ status: 409, json: { error: "Stale review" } }); }
    if (options.fail) return route.fulfill({ status: 503, json: { error: "Failed import" } });
    return route.fulfill({ json: { bots: [importedBot], groups: [], routines: [] } });
  });
  return requests;
}
async function chooseAndReview(page: Page) {
  await page.getByRole("button", { name: /^Personal and home/ }).click();
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import starter profile" })).toBeEnabled();
}

test("three starters require selection and fresh review, import inert records, then prepare a draft without sending", async ({ page }) => {
  const requests = await fixture(page, { stale: true });
  await page.goto(origin + "/__starters");
  await expect(page.getByLabel("Available starter profiles").getByRole("button")).toHaveCount(3);
  expect(requests.map(request => request.action)).toEqual(["catalog"]);
  await page.getByRole("button", { name: /^Personal and home/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("checkbox", { name: "Weekly review" })).not.toBeChecked();
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  expect(requests.at(-1).selection).toEqual({ agents: ["planner", "helper"], skills: [], instructions: [], routines: [] });
  await page.getByRole("checkbox", { name: "Weekly review" }).check();
  await expect(page.getByRole("button", { name: "Import starter profile" })).toHaveCount(0);
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  await page.getByRole("button", { name: "Import starter profile" }).click();
  await expect(page.getByRole("alert")).toContainText("Check your workspace");
  await expect(page.getByRole("button", { name: "Open first task" })).toHaveCount(0);
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  await page.getByRole("button", { name: "Import starter profile" }).click();
  await expect(page.getByRole("status")).toContainText("No task has been sent");
  const actions = await page.evaluate(() => (window as any).fixtureActions);
  expect(actions).toEqual([{ type: "botAdded", bot: importedBot }]);
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem("murage-drafts") ?? "{}")[id], draftId)).toBeUndefined();
  await page.getByRole("button", { name: "Open first task" }).click();
  const opened = await page.evaluate(id => ({ text: JSON.parse(localStorage.getItem("murage-drafts") ?? "{}")[id], actions: (window as any).fixtureActions }), draftId);
  expect(opened.text).toContain("My notes:");
  expect(opened.actions.slice(-2)).toEqual([{ type: "select", id: "new-bot" }, { type: "toggleAppSettings", open: false }]);
  expect(requests.filter(request => request.action === "import").at(-1)).toMatchObject({ profileId: "starter-personal-home", archiveSha256: "archive-sha", reviewHash: "review-hash", selection: { routines: ["review"] } });
  expect(requests.every(request => ["catalog", "preview", "import"].includes(request.action))).toBe(true);
});

test("opening the first task preserves existing text, whitespace and attachment-only drafts", async ({ page }) => {
  await fixture(page);
  const attachment = { kind: "file", id: "attachment", path: "/fixture/notes.txt", name: "notes.txt", size: 10 };
  for (const existing of [{ text: "My existing plan", attachments: [attachment] }, { text: "  ", attachments: [] }, { text: "", attachments: [attachment] }]) {
    await page.goto(origin + "/__starters");
    await chooseAndReview(page);
    await page.getByRole("button", { name: "Import starter profile" }).click();
    await expect(page.getByRole("button", { name: "Open first task" })).toBeVisible();
    await page.evaluate(({ id, existing }) => {
      localStorage.setItem("murage-drafts", JSON.stringify({ [id]: existing.text }));
      localStorage.setItem("murage-draft-attachments", JSON.stringify({ [id]: existing.attachments }));
    }, { id: draftId, existing });
    await page.getByRole("button", { name: "Open first task" }).click();
    expect(await page.evaluate(id => ({ text: JSON.parse(localStorage.getItem("murage-drafts")!)[id], attachments: JSON.parse(localStorage.getItem("murage-draft-attachments")!)[id] }), draftId)).toEqual(existing);
  }
});

test("import failure and unavailable draft storage never claim completion or a saved draft", async ({ page }) => {
  await fixture(page, { fail: true });
  await page.goto(origin + "/__starters");
  await chooseAndReview(page);
  await page.getByRole("button", { name: "Import starter profile" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not confirm the import");
  await expect(page.getByRole("button", { name: "Open first task" })).toHaveCount(0);
  await page.unroute("**/api/starter-profiles");
  await fixture(page);
  await page.goto(origin + "/__starters");
  await chooseAndReview(page);
  await page.getByRole("button", { name: "Import starter profile" }).click();
  await expect(page.getByRole("button", { name: "Open first task" })).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage denied"); } }); });
  await page.getByRole("button", { name: "Open first task" }).click();
  await expect(page.getByRole("alert")).toContainText("draft could not be saved safely");
  expect((await page.evaluate(() => (window as any).fixtureActions)).some((action: any) => action.type === "select")).toBe(false);
});

for (const skin of ["light", "dark"]) test("mobile " + skin + " starter review is legible with paused-routine guidance", async ({ page }, info) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__starters?skin=" + skin);
  await chooseAndReview(page);
  await expect(page.getByText("Your current Chief stays unchanged", { exact: false })).toBeVisible();
  await expect(page.getByText(/Imported routines stay paused/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("starter-review-" + skin + "-mobile.png"), fullPage: true });
});

const engine = { instanceId: "fuigo", driverKind: "fuigoAgent", displayName: "Fuigo", access: "cloud", enabled: true,
  snapshot: { state: "available", authenticated: true }, models: { default: "fixture-model", options: [{ id: "fixture-model", label: "Fixture model" }] },
  install: { command: { win32: "npm install -g forbidden-fixture" } } };
async function onboardingFixture(page: Page, options: { established?: boolean; repair?: boolean } = {}) {
  let checks = 0;
  await page.addInitScript(() => { (window as any).muragebox = { platform: "win32" }; });
  await page.route("**/api/config", route => route.fulfill({ json: { surface: "desktop" } }));
  await page.route("**/api/bots?messages=0", route => route.fulfill({ json: { bots: options.established ? [importedBot] : [], groups: [] } }));
  await page.route("**/api/instances", route => {
    checks++;
    if (options.repair && checks === 2) return route.fulfill({ status: 503, json: { error: "Fixture recheck unavailable" } });
    const value = options.repair && checks < 4 ? { ...engine, snapshot: { state: "unavailable", setupAction: "repair", reason: "Bundled engine could not start" }, models: { default: "", options: [] } } : engine;
    return route.fulfill({ json: { instances: [value] } });
  });
  return fixture(page);
}

test("outcome-first onboarding requires an explicit engine and model, reviews a crew and opens a draft", async ({ page }, info) => {
  const requests = await onboardingFixture(page);
  await page.goto(origin + "/__starters?onboarding&skin=dark");
  await expect(page.getByRole("button", { name: /^Organize my day/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Run my business/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Build and create/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath("onboarding-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: /^Organize my day/ }).click();
  await expect(page.getByRole("button", { name: "Preview my crew" })).toBeDisabled();
  await page.getByRole("button", { name: "Fuigo Included" }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("");
  await page.getByRole("combobox", { name: "Model" }).selectOption("fixture-model");
  await page.getByRole("button", { name: "Preview my crew" }).click();
  await expect(page.getByRole("heading", { name: "Preview your crew" })).toBeVisible();
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  await page.getByRole("button", { name: "Import starter profile" }).click();
  expect(requests.find(request => request.action === "import")).toMatchObject({ modelSelection: { instanceId: "fuigo", model: "fixture-model" }, firstRun: true });
  await expect(page.getByRole("status")).toContainText("No task has been sent");
  await page.getByRole("button", { name: "Open first task" }).click();
  await expect(page.getByText("Workspace open", { exact: true })).toBeVisible();
  expect(await page.evaluate(id => JSON.parse(localStorage.getItem("murage-drafts") ?? "{}")[id], draftId)).toContain("My notes:");
});

test("bundled Fuigo stays unavailable through failed checks and only unlocks after actual successful recheck", async ({ page }, info) => {
  await onboardingFixture(page, { repair: true });
  await page.goto(origin + "/__starters?onboarding&skin=dark");
  await page.getByRole("button", { name: /^Build and create/ }).click();
  await page.getByRole("button", { name: "Fuigo Included" }).click();
  await expect(page.getByText("Repair bundled Fuigo", { exact: true })).toBeVisible();
  await expect(page.getByText(/^npm install -g/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview my crew" })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("bundled-fuigo-repair.png"), fullPage: true });
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture recheck unavailable");
  await expect(page.getByRole("button", { name: "Preview my crew" })).toBeDisabled();
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Bundled engine could not start");
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveCount(0);
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Model" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview my crew" })).toBeDisabled();
  await page.getByRole("combobox", { name: "Model" }).selectOption("fixture-model");
  await expect(page.getByRole("button", { name: "Preview my crew" })).toBeEnabled();
});

test("interrupted selection resumes, while an established workspace never creates another crew", async ({ page }) => {
  const requests = await onboardingFixture(page);
  await page.goto(origin + "/__starters?onboarding");
  await page.getByRole("button", { name: /^Run my business/ }).click();
  await page.getByRole("button", { name: "Fuigo Included" }).click();
  await page.getByRole("combobox", { name: "Model" }).selectOption("fixture-model");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Choose an engine" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("fixture-model");
  expect(requests.filter(request => request.action === "import")).toHaveLength(0);
  await page.unroute("**/api/bots?messages=0");
  await page.route("**/api/bots?messages=0", route => route.fulfill({ json: { bots: [importedBot], groups: [] } }));
  await page.reload();
  await expect(page.getByText("Workspace open", { exact: true })).toBeVisible();
  expect(requests.filter(request => request.action === "import")).toHaveLength(0);
});

for (const action of ["Start empty", "Import existing"]) test(action + " opens the existing workspace flow without importing a starter", async ({ page }) => {
  const requests = await onboardingFixture(page);
  await page.goto(origin + "/__starters?onboarding");
  await page.getByRole("button", { name: action, exact: true }).click();
  await expect(page.getByText("Workspace open", { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  if (action === "Import existing") expect(await page.evaluate(() => (window as any).fixtureActions)).toContainEqual({ type: "showTeamLibrary", view: "teams" });
});

for (const skin of ["light", "dark"]) test("onboarding outcome choices fit mobile " + skin, async ({ page }, info) => {
  await onboardingFixture(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__starters?onboarding&skin=" + skin);
  await expect(page.getByRole("button", { name: "Start empty", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("onboarding-" + skin + "-mobile.png"), fullPage: true });
});
