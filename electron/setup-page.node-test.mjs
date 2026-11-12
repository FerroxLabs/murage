// SPDX-License-Identifier: AGPL-3.0-or-later
// WIN-NOROUTE-1019 T9-T12 (design rev 2.2, A5-A7). The server answers an unservable page load with its own setup page (503), so
// Electron has no gate. What is left on this side: the log-link token has two trusted senders (the app origin and the exact
// startup error page), and a pending package install or Cloud link is delivered only to a window that is showing the app.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

import * as perms from "./app-permissions.mjs";
import * as readiness from "./app-readiness.mjs";
import { createCloudLinkQueue } from "./cloud-link-queue.mjs";

const electronDir = path.dirname(fileURLToPath(import.meta.url));
const main = readFileSync(path.join(electronDir, "main.mjs"), "utf8");
// Read off the module so a missing export fails the assertion (behavior), not the import.
const OPEN = perms.OPEN_LOG_URL ?? "murage-open-log:now";
const ORIGIN = "http://127.0.0.1:8799";
const ERROR_PAGE = "data:text/html;charset=utf-8,%3Cbody%3Eerror%3C%2Fbody%3E";
const act = (url, context) => perms.mainWindowOpenAction(url, context);

test("T9 the log token is accepted from the app origin and the exact error page, and from nowhere else", () => {
  const ctx = (over) => ({ currentUrl: `${ORIGIN}/any`, trustedOrigin: ORIGIN, errorPageUrl: ERROR_PAGE, ...over });
  assert.deepEqual(act(OPEN, ctx()), { kind: "diagnostics-log" });
  assert.deepEqual(act(OPEN, ctx({ currentUrl: `${ORIGIN}/deep/route?x=1#h` })), { kind: "diagnostics-log" });
  assert.deepEqual(act(OPEN, ctx({ currentUrl: ERROR_PAGE })), { kind: "diagnostics-log" });
  const refused = [
    ["another data: page", ctx({ currentUrl: "data:text/html,%3Cb%3Eevil%3C%2Fb%3E" })],
    ["the error page URL with something appended", ctx({ currentUrl: `${ERROR_PAGE}%3Cscript%3E` })],
    ["https://evil.example", ctx({ currentUrl: "https://evil.example/" })],
    ["an empty current URL", ctx({ currentUrl: "" })],
    ["no current URL", ctx({ currentUrl: undefined })],
    ["a wrong port", ctx({ currentUrl: "http://127.0.0.1:8800/" })],
    ["127.0.0.1.evil", ctx({ currentUrl: "http://127.0.0.1.evil/" })],
    ["localhost for 127.0.0.1", ctx({ currentUrl: "http://localhost:8799/" })],
    ["a userinfo trick", ctx({ currentUrl: "http://127.0.0.1:8799@evil.example/" })],
    ["a file: page", ctx({ currentUrl: "file:///C:/Profiles/x/AppData/Murage/server.log" })],
    ["an unset trusted origin", ctx({ trustedOrigin: undefined })],
    ["a null trusted origin on the app page", ctx({ trustedOrigin: null })],
    ["a malformed trusted origin", ctx({ trustedOrigin: "not a url" })],
    ["an opaque (data:) trusted origin", ctx({ trustedOrigin: "data:text/html,x", currentUrl: "data:text/html,x" , errorPageUrl: undefined })],
    ["an unset error page URL on a data: page", ctx({ currentUrl: ERROR_PAGE, errorPageUrl: undefined, trustedOrigin: ORIGIN })],
    ["an empty error page URL", ctx({ currentUrl: "", errorPageUrl: "" })],
    ["a bare data:text/html error page URL on both sides", ctx({ currentUrl: "data:text/html", errorPageUrl: "data:text/html", trustedOrigin: ORIGIN })],
    ["an error page URL with an empty body", ctx({ currentUrl: "data:text/html,", errorPageUrl: "data:text/html,", trustedOrigin: ORIGIN })],
    ["a non-data: error page URL", ctx({ currentUrl: "https://evil.example/", errorPageUrl: "https://evil.example/", trustedOrigin: undefined })],
  ];
  for (const [name, context] of refused) assert.deepEqual(act(OPEN, context), { kind: "refuse" }, name);
  // The old file:// link is gone everywhere: the address is refused, and the legacy parameter changes nothing.
  const logFile = "file:///C:/Profiles/x/AppData/Local/Murage/logs/server.log";
  for (const currentUrl of [ERROR_PAGE, `${ORIGIN}/`, "data:text/html,x"]) {
    assert.deepEqual(act(logFile, { currentUrl, trustedOrigin: ORIGIN, errorPageUrl: ERROR_PAGE, diagnosticsLogHref: logFile }), { kind: "refuse" }, currentUrl);
  }
  // Any other address keeps its policy from the app page.
  assert.deepEqual(act("https://example.com/a", ctx()), { kind: "external", url: "https://example.com/a" });
  assert.deepEqual(act("javascript:alert(1)", ctx()), { kind: "refuse" });
});

