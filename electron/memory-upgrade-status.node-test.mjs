// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BOOT_EXTEND_ABSOLUTE_MS, BOOT_EXTEND_LIMIT_MS } from "./server-boot-probe.mjs";
import { pollServerIdentity, launchOf } from "./signed-fetch.test.mjs";
import {
  MEMORY_UPGRADE_STATUS_FILE, describeBytes, memoryUpgradeBlockedSentence, memoryUpgradeLocale, memoryUpgradeProgress,
  readMemoryUpgradeStatus, watchMemoryUpgrade,
} from "./memory-upgrade-status.mjs";

function dir() { const root = mkdtempSync(path.join(tmpdir(), "murage-upgrade-note-")); mkdirSync(root, { recursive: true }); return root; }
const note = (root, value) => writeFileSync(path.join(root, MEMORY_UPGRADE_STATUS_FILE), JSON.stringify({ v: 1, pid: 77, startedAt: 1, updatedAt: 2, ...value }));

test("reads the note only for the child that is starting now, and only the closed shapes", () => {
  const root = dir();
  try {
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }), null);
    note(root, { state: "upgrading", phase: "copying", copyBytes: 1000, partialName: "messages.pre-memory-v3.db.partial" });
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }).phase, "copying");
    assert.equal(readMemoryUpgradeStatus(root, { pid: 78 }), null, "a note from an earlier launch is not this launch's state");
    note(root, { state: "blocked", code: "MEMORY_MIGRATION_DISK_SPACE", shortBytes: 5 });
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }).code, "MEMORY_MIGRATION_DISK_SPACE");
    note(root, { state: "blocked", code: "SOMETHING_ELSE" });
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }), null);
    note(root, { state: "upgrading", phase: "copying", partialName: "../../etc/passwd" });
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }).partialName, undefined, "only a bare file name is followed");
    writeFileSync(path.join(root, MEMORY_UPGRADE_STATUS_FILE), "{not json");
    assert.equal(readMemoryUpgradeStatus(root, { pid: 77 }), null);
  } finally { safeWipeSync(root); }
});

test("progress is the size of the growing copy over its expected size", () => {
  const status = { state: "upgrading", phase: "copying", copyBytes: 1000, partialName: "x.partial" };
  assert.equal(memoryUpgradeProgress(status, "/d", () => 500), 50);
  assert.equal(memoryUpgradeProgress(status, "/d", () => 5000), 94, "never claims done before the upgrade itself has run");
  assert.equal(memoryUpgradeProgress(status, "/d", () => { throw new Error("not created yet"); }), null);
  assert.equal(memoryUpgradeProgress({ ...status, phase: "migrating" }, "/d"), null, "a step with no figure has no percent");
  assert.equal(memoryUpgradeProgress({ state: "blocked", code: "MEMORY_MIGRATION_FAILED" }, "/d"), null);
});

