// Native main-app permission smoke (0.1.52 S1-T2).
//
// Adapted from OpenMausBot PR #986 (scripts/smoke-app-permissions.mjs),
// Apache License 2.0. Murage additions: the handlers are the exact main.mjs
// decisions bound to an owned window, and the fixture also proves that a
// same-origin subframe and a second same-origin window are refused.
//
// Run with: node scripts/smoke-app-permissions.mjs   (macOS; Linux needs xvfb-run)
// Uses Chromium's fake microphone and captures only its own disposable page,
// never the user's microphone, camera, desktop, clipboard or app data. The Node
// parent owns the temporary profile and removes it after the Electron child
// exits, because Chromium can still write cache files after app.quit.
import electron from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mainAppPermissionCheckAllowed, mainAppPermissionRequestAllowed } from "../electron/app-permissions.mjs";
import { createMainNavigationGuard, createOwnedMainIpc, rendererOriginArguments } from "../electron/main-ipc-trust.mjs";
import { isOwnedMainSender } from "../electron/main-trust.mjs";
import screenPreview from "../electron/screen-preview.cjs";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

if (!process.versions.electron) {
  const data = mkdtempSync(join(tmpdir(), "murage-permission-smoke-"));
  let code = 1;
  try {
    const result = spawnSync(electron, [fileURLToPath(import.meta.url), data], { stdio: "inherit", timeout: 40_000 });
    if (result.error) throw result.error;
    code = result.status ?? 1;
  } finally {
    safeWipeSync(data);
  }
  process.exit(code);
}

const { app, BrowserWindow, ipcMain, session } = electron;
const PRELOAD = fileURLToPath(new URL("../electron/preload.cjs", import.meta.url));
const data = process.argv[2];
assert.ok(data, "Run this smoke with Node so its parent owns the temporary profile");
app.setPath("userData", data);
app.setPath("sessionData", data);
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("disable-background-networking");
const timeout = setTimeout(() => { console.error("Permission smoke timed out"); app.exit(1); }, 30_000);

const PAGE = "<!doctype html><title>Isolated permission smoke</title><p>Only this test page is captured.</p>";