test("T9 the window open handler forwards the trusted origin and the error page URL, and opens the log once", () => {
  const opened = [];
  const handler = (currentUrl) => perms.createMainWindowOpenHandler({
    openExternal: async () => {}, openDiagnosticsLog: async () => { opened.push("log"); },
    currentUrl: () => currentUrl, trustedOrigin: () => ORIGIN, errorPageUrl: () => ERROR_PAGE,
  });
  assert.deepEqual(handler(`${ORIGIN}/x`)({ url: OPEN }), { action: "deny" });
  assert.deepEqual(handler(ERROR_PAGE)({ url: OPEN }), { action: "deny" });
  assert.equal(opened.length, 2);
  handler("data:text/html,evil")({ url: OPEN }); handler("https://evil.example/")({ url: OPEN }); handler("")({ url: OPEN });
  assert.equal(opened.length, 2, "an untrusted page never opens the log");
  // Fail closed: a getter that throws, or that is missing, refuses.
  perms.createMainWindowOpenHandler({ openExternal: async () => {}, openDiagnosticsLog: async () => { opened.push("bad"); }, currentUrl: () => ERROR_PAGE, trustedOrigin: () => { throw new Error("x"); }, errorPageUrl: () => ERROR_PAGE })({ url: OPEN });
  perms.createMainWindowOpenHandler({ openExternal: async () => {}, openDiagnosticsLog: async () => { opened.push("bad"); }, currentUrl: () => ERROR_PAGE })({ url: OPEN });
  assert.equal(opened.includes("bad"), false);
});

test("T10 the startup error page links the log through the private address and has no file: link", () => {
  const start = main.indexOf("function escapeHtml(value)");
  const end = main.indexOf("// How long one packaged-server child");
  assert.ok(start > 0 && end > start, "buildErrorPage is where the test expects");
  const ctx = vm.createContext({ path, pathToFileURL, LOG_DIR: path.join(path.sep, "var", "log", "murage"), OPEN_LOG_URL: OPEN });
  vm.runInContext(main.slice(start, end), ctx);
  for (const allPortsOccupied of [false, true]) {
    const url = ctx.buildErrorPage({ allPortsOccupied });
    assert.ok(url.startsWith("data:text/html"));
    const html = decodeURIComponent(url.slice(url.indexOf(",") + 1));
    assert.ok(html.includes('href="murage-open-log:now"'), html);
    assert.equal(html.includes("file:"), false, html);
    assert.equal(vm.runInContext("lastErrorPageUrl", ctx), url, "the URL main built is the one it remembers");
  }
});

// ---- readiness (A5) ----
const fakeContents = () => Object.assign(new EventEmitter(), { id: Math.random() });
const nav = (wc, url, code, extra = {}) => { wc.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false, ...extra }); wc.emit("did-navigate", {}, url, code, ""); };

