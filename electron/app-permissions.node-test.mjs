// Adapted from OpenMausBot PR #986 (electron/app-permissions.node-test.mjs),
// Apache License 2.0. Murage additions cover the owned-main-window binding,
// the gated IPC handler, the window.open handler and the startup log link.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  appPermissionAllowed,
  createMainWindowOpenHandler,
  createOpenExternalHandler,
  externalWebUrl,
  mainAppPermissionCheckAllowed,
  mainAppPermissionRequestAllowed,
  mainWindowOpenAction,
  ownedMainSenderGate,
} from "./app-permissions.mjs";

const LOCAL_ORIGIN = "http://127.0.0.1:5199";
const LOCAL_PAGE = "http://127.0.0.1:5199/chat?botId=bot-1";

// --- pure policy (upstream cases kept verbatim, plus security-origin checks) ---

test("grants notifications, clipboard, and fullscreen to the local renderer page", () => {
  for (const permission of ["notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), true, permission);
  }
});

test("accepts a bare origin or a full URL on either side", () => {
  assert.equal(appPermissionAllowed("notifications", LOCAL_ORIGIN, LOCAL_ORIGIN), true);
  assert.equal(appPermissionAllowed("notifications", `${LOCAL_ORIGIN}/settings#voice`, `${LOCAL_ORIGIN}/`), true);
  assert.equal(appPermissionAllowed("fullscreen", "http://127.0.0.1:8799/chat", "http://127.0.0.1:8799"), true);
});

test("allows media for audio (microphone) and guarded display-capture, denies video (camera)", () => {
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio"] }), true);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "audio" }), true);
  // Electron 43 routes getDisplayMedia through permission="media" with an empty
  // mediaTypes array before dispatching to setDisplayMediaRequestHandler.
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: [] }), true);

  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio", "video"] }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "video" }), false);

  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaType: "unknown" }), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, {}), false);
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("media requests also require Chromium's security origin to be the renderer origin", () => {
  assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio"], securityOrigin: `${LOCAL_ORIGIN}/` }), true);
  for (const securityOrigin of ["https://other.example/", "http://127.0.0.1:5200/", "null", "", "not a url", null, 7]) {
    assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, { mediaTypes: ["audio"], securityOrigin }), false, String(securityOrigin));
  }
});

test("refuses permissions to any other origin", () => {
  assert.equal(appPermissionAllowed("notifications", "https://other.example/chat", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("clipboard-read", "http://127.0.0.1:5200/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("media", "https://127.0.0.1:5199/", LOCAL_ORIGIN, { mediaTypes: ["audio"] }), false);
  assert.equal(appPermissionAllowed("fullscreen", "http://localhost:5199/", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("fullscreen", "http://127.0.0.1:5199.evil.test/", LOCAL_ORIGIN), false);
});

test("keeps every privileged capability off even for the local renderer page", () => {
  const privileged = [
    "geolocation", "camera", "usb", "hid", "serial", "midi", "midiSysex",
    "display-capture", "fileSystem", "openExternal", "idle-detection", "speaker-selection",
    "window-management", "storage-access", "top-level-storage-access", "pointerLock",
    "keyboardLock", "mediaKeySystem", "unknown",
  ];
  for (const permission of privileged) {
    assert.equal(appPermissionAllowed(permission, LOCAL_PAGE, LOCAL_ORIGIN), false, permission);
  }
  assert.equal(appPermissionAllowed(undefined, LOCAL_PAGE, LOCAL_ORIGIN), false);
});

test("rejects mixed, unknown, and conflicting media details", () => {
  for (const details of [
    { mediaTypes: ["audio", "unknown"] }, { mediaTypes: ["unknown"] },
    { mediaType: "audio", mediaTypes: ["video"] },
    { mediaType: "unknown", mediaTypes: [] }, { mediaTypes: "audio" }, null,
  ]) assert.equal(appPermissionAllowed("media", LOCAL_PAGE, LOCAL_ORIGIN, details), false, JSON.stringify(details));
});

test("fails closed on unparsable or opaque origins", () => {
  assert.equal(appPermissionAllowed("notifications", "not a url", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", "", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", undefined, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", null, LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, "not a url"), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, undefined), false);
  assert.equal(appPermissionAllowed("notifications", LOCAL_PAGE, null), false);
  // Opaque origins all serialise as "null"; two of them must never match.
  assert.equal(appPermissionAllowed("notifications", "data:text/html,x", "about:blank"), false);
  assert.equal(appPermissionAllowed("notifications", "javascript:alert(1)", LOCAL_ORIGIN), false);
  assert.equal(appPermissionAllowed("notifications", "file:///index.html", "file:///index.html"), false);
});

// --- session handlers bound to the owned main window ---

function contents({ destroyed = false } = {}) {
  return { isDestroyed: () => destroyed };
}

test("permission requests are granted only to the owned main window's top frame", () => {
  const owned = contents();
  const base = { contents: owned, ownedContents: owned, origin: LOCAL_ORIGIN };
  const microphone = { isMainFrame: true, requestingUrl: LOCAL_PAGE, mediaTypes: ["audio"], securityOrigin: LOCAL_ORIGIN };
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: microphone }), true);
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: { ...microphone, mediaTypes: [] } }), true, "display routing");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "notifications", details: { isMainFrame: true, requestingUrl: LOCAL_PAGE } }), true);

  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: { ...microphone, mediaTypes: ["video"] } }), false, "camera");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, contents: contents(), permission: "media", details: microphone }), false, "another same-origin window");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: { ...microphone, isMainFrame: false } }), false, "same-origin subframe");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: { ...microphone, isMainFrame: undefined } }), false, "omitted frame identity");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: { ...microphone, requestingUrl: "https://other.example/" } }), false, "navigated away");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, permission: "media", details: undefined }), false);
  assert.equal(mainAppPermissionRequestAllowed({ ...base, ownedContents: null, permission: "media", details: microphone }), false, "no main window");
  assert.equal(mainAppPermissionRequestAllowed({ ...base, contents: null, permission: "media", details: microphone }), false);
  assert.equal(mainAppPermissionRequestAllowed({ ...base, origin: null, permission: "media", details: microphone }), false);
  const gone = contents({ destroyed: true });
  assert.equal(mainAppPermissionRequestAllowed({ ...base, contents: gone, ownedContents: gone, permission: "media", details: microphone }), false);
  const throwing = { isDestroyed: () => { throw new Error("destroyed"); } };
  assert.equal(mainAppPermissionRequestAllowed({ ...base, contents: throwing, ownedContents: throwing, permission: "media", details: microphone }), false);
  assert.equal(mainAppPermissionRequestAllowed(), false);
});

