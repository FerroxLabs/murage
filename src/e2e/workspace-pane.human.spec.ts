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
// handle, the protected HTML preview letting nothing out, and (STOPRESTORE2)
// a Save pressed right after Stop waiting for the stopped turn's lease with
// the named refusal when the engine outlives its close budget.
//
// Nothing here touches a real app, data directory, engine or network.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initializeArtifacts } from "../../server/artifacts.ts";
import { ProjectTurnLeases } from "../../server/project-turn-leases.ts";
import { sendDelegated } from "../../server/route-delegation.ts";
import { workspaceFilesRoute, type WorkspaceFilesDeps } from "../../server/workspace-files.ts";
import { WORKSPACE_FILES_ROUTE_PREFIX, WORKSPACE_FILES_ROUTES } from "../../shared/workspace-files.ts";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let root: string, dataDir: string, workspace: string, origin: string, server: ViteDevServer, db: DatabaseSync;
let leakedRequests = 0;
/** While set, write answers are held until `/__control/release`. */
let holdWrites = false;
const heldWrites: Array<() => void> = [];
/** The real writer registry a bot turn holds its working folder in
 * (STOPRESTORE2). `/__control/turn/<start|stop|close>` does what dispatch,
 * Stop and the engine's terminal event do to it; `/__control/close-budget`
 * sets the engine close budget the save's wait is bounded by. */
const turns = new ProjectTurnLeases();
let closeBudgetMs = 5_000;
/** One generation per started turn: a completed turn id is a tombstone in
 * the registry, so ids are never reused. */
