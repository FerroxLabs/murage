// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 Windows final D1. Twice, in a window Murage had reopened itself
// (after a backup, and after Backup mode's Retry startup), Back up now and
// Restart into Backup mode failed with nothing running. From then on
// Backups read "Needs a supported desktop app", Back up now and Turn off
// were greyed out, daily backups stopped without a word, and only a quit and
// reopen brought them back.
//
// Why: every backup action checks the backup tool afresh. On Windows one
// check that failed (the coordinator recorded the Back up now as skipped /
// cancelled, i.e. refused in prepare, before any handoff or close) set the
// tool to "failed", and only macOS ever checked again. supported() is
// "the tool is ready", so it stayed false for the life of the process.
//
// These drive the real tool capability, the real schedule host and the real
// coordinator, wired the way electron/main.mjs wires them.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BackupCoordinator } from "../server/backup-coordinator.ts";
import * as backupMode from "./backup-mode.mjs";
const { createBackupModeController, createBackupToolCapability } = backupMode;
const BACKUP_TOOL_STUCK_AFTER = backupMode.BACKUP_TOOL_STUCK_AFTER ?? 3;
import { createBackupScheduleHost } from "./backup-schedule-host.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const fakeKey = "# public key: age1" + "q".repeat(58) + "\nAGE-SECRET-KEY-1" + "A".repeat(60) + "\n";
const choices = { enabled: true, timezone: "UTC", time: "09:00", catchupMs: 86400000, maxBytes: 100000000, maxDurationMs: 60000, selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" }, preUpgrade: false };
const until = async (predicate, ms = 3000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw Error("timed out"); await new Promise(r => setTimeout(r, 5)); } };
const fast = { recheckOptions: { delays: [5, 10, 20] }, actionRetryDelays: [5, 10] };

/** The tool capability on one platform, with a check that can be made to
 * fail the next `failNext` times, or always. */
function toolOn(platform, root, events) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  const check = { calls: 0, failNext: 0, fail: false, usable: true };
  const resources = path.join(root, "resources"), key = `relaunchTool${Date.now()}${Math.random()}`;
  globalThis[key] = check;
  let options = {};
  if (platform === "win32") {
    // The resolver the capability imports; this one only counts and refuses.
    mkdirSync(path.join(resources, "server"), { recursive: true });
    writeFileSync(path.join(resources, "server", "windows-backup-resources.js"), `
      import path from 'node:path';
      export function createWindowsBackupResourceResolver(input) {
        return async () => {
          const check = globalThis[${JSON.stringify(key)}]; check.calls++;
          if (check.fail || check.failNext > 0) { check.failNext--; throw Object.assign(Error('AGE_TOOL_UNVERIFIED'), { step: 'signatures', reason: 'timeout' }); }
          return { executable: path.join(input.resourcesPath, 'backup-tools', 'x64', 'murage-backup-age.exe') };
        };
      }`);
  } else if (platform === "darwin") {
    const file = path.join(resources, "backup-tools", process.arch, "age");
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, "fixture tool");
    options = { verifyMacTool: async () => { check.calls++; if (check.fail || check.failNext > 0) { check.failNext--; return false; } return true; } };
  }
  const executable = platform === "darwin" ? path.join(root, "Murage") : path.join(root, "Murage.exe");
  writeFileSync(executable, "fixture executable");
  const capability = createBackupToolCapability({ resourcesPath: resources, currentExecutable: executable, isUsable: () => check.usable, ...fast, ...options,
    onFailure: ({ failures }) => events.push(`failed ${failures}`), onReady: () => events.push("ready again") });
  return { capability, check, restore: () => { capability.invalidate(); Object.defineProperty(process, "platform", descriptor); delete globalThis[key]; } };
}

/** main.mjs's reason, over this capability: never while it is still checking. */
const reasonFor = capability => capability.currentTool() || capability.status().checking ? null : "tool";

