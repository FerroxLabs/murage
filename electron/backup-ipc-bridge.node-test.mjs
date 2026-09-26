// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// From the 0.1.60 pre-release audit (IPC sub-audit). Drives the REAL preload.cjs into the REAL backup ipcMain.handle statements
// lifted out of main.mjs (only the hosts behind them are stubs), and the REAL
// recovery preload into the REAL recovery controller, with the argument
// shapes the renderer call sites actually use.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { settleRecoveryKeyRequest } from "./backup-recovery-key.mjs";
import { setUpBackupsRequest } from "./backup-schedule-host.mjs";
import { createInstallationRecoveryController } from "./installation-recovery-controller.mjs";

const ORIGIN = "http://127.0.0.1:47321";

function backupHandlers(context) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const wanted = tree.statements.filter(node => {
    const text = node.getText(tree);
    if (ts.isExpressionStatement(node)) return /^ipcMain\.handle\("backup-(mode|schedule):/.test(text);
    if (ts.isForOfStatement(node)) return text.includes("`backup-closed:${action}`") || text.includes("`backup-remote:${action}`");
    return false;
  });
  const handlers = new Map();
  vm.runInNewContext(wanted.map(node => node.getText(tree)).join("\n"), { ...context, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } });
  return handlers;
}

function preload(handlers) {
  const exposed = {};
  const invoke = async (channel, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) throw Error(`No handler registered for '${channel}'`);
    try { return structuredClone(await handler({ senderFrame: { url: ORIGIN } }, ...structuredClone(args))); }
    catch (error) { throw Error(`Error invoking remote method '${channel}': Error: ${error.message}`); }
  };
  const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: { invoke, sendSync: () => "", on: () => {}, once: () => {}, send: () => {}, removeListener: () => {}, removeAllListeners: () => {} },
    webUtils: { getPathForFile: () => "" } };
  const context = { require: name => { if (name === "electron") return electron; throw Error("preload may not require " + name); },
    process: { argv: [`--murage-renderer-origin=${ORIGIN}`], platform: process.platform, env: {} }, location: { origin: ORIGIN },
    console, setTimeout, clearTimeout, queueMicrotask, URL, module: { exports: {} }, exports: {} };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), context);
  return exposed.muragebox;
}

function fixture() {
  const calls = [];
  const record = (name, value) => (...args) => { calls.push([name, args]); return value; };
  const status = { supported: true, pending: false, enabled: false, revision: 3, phase: "idle", schedule: { enabled: false, preUpgrade: false } };
  const context = {
    backupMode: { status: record("mode.status", { supported: true, pending: false }), restart: record("mode.restart", Promise.resolve({ restarting: false })), isPreparing: () => false },
    backupRecoveryKeys: { isPending: () => false, create: record("keys.create", Promise.resolve({ cancelled: true })), saveCopy: record("keys.saveCopy", Promise.resolve({ cancelled: true })) },
    settleRecoveryKeyRequest, setUpBackupsRequest,
    backupScheduleHost: { isPreparing: () => false, status: record("schedule.status", status), selectReferences: record("schedule.select", { cancelled: true }),
      setUpBackups: record("schedule.setUp", Promise.resolve({ cancelled: true })), configure: record("schedule.configure", status),
      runNow: record("schedule.runNow", status), clearReview: record("schedule.clearReview", status) },
    closedBackupController: Object.fromEntries(["status", "stage", "install", "disable"].map(name => [name, record(`closed.${name}`, { supported: true, state: "unconfigured" })])),
    closedBackupRequested: false,
    backupRemoteHost: new Proxy({}, { get: (_target, name) => record(`remote.${String(name)}`, Promise.resolve({ ok: true })) }),
    backupRemoteOperations: new Set(), desktopShutdownStarted: false, desktopRecoveryMode: false,
    // Defined elsewhere in main.mjs; the clear-review handler calls it.
    announceLastBackupFailure: async () => {},
  };
  return { calls, bridge: preload(backupHandlers(context)) };
}

