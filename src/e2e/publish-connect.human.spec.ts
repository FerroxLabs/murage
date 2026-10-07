// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Connect Netlify card and the published-sites list in a real browser at
// phone (390) and desktop (1440) width: no sideways scroll, every control
// reachable, the token field never shows its value. Static fixture, no harness.
// Screenshots land in PUBLISH_CONNECT_SHOTS_DIR when set, else the output dir.
import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  cache = mkdtempSync(join(tmpdir(), "murage-publish-connect-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@/state/store", replacement: "/publish-connect-store" }, { find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "publish-connect-fixture",
      resolveId(id) { if (id === "/publish-connect-store") return "\0publish-connect-store"; },
      load(id) {
        if (id === "\0publish-connect-store") return "export function useStore(){return {state:{bots:[],groups:[],selectedId:null},dispatch(){}};}export async function api(){return {};}";
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__publish" || req.url?.startsWith("/__publish?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publish</title><body style="margin:0"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/src/e2e/publish-connect-fixture.tsx"></script></body></html>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

for (const [label, width, height] of [["390", 390, 4200], ["1440", 1440, 3000]] as const) {
  test(`gallery at ${label}px: nothing scrolls sideways, the token field is empty and hidden`, async ({ page }, info) => {
    page.on("pageerror", (error) => { throw error; });
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/__publish`);
    await page.waitForSelector("[data-shot='connect-start']");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const token = page.locator("[data-shot='connect-token-after-sign-in'] input");
    await expect(token).toHaveAttribute("type", "password");
    expect(await token.inputValue()).toBe("");
    // every button is tall enough to press
    for (const button of await page.locator("button, a[href]").all()) {
      const box = await button.boundingBox();
      if (box) expect.soft(box.height, "a control at least 36px tall").toBeGreaterThanOrEqual(36);
    }
    const dir = process.env.PUBLISH_CONNECT_SHOTS_DIR ?? info.outputDir;
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `publish-connect-${label}.png`), fullPage: true });
  });
}
