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

test("the preload exposes it as a call with no arguments", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /preparePreviousVersion: \(\) => ipcRenderer\.invoke\("update:prepare-previous-version"\)/);
});
