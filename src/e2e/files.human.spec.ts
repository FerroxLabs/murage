import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { artifactsRequest, initializeArtifacts, type ArtifactAccess } from "../../server/artifacts.ts";
import { sendDelegated } from "../../server/route-delegation.ts";
import { workspaceFilesRoute, type WorkspaceFilesDeps } from "../../server/workspace-files.ts";
import type { ArtifactQuery, ArtifactRegistration } from "../../shared/artifacts.ts";
import { WORKSPACE_FILES_ROUTE_PREFIX } from "../../shared/workspace-files.ts";
let root: string, dataDir: string, workspace: string, storage: string, origin: string, server: ViteDevServer, db: DatabaseSync;
let leakedRequests = 0;
const proof = "files-fixture-proof";
// The same three shapes Files has to tell apart: a resolved working folder, a
// legacy conversation pinned to no workspace at all, and one whose files live
// on a remote computer.
const fixtureBots = [
  { id: "research", name: "Research bot", threadId: "task", tasks: [{ threadId: "task", title: "Weekly report" }] },
  { id: "legacy", name: "Legacy bot", threadId: "old", tasks: [{ threadId: "old", title: "Older task" }] },
  { id: "remote", name: "Remote bot", threadId: "remote-task", tasks: [{ threadId: "remote-task", title: "Cloud run" }] },
];
test.beforeAll(async () => {
  // Resolved once, because the server answers with the real path it opened.
  root = realpathSync(mkdtempSync(join(tmpdir(), "murage-files-browser-")));
  // Murage's own data folder is never a workspace, so the browsed folder has
  // to live outside it exactly as it does in the app.
  dataDir = join(root, "data"); workspace = join(root, "workspace"); storage = join(dataDir, "artifact-files");
  mkdirSync(workspace); mkdirSync(dataDir);
  writeFileSync(join(dataDir, "routines.json"), JSON.stringify({ runs: [{ runOn: "cloud", botId: "remote", threadId: "remote-task" }] }));
  db = new DatabaseSync(join(root, "messages.db")); initializeArtifacts(db);
  const access: ArtifactAccess = { owner: true, scopes: [{ botId: "research", botName: "Research bot", threadId: "task", runId: "routine-run", workspaceRoot: workspace }] };
  const workspaceDeps: WorkspaceFilesDeps = {
    dataDir,
    database: () => db,
    store: {
      bots: [
        { id: "research", name: "Research bot", threadId: "task", resumeCursors: {}, tasks: [{ threadId: "task", cwd: workspace, resumeCursors: {} }] },
        { id: "legacy", name: "Legacy bot", threadId: "old", resumeCursors: {}, tasks: [{ threadId: "old", cwd: null, resumeCursors: {} }] },
        { id: "remote", name: "Remote bot", threadId: "remote-task", resumeCursors: {}, tasks: [{ threadId: "remote-task", cwd: null, resumeCursors: {} }] },
      ],
      groups: [],
    } as never,
    artifactScopes: () => [...access.scopes],
  };
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({ configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"), resolve: { alias: { "@": join(repo, "src") } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [react(), tailwindcss(), {
    name: "files-http-fixture", resolveId(id) { if (id === "/__files.js") return "\0files-fixture"; },
    load(id) { if (id !== "\0files-fixture") return; return `import React from 'react';import {createRoot} from 'react-dom/client';import {Files} from '/src/components/Files.tsx';import '/src/styles.css';window.__artifactBridgeProbe=0;createRoot(document.getElementById('root')).render(React.createElement(Files,{bots:${JSON.stringify(fixtureBots)},initialBotId:'research'}));`; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname === "/leak") { leakedRequests++; res.end("Unexpected request"); return; }
      if (url.pathname === "/__files") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__files.js"></script>'); return; }
      if (url.pathname === "/api/desktop-secret") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ secret: proof })); return; }
      const desktop = req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof;
      if (url.pathname === WORKSPACE_FILES_ROUTE_PREFIX || url.pathname.startsWith(`${WORKSPACE_FILES_ROUTE_PREFIX}/`)) {
        let body = ""; for await (const chunk of req) { body += String(chunk); if (body.length > 65_536) { res.statusCode = 413; res.end(); return; } }
        try {
          // The real module, with the real deps: the fixture decides only who
          // is asking, never what the workspace answers.
          sendDelegated(res, req.method ?? "GET", await workspaceFilesRoute({
            method: req.method ?? "GET", path: url.pathname, url, headers: req.headers, desktop,
            readBody: async () => (body ? JSON.parse(body) as unknown : undefined),
          }, workspaceDeps));
        } catch { res.statusCode = 500; res.end(JSON.stringify({ error: "Fixture workspace request failed" })); }
        return;
      }
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

