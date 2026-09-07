// Native Electron proof of the recovery window/preload/IPC surface only.
// No normal main entry, provider or live installation is started.
import { app, BrowserWindow, ipcMain, session, utilityProcess } from "electron";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openInstallationRecoveryWindow } from "../electron/installation-recovery-window.mjs";
import { acquireDataDirLease } from "../electron/data-dir-lease.mjs";
import { createServerChildLifecycle } from "../electron/server-child-lifecycle.mjs";
import { runInstallationRecoveryWorker } from "../electron/installation-recovery-runner.mjs";
import { restoredConnectionProfile, restoredBrowserPartition } from "../electron/restored-connections.mjs";
import { configureCompanionStorage, companionEnabledAtRest } from "../electron/companion.mjs";
import { assertRestoreReviewed } from "../electron/restore-review.mjs";

const scratch = process.env.MURAGE_RECOVERY_SMOKE_DIR;
if (!scratch || path.dirname(scratch) !== tmpdir().replace(/\/$/, "") || !path.basename(scratch).startsWith("murage-recovery-window-")) throw new Error("Run through scripts/test-desktop-recovery.mjs with an owned temporary directory");
app.setPath("userData", path.join(scratch, "user-data"));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, ".planning", "desktop-recovery-native");
mkdirSync(evidence, { recursive: true });
let exitCode = 1;
app.on("window-all-closed", () => app.quit());
const watchdog = setTimeout(() => { console.error("Recovery native smoke timed out; ready=" + app.isReady()); app.exit(1); }, 45_000);
void app.whenReady().then(async () => {
session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("file:") }));
const context = { skin: "dark", reason: "This disposable installation needs recovery.", dataDirectory: path.join(scratch, "fixture") };
const calls = [];
const oldCompanionSettings = path.join(app.getPath("userData"), "companion-settings.json");
mkdirSync(app.getPath("userData"), { recursive: true });
const oldPreferences = '{"enabled":true,"remoteAccess":false,"keepAwake":false}';
writeFileSync(oldCompanionSettings, oldPreferences);
assert.equal(companionEnabledAtRest(), true);
const oldBrowserPartition = "persist:murage-browser-profile-work";
await session.fromPartition(oldBrowserPartition).cookies.set({ url: "https://fixture.invalid", name: "old-session", value: "synthetic-cookie-canary" });
mkdirSync(context.dataDirectory);
const original = '{"profile":{"name":"Native recovery fixture"},"flux":{"apiKey":"native-recovery-private-canary"}}';
writeFileSync(path.join(context.dataDirectory, "config.json"), original);
writeFileSync(path.join(context.dataDirectory, "bots.json"), "[]");
writeFileSync(path.join(context.dataDirectory, "groups.json"), "[]");
const owner = acquireDataDirLease(context.dataDirectory);
const children = new Set();
const archive = path.join(scratch, process.platform === "win32" ? "selected-backup.zip" : "<img src=x onerror=alert(1)>.zip");
let confirmation = 0;
let restarts = 0;
const run = async (operation, options) => {
  const args = operation === "plan-restore" ? [operation, "--archive", options.archive]
    : operation === "activate" ? [operation, "--data-dir", context.dataDirectory, "--review-hash", options.reviewHash]
    : operation === "backup" ? [operation, "--data-dir", context.dataDirectory, "--output", options.output]
    : operation === "restore" ? [operation, "--data-dir", context.dataDirectory, "--archive", options.archive, "--sha256", options.sha256]
    : [operation, "--data-dir", context.dataDirectory];
  const result = await runInstallationRecoveryWorker({
    fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
    entry: path.join(root, "dist-server", "installation-recovery-worker.js"), args,
    env: { PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...(operation !== "plan-restore" ? owner.utilityServerLeaseEnvironment() : {}) },
    track: child => { const lifecycle = createServerChildLifecycle(child); children.add(lifecycle); void lifecycle.exit.then(() => children.delete(lifecycle)); return lifecycle; },
    timeoutMs: 20_000,
  });
  calls.push({ operation, result });
  return result;
};
await run("backup", { output: archive });
const opened = openInstallationRecoveryWindow({
  BrowserWindow, ipcMain, baseDir: path.join(root, "electron"), context, isAvailable: () => true,
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [archive] }), showMessageBox: async () => ({ response: confirmation }), showSaveDialog: async () => ({ canceled: true }) },
  run,
  retry: async () => { restarts++; }, openDiagnostics: async () => {},
});
try {
  await opened.loaded;
  const wc = opened.window.webContents;
  const waitFor = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await wc.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Recovery UI did not settle");
  };
  await waitFor('document.getElementById("location").textContent.includes("fixture")');
  assert.equal(await wc.executeJavaScript('typeof window.muragebox === "undefined" && typeof window.require === "undefined" && typeof window.murageRecovery.action === "function"'), true);
  await wc.executeJavaScript('document.querySelector("[data-action=choose-backup]").click()');
  await waitFor('!document.getElementById("preview").hidden && !document.getElementById("restore").disabled');
  assert.equal(calls.length, 2);
  assert.equal(await wc.executeJavaScript('document.getElementById("backup-name").children.length'), 0);
  await wc.executeJavaScript('document.getElementById("restore").click()');
  await waitFor('!document.getElementById("restore").disabled');
  assert.equal(calls.length, 2, "cancelled native confirmation must not restore");
  await wc.executeJavaScript('document.getElementById("restore").focus()');
  assert.equal(await wc.executeJavaScript('document.activeElement.id'), "restore");
  assert.equal(await wc.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'), true);
  const paint = () => wc.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await wc.executeJavaScript('window.scrollTo(0,0)');
  await paint();
  writeFileSync(path.join(evidence, "dark.png"), (await wc.capturePage()).toPNG());
  context.skin = "light";
  await wc.executeJavaScript('window.murageRecovery.action("state").then(render)');
  await wc.executeJavaScript('window.scrollTo(0,0)');
  await paint();
  writeFileSync(path.join(evidence, "light.png"), (await wc.capturePage()).toPNG());
  confirmation = 1;
  await wc.executeJavaScript('document.getElementById("restore").click()');
  await waitFor('document.getElementById("status").textContent.startsWith("Restore completed")');
  assert.equal(JSON.parse(readFileSync(path.join(context.dataDirectory, "restore-review.json"), "utf8")).status, "review-required");
  assert.equal(readFileSync(path.join(context.dataDirectory, "config.json"), "utf8").includes("native-recovery-private-canary"), false);
  const restored = calls.find(call => call.operation === "restore").result;
  assert.equal(readFileSync(path.join(restored.previousDataDir, "config.json"), "utf8"), original);
  const profile = restoredConnectionProfile(context.dataDirectory);
  assert.ok(profile);
  configureCompanionStorage({ settingsDirectory: profile.companionSettings, stateDirectory: profile.companionState });
  assert.equal(companionEnabledAtRest(), false);
  assert.equal(readFileSync(oldCompanionSettings, "utf8"), oldPreferences);
  const freshCookies = await session.fromPartition(restoredBrowserPartition(oldBrowserPartition, profile)).cookies.get({ url: "https://fixture.invalid" });
  assert.equal(freshCookies.length, 0);
  assert.equal((await session.fromPartition(oldBrowserPartition).cookies.get({ url: "https://fixture.invalid" }))[0].value, "synthetic-cookie-canary");
  await wc.executeJavaScript('document.querySelector("[data-action=review-installation]").click()');
  await waitFor('!document.getElementById("activation-review").hidden');
  await wc.executeJavaScript('document.querySelector("[data-action=activate]").click()');
  await waitFor('document.getElementById("status").textContent.startsWith("Review approved")');
  assertRestoreReviewed(context.dataDirectory);
  assert.equal(restarts, 1);
  await wc.executeJavaScript('document.querySelector("[data-action=rollback]").click()');
  await waitFor('document.getElementById("status").textContent.startsWith("Previous installation restored")');
  assert.equal(readFileSync(path.join(context.dataDirectory, "config.json"), "utf8"), original);
  configureCompanionStorage(null);
  assert.equal(companionEnabledAtRest(), true);
  assert.equal(children.size, 0);
  const report = { passed: true, platform: process.platform, electron: process.versions.electron, node: process.versions.node, bridge: "restricted", nativeConfirmation: "mocked-cancel-and-accept", providerCalls: 0, workerCalls: calls.length, browserCookieIsolation: true, freshCompanionPreferences: true, activationApproved: true, restartRequests: restarts, scope: "actual native window/preload/IPC and real delegated utility backup/inspect/restore/review/activate/rollback; dialogs and final app relaunch injected; real reviewed harness boot tested separately" };
  writeFileSync(path.join(evidence, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  exitCode = 0;
} catch (error) { console.error(error); }
finally { clearTimeout(watchdog); await Promise.all([...children].map(child => child.stop())); owner.release(); opened.window.destroy(); app.exit(exitCode); }
}).catch(error => { clearTimeout(watchdog); console.error(error); app.exit(1); });
