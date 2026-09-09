import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSidebar } from "./fixtures.ts";

let fixture: { info: { url: string; dataDir: string }; close(): Promise<void> }, vite: ViteDevServer, origin: string;
test.beforeAll(async () => {
  const { launchVerificationServer } = await import(new URL("../../scripts/control-murage.ts", import.meta.url).href);
  fixture = await launchVerificationServer(process.env);
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    vite = await createServer({ configFile: false, root, envFile: false, cacheDir: join(fixture.info.dataDir, "polish-vite-cache"), resolve: { alias: { "@": join(root, "src") } }, plugins: [react(), tailwindcss()], server: { host: "127.0.0.1", watch: null, hmr: false, proxy: { "/api": { target: fixture.info.url } } } });
    await vite.listen(0); const address = vite.httpServer!.address(); if (!address || typeof address === "string") throw Error("No integration fixture port"); origin = `http://127.0.0.1:${address.port}`;
  } catch (error) { await vite?.close(); await fixture.close(); throw error; }
});
test.afterAll(async () => { try { await vite?.close(); } finally { await fixture?.close(); } });
for (const skin of ["light", "dark"]) test("integrated Tools shortcut search and Escape restores focus in " + skin, async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(skin => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); localStorage.setItem("murage-skin", skin); }, skin);
  await page.goto(origin); const sidebar = await openSidebar(page);
  const trigger = sidebar.getByRole("button", { name: /^Tools/ }); await trigger.click();
  await sidebar.getByRole("menuitem", { name: "Keyboard shortcuts", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }); await expect(dialog).toBeVisible();
  const search = dialog.getByRole("textbox", { name: "Search shortcuts" }); await expect(search).toBeFocused(); await search.fill("Search and switch conversations");
  await expect(dialog.getByRole("term")).toHaveText(["Search and switch conversationsCommand palette"]);
  await expect(dialog.locator("kbd").last()).toHaveText("K");
  await page.screenshot({ path: info.outputPath("tools-shortcuts-" + skin + ".png"), fullPage: true });
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
});
