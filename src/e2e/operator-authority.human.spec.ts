import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { freePortBlock } from "../../server/testing/ports.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const proof = "operator-fixture-proof";
let server: ViteDevServer;
let origin: string;

function sourceHandlers() {
  const workspace = ts.createSourceFile("workspace.tsx", readFileSync(`${root}/src/components/LocalVmWorkspace.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const app = ts.createSourceFile("App.tsx", readFileSync(`${root}/src/App.tsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const release = workspace.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "bestEffortRelease")!;
  let viewerEffect: ts.Node | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === "useEffect" && node.getText(app).includes("desktopViewer?.onState")) viewerEffect = node;
    ts.forEachChild(node, walk);
  };
  walk(app);
  if (!viewerEffect) throw new Error("App viewer lifecycle effect not found");
  return ts.transpileModule(`
    import { useEffect } from 'react';
    import { api } from '/src/state/store.tsx';
    import { desktopSurfaceHeaders } from '/src/lib/live-events.ts';
    ${release.getText(workspace)}
    export function TeardownProbe() {
      useEffect(() => () => {
        const before = window.fixtureFetches.length;
        bestEffortRelease('workspace-bot', 'lease_fixture_123456789');
        window.releaseStartedSynchronously = window.fixtureFetches.length > before;
      }, []);
      return null;
    }
    export function ViewerProbe() {
      const dispatch = action => window.operatorEvents.push(['dispatch', action]);
      ${viewerEffect.getText(app)};
      return null;
    }
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}

test.beforeAll(async () => {
  server = await createServer({
    configFile: false, root, resolve: { alias: { "@": `${root}/src` } },
    cacheDir: `${root}/node_modules/.vite-operator-authority`,
    server: { host: "127.0.0.1", port: 0, strictPort: true, watch: null, hmr: false },
    plugins: [react(), tailwind(), {
      name: "operator-authority-fixture",
      resolveId(id) {
        if (id === "/__operator.js") return "\0operator-fixture";
        if (id === "/__operator-handlers.js") return "\0operator-handlers";
      },
      load(id) {
        if (id === "\0operator-handlers") return sourceHandlers();
        if (id !== "\0operator-fixture") return;
        return `
          import React, {useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {LocalComputerSection} from '/src/components/LocalComputerSection.tsx';
          import {LinuxLocalControl} from '/src/components/LinuxLocalControl.tsx';
          import {DesktopCapabilitiesProvider} from '/src/components/DesktopCapabilities.tsx';
          import {ensureDesktopSurfaceSecret} from '/src/lib/live-events.ts';
          import {api} from '/src/state/store.tsx';
          import {TeardownProbe, ViewerProbe} from '/__operator-handlers.js';
          import '/src/styles.css';
          await ensureDesktopSurfaceSecret();
          window.primeControl = () => api('/api/bots/workspace-bot/computer/control', {
            method:'POST', body:JSON.stringify({action:'take',controlLeaseId:'lease_fixture_123456789'})});
          const view = new URL(location.href).searchParams.get('view');
          function Cleanup() {
            const [mounted,setMounted]=useState(true);
            return React.createElement(React.Fragment,{},
              React.createElement('button',{onClick:()=>setMounted(false)},'Unmount workspace'),
              mounted && React.createElement(TeardownProbe));
          }
          createRoot(document.getElementById('root')).render(
            view==='local' ? React.createElement(LocalComputerSection) :
            view==='linux' ? React.createElement(DesktopCapabilitiesProvider,{},React.createElement(LinuxLocalControl)) :
            view==='cleanup' ? React.createElement(Cleanup) : React.createElement(ViewerProbe));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/__operator?")) return next();
          res.setHeader("content-type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<div id="root"></div><script type="module" src="/__operator.js"></script>'));
        });
      },
    }],
  });
  await server.listen(await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); });