test("T11 appPageLoaded is true only for a 200 on the trusted origin", () => {
  const f = (url, code, origin = ORIGIN) => readiness.appPageLoaded({ url, code, origin });
  assert.equal(f(`${ORIGIN}/`, 200), true);
  assert.equal(f(`${ORIGIN}/deep/route?x=1`, 200), true);
  assert.equal(f(`${ORIGIN}/`, 503), false);
  assert.equal(f(`${ORIGIN}/`, 404), false);
  assert.equal(f("data:text/html,x", 200), false);
  assert.equal(f("data:text/html,x", 0), false);
  assert.equal(f("http://127.0.0.1:8800/", 200), false);
  assert.equal(f("http://127.0.0.1.evil/", 200), false);
  assert.equal(f("https://evil.example/", 200), false);
  assert.equal(f(`${ORIGIN}/`, 200, null), false);
  assert.equal(readiness.appPageLoaded({ url: `${ORIGIN}/`, code: 200 }), false);
  assert.equal(f(`${ORIGIN}/`, 200, "data:text/html,x"), false);
});

test("T11 a window is ready only while it shows the app; every way off the app clears it", () => {
  const tracker = readiness.createAppReadiness({ origin: () => ORIGIN });
  const wc = fakeContents();
  tracker.track(wc);
  assert.equal(tracker.ready(wc), false, "a new window starts not ready");
  nav(wc, `${ORIGIN}/`, 503);
  assert.equal(tracker.ready(wc), false, "the setup page (503)");
  nav(wc, `${ORIGIN}/`, 200);
  assert.equal(tracker.ready(wc), true, "the meta refresh reached the app");
  // 200 -> pushState / hash route keeps it (did-navigate does not fire again)
  wc.emit("did-start-navigation", { url: `${ORIGIN}/chat/1`, isMainFrame: true, isSameDocument: true });
  wc.emit("did-navigate-in-page", {}, `${ORIGIN}/chat/1`, true);
  assert.equal(tracker.ready(wc), true, "in-page navigation keeps readiness");
  // a subframe starting a navigation does not clear it
  wc.emit("did-start-navigation", { url: "https://x/", isMainFrame: false, isSameDocument: false });
  assert.equal(tracker.ready(wc), true);
  // 200 -> 503
  nav(wc, `${ORIGIN}/`, 503);
  assert.equal(tracker.ready(wc), false, "200 then 503");
  nav(wc, `${ORIGIN}/`, 200);
  // a main-frame navigation starting clears it until it commits
  wc.emit("did-start-navigation", { url: `${ORIGIN}/`, isMainFrame: true, isSameDocument: false });
  assert.equal(tracker.ready(wc), false, "cleared at the start of a main-frame navigation");
  wc.emit("did-navigate", {}, `${ORIGIN}/`, 200, "");
  assert.equal(tracker.ready(wc), true);
  // the legacy positional form of did-start-navigation clears too
  wc.emit("did-start-navigation", {}, `${ORIGIN}/`, false, true);
  assert.equal(tracker.ready(wc), false, "legacy argument order");
  nav(wc, `${ORIGIN}/`, 200);
  // transport failure
  wc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", `${ORIGIN}/`, true);
  assert.equal(tracker.ready(wc), false, "transport failure");
  nav(wc, `${ORIGIN}/`, 200);
  wc.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://x/", false);
  assert.equal(tracker.ready(wc), true, "a subframe failing leaves it");
  // renderer gone
  wc.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(tracker.ready(wc), false, "renderer gone");
  // a data: page (the startup error page) and another origin
  nav(wc, ERROR_PAGE, 0);
  assert.equal(tracker.ready(wc), false);
  nav(wc, "https://evil.example/", 200);
  assert.equal(tracker.ready(wc), false);
  // replacement: a new webContents is not ready whatever the old one was
  nav(wc, `${ORIGIN}/`, 200);
  const replacement = fakeContents();
  tracker.track(replacement);
  assert.equal(tracker.ready(wc), true);
  assert.equal(tracker.ready(replacement), false, "window replacement (gpu-lost)");
  assert.equal(tracker.ready(null), false);
  assert.equal(tracker.ready(undefined), false);
});

test("T11 an unset or changing origin fails closed", () => {
  let origin = null;
  const tracker = readiness.createAppReadiness({ origin: () => origin });
  const wc = fakeContents();
  tracker.track(wc);
  nav(wc, `${ORIGIN}/`, 200);
  assert.equal(tracker.ready(wc), false, "no trusted origin yet");
  origin = ORIGIN;
  nav(wc, `${ORIGIN}/`, 200);
  assert.equal(tracker.ready(wc), true);
});