test("every backup preload method, called as the renderer calls it, passes main's argument check", async () => {
  const { calls, bridge } = fixture();
  const ref = "ref-1", rev = 3, job = "a".repeat(64), policy = { keepLast: 3 };
  const cases = [
    ["backup.status", () => bridge.backup.status()],
    ["backup.restart", () => bridge.backup.restart()],
    ["backup.createRecoveryKey", () => bridge.backup.createRecoveryKey()],
    ["backup.saveRecoveryKeyCopy", () => bridge.backup.saveRecoveryKeyCopy()],
    ["schedule.status", () => bridge.backupSchedule.status()],
    ["schedule.selectReferences", () => bridge.backupSchedule.selectReferences()],
    // FirstRunBackupsRow and "Turn on backups": completeBackupSetup(host, undefined) -> setUp(undefined)
    ["schedule.setUp(undefined)", () => bridge.backupSchedule.setUp(undefined)],
    ["schedule.setUp()", () => bridge.backupSchedule.setUp()],
    ["schedule.setUp({existingKey:true})", () => bridge.backupSchedule.setUp({ existingKey: true })],
    ["schedule.configure", () => bridge.backupSchedule.configure(rev, { enabled: true, allowIdleRestart: true })],
    ["schedule.runNow", () => bridge.backupSchedule.runNow(rev)],
    ["schedule.clearReview", () => bridge.backupSchedule.clearReview(rev)],
    ...["status", "stage", "install", "disable"].map(name => [`closed.${name}`, () => bridge.backupClosed[name]()]),
    ["remote.status", () => bridge.backupRemote.status()],
    ["remote.save", () => bridge.backupRemote.save(0, { kind: "sftp", label: "x", host: "h", port: 22, user: "u", folder: "f" })],
    ["remote.testConnection", () => bridge.backupRemote.testConnection(ref, rev)],
    ["remote.trustServer", () => bridge.backupRemote.trustServer(ref, rev, "SHA256:" + "A".repeat(43))],
    ["remote.remove", () => bridge.backupRemote.remove(ref, rev)],
    ["remote.createRepositoryPassword", () => bridge.backupRemote.createRepositoryPassword(ref, rev)],
    ["remote.saveRepositoryPasswordCopy", () => bridge.backupRemote.saveRepositoryPasswordCopy(ref, rev)],
    ["remote.selectRepositoryPassword", () => bridge.backupRemote.selectRepositoryPassword(ref, rev)],
    ["remote.connect", () => bridge.backupRemote.connect(ref, rev)],
    ["remote.uploadLatest", () => bridge.backupRemote.uploadLatest(ref, rev, job)],
    ["remote.setAutomaticUpload", () => bridge.backupRemote.setAutomaticUpload(ref, rev, true)],
    ["remote.reconcileLatest", () => bridge.backupRemote.reconcileLatest(ref, rev, job)],
    ["remote.listBackups", () => bridge.backupRemote.listBackups(ref, rev)],
    ["remote.downloadBackup", () => bridge.backupRemote.downloadBackup(ref, rev, job)],
    ["remote.saveMaintenanceCredentials", () => bridge.backupRemote.saveMaintenanceCredentials(ref, rev, { accessKeyId: "a", secretAccessKey: "b" })],
    ["remote.previewRetention", () => bridge.backupRemote.previewRetention(ref, rev, policy)],
    ["remote.applyRetention", () => bridge.backupRemote.applyRetention(ref, rev, policy, job)],
    ["remote.clearRetentionReview", () => bridge.backupRemote.clearRetentionReview(ref, rev, job)],
  ];
  const failures = [];
  for (const [name, call] of cases) { try { await call(); } catch (error) { failures.push(`${name}: ${error.message}`); } }
  assert.deepEqual(failures, []);
  // Hosts saw exactly the renderer's values (no dropped or padded argument).
  assert.deepEqual(calls.filter(([name]) => name === "schedule.setUp").map(([, args]) => args), [[{ existingKey: false }], [{ existingKey: false }], [{ existingKey: true }]]);
  assert.deepEqual(calls.find(([name]) => name === "remote.applyRetention")[1], [ref, rev, policy, job]);
});

// Renderer's own recovery-window argument choice (renderer.js action()).
const rendererArgs = (name, current) => ["restore", "restore-separate", "restore-encrypted-new"].includes(name) ? current?.selection?.id : name === "activate" ? current?.review?.id : undefined;