function vmStatus() {
  return {
    platform: "linux", runtime: "docker", available: ["docker"], daemonUp: true,
    image: true, imageMatches: true, managed: true, container: "missing", network: "loopback",
    security: "hardened", persistence: "durable", desktopReady: false, ready: false, problem: null,
    image_ref: "fixture", base_image_ref: "fixture", driver_version: "fixture", container_name: "fixture",
    workspace_path: "/fixture/workspace", workspace_guest_path: "/home/cua/workspace", viewer_url: "",
    idle_timeout_ms: 1000, mode: "shared", max_instances: 2,
    commands: { install: null, runtimeStart: null, pull: null, run: null, start: null, stop: null, remove: null, view: "" },
  };
}
type RequestRecord = { path: string; headers: Record<string, string>; body: Record<string, unknown> };
async function mount(page: Page, view: string, remote = false) {
  const requests: RequestRecord[] = [];
  const state = { status: vmStatus(), failure: "", releaseHeld: false, hold: null as Promise<void> | null };
  await page.addInitScript(({ proof, remote }) => {
    localStorage.setItem("murage-analytics-opt-out", "1");
    const w = window as any;
    w.operatorEvents = [];
    w.fixtureFetches = [];
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => { w.fixtureFetches.push({ path: String(input), init }); return fetch(input, init); };
    w.muragebox = {
      platform: "linux", desktopSurfaceSecret: remote ? "" : proof,
      getCapabilities: async () => ({
        host: { platform: "linux", session: "x11", label: "Linux", packaged: true }, windowChrome: "native",
        localComputer: { available: false, enabled: true, status: "unavailable", support: "supported", message: "Fixture driver needs attention" },
        screenPreview: { available: false }, dictation: { available: false },
      }),
      localControl: {
        enable: async () => { w.operatorEvents.push(["enable"]); },
        disable: async () => { w.operatorEvents.push(["disable"]); },
        retry: async () => { w.operatorEvents.push(["retry"]); },
      },
      browser: { setHumanControl: async (botId: string, held: boolean) => { w.operatorEvents.push(["native", botId, held]); return true; } },
      desktopViewer: { onState: (listener: unknown) => { w.viewerListener = listener; return () => {}; } },
    };
  }, { proof, remote });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/desktop-secret") return route.fulfill({ status: remote ? 404 : 200, json: remote ? {} : { secret: proof } });
    if (request.method() === "GET") return route.fulfill({ json: path === "/api/local-computer" ? state.status : {} });
    const record = { path, headers: request.headers(), body: JSON.parse(request.postData() || "{}") };
    requests.push(record);
    if (record.headers["x-murage-surface"] !== "desktop" || record.headers["x-murage-surface-secret"] !== proof) {
      return route.fulfill({ status: 404, json: { error: "no such route" } });
    }
    if (state.hold) await state.hold;
    if (state.failure) return route.fulfill({ status: 503, json: { error: state.failure } });
    if (path === "/api/config") {
      const policy = record.body.localVm as { mode: string; maxInstances: number };
      Object.assign(state.status, { mode: policy.mode, max_instances: policy.maxInstances });
    }
    return route.fulfill({ json: path.endsWith("/control")
      ? { held: record.body.action === "take" || state.releaseHeld, helpReason: null, released: !state.releaseHeld }
      : path.startsWith("/api/local-computer") ? state.status : {} });
  });
  await page.goto(`${origin}/__operator?view=${view}`);
  return { requests, state };
}

test("mounted VM actions and policy save send desktop proof and remain retryable", async ({ page }) => {
  const { requests, state } = await mount(page, "local");
  const create = page.getByRole("button", { name: "Create Local VM", exact: true });
  await expect(create).toBeVisible();
  let release = () => {};
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  state.failure = "Fixture VM preparation failed";
  await create.click();
  await expect(create).toBeDisabled();
  await expect.poll(() => requests.length).toBe(1);
  release();
  state.hold = null;
  await expect(page.getByText(state.failure)).toBeVisible();
  await expect(create).toBeEnabled();
  state.failure = "";
  await create.click();
  await expect(create).toBeEnabled();
  state.failure = "Fixture isolation policy failed";
  await page.getByRole("button", { name: "Per bot", exact: true }).click();
  await expect(page.getByText(state.failure)).toBeVisible();
  expect(state.status.mode).toBe("shared");
  state.failure = "";
  await page.getByRole("button", { name: "Per bot", exact: true }).click();
  await expect.poll(() => state.status.mode).toBe("per-bot");
  await expect(page.getByRole("combobox", { name: "Maximum per-bot desktops" })).toBeEnabled();
  expect(requests.map((r) => r.path)).toEqual(["/api/local-computer/run", "/api/local-computer/run", "/api/config", "/api/config"]);
  expect(requests.every((r) => r.headers["x-murage-surface-secret"] === proof)).toBe(true);
});

test("mounted Linux retry waits for accepted interrupt and recovers from failure", async ({ page }) => {
  const { state, requests } = await mount(page, "linux");
  state.failure = "Fixture interrupt failed";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText(state.failure)).toBeVisible();
  expect(await page.evaluate("window.operatorEvents")).toEqual([]);
  state.failure = "";
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect.poll(() => page.evaluate("window.operatorEvents")).toEqual([["retry"]]);
  await page.getByRole("button", { name: "Disable local control", exact: true }).click();
  await expect.poll(() => page.evaluate("window.operatorEvents")).toEqual([["retry"], ["disable"]]);
  expect(requests.every((r) => r.headers["x-murage-surface-secret"] === proof)).toBe(true);
});