async function run() {
  let redirectTarget = "";
  const servers = [0, 1].map(() => createServer((req, res) => {
    if (req.url === "/redirect" && redirectTarget) {
      res.statusCode = 302;
      res.setHeader("Location", redirectTarget);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url === "/with-frame" ? `${PAGE}<iframe src="/frame"></iframe>` : PAGE);
  }));
  let win, other, bridged, unowned;
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve))));
    const [origin, foreignOrigin] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
    await app.whenReady();
    const guard = screenPreview.createDisplayMediaGuard();
    const webPreferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };
    win = new BrowserWindow({ show: false, webPreferences });
    const owned = () => (win && !win.isDestroyed() ? win.webContents : null);
    // Same decision functions and arguments as main.mjs's default-session policy.
    session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      mainAppPermissionCheckAllowed({ contents, permission, requestingOrigin, details, ownedContents: owned(), origin }));
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(mainAppPermissionRequestAllowed({ contents, permission, details, ownedContents: owned(), origin })));
    const displayDecisions = [];
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const allowed = guard.consume(request, origin);
      displayDecisions.push(allowed);
      // Electron can capture this fixture's own frame without screen access.
      screenPreview.invokeDisplayMediaCallback(callback, allowed ? { video: request.frame } : {});
    });
    const script = expression => `
      (${expression}).then(stream => {
        const tracks = stream.getTracks().map(track => track.kind);
        stream.getTracks().forEach(track => track.stop());
        return { tracks };
      }).catch(error => ({ error: error.name }))`;
    const capture = (target, expression) => target.executeJavaScript(script(expression), true);
    const microphone = "navigator.mediaDevices.getUserMedia({audio:true})";
    const camera = "navigator.mediaDevices.getUserMedia({video:true})";
    const display = "navigator.mediaDevices.getDisplayMedia({video:true,audio:false})";

    // Owned main window on the trusted origin.
    await win.loadURL(`${origin}/with-frame`);
    assert.deepEqual(await capture(win.webContents, microphone), { tracks: ["audio"] });
    assert.deepEqual(await capture(win.webContents, camera), { error: "NotAllowedError" });
    assert.ok((await capture(win.webContents, display)).error, "screen capture needs an intent");
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.deepEqual(await capture(win.webContents, display), { tracks: ["video"] });
    assert.ok((await capture(win.webContents, display)).error, "screen intent is one-shot");
    assert.deepEqual(displayDecisions, [false, true, false]);

    // Same-origin subframe of the owned window.
    const frame = win.webContents.mainFrame.frames[0];
    assert.ok(frame, "fixture subframe loaded");
    assert.deepEqual(await capture(frame, microphone), { error: "NotAllowedError" }, "subframe microphone is refused");

    // A second window on the same origin is not the owned main window.
    other = new BrowserWindow({ show: false, webPreferences });
    await other.loadURL(origin);
    assert.deepEqual(await capture(other.webContents, microphone), { error: "NotAllowedError" }, "unowned window microphone is refused");
    assert.equal(guard.begin(other.webContents.mainFrame), true);
    assert.ok((await capture(other.webContents, display)).error, "unowned window must not capture");
    assert.deepEqual(displayDecisions, [false, true, false], "unowned window capture must not reach source selection");
    other.destroy();
    other = null;

    // Owned window navigated to a foreign origin.
    await win.loadURL(foreignOrigin);
    assert.deepEqual(await capture(win.webContents, microphone), { error: "NotAllowedError" });
    assert.equal(guard.begin(win.webContents.mainFrame), true);
    assert.ok((await capture(win.webContents, display)).error, "another origin must not capture");
    assert.deepEqual(displayDecisions, [false, true, false], "foreign capture must not reach source selection");

    // S1-T3 (B6): the real preload, the owned-main IPC gate and the main-window
    // navigation guard, exactly as main.mjs wires them. The secret here is a
    // fixture value; no app data, credentials or external browser are touched.
    redirectTarget = `${foreignOrigin}/`;
    const secret = "isolated-smoke-secret";
    const gate = createOwnedMainIpc({ ipcMain, isTrusted: (event) => isOwnedMainSender(event, { window: bridged, origin }) });
    gate.on("desktop:surface-secret", (event) => { event.returnValue = secret; }, { refusedReturnValue: "" });
    gate.handle("desktop:capabilities", () => ({ fixture: true }));
    const bridgePreferences = { ...webPreferences, preload: PRELOAD, additionalArguments: rendererOriginArguments(origin) };
    const openedExternally = [];
    bridged = new BrowserWindow({ show: false, webPreferences: bridgePreferences });
    const navigation = createMainNavigationGuard({ origin: () => origin, openExternal: (url) => { openedExternally.push(url); } });
    bridged.webContents.on("will-navigate", navigation.willNavigate);
    bridged.webContents.on("will-redirect", navigation.willRedirect);
    const bridgeState = (target) => target.webContents.executeJavaScript(`(async () => ({
      type: typeof window.muragebox,
      secret: window.muragebox ? window.muragebox.desktopSurfaceSecret : null,
      capabilities: window.muragebox ? await window.muragebox.getCapabilities().then((value) => value, (error) => ({ refused: /main Murage window/.test(String(error && error.message)) })) : null,
    }))()`);
    const currentOrigin = (target) => new URL(target.webContents.getURL()).origin;

    await bridged.loadURL(origin);
    assert.deepEqual(await bridgeState(bridged), { type: "object", secret, capabilities: { fixture: true } }, "owned window gets the bridge and the secret");

    // A renderer-initiated navigation off the renderer origin stays in place and
    // goes to the default browser (recorded here) instead.
    await bridged.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${foreignOrigin}/`)}; true`);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(currentOrigin(bridged), origin, "navigation away is refused");
    assert.deepEqual(openedExternally, [`${foreignOrigin}/`]);

    // A main-frame redirect off the renderer origin is refused.
    await assert.rejects(bridged.loadURL(`${origin}/redirect`), "cross-origin redirect is aborted");
    assert.equal(currentOrigin(bridged), origin, "redirect away is refused");
    assert.deepEqual(openedExternally, [`${foreignOrigin}/`], "a redirect never opens externally");

    // A second window on the same origin gets a bridge from the preload, but
    // main refuses its secret request and its privileged IPC.
    unowned = new BrowserWindow({ show: false, webPreferences: bridgePreferences });
    await unowned.loadURL(origin);
    assert.deepEqual(await bridgeState(unowned), { type: "object", secret: "", capabilities: { refused: true } }, "unowned window is refused");
    unowned.destroy();
    unowned = null;

    // A foreign document in the owned window (loaded by main here, to model a
    // navigation that escaped) gets no bridge at all.
    await bridged.loadURL(foreignOrigin);
    assert.deepEqual(await bridgeState(bridged), { type: "undefined", secret: null, capabilities: null }, "foreign document has no bridge");

    console.log(JSON.stringify({
      electron: process.versions.electron, platform: process.platform,
      microphone: "allowed", camera: "denied", display: "intent-bound-one-shot",
      subframe: "denied", unownedWindow: "denied", foreignOrigin: "denied",
      bridge: "owned-origin-only", navigation: "refused-opened-externally", redirect: "refused",
      unownedWindowIpc: "refused", foreignDocumentBridge: "absent",
    }));
  } finally {
    clearTimeout(timeout);
    unowned?.destroy();
    bridged?.destroy();
    other?.destroy();
    win?.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

// Do not top-level-await app readiness: Electron finishes loading this module
// before emitting ready. Keep fixture startup errors visible and bounded.
void run().then(() => app.quit(), error => { console.error(error); app.exit(1); });
