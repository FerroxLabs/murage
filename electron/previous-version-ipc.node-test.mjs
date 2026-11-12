// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Settings > About & updates step back: the REAL ipcMain.handle statement lifted out of main.mjs,
// the REAL preload line, and stubs only for the app state behind them.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { removeTempDirSync } from "../server/testing/cleanup.ts";
import vm from "node:vm";
import ts from "typescript";
import { voiceFinishingDialog } from "./prepare-voice-finishing.mjs";
import { downgradeWorkPendingMessage } from "./prepare-work-pending.mjs";

function handler(state) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find(n => ts.isExpressionStatement(n) && n.getText(tree).startsWith('ipcMain.handle("update:prepare-previous-version"'));
  assert.ok(node, "handler present");
  const handlers = new Map();
  const prepare = async () => { state.calls += 1; };
  prepare.running = state.running;
  const sandbox = vm.createContext({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    app: { isPackaged: state.packaged ?? true },
    prepareForPreviousVersion: prepare,
  });
  vm.runInContext(`var desktopRecoveryMode=${!!state.recovery}; var desktopShutdownStarted=${!!state.shutdown};`, sandbox);
  vm.runInContext(node.getText(tree), sandbox);
  return handlers.get("update:prepare-previous-version");
}

test("starts the step back and answers only {started:true}", () => {
  const state = { calls: 0 };
  assert.equal(JSON.stringify(handler(state)({})), '{"started":true}');
  assert.equal(state.calls, 1);
});

test("is refused while recovery mode is active", () => {
  const state = { calls: 0, recovery: true };
  assert.equal(JSON.stringify(handler(state)({})), '{"started":false}');
  assert.equal(state.calls, 0);
});

test("is refused once a shutdown has started", () => {
  const state = { calls: 0, shutdown: true };
  assert.equal(JSON.stringify(handler(state)({})), '{"started":false}');
  assert.equal(state.calls, 0);
});

test("is refused while it is already running or in an unpackaged app", () => {
  for (const state of [{ calls: 0, running: true }, { calls: 0, packaged: false }]) {
    assert.equal(JSON.stringify(handler(state)({})), '{"started":false}');
    assert.equal(state.calls, 0);
  }
});

test("accepts no arguments", () => {
  const state = { calls: 0 };
  assert.throws(() => handler(state)({}, "anything"), /INVALID_REQUEST/);
  assert.throws(() => handler(state)({}, { force: true }), /INVALID_REQUEST/);
  assert.equal(state.calls, 0);
});

// 1.0.18: the REAL prepareForPreviousVersion lifted out of main.mjs. A held bot Post refuses the step back with
// DOWNGRADE_WORK_PENDING (the downgrade's own refusal, server/downgrade-102-schema.test.ts), and the dialog uses the reviewed pending-work copy.
async function prepareDialogs(refusal) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "prepareForPreviousVersion");
  assert.ok(node, "prepareForPreviousVersion present");
  // STARTUP-SILENT: the step back names its quit "automatic" before app.quit(), with the REAL noteShutdownCause lifted beside it.
  const noteCause = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "noteShutdownCause");
  assert.ok(noteCause, "noteShutdownCause present");
  const shown = []; let quit = 0; let causeAtQuit;
  let sandbox;
  sandbox = vm.createContext({
    app: { isPackaged: true, quit: () => { quit += 1; causeAtQuit = sandbox.shutdownCause; } },
    mainWindow: undefined,
    dialog: { showMessageBox: async (...args) => { const box = args.at(-1); shown.push(box); return { response: 0 }; } },
    runDesktopRecovery: typeof refusal === "function" ? refusal : async () => { throw refusal; },
    voiceFinishingDialog, downgradeWorkPendingMessage,
  });
  vm.runInContext("var desktopRecoveryMode=false; var desktopShutdownStarted=false; var desktopDataOwner=true; var desktopDataDir='/data'; var shutdownCause=null;", sandbox);
  vm.runInContext(noteCause.getText(tree), sandbox);
  vm.runInContext(node.getText(tree), sandbox);
  await vm.runInContext("prepareForPreviousVersion()", sandbox);
  return { shown, quit, causeAtQuit };
}

test("a held bot Post refusing the step back shows the reviewed pending-work dialog", async () => {
  const held = Object.assign(new Error("You have 1 post from a bot still waiting for your answer. Post or decline it, then try again."), { code: "DOWNGRADE_WORK_PENDING" });
  const { shown, quit, causeAtQuit } = await prepareDialogs(held);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].message, "Murage will be ready for 1.0.2 once this is done.");
  assert.equal(shown[1].detail, "Your chats and memories are as they were. Murage can't go back to the earlier version while messages or a restore are pending. Finish or cancel the pending restore first, then send or cancel any waiting messages and try again.");
  assert.doesNotMatch(shown[1].detail, /Code:|DOWNGRADE_WORK_PENDING/);
  assert.equal(quit, 1);
  assert.equal(causeAtQuit, "automatic");
});

