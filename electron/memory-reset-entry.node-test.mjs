// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1023-seanclean (owner of electron/memory-reset-entry.mjs and of this test): the packaged app's hidden one-time flag.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MEMORY_RESET_ENTRY, MEMORY_RESET_FLAG, MEMORY_RESET_USAGE_EXIT, isMemoryResetLaunch, memoryResetArguments, memoryResetEntry, runMemoryReset } from "./memory-reset-entry.mjs";

const exe = "/Applications/App.app/Contents/MacOS/App";

test("only a launch whose first argument is the flag is the clean-up; every other launch passes through", () => {
  assert.equal(isMemoryResetLaunch([exe, MEMORY_RESET_FLAG]), true);
  assert.equal(isMemoryResetLaunch([exe]), false);
  assert.equal(isMemoryResetLaunch([exe, "--murage-login", MEMORY_RESET_FLAG]), false);
  assert.equal(isMemoryResetLaunch([exe, "murage://open"]), false);
});

test("only the command's own arguments are passed on, each value checked", () => {
  assert.deepEqual(memoryResetArguments([exe, MEMORY_RESET_FLAG]), []);
  assert.deepEqual(memoryResetArguments([exe, MEMORY_RESET_FLAG, "--data-dir", "/home/owner/.data", "--finish-minutes", "45", "--dry-run", "--no-check"]),
    ["--data-dir", "/home/owner/.data", "--finish-minutes", "45", "--dry-run", "--no-check"]);
  for (const bad of [["--inspect"], ["--withdraw-stuck"], ["--data-dir"], ["--data-dir", "--dry-run"], ["--finish-minutes", "soon"], ["--data-dir", "a\nb"], ["-e", "process.exit()"], ["/some/script.js"]])
    assert.equal(memoryResetArguments([exe, MEMORY_RESET_FLAG, ...bad]), null, JSON.stringify(bad));
});

test("the command is the bundled entry beside the packaged server, else the source tree's build", () => {
  const packaged = path.join("/res", "server", MEMORY_RESET_ENTRY);
  assert.equal(memoryResetEntry({ resourcesPath: "/res", exists: file => file === packaged, here: "/src/electron" }), packaged);
  const built = path.join("/src/electron", "..", "dist-server", MEMORY_RESET_ENTRY);
  assert.equal(memoryResetEntry({ resourcesPath: "/res", exists: file => file === built, here: "/src/electron" }), built);
  assert.equal(memoryResetEntry({ resourcesPath: "/res", exists: () => false, here: "/src/electron" }), null);
});

test("the flag runs the bundled command as Node with this executable, and its exit code is the launch's", () => {
  const calls = [];
  const spawn = (file, args, options) => { calls.push({ file, args, options }); return { status: 2 }; };
  const code = runMemoryReset({ argv: [exe, MEMORY_RESET_FLAG, "--data-dir", "/home/owner/.data"], execPath: exe, env: { HOME: "/home/owner", NODE_OPTIONS: "--inspect" }, spawn, entry: "/res/server/x.js", write: () => {} });
  assert.equal(code, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, exe);
  assert.deepEqual(calls[0].args, ["/res/server/x.js", "--data-dir", "/home/owner/.data"]);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(calls[0].options.env.HOME, "/home/owner");
  assert.equal("NODE_OPTIONS" in calls[0].options.env, false);
  assert.equal(calls[0].options.stdio, "inherit");
});

test("arguments that are not understood, a build without the command, or a start failure never start anything else", () => {
  let started = 0; const spawn = () => { started++; return { status: 0 }; };
  assert.equal(runMemoryReset({ argv: [exe, MEMORY_RESET_FLAG, "--inspect"], execPath: exe, env: {}, spawn, entry: "/res/server/x.js", write: () => {} }), MEMORY_RESET_USAGE_EXIT);
  assert.equal(runMemoryReset({ argv: [exe, MEMORY_RESET_FLAG], execPath: exe, env: {}, spawn, entry: null, write: () => {} }), 1);
  assert.equal(started, 0);
  assert.equal(runMemoryReset({ argv: [exe, MEMORY_RESET_FLAG], execPath: exe, env: {}, spawn: () => ({ error: new Error("ENOENT"), status: null }), entry: "/res/server/x.js", write: () => {} }), 1);
});

test("electron/main.mjs imports the clean-up entry right after the Sentinel trampoline, before any other app module", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
  const imports = main.split("\n").filter(line => line.startsWith("import "));
  assert.deepEqual(imports.slice(2, 4), ['import "./sentinel-trampoline-entry.mjs";', 'import "./memory-reset-entry.mjs";']);
  // the entry itself loads nothing of the app: Node modules and the hide installer only
  const entry = readFileSync(path.join(import.meta.dirname, "memory-reset-entry.mjs"), "utf8");
  assert.deepEqual(entry.split("\n").filter(line => line.startsWith("import ")).map(line => line.slice(line.indexOf(" from ") + 6)),
    ['"node:child_process";', '"node:fs";', '"node:path";', '"node:url";', '"../shared/win-hide-child-process.mjs";']);
});