let turnSerial = 0;
const TURN = { threadId: "task", generation: "", turnId: "" };
const proof = "workspace-pane-fixture-proof";
const scope = { botId: "research", threadId: "task" };
const REPORT = "# Weekly report\n\nThree updates this week.\n";
const NOTES = "line one\nline two\n";
const SAVED = { id: "saved-old", botId: "research", threadId: "task", botName: "Research bot", name: "Saved report", filename: "report.md", relativePath: "report.md", kind: "text", bytes: 22, createdAt: 1, sha256: "a".repeat(64), savedState: "available", sourceState: "changed", sourceConversationAvailable: true };

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
    projectFolders: turns.folders, projectTurns: turns, stoppedTurnCloseMs: () => closeBudgetMs,
  };
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  server = await createServer({
    configFile: false, root: repo, envFile: false, cacheDir: join(root, "vite-cache"), resolve: { alias: { "@": join(repo, "src") } },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), {
      name: "workspace-pane-fixture",
      enforce: "pre",
      resolveId(id) { if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0pane-store"; if (id === "/__pane.js") return "\0pane-fixture"; },
      load(id) {
        if (id === "\0pane-store") return `export * from '/src/state/store.tsx?original';import {useSyncExternalStore} from 'react';export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}`;
        if (id !== "\0pane-fixture") return;
        // The real surface, the real reducer, a stand-in chat column. The
        // reducer's state and dispatch are exposed so a test can do what
        // Files "Open beside chat" and the chat header do.
        return `import React, {useReducer, useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {WorkspacePane,WorkspacePaneSurface} from '/src/components/WorkspacePane.tsx';
import {Sidebar} from '/src/components/Sidebar.tsx';
import {ChatHeader} from '/src/components/ChatHeader.tsx';
import {ArtifactCard,openFiles} from '/src/components/Files.tsx';
import {initialState} from '/src/state/store.tsx?original';
import {initialWorkspacePaneState, workspacePaneReducer} from '/src/lib/workspace-pane.ts';
import '/src/styles.css';
const scope=${JSON.stringify(scope)};
const joined=new URLSearchParams(location.search).has('joined');
const base={color:'blue',messages:[],description:'',autoApprove:false,tasks:[],modelSelection:{instanceId:'fixture',model:'test'}};
const bots=[{...base,id:'research',name:'Research bot',threadId:'task',tasks:[{threadId:'task',title:'Weekly report'}]},{...base,id:'other',name:'Other bot',threadId:'other-task'}];
const state={...initialState,bots,selectedId:'research',config:{features:{},box:{configured:false}},instances:[]};
const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
function dispatch(action){if(action.type==='workspacePane')state.workspacePane=workspacePaneReducer(state.workspacePane,action.action);if(action.type==='select')state.selectedId=action.id;publish();}
function publish(){window.fixtureStore={state:{...state},dispatch,refreshInstances:async()=>{}};listeners.forEach(fn=>fn());}publish();
function Joined(){const [,force]=useReducer(n=>n+1,0);useEffect(()=>window.subscribeFixture(force),[]);const bot=state.bots.find(bot=>bot.id===state.selectedId);const compact=state.workspacePane.open&&state.workspacePane.compact&&state.workspacePane.compactView==='workspace';return React.createElement('div',{style:{display:'flex',height:'100vh'}},React.createElement(Sidebar,{open:false,onClose:()=>{}}),React.createElement('main',{style:{display:'flex',position:'relative',flex:1,minWidth:0}},React.createElement('div',{'data-testid':'joined-chat-column',style:{flex:1,minWidth:0,visibility:compact?'hidden':undefined},inert:compact||undefined,hidden:state.workspacePane.open&&state.workspacePane.expanded},React.createElement(ChatHeader,{bot,messages:[],mascotMotion:null,findOpen:false,onToggleFind:()=>{}}),React.createElement(ArtifactCard,{artifact:window.savedFixture,onPreview:()=>openFiles({botId:'research',threadId:'task',artifactId:'saved-old'}),onDownload:()=>{}})),React.createElement(WorkspacePane,{bot})));}
function Harness(){
  const [pane, dispatch]=useReducer(workspacePaneReducer,{...initialWorkspacePaneState, open:true, compactView:'workspace'});
  useEffect(()=>{window.__pane={dispatch, state:pane};},[pane]);
  return React.createElement('div',{style:{display:'flex',height:'100vh',position:'relative'}},
    React.createElement('div',{'data-testid':'chat',style:{flex:1,minWidth:0,padding:16},hidden:pane.expanded||undefined},'Chat column'),
    React.createElement(WorkspacePaneSurface,{scope,pane,dispatch,labelForScope:()=>'Research bot · Weekly report',drafts:null,probeMs:250,onOpenFiles:()=>{window.__filesOpened=(window.__filesOpened||0)+1;}}));
}
createRoot(document.getElementById('root')).render(React.createElement(joined?Joined:Harness));`;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/leak") { leakedRequests++; res.end("Unexpected request"); return; }
          if (url.pathname === "/__pane") { res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__pane.js"></script>'); return; }
          if (url.pathname === "/__control/hold") { holdWrites = true; res.end("held"); return; }
          if (url.pathname === "/__control/release") { holdWrites = false; for (const release of heldWrites.splice(0)) release(); res.end("released"); return; }
          if (url.pathname === "/__control/turn/start") {
            turnSerial++; TURN.generation = `turn-${turnSerial}`; TURN.turnId = `provider-turn-${turnSerial}`;
            turns.acquire(TURN.threadId, TURN.generation, workspace); turns.markDispatched(TURN.generation); turns.bind(TURN.threadId, TURN.generation, TURN.turnId);
            res.end("started"); return;
          }
          if (url.pathname === "/__control/turn/stop") { turns.markStopRequested(TURN.generation); res.end("stop requested"); return; }
          if (url.pathname === "/__control/turn/close") { turns.complete(TURN.threadId, TURN.turnId); res.end("closed"); return; }
          if (url.pathname === "/__control/close-budget") { closeBudgetMs = Number(url.searchParams.get("ms")) || 5_000; res.end(String(closeBudgetMs)); return; }
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
test.afterAll(async () => { await server?.close(); db?.close(); if (root) safeWipeSync(root); });
test.beforeEach(() => {
  writeFileSync(file("report.md"), REPORT);
  writeFileSync(file("notes.txt"), NOTES);
  holdWrites = false; for (const release of heldWrites.splice(0)) release();
  turns.disposed(turns.generations()); closeBudgetMs = 5_000;
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

for (const width of [390, 820, 1440]) for (const skin of ["light", "dark"]) test(`joined Files Memory panel ${width} ${skin}`, async ({ page }, info) => {
  const errors: string[] = [], actions: Array<Record<string, unknown>> = [];
  const accessibility: unknown[] = [];
  const audit = async () => {
    if (!process.env.MURAGE_AXE_SCRIPT) { accessibility.push({ unavailable: "MURAGE_AXE_SCRIPT was not supplied" }); return; }
    await page.addScriptTag({ path: process.env.MURAGE_AXE_SCRIPT });
    const result = await page.evaluate(async () => (window as any).axe.run(document.querySelector('[data-testid="workspace-pane"]'), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } }));
    accessibility.push(result.violations);
    writeFileSync(info.outputPath(`axe-${accessibility.length}.json`), JSON.stringify(result, null, 2));
    expect(result.violations.filter((violation: { impact: string }) => ["serious", "critical"].includes(violation.impact))).toEqual([]);
  };
  let releaseOld: (() => void) | undefined;
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(saved => { (window as any).muragebox = {}; (window as any).savedFixture = saved; }, SAVED);
  const mode = width === 390 ? "off" : width === 820 ? "paused" : "active";
  const record = (botId: string) => ({ id: `memory-${botId}`, version: 1, scopeId: botId, text: `Private note for ${botId}`, state: "active", assertion: "owner-statement", validFrom: 1, ownerPinned: true });
  await page.route("**/api/config", route => route.fulfill({ json: { features: {}, box: { configured: false } } }));
  await page.route("**/api/memory/status", route => route.fulfill({ json: { mode, configuration: { excludedThreadIds: [], extractorInstanceId: null }, scopes: [{ id: "research", kind: "bot", ownerKey: "research", label: "Research bot" }, { id: "other", kind: "bot", ownerKey: "other", label: "Other bot" }], model: { state: "missing" }, records: { active: 2 }, backlog: {}, cost: {}, deletion: {}, extractors: [], workerError: null } }));
  await page.route("**/api/memory/action", async route => {
    const body = route.request().postDataJSON(); actions.push(body);
    if (body.action === "list" && body.query === "delayed") await new Promise<void>(resolve => { releaseOld = resolve; });
    if (body.action === "list") return route.fulfill({ json: { records: [record(body.botId)], scopeIds: [body.botId] } });
    if (body.action === "import-review-list") return route.fulfill({ json: { links: [] } });
    if (body.action === "inspect") return route.fulfill({ json: { record: record(String(body.id).replace("memory-", "")), evidence: [], lineage: [] } });
    return route.fulfill({ status: 400, json: { error: "Unexpected memory mutation" } });
  });
  await page.route("**/api/artifacts?*", route => route.fulfill({ json: { items: [SAVED], total: 1, pageSize: 25 } }));
  await page.route("**/api/artifacts/saved-old/preview", route => route.fulfill({ json: { artifact: SAVED, mode: "text", content: "Historical saved bytes" } }));
  await page.goto(`${origin}/__pane?joined=1`);
  await page.evaluate(value => { document.documentElement.dataset.skin = value; }, skin);
  const folder = page.locator('[data-header-labelled="folder"]');
  if (await folder.isVisible()) await folder.click();
  else { await page.getByRole("button", { name: "More actions", exact: true }).click(); await page.getByRole("menuitem", { name: /Open files/i }).click(); }
  await expect(page.getByTestId("workspace-pane")).toBeVisible();
  await page.getByRole("button", { name: "Open notes.txt", exact: true }).click();
  await expect(page.getByTestId("workspace-text-preview")).toBeVisible();
  await page.getByRole("tab", { name: /^notes\.txt/ }).focus(); await page.keyboard.press("Delete");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
  await editInSource(page);
  await sourceBox(page).fill("# Unsaved owner draft");
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await expect(page.getByTestId("memory-settings")).toHaveAttribute("data-compact", "true");
  await expect(page.getByText(`Private note for research`, { exact: true })).toBeVisible();
  await expect(page.getByTestId("memory-settings")).toContainText(mode === "active" ? "Capture and recall are on." : mode === "off" ? "Memory is off." : "Memory is paused.");
  for (const view of ["Important", "Recent", "Needs review"]) { await page.getByRole("button", { name: view, exact: true }).click(); await expect(page.getByRole("button", { name: view, exact: true })).toBeEnabled(); }
  await page.getByRole("button", { name: "Inspect memory", exact: true }).click();
  await page.getByRole("checkbox", { name: "Confirm forgetting this memory" }).check();
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  expect(actions.every(action => ["list", "inspect", "import-review-list"].includes(String(action.action)))).toBe(true);
  await page.getByRole("tab", { name: "Memory", exact: true }).focus(); await page.keyboard.press("Home");
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeFocused();
  await expect(sourceBox(page)).toHaveValue("# Unsaved owner draft");
  const fileTabs = page.getByRole("tablist", { name: "Open files", exact: true });
  await expect(fileTabs.getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "Close report.md", exact: true }).click();
  await expect(page.getByTestId("workspace-pane-close-question")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page.getByRole("button", { name: "Open notes.txt", exact: true }).click();
  await page.getByRole("tab", { name: /^notes\.txt/ }).focus(); await page.keyboard.press("Delete");
  await expect(fileTabs.getByRole("tab")).toBeFocused();
  await expect(sourceBox(page)).toHaveValue("# Unsaved owner draft");
  await fileTabs.getByRole("tab").focus(); await page.keyboard.press("Delete");
  await expect(page.getByTestId("workspace-pane-close-question")).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  const compactLayout = await page.getByTestId("workspace-pane").getAttribute("data-layout") === "compact";
  const chat = page.getByTestId("joined-chat-column");
  if (compactLayout) { await expect(chat).toHaveAttribute("inert", ""); await expect(chat).toBeHidden(); }
  else expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(360);
  await audit();
  await page.screenshot({ path: info.outputPath(`joined-files-${width}-${skin}.png`) });
  if (!compactLayout) { await page.getByTestId("workspace-pane-expand").click(); await expect(page.getByTestId("workspace-pane")).toHaveAttribute("data-layout", "expanded"); await page.getByTestId("workspace-pane-expand").click(); }
  else { await page.getByTestId("workspace-pane-back").click(); await expect(page.getByTestId("workspace-pane")).toBeHidden(); }
  await expect(chat).toBeVisible();
  expect((await chat.boundingBox())!.width).toBeGreaterThanOrEqual(360);
  await page.locator('article[data-artifact-id="saved-old"]').getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("region", { name: "File preview", exact: true })).toContainText("Historical saved bytes");
  const savedText = page.getByText("Historical saved bytes", { exact: true });
  await expect(savedText).toBeVisible();
  const savedBounds = (await savedText.boundingBox())!;
  expect(savedBounds.y).toBeGreaterThanOrEqual(0);
  expect(savedBounds.y + savedBounds.height).toBeLessThanOrEqual(900);
  await audit();
  await page.screenshot({ path: info.outputPath(`joined-saved-${width}-${skin}.png`) });
  await page.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved versions", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Memory", exact: true }).click();
  await page.getByLabel("Search memory", { exact: true }).fill("delayed");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  try {
    await expect.poll(() => Boolean(releaseOld)).toBe(true);
    await page.evaluate(() => (window as any).fixtureStore.dispatch({ type: "select", id: "other" }));
    await expect(page.getByTestId("workspace-pane-scope")).toContainText("Other bot");
    await expect(page.getByText("Private note for other", { exact: true })).toBeVisible();
  } finally { releaseOld?.(); }
  await expect(page.getByText("Private note for research", { exact: true })).toHaveCount(0);
  await audit();
  await page.screenshot({ path: info.outputPath(`joined-memory-${width}-${skin}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
  await info.attach("joined-panel-observations", { body: JSON.stringify({ width, skin, mode, errors, actions, accessibility }, null, 2), contentType: "application/json" });
  writeFileSync(info.outputPath("joined-panel-observations.json"), JSON.stringify({ width, skin, mode, errors, actions, accessibility }, null, 2));
});

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

  await page.getByTestId("workspace-document").locator("summary").click();
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
  await page.getByTestId("workspace-document").locator("summary").click();
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

test("a Save right after Stop waits for the stopped turn to close, and names the refusal when it does not (STOPRESTORE2)", async ({ page, request }) => {
  await open(page);
  await editInSource(page);
  await sourceBox(page).fill("# Weekly report\n\nEdited while the bot worked.\n");
  // A live turn holds the workspace: Save is refused at once, nothing written.
  await request.get(`${origin}/__control/turn/start`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-save-error")).toHaveText("File not saved: a bot is writing to this workspace. Your changes are still here; try again when it finishes.");
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File not saved");
  expect(disk("report.md")).toBe(REPORT);

  // Stop: the bot reads idle but the engine has not closed, so the lease is
  // still held. Save now waits instead of refusing; the engine's close
  // (turn.completed) releases the lease and the save lands.
  await request.get(`${origin}/__control/turn/stop`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("Saving file…");
  await expect(page.getByTestId("markdown-save-error")).toHaveCount(0);
  expect(disk("report.md")).toBe(REPORT);
  await request.get(`${origin}/__control/turn/close`);
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  await expect(tabs(page).first()).not.toHaveAttribute("data-dirty", "true");
  expect(disk("report.md")).toBe("# Weekly report\n\nEdited while the bot worked.\n");

  // A stopped turn whose engine outlives its close budget: the pane shows
  // the named, retryable refusal — not a generic failure — and keeps the text.
  await request.get(`${origin}/__control/close-budget?ms=300`);
  await request.get(`${origin}/__control/turn/start`);
  await request.get(`${origin}/__control/turn/stop`);
  await sourceBox(page).fill("# Weekly report\n\nEdited after a slow Stop.\n");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-save-error")).toHaveText("File not saved: a stopped bot turn is still closing in this workspace. Your changes are still here; wait a moment and save again.");
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File not saved");
  await expect(sourceBox(page)).toHaveValue("# Weekly report\n\nEdited after a slow Stop.\n");
  expect(disk("report.md")).toBe("# Weekly report\n\nEdited while the bot worked.\n");
  await page.screenshot({ path: test.info().outputPath("save-stopped-turn-closing.png") });
  // Saving again once the engine closed writes.
  await request.get(`${origin}/__control/turn/close`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByTestId("markdown-file-status")).toHaveText("File saved");
  await expect(page.getByTestId("markdown-save-error")).toHaveCount(0);
  expect(disk("report.md")).toBe("# Weekly report\n\nEdited after a slow Stop.\n");
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
  await page.getByRole("button", { name: "Saved versions", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __filesOpened?: number }).__filesOpened)).toBe(1);
});
