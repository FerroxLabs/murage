// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 real-window fixture (design A8). A REAL BrowserWindow with the production preload, window-open handler,
// navigation guard and readiness tracker, against the REAL server entry (server/index.ts, started the way main forks the
// packaged child: Electron's own Node, MURAGE_STATIC_DIR, an isolated data dir, a free port, no network or engine keys).
// index.html is removed, the setup page is asserted, index.html is restored, and the app must arrive by the page's own refresh.
// Run under Electron (xvfb-run on a display-less Linux box); electron/setup-page.electron.test.mjs launches it.
import { app, BrowserWindow, ipcMain, session, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMainWindowOpenHandler, OPEN_LOG_URL } from "../app-permissions.mjs";
import { createAppReadiness } from "../app-readiness.mjs";
import { createMainNavigationGuard, rendererOriginArguments } from "../main-ipc-trust.mjs";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const electronDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(electronDir);
const lang = process.env.MURAGE_TEST_LANG || "";
const { UI_GATE_TEXT } = await import(pathToFileURL(path.join(root, "server", "static-ui-setup-page.ts")).href);
const home = mkdtempSync(path.join(tmpdir(), "murage-setup-window-"));
app.setPath("userData", path.join(home, "electron"));
app.setPath("sessionData", path.join(home, "electron"));
if (lang) app.commandLine.appendSwitch("lang", lang);
// The preload asks main for the launch secret synchronously while the page loads.
ipcMain.on("desktop:surface-secret", (event) => { event.returnValue = ""; });

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value; try { value = await fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

let server; let serverLog = "";
async function main() {
  await app.whenReady();
  const data = path.join(home, "data"), staticDir = path.join(home, "static");
  mkdirSync(data); mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  writeFileSync(path.join(staticDir, "assets", "smoke.css"), "body{color:white}");
  let port = await freePort(); const webhook = await freePort(); if (port === webhook) port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // The packaged child: the bundled server entry (pnpm build:server) forked on Electron's own Node with utilityProcess.fork, the
  // way main.mjs forks it, with the same MURAGE_* environment minus everything that needs the network or a login.
  const entry = process.env.MURAGE_TEST_SERVER_ENTRY || path.join(root, "dist-server", "index.js");
  if (!existsSync(entry)) throw new Error(`the bundled server ${entry} is missing: run pnpm build:server`);
  server = utilityProcess.fork(entry, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(webhook), MURAGE_DEV_DESKTOP_SECRET: "ab".repeat(32), MURAGE_STATIC_UI_TRACE: "1", PATH: process.env.PATH ?? "" },
  });
  server.stdout.on("data", (c) => { serverLog += c; }); server.stderr.on("data", (c) => { serverLog += c; });
  let serverExited = null; server.once("exit", (code) => { serverExited = code; });
  await waitFor(async () => { if (serverExited !== null) throw new Error(`server exited (${serverExited}): ${serverLog}`); return (await fetch(`${origin}/api/health`)).ok; }, 60000, "the real server to be healthy");
  console.log("step0-real-server-up-without-index-html");

  // What the window shows, from the network's side: every main-frame response.
  const mainFrame = [];
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === "mainFrame") {
      const key = Object.keys(details.responseHeaders ?? {}).find((k) => k.toLowerCase() === "content-type");
      mainFrame.push({ url: details.url, status: details.statusCode, type: key ? String(details.responseHeaders[key][0] ?? "") : "" });
    }
    callback({});
  });

  // What the server is actually sent for every main-frame request (initial load, Retry, meta refresh): the Fetch Metadata and language.
  const requests = [];
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.resourceType === "mainFrame") {
      const h = Object.fromEntries(Object.entries(details.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]));
      requests.push({ url: details.url, dest: h["sec-fetch-dest"], mode: h["sec-fetch-mode"], lang: h["accept-language"], accept: h.accept });
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  const opened = { log: 0, external: [] };
  const readiness = createAppReadiness({ origin: () => origin });
  // The error page main built, exactly as main.mjs builds it (the function is sliced out of main.mjs, not copied).
  const mainSource = readFileSync(path.join(electronDir, "main.mjs"), "utf8");
  const slice = mainSource.slice(mainSource.indexOf("function escapeHtml(value)"), mainSource.indexOf("// How long one packaged-server child"));
  const errorCtx = vm.createContext({ path, pathToFileURL, LOG_DIR: path.join(home, "logs"), OPEN_LOG_URL });
  vm.runInContext(slice, errorCtx);

  const win = new BrowserWindow({
    show: true, width: 900, height: 600,
    webPreferences: { contextIsolation: true, preload: path.join(electronDir, "preload.cjs"), additionalArguments: rendererOriginArguments(origin) },
  });
  win.webContents.setWindowOpenHandler(createMainWindowOpenHandler({
    openExternal: async (url) => { opened.external.push(url); },
    openDiagnosticsLog: async () => { opened.log += 1; },
    currentUrl: () => (win.isDestroyed() ? "" : win.webContents.getURL()),
    trustedOrigin: () => origin,
    errorPageUrl: () => vm.runInContext("lastErrorPageUrl", errorCtx),
    warn: (message) => console.log(`warn: ${message}`),
  }));
  const guard = createMainNavigationGuard({ origin: () => origin, openExternal: async (url) => { opened.external.push(url); }, warn: (message) => console.log(`guard: ${message}`) });
  win.webContents.on("will-navigate", guard.willNavigate);
  win.webContents.on("will-redirect", guard.willRedirect);
  readiness.track(win.webContents);

  const text = (id) => win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)})?.textContent ?? null`);
  const click = (id) => win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).click()`, true);
  const words = UI_GATE_TEXT[lang ? lang.split("-")[0] : "en"] ?? UI_GATE_TEXT.en;

  // 1. No index.html: a page load is the setup page, in the window's language, never JSON, never Chromium's own error page.
  await win.loadURL(`${origin}/deep/route?x=1`).catch((e) => console.log(`loadURL: ${e.code ?? e.message}`));
  assert.equal(await text("t"), words.title, "the setup page title");
  assert.equal(await text("d"), words.body);
  assert.equal(await text("retry"), words.retry);
  assert.equal(await text("log"), words.log);
  const first = new URL(win.webContents.getURL());
  assert.equal(first.pathname + first.search, "/deep/route?x=1");
  assert.equal(readiness.ready(win.webContents), false, "the setup page is not the app");
  console.log(`step1-setup-page-shown-${lang || "en"}`);

  // 2. (c) Show the log reaches the open handler once, from the real preload'd setup page on the app origin.
  await click("log"); await sleep(400);
  assert.equal(opened.log, 1, "the log opened once");
  assert.equal(win.webContents.getURL(), `${origin}/deep/route?x=1`, "the window did not navigate");
  console.log("step2-show-the-log-opens-once");

  // 3. (d) Retry while still unavailable: the same page again, same path and query, no JSON in between.
  const before = mainFrame.length;
  const reloaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve));
  await click("retry"); await reloaded;
  assert.equal(await text("t"), words.title, "Retry while still unavailable stays on the setup page");
  const again = new URL(win.webContents.getURL());
  assert.equal(again.pathname + again.search, "/deep/route?x=1", "Retry keeps the route");
  assert.ok(mainFrame.length > before && mainFrame.slice(before).every((r) => r.status === 503));
  console.log("step3-retry-stays-on-setup-page");

  // 4. (b) The files come back: the app arrives by the page's own refresh, with no input, at the same route.
  const restoredAt = Date.now();
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>Packaged Murage</title><p id=\"app\">app</p>");
  await waitFor(async () => (await win.webContents.executeJavaScript("document.title")) === "Packaged Murage", 9000, "the app to arrive by itself");
  const elapsed = Date.now() - restoredAt;
  assert.ok(elapsed <= 8000, `the app arrived ${elapsed} ms after the restore`);
  const arrived = new URL(win.webContents.getURL());
  assert.equal(arrived.pathname + arrived.search, "/deep/route?x=1");
  await waitFor(() => readiness.ready(win.webContents), 2000, "readiness after the app loaded");
  console.log(`step4-app-arrived-by-itself-in-${elapsed}ms`);

  // 5. No extra reload after success.
  const settled = mainFrame.length; await sleep(4500);
  assert.equal(mainFrame.length, settled, "no reload after the app is up");
  console.log("step5-no-reload-after-success");

  // 6. (a) Not one main-frame response in the whole sequence was JSON.
  assert.deepEqual(mainFrame.filter((r) => /json/i.test(r.type)), [], "no JSON page response");
  assert.ok(mainFrame.some((r) => r.status === 503 && /^text\/html/.test(r.type)), "the setup page was served as html");
  assert.equal(mainFrame.at(-1).status, 200);
  console.log(`step6-no-json-main-frame-responses-of-${mainFrame.length}`);
  // The headers the server really saw: every page load was a document navigation and carried the window's language.
  assert.ok(requests.length >= 3, `main-frame requests recorded: ${requests.length}`);
  for (const r of requests) {
    assert.equal(r.dest, "document", `sec-fetch-dest on ${r.url}`);
    assert.equal(r.mode, "navigate");
    assert.match(String(r.accept), /text\/html/);
    assert.ok(String(r.lang).toLowerCase().startsWith(lang ? lang.split("-")[0] : "en"), `accept-language ${r.lang}`);
  }
  console.log(`step6b-request-headers-document-navigate-${lang || "en"}-x${requests.length}`);

  // 7. (e) The real startup error page: its log link opens the log, which proves the data: URL round-trips through getURL().
  const errorUrl = errorCtx.buildErrorPage({ allPortsOccupied: false });
  await win.loadURL(errorUrl);
  assert.equal(win.webContents.getURL(), errorUrl, "the committed data: URL equals the URL main built (else switch to a per-build nonce)");
  assert.equal(readiness.ready(win.webContents), false, "the error page is not the app");
  await win.webContents.executeJavaScript("document.querySelector('a[target=_blank]').click()", true); await sleep(400);
  assert.equal(opened.log, 2, "the error page's log link opens the log");
  console.log("step7-error-page-log-link-opens-log");

  // 8. Another data: page asking for the same address is refused.
  await win.loadURL("data:text/html," + encodeURIComponent(`<a id="x" target="_blank" href="${OPEN_LOG_URL}">x</a>`));
  await win.webContents.executeJavaScript("document.getElementById('x').click()", true); await sleep(400);
  assert.equal(opened.log, 2, "another data: page cannot open the log");
  console.log("step8-other-data-page-refused");
  console.log("setup-page-window-passed");
}

main().then(() => 0, (error) => { console.log(`FAILED: ${error?.stack ?? error}`); console.log(`server log tail: ${serverLog.slice(-3000)}`); return 1; })
  .then(async (code) => { try { server?.kill("SIGTERM"); await sleep(500); safeWipeSync(home); } catch { /* best effort */ } app.exit(code); });
