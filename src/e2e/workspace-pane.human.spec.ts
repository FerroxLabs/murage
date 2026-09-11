// The workspace pane, in a real browser (F4-T3).
//
// A Vite fixture mounts the real WorkspacePaneSurface with the real pane
// reducer beside a stand-in chat column, and serves the real F4-T1 workspace
// routes (server/workspace-files.ts, with a real ProjectFolderLeases) over a
// temporary folder. What this proves is what a person does and what lands on
// disk: clicking a file, the one clean preview tab being reused, Keep open
// and Edit making tabs persistent, Save writing the bytes, typing during a
// held save leaving the newer text unsaved, an external change reloading a
// clean preview and raising a conflict for a dirty editor, the dirty-close
// question, the compact overlay's Back to chat keeping a draft, the drag
// handle, and the protected HTML preview letting nothing out.
//
// Nothing here touches a real app, data directory, engine or network.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initializeArtifacts } from "../../server/artifacts.ts";
import { ProjectFolderLeases } from "../../server/project-folder-leases.ts";
import { sendDelegated } from "../../server/route-delegation.ts";
import { workspaceFilesRoute, type WorkspaceFilesDeps } from "../../server/workspace-files.ts";
import { WORKSPACE_FILES_ROUTE_PREFIX, WORKSPACE_FILES_ROUTES } from "../../shared/workspace-files.ts";

let root: string, dataDir: string, workspace: string, origin: string, server: ViteDevServer, db: DatabaseSync;
let leakedRequests = 0;
/** While set, write answers are held until `/__control/release`. */
let holdWrites = false;
const heldWrites: Array<() => void> = [];
const proof = "workspace-pane-fixture-proof";
const scope = { botId: "research", threadId: "task" };
const REPORT = "# Weekly report\n\nThree updates this week.\n";
const NOTES = "line one\nline two\n";

const file = (relative: string) => join(workspace, ...relative.split("/"));
const disk = (relative: string) => readFileSync(file(relative), "utf8");

