import { test, expect } from "@playwright/test";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { axeScriptPath } from "./axe";

let vite: ViteDevServer, scratch: string, origin: string;
const root = fileURLToPath(new URL("../../", import.meta.url));
const axePath = axeScriptPath;
test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "murage-browser-display-"));
  vite = await createServer({ configFile: false, root, envFile: false, cacheDir: scratch,
    resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{ name: "isolated-browser-display", enforce: "pre",
      resolveId(id) {
        if (id === "/__browser.js") return "\0browser-display-entry";
        if (id === "/__approvals.js") return "\0approval-display-entry";
        if (id === "@/state/store" || id.replaceAll("\\", "/").endsWith("/src/state/store")) return "\0browser-display-store";
      },
      load(id) {
        if (id === "\0approval-display-entry") return `
          import React from 'react';import {createRoot}from'react-dom/client';import {ApprovalCard}from'/src/components/ApprovalCard.tsx';import'/src/styles.css';
          const held='This task started outside the desktop. Your approval is required before this action can continue.';
          createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,...[undefined,'allow','deny'].map(answered=>
            React.createElement('section',{'data-fixture-state':answered||'pending',style:{marginBottom:16}},React.createElement(ApprovalCard,{message:{id:answered||'pending',role:'bot',kind:'options',at:1,card:{title:'Approval',subtitle:'Synthetic web search',tool:'WebSearch',options:['Allow','Deny'],answered,held}}})))));`;
        if (id === "\0browser-display-store") return `
          export const useStore=()=>({state:{config:{browserProfiles:[]}},dispatch:()=>{}});
          export async function api(url,options){
            const f=window.browserFixture;
            if(options?.method==='POST'){if(f.actionError)throw Error(f.actionError);return f.status;}
            f.polls++;
            if(f.failed)throw Error('The bundled browser could not be verified.');
            return url.includes('/frame?')?null:f.status;
          }`;
        if (id === "\0browser-display-entry") return `
          import React from 'react';import {createRoot}from'react-dom/client';
          import {UnifiedBrowserPanel}from'/src/components/UnifiedBrowserPanel.tsx';import'/src/styles.css';
          window.browserFixture={failed:true,actionError:'',polls:0,status:{generation:1,held:false,connected:true,protectedDocument:false,url:'about:blank'}};
          createRoot(document.getElementById('root')).render(React.createElement(UnifiedBrowserPanel,{bot:{id:'fixture',name:'Test bot',busy:false}}));`;
      },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== "/__browser" && req.url !== "/__approvals") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en" data-skin="dark"><head><title>Component state fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:560px;margin:16px auto;padding:12px"></main><script type="module" src="'+(req.url === "/__approvals" ? "/__approvals.js" : "/__browser.js")+'"></script></body></html>');
      }); },
    }, react(), tailwindcss()] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Fixture port missing");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); if (scratch) safeWipeSync(scratch); });

test("resolved approval cards no longer request approval", async ({ page }, info) => {
  await page.route("**/*", route => route.request().url().startsWith(origin) || route.request().url().startsWith("data:") ? route.continue() : route.abort());
  await page.goto(origin + "/__approvals");
  const held = "This task started outside the desktop. Your approval is required before this action can continue.";
  await expect(page.locator('[data-fixture-state="pending"]')).toContainText(held);
  await expect(page.locator('[data-fixture-state="allow"]')).toContainText("Allowed");
  await expect(page.locator('[data-fixture-state="deny"]')).toContainText("Denied");
  await expect(page.locator('[data-fixture-state="allow"]')).not.toContainText(held);
  await expect(page.locator('[data-fixture-state="deny"]')).not.toContainText(held);
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`approval-states-${width}.png`), fullPage: true });
  }
});

test("connection failure is truthful and recovery clears only the connection error", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(origin) || route.request().url().startsWith("data:") ? route.continue() : route.abort());
  await page.goto(origin + "/__browser");
  await expect(page.getByText("Browser unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Connecting to browser…", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("could not be verified");
  for (const width of [390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`unavailable-${width}.png`), fullPage: true });
  }
  await page.evaluate(() => { (window as unknown as { browserFixture: { failed: boolean } }).browserFixture.failed = false; });
  await expect(page.getByText("Waiting for the page…", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.evaluate(() => { (window as unknown as { browserFixture: { actionError: string } }).browserFixture.actionError = "Control permission refused"; });
  const button = page.getByRole("button", { name: "Take control", exact: true });
  await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Control permission refused");
  const before = await page.evaluate(() => (window as unknown as { browserFixture: { polls: number } }).browserFixture.polls);
  await expect.poll(() => page.evaluate(() => (window as unknown as { browserFixture: { polls: number } }).browserFixture.polls)).toBeGreaterThan(before + 1);
  await expect(page.getByRole("alert")).toHaveText("Control permission refused");
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => (await (window as unknown as { axe: { run(): Promise<{ violations: { impact: string }[] }> } }).axe.run()).violations.filter(v => ["serious", "critical"].includes(v.impact)));
  expect(violations).toEqual([]); expect(errors).toEqual([]);
  if (process.env.MURAGE_LIGHTHOUSE_CLI) {
    const output = info.outputPath("lighthouse.json");
    await promisify(execFile)(process.execPath, [process.env.MURAGE_LIGHTHOUSE_CLI, origin + "/__browser", "--quiet", "--chrome-flags=--headless=new --no-sandbox", "--only-categories=performance,accessibility", "--output=json", `--output-path=${output}`], { timeout: 45000 });
    const report = JSON.parse(readFileSync(output, "utf8"));
    console.log("Isolated browser-state fixture Lighthouse", JSON.stringify(Object.fromEntries(Object.entries(report.categories).map(([key, value]) => [key, (value as { score: number }).score]))));
  }
});
