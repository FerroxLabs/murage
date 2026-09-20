// The engine step of onboarding, on a machine that has a lot of engines.
//
// Two things were wrong at 1440x900, and both are about the first minute of
// the app rather than anything exotic:
//
//  1. Choosing Fuigo — the engine included with Murage — opened its setup
//     panel BELOW the whole engine list, so on a laptop screen the only
//     thing that could finish the setup ("Open Flux Router in Models") was
//     off screen with nothing saying so.
//  2. The OpenAI-compatible engine has no official logo, and its fallback
//     mark was `size-full`: as a flex item it took the whole row, so that
//     row was a blank square with no name on it.
//
// Real Onboarding, real ProviderMark, real EngineSetup; only the backend is
// a fixture, and it never returns a credential or runs a model.
import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigStatus } from "../state/store";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;
let pageErrors: string[] = [];
const proof = "cd".repeat(32);
const config: ConfigStatus = {
  composio: { configured: false, mode: "managed" },
  box: { configured: false },
  vps: { configured: false, sshAlias: "" },
  rooms: { turnTimeoutMinutes: 15 },
  localVm: { mode: "shared", maxInstances: 1 },
  flux: { configured: false },
  profile: { name: "", email: "" },
};

// A real-looking spread: Fuigo first (as it ships), the OpenAI-compatible
// engine with no logo of its own, and enough others to push anything below
// the list off a 900px-tall screen.
const OTHERS = [
  ["claudeAgent", "Claude Code"], ["codex", "Codex"], ["grokAgent", "Grok"], ["kimiAgent", "Kimi"],
  ["droidAgent", "Droid"], ["cursorAgent", "Cursor"], ["opencodeGo", "OpenCode"], ["qwenAgent", "Qwen"],
  ["hermesAgent", "Hermes"], ["antigravityAgent", "Antigravity"], ["piAgent", "Pi"], ["boxAgent", "Box"],
] as const;
const instances = [
  { instanceId: "fuigo", driverKind: "fuigoAgent", displayName: "Fuigo", enabled: true, access: "subscription", models: { default: "", options: [] }, snapshot: { state: "available", authenticated: false }, install: {} },
  { instanceId: "openai-compat", driverKind: "openai-compat", displayName: "OpenAI-compatible", enabled: true, access: "custom", models: { default: "", options: [] }, snapshot: { state: "unavailable" }, install: {} },
  ...OTHERS.map(([driverKind, displayName]) => ({
    instanceId: driverKind, driverKind, displayName, enabled: true, access: "subscription",
    models: { default: "", options: [] }, snapshot: { state: "available", authenticated: false }, install: {},
  })),
];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-onboarding-engine-vite-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "onboarding-engine-fixture",
      resolveId(id) { if (id === "/__engine-step.js") return "\0onboarding-engine-fixture"; },
      load(id) {
        if (id.endsWith("/src/styles.css")) return readFileSync(id, "utf8").replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source "./components";');
        if (id !== "\0onboarding-engine-fixture") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';import {StoreProvider} from '/src/state/store.tsx';import {Onboarding} from '/src/components/Onboarding.tsx';import '/src/styles.css';
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider,null,React.createElement(Onboarding,{onDone:()=>{}})));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? "/", "http://fixture").pathname;
        const json = (value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
        if (path === "/__engine-step") { res.setHeader("content-type", "text/html"); res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Engine step fixture</title></head><body><div id="root"></div><script type="module" src="/__engine-step.js"></script></body></html>'); }
        else if (path === "/api/desktop-secret") json({ secret: proof });
        else if (path === "/api/config" && req.method === "GET") json({ ...config, surface: "desktop" });
        else if (path === "/api/instances") json({ instances });
        else if (path === "/api/bots") json({ bots: [], groups: [] });
        else if (path === "/api/flux-connection") json({ configured: false, revision: "fixture", conflict: false, choices: [] });
        else if (path === "/api/provider-connections" && req.method === "GET") json({ connections: [], storage: "local-config" });
        else if (path.startsWith("/api/") && !["GET", "HEAD"].includes(req.method ?? "GET")) json({ error: "Unexpected fixture write" }, 409);
        else if (path.startsWith("/api/")) json({ error: "Unused fixture read" }, 404);
        else next();
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(async ({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); await page.route("https://**/*", route => route.abort()); });
test.afterEach(() => { expect(pageErrors).toEqual([]); });
test.afterAll(async () => { await server?.close(); if (cache) safeWipeSync(cache); });

async function engineStep(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => { localStorage.setItem("murage-email-gate", "skipped"); localStorage.setItem("murage-flux-invite-dismissed", "1"); });
  await page.goto(`${origin}/__engine-step`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Choose your first outcome").getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "Choose an engine", exact: true })).toBeVisible();
}

test("the included engine's setup is on screen with a full list of engines", async ({ page }, testInfo) => {
  await engineStep(page);
  const list = page.getByLabel("Choose an engine");
  // a real machine's worth of engines, not a one-row fixture
  expect(await list.getByRole("button").count()).toBeGreaterThanOrEqual(14);

  await list.getByRole("button", { name: /Fuigo/ }).click();
  const finish = page.getByRole("button", { name: "Open Flux Router in Models", exact: true });
  await expect(finish).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("engine-step-1440.png") });
  // the point of the finding: visible in the DOM is not visible on a laptop
  await expect(finish).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the engine with no logo still shows its name", async ({ page }, testInfo) => {
  await engineStep(page);
  const row = page.getByLabel("Choose an engine").getByRole("button", { name: /OpenAI-compatible/ });
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("openai-compatible-row.png") });
  const mark = await row.evaluate(node => {
    const span = node.querySelector("span");
    const rect = span!.getBoundingClientRect();
    return { markWidth: rect.width, rowWidth: node.getBoundingClientRect().width };
  });
  // the fallback initial is a mark, not the row
  expect(mark.markWidth).toBeLessThan(mark.rowWidth / 4);
  await expect(row).toContainText("OpenAI-compatible");
});