test("a percent is never made up: only the launch-wide figure of a known launch, or the copy's own growth, is one", async () => {
  const { sampleState } = await import("../shared/upgrade-contract.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "murage-upgrade-v7-"));
  try {
    note(root, { state: "upgrading", phase: "converting", done: 500, total: 1000 });
    const status = readMemoryUpgradeStatus(root, { pid: 77 });
    assert.equal(status.phase, "converting");
    assert.equal(memoryUpgradeProgress(status, root), null, "sets done is not a percent of the whole launch");
    assert.equal(memoryUpgradeProgress({ state: "upgrading", phase: "reclaiming" }, root), null);
    assert.equal(memoryUpgradeProgress({ state: "upgrading", phase: "indexing" }, root), null);
    const known = { state: "upgrading", upgrade: { ok: true, state: sampleState({ overall: 0.42 }) } };
    assert.equal(memoryUpgradeProgress(known, root), 42);
    assert.equal(memoryUpgradeProgress({ state: "upgrading", upgrade: { ok: true, state: sampleState({ launch: "unknown", overall: "unknown" }) } }, root), null);
  } finally { safeWipeSync(root); }
});

test("every sentence is plain: no em dash, no banned words, the shortfall is named", () => {
  assert.equal(describeBytes(1), "1 MB");
  assert.equal(describeBytes(590 * 1048576 - 1), "590 MB");
  assert.equal(describeBytes(1.31 * 1024 ** 3), "1.4 GB");
  const space = memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_DISK_SPACE", shortBytes: 590 * 1048576 }, "en-US");
  assert.match(space, /at least 590 MB/);
  assert.equal(memoryUpgradeLocale("pt-BR"), "pt");
  assert.equal(memoryUpgradeLocale("sv"), "en");
  assert.match(memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_DISK_SPACE", shortBytes: 590 * 1048576 }, "de"), /590 MB/);
  for (const language of ["en", "de", "es", "fr", "hi", "ja", "pt", "zh"]) {
    const all = [
      ...["MEMORY_MIGRATION_DISK_SPACE", "MEMORY_SCHEMA_NEWER", "MEMORY_MIGRATION_FAILED"].map(code => memoryUpgradeBlockedSentence({ code, shortBytes: 1048576 }, language)),
      memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_TIMEOUT" }, language, { logPath: "/logs/server.log" }),
    ].join("\n");
    assert.doesNotMatch(all, /—|\bsafe|\bsafely|safety|unsafe|composio|\$|price/i, language);
  }
  assert.match(memoryUpgradeBlockedSentence({ code: "MEMORY_MIGRATION_TIMEOUT" }, "en", { logPath: "/logs/server.log" }), /did not finish in the time Murage allows.*\/logs\/server\.log/);
});

test("the watcher reports changes once and says when an upgrade is running", () => {
  let current = null; const seen = [];
  let tick;
  const watch = watchMemoryUpgrade({
    dataDir: "/d", pid: 77, read: () => current, progress: status => (status ? 10 : null),
    onUpdate: (status, percent) => seen.push([status?.state ?? null, percent]),
    setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  tick(); assert.equal(watch.active(), false);
  current = { state: "upgrading", phase: "copying" }; tick(); tick();
  assert.equal(watch.active(), true);
  current = { state: "blocked", code: "MEMORY_MIGRATION_FAILED" }; tick();
  assert.equal(watch.active(), false);
  assert.deepEqual(seen, [[null, null], ["upgrading", 10], ["blocked", 10]]);
});

test("the boot wait outlasts its budget while a memory upgrade runs, then ends at the hard cap", async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; if (clock < 200_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", launch: launchOf("n9"), static: true }) }; };
  const ready = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl, extendWhile: () => true });
  assert.equal(ready.outcome, "ready");
  assert.ok(clock >= 200_000 && calls > 100);
  clock = 0;
  const never = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); }, extendWhile: () => true });
  assert.equal(never.outcome, "timeout");
  assert.ok(clock >= BOOT_EXTEND_LIMIT_MS && clock < BOOT_EXTEND_LIMIT_MS + 10_000);
  clock = 0;
  const plain = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); } });
  assert.equal(plain.outcome, "timeout");
  assert.ok(clock < 62_000, "without an upgrade the budget is unchanged");
});

test("main.mjs shows the upgrade screen, keeps waiting for it, and reports a blocked upgrade on the recovery page", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /watchMemoryUpgrade\(\{ dataDir: desktopDataDir, pid: \(\) => proc\.pid, onReading: showMemoryUpgradeProgress \}\)/);
  assert.match(main, /extendWhile: \(\) => upgradeWatch\?\.active\(\) \?\? false/);
  assert.match(main, /reason: "memory-blocked"/);
  assert.match(main, /memoryUpgradeBlocked \? "MEMORY_UPGRADE_BLOCKED"/);
  assert.match(main, /reasonCode === "MEMORY_UPGRADE_BLOCKED"\s*\?\s*memoryUpgradeBlockedSentence\(memoryUpgradeBlocked, app\.getLocale\(\), \{ logPath: path\.join\(LOG_DIR, "server\.log"\) \}\)/);
  // one wait window: the upgrade screen is the start-up splash, and a second window for it no longer exists
  assert.doesNotMatch(main, /memoryUpgradeWindow|buildMemoryUpgradePage/);
  assert.match(main, /upgradeScreen\.update\(status, percent/);
  assert.match(main, /startupSplash\.set\(view\)/);
});

// Review (Opus, 2026-10-02) additions.
test("the shell removes the note and its temp file once the child is gone, and nothing else", async () => {
  const { clearMemoryUpgradeStatus } = await import("./memory-upgrade-status.mjs");
  const { existsSync } = await import("node:fs");
  const root = dir();
  try {
    note(root, { state: "blocked", code: "MEMORY_MIGRATION_DISK_SPACE" });
    writeFileSync(path.join(root, `${MEMORY_UPGRADE_STATUS_FILE}.4242.tmp`), "{");
    writeFileSync(path.join(root, "messages.db"), "keep");
    writeFileSync(path.join(root, "messages.pre-memory-v3.db"), "keep");
    clearMemoryUpgradeStatus(root);
    assert.equal(existsSync(path.join(root, MEMORY_UPGRADE_STATUS_FILE)), false);
    assert.equal(existsSync(path.join(root, `${MEMORY_UPGRADE_STATUS_FILE}.4242.tmp`)), false);
    assert.equal(existsSync(path.join(root, "messages.db")), true);
    assert.equal(existsSync(path.join(root, "messages.pre-memory-v3.db")), true);
    clearMemoryUpgradeStatus(path.join(root, "missing")); // never throws
  } finally { safeWipeSync(root); }
});

