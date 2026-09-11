import { test, expect } from "@playwright/test";
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
  cache = mkdtempSync(join(tmpdir(), "murage-bundle-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "bundle-import-fixture",
      resolveId(id) { if (id === "/__bundle.js") return "\0bundle-fixture"; if (id === "/fixture-store") return "\0bundle-store"; },
      load(id) {
        if (id === "\0bundle-store") return "export async function api(path,init){const r=await fetch(path,init);const body=await r.json();if(!r.ok)throw Object.assign(new Error(body.error),{status:r.status});return body;}export function useStore(){return {state:{bots:[]},dispatch:action=>(window.fixtureActions??=[]).push(action)}}";
        if (id !== "\0bundle-fixture") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {TeamLibraryPanel} from '/src/components/TeamLibraryPanel.tsx';import {BundleImportDialog} from '/src/components/BundleImportDialog.tsx';import '/src/styles.css';const direct=new URLSearchParams(location.search).has('direct');createRoot(document.getElementById('root')).render(React.createElement(direct?BundleImportDialog:TeamLibraryPanel,{archivePath:'/fixture/selected.zip',fileName:'selected.zip',returnFocusRef:{current:null},onClose:()=>window.fixtureClosed=true,onImported:r=>window.fixtureImported=r}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__bundle?") && req.url !== "/__bundle") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__bundle.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
const scan = { blocked: false, reviewRequired: false, findings: [] };
const options = {
  archiveSha256: "archive-sha", scan,
  agents: [{ key: "scout", name: "Researcher", skills: ["research"] }],
  skills: [{ key: "research", name: "Research skill", license: "MIT", dependencies: [] }],
  routines: [{ key: "daily", name: "Daily research", agent: "scout" }],
  instructions: [{ agent: "scout", path: "bots/scout/SOUL.md" }],
};
const preview = { archiveSha256: "archive-sha", reviewHash: "review-hash", scan, missingDependencies: [], summary: { name: "Selected package", agents: 1, skills: 1, routines: 0, instructions: 1, suggestedChief: "scout" } };
async function emptyCatalog(page: import("@playwright/test").Page) {
  await page.route("**/api/team-library/catalog", route => route.fulfill({ json: { teams: [], repositoryUrl: "" } }));
  await page.route("**/api/library/browse", route => route.fulfill({ json: { facets: [], totalSkills: 0 } }));
}
test("desktop ZIP picker selects exact content and updates the existing workspace after reviewed import", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { (window as any).muragebox = { getPathForFile: () => "/fixture/selected.zip" }; });
  await emptyCatalog(page);
  const requests: any[] = [];
  await page.route("**/api/packages/import", async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    if (body.action === "options") return route.fulfill({ json: options });
    if (body.action === "preview") return route.fulfill({ json: preview });
    return route.fulfill({ json: { bots: [{ id: "fresh-bot", name: "Researcher", composio: false, computer: "off", browser: false }], groups: [], routines: [] } });
  });
  await page.goto(origin + "/__bundle");
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "selected.zip", mimeType: "application/zip", buffer: Buffer.from("fixture-path-only") });
  const dialog = page.getByRole("dialog", { name: "Import selected package contents" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Preview selection" })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /^Researcher Required skills/ }).check();
  await dialog.getByRole("checkbox", { name: /^Research skill/ }).check();
  await dialog.getByRole("checkbox", { name: "Researcher instructions", exact: true }).check();
  await dialog.getByRole("button", { name: "Preview selection" }).click();
  await expect(dialog.getByText("The suggested Chief arrives as an ordinary bot. Your current Chief stays unchanged.")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("bundle-review-mobile.png") });
  await dialog.getByRole("button", { name: "Import package" }).click();
  await expect(dialog).toHaveCount(0);
  const imported = await page.evaluate(() => ({ result: (window as any).fixtureImported, actions: (window as any).fixtureActions }));
  expect(imported.result.importedBotIds).toEqual(["fresh-bot"]);
  expect(imported.actions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "botAdded", bot: expect.objectContaining({ id: "fresh-bot", computer: "off" }) })]));
  expect(requests.at(-1)).toMatchObject({ action: "import", archivePath: "/fixture/selected.zip", selection: { agents: ["scout"], skills: ["research"], routines: [], instructions: ["scout"] }, archiveSha256: "archive-sha", reviewHash: "review-hash" });
});