test("permission checks accept the owned top frame or a sender-less check on the renderer origin", () => {
  const owned = contents();
  const base = { ownedContents: owned, origin: LOCAL_ORIGIN };
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: owned, permission: "clipboard-sanitized-write", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true, requestingUrl: LOCAL_PAGE } }), true);
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: owned, permission: "media", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true, mediaType: "audio", securityOrigin: LOCAL_ORIGIN } }), true);
  // Electron passes null webContents for notifications checks.
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: null, permission: "notifications", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: false } }), true);
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: owned, permission: "fullscreen", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true, embeddingOrigin: LOCAL_ORIGIN } }), true, "same-origin embedder value");

  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: owned, permission: "media", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true, mediaType: "video" } }), false, "camera");
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: contents(), permission: "notifications", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true } }), false, "another window");
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: owned, permission: "clipboard-read", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: false } }), false, "same-origin subframe");
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: null, permission: "notifications", requestingOrigin: "https://other.example", details: { isMainFrame: false, embeddingOrigin: LOCAL_ORIGIN } }), false, "cross-origin subframe");
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: null, permission: "notifications", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: false, embeddingOrigin: "https://other.example" } }), false, "framed by a foreign page");
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: null, permission: "geolocation", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: false } }), false);
  assert.equal(mainAppPermissionCheckAllowed({ ...base, ownedContents: null, contents: owned, permission: "notifications", requestingOrigin: LOCAL_ORIGIN, details: { isMainFrame: true } }), false);
  assert.equal(mainAppPermissionCheckAllowed({ ...base, contents: null, permission: "notifications", requestingOrigin: "", details: undefined }), false);
  assert.equal(mainAppPermissionCheckAllowed(), false);
});

// --- external links ---

test("web links reject embedded credentials and non-web schemes", () => {
  assert.equal(externalWebUrl("https://example.com/help?q=hello#more"), "https://example.com/help?q=hello#more");
  assert.equal(externalWebUrl("http://127.0.0.1:8799"), "http://127.0.0.1:8799/");
  for (const url of ["https://user:pass@example.com", "http://user@example.com", "https://:pass@example.com"])
    assert.throws(() => externalWebUrl(url), /credentials/);
  for (const url of ["file:///tmp/test", "javascript:alert(1)", "data:text/html,test", "mailto:test@example.com", "x-apple.systempreferences:com.apple.preference.security"])
    assert.throws(() => externalWebUrl(url), /Only web/);
  for (const url of [null, 123, "not a url", ""])
    assert.throws(() => externalWebUrl(url), /web address/);
});

test("refusals never echo the rejected address", () => {
  for (const url of ["https://user:s3cret-token@example.com/x", "file:///Users/someone/private.txt", "not a url s3cret"]) {
    assert.throws(() => externalWebUrl(url), (error) => !error.message.includes("s3cret") && !error.message.includes("someone"));
  }
});