test("an unfinished restore refusing the step back tells the person to finish recovery in this version", async () => {
  const open = Object.assign(new Error("A restore has not finished."), { code: "DOWNGRADE_RESTORE_OPEN" });
  const { shown, quit, causeAtQuit } = await prepareDialogs(open);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].detail, "Your chats and memories are as they were. A restore has not finished. Open this version of Murage to finish recovery, then try going back to the earlier version.");
  assert.doesNotMatch(shown[1].detail, /Code:|DOWNGRADE_RESTORE_OPEN/);
  assert.equal(quit, 1);
  assert.equal(causeAtQuit, "automatic");
});

// Drive the actual offline command, then pass its refusal through the real desktop dialog function.
// Each fixture starts with neither messages.db nor routines.json.
for (const phase of ["armed", "captured", "swapped", "unreadable", null]) {
  test(`missing database and routines with journal ${phase ?? "absent"}: the desktop reports the command result`, async () => {
    const data = mkdtempSync(join(tmpdir(), "murage-previous-version-"));
    try {
      const journal = phase === null ? null : phase === "unreadable" ? "{ torn" : JSON.stringify({ version: 1, id: "job-X", archiveId: "arc1", source: "local", phase, at: 1_800_000_000_000 });
      if (journal !== null) writeFileSync(join(data, "restore-job.json"), journal);
      let result;
      const { shown } = await prepareDialogs(async (operation) => {
        assert.equal(operation, "memory-downgrade");
        const cli = fileURLToPath(new URL("../scripts/installation-recovery.ts", import.meta.url));
        const child = await promisify(execFile)(process.execPath, [cli, operation, "--data-dir", data, "--to", "10"], { timeout: 20_000 }).catch(error => error);
        assert.equal(child.code, 1);
        assert.equal(child.stdout, "");
        result = JSON.parse(child.stderr);
        throw Object.assign(new Error(result.message), { code: result.error });
      });
      assert.equal(shown.length, 2);
      assert.equal(result?.ok, false);
      assert.equal(result?.error, phase === null ? "MEMORY_DATABASE_MISSING" : "DOWNGRADE_RESTORE_OPEN");
      if (phase === null) {
        assert.equal(shown[1].message, "Ready for Murage 1.0.2.");
      } else {
        assert.ok(shown.every(box => !/^Ready/.test(box.message)));
        assert.equal(shown[1].type, "warning");
        assert.equal(shown[1].detail, "Your chats and memories are as they were. A restore has not finished. Open this version of Murage to finish recovery, then try going back to the earlier version.");
        assert.equal(readFileSync(join(data, "restore-job.json"), "utf8"), journal);
      }
      assert.equal(existsSync(join(data, "messages.db")), false);
      assert.equal(existsSync(join(data, "routines.json")), false);
    } finally { removeTempDirSync(data); }
  });
}

test("a voice reply still finishing refuses the step back with the minutes left, as finishing up, not an error", async () => {
  const finishing = Object.assign(new Error("Murage is finishing a voice reply. Try again in about 4 min."), { code: "DOWNGRADE_VOICE_FINISHING_4" });
  const { shown, quit, causeAtQuit } = await prepareDialogs(finishing);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].type, "info");
  assert.equal(shown[1].message, "Murage is finishing a voice reply.");
  assert.equal(shown[1].detail, "Try again in about 4 min. Your chats and memories are as they were.");
  assert.deepEqual(shown[1].buttons, ["Quit"]);
  assert.doesNotMatch(shown[1].detail, /Code:|error/i);
  assert.equal(quit, 1);
  assert.equal(causeAtQuit, "automatic");
});

test("the preload exposes it as a call with no arguments", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /preparePreviousVersion: \(\) => ipcRenderer\.invoke\("update:prepare-previous-version"\)/);
});

test("the downgrade dialog names unfinished calls and the preserved phone history folder", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "prepareForPreviousVersion");
  for (const failure of [undefined, "PHONE_CALLS_PENDING", "PHONE_CALLS_UNREADABLE"]) {
    const dialogs = [];
    const sandbox = vm.createContext({
      app: { isPackaged: true, quit() {} }, mainWindow: undefined,
      noteShutdownCause: () => {}, // b9 STARTUP-SILENT names the step-back quit; test 7 checks the real function
      desktopRecoveryMode: false, desktopShutdownStarted: false, desktopDataOwner: {}, desktopDataDir: "/fixture",
      dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 }; } },
      voiceFinishingDialog, downgradeWorkPendingMessage,
      runDesktopRecovery: async () => { if (failure) throw Object.assign(new Error(failure), { code: failure }); return { phoneCallsPreservedAt: "/fixture-preserved" }; },
    });
    vm.runInContext(node.getText(tree), sandbox);
    await vm.runInContext("prepareForPreviousVersion()", sandbox);
    const last = dialogs.at(-1);
    if (failure) {
      assert.equal(last.type, "warning");
      assert.match(last.detail, /phone call/i);
      assert.doesNotMatch(last.message, /^Ready/);
    } else assert.match(last.detail, /\/fixture-preserved.*restore/);
  }
});
