import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { verifiedArtifactNativePath } from "../electron/artifact-action.mjs";

const cfg = JSON.parse(fs.readFileSync(process.env.MURAGE_FILES_NATIVE_CONFIG, "utf8"));
app.setPath("userData", cfg.userData); app.setPath("sessionData", cfg.userData);
app.setName("Murage Files native verification");
const run = promisify(execFile);
const digest = value => createHash("sha256").update(value).digest("hex");
const proof = { status: "running", platform: process.platform, electron: process.versions.electron, pid: process.pid, dispatches: [], visualFileOpened: "unverified; native dispatch is not document-rendering proof" };
const frontmost = async () => {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("AppKit");var app=$.NSWorkspace.sharedWorkspace.frontmostApplication;JSON.stringify({pid:Number(app.processIdentifier),bundle:String(ObjC.unwrap(app.bundleIdentifier)||"")});']);
  return JSON.parse(stdout.trim());
};
let win;
const stage = name => {
  proof.stages ??= [];
  proof.stages.push({ name, at: new Date().toISOString() });
  fs.writeFileSync(cfg.output, JSON.stringify(proof, null, 2), { mode: 0o600 });
};
stage("before-ready");
void app.whenReady().then(async () => {
try {
  stage("ready");
  assert.equal(process.platform, "darwin");
  const source = fs.readFileSync(cfg.mainSource, "utf8");
  const start = source.indexOf('ipcMain.handle("desktop:artifact-action",');
  const end = source.indexOf('\n\nipcMain.handle("desktop:save-file",', start);
  assert(start >= 0 && end > start);
  const handler = source.slice(start, end);
  assert.equal(digest(handler), cfg.handlerSha256);
  proof.handlerSha256 = cfg.handlerSha256;
  proof.preloadSha256 = digest(fs.readFileSync(cfg.preload));
  assert.equal(proof.preloadSha256, cfg.preloadSha256);
  const actualOpen = shell.openPath.bind(shell), actualReveal = shell.showItemInFolder.bind(shell);
  const observedShell = {
    async openPath(savedPath) {
      assert.equal(savedPath, cfg.savedPath); assert.equal(path.extname(savedPath), ".txt");
      assert.equal(digest(fs.readFileSync(savedPath)), cfg.sha256);
      const result = await actualOpen(savedPath);
      proof.dispatches.push({ action: "open", nativeFunction: "electron.shell.openPath", path: savedPath, result, realCallThrough: true });
      return result;
    },
    showItemInFolder(savedPath) {
      assert.equal(savedPath, cfg.savedPath); assert.equal(digest(fs.readFileSync(savedPath)), cfg.sha256);
      actualReveal(savedPath);
      proof.dispatches.push({ action: "reveal", nativeFunction: "electron.shell.showItemInFolder", path: savedPath, realCallThrough: true });
    },
  };
  // Install the current handler verbatim; only its lexical dependencies are
  // supplied. Native shell observers call through, never substitute success.
  const install = new Function("ipcMain", "BrowserWindow", "app", "SERVER_PORT", "DEV_URL", "desktopSurfaceSecret", "fetch", "dialog", "verifiedArtifactNativePath", "ownedDesktopDataDir", "path", "shell", handler);
  install(ipcMain, BrowserWindow, app, cfg.serverPort, cfg.uiUrl, cfg.desktopSecret, fetch, dialog, verifiedArtifactNativePath, () => cfg.dataDir, path, observedShell);
  win = new BrowserWindow({ width: 840, height: 620, show: true, webPreferences: { contextIsolation: true, sandbox: true, preload: cfg.preload } });
  ipcMain.on("desktop:surface-secret", event => {
    assert.equal(event.sender, win.webContents);
    event.returnValue = cfg.desktopSecret;
  });
  await win.loadURL(cfg.uiUrl);
  assert.equal(await win.webContents.executeJavaScript("typeof window.muragebox?.artifactAction"), "function");
  proof.actualPreload = true;
  stage("preload-ready");
  proof.rendererOrigin = await win.webContents.executeJavaScript("location.origin");
  assert.equal(proof.rendererOrigin, new URL(cfg.uiUrl).origin);
  for (const action of ["open", "reveal"]) {
    await win.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').click()`);
    const deadline = Date.now() + 15000;
    let state;
    do {
      state = await win.webContents.executeJavaScript("window.actionResult");
      if (state?.action === action && state?.status !== "running") break;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(state?.action, action); assert.equal(state?.status, "passed");
    stage(`${action}-dispatched`);
    await new Promise(resolve => setTimeout(resolve, 500));
    proof[`${action}Frontmost`] = await frontmost();
  }
  assert.equal(proof.dispatches.length, 2);
  assert.equal(proof.dispatches[0].result, "");
  assert.deepEqual(proof.dispatches.map(item => item.action), ["open", "reveal"]);
  fs.writeFileSync(cfg.screenshot, (await win.webContents.capturePage()).toPNG());
  proof.snapshotSha256 = digest(fs.readFileSync(cfg.savedPath));
  assert.equal(proof.snapshotSha256, cfg.sha256);
  proof.status = "passed";
} catch (error) {
  proof.status = "failed"; proof.error = error instanceof Error ? error.message : "Native fixture failed";
} finally {
  proof.childPids = app.getAppMetrics().map(metric => metric.pid);
  if (win && !win.isDestroyed()) win.destroy();
  proof.windowClosed = !win || win.isDestroyed();
  fs.writeFileSync(cfg.output, JSON.stringify(proof, null, 2), { mode: 0o600 });
  app.exit(proof.status === "passed" ? 0 : 1);
}
}).catch(error => {
  proof.status = "failed";
  proof.error = error instanceof Error ? error.message : "Readiness callback failed";
  stage("readiness-error");
  app.exit(1);
});