test("every recovery button, sent through the real recovery preload, is accepted by the real controller", async () => {
  const actions = [...readFileSync(new URL("./recovery/index.html", import.meta.url), "utf8").matchAll(/data-action="([a-z-]+)"/g)].map(match => match[1]);
  const preview = { ok: true, operation: "plan-restore", sha256: "b".repeat(64), snapshotId: "snap", activationAvailable: false };
  const controller = createInstallationRecoveryController({
    isTrustedSender: () => true, isAvailable: () => true, encryptedAvailable: () => true, canRestoreSeparate: () => true, canCaptureSeparate: () => true,
    planSeparate: () => ({ dataDirectory: "/new" }), retainedDestination: () => null,
    chooseBackup: async () => ({ path: "/b.zip", name: "b.zip" }), chooseEncryptedBackup: async () => null, chooseEncryptedDestination: async () => null,
    chooseDestination: async () => null, chooseRecoveryIdentity: async () => null,
    run: async operation => operation === "plan-restore" ? preview : operation === "review" ? { operation: "review", activationAvailable: true, reviewHash: "c".repeat(64), files: 1, bytes: 1, snapshotId: "s" } : { ok: true },
    runCaptureSeparate: async () => ({ status: "cancelled" }), confirm: async () => false, retry: async () => {}, openDiagnostics: async () => {},
  });
  let exposed;
  vm.runInNewContext(readFileSync(new URL("./recovery/preload.cjs", import.meta.url), "utf8"), { require: () => ({
    contextBridge: { exposeInMainWorld: (_key, value) => { exposed = value; } },
    ipcRenderer: { invoke: async (_channel, input) => structuredClone(await controller.handle({}, structuredClone(input))) },
  }) });
  const refused = [];
  let current = await exposed.action("state", rendererArgs("state", null));
  // Selection and review first, so restore/activate carry real ids.
  for (const name of ["choose-backup", "restore", "choose-separate-backup", "restore-separate", "review-installation", "activate", ...actions]) {
    if (name === "capture-separate") continue; // host stub returns no restore; covered by product tests
    try { current = await exposed.action(name, rendererArgs(name, current)); if (current.error === "INVALID_RECOVERY_REQUEST") refused.push(name); }
    catch (error) { refused.push(`${name}: ${error.message}`); }
  }
  assert.deepEqual(refused, []);
});

// 0.1.60 audit IPC-L3: the ownership sentence names the button the window
// shows: "Retry startup" in the ordinary recovery window, "Return to
// workspace" in Backup mode. Real messages.js + real renderer.js.
for (const backupMode of [false, true]) test(`recovery-window ownership sentence names the button on screen (backup mode ${backupMode})`, async () => {
  const html = readFileSync(new URL("./recovery/index.html", import.meta.url), "utf8");
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { id, textContent: "", hidden: false, disabled: false, dataset: {}, addEventListener() {} }); return elements.get(id); };
  const buttons = [...html.matchAll(/<button data-action="([a-z-]+)"[^>]*>([^<]*)<\/button>/g)].map(([, action, text]) => ({ ...element("button:" + action), dataset: { action }, textContent: text, addEventListener() {} }));
  const state = { busy: false, available: false, encryptedAvailable: false, separateAvailable: false, captureAvailable: false, selection: null, review: null, result: null,
    error: "RECOVERY_OWNERSHIP_REQUIRED", errorAction: "retry", context: { backupMode, dataDirectory: "/data" } };
  const context = { document: { getElementById: element, querySelectorAll: () => buttons, documentElement: { dataset: {} } }, window: { murageRecovery: { action: async () => state } } };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(new URL("./recovery/messages.js", import.meta.url), "utf8"), context);
  vm.runInNewContext(readFileSync(new URL("./recovery/renderer.js", import.meta.url), "utf8"), context);
  await new Promise(resolve => setTimeout(resolve, 10));
  const shown = element("error").textContent;
  const retry = buttons.find(button => button.dataset.action === "retry").textContent;
  assert.equal(retry, backupMode ? "Return to workspace" : "Retry startup");
  assert.ok(shown.includes(`choose ${retry}.`), shown);
});
