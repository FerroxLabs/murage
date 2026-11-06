// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Settings > About & updates step back: the REAL ipcMain.handle statement lifted out of main.mjs,
// the REAL preload line, and stubs only for the app state behind them.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

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
// DOWNGRADE_WORK_PENDING (the downgrade's own refusal, server/downgrade-102-schema.test.ts), and the dialog detail names
// bot posts and how to clear them.
async function prepareDialogs(refusal) {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("main.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "prepareForPreviousVersion");
  assert.ok(node, "prepareForPreviousVersion present");
  const shown = []; let quit = 0;
  const sandbox = vm.createContext({
    app: { isPackaged: true, quit: () => { quit += 1; } },
    mainWindow: undefined,
    dialog: { showMessageBox: async (...args) => { const box = args.at(-1); shown.push(box); return { response: 0 }; } },
    runDesktopRecovery: async () => { throw refusal; },
  });
  vm.runInContext("var desktopRecoveryMode=false; var desktopShutdownStarted=false; var desktopDataOwner=true; var desktopDataDir='/data';", sandbox);
  vm.runInContext(node.getText(tree), sandbox);
  await vm.runInContext("prepareForPreviousVersion()", sandbox);
  return { shown, quit };
}

test("a held bot Post refusing the step back names bot posts in the dialog", async () => {
  const held = Object.assign(new Error("You have 1 post from a bot still waiting for your answer. Post or decline it, then try again."), { code: "DOWNGRADE_WORK_PENDING" });
  const { shown, quit } = await prepareDialogs(held);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].message, "Murage will be ready for 1.0.2 once this is done.");
  assert.equal(shown[1].detail, "Your chats and memories are as they were. Some messages, bot posts or other work are still waiting. Open Murage, send, post or decline what is waiting, let the rest finish, then try again.");
  assert.doesNotMatch(shown[1].detail, /send or cancel|Code:/);
  assert.equal(quit, 1);
});

test("the preload exposes it as a call with no arguments", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /preparePreviousVersion: \(\) => ipcRenderer\.invoke\("update:prepare-previous-version"\)/);
});
