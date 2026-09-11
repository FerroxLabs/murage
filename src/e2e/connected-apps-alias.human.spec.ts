// The first connected account is labelled before OAuth starts (adapted from
// OpenMausBot PR #758, merge 86b19df10a0aaebdc66f9da41c46f42d26dd3843,
// Apache-2.0). The real PluginsPanel renders against a synthetic broker:
// every authorization request is counted, and no real sign-in happens.
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
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-apps-alias-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false, resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
    name: "apps-alias-fixture", enforce: "pre",
    resolveId(id) { if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0apps-store"; if (id === "/__apps.js") return "\0apps-entry"; },
    load(id) {
      if (id === "\0apps-store") return `export * from '/src/state/store.tsx?original';import {initialState} from '/src/state/store.tsx?original';const dispatch=action=>window.dispatched.push(action);const config={composio:{configured:true,mode:'self-hosted'},box:{configured:false},vps:{configured:false,sshAlias:''},rooms:{turnTimeoutMinutes:15},localVm:{mode:'shared',maxInstances:1},flux:{configured:false}};const state={...initialState,config};export function useStore(){return {state,dispatch};}`; // stable like the real memoized dispatch, so the dialog focus effect runs once. CTA1: the panel is locked until a key exists; this fixture runs on the person's own Composio key, matching its catalog answer.
      if (id !== "\0apps-entry") return;
      return `import React from 'react';import {createRoot} from 'react-dom/client';import {PluginsPanel} from '/src/components/PluginsPanel.tsx';import '/src/styles.css';
        const query=new URLSearchParams(location.search);document.documentElement.dataset.skin=query.get('skin')||'dark';
        window.dispatched=[];window.opened=[];
        // The preload bridge always means desktop, so a remote viewer gets none and its surface comes from /api/config alone.
        if(query.get('surface')!=='remote')window.muragebox={openExternal:async url=>{window.opened.push(url);}};
        createRoot(document.getElementById('root')).render(React.createElement(PluginsPanel));`;
    },
    configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__apps" && !req.url?.startsWith("/__apps?")) return next(); res.setHeader("content-type", "text/html"); res.end('<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:var(--color-app)"><div id="root"></div><script type="module" src="/__apps.js"></script></body></html>'); }); },
  }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

const LINK = (slug: string) => `https://connect.composio.dev/link/${slug}`;
const CARDS = [
  { slug: "slack", label: "Slack", blurb: "Team chat", logo: null, domain: null },
  { slug: "github", label: "GitHub", blurb: "Code hosting", logo: null, domain: null },
  { slug: "notion", label: "Notion", blurb: "Docs and wikis", logo: null, domain: null },
];
const inventory = () => ({
  slack: { connected: false, pending: false, status: "not_connected", accounts: [] as unknown[] },
  github: { connected: true, pending: false, status: "ACTIVE", accounts: [{ id: "ca_github_personal", alias: "personal", status: "ACTIVE" }] },
  notion: { connected: false, pending: true, status: "INITIATED", accounts: [{ id: "ca_notion", alias: "team", status: "INITIATED" }] },
});

async function mount(page: Page, { surface = "desktop", unreadable = false, width = 1100, skin = "dark" } = {}) {
  const services: Record<string, any> = inventory();
  const calls = { authorize: [] as Array<{ slug: string; body: unknown }>, status: [] as string[] };
  await page.setViewportSize({ width, height: 860 });
  await page.route("**/api/desktop-secret", route => route.fulfill({ json: { secret: "fixture-secret" } }));
  await page.route("**/api/config", route => route.fulfill({ json: { surface, features: {} } }));
  await page.route("**/api/connectors/catalog", route => route.fulfill({ json: { cards: CARDS, source: "curated", configured: true, mode: "self-hosted" } }));
  await page.route("**/api/connectors/connected", route => route.fulfill({ json: unreadable ? { credentialStore: "unavailable", services: {} } : { services } }));
  await page.route(/\/api\/connectors\?services=/, route => {
    const requested = new URL(route.request().url()).searchParams.get("services") ?? "";
    calls.status.push(requested);
    return route.fulfill({ json: { services: Object.fromEntries(requested.split(",").map(slug => [slug, services[slug]])) } });
  });
  await page.route(/\/api\/connectors\/[^/?]+\/authorize$/, route => {
    const slug = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const raw = route.request().postData();
    calls.authorize.push({ slug, body: raw ? JSON.parse(raw) : null });
    services[slug] = { connected: false, pending: true, status: "INITIATED", accounts: [{ id: `ca_${slug}`, status: "INITIATED" }] };
    return route.fulfill({ json: { url: LINK(slug) } });
  });
  await page.goto(`${origin}/__apps?skin=${skin}&surface=${surface}`);
  await expect(page.getByRole("dialog", { name: "Plugins" })).toBeVisible();
  return calls;
}
const opened = (page: Page) => page.evaluate(() => (window as any).opened as string[]);