test("the upgrade screen can be closed (that quits), a wait that ran out mid-upgrade is not retried on other ports, and a stopped start clears the note", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const screen = main.slice(main.indexOf("function showMemoryUpgradeProgress"), main.indexOf("function syncBrowserConnection"));
  assert.doesNotMatch(screen, /closable: false/, "Windows and Linux have no other way out of this screen");
  assert.match(screen, /onUserClose: \(\) => app\.quit\(\)/);
  assert.match(main, /icon: APP_ICON, language: app\.getLocale\?\.\(\), onUserClose: \(\) => app\.quit\(\), note:/, "the packaged splash quits on close too");
  const start = main.slice(main.indexOf("async function startServerOn("), main.indexOf("async function startServerPackaged("));
  assert.match(start, /identity\.outcome === "timeout" && upgradeSeen/);
  assert.match(start, /clearMemoryUpgradeStatus\(desktopDataDir\)/);
  assert.ok((start.match(/clearMemoryUpgradeStatus\(desktopDataDir\)/g) ?? []).length >= 3, "every path where the child did not come up");
});

test("an upgrade that ends after the normal budget leaves the child a full budget to finish booting", async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  // upgrade runs until 100 s, then the rest of the boot takes 30 s more
  const fetchImpl = async () => { if (clock < 130_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", launch: launchOf("n9"), static: true }) }; };
  const result = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl, extendWhile: () => clock < 100_000 });
  assert.equal(result.outcome, "ready", "a finished upgrade must not leave the child only the last 5 s extension step");
});

test("S1: the 30-minute cap does not end an upgrade whose note is still moving, and still ends a stalled one", async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  const refused = async () => { throw new Error("refused"); };
  // progress stays fresh until 50 minutes in, then the note stops moving
  const staysFresh = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: refused, extendWhile: () => true, progressFresh: () => clock < 50 * 60_000 });
  assert.equal(staysFresh.outcome, "timeout");
  assert.ok(clock >= 50 * 60_000 && clock < 50 * 60_000 + 10_000, "waited past the 30-minute cap while progress was fresh");
  // a child that comes up at 45 minutes while still reporting progress is ready, not failed
  clock = 0;
  const lateReady = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, extendWhile: () => true, progressFresh: () => true,
    fetchImpl: async () => { if (clock < 45 * 60_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", launch: launchOf("n9"), static: true }) }; } });
  assert.equal(lateReady.outcome, "ready");
  // no fresh progress: the cap is the end, as before
  clock = 0;
  const stalled = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: refused, extendWhile: () => true, progressFresh: () => false });
  assert.equal(stalled.outcome, "timeout");
  assert.ok(clock >= BOOT_EXTEND_LIMIT_MS && clock < BOOT_EXTEND_LIMIT_MS + 10_000);
  // and fresh progress never lifts the absolute ceiling
  clock = 0;
  const wedged = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep: async (ms) => { clock += ms * 50; }, fetchImpl: refused, extendWhile: () => true, progressFresh: () => true });
  assert.equal(wedged.outcome, "timeout");
  assert.ok(clock >= BOOT_EXTEND_ABSOLUTE_MS);
});

test("S1: the watcher calls an upgrade fresh while its note changes and stale once it has sat still", () => {
  let current = { state: "upgrading", phase: "repairing", updatedAt: 1, done: 0, total: 9 };
  let tick; let clock = 0;
  const watch = watchMemoryUpgrade({
    dataDir: "/d", pid: 77, read: () => current, progress: () => 10, onUpdate: () => {}, now: () => clock, freshMs: 5 * 60_000,
    setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer: () => {},
  });
  assert.equal(watch.fresh(), false, "nothing seen yet");
  tick(); assert.equal(watch.fresh(), true);
  clock = 4 * 60_000; current = { ...current, updatedAt: 2 }; tick();
  clock = 8 * 60_000; assert.equal(watch.fresh(), true, "moved 4 minutes ago");
  clock = 10 * 60_000; tick(); assert.equal(watch.fresh(), false, "still, for more than five minutes");
  current = { ...current, updatedAt: 3, done: 1 }; tick(); assert.equal(watch.fresh(), true);
  assert.equal(memoryUpgradeProgress({ state: "upgrading", phase: "repairing", done: 1, total: 4 }, "/d"), null, "a count of steps is not a percent of the launch");
  assert.equal(readMemoryUpgradeStatus(dir(), { pid: 77 }), null);
});

