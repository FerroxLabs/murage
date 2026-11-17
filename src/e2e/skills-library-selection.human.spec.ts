// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { test, expect, type Page } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import type { SkillListItem } from "../lib/skillsLibrary";

// Renderer fixture: real panel, browser, detail and rich editor; only API data
// and the store's bot inventory are fixtures. No live app or server mutations.
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "skills-selection-"));
  server = await createServer({ configFile: false, envFile: false, root, cacheDir: cache,
    optimizeDeps: { entries: [], noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "lucide-react", "clsx", "tailwind-merge", "posthog-js", "yaml", "react-markdown", "remark-gfm", "zod", "@tiptap/core", "@tiptap/extension-table", "@tiptap/extension-list", "@tiptap/markdown", "@tiptap/starter-kit", "@tiptap/extension-drag-handle-react", "@tiptap/extension-placeholder", "@tiptap/react", "@tiptap/react/menus", "@tiptap/suggestion", "katex", "dompurify"] },
    resolve: { alias: [{ find: "@/state/store", replacement: "/__selection-store.ts" }, { find: "@", replacement: join(root, "src") }] },
    server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [react(), tailwindcss(), {
      name: "skills-selection-fixture",
      resolveId(id) { if (id === "/__selection-store.ts" || id === "/__selection-entry.tsx") return id; },
      load(id) {
        if (id === "/__selection-store.ts") return `
          export * from '/src/state/store.tsx';
          import {initialState} from '/src/state/store.tsx';
          const state={...initialState,bots:[{id:'fixture-bot',name:'Builder'}]};
          export function useStore(){return {state,dispatch(){}};}`;
        if (id === "/__selection-entry.tsx") return `
          import React from 'react';import {createRoot} from 'react-dom/client';
          import {TeamLibraryPanel} from '/src/components/TeamLibraryPanel.tsx';
          import {LazyOverlay} from '/src/components/LazyOverlay.tsx';
          import '/src/styles.css';
          createRoot(document.getElementById('root')).render(<LazyOverlay name="selection-fixture" kind="window" covers="always" onDismiss={()=>{}} onRetry={()=>{}}><TeamLibraryPanel initialView="skills" onClose={()=>{}} onImported={()=>{}} returnFocusRef={{current:null}}/></LazyOverlay>);`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (req.url !== "/__selection") return next();
          res.setHeader("content-type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__selection-entry.tsx"></script>'));
        });
      },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

async function fixture(page: Page, count: number, copy = false) {
  let skills: SkillListItem[] = Array.from({ length: count }, (_, i) => ({
    id: `library:skill-${i}`, name: `Skill ${String(i).padStart(3, "0")}`, description: "Fixture instructions.", topics: ["testing"], bots: [], mine: false,
  }));
  const original = skills[1];
  const copyId = "collection:fixture-copy";
  if (copy) skills.push({ ...original, id: copyId, name: "My fixture copy", mine: true });
  const details = (skill: SkillListItem) => ({
    ...skill, ref: skill.id, kind: skill.mine ? "collection" : "library", source: skill.mine ? "Copied from library" : "Library",
    originalRef: skill.mine ? original.id : undefined, text: `# ${skill.name}\n\nFixture instructions.`,
    files: [{ path: "SKILL.md", size: 30 }], verdict: "clean", scan: { verdict: "clean", findings: [], contentHash: "a".repeat(64) }, usedBy: [], skipped: [],
  });
  await page.route("**/api/**", async route => {
    const req = route.request(), url = new URL(req.url());
    let data: unknown;
    if (url.pathname === "/api/library/topics") data = { topics: [{ term: "testing", label: "Testing", count: skills.length }], totalSkills: skills.length };
    else if (url.pathname === "/api/library/skills") {
      const q = url.searchParams.get("q")?.toLowerCase(), filter = url.searchParams.get("filter");
      const matches = skills.filter(s => (!q || s.name.toLowerCase().includes(q)) && (filter !== "mine" || s.mine) && (filter !== "onBots" || s.bots.length));
      const offset = Number(url.searchParams.get("offset") || 0), limit = Number(url.searchParams.get("limit") || 100);
      data = { items: matches.slice(offset, offset + limit), total: matches.length, offset };
    } else if (url.pathname.startsWith("/api/skills/")) {
      const parts = url.pathname.split("/");
      const id = parts[3] === "collection" ? `collection:${decodeURIComponent(parts[4])}` : decodeURIComponent(parts[3]);
      const skill = skills.find(s => s.id === id);
      if (!skill) return route.fulfill({ status: 404, json: { error: "Skill not found" } });
      if (url.pathname.endsWith("/duplicate")) {
        const copied = { ...skill, id: copyId, mine: true }; skills.push(copied); data = { skill: details(copied) };
      } else if (url.pathname.endsWith("/revert")) {
        skills = skills.filter(s => s.id !== id); data = { id: original.id, reverted: true, movedBots: [] };
      } else if (req.method() === "PUT") {
        const body = req.postDataJSON(); skill.name = body.displayName; skill.description = body.description;
        data = { skill: details(skill), needsLook: [], failed: [] };
      } else data = details(skill);
    } else if (url.pathname.includes("catalog")) data = { repositoryUrl: "", teams: [] };
    else if (url.pathname.includes("browse")) data = { facets: [], totalSkills: skills.length };
    else data = {};
    await route.fulfill({ json: data });
  });
  await page.goto(`${origin}/__selection`);
  await expect(page.locator('[data-skill-index="0"]')).toBeVisible();
  await expect(page.locator("[data-skills-browser]")).toHaveAttribute("data-compact", String(page.viewportSize()!.width < 860));
  return { original, copyId };
}

async function pickFilter(page: Page, name: string) {
  const change = page.locator('section[aria-label="Skills"] [aria-haspopup="dialog"]');
  if (await change.count()) await change.click();
  await page.locator('nav[aria-label="Topics"]').getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

for (const [width, height] of [[1040, 780], [700, 520]]) {
  test(`${width}x${height} Save selects the copy after keeping a draft through keyboard navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page, 3);
    await page.getByRole("button", { name: /^Skill 001/ }).click();
    const pane = page.locator("section[data-skill-editor]");
    await pane.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("My fixture copy");
    if (width < 860) await page.setViewportSize({ width: 1040, height: 780 });
    await expect(page.locator("[data-skills-browser]")).toHaveAttribute("data-compact", "false");
    const selectedRow = page.locator('[data-skill-index][aria-current="true"]');
    await selectedRow.focus();
    await expect(selectedRow).toBeFocused();
    await selectedRow.press("ArrowDown");
    await expect(page.getByRole("alertdialog", { name: "Discard unsaved edits?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.getByRole("button", { name: "Save as my copy", exact: true }).click();
    await expect(pane.getByRole("heading", { level: 2 })).toHaveText("My fixture copy");
    await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("My fixture copy");
  });
  test(`${width}x${height} a newer row choice wins while Revert is pending`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page, 3, true);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/revert", async route => { await pending; await route.fallback(); });
    await page.getByRole("button", { name: /^My fixture copy/ }).click();
    const pane = page.locator("section[data-skill-editor]");
    try {
      await pane.getByRole("button", { name: "Go back to the original", exact: true }).click();
      await expect(pane.getByRole("button", { name: "Going back…", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: /^Skill 000/ }).click();
    } finally { release(); }
    await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 000");
    await expect(page.getByRole("list", { name: "Skill results" })).toHaveAttribute("aria-busy", "false");
    await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("Skill 000");
  });
  test(`${width}x${height} search cannot leave while a copy is saving`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page, 3);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/skills/collection/**", async route => { await pending; await route.fallback(); });
    await page.getByRole("button", { name: /^Skill 001/ }).click();
    const pane = page.locator("section[data-skill-editor]");
    await pane.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("My fixture copy");
    if (width < 860) await page.setViewportSize({ width: 1040, height: 780 });
    try {
      await page.getByRole("button", { name: "Save as my copy", exact: true }).click();
      await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
      const search = page.getByRole("textbox", { name: /^Search all/ });
      await search.fill("Skill 002");
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("My fixture copy");
      await expect(search).toHaveValue("");
      await expect(page.getByRole("alertdialog")).toHaveCount(0);
    } finally { release(); }
    await expect(pane.getByRole("heading", { level: 2 })).toHaveText("My fixture copy");
    await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("My fixture copy");
  });
  test(`${width}x${height} search asks before discarding a dirty draft`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page, 3);
    await page.getByRole("button", { name: /^Skill 001/ }).click();
    const pane = page.locator("section[data-skill-editor]");
    await pane.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByLabel("Name", { exact: true }).fill("Keep this draft");
    // Compact editing hides the list; widening makes search available again.
    if (width < 860) await page.setViewportSize({ width: 1040, height: 780 });
    const search = page.getByRole("textbox", { name: /^Search all/ });
    await search.fill("Skill 002");
    await expect(page.getByRole("alertdialog", { name: "Discard unsaved edits?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keep this draft");
    await expect(search).toHaveValue("");
    await search.fill("Skill 002");
    await page.getByRole("button", { name: "Discard edits", exact: true }).click();
    await expect(search).toHaveValue("Skill 002");
    await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 002");
  });
  test(`${width}x${height} search keeps an instructions-only draft when confirmation is escaped`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await fixture(page, 3);
    await page.locator('[data-skill-index="0"]').focus();
    await page.locator('[data-skill-index="0"]').press("ArrowDown");
    await expect(page.locator('[data-skill-index="1"]')).toBeFocused();
    await expect(page.locator('[data-skill-index="1"]')).toHaveCSS("outline-offset", "-2px");
    await page.getByRole("button", { name: /^Skill 001/ }).click();
    const pane = page.locator("section[data-skill-editor]");
    await pane.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.fill("Keep these unsaved instructions.");
    if (width < 860) await page.setViewportSize({ width: 1040, height: 780 });
    const search = page.getByRole("textbox", { name: /^Search all/ });
    await search.pressSequentially("S");
    await expect(page.getByRole("alertdialog", { name: "Discard unsaved edits?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(editor).toHaveText("Keep these unsaved instructions.");
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Skill 001");
    await expect(search).toHaveValue("");
    await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("Skill 001");
    await search.fill("Skill 002");
    await page.getByRole("button", { name: "Discard edits", exact: true }).click();
    await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 002");
    await expect(search).toHaveValue("Skill 002");
  });
  for (const scenario of ["all", "search", "later page"] as const) {
    test(`${width}x${height} Save as my copy keeps the copy selected: ${scenario}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await fixture(page, scenario === "later page" ? 237 : 3);
      if (scenario === "search") await page.getByRole("textbox", { name: /^Search all/ }).fill("Skill 001");
      await page.getByRole("button", { name: /^Skill 001/ }).click();
      const pane = page.locator("section[data-skill-editor]");
      await pane.getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill("My fixture copy");
      await page.getByRole("button", { name: "Save as my copy", exact: true }).click();
      await expect(page.getByRole("list", { name: "Skill results" })).toHaveAttribute("aria-busy", "false");
      await expect(pane.getByRole("heading", { level: 2 })).toHaveText("My fixture copy");
      await expect(page.locator('[data-skill-index][aria-current="true"]')).toHaveCount(1);
      await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("My fixture copy");
      await expect(page.locator('[data-skill-index][aria-current="true"]')).toBeInViewport();
      await expect(pane.getByRole("button", { name: "Go back to the original", exact: true })).toBeVisible();
      await expect(pane.getByText("Saved. This is your copy. Your bots use it in place of the library original.", { exact: true })).toBeVisible();
      if (scenario === "search") await expect(page.getByRole("textbox", { name: /^Search all/ })).toHaveValue("");
      if (scenario === "all") await page.screenshot({ path: info.outputPath("selected-copy.png") });
      await page.getByRole("button", { name: /^Skill 000/ }).click();
      await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 000");
    });
  }
  for (const filter of ["All skills", "Your copies"]) {
    test(`${width}x${height} Revert keeps the restored skill selected: ${filter}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await fixture(page, 3, true);
      if (filter === "Your copies") await pickFilter(page, filter);
      await page.getByRole("button", { name: /^My fixture copy/ }).click();
      const pane = page.locator("section[data-skill-editor]");
      await pane.getByRole("button", { name: "Go back to the original", exact: true }).click();
      await expect(page.getByRole("list", { name: "Skill results" })).toHaveAttribute("aria-busy", "false");
      await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 001");
      await expect(page.locator('[data-skill-index][aria-current="true"]')).toHaveCount(1);
      await expect(page.locator('[data-skill-index][aria-current="true"]')).toContainText("Skill 001");
      await expect(pane.getByRole("button", { name: "Go back to the original", exact: true })).toHaveCount(0);
      await expect(pane.getByText("Your bots now use the library original.", { exact: true })).toBeVisible();
      if (filter === "All skills") await page.screenshot({ path: info.outputPath("selected-original.png") });
      await page.getByRole("button", { name: /^Skill 000/ }).click();
      await expect(pane.getByRole("heading", { level: 2 })).toHaveText("Skill 000");
    });
  }
}