const LOG_HREF = "file:///Users/test/Library/Logs/Murage/server.log";
const ERROR_PAGE = "data:text/html;charset=utf-8,%3Cbody%3E";

test("window.open opens credential-free web links and only the startup page's exact log link", () => {
  assert.deepEqual(mainWindowOpenAction("https://example.com/a", { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }), { kind: "external", url: "https://example.com/a" });
  assert.deepEqual(mainWindowOpenAction(LOG_HREF, { currentUrl: ERROR_PAGE, diagnosticsLogHref: LOG_HREF }), { kind: "diagnostics-log" });

  for (const [url, context] of [
    ["https://user:pass@example.com", { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    ["javascript:alert(1)", { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    ["about:blank", { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    ["", { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    [undefined, { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    [LOG_HREF, { currentUrl: LOCAL_PAGE, diagnosticsLogHref: LOG_HREF }],
    ["file:///etc/passwd", { currentUrl: ERROR_PAGE, diagnosticsLogHref: LOG_HREF }],
    [`${LOG_HREF}?x`, { currentUrl: ERROR_PAGE, diagnosticsLogHref: LOG_HREF }],
    [LOG_HREF, { currentUrl: ERROR_PAGE, diagnosticsLogHref: null }],
    [LOG_HREF, { currentUrl: "https://other.example/", diagnosticsLogHref: LOG_HREF }],
    [LOG_HREF, {}],
  ]) assert.deepEqual(mainWindowOpenAction(url, context), { kind: "refuse" }, `${url} from ${context.currentUrl}`);
});

function windowOpenFixture({ current = LOCAL_PAGE, openExternal, openDiagnosticsLog } = {}) {
  const opened = [], logs = [], warnings = [];
  const handler = createMainWindowOpenHandler({
    openExternal: openExternal ?? (async (url) => { opened.push(url); }),
    openDiagnosticsLog: openDiagnosticsLog ?? (async () => { logs.push("server.log"); }),
    currentUrl: () => current,
    diagnosticsLogHref: () => LOG_HREF,
    warn: (message) => warnings.push(message),
  });
  return { handler, opened, logs, warnings };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the main-window popup handler always denies and opens only what the policy allows", async () => {
  const { handler, opened, logs, warnings } = windowOpenFixture();
  assert.deepEqual(handler({ url: "https://example.com/docs" }), { action: "deny" });
  for (const url of ["https://user:pass@example.com/", "file:///tmp/x", "javascript:alert(1)", "about:blank", "", 42]) {
    assert.deepEqual(handler({ url }), { action: "deny" });
  }
  assert.deepEqual(handler(), { action: "deny" });
  assert.deepEqual(handler({ url: LOG_HREF }), { action: "deny" });
  await settle();
  assert.deepEqual(opened, ["https://example.com/docs"]);
  assert.deepEqual(logs, [], "log link is not honoured from the app page");
  assert.deepEqual(warnings, []);

  const errorPage = windowOpenFixture({ current: ERROR_PAGE });
  assert.deepEqual(errorPage.handler({ url: LOG_HREF }), { action: "deny" });
  await settle();
  assert.deepEqual(errorPage.logs, ["server.log"]);
  assert.deepEqual(errorPage.opened, []);
});

test("popup opening failures are contained and logged without the address", async () => {
  const rejected = windowOpenFixture({ openExternal: async () => { throw new Error("no handler for https://secret.example"); } });
  assert.deepEqual(rejected.handler({ url: "https://secret.example/path" }), { action: "deny" });
  const thrown = windowOpenFixture({ openExternal: () => { throw new Error("sync"); } });
  assert.deepEqual(thrown.handler({ url: "https://secret.example/path" }), { action: "deny" });
  const logFailure = windowOpenFixture({ current: ERROR_PAGE, openDiagnosticsLog: async () => { throw new Error("gone"); } });
  assert.deepEqual(logFailure.handler({ url: LOG_HREF }), { action: "deny" });
  await settle();
  assert.deepEqual(rejected.warnings, ["The external web link could not be opened"]);
  assert.deepEqual(thrown.warnings, ["The external web link could not be opened"]);
  assert.deepEqual(logFailure.warnings, ["The server log could not be opened"]);
});

// --- desktop:open-external IPC gate, using Murage's real owned-main-sender predicate ---

const ORIGIN = "http://127.0.0.1:8799";

function mainWindowFixture({ url = `${ORIGIN}/index.html`, destroyed = false } = {}) {
  const mainFrame = { url, detached: false };
  const webContents = { mainFrame, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => destroyed };
  return { window, webContents, mainFrame, event: { sender: webContents, senderFrame: mainFrame } };
}

function ipcFixture(window, { openExternal } = {}) {
  const opened = [];
  const handler = createOpenExternalHandler({
    isTrustedSender: ownedMainSenderGate({ window: () => window, origin: () => ORIGIN }),
    openExternal: openExternal ?? (async (url) => { opened.push(url); }),
  });
  return { handler, opened };
}

test("the owned main renderer opens credential-free web links", async () => {
  const main = mainWindowFixture();
  const { handler, opened } = ipcFixture(main.window);
  assert.equal(await handler(main.event, "https://composio.example/connect?state=abc"), true);
  assert.equal(await handler(main.event, "http://127.0.0.1:6080/vnc.html?token=x"), true);
  assert.deepEqual(opened, ["https://composio.example/connect?state=abc", "http://127.0.0.1:6080/vnc.html?token=x"]);
});

test("bad schemes and credential-bearing links are refused before opening", async () => {
  const main = mainWindowFixture();
  const { handler, opened } = ipcFixture(main.window);
  for (const url of ["file:///etc/hosts", "javascript:alert(1)", "mailto:a@example.com", "smb://host/share"])
    await assert.rejects(handler(main.event, url), /Only web links/);
  for (const url of ["https://user:pass@example.com", "http://token@example.com/"])
    await assert.rejects(handler(main.event, url), /credentials/);
  for (const url of [undefined, 5, "nonsense"])
    await assert.rejects(handler(main.event, url), /web address/);
  assert.deepEqual(opened, []);
});

test("untrusted senders are refused before the address is examined", async () => {
  const main = mainWindowFixture();
  const other = mainWindowFixture();
  const subframe = { url: `${ORIGIN}/`, detached: false };
  const navigated = mainWindowFixture({ url: "https://attacker.example/" });
  const destroyed = mainWindowFixture({ destroyed: true });
  const cases = [
    ["another window", main.window, other.event],
    ["subframe", main.window, { sender: main.webContents, senderFrame: subframe }],
    ["navigated away", navigated.window, navigated.event],
    ["look-alike port", mainWindowFixture({ url: "http://127.0.0.1:8800/" }).window, null],
    ["destroyed window", destroyed.window, destroyed.event],
    ["no window", null, main.event],
    ["no event", main.window, undefined],
  ];
  for (const [name, window, event] of cases) {
    const { handler, opened } = ipcFixture(window);
    const sender = event === null ? { sender: window.webContents, senderFrame: window.webContents.mainFrame } : event;
    await assert.rejects(handler(sender, "https://example.com/"), /only from the main Murage window/, name);
    await assert.rejects(handler(sender, "file:///etc/hosts"), /only from the main Murage window/, `${name} (bad URL)`);
    assert.deepEqual(opened, [], name);
  }
  const throwingGate = createOpenExternalHandler({ isTrustedSender: () => { throw new Error("boom"); }, openExternal: async () => assert.fail("opened") });
  await assert.rejects(throwingGate(main.event, "https://example.com/"), /only from the main Murage window/);
});

test("an operating-system open failure reaches the renderer", async () => {
  const main = mainWindowFixture();
  const { handler } = ipcFixture(main.window, { openExternal: async () => { throw new Error("No application"); } });
  await assert.rejects(handler(main.event, "https://example.com/"), /No application/);
});

// --- wiring in main.mjs ---

test("main.mjs routes both external-link entry points and the default session through this policy", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("desktop:open-external", createOpenExternalHandler\(\{\s*isTrustedSender: ownedMainSenderGate\(\{ window: \(\) => mainWindow, origin: trustedRendererOrigin \}\)/);
  assert.match(main, /win\.webContents\.setWindowOpenHandler\(createMainWindowOpenHandler\(\{/);
  assert.doesNotMatch(main, /setWindowOpenHandler\(\(\{ url \}\) => \{\s*shell\.openExternal\(url\)/, "raw popup forwarding is gone");
  assert.match(main, /session\.defaultSession\.setPermissionRequestHandler\([^]*?mainAppPermissionRequestAllowed\(/);
  assert.match(main, /session\.defaultSession\.setPermissionCheckHandler\([^]*?mainAppPermissionCheckAllowed\(/);
  const policy = main.indexOf("session.defaultSession.setPermissionRequestHandler(");
  const display = main.indexOf("session.defaultSession.setDisplayMediaRequestHandler(");
  const firstWindow = main.indexOf("createWindow(", main.indexOf("const desktopStartup = app.whenReady()"));
  assert.ok(policy > 0 && display > policy && firstWindow > policy, "policy is installed before display capture and the first main window");
  // The separate viewer policy and the one-shot display guard stay in place.
  assert.match(main, /viewer\.webContents\.session\.setPermissionRequestHandler\([^]*?desktopViewerPermissionAllowed\(/);
  assert.match(main, /displayMediaGuard\.consume\(request, rendererOrigin\(\)\)/);
});