test("S1: main.mjs hands the boot probe the watcher's freshness", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), /progressFresh: \(\) => upgradeWatch\?\.fresh\(\) \?\? false/);
});

test("P1 r1: an upgrade that ends after the 30-minute cap still gives the child its boot budget", async () => {
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };
  const end = 31 * 60_000;
  // the upgrade (and its note) ends at 31 minutes; the rest of the boot needs 20 seconds more
  const fetchImpl = async () => { if (clock < end + 20_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", launch: launchOf("n9"), static: true }) }; };
  const result = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl, extendWhile: () => clock < end, progressFresh: () => clock < end });
  assert.equal(result.outcome, "ready");
  // and a note that stays but stops moving is still a stall
  clock = 0;
  const stalled = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); }, extendWhile: () => true, progressFresh: () => clock < end });
  assert.equal(stalled.outcome, "timeout");
  assert.ok(clock < end + 10_000);
  // a finished upgrade whose child never comes up is still bounded by one budget
  clock = 0;
  const dead = await pollServerIdentity({ port: 1, nonce: () => "n9", bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); }, extendWhile: () => clock < end, progressFresh: () => clock < end });
  assert.equal(dead.outcome, "timeout");
  assert.ok(clock >= end + 55_000 && clock < end + 70_000);
});

test("P1 r2: a long indivisible step past the stale threshold does not fail the boot while the server is alive, and a dead server still does", async () => {
  // The server's heartbeat thread rewrites the note (updatedAt) every 30 s while the server thread is blocked inside one statement.
  const boot = async ({ aliveUntil, readyAt }) => {
    let clock = 0;
    const now = () => clock;
    let current = { state: "upgrading", phase: "migrating", step: "indexes", updatedAt: 0 };
    let tick;
    const watch = watchMemoryUpgrade({ dataDir: "/d", launch: launchOf("n5"), read: () => current, progress: () => 95, onUpdate: () => {}, now, freshMs: 5 * 60_000,
      setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer: () => {} });
    const sleep = async (ms) => {
      clock += ms;
      if (clock <= aliveUntil && Math.floor(clock / 30_000) !== Math.floor((clock - ms) / 30_000)) current = { ...current, updatedAt: clock };
      tick();
    };
    tick();
    const result = await pollServerIdentity({ port: 1, nonce: () => "n5", bootTimeoutMs: 60_000, now, sleep, extendWhile: () => watch.active(), progressFresh: () => watch.fresh(),
      fetchImpl: async () => { if (clock < readyAt) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", launch: launchOf("n5"), static: true }) }; } });
    return { outcome: result.outcome, clock };
  };
  // one statement that runs for 50 minutes (past the 30-minute cap and every five-minute stale window), then the server is ready
  const alive = await boot({ aliveUntil: Infinity, readyAt: 50 * 60_000 });
  assert.equal(alive.outcome, "ready", "the heartbeat kept the note fresh through a 50-minute statement");
  // the server dies at 35 minutes: the beats stop with it, the note goes stale, and the boot fails soon after
  const dead = await boot({ aliveUntil: 35 * 60_000, readyAt: Infinity });
  assert.equal(dead.outcome, "timeout");
  assert.ok(dead.clock >= 40 * 60_000 && dead.clock < 41 * 60_000, `failed ${Math.round(dead.clock / 60_000)} min in`);
  // the reader passes the step through, and drops one it does not know
  const root = dir();
  try {
    note(root, { state: "upgrading", phase: "migrating", launch: launchOf("n3"), step: "indexes", stepElapsedMs: 61_000 });
    assert.deepEqual([readMemoryUpgradeStatus(root, { launch: launchOf("n3") }).step, readMemoryUpgradeStatus(root, { launch: launchOf("n3") }).stepElapsedMs], ["indexes", 61_000]);
    note(root, { state: "upgrading", phase: "migrating", launch: launchOf("n3"), step: "C:\\secret" });
    assert.equal(readMemoryUpgradeStatus(root, { launch: launchOf("n3") }).step, undefined);
  } finally { safeWipeSync(root); }
});