// R3-T2: the Workspace half of Files. A bot writes a nested report with no
// register call, and the owner finds it, reads it, and keeps a verified
// version — the journey the registration-only proof above never covered.
for (const width of [390, 1440]) test(`a report written without a register call is found, read and saved at ${width}px`, async ({ page }, testInfo) => {
  const name = `workspace-${width}.html`, relativePath = `reports/deep/${name}`;
  const content = `<h1>Workspace report ${width}</h1><p>WORKSPACE_DISCOVERED: not registered by any tool.</p><script>parent.__artifactBridgeProbe=99;fetch('${origin}/leak?workspace-script')</script><img src="${origin}/leak?workspace-image">`;
  mkdirSync(join(workspace, "reports", "deep"), { recursive: true });
  writeFileSync(join(workspace, relativePath), content);
  const beforeLeaks = leakedRequests;
  await page.setViewportSize({ width, height: 900 });
  await page.goto(origin + "/__files");

  const workspaceSection = page.locator('[data-testid="files-workspace"]');
  await expect(page.locator('[data-testid="files-effective-root"]')).toContainText("Browsing Research bot");
  await expect(page.locator('[data-testid="files-effective-root"]')).toContainText("Working folder you chose");
  // The resolved folder is the server's answer, not a path typed into the UI.
  await expect(workspaceSection).toContainText(`Folder: ${workspace}`);

  await workspaceSection.getByRole("button", { name: "Open folder reports", exact: true }).click();
  await workspaceSection.getByRole("button", { name: "Open folder deep", exact: true }).click();
  const row = workspaceSection.locator(`[data-workspace-path="${relativePath}"]`);
  await expect(row).toContainText("Workspace file ·");
  await expect(row).not.toContainText("Saved copy");

  await row.getByRole("button", { name: `View the current ${name}`, exact: true }).click();
  const view = page.getByRole("region", { name: "Workspace file view", exact: true });
  await expect(view).toContainText("Shown from the file on disk right now. It is not a saved copy until you save this version.");
  const frame = page.frameLocator(`iframe[title="Workspace view of ${name}"]`);
  await expect(frame.getByText("WORKSPACE_DISCOVERED: not registered by any tool.", { exact: true })).toBeVisible();
  await expect(frame.locator("script,iframe")).toHaveCount(0);
  expect(await frame.locator("img").getAttribute("src")).toBe(null);
  expect(await page.evaluate(() => (window as unknown as { __artifactBridgeProbe: number }).__artifactBridgeProbe)).toBe(0);
  expect(leakedRequests).toBe(beforeLeaks);

  await row.getByRole("button", { name: `Save this version of ${name}`, exact: true }).click();
  await expect(page.getByText(`Saved this version of ${name}.`, { exact: false })).toBeVisible();
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Saved copy");
  const download = page.waitForEvent("download"); await card.getByRole("button", { name: "Download", exact: true }).click();
  expect(createHash("sha256").update(readFileSync((await (await download).path())!)).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));

  // One Refresh reloads both halves: the workspace re-reads the changed file
  // on disk, and the saved copy still reports the original it kept.
  writeFileSync(join(workspace, relativePath), `${content}<p>Changed after saving.</p>`);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card).toContainText("Original file has changed");
  await expect(workspaceSection.locator(`[data-workspace-path="${relativePath}"]`)).toBeVisible();
  await row.getByRole("button", { name: `View the current ${name}`, exact: true }).click();
  await expect(page.frameLocator(`iframe[title="Workspace view of ${name}"]`).getByText("Changed after saving.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`files-workspace-${width}.png`), fullPage: true });
});

test("a legacy conversation and a remote one say so instead of listing a folder", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/__files");
  const state = page.locator('[data-testid="files-workspace-state"]');
  await expect(state).toHaveCount(0);

  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOption({ label: "Legacy bot" });
  await expect(state).toHaveAttribute("data-state", "no-dedicated-workspace");
  await expect(state).toContainText("This older conversation has no dedicated workspace");
  await expect(page.getByRole("searchbox", { name: "Search this workspace" })).toHaveCount(0);

  await page.getByRole("combobox", { name: "Bot", exact: true }).selectOption({ label: "Remote bot" });
  await expect(state).toHaveAttribute("data-state", "remote");
  await expect(state).toContainText("Stored on a remote computer; not available locally.");
  await expect(page.getByRole("searchbox", { name: "Search this workspace" })).toHaveCount(0);
  // Neither state may claim there are simply no files.
  await expect(page.locator('[data-testid="files-workspace"]')).not.toContainText("This workspace has no files yet.");
});

test("active saved filters are named, and All saved files widens only the saved half", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + "/__files");
  const filters = page.locator('[data-testid="files-saved-filters"]');
  await expect(filters).toContainText("Showing only: Bot Research bot");
  await page.getByRole("combobox", { name: "Type", exact: true }).selectOption({ label: "HTML reports" });
  await expect(filters).toContainText("Type HTML reports");

  await filters.getByRole("button", { name: "All saved files", exact: true }).click();
  await expect(filters).toContainText("Showing every saved file.");
  await expect(filters.getByRole("button", { name: "All saved files", exact: true })).toHaveCount(0);
  // Widening the saved list must not move the workspace half off this bot.
  await expect(page.locator('[data-testid="files-effective-root"]')).toContainText("Browsing Research bot");
});