// ---- the two delivery entry points, as main.mjs wires them ----
function sliceBetween(start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from);
  assert.ok(from > 0 && to > from, `main.mjs has ${start}`);
  return main.slice(from, to);
}
function packageDelivery(tracker, win) {
  const ctx = vm.createContext({ appReadiness: tracker, pendingPackageInstallUrl: "murage://package/x", BrowserWindow: { getAllWindows: () => [win] } });
  vm.runInContext(sliceBetween("function deliverPackageInstall(", "function queuePackageInstall("), ctx);
  return { deliver: () => ctx.deliverPackageInstall(win), pending: () => vm.runInContext("pendingPackageInstallUrl", ctx) };
}
const fakeWindow = (wc) => { const sent = []; wc.send = (channel, ...args) => sent.push([channel, ...args]); wc.isLoadingMainFrame = () => false; return { webContents: wc, isDestroyed: () => false, sent }; };

test("T11 a package install waits on a 503 page, is delivered once after the app loads, and is not lost", () => {
  const tracker = readiness.createAppReadiness({ origin: () => ORIGIN });
  const wc = fakeContents(); tracker.track(wc);
  const win = fakeWindow(wc);
  const { deliver, pending } = packageDelivery(tracker, win);
  nav(wc, `${ORIGIN}/`, 503);
  wc.emit("did-finish-load");
  deliver();
  assert.equal(win.sent.length, 0, "nothing is sent to the setup page");
  assert.equal(pending(), "murage://package/x", "it stays queued");
  deliver(); // a link that arrives while the 503 page is idle
  assert.equal(win.sent.length, 0);
  nav(wc, `${ORIGIN}/`, 200);
  deliver();
  assert.deepEqual(win.sent, [["package:install", "murage://package/x"]], "delivered after recovery");
  deliver();
  assert.equal(win.sent.length, 1, "exactly once");
  assert.equal(pending(), null);
});

test("T11 a package install is not sent to a window whose renderer is gone or that was replaced", () => {
  const tracker = readiness.createAppReadiness({ origin: () => ORIGIN });
  const wc = fakeContents(); tracker.track(wc);
  const win = fakeWindow(wc);
  const { deliver } = packageDelivery(tracker, win);
  nav(wc, `${ORIGIN}/`, 200);
  wc.emit("render-process-gone", {}, { reason: "gpu-lost" });
  deliver();
  assert.equal(win.sent.length, 0);
  const wc2 = fakeContents(); tracker.track(wc2);
  const win2 = fakeWindow(wc2);
  const second = packageDelivery(tracker, win2);
  second.deliver();
  assert.equal(win2.sent.length, 0, "the replacement window starts not ready");
  nav(wc2, `${ORIGIN}/`, 200);
  second.deliver();
  assert.equal(win2.sent.length, 1);
});

