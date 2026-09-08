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
  cache = mkdtempSync(join(tmpdir(), "murage-provider-error-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false, optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react"] }, resolve: { alias: { "@": root + "/src" } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "provider-error-fixture",
      resolveId(id) { if (id === "/__provider.js") return "\0provider-error-fixture"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== "\0provider-error-fixture") return;
        return "import React from 'react';import {createRoot} from 'react-dom/client';import {ProviderErrorCard} from '/src/components/ProviderErrorCard.tsx';import {RuntimeErrorCard} from '/src/components/RuntimeErrorCard.tsx';import {setLocale} from '/src/lib/i18n.ts';import '/src/styles.css';const q=new URLSearchParams(location.search);setLocale(q.get('lang')||'en');document.documentElement.dataset.skin=q.get('skin')||'dark';window.retryCalls=0;window.settingsCalls=0;createRoot(document.getElementById('root')).render(React.createElement(q.has('runtime')?RuntimeErrorCard:ProviderErrorCard,{message:'Internal error',details:q.has('detail')?'Internal error — diagnostic text beyond a short badge. Provider response: HTTP 500. Engine error code: -32603. <script>window.injected=true</script>':undefined,info:{kind:q.get('kind')||'credits',httpStatus:Number(q.get('status')||402),...(q.get('provider')==='flux-router'?{provider:'flux-router'}:{})},onRetry:q.has('noRetry')?undefined:()=>window.retryCalls++,onOpenProviderSettings:()=>window.settingsCalls++}));";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__provider?") && req.url !== "/__provider") return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main style="padding:24px;max-width:760px;margin:40px auto" id="root"></main><script type="module" src="/__provider.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });

for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) test("provider recovery renders translated actions on mobile: " + locale, async ({ page }, info) => {
  const pack = JSON.parse(readFileSync(new URL("../locales/" + locale + ".json", import.meta.url), "utf8"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&lang=" + locale);
  await expect(page.getByRole("heading", { name: pack["providerError.credits.title"].replace("{provider}", "Flux Router") })).toBeVisible();
  await expect(page.getByRole("button", { name: pack["providerError.settings"], exact: true })).toBeVisible();
  await page.getByRole("button", { name: pack["providerError.retry"], exact: true }).click();
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(1);
  await page.getByText(pack["providerError.details"], { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(pack["providerError.status"].replace("{status}", "402"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (["de", "ja"].includes(locale)) await page.screenshot({ path: info.outputPath("provider-error-" + locale + ".png"), fullPage: true });
});

test("Flux credits render a billing action, useful recovery details and keyboard-only manual actions", async ({ page }, info) => {
  await page.setViewportSize({ width: 980, height: 780 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&skin=dark");
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(page.getByRole("heading", { name: "Flux Router needs credits" })).toBeVisible();
  await expect(alert).toContainText("How to continue");
  const billing = page.getByRole("link", { name: "Add Flux credits" });
  await expect(billing).toHaveAttribute("href", "https://fluxrouter.ai/home/billing");
  await expect(billing).toHaveAttribute("rel", "noopener noreferrer");
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  await billing.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Provider settings" })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).settingsCalls)).toBe(1);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(1);
  await page.getByText("Technical details", { exact: true }).click();
  await expect(alert).toContainText("Provider response: HTTP 402");
  await expect(alert).not.toContainText("request ID");
  await page.screenshot({ path: info.outputPath("flux-credits-dark-desktop.png") });
});

for (const skin of ["light", "dark"]) test("provider recovery card fits mobile in " + skin, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__provider?provider=flux-router&kind=credits&status=402&skin=" + skin);
  await expect(page.getByRole("alert")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const label of ["Provider settings", "Retry"]) {
    const bounds = await page.getByRole("button", { name: label, exact: true }).boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
  }
  await page.screenshot({ path: info.outputPath("flux-credits-" + skin + "-mobile.png") });
});

test("other provider failures use fixed recovery categories and never gain a billing link", async ({ page }) => {
  const scenarios = [
    { kind: "credits", status: 402, title: /needs credits/, resolution: /choose another configured engine/ },
    { kind: "authentication", status: 401, title: /could not authenticate/, resolution: /sign-in or API-key configuration/ },
    { kind: "permission", status: 403, title: /denied access/, resolution: /account has access/ },
    { kind: "rate-limit", status: 429, title: /request limit reached/, resolution: /limit and reset time before retrying/ },
    { kind: "unavailable", status: 503, title: /temporarily unavailable/, resolution: /Retry later/ },
  ];
  for (const scenario of scenarios) {
    await page.goto(origin + "/__provider?kind=" + scenario.kind + "&status=" + scenario.status + "&skin=light&noRetry=1");
    await expect(page.getByRole("heading", { name: scenario.title })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(scenario.resolution);
    await expect(page.getByRole("link")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  }
});

for (const width of [390, 1000]) test(`runtime errors explain missing context and expand received details at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin + "/__provider?runtime=1");
  await expect(page.getByRole("heading", { name: "This request hit a problem" })).toBeVisible();
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.getByText("No additional error details were supplied by the engine.")).toBeVisible();
  expect(await page.evaluate(() => (window as any).retryCalls)).toBe(0);
  await page.goto(origin + "/__provider?runtime=1&detail=1");
  await page.getByText("Technical details", { exact: true }).click();
  await expect(page.locator("pre")).toContainText("Engine error code: -32603");
  await expect(page.locator("pre")).toContainText("<script>");
  expect(await page.evaluate(() => (window as any).injected)).toBeUndefined();
  await page.getByRole("button", { name: "Provider settings", exact: true }).click();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  expect(await page.evaluate(() => [(window as any).settingsCalls, (window as any).retryCalls])).toEqual([1, 1]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`runtime-error-${width}.png`), fullPage: true });
});
