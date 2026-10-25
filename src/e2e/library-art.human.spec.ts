// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The bot and team libraries show the shipped template art. This runs the real catalog and the real
// public/library-art files through the real panels: every card's image has to load, the detail view
// leads with the large one, and a template with no art keeps the old placeholder.
import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;
const root = fileURLToPath(new URL("../../", import.meta.url));
const shots = process.env.LIBRARY_ART_SHOTS;

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-library-art-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/library-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "library-art-fixture",
      resolveId(id) { if (id === "/__library.js") return "\0library-ui"; if (id === "/library-fixture-store") return "\0library-store"; },
      load(id) {
        if (id === "\0library-store") return "export async function api(path,init){const r=await fetch(path,init);if(!r.ok)throw new Error('Fixture request failed');return r.json()}export function useStore(){return {state:{bots:[]},dispatch:()=>{}}}";
        if (id !== "\0library-ui") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {TeamLibraryPanel} from '/src/components/TeamLibraryPanel.tsx';import '/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(TeamLibraryPanel,{onClose:()=>{},onImported:()=>{},returnFocusRef:{current:null}}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__library") || req.url.startsWith("/__library.js")) return next();
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
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const catalog = JSON.parse(readFileSync(join(root, "library/catalog.json"), "utf8")) as { teams: Array<{ slug: string; members: number; name: string }> };
const withoutArt = { slug: "no-art-fixture", name: "Template without art", summary: "Keeps the placeholder.", category: "Run", members: 1, skills: [], requires: { apps: [] }, manifest: "", readme: "", playbooks: [] };

function packageFor(slug: string): unknown {
  for (const dir of ["bot-library/builtins", "library/packages", "library/assistants"]) {
    const file = join(root, dir, `${slug}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  }
  throw new Error(`no package for ${slug}`);
}

for (const skin of ["light", "dark"]) test(`library art in the bot and team libraries, ${skin}`, async ({ page }) => {
  if (shots) mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  const team = catalog.teams.find((entry) => entry.slug === "marketing-agency") ?? catalog.teams.find((entry) => entry.members > 2)!;
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/team-library/catalog") return route.fulfill({ json: { repositoryUrl: "", teams: [...catalog.teams, withoutArt] } });
    if (path === "/api/library/browse") return route.fulfill({ json: { facets: [], totalSkills: 0 } });
    const one = path.match(/^\/api\/team-library\/teams\/([a-z0-9-]+)$/);
    if (one) return route.fulfill({ json: packageFor(one[1]) });
    return route.fulfill({ json: {} });
  });
  await page.goto(`${origin}/__library?skin=${skin}`);
  const tabs = page.getByRole("tablist", { name: "Library view" });

  // Teams: art on every visible card, and it actually loaded.
  await expect(tabs.getByRole("tab", { name: "Teams", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: team.name, exact: true }).first()).toBeVisible();
  await expect.poll(() => page.locator("article img").evaluateAll((images) => (images as HTMLImageElement[]).filter((image) => image.complete && image.naturalWidth > 0).length)).toBeGreaterThan(0);
  expect(await page.locator("article img[alt^='Illustration of the']").count()).toBeGreaterThan(0);
  if (shots) await page.screenshot({ path: join(shots, `team-library-${skin}.png`) });

  // Bots: the placeholder stays for a template with no art.
  await tabs.getByRole("tab", { name: "Bots", exact: true }).click();
  await expect.poll(() => page.locator("article img[alt^='Illustration of ']").count()).toBeGreaterThan(0);
  if (shots) await page.screenshot({ path: join(shots, `bot-library-${skin}.png`) });
  const bare = page.locator("article", { has: page.getByRole("heading", { name: "Template without art" }) });
  await bare.scrollIntoViewIfNeeded();
  await expect(bare.locator("img")).toHaveCount(0);

  // Detail: the large image leads the team preview.
  await tabs.getByRole("tab", { name: "Teams", exact: true }).click();
  await page.locator("article", { has: page.getByRole("heading", { name: team.name, exact: true }) }).first().getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Purpose", exact: true })).toBeVisible();
  const hero = page.locator(`img[src='/library-art/${team.slug}-512.webp']`);
  await expect(hero).toBeVisible();
  expect(await hero.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(512);
  if (shots) await page.screenshot({ path: join(shots, `team-detail-${skin}.png`) });
});