for (const [skin, width] of [["dark", 1100], ["light", 390]] as const) test(`the first account is labelled before any authorization starts (${skin}, ${width}px)`, async ({ page }, info) => {
  const calls = await mount(page, { skin, width });
  const connect = page.locator('[data-connector-action="slack"]');
  await expect(connect).toHaveText("Connect");
  await expect(connect).toBeEnabled();
  await connect.click();
  const label = page.getByRole("textbox", { name: "Label for the new Slack account", exact: true });
  await expect(label).toBeFocused();
  await expect(label).toHaveAccessibleDescription(/Name this account before you sign in/);
  expect(calls.authorize).toEqual([]);

  // A blank label cannot be submitted: Continue stays disabled, so Enter keeps
  // the form open and focused and sends nothing.
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await label.press("Enter");
  await label.fill("   ");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await label.press("Enter");
  await expect(label).toBeFocused();
  await label.fill("");
  expect(calls.authorize).toEqual([]);
  expect(await opened(page)).toEqual([]);

  // Cancel, Escape and a second press of the button all close the form without authorizing.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(label).toHaveCount(0);
  await expect(connect).toBeFocused();
  await connect.press("Enter");
  await expect(label).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(label).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Plugins" })).toBeVisible();
  await expect(connect).toBeFocused();
  await connect.click();
  await expect(label).toBeVisible();
  await connect.click();
  await expect(label).toHaveCount(0);
  expect(calls.authorize).toEqual([]);
  expect(await opened(page)).toEqual([]);

  // A confirmed label sends exactly one authorization carrying the normalized label.
  await connect.click();
  await label.fill("  team  ");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`first-account-label-${skin}-${width}.png`) });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => calls.authorize.length).toBe(1);
  expect(calls.authorize).toEqual([{ slug: "slack", body: { alias: "team" } }]);
  await expect.poll(() => opened(page)).toEqual([LINK("slack")]);
  await expect(label).toHaveCount(0);

  // A pending authorization with its retained URL continues that same URL; no new authorization.
  await expect(connect).toHaveText("Continue");
  await connect.click();
  await expect.poll(() => opened(page)).toEqual([LINK("slack"), LINK("slack")]);
  expect(calls.authorize).toHaveLength(1);
  await expect(page.getByRole("textbox", { name: /^Label for/ })).toHaveCount(0);
});

test("an additional account keeps its own wording and sends only its confirmed label", async ({ page }) => {
  const calls = await mount(page);
  const add = page.locator('[data-connector-action="github"]');
  await expect(add).toHaveText("Add account");
  await add.click();
  const label = page.getByRole("textbox", { name: "Label for another GitHub account", exact: true });
  await expect(label).toBeFocused();
  await expect(label).toHaveAccessibleDescription(/unique label/);
  expect(calls.authorize).toEqual([]);
  await label.fill("work");
  await label.press("Enter");
  await expect.poll(() => calls.authorize.length).toBe(1);
  expect(calls.authorize).toEqual([{ slug: "github", body: { alias: "work" } }]);
});

test("a pending authorization without a retained URL only checks status", async ({ page }) => {
  const calls = await mount(page);
  const notion = page.locator('[data-connector-action="notion"]');
  await expect(notion).toHaveText("Check status");
  const before = calls.status.length;
  await notion.click();
  await expect.poll(() => calls.status.slice(before)).toContain("notion");
  await expect(page.getByRole("textbox", { name: /^Label for/ })).toHaveCount(0);
  expect(calls.authorize).toEqual([]);
  expect(await opened(page)).toEqual([]);
});

test("an unreadable inventory cannot start a new account", async ({ page }) => {
  const calls = await mount(page, { unreadable: true });
  const connect = page.locator('[data-connector-action="slack"]');
  await expect(connect).toHaveText("Unavailable");
  await expect(connect).toBeDisabled();
  await connect.click({ force: true });
  await expect(page.getByRole("textbox", { name: /^Label for/ })).toHaveCount(0);
  expect(calls.authorize).toEqual([]);
});

test("a remote viewer cannot open the label form or authorize", async ({ page }) => {
  const calls = await mount(page, { surface: "remote" });
  await expect(page.getByText("View connected apps. Manage connections and MCP tools in the desktop app.")).toBeVisible();
  const connect = page.locator('[data-connector-action="slack"]');
  await expect(connect).toBeDisabled();
  await expect(connect).toHaveAttribute("title", "Manage connections in the desktop app");
  await connect.click({ force: true });
  await expect(page.getByRole("textbox", { name: /^Label for/ })).toHaveCount(0);
  expect(calls.authorize).toEqual([]);
});
