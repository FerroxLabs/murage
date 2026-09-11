import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { safeWipe } from "../../server/testing/safe-wipe.mjs";
const pack = (locale: string) => JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8")) as Record<string, string>;
let vite: ViteDevServer, origin: string, temporary: string;
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "murage-account-locale-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, envFile: false, root, cacheDir: join(temporary, "vite"),
    resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{ name: "account-locale-fixture", enforce: "pre", resolveId(id, importer) {
      if (id === "/__account.js") return "\0account-entry";
      if (importer?.endsWith("ClaudeAccountsSettings.tsx") && (id.endsWith("/state/store") || id.endsWith("/state/store.tsx"))) return "\0account-api";
    }, load(id) {
      if (id === "\0account-api") return `export const api=async(path,options)=>{if(options?.method){await new Promise(resolve=>setTimeout(resolve,100));throw null}return {accounts:[{instanceId:'fixture',displayName:'Work',managed:true,isDefault:false,configDir:'/synthetic/unused',signInCommand:'SYNTHETIC_COMMAND_NOT_EXECUTED',signInShell:'powershell',snapshot:{state:'available',authenticated:false}}]}};`;
      if (id === "\0account-entry") return `import React from 'react';import {createRoot} from 'react-dom/client';import {setLocale} from '/src/lib/i18n.ts';import {ClaudeAccountsSettings} from '/src/components/ClaudeAccountsSettings.tsx';import '/src/styles.css';setLocale(new URLSearchParams(location.search).get('locale'));Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{}}});createRoot(document.getElementById('root')).render(React.createElement(ClaudeAccountsSettings));`;
    }, configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__account?")) return next();
      res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><main id="root" style="height:100dvh;overflow:auto;padding:16px;max-width:900px;margin:auto"></main><script type="module" src="/__account.js"></script>');
    }); } }, react(), tailwindcss()] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); if (temporary) await safeWipe(temporary); });
for (const width of [390, 1440]) for (const locale of ["zz", "de"]) test(`account action copy ${locale} at ${width}`, async ({ page }, info) => {
  const catalog = pack(locale === "zz" ? "en" : locale);
  const text = (key: string) => catalog[`claudeAccounts.${key}`].replaceAll("{name}", "Work").replaceAll("{shell}", "PowerShell");
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/__account?locale=${locale}`);
  await expect(page.getByText(text("safety"), { exact: true })).toBeVisible();
  await page.getByText(text("instructionsTitle"), { exact: true }).click();
  await expect(page.getByText(text("instructions"), { exact: true })).toBeVisible();
  const copy = page.getByRole("button", { name: text("copySignIn"), exact: true });
  await copy.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText(text("copied"));
  await page.getByRole("button", { name: "Remove Work account", exact: true }).click();
  await expect(page.getByText(text("removeConfirm"), { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: text("confirmRemoval"), exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.getElementById("root")!.scrollWidth <= document.getElementById("root")!.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`accounts-${locale}-${width}.png`) });
  await page.getByRole("button", { name: text("confirmRemoval"), exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(text("changeError"));
  await expect(page.getByRole("button", { name: text("refresh"), exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
