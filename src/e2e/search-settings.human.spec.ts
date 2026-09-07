import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-search-settings-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/search-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "search-settings-fixture",
      resolveId(id) { if (id === "/__search.js") return "\0search-settings"; if (id === "/search-fixture-store") return "\0search-store"; },
      load(id) {
        if (id === "\0search-store") return "import React from 'react';export async function api(path,init){const r=await fetch(path,init);const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}export function useStore(){const [config,setConfig]=React.useState(window.fixtureConfig);return {state:{config},dispatch:action=>{window.fixtureConfig=action.config;setConfig(action.config)}}}";
        if (id !== "\0search-settings") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {SearchSettings} from '/src/components/SearchSettings.tsx';import {setLocale} from '/src/lib/i18n.ts';import '/src/styles.css';const q=new URLSearchParams(location.search);setLocale(q.get('lang')||'en');document.documentElement.dataset.skin=q.get('skin')||'dark';window.fixtureConfig??={webSearch:{provider:q.get('provider')||'engine',tavilyConfigured:false,exaConfigured:false}};createRoot(document.getElementById('root')).render(React.createElement(SearchSettings));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__search?") && req.url !== "/__search") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:620px;margin:16px auto"></main><script type="module" src="/__search.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });
test("Firecrawl key setup preserves engine-first default until explicitly selected", async ({ page }, info) => {
  test.setTimeout(45000);
  await page.addInitScript(() => {
    (window as any).credentialCalls = [];
    (window as any).muragebox = { setCredential: async (name: string, value: string) => {
      (window as any).credentialCalls.push({ name, supplied: Boolean(value) });
      return { webSearch: { provider: "engine", tavilyConfigured: false, exaConfigured: false, firecrawlConfigured: true } };
    } };
  });
  const providerWrites: string[] = [];
  await page.route("**/api/config", route => {
    const provider = route.request().postDataJSON().webSearch.provider; providerWrites.push(provider);
    return route.fulfill({ json: { webSearch: { provider, tavilyConfigured: false, exaConfigured: false, firecrawlConfigured: true } } });
  });
  await page.goto(origin + "/__search");
  await expect(page.getByLabel("Search provider", { exact: true })).toHaveValue("engine");
  await expect(page.getByText("Use the engine's own search first.", { exact: false })).toBeVisible();
  await page.getByLabel("Firecrawl API key", { exact: true }).fill("fake-firecrawl-key");
  await page.getByRole("button", { name: "Save Firecrawl key", exact: true }).click();
  await expect(page.getByLabel("Firecrawl API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Search provider", { exact: true })).toHaveValue("engine");
  expect(await page.evaluate(() => (window as any).credentialCalls)).toEqual([{ name: "firecrawlSearchApiKey", supplied: true }]);
  expect(providerWrites).toEqual([]);
  await page.getByLabel("Search provider", { exact: true }).selectOption("firecrawl");
  await expect(page.getByRole("status")).toHaveText("Search provider saved.");
  expect(providerWrites).toEqual(["firecrawl"]);
  await page.screenshot({ path: info.outputPath("firecrawl-settings.png"), fullPage: true });
});
test("free search selection discloses fallback without saving keys or searching", async ({ page }) => {
  const writes: unknown[] = [];
  await page.route("**/api/config", route => {
    const body = route.request().postDataJSON(); writes.push(body);
    return route.fulfill({ json: { webSearch: { provider: body.webSearch.provider, tavilyConfigured: false, exaConfigured: false } } });
  });
  await page.goto(origin + "/__search");
  await page.getByLabel("Search provider", { exact: true }).selectOption("auto");
  await expect(page.getByRole("status")).toHaveText("Search provider saved.");
  await expect(page.getByText("No API key required.", { exact: false })).toContainText("DuckDuckGo");
  expect(writes).toEqual([{ webSearch: { provider: "auto" } }]);
});

for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) test("translated search controls save keys with truthful status: " + locale, async ({ page }, info) => {
  const pack = JSON.parse(readFileSync(new URL("../locales/" + locale + ".json", import.meta.url), "utf8"));
  const config = { webSearch: { provider: "engine", tavilyConfigured: false, exaConfigured: false } };
  await page.route("**/api/config", route => {
    const patch = route.request().postDataJSON().webSearch;
    if (patch.provider) config.webSearch.provider = patch.provider;
    if (patch.tavilyApiKey !== undefined) config.webSearch.tavilyConfigured = Boolean(patch.tavilyApiKey);
    return route.fulfill({ json: config });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__search?lang=" + locale);
  await expect(page.getByRole("heading", { name: pack["searchSettings.title"] })).toBeVisible();
  await page.getByLabel(pack["searchSettings.provider"], { exact: true }).selectOption("tavily");
  await page.getByLabel(pack["searchSettings.apiKey"].replace("{provider}", "Tavily"), { exact: true }).fill("fake-key");
  await page.getByRole("button", { name: pack["searchSettings.saveKey"].replace("{provider}", "Tavily"), exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(pack["searchSettings.keySavedNotice"].replace("{provider}", "Tavily"));
  expect(config.webSearch.provider).toBe("tavily");
  await expect(page.getByLabel(pack["searchSettings.apiKey"].replace("{provider}", "Tavily"), { exact: true })).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (["de", "hi"].includes(locale)) await page.screenshot({ path: info.outputPath("search-settings-" + locale + ".png"), fullPage: true });
});

test("browser fallback saves provider separately and replaces or clears write-only keys with confirmed outcomes", async ({ page }) => {
  const config = { webSearch: { provider: "engine", tavilyConfigured: false, exaConfigured: false } };
  const writes: any[] = [];
  let failNext = false;
  let release: (() => void) | undefined;
  let holdNext = false;
  await page.route("**/api/config", async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (holdNext) { holdNext = false; await new Promise<void>(resolve => { release = resolve; }); }
    if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: "Backend body containing sensitive fixture value" } }); }
    if (body.webSearch.provider) config.webSearch.provider = body.webSearch.provider;
    if (Object.hasOwn(body.webSearch, "tavilyApiKey")) config.webSearch.tavilyConfigured = Boolean(body.webSearch.tavilyApiKey);
    if (Object.hasOwn(body.webSearch, "exaApiKey")) config.webSearch.exaConfigured = Boolean(body.webSearch.exaApiKey);
    return route.fulfill({ json: config });
  });
  await page.goto(origin + "/__search");
  await expect(page.getByLabel("Search provider")).toHaveValue("engine");
  await expect(page.getByText("Use the engine's own search first.", { exact: false })).toBeVisible();
  await page.getByLabel("Search provider").selectOption("tavily");
  await expect(page.getByRole("status")).toContainText("Search provider saved");
  const input = page.getByLabel("Tavily API key", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("fixture-tavily-first");
  holdNext = true;
  await page.getByRole("button", { name: "Save Tavily key" }).click();
  await expect(page.getByRole("button", { name: "Save Tavily key" })).toBeDisabled();
  await expect(page.getByLabel("Search provider")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save Tavily key" })).toHaveText("Saving…");
  await expect.poll(() => Boolean(release)).toBe(true); release!();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("Tavily key saved. Search has not been tested.");
  expect(writes.at(-1)).toEqual({ webSearch: { tavilyApiKey: "fixture-tavily-first" } });
  await expect(page.getByLabel("Search provider")).toHaveValue("tavily");
  await input.fill("fixture-tavily-replacement");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  expect(writes.at(-1)).toEqual({ webSearch: { tavilyApiKey: "fixture-tavily-replacement" } });
  failNext = true;
  await page.getByRole("button", { name: "Clear Tavily key" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not remove the Tavily key");
  await expect(page.getByRole("alert")).not.toContainText("Backend body");
  await expect(page.getByRole("button", { name: "Clear Tavily key" })).toBeVisible();
  await page.getByRole("button", { name: "Clear Tavily key" }).click();
  await expect(page.getByRole("status")).toContainText("Tavily key removed");
  await expect(page.getByRole("button", { name: "Clear Tavily key" })).toHaveCount(0);
  expect(writes.at(-1)).toEqual({ webSearch: { tavilyApiKey: "" } });
  await expect(page.getByLabel("Search provider")).toHaveValue("tavily");
  await page.getByLabel("Search provider").selectOption("off");
  await expect(page.getByText(/Independent engine and MCP search tools may still be available/)).toBeVisible();
  await expect(page.getByText(/Connected|Ready/, { exact: true })).toHaveCount(0);
});

test("failed key save retains the typed value without claiming custody or sending a search", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/**", route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 503, json: { error: "fixture failure" } });
  });
  await page.goto(origin + "/__search");
  const input = page.getByLabel("Exa API key", { exact: true });
  await input.fill("fixture-exa-failed");
  await page.getByRole("button", { name: "Save Exa key" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not save the Exa key");
  await expect(input).toHaveValue("fixture-exa-failed");
  await expect(page.getByRole("button", { name: "Clear Exa key" })).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!).pathname).toBe("/api/config");
});

test("desktop keys use secure credential IPC and preserve provider selection", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).fixtureConfig = { webSearch: { provider: "exa", tavilyConfigured: false, exaConfigured: false } };
    (window as any).credentialCalls = [];
    (window as any).muragebox = { setCredential: async (name: string, value: string) => {
      (window as any).credentialCalls.push({ name, value });
      const current = (window as any).fixtureConfig;
      return { webSearch: { ...current.webSearch, [name === "tavilySearchApiKey" ? "tavilyConfigured" : "exaConfigured"]: Boolean(value) } };
    } };
  });
  let httpWrites = 0;
  await page.route("**/api/config", route => { httpWrites++; return route.fulfill({ status: 500, json: {} }); });
  await page.goto(origin + "/__search");
  await page.getByLabel("Tavily API key", { exact: true }).fill("fixture-desktop-tavily");
  await page.getByRole("button", { name: "Save Tavily key" }).click();
  await expect(page.getByLabel("Tavily API key", { exact: true })).toHaveValue("");
  await page.getByLabel("Exa API key", { exact: true }).fill("fixture-desktop-exa");
  await page.getByRole("button", { name: "Save Exa key" }).click();
  await expect(page.getByLabel("Exa API key", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Clear Tavily key" }).click();
  await expect(page.getByRole("status")).toContainText("Tavily key removed");
  await expect(page.getByLabel("Search provider")).toHaveValue("exa");
  expect(httpWrites).toBe(0);
  expect(await page.evaluate(() => (window as any).credentialCalls)).toEqual([
    { name: "tavilySearchApiKey", value: "fixture-desktop-tavily" },
    { name: "exaSearchApiKey", value: "fixture-desktop-exa" },
    { name: "tavilySearchApiKey", value: "" },
  ]);
});

for (const skin of ["light", "dark"]) test("mobile " + skin + " search settings remain readable and keyboard accessible", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__search?provider=tavily&skin=" + skin);
  await expect(page.getByRole("heading", { name: "Web search" })).toBeVisible();
  await expect(page.getByText(/There is no automatic fallback/)).toBeVisible();
  await page.getByLabel("Search provider").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Tavily API key", { exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("search-settings-" + skin + "-mobile.png") });
});