test("T11 a Cloud link drains only into a window that is showing the app, from every drain path", async () => {
  const tracker = readiness.createAppReadiness({ origin: () => ORIGIN });
  const wc = fakeContents(); tracker.track(wc);
  const ctx = vm.createContext({ appReadiness: tracker, mainWindow: { isDestroyed: () => false, webContents: Object.assign(wc, { isLoadingMainFrame: () => false, send() {} }) } });
  vm.runInContext(sliceBetween("const cloudLinkWindowLoaded", "let pendingCloudLinkEvent"), ctx);
  const handled = [];
  const windowLoaded = vm.runInContext("cloudLinkWindowLoaded", ctx);
  const queue = createCloudLinkQueue({ ready: () => true, live: () => true, windowLoaded, handle: (link) => { handled.push(link.kind); } });
  nav(wc, `${ORIGIN}/`, 503);
  wc.emit("did-finish-load");
  queue.enqueue({ kind: "connect-cloud", url: "murage://connect-cloud" });
  assert.equal(queue.drain(), false, "did-finish-load / live flip / startup paths all go through this check");
  assert.equal(queue.pendingKind(), "connect-cloud", "the link stays queued while the setup page is up");
  nav(wc, `${ORIGIN}/`, 200);
  wc.emit("did-finish-load");
  assert.equal(queue.drain(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(handled, ["connect-cloud"], "exactly once after recovery");
  assert.equal(queue.drain(), false);
});

test("T11 a Cloud link event raised while the window is on the setup page is kept and delivered once after the app loads", async () => {
  const tracker = readiness.createAppReadiness({ origin: () => ORIGIN });
  const wc = fakeContents(); tracker.track(wc);
  const sent = [];
  const win = { isDestroyed: () => false, webContents: Object.assign(wc, { send: (...a) => sent.push(a), isLoadingMainFrame: () => false }) };
  const ctx = vm.createContext({ appReadiness: tracker, mainWindow: win });
  vm.runInContext(sliceBetween("let pendingCloudLinkEvent", "function focusConnectCard"), ctx);
  const windowLoaded = (() => { const c = vm.createContext({ appReadiness: tracker, mainWindow: win }); vm.runInContext(sliceBetween("const cloudLinkWindowLoaded", "let pendingCloudLinkEvent"), c); return vm.runInContext("cloudLinkWindowLoaded", c); })();
  // The production shape: the queue drains into an ASYNC handler that awaits, and the window leaves the app during the await.
  nav(wc, `${ORIGIN}/`, 200);
  const queue = createCloudLinkQueue({
    ready: () => true, live: () => true, windowLoaded,
    handle: async (link) => { await new Promise((resolve) => setImmediate(resolve)); nav(wc, `${ORIGIN}/`, 503); ctx.tellCloudLinkWindow({ kind: link.kind }); },
  });
  queue.enqueue({ kind: "door", url: "murage://door" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 0, "nothing reaches the setup page");
  ctx.flushCloudLinkEvent(win);
  assert.equal(sent.length, 0, "still on the setup page: it stays kept");
  nav(wc, `${ORIGIN}/`, 200);
  ctx.flushCloudLinkEvent(win);
  assert.deepEqual(sent, [["cloud-home:link-event", { kind: "door" }]], "the original event, once, after recovery");
  ctx.flushCloudLinkEvent(win);
  assert.equal(sent.length, 1, "exactly once");
  // a replacement window is never sent the kept event
  ctx.tellCloudLinkWindow({ kind: "connect-cloud" });
  assert.equal(sent.length, 2, "ready window: sent straight away");
});

test("T11 main.mjs wires the tracker per window and keeps the did-finish-load line", () => {
  assert.match(main, /appReadiness\.track\(win\.webContents\)/);
  assert.match(main, /did-finish-load", \(\) => flushCloudLinkEvent\(win\)/);
  // every Cloud link drain goes through the one queue whose window gate is the readiness check
  assert.match(main, /windowLoaded: cloudLinkWindowLoaded,/);
  assert.equal((main.match(/cloudLinks\.drain\(\)/g) ?? []).length, 4, "the four drain entry points: did-finish-load, live flip, end of startup, a cancelled navigation giving the app back");
  assert.match(main, /const cloudLinkWindowLoaded = \(\) => Boolean\(mainWindow && !mainWindow\.isDestroyed\(\) && appReadiness\.ready\(mainWindow\.webContents\)/);
  assert.match(main, /did-finish-load", \(\) => \{ deliverPackageInstall\(win\); cloudLinks\.drain\(\); appReadiness\.flush\(win\.webContents\); \}/);
  assert.match(main, /createAppReadiness\(\{\s*origin: \(\) => trustedRendererOrigin\(\),(?:[\s\S]*?\bprobe:[\s\S]*?)?\s*onRestored:/);
  assert.match(main, /trustedOrigin: \(\) => trustedRendererOrigin\(\)/);
  assert.match(main, /errorPageUrl: \(\) => lastErrorPageUrl/);
});

test("T12 nothing under electron/ imports ui-gate, and the gate files are gone", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) { if (entry !== "node_modules") walk(full); continue; }
      if (/ui-gate/.test(entry)) offenders.push(`${full} (file)`);
      if (!/\.(mjs|cjs|js|ts)$/.test(entry) || full === fileURLToPath(import.meta.url)) continue;
      if (/ui-gate|attachMainUiGate/.test(readFileSync(full, "utf8"))) offenders.push(full);
    }
  };
  walk(electronDir);
  assert.deepEqual(offenders, []);
});
