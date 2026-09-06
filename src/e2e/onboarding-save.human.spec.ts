import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePortBlock } from "../../server/testing/ports";

// Actual onboarding + API helper, isolated HTTP fixture. No subscription,
// provider, native permission or live installation call leaves this server.
let server: ViteDevServer;
let origin: string;
let cache: string;
let mode: "success" | "hold" | "reject" | "malformed";
let release: (() => void) | undefined;
let writes: Array<{ proof: string; profile: { name: string; email: string } }>;
let subscriptions: number;
const proof = "7a".repeat(32);

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-onboarding-vite-"));
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [{
      name: "onboarding-save-fixture",
      resolveId(id) { if (id === "/__onboarding.js") return "\0onboarding-save-fixture"; },
      load(id) {
        if (id !== "\0onboarding-save-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { Onboarding } from '/src/components/Onboarding.tsx';
          createRoot(document.getElementById('root')).render(React.createElement(Onboarding, {onDone:()=>{}}));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          const json = (body: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          if (path === "/__onboarding") {
            res.setHeader("content-type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/__onboarding.js"></script>');
          } else if (path === "/api/desktop-secret") json({ secret: proof });
          else if (path === "/api/config" && req.method === "GET") {
            json({ surface: req.headers["x-murage-surface-secret"] === proof ? "desktop" : "remote" });
          } else if (path === "/api/config" && req.method === "PUT") {
            let body = "";
            req.on("data", (chunk) => { body += chunk; });
            req.on("end", () => {
              const profile = JSON.parse(body).profile;
              const received = String(req.headers["x-murage-surface-secret"] ?? "");
              writes.push({ proof: received, profile });
              if (received !== proof) return json({ error: "no such route" }, 404);
              if (mode === "reject") return json({ error: "Fixture profile save unavailable" }, 503);
              if (mode === "malformed") return json({ error: "Unconfirmed success" });
              if (mode === "hold") { release = () => json({ profile }); return; }
              json({ profile });
            });
          } else if (path === "/api/subscribe") { subscriptions++; json({ ok: true }); }
          else if (path === "/api/instances") json({ instances: [] });
          else if (path.startsWith("/api/")) json({ error: "Unexpected fixture route" }, 404);
          else next();
        });
      },
    }],
  });
  await server.listen(await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.beforeEach(() => { mode = "success"; writes = []; subscriptions = 0; release = undefined; });
test.afterEach(() => { release?.(); release = undefined; });
test.afterAll(async () => { await server?.close(); if (cache) rmSync(cache, { recursive: true, force: true }); });

async function fill(page: import("@playwright/test").Page) {
  await page.goto(`${origin}/__onboarding`);
  await page.getByPlaceholder("Your name").fill("Fixture Person");
  await page.getByPlaceholder("you@example.com").fill("Fixture@Example.test");
}

test("onboarding saves the profile with desktop proof before continuing", async ({ page }) => {
  await fill(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ proof, profile: { name: "Fixture Person", email: "fixture@example.test" } });
  await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
  await expect.poll(() => subscriptions).toBe(1);
});

test("onboarding holds pending state and submits only once", async ({ page }) => {
  mode = "hold";
  await fill(page);
  await page.getByPlaceholder("you@example.com").press("Enter");
  await expect.poll(() => writes.length).toBe(1);
  await expect(page.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  expect(subscriptions).toBe(0);
  release?.();
  release = undefined;
  await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
  expect(writes).toHaveLength(1);
});

test("onboarding retains a failed profile draft and permits an explicit retry", async ({ page }) => {
  mode = "reject";
  await fill(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Fixture profile save unavailable");
  await expect(page.getByPlaceholder("Your name")).toHaveValue("Fixture Person");
  await expect(page.getByPlaceholder("you@example.com")).toHaveValue("Fixture@Example.test");
  expect(subscriptions).toBe(0);
  mode = "success";
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
  expect(writes).toHaveLength(2);
  await expect.poll(() => subscriptions).toBe(1);
});

test("onboarding does not accept an unconfirmed successful response", async ({ page }) => {
  mode = "malformed";
  await fill(page);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  expect(subscriptions).toBe(0);
  await page.getByRole("button", { name: "Maybe later", exact: true }).click();
  await expect(page.getByPlaceholder("you@example.com")).toHaveCount(0);
});