async function relaunchedWindow(platform, work, hostExtra = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-relaunch-tool-")));
  const installation = path.join(root, "installation"), destination = path.join(root, "archives"), keyFile = path.join(root, "independent-key.txt");
  mkdirSync(installation); mkdirSync(destination); writeFileSync(keyFile, fakeKey, { mode: 0o600 });
  const events = [], calls = [], announced = [];
  const tool = toolOn(platform, root, events);
  let now = Date.parse("2026-09-27T07:30:00Z"), binding;
  const coordinator = () => new BackupCoordinator({ stateDirectory: path.join(root, "control"), now: () => now });
  const { capability } = tool;
  const host = createBackupScheduleHost({
    coordinator: coordinator(), installation: () => installation, now: () => now,
    // As main.mjs: the tool must be ready; checking while it is being checked.
    supported: () => Boolean(capability.currentTool()), checking: () => capability.status().checking,
    unavailableReason: () => reasonFor(capability), announceUnavailable: reason => { announced.push(reason); },
    readProtected: async () => binding, writeProtected: async (_key, value) => { binding = value; },
    chooseDestination: async () => destination, chooseKey: async () => keyFile, confirmReferences: async () => true,
    // As main.mjs's prepare: the action's own fresh check first.
    prepare: async () => { await (capability.requireFresh ?? capability.requireTool)(); calls.push("prepare"); return async () => calls.push("release"); },
    cleanupIdle: async () => calls.push("cleanup"), relaunch: async mode => calls.push(mode),
    capture: async request => { const bytes = Buffer.from("fictional encrypted artifact"); writeFileSync(request.output, bytes, { flag: "wx", mode: 0o600 }); return { ok: true, operation: "backup-encrypted", path: request.output, sha256: digest(bytes), snapshotId: randomUUID(), coverage: { scope: "application-data", fullInstallation: false, credentialPolicy: "preserve-in-encrypted-fidelity" } }; },
    ...hostExtra,
  });
  try {
    // The relaunched window's own startup check passes, as it did at 07:32.
    if (platform !== "linux") await capability.requireTool();
    const picked = await host.selectReferences();
    await host.configure(0, { ...choices, ...Object.fromEntries(["installationRef", "destinationRef", "recoveryRef"].map(k => [k, picked.refs[k]])), allowIdleRestart: true });
    host.stopPolling(); await until(() => !host.isPreparing());
    await work({ host, capability, check: tool.check, calls, events, announced, coordinator, setNow: value => { now = value; } });
  } finally { host.stopPolling(); tool.restore(); safeWipeSync(root); }
}

for (const platform of ["win32", "darwin"]) {
  test(`${platform}: Back up now in a relaunched window survives one failed tool check and never leaves backups unsupported`, () => relaunchedWindow(platform, async ({ host, capability, check, calls, coordinator }) => {
    assert.equal((await host.status()).supported, true);
    // The check at the click fails once (Windows: a signature check that ran
    // past its bound while the reopened app was still starting).
    check.failNext = 1;
    const status = await host.status();
    await host.runNow(status.revision);
    assert.deepEqual(calls, ["prepare", "cleanup", "backup"]);
    assert.equal(coordinator().status().phase, "handoff-armed");
    assert.ok(capability.currentTool());
  }));

  test(`${platform}: when every try at the click fails, the tool is checked again by itself and backups come back without a restart`, () => relaunchedWindow(platform, async ({ host, capability, check, calls, events, coordinator }) => {
    check.fail = true;
    const status = await host.status();
    await assert.rejects(host.runNow(status.revision), /BACKUP_UNAVAILABLE|AGE_TOOL_UNVERIFIED/);
    check.fail = false;
    assert.equal(coordinator().status().phase, "skipped"); assert.equal(coordinator().status().job.error, "cancelled");
    assert.equal(calls.includes("cleanup"), false);
    // D1: this read {supported:false} for more than five minutes. Now the
    // next check runs by itself and passes.
    await until(() => Boolean(capability.currentTool()));
    const after = await host.status();
    assert.equal(after.supported, true); assert.equal(after.unavailable, undefined);
    assert.ok(events.includes("ready again"));
    await host.runNow(after.revision);
    assert.equal(calls.at(-1), "backup");
  }));

  test(`${platform}: Restart into Backup mode in a relaunched window survives one failed tool check`, async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-relaunch-mode-"))), events = [];
    const tool = toolOn(platform, root, events), { capability, check } = tool;
    try {
      await capability.requireTool();
      let restarted = 0;
      const mode = createBackupModeController({ supported: () => Boolean(capability.currentTool()), unavailableReason: () => reasonFor(capability),
        readActivity: async () => ({ bots: [], groups: [] }), confirm: async () => true,
        prepare: async () => { await (capability.requireFresh ?? capability.requireTool)(); return async () => {}; }, restart: async () => { restarted++; } });
      check.failNext = 1;
      assert.deepEqual(await mode.restart(), { restarting: true }); assert.equal(restarted, 1);
      // Even after a run of failures it recovers by itself.
      check.fail = true;
      await assert.rejects(mode.restart());
      check.fail = false;
      await until(() => mode.status().supported === true);
    } finally { tool.restore(); safeWipeSync(root); }
  });
}

test("a tool that keeps failing its check stops reading as 'getting ready': the page says why, and a due daily backup is announced, not dropped", () => relaunchedWindow("win32", async ({ host, capability, check, announced, events, setNow }) => {
  check.fail = true;
  await assert.rejects(capability.requireTool());
  await until(() => events.includes(`failed ${BACKUP_TOOL_STUCK_AFTER}`));
  const stuck = await host.status();
  assert.equal(stuck.supported, false); assert.equal(stuck.checking, undefined); assert.equal(stuck.unavailable, "tool");
  // The daily backup comes due while the tool is failing.
  setNow(Date.parse("2026-09-28T09:01:00Z"));
  await host.tick();
  assert.deepEqual(announced, ["tool"]);
  // Checks go on in the background; once one passes, backups are back.
  check.fail = false;
  await until(() => Boolean(capability.currentTool()), 5000);
  assert.equal((await host.status()).supported, true);
  assert.ok(events.includes("ready again"));
}));