test("mounted teardown initiates a cached-proof keepalive release before clearing Electron", async ({ page }) => {
  const { requests, state } = await mount(page, "cleanup");
  await expect(page.getByRole("button", { name: "Unmount workspace" })).toBeVisible();
  await page.evaluate("window.primeControl()");
  requests.length = 0;
  let release = () => {};
  state.hold = new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole("button", { name: "Unmount workspace" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    path: "/api/bots/workspace-bot/computer/control",
    headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof },
    body: { action: "release", controlLeaseId: "lease_fixture_123456789" },
  });
  expect(await page.evaluate("window.releaseStartedSynchronously")).toBe(true);
  expect(await page.evaluate("window.fixtureFetches.at(-1).init.keepalive")).toBe(true);
  expect(await page.evaluate("window.operatorEvents")).toEqual([]);
  release();
  state.hold = null;
  await expect.poll(() => page.evaluate("window.operatorEvents")).toEqual([["native", "workspace-bot", false]]);
});

for (const refused of ["http-error", "still-held"]) {
  test(`teardown preserves Electron's hold after ${refused}`, async ({ page }) => {
    const { state, requests } = await mount(page, "cleanup");
    await expect(page.getByRole("button", { name: "Unmount workspace" })).toBeVisible();
    state.failure = refused === "http-error" ? "Fixture release failed" : "";
    state.releaseHeld = refused === "still-held";
    const response = page.waitForResponse((response) => response.url().endsWith("/computer/control"));
    await page.getByRole("button", { name: "Unmount workspace" }).click();
    expect((await response).status()).toBe(refused === "http-error" ? 503 : 200);
    expect(requests[0].body.controlLeaseId).toBe("lease_fixture_123456789");
    expect(await page.evaluate("window.operatorEvents")).toEqual([]);
  });
}

test("mounted App viewer handler uses its event context and releases native control only after acceptance", async ({ page }) => {
  const { state, requests } = await mount(page, "viewer");
  await expect.poll(() => page.evaluate("Boolean(window.viewerListener)")).toBe(true);
  state.failure = "Fixture release failed";
  const failed = page.waitForResponse((response) => response.url().endsWith("/computer/control"));
  await page.evaluate("window.viewerListener({open:false,contextId:'viewer-bot'})");
  expect((await failed).status()).toBe(503);
  expect(await page.evaluate("window.operatorEvents")).toEqual([]);

  state.failure = "";
  state.releaseHeld = true;
  await page.evaluate("window.viewerListener({open:false,contextId:'viewer-bot'})");
  await expect.poll(() => page.evaluate("window.operatorEvents")).toEqual([
    ["dispatch", { type: "computerControl", botId: "viewer-bot", held: true, helpReason: null }],
  ]);
  state.releaseHeld = false;
  await page.evaluate("window.viewerListener({open:false,contextId:'viewer-bot'})");
  await expect.poll(() => page.evaluate("window.operatorEvents.filter(event=>event[0]==='native')"))
    .toEqual([["native", "viewer-bot", false]]);
  expect(requests.every((r) => r.path.startsWith("/api/bots/viewer-bot/computer/"))).toBe(true);
  expect(requests.every((r) => r.headers["x-murage-surface-secret"] === proof)).toBe(true);
  expect(requests.filter((r) => r.path.endsWith("/viewer-close"))).toHaveLength(3);
});

for (const view of ["local", "linux"]) {
  test(`remote ${view} surface cannot acquire authority`, async ({ page }) => {
    const { requests, state } = await mount(page, view, true);
    await page.getByRole("button", { name: view === "local" ? "Create Local VM" : "Try again", exact: true }).click();
    await expect(page.getByText(/no such route|Could not stop active local computer turns/)).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0].headers["x-murage-surface-secret"]).toBeUndefined();
    expect(state.status.mode).toBe("shared");
    expect(await page.evaluate("window.operatorEvents")).toEqual([]);
  });
}

for (const view of ["cleanup", "viewer"]) {
  test(`remote ${view} handler cannot release native control`, async ({ page }) => {
    const { requests } = await mount(page, view, true);
    const response = page.waitForResponse((response) => response.url().endsWith("/computer/control"));
    if (view === "cleanup") await page.getByRole("button", { name: "Unmount workspace" }).click();
    else {
      await expect.poll(() => page.evaluate("Boolean(window.viewerListener)")).toBe(true);
      await page.evaluate("window.viewerListener({open:false,contextId:'viewer-bot'})");
    }
    expect((await response).status()).toBe(404);
    expect(requests.every((record) => record.headers["x-murage-surface-secret"] === undefined)).toBe(true);
    expect(await page.evaluate("window.operatorEvents")).toEqual([]);
  });
}
