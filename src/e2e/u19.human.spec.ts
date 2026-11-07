import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { AppState } from "../state/store";
import { openSidebar } from "./fixtures";

declare global {
  interface Window {
    u19: { patch(next: Partial<AppState>): void; actions: Array<{ type: string; botId?: string; patch?: { name: string } }>; state(): AppState; failSave(): void };
  }
}
let server: ViteDevServer, origin: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({
    configFile: false, root, envFile: false,
    cacheDir: join(process.env.MURAGE_E2E_DATA_DIR!, "vite-u19"),
    resolve: { alias: [
      { find: "@/state/store", replacement: join(root, "src/e2e/u19-store-fixture.tsx") },
      { find: "@", replacement: join(root, "src") },
    ] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "u19-fixture",
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__u19") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/e2e/u19-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });
test.beforeEach(async ({ page }) => {
  // Nothing in this fixture is allowed to reach a provider or another app.
  await page.route("**/*", async (route) => {
    if (!route.request().url().startsWith(origin)) return route.abort();
    if (new URL(route.request().url()).pathname.startsWith("/api/")) return route.fulfill({ json: {} });
    return route.continue();
  });
  page.on("pageerror", (error) => { throw error; });
  await page.goto(origin + "/__u19");
  await expect(page.locator('[data-sidebar-select="a"]')).toBeVisible();
});
const selected = (page: Page, id: string) => expect.poll(() => page.evaluate(() => window.u19.state().selectedId)).toBe(id);
const displayed = (page: Page) => page.locator("[data-sidebar-select]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-select")));

test("shortcuts follow the displayed order during a pending and failed reorder save", async ({ page }) => {
  await openSidebar(page);
  expect(await displayed(page)).toEqual(["a", "b"]);
  const beta = page.locator('[data-sidebar-section-id="section:Beta"]');
  await beta.locator("button[aria-keyshortcuts]").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect.poll(() => displayed(page)).toEqual(["b", "a"]);
  for (const fail of [false, true]) {
    if (fail) {
      await page.evaluate(() => window.u19.failSave());
      // Conversation shortcuts close the phone drawer; reopen it to read the warning.
      await openSidebar(page);
      await expect(page.getByText("Couldn't sync the order to your computer. It is kept on this device for now.")).toBeVisible();
      expect(await displayed(page)).toEqual(["b", "a"]);
    }
    await page.keyboard.press("Control+1");
    await selected(page, "b");
    await page.keyboard.press("Control+Shift+BracketRight");
    await selected(page, "a");
    await page.keyboard.press("Control+Shift+BracketLeft");
    await selected(page, "b");
  }
});

test("Show hidden changes number and cycle shortcuts with the displayed rows", async ({ page }) => {
  await openSidebar(page);
  await page.getByRole("button", { name: "Show hidden (1)" }).click();
  expect(await displayed(page)).toEqual(["a", "b", "h"]);
  await page.keyboard.press("Control+3");
  await selected(page, "h");
  await page.keyboard.press("Control+Shift+BracketLeft");
  await selected(page, "b");
  await page.keyboard.press("Control+3");
  // Selecting a conversation closes the phone drawer, including through a shortcut.
  await openSidebar(page);
  await page.getByRole("button", { name: "Hide hidden bots (1)" }).click();
  expect(await displayed(page)).toEqual(["a", "b"]);
  // Start at the last visible row so stale inclusion of h cannot also wrap to a.
  await page.keyboard.press("Control+2");
  await selected(page, "b");
  await page.keyboard.press("Control+Shift+BracketRight");
  await selected(page, "a");
  await page.keyboard.press("Control+3");
  await selected(page, "a");
});

for (const removed of ["routines", "bots", "groups"] as const) {
  test(`Sidebar clears orphan routine attention after removing ${removed}`, async ({ page }) => {
    await page.evaluate(() => window.u19.patch({
      routines: [{ id: "r" }] as AppState["routines"],
      routineRuns: [{ id: "run", routineId: "r", botId: "a", groupId: "g", status: "failed" }] as AppState["routineRuns"],
      groups: [{ id: "g", name: "Room", memberIds: [], messages: [] }] as unknown as AppState["groups"],
    }));
    await expect(page.locator("[data-routines-attention]")).toHaveCount(1);
    await page.evaluate((key) => window.u19.patch({ [key]: [] }), removed);
    await expect(page.locator("[data-routines-attention]")).toHaveCount(0);
  });
}

for (const location of ["header", "empty"] as const) {
  test(`${location} rename resets identity and focus between same-named bots`, async ({ page }) => {
    const title = page.getByRole("main").getByRole("button", { name: "Rename Same name", exact: true });
    await expect(title).toHaveCount(2);
    const target = location === "header" ? title.first() : title.last();
    await target.focus();
    await page.keyboard.press("Enter");
    const input = page.getByRole("textbox", { name: "Rename", exact: true });
    await expect(input).toBeFocused();
    await input.fill("Uncommitted A");
    // Keep the tree mounted and switch by shortcut while the input owns focus.
    await page.keyboard.press("Control+2");
    await selected(page, "b");
    await expect(input).toHaveCount(0);
    expect(await page.evaluate(() => window.u19.actions.filter((a) => a.type === "updateBot"))).toEqual([]);
    await target.focus();
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("Same name");
    await expect(input).toBeFocused();
    await input.fill("Renamed B");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.u19.actions.filter((a) => a.type === "updateBot"))).toEqual([
      { type: "updateBot", botId: "b", patch: { name: "Renamed B" } },
    ]);
  });
}