test("linux: the tool is looked at on every read, so a failed action check never sticks, and a missing tool is said plainly", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "murage-relaunch-linux-"))), events = [];
  const tool = toolOn("linux", root, events), { capability } = tool;
  try {
    await assert.rejects(capability.requireFresh(), /BACKUP_UNAVAILABLE/);
    // Nothing is remembered: no failed state, no count, no timer.
    assert.deepEqual(capability.status(), { state: "failed", checking: false, failures: 0 });
    assert.deepEqual(events, []);
    assert.equal(reasonFor(capability), "tool");
  } finally { tool.restore(); safeWipeSync(root); }
});

// 0.1.60 Windows final L3: after the card was answered the page kept
// "<bot> is waiting for your answer" until the next backup.
test("an answered card stops being named on the Backups page at once", async () => {
  const pebble = { botId: "pebble", name: "Pebble", threadId: "thread-1", messageId: "m1" };
  let waitingNow = [pebble], harnessUp = true;
  await relaunchedWindow("win32", async ({ host }) => {
    const s = await host.status();
    await assert.rejects(host.runNow(s.revision), /BACKUP_WAITING_ON_YOU/);
    assert.deepEqual((await host.status()).heldBy.bots.map(bot => bot.name), ["Pebble"]);
    // The harness can't say right now: the last known answer stays.
    harnessUp = false; assert.deepEqual((await host.status()).heldBy.bots.map(bot => bot.name), ["Pebble"]);
    // Answered.
    harnessUp = true; waitingNow = [];
    assert.equal((await host.status()).heldBy, undefined);
  }, {
    prepare: async () => { throw Object.assign(new Error("BACKUP_WAITING_ON_YOU"), { waitingOnYou: [pebble] }); },
    waitingNow: async () => { if (!harnessUp) throw Error("Murage is not ready yet."); return waitingNow; },
  });
});

// The wiring in main.mjs itself.
const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
test("main.mjs: actions use the retried fresh check, the close before a backup restart is watched, and the host is told why", () => {
  const wrapper = main.slice(main.indexOf("async function requireDesktopBackupTool("), main.indexOf("\nconst backupMode"));
  assert.match(wrapper, /desktopBackupTool\.requireFresh\(\)/);
  assert.match(main, /cleanupIdle:cleanupForBackupRestart,/);
  assert.match(main, /await cleanupForBackupRestart\(\);\n\s*relaunchDesktop\(/);
  assert.match(main, /unavailableReason:backupUnavailableReason,\n\s*announceUnavailable:/);
  assert.match(main, /waitingNow:async\(\)=>\(await harnessJson\("\/api\/backup-waiting"\)\)\?\.bots/);
});
test("main.mjs: a backup restart whose close can't finish marks this window as unable to back up and says so", async () => {
  const start = main.indexOf("let desktopBackupCleanupFailed"), end = main.indexOf("const desktopBackupTool = createBackupToolCapability");
  assert.ok(start > 0 && end > start);
  const announced = [], logged = [];
  const context = { app: { isPackaged: true }, desktopRecoveryMode: false, desktopShutdownStarted: false, desktopDataOwner: {}, desktopCleanupStage: "owned harness",
    desktopBackupTool: { currentTool: () => "age.exe", status: () => ({ checking: false }) },
    cleanupDesktopForExit: async () => { context.desktopShutdownStarted = true; throw Error("The owned harness has not exited"); },
    slog: line => logged.push(line), announceBackupUnavailable: async reason => { announced.push(reason); } };
  vm.createContext(context);
  vm.runInContext(main.slice(start, end).replace("let desktopBackupCleanupFailed", "var desktopBackupCleanupFailed"), context);
  assert.equal(context.backupUnavailableReason(), null);
  await assert.rejects(context.cleanupForBackupRestart(), /has not exited/);
  assert.equal(context.backupUnavailableReason(), "closing");
  assert.deepEqual(announced, ["closing"]);
  assert.match(logged.join("\n"), /backup restart cleanup incomplete \(owned harness\)/);
  // A tool that is still being checked is not a reason; one that keeps failing is.
  Object.assign(context, { desktopShutdownStarted: false, desktopBackupTool: { currentTool: () => null, status: () => ({ checking: true }) } });
  assert.equal(context.backupUnavailableReason(), null);
  context.desktopBackupTool.status = () => ({ checking: false });
  assert.equal(context.backupUnavailableReason(), "tool");
});