test("warning acknowledgement resets after stale import and dependencies require an explicit new selection", async ({ page }) => {
  let missing = true;
  await page.route("**/api/packages/import", route => {
    const body = route.request().postDataJSON();
    if (body.action === "options") return route.fulfill({ json: options });
    if (body.action === "import") return route.fulfill({ status: 409, json: { error: "Package changed." } });
    const reply = missing ? { ...preview, summary: null, missingDependencies: ["skill:research"] } : { ...preview, scan: { blocked: false, reviewRequired: true, findings: [{ path: "SOUL.md", rule: "machine-local-path" }] } };
    missing = false;
    return route.fulfill({ json: reply });
  });
  await page.goto(origin + "/__bundle?direct=1");
  await page.getByRole("checkbox", { name: /^Researcher Required skills/ }).check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("alert")).toContainText("Select the missing dependencies");
  await expect(page.getByRole("button", { name: "Import package" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /^Research skill/ }).check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("button", { name: "Import package" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed the warnings/ }).check();
  await page.getByRole("button", { name: "Import package" }).click();
  await expect(page.getByRole("alert")).toContainText("Check the workspace");
  await expect(page.getByRole("button", { name: "Import package" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /^Researcher Required skills/ })).not.toBeChecked();
});

test("blocked options cannot expose candidate content or proceed; browser-only file picker explains the missing native path", async ({ page }) => {
  await page.route("**/api/packages/import", route => route.fulfill({ json: { archiveSha256: "blocked", scan: { blocked: true, reviewRequired: false, findings: [{ path: "manifest.json", rule: "provider-token" }] }, agents: [{ key: "fake", name: "FAKE_SECRET_MUST_NOT_RENDER" }] } }));
  await page.goto(origin + "/__bundle?direct=1");
  await expect(page.getByRole("alert")).toContainText("Import blocked");
  await expect(page.getByRole("button", { name: "Preview selection" })).toHaveCount(0);
  await expect(page.getByText("FAKE_SECRET_MUST_NOT_RENDER")).toHaveCount(0);
  await emptyCatalog(page);
  await page.goto(origin + "/__bundle");
  await page.getByRole("tab", { name: "Import" }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: "selected.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await expect(page.getByRole("alert")).toContainText("Murage desktop app");
  await expect(page.getByRole("dialog", { name: "Import selected package contents" })).toHaveCount(0);
});

test("version comparison describes the prior selection and omitted content without offering an in-place upgrade", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/packages/import", route => route.fulfill({ json: route.request().postDataJSON().action === "options" ? options : {
    ...preview, comparison: { status: "compared", previousRelease: "1.0.0", incomingRelease: "1.1.0", changes: [
      { category: "agents", key: "scout", change: "changed" },
      { category: "skills", key: "citations", change: "added" },
      { category: "routines", key: "daily", change: "omitted" },
    ] },
  } }));
  await page.goto(origin + "/__bundle?direct=1");
  await page.getByRole("checkbox", { name: /^Researcher Required skills/ }).check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  const comparison = page.getByRole("region", { name: "Package version comparison" });
  await expect(comparison).toContainText("Last imported selection: 1.0.0");
  await expect(comparison).toContainText("Selected package: 1.1.0");
  await expect(comparison).toContainText("not your current local edits");
  await expect(comparison).toContainText("Changed · agents: scout");
  await expect(comparison).toContainText("Added · skills: citations");
  await expect(comparison).toContainText("Not included · routines: daily");
  await expect(comparison).toContainText("Imports a separate copy; existing bots and permissions stay unchanged.");
  await expect(page.getByRole("button", { name: /upgrade|replace/i })).toHaveCount(0);
  await comparison.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("bundle-version-comparison-mobile.png") });
});

test("unavailable comparison stays explicit and blocked previews suppress all version details", async ({ page }) => {
  let blocked = false;
  await page.route("**/api/packages/import", route => route.fulfill({ json: route.request().postDataJSON().action === "options" ? options : {
    ...preview, scan: { ...scan, blocked },
    comparison: blocked
      ? { status: "compared", previousRelease: "PRIVATE_PREVIOUS_RELEASE", incomingRelease: "PRIVATE_INCOMING_RELEASE", changes: [{ category: "skills", key: "PRIVATE_COMPARISON_KEY", change: "changed" }] }
      : { status: "unavailable", incomingRelease: "1.1.0", changes: [] },
  } }));
  await page.goto(origin + "/__bundle?direct=1");
  await page.getByRole("checkbox", { name: /^Researcher Required skills/ }).check();
  await page.getByRole("button", { name: "Preview selection" }).click();
  const comparison = page.getByRole("region", { name: "Package version comparison" });
  await expect(comparison).toContainText("prior version lacks saved comparison data");
  await expect(comparison).not.toContainText("No differences");
  await expect(comparison).toContainText("Imports a separate copy");
  blocked = true;
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("alert")).toContainText("Import blocked");
  await expect(comparison).toHaveCount(0);
  await expect(page.getByText(/PRIVATE_(PREVIOUS|INCOMING|COMPARISON)/)).toHaveCount(0);
});
