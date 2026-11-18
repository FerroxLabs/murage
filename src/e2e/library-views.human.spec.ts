import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "./scoped-tailwind";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

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
        if (id === "\0library-store") return "export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('Fixture request failed');return r.json()}export function useStoreActions(){return {dispatch(){},flushBotPatches:async()=>{}};}export function useStoreActionsIfAny(){return useStoreActions();}export function useStoreIfAny(){return useStore();} export function useStore(){return {state:{bots:[]},dispatch:()=>{}}}";
        if (id !== "\0library-ui") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {TeamLibraryPanel} from '/src/components/TeamLibraryPanel.tsx';import {SkillPicker} from '/src/components/skills/SkillPicker.tsx';import '/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(new URLSearchParams(location.search).has('picker')?SkillPicker:TeamLibraryPanel,{botId:'fixture-bot',botName:'Sable',onDone:()=>{},onClose:()=>{},onImported:()=>{},returnFocusRef:{current:null}}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__library" ) || req.url.startsWith("/__library.js")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="height:100dvh;overflow-y:auto;padding:16px;box-sizing:border-box"></div><script type="module" src="/__library.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

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
    if (path === "/api/library/topics") return route.fulfill({ json: { topics: [{ term: "research", label: "Research", count: 1 }], totalSkills: 1 } });
    if (path === "/api/library/skills") return route.fulfill({ json: { items: [{ id: "notes", name: "Notes skill", description: "Summarize supplied notes.", topics: ["research"], bots: [], mine: false }], total: 1, offset: 0 } });
    if (path === "/api/library/search") return route.fulfill({ json: { pagination: { offset: 0, limit: 60, total: 1 }, teams: teams.map(({ slug }) => ({ slug })), skills: [{ id: "notes", name: "Notes skill", description: "Summarize supplied notes.", terms: ["research"] }] } });
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

for (const picker of [false, true]) for (const skin of ["light", "dark"]) test("FB2/FB3 browser: " + (picker ? "bot picker" : "templates") + " pages 600 skills and searches within a topic in " + skin, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const topics = Array.from({ length: 141 }, (_, i) => ({ term: i ? "topic-" + i : "planning", count: i ? 12 : 600 }));
  const skills = Array.from({ length: 600 }, (_, i) => ({ id: "planning-" + String(i).padStart(3, "0"), name: "Skill " + String(i).padStart(3, "0"), description: i === 599 ? "Unique tail marker" : "Plan supplied tasks", terms: ["planning"] }));
  const mutations: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (route.request().method() !== "GET") mutations.push(path);
    if (path === "/api/team-library/catalog") return route.fulfill({ json: { repositoryUrl: "", teams: [] } });
    if (path === "/api/library/browse") return route.fulfill({ json: { facets: topics, totalSkills: 2247 } });
    if (path === "/api/library/topics") return route.fulfill({ json: { topics: topics.map(t => ({ term: t.term, label: t.term === "planning" ? "Planning" : t.term.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()), count: t.count })), totalSkills: 2247 } });
    const summary = (s: typeof skills[number]) => ({ ...s, ref: "library:" + s.id, kind: "library", verdict: "clean", usedBy: [], source: "Library" });
    if (path.startsWith("/api/skills/library:") || path.startsWith("/api/skills/library%3A")) return route.fulfill({ json: { ...summary(skills[599]!), text: "Read these instructions before adding this skill.", files: ["SKILL.md"], skipped: [], scan: { verdict: "clean", findings: [], contentHash: "fixture" }, bots: [{ botId: "fixture-bot", botName: "Sable", canUseSkills: true, enabled: false }] } });
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const term = url.searchParams.get("term") ?? url.searchParams.get("category");
    const hits = term === "planning" ? skills.filter(s => !q || (s.name + " " + s.description).toLowerCase().includes(q)) : [];
    const offset = Number(url.searchParams.get("offset") ?? 0), limit = Number(url.searchParams.get("limit") ?? 60);
    const pagination = { offset, limit, total: hits.length };
    if (path === "/api/library/search") return route.fulfill({ json: { teams: [], skills: hits.slice(offset, offset + limit), pagination } });
    if (path === "/api/skills") return route.fulfill({ json: { yours: [], library: hits.slice(offset, offset + limit).map(summary), categories: topics.map(t => ({ name: t.term, count: t.count })), libraryReady: true, pagination } });
    return route.fulfill({ json: {} });
  });
  await page.goto(origin + "/__library?skin=" + skin + (picker ? "&picker=1" : ""));
  const counter = page.getByRole("navigation", { name: "Skill pages" }).getByRole("status");
  if (picker) {
    await expect(page.getByLabel("Topic").locator("option")).toHaveCount(142);
    await page.getByLabel("Topic").selectOption("planning");
  } else {
    await page.getByRole("tablist", { name: "Library view" }).getByRole("tab", { name: "Skills", exact: true }).click();
    await page.getByRole("button", { name: "Show all 141 topics" }).click();
    await expect(page.getByRole("button", { name: "Topic 140 (12 skills)", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Planning (600 skills)", exact: true }).click();
    await page.getByRole("button", { name: "Show fewer", exact: true }).click();
  }
  await expect(counter).toHaveText("1–60 of 600 skills");
  const rows = picker ? page.locator("li button") : page.locator("article");
  await expect(rows).toHaveCount(60);
  for (let i = 0; i < 9; i++) await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(counter).toHaveText("541–600 of 600 skills");
  await expect(rows).toHaveCount(60);
  await expect(page.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: picker ? "Search skills to add" : "Search skills", exact: true }).fill("Unique");
  await expect(rows).toHaveCount(1);
  await expect(counter).toHaveText("1–1 of 1 skill");
  await page.screenshot({ path: info.outputPath("topic-search-" + skin + ".png") });
  if (picker) {
    await rows.first().click();
    await expect(page.getByText("Read these instructions before adding this skill.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add", exact: true })).toBeVisible();
  }
  expect(mutations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
