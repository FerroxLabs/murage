// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 real-window fixture (design A8). A REAL BrowserWindow with the production preload, window-open handler,
// navigation guard and readiness tracker, against the REAL server entry (server/index.ts, started the way main forks the
// packaged child: Electron's own Node, MURAGE_STATIC_DIR, an isolated data dir, a free port, no network or engine keys).
// index.html is removed, the setup page is asserted, index.html is restored, and the app must arrive by the page's own refresh.
// Run under Electron (xvfb-run on a display-less Linux box); electron/setup-page.electron.test.mjs launches it.
import { app, BrowserWindow, ipcMain, session, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let serverExited = null;
  const forkServer = () => {
    serverExited = null;
    const child = utilityProcess.fork(entry, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: home, USERPROFILE: home, MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(webhook), MURAGE_DEV_DESKTOP_SECRET: "ab".repeat(32), MURAGE_STATIC_UI_TRACE: "1", PATH: process.env.PATH ?? "" },
    });
    child.stdout.on("data", (c) => { serverLog += c; }); child.stderr.on("data", (c) => { serverLog += c; });
    child.once("exit", (code) => { serverExited = code; });
    return child;
  };
  server = forkServer();
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
  const mainSource = readFileSync(path.join(electronDir, "main.mjs"), "utf8");
  // main's own inspect of the live main document, sliced out of main.mjs, not copied.
  const inspectCtx = vm.createContext({});
  vm.runInContext(mainSource.slice(mainSource.indexOf("function inspectMainDocument("), mainSource.indexOf("const appReadiness = createAppReadiness(")), inspectCtx);
  const inspectMainDocument = inspectCtx.inspectMainDocument;
  const readiness = createAppReadiness({ origin: () => origin, inspect: inspectMainDocument });
  const loadRecovery = process.env.MURAGE_TEST_LOAD_RECOVERY === "0" ? null : await import("../load-failure-recovery.mjs").catch(() => null);
  // The error page main built, exactly as main.mjs builds it (the function is sliced out of main.mjs, not copied).
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
  // Production wiring (main.mjs, A15): a window left on an error document of the app origin reloads once the server answers health.
  // The recovery handle sits in a WeakMap exactly as in main, and the reload spy wrapper counts what recovery itself loads.
  const loadFailureRecoveries = new WeakMap();
  const recovery = { reloads: 0, log: [], hrefCalls: 0, healthCalls: 0 };
  const live = () => inspectMainDocument(win.webContents);
  loadFailureRecoveries.set(win.webContents, loadRecovery?.attachLoadFailureRecovery(win.webContents, {
    origin: () => origin,
    inspect: live,
    readiness: () => readiness.stateOf(win.webContents),
    busy: () => false,
    documentHref: () => { recovery.hrefCalls += 1; return win.webContents.mainFrame.executeJavaScript("location.href", false); },
    healthy: async () => { recovery.healthCalls += 1; return (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })).ok; },
    reload: (target) => { recovery.reloads += 1; void win.loadURL(target).catch(() => {}); },
    log: (line) => { recovery.log.push(line); console.log(`recovery: ${line}`); },
  }));

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

  // 9. (S7) The server child dies while the window is on the setup page. The setup page's own refresh meets a dead server and Chromium
  // commits an error document (chrome-error://chromewebdata), which never refreshes. When the child is back the window must recover on its
  // own, and never show JSON on the way. The index is removed first so the first page after the restart is the setup page again.
  rmSync(path.join(staticDir, "index.html"));
  await win.loadURL(`${origin}/s7`).catch(() => {});
  assert.equal(await text("t"), words.title, "back on the setup page before the kill");
  const jsonBefore = mainFrame.filter((r) => /json/i.test(r.type)).length;
  const onErrorDocument = () => loadRecovery.errorCandidate(live(), origin);
  // Diagnostic reads of the renderer's own location.href call mainFrame.executeJavaScript directly, never through the recovery wrapper.
  const documentHref = () => win.webContents.mainFrame.executeJavaScript("location.href", false);
  const describeDoc = () => { const d = live() ?? {}; return `getURL=${d.committedUrl} mainFrame.url=${d.frameUrl} origin=${d.frameOrigin} entry=${d.entryUrl}`; };
  // One kill/restart cycle. `kick` calls main's running-transition line the moment the restarted child answers /api/health.
  const cycle = async (kick) => {
    server.kill();
    await waitFor(() => serverExited !== null, 10000, "the killed server child to exit");
    await waitFor(onErrorDocument, 12000, "the refresh to hit the dead server and leave an error document (A15 predicate)");
    const href = await documentHref();
    assert.ok(typeof href === "string" && href.startsWith("chrome-error://"), `the renderer's own location.href on the error document starts with chrome-error:// (got ${JSON.stringify(href)})`);
    console.log(`step9a-window-on-error-document-after-kill ${describeDoc()} documentHref=${href}`);
    const logFrom = recovery.log.length;
    await sleep(1500);
    server = forkServer();
    await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, 60000, "the restarted server child");
    const backAt = Date.now();
    if (kick) loadFailureRecoveries.get(win.webContents)?.kick();
    await waitFor(async () => (await text("t")) === words.title, kick ? 3000 : 15000, "the window to leave the error document for the setup page");
    const lines = recovery.log.slice(logFrom);
    const confirmedLine = lines.find((line) => line.startsWith("load recovery: error document"));
    assert.ok(confirmedLine && /href=chrome-error:\/\//.test(confirmedLine), `the production confirm call's href=chrome-error:// is in the recovery log: ${JSON.stringify(lines)}`);
    assert.ok(lines.findIndex((line) => line.includes("reloading")) > lines.indexOf(confirmedLine), "and the reload follows it");
    console.log(`recovery-line: ${confirmedLine}`);
    return Date.now() - backAt;
  };
  console.log(`step9b-setup-page-back-in-${await cycle(true)}ms (kick path, bound 3000ms)`);
  console.log(`step9bprime-setup-page-back-without-kick-in-${await cycle(false)}ms (bound 15000ms)`);
  writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>Packaged Murage</title><p id=\"app\">app</p>");
  await waitFor(async () => (await win.webContents.executeJavaScript("document.title")) === "Packaged Murage", 9000, "the app after the restore");
  assert.equal(mainFrame.filter((r) => /json/i.test(r.type)).length, jsonBefore, "no JSON during the S7 recovery");
  console.log("step9c-app-back-no-json");

  // 9d. No unsolicited reload (Astra r1 #7): a navigation to the app that is started and then stopped leaves the app on screen, and
  // recovery issues no load of its own afterwards, well beyond the maximum backoff plus the probe.
  const loadsBefore = recovery.reloads, logBefore = recovery.log.length;
  for (let i = 0; i < 2; i += 1) {
    const started = new Promise((resolve) => win.webContents.once("did-start-navigation", (event, url, _inPlace, isMainFrame) => resolve(event?.isMainFrame ?? isMainFrame)));
    const loading = win.loadURL(origin).catch(() => {});
    await started;
    win.webContents.stop();
    await loading;
    const d = live();
    assert.ok(d.committedUrl.startsWith(origin) && d.frameOrigin === origin, `the app document is still shown (${describeDoc()})`);
  }
  await sleep(15000);
  assert.equal(recovery.reloads, loadsBefore, "zero recovery-issued loads after a stopped navigation");
  assert.ok(!recovery.log.slice(logBefore).some((line) => line.includes("reloading")), "the recovery log has no reloading line");
  console.log("step9d-no-unsolicited-reload");

  // 9e. (rev 2.5.1) The real server sends a CSP sandbox on the diagram frame's route, matched on the DECODED path, so the plain and the
  // percent-encoded spelling of the same file are both opaque-origin documents with an http URL. Loaded top-level, each is a recovery
  // candidate that the renderer must answer for: recovery asks, learns it is a page, and never probes health or reloads. The frame file
  // is named exactly the way the build names it (content hash), and each row counts only if its own response carries the sandbox.
  const frameHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${"A".repeat(43)}='"><title>frame</title>`;
  const frameName = `mermaid-frame-${createHash("sha256").update(frameHtml, "utf8").digest("hex").slice(0, 16)}.html`;
  writeFileSync(path.join(staticDir, frameName), frameHtml);
  let counted = 0;
  for (const url of [`${origin}/${frameName}`, `${origin}/%6d${frameName.slice(1)}`]) {
    const res = await fetch(url); // the URL object keeps the percent-encoding as written
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.equal(res.status, 200, `${url} is served`);
    assert.ok(/(?:^|;)\s*sandbox(?:\s|;|$)/.test(csp), `${url}: the real response carries the sandbox CSP directive (got ${JSON.stringify(csp)})`);
    counted += 1;
    await win.loadURL(url).catch(() => {});
    await waitFor(() => win.webContents.getURL() === url && live()?.frameOrigin === "null", 8000, `${url} committed as an opaque-origin document`);
    assert.equal(win.webContents.mainFrame.origin, "null", "the decoded route got the sandbox: origin is opaque");
    const href = await documentHref();
    assert.ok(typeof href === "string" && href.startsWith("http"), `documentHref is the http URL (got ${JSON.stringify(href)})`);
    // A successful 200 commit can leave READY, which skips confirmation; drive the window into eligibility with the ambiguous failure.
    const before = { reloads: recovery.reloads, health: recovery.healthCalls, log: recovery.log.length };
    recovery.hrefCalls = 0;
    win.webContents.emit("did-fail-load", {}, -102, "ERR_CONNECTION_REFUSED", url, true);
    win.webContents.emit("did-stop-loading");
    assert.equal(readiness.stateOf(win.webContents), "NOT_READY", "the tracker is NOT_READY after the ambiguous failure");
    await sleep(15000);
    assert.ok(recovery.hrefCalls >= 1, `recovery's own confirmation ran (${recovery.hrefCalls} calls)`);
    assert.equal(recovery.healthCalls, before.health, "0 health calls from recovery");
    assert.equal(recovery.reloads, before.reloads, "0 recovery reloads");
    assert.ok(!recovery.log.slice(before.log).some((line) => line.includes("error document")), "no error document line");
    console.log(`step9e-sandboxed-frame-left-alone ${url} origin=null csp=${JSON.stringify(csp)} confirmCalls=${recovery.hrefCalls}`);
  }
  assert.equal(counted, 2, "both mermaid rows counted");
  console.log("setup-page-window-passed");
}

main().then(() => 0, (error) => { console.log(`FAILED: ${error?.stack ?? error}`); console.log(`server log tail: ${serverLog.slice(-3000)}`); return 1; })
  .then(async (code) => { try { server?.kill("SIGTERM"); await sleep(500); safeWipeSync(home); } catch { /* best effort */ } app.exit(code); });