test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "murage-workspace-pane-")));
  dataDir = join(root, "data"); workspace = join(root, "workspace");
  mkdirSync(join(workspace, "site"), { recursive: true }); mkdirSync(dataDir);
  writeFileSync(file("report.md"), REPORT);
  writeFileSync(file("notes.txt"), NOTES);
  writeFileSync(file("deck.pptx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  db = new DatabaseSync(join(root, "messages.db")); initializeArtifacts(db);
  const deps: WorkspaceFilesDeps = {
    dataDir, database: () => db,
    store: { bots: [{ id: "research", name: "Research bot", threadId: "task", resumeCursors: {}, tasks: [{ threadId: "task", title: "Weekly report", cwd: workspace, resumeCursors: {} }] }], groups: [] } as never,
    artifactScopes: () => [{ botId: "research", botName: "Research bot", threadId: "task", workspaceRoot: workspace }],
    projectFolders: new ProjectFolderLeases(),
  };
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({
    configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"), resolve: { alias: { "@": join(repo, "src") } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "workspace-pane-fixture",
      resolveId(id) { if (id === "/__pane.js") return "\0pane-fixture"; },
      load(id) {
        if (id !== "\0pane-fixture") return;
        // The real surface, the real reducer, a stand-in chat column. The
        // reducer's state and dispatch are exposed so a test can do what
        // Files "Open beside chat" and the chat header do.
        return `import React, {useReducer, useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {WorkspacePaneSurface} from '/src/components/WorkspacePane.tsx';
import {initialWorkspacePaneState, workspacePaneReducer} from '/src/lib/workspace-pane.ts';
import '/src/styles.css';
const scope=${JSON.stringify(scope)};
function Harness(){
  const [pane, dispatch]=useReducer(workspacePaneReducer,{...initialWorkspacePaneState, open:true, compactView:'workspace'});
  useEffect(()=>{window.__pane={dispatch, state:pane};},[pane]);
  return React.createElement('div',{style:{display:'flex',height:'100vh',position:'relative'}},
    React.createElement('div',{'data-testid':'chat',style:{flex:1,minWidth:0,padding:16},hidden:pane.expanded||undefined},'Chat column'),
    React.createElement(WorkspacePaneSurface,{scope,pane,dispatch,labelForScope:()=>'Research bot · Weekly report',drafts:null,probeMs:250,onOpenFiles:()=>{window.__filesOpened=(window.__filesOpened||0)+1;}}));
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/leak") { leakedRequests++; res.end("Unexpected request"); return; }
          if (url.pathname === "/__pane") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__pane.js"></script>'); return; }
          if (url.pathname === "/__control/hold") { holdWrites = true; res.end("held"); return; }
          if (url.pathname === "/__control/release") { holdWrites = false; for (const release of heldWrites.splice(0)) release(); res.end("released"); return; }
          if (url.pathname === "/api/desktop-secret") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ secret: proof })); return; }
          if (url.pathname !== WORKSPACE_FILES_ROUTE_PREFIX && !url.pathname.startsWith(`${WORKSPACE_FILES_ROUTE_PREFIX}/`)) return next();
          const desktop = req.headers["x-murage-surface"] === "desktop" && req.headers["x-murage-surface-secret"] === proof;
          let body = ""; for await (const chunk of req) { body += String(chunk); if (body.length > 1_000_000) { res.statusCode = 413; res.end(); return; } }
          try {
            const result = await workspaceFilesRoute({
              method: req.method ?? "GET", path: url.pathname, url, headers: req.headers, desktop,
              readBody: async () => (body ? JSON.parse(body) as unknown : undefined),
            }, deps);
            // The write has happened by now; only its acknowledgement waits.
            if (url.pathname === WORKSPACE_FILES_ROUTES.write && holdWrites) await new Promise<void>(resolve => heldWrites.push(resolve));
            sendDelegated(res, req.method ?? "GET", result);
          } catch { res.statusCode = 500; res.end(JSON.stringify({ error: "Fixture workspace request failed" })); }
        });
      },
    }],
  });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Workspace pane fixture did not bind");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });
test.beforeEach(() => {
  writeFileSync(file("report.md"), REPORT);
  writeFileSync(file("notes.txt"), NOTES);
  holdWrites = false; for (const release of heldWrites.splice(0)) release();
});

async function open(page: Page, { width = 1440, skin = "light" } = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}/__pane`);
  await page.evaluate(value => { document.documentElement.dataset.skin = value; }, skin);
  await expect(page.getByTestId("workspace-pane")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open report.md" })).toBeVisible();
}
const tabs = (page: Page) => page.getByTestId("workspace-tab");
const tabNamed = (page: Page, name: string) => page.getByTestId("workspace-tab").filter({ has: page.getByRole("tab", { name: new RegExp(`^${name.replace(".", "\\.")}`) }) });
const sourceBox = (page: Page) => page.getByRole("textbox", { name: "Markdown source" });
async function editInSource(page: Page) {
  await page.getByRole("button", { name: "Edit report.md" }).click();
  await expect(page.getByTestId("workspace-document")).toHaveAttribute("data-mode", "edit");
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(sourceBox(page)).toHaveValue(REPORT);
}

test("a single click previews a file and the next click reuses the tab; Keep open and Edit make tabs stay", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open report.md" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tabs(page).first()).toHaveAttribute("data-preview", "true");
  await expect(page.getByTestId("workspace-markdown-preview")).toContainText("Weekly report");
  await expect(page.getByTestId("workspace-markdown-preview")).toContainText("Three updates this week.");
  await expect(page.getByTestId("workspace-markdown-preview")).not.toContainText("# Weekly");
  // A preview writes nothing.
  expect(disk("report.md")).toBe(REPORT);

  await page.getByRole("button", { name: "Open notes.txt" }).click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByRole("tab", { name: /^notes\.txt/ })).toBeVisible();
  await expect(page.getByTestId("workspace-text-preview")).toHaveText(NOTES.trimEnd());

  await page.getByRole("button", { name: "Keep open", exact: true }).click();
  await expect(tabs(page).first()).not.toHaveAttribute("data-preview", "true");
  await page.getByRole("button", { name: "Open report.md" }).click();
  await expect(tabs(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Edit report.md" }).click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByTestId("workspace-document")).toHaveAttribute("data-mode", "edit");
  await page.getByRole("button", { name: "Open deck.pptx" }).click();
  await expect(tabs(page)).toHaveCount(3);
  await expect(page.getByText("No preview for this format.")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("pane-tabs-light.png") });
});

test("Save writes the bytes; typing during a held save leaves the newer text unsaved", async ({ page, request }) => {
  await open(page);
  await editInSource(page);
  await sourceBox(page).fill("# Weekly report\n\nFirst edit.\n");
  await expect(tabs(page).first()).toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe(REPORT);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  await expect(tabs(page).first()).not.toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe("# Weekly report\n\nFirst edit.\n");

  // Hold the acknowledgement of the next save and keep typing meanwhile.
  await request.get(`${origin}/__control/hold`);
  await sourceBox(page).fill("# Weekly report\n\nSecond edit.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Saving file…");
  await sourceBox(page).fill("# Weekly report\n\nSecond edit, then a third.\n");
  await request.get(`${origin}/__control/release`);
  // The receipt lands: the submitted text is on disk, the newer text is not
  // claimed saved, and the tab says so.
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Unsaved changes");
  await expect(tabs(page).first()).toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe("# Weekly report\n\nSecond edit.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  expect(disk("report.md")).toBe("# Weekly report\n\nSecond edit, then a third.\n");
});

test("switching tabs during a held save settles only the saving tab, and the draft survives the switch", async ({ page, request }) => {
  await open(page);
  await page.getByRole("button", { name: "Open notes.txt" }).click();
  await page.getByRole("button", { name: "Keep open", exact: true }).click();
  await editInSource(page);
  await request.get(`${origin}/__control/hold`);
  await sourceBox(page).fill("# Weekly report\n\nSaved while away.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Saving file…");
  await page.getByRole("tab", { name: /^notes\.txt/ }).click();
  await expect(page.getByTestId("workspace-text-preview")).toBeVisible();
  await request.get(`${origin}/__control/release`);
  await expect(tabNamed(page, "report.md")).not.toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe("# Weekly report\n\nSaved while away.\n");
  await page.getByRole("tab", { name: /^report\.md/ }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  // Type, switch away and back: the typing is still there and still unsaved.
  await sourceBox(page).fill("# Weekly report\n\nTyped, then switched.\n");
  await expect(tabNamed(page, "report.md")).toHaveAttribute("data-dirty", "true");
  await page.getByRole("tab", { name: /^notes\.txt/ }).click();
  await page.getByRole("tab", { name: /^report\.md/ }).click();
  await expect(sourceBox(page)).toHaveValue("# Weekly report\n\nTyped, then switched.\n");
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Unsaved changes");
  expect(disk("report.md")).toBe("# Weekly report\n\nSaved while away.\n");
});

test("an external change reloads a clean preview and raises a conflict for a dirty editor", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open notes.txt" }).click();
  await expect(page.getByTestId("workspace-text-preview")).toHaveText(NOTES.trimEnd());
  writeFileSync(file("notes.txt"), "line one\nline two\nline three from outside\n");
  await expect(page.getByTestId("workspace-text-preview")).toHaveText("line one\nline two\nline three from outside");
  await expect(page.getByTestId("workspace-document-notice")).toHaveText("Updated from the file on disk.");

  await editInSource(page);
  await sourceBox(page).fill("# Weekly report\n\nMine.\n");
  await expect(tabNamed(page, "report.md")).toHaveAttribute("data-dirty", "true");
  writeFileSync(file("report.md"), "# Weekly report\n\nTheirs.\n");
  await expect(page.getByTestId("markdown-conflict")).toBeVisible();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Not saved: the file changed on disk");
  // Neither text is lost and nothing was written.
  await expect(sourceBox(page)).toHaveValue("# Weekly report\n\nMine.\n");
  expect(disk("report.md")).toBe("# Weekly report\n\nTheirs.\n");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByTestId("markdown-conflict")).toContainText("Theirs.");
  await page.getByRole("button", { name: "Keep my version", exact: true }).click();
  await expect(page.getByTestId("markdown-conflict")).toHaveCount(0);
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  expect(disk("report.md")).toBe("# Weekly report\n\nMine.\n");
});

test("closing a dirty tab asks first; the answer is honoured either way", async ({ page }) => {
  await open(page);
  await editInSource(page);
  await sourceBox(page).fill("# Weekly report\n\nNot saved.\n");
  await page.getByRole("button", { name: "Close report.md" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Close without saving?");
  await page.getByRole("button", { name: "Keep editing" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(1);
  await expect(sourceBox(page)).toHaveValue("# Weekly report\n\nNot saved.\n");
  await page.getByRole("button", { name: "Close report.md" }).click();
  await page.getByRole("button", { name: "Close anyway" }).click();
  await expect(tabs(page)).toHaveCount(0);
  await expect(page.getByTestId("workspace-pane-empty")).toBeVisible();
  expect(disk("report.md")).toBe(REPORT);
});

test("the rail resizes by drag and keyboard, and never squeezes the chat below its minimum", async ({ page }) => {
  await open(page);
  const pane = page.getByTestId("workspace-pane");
  const before = (await pane.boundingBox())!;
  expect(Math.round(before.width)).toBe(440);
  const handle = page.getByTestId("workspace-pane-resize");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 160, box.y + 200, { steps: 8 });
  await page.mouse.up();
  const dragged = (await pane.boundingBox())!;
  expect(Math.round(dragged.width)).toBe(600);
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  expect(Math.round((await pane.boundingBox())!.width)).toBe(616);
  await page.keyboard.press("End");
  // 1440 wide: the chat keeps 360.
  expect(Math.round((await pane.boundingBox())!.width)).toBe(1440 - 360);
  expect(Math.round((await page.getByTestId("chat").boundingBox())!.width)).toBe(360);
  await page.keyboard.press("Home");
  expect(Math.round((await pane.boundingBox())!.width)).toBe(320);
  await page.getByTestId("workspace-pane-expand").click();
  await expect(pane).toHaveAttribute("data-layout", "expanded");
  expect(Math.round((await pane.boundingBox())!.width)).toBe(1440);
  await page.getByTestId("workspace-pane-expand").click();
  await expect(pane).toHaveAttribute("data-layout", "rail");
});

for (const skin of ["light", "dark"] as const) test(`below md the pane covers the chat, Back to chat keeps the draft, and the chat comes back (${skin})`, async ({ page }) => {
  await open(page, { width: 390, skin });
  const pane = page.getByTestId("workspace-pane");
  await expect(pane).toHaveAttribute("data-layout", "compact");
  expect(Math.round((await pane.boundingBox())!.width)).toBe(390);
  // The chat is underneath, not beside: the top-left pixel belongs to the pane.
  expect(await page.evaluate(() => document.elementFromPoint(20, 40)?.closest("[data-testid=workspace-pane]") !== null)).toBe(true);
  await editInSource(page);
  await sourceBox(page).fill("# Weekly report\n\nPhone draft.\n");
  await page.screenshot({ path: test.info().outputPath(`pane-compact-${skin}.png`) });
  await page.getByTestId("workspace-pane-back").click();
  await expect(pane).toBeHidden();
  await expect(page.getByTestId("chat")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __pane: { dispatch: (action: unknown) => void } }).__pane.dispatch({ type: "show" }));
  await expect(pane).toBeVisible();
  await expect(sourceBox(page)).toHaveValue("# Weekly report\n\nPhone draft.\n");
  await expect(tabNamed(page, "report.md")).toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe(REPORT);
  // Everything in the pane fits the phone: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("an HTML report previews inside the protected frame and lets nothing out", async ({ page }) => {
  writeFileSync(file("site/index.html"), `<h1>Site report</h1><script>parent.__probe=99;fetch('${origin}/leak?script')</script><img src="${origin}/leak?image"><a href="${origin}/leak?link">Untrusted link</a>`);
  const before = leakedRequests;
  await open(page);
  await page.getByRole("button", { name: "Open folder site" }).click();
  await page.getByRole("button", { name: "Open index.html" }).click();
  const frame = page.frameLocator('iframe[title="Preview of index.html"]');
  await expect(frame.getByRole("heading", { name: "Site report" })).toBeVisible();
  await expect(frame.locator("script,img[src]")).toHaveCount(0);
  await frame.getByText("Untrusted link").click();
  expect(page.url()).toContain("/__pane");
  expect(await page.evaluate(() => (window as unknown as { __probe?: number }).__probe)).toBeUndefined();
  expect(leakedRequests).toBe(before);
  // The folder crumb leads back to the root; Open Files hands off to Files.
  await page.getByRole("navigation", { name: "Workspace folders" }).getByRole("button", { name: "workspace", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open report.md" })).toBeVisible();
  await page.getByRole("button", { name: "Open Files", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __filesOpened?: number }).__filesOpened)).toBe(1);
});
