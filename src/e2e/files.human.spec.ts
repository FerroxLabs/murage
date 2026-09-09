import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { artifactsRequest, initializeArtifacts, type ArtifactAccess } from "../../server/artifacts.ts";
import type { ArtifactQuery, ArtifactRegistration } from "../../shared/artifacts.ts";
let root: string, workspace: string, storage: string, origin: string, server: ViteDevServer, db: DatabaseSync;
let leakedRequests = 0;
const proof = "files-fixture-proof";
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "murage-files-browser-")); workspace = join(root, "workspace"); storage = join(root, "artifact-files"); mkdirSync(workspace);
  db = new DatabaseSync(join(root, "messages.db")); initializeArtifacts(db);
  const access: ArtifactAccess = { owner: true, scopes: [{ botId: "research", botName: "Research bot", threadId: "task", runId: "routine-run", workspaceRoot: workspace }] };
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"), resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
    name: "files-http-fixture", resolveId(id) { if (id === "/__files.js") return "\0files-fixture"; },
    load(id) { if (id !== "\0files-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {Files} from '/src/components/Files.tsx';import '/src/styles.css';window.__artifactBridgeProbe=0;createRoot(document.getElementById('root')).render(React.createElement(Files,{bots:[{id:'research',name:'Research bot',threadId:'task',tasks:[{threadId:'task',title:'Weekly report'}]}],initialBotId:'research'}));`; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/leak") { leakedRequests++; res.end("Unexpected request"); return; }
      if (url.pathname === "/__files") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__files.js"></script>'); return; }
      if (url.pathname === "/api/desktop-secret") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ secret: proof })); return; }
      if (!url.pathname.startsWith("/api/artifacts")) return next();
      let encoded = ""; for await (const chunk of req) { encoded += String(chunk); if (encoded.length > 16_384) { res.statusCode = 413; res.end(); return; } }
      try {
        const query: ArtifactQuery = {};
        for (const key of ["query", "botId", "threadId", "kind"] as const) if (url.searchParams.has(key)) (query as Record<string, unknown>)[key] = url.searchParams.get(key);
        for (const key of ["since", "until", "page", "pageSize"] as const) if (url.searchParams.has(key)) query[key] = Number(url.searchParams.get(key));
        const response = artifactsRequest(db, storage, { method: req.method ?? "GET", path: url.pathname, query, body: encoded ? JSON.parse(encoded) as ArtifactRegistration : undefined }, { ...access, owner: req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof });
        res.statusCode = response.status; for (const [key, value] of Object.entries(response.headers ?? {})) if (value !== undefined) res.setHeader(key, value);
        if (response.bytes) res.end(response.bytes); else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response.body)); }
      } catch { res.statusCode = 500; res.end(JSON.stringify({ error: "Fixture request failed" })); }
    }); },
  }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw Error("Files fixture did not bind"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

for (const skin of ["light", "dark"]) for (const width of [390, 1440]) test(`verified HTML saved preview/download is isolated at ${width}px ${skin}`, async ({ page, request }, testInfo) => {
  const relativePath = `report-${width}-${skin}.html`, name = `Weekly report ${width} ${skin}`;
  const content = `<h1>${name}</h1><p>Three verified updates.</p><script>parent.__artifactBridgeProbe=99;fetch('${origin}/leak?script')</script><img src="${origin}/leak?image"><iframe src="${origin}/leak?frame"></iframe><meta http-equiv="refresh" content="0;url=${origin}/leak?navigation"><a href="${origin}/leak?link">Untrusted link</a><style>body{font:16px system-ui;padding:24px;color:#162033}p{background-image:url('${origin}/leak?css')}</style>`;
  writeFileSync(join(workspace, relativePath), content); const beforeLeaks = leakedRequests;
  expect((await request.get(origin + "/api/artifacts")).status()).toBe(404);
  await page.setViewportSize({ width, height: 900 }); await page.goto(origin + "/__files");
  await page.evaluate(skin => document.documentElement.dataset.skin = skin, skin);
  await page.getByText("Save an existing workspace file", { exact: true }).click();
  await page.getByRole("textbox", { name: "Relative file path", exact: true }).fill(relativePath);
  await page.getByRole("textbox", { name: "Friendly name (optional)", exact: true }).fill(name);
  await page.getByRole("button", { name: "Verify and save file", exact: true }).click();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card).toBeVisible();
  await page.getByRole("searchbox", { name: "Search files" }).fill(name); await page.getByRole("searchbox", { name: "Search files" }).press("Enter");
  await expect(page.locator("article")).toHaveCount(1);
  await card.getByRole("button", { name: "Preview", exact: true }).click();
  const frame = page.frameLocator(`iframe[title="Preview ${name}"]`);
  await expect(frame.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(frame.locator("script,iframe,meta[http-equiv=refresh]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __artifactBridgeProbe: number }).__artifactBridgeProbe)).toBe(0);
  await frame.getByText("Untrusted link", { exact: true }).click();
  const iframe = page.frames().find(frame => frame.url() === "about:srcdoc")!;
  expect(await iframe.evaluate(() => { try { return window.parent.location.href; } catch { return "blocked"; } })).toBe("blocked");
  expect(await iframe.evaluate(() => { try { return localStorage.getItem("credential-canary"); } catch { return "blocked"; } })).toBe("blocked");
  expect(leakedRequests).toBe(beforeLeaks);
  const download = page.waitForEvent("download"); await card.getByRole("button", { name: "Download", exact: true }).click();
  const downloaded = await download; expect(downloaded.suggestedFilename()).toBe(`${name}.html`);
  expect(createHash("sha256").update(readFileSync((await downloaded.path())!)).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
  writeFileSync(join(workspace, relativePath), "<h1>Changed original</h1>");
  await page.getByRole("button", { name: "Refresh", exact: true }).click(); await expect(card).toContainText("Original file has changed");
  await card.getByRole("button", { name: "Preview", exact: true }).click(); await expect(frame.getByRole("heading", { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`files-${width}-${skin}.png`), fullPage: true });
  await page.getByRole("region", { name: "File preview", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`files-preview-${width}-${skin}.png`), fullPage: true });
});
