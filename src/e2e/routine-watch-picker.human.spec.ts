import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-watch-picker-ui-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: [{ find: "@/state/store", replacement: "/watch-fixture-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "watch-picker-fixture", resolveId(id) { if (id === "/__watch.js") return "\0watch-fixture"; if (id === "/watch-fixture-store") return "\0watch-store"; },
      load(id) {
        if (id === "\0watch-store") return "export async function api(path,init){const r=await fetch(path,init);const d=await r.json();if(!r.ok)throw new Error(d.error);return d}export function useStore(){return {dispatch:value=>(window.actions??=[]).push(value)}}";
        if (id !== "\0watch-fixture") return;
        return "import React from 'react';import{createRoot}from'react-dom/client';import{RoutineWatchPicker}from'/src/components/RoutineWatchPicker.tsx';import'/src/styles.css';document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'dark';createRoot(document.getElementById('root')).render(React.createElement(RoutineWatchPicker,{bots:[{id:'worker',name:'Worker',threadId:'worker-thread'}],onClose:()=>{window.watchPickerClosed=true}}));";
      }, configureServer(vite) { vite.middlewares.use((req, res, next) => { if (!req.url?.startsWith("/__watch")) return next(); if (req.url.startsWith("/__watch.js")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>File watch fixture</title><body style="background:var(--color-app);margin:0"><main id="root"></main><script type="module" src="/__watch.js"></script>'); }); },
    }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
async function routeFiles(page: Page, unavailable = false) {
  const proposals: unknown[] = [];
  await page.route("**/api/bots/worker/watch-files?*", route => unavailable ? route.fulfill({ status: 409, json: { error: "Choose an existing working folder for this bot before creating a file watch" } })
    : route.fulfill({ json: new URL(route.request().url()).searchParams.get("directory") === "reports"
      ? { directory: "reports", entries: [{ name: "status.txt", relativePath: "reports/status.txt", directory: false }], truncated: false }
      : { directory: "", entries: [{ name: "reports", relativePath: "reports", directory: true }], truncated: false } }));
  await page.route("**/api/bots/worker/watch-proposal", async route => { proposals.push(route.request().postDataJSON()); await route.fulfill({ status: 201, json: { botId: "chief", threadId: "chief-thread", messageId: "confirmation-message" } }); });
  return proposals;
}
for (const width of [390, 820, 1440]) test(`file choice and confirmation handoff at ${width}px`, async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const proposals = await routeFiles(page); await page.setViewportSize({ width, height: 900 });
  await page.goto(origin + "/__watch" + (width === 820 ? "?skin=light" : "")); await page.waitForLoadState("networkidle");
  await expect(page.getByRole("dialog", { name: "Watch a file" })).toBeVisible();
  await expect(page.getByLabel("Working folder for")).toBeFocused();
  await expect(page.getByRole("button", { name: "Review in chat" })).toBeDisabled();
  await page.getByRole("button", { name: "reports/", exact: true }).click();
  await page.getByRole("radio", { name: "status.txt" }).check();
  await expect(page.getByRole("button", { name: "Review in chat" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`file-watch-${width}.png`), fullPage: true });
  await page.getByRole("button", { name: "Review in chat" }).click();
  await expect.poll(() => proposals.length).toBe(1);
  expect(proposals[0]).toMatchObject({ relativePath: "reports/status.txt", everyMinutes: 15, maxChecks: 100 });
  expect(await page.evaluate(() => (window as unknown as { actions: unknown[] }).actions)).toEqual([
    { type: "select", id: "chief", threadId: "chief-thread" }, { type: "focusMessage", threadId: "chief-thread", messageId: "confirmation-message" },
  ]);
  expect(errors).toEqual([]);
});
test("missing working folder is explicit and cannot activate a watch", async ({ page }) => {
  const proposals = await routeFiles(page, true); await page.goto(origin + "/__watch");
  await expect(page.getByRole("alert")).toContainText("Choose an existing working folder");
  await expect(page.getByRole("button", { name: "Review in chat" })).toBeDisabled(); expect(proposals).toEqual([]);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { watchPickerClosed: boolean }).watchPickerClosed)).toBe(true);
});
