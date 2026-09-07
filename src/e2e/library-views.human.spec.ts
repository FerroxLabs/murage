import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-library-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/library-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "library-fixture",
      resolveId(id) { if (id === "/__library.js") return "\0library-ui"; if (id === "/library-fixture-store") return "\0library-store"; },
      load(id) {
        if (id === "\0library-store") return "export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('Fixture request failed');return r.json()}export function useStore(){return {state:{bots:[]},dispatch:()=>{}}}";
        if (id !== "\0library-ui") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {TeamLibraryPanel} from '/src/components/TeamLibraryPanel.tsx';import '/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(TeamLibraryPanel,{onClose:()=>{},onImported:()=>{},returnFocusRef:{current:null}}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__library" ) || req.url.startsWith("/__library.js")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__library.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });

for (const skin of ["light", "dark"]) test(`separate views and informative preview in ${skin}`, async ({ page }, testInfo) => {
  await page.setViewportSize(skin === "light" ? { width: 390, height: 844 } : { width: 1200, height: 900 });
  const base = { category: "Research", summary: "Review supplied notes", skills: [], requires: { apps: [] }, manifest: "", readme: "" };
  const teams = [{ ...base, slug: "solo", name: "Solo researcher", members: 1 }, { ...base, slug: "crew", name: "Research crew", members: 2 }];
  const mutations: string[] = [];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") mutations.push(path);
    if (path === "/api/team-library/catalog") return route.fulfill({ json: { repositoryUrl: "", teams } });
    if (path === "/api/library/browse") return route.fulfill({ json: { facets: [{ term: "research", count: 1 }], totalSkills: 1 } });
    if (path === "/api/library/search") return route.fulfill({ json: { teams: teams.map(({ slug }) => ({ slug })), skills: [{ id: "notes", name: "Notes skill", description: "Summarize supplied notes.", terms: ["research"] }] } });
    if (path === "/api/team-library/teams/crew") return route.fulfill({ json: { format: "murage.package", version: 1, package: {
      name: "Research crew", summary: "Turn supplied interviews into a reviewable brief.", outcomes: ["A brief with evidence from your interviews"],
      examples: [{ title: "Interview review", input: "Summarize these three interviews", output: "A brief grounded in the supplied interviews" }],
      agents: [{ name: "Reader", title: "Researcher", description: "Extracts evidence from supplied interviews." }, { name: "Editor", title: "Reviewer", description: "Checks the brief against the source notes." }],
    } } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__library?skin=${skin}`);
  const tabs = page.getByRole("tablist", { name: "Library view" });
  await expect(tabs.getByRole("tab", { name: "Teams", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Research crew", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Solo researcher" })).toHaveCount(0);
  await expect(page.getByText("Browse skills by topic")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search teams", exact: true }).fill("research");
  await expect(page.getByText("1 teams", { exact: true })).toBeVisible();
  await tabs.getByRole("tab", { name: "Bots", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Solo researcher" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Research crew", exact: true })).toHaveCount(0);
  await tabs.getByRole("tab", { name: "Skills", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Notes skill" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toHaveCount(0);
  await tabs.getByRole("tab", { name: "Teams", exact: true }).click();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Purpose", exact: true })).toBeVisible();
  await expect(page.getByText("A brief with evidence from your interviews", { exact: true })).toBeVisible();
  await expect(page.getByText("Extracts evidence from supplied interviews.", { exact: true })).toBeVisible();
  await expect(page.getByText("Checks the brief against the source notes.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Interview review", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`library-preview-${skin}.png`) });
  expect(mutations).toEqual([]);
});
