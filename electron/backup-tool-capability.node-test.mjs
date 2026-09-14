import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createBackupToolCapability } from "./backup-mode.mjs";

async function fixture(work) {
  const root = mkdtempSync(path.join(tmpdir(), "murage-backup-capability-"));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const state = { calls: 0, usable: true, fail: false, hold: null, wrong: false };
  const resources = path.join(root, "resources");
  mkdirSync(path.join(resources, "server"), { recursive: true });
  const key = `backupFixture${Date.now()}${Math.random()}`;
  globalThis[key] = state;
  writeFileSync(path.join(resources, "server", "windows-backup-resources.js"), `
    import path from 'node:path';
    export function createWindowsBackupResourceResolver(input) {
      return async () => {
        const state = globalThis[${JSON.stringify(key)}];
        state.calls++; state.input = input;
        await state.hold;
        if (state.fail) throw Error('AGE_TOOL_UNVERIFIED');
        return { executable: path.join(input.resourcesPath, 'backup-tools', 'x64', state.wrong ? 'other.exe' : 'murage-backup-age.exe') };
      };
    }
  `);
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  const executable = path.join(root, "Murage.exe");
  const capability = createBackupToolCapability({ resourcesPath: resources, currentExecutable: executable, isUsable: () => state.usable });
  try { await work({ capability, state, resources, executable }); }
  finally { Object.defineProperty(process, "platform", descriptor); delete globalThis[key]; rmSync(root, { recursive: true }); }
}

test("Windows capability verifies fixed resources per operation, never during status reads", () => fixture(async ({ capability, state, resources, executable }) => {
  assert.equal(capability.currentTool(), null); assert.equal(capability.status().state, "pending");
  assert.equal(state.calls, 0);
  const expected = path.join(resources, "backup-tools", "x64", "age.exe");
  assert.equal(await capability.requireTool(), expected);
  assert.deepEqual(state.input, { resourcesPath: resources, currentExecutable: executable });
  assert.equal(capability.currentTool(), expected); capability.status(); assert.equal(state.calls, 1);
  assert.equal(await capability.requireTool(), expected); assert.equal(state.calls, 2);
  state.fail = true;
  await assert.rejects(capability.requireTool(), /AGE_TOOL_UNVERIFIED/);
  assert.equal(capability.currentTool(), null); assert.equal(capability.status().state, "failed");
  state.fail = false; assert.equal(await capability.requireTool(), expected);
}));

test("Windows verification coalesces and shutdown invalidates its pending result", () => fixture(async ({ capability, state }) => {
  let release; state.hold = new Promise(resolve => { release = resolve; });
  const first = capability.requireTool(), second = capability.requireTool();
  const results = Promise.allSettled([first, second]);
  while (!state.calls) await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.calls, 1); capability.invalidate(); state.usable = false;
  let drained = false; const drain = capability.settled().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  release(); const outcome = await results; await drain;
  assert.ok(outcome.every(value => value.status === "rejected")); assert.equal(capability.currentTool(), null);
}));

test("Windows capability refuses a wrong helper identity or lost host before readiness", () => fixture(async ({ capability, state }) => {
  state.wrong = true; await assert.rejects(capability.requireTool(), /unavailable/);
  assert.equal(capability.currentTool(), null); state.wrong = false; state.usable = false;
  await assert.rejects(capability.requireTool(), /unavailable/); assert.equal(state.calls, 1);
}));

const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
function mainFunction(name, end) {
  const start = main.indexOf(`async function ${name}(`);
  assert.ok(start >= 0); const stop = main.indexOf(end, start); assert.ok(stop > start);
  return main.slice(start, stop);
}
test("actual desktop verifier wrapper refuses owner changes after await", async () => {
  let release;
  const context = { desktopDataOwner: {}, desktopDataDir: "fixture", desktopShutdownStarted: false,
    desktopBackupTool: { requireTool: () => new Promise(resolve => { release = resolve; }) } };
  const run = vm.runInNewContext(`(${mainFunction("requireDesktopBackupTool", "\nconst backupMode")})`, context);
  const pending = run(); context.desktopDataOwner = {}; release("fixed-age.exe");
  await assert.rejects(pending, error => error.code === "BACKUP_UNAVAILABLE");
});

test("actual desktop recovery rejects failed verification before identity or worker dispatch", async () => {
  let calls = 0;
  const context = { desktopDataOwner: {}, desktopDataDir: "fixture", desktopRecoveryMode: true, desktopShutdownStarted: false,
    requireDesktopBackupTool: async () => { throw Object.assign(Error("unverified"), { code: "AGE_TOOL_UNVERIFIED" }); },
    canRestoreSeparateInstallation: () => false, runInstallationRecoveryWorker: () => { calls++; } };
  const run = vm.runInNewContext(`(${mainFunction("runDesktopRecovery", "\nfunction initializeBackgroundLifecycle")})`, context);
  const readIdentity = () => { calls++; return "synthetic"; };
  await assert.rejects(run("backup-encrypted", { readIdentity }), error => error.code === "AGE_TOOL_UNVERIFIED");
  assert.equal(calls, 0);
});

test("actual desktop recovery retains ordinary Windows failure paths without changing POSIX policy", async () => {
  for (const platform of ["win32", "darwin"]) {
    const failure = Object.assign(Error("worker failed"), { code: "AGE_PROCESS_FAILED", retainedDirectory: "private-stage" });
    const context = { desktopDataOwner: { utilityServerLeaseEnvironment: () => ({}) }, desktopDataDir: "fixture",
      desktopRecoveryMode: true, desktopShutdownStarted: false, retainedSeparateDirectory: null,
      requireDesktopBackupTool: async () => "fixed-age.exe", canRestoreSeparateInstallation: () => false,
      awaitOwnedWork: async promise => promise, desktopStartup: Promise.resolve(), ownedServerChildren: new Set(),
      serverProc: null, credentialWrites: new Set(), companionStarts: new Set(), browserLifecycleCleanups: new Map(),
      stopDesktopCompanion: async () => {}, browserSurface: null, browserHost: null, cuaReady: Promise.resolve(), stopCua: async () => {},
      process: { platform, env: {}, resourcesPath: "resources" }, path, trackOwnedServerChild: () => {},
      runInstallationRecoveryWorker: async () => { throw failure; } };
    const run = vm.runInNewContext(`(${mainFunction("runDesktopRecovery", "\nfunction initializeBackgroundLifecycle")})`, context);
    await assert.rejects(run("inspect-encrypted", { archive: "fixture.age", readIdentity: async () => "synthetic" }), error => error === failure);
    assert.equal(context.retainedSeparateDirectory, platform === "win32" ? "private-stage" : null);
  }
});
