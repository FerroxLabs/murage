// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { BOOT_EXTEND_LIMIT_MS, pollServerIdentity } from "./server-boot-probe.mjs";
import {
  MEMORY_UPGRADE_STATUS_FILE, buildMemoryUpgradePage, describeBytes, memoryUpgradeBlockedSentence, memoryUpgradeLocale, memoryUpgradeProgress,
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
  assert.equal(memoryUpgradeProgress(status, "/d", () => { throw new Error("not created yet"); }), 1);
  assert.equal(memoryUpgradeProgress({ ...status, phase: "migrating" }, "/d"), 95);
  assert.equal(memoryUpgradeProgress({ state: "blocked", code: "MEMORY_MIGRATION_FAILED" }, "/d"), null);
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
      decodeURIComponent(buildMemoryUpgradePage({ language, percent: 10 })),
    ].join("\n");
    assert.doesNotMatch(all, /—|\bsafe|\bsafely|safety|unsafe|composio|\$|price/i, language);
  }
  assert.match(decodeURIComponent(buildMemoryUpgradePage({ language: "en" })), /Upgrading your memory/);
  assert.match(decodeURIComponent(buildMemoryUpgradePage({ language: "en" })), /can take a minute/);
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
  const fetchImpl = async () => { calls += 1; if (clock < 200_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", pid: 9, static: true }) }; };
  const ready = await pollServerIdentity({ port: 1, pid: () => 9, bootTimeoutMs: 60_000, now, sleep, fetchImpl, extendWhile: () => true });
  assert.equal(ready.outcome, "ready");
  assert.ok(clock >= 200_000 && calls > 100);
  clock = 0;
  const never = await pollServerIdentity({ port: 1, pid: () => 9, bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); }, extendWhile: () => true });
  assert.equal(never.outcome, "timeout");
  assert.ok(clock >= BOOT_EXTEND_LIMIT_MS && clock < BOOT_EXTEND_LIMIT_MS + 10_000);
  clock = 0;
  const plain = await pollServerIdentity({ port: 1, pid: () => 9, bootTimeoutMs: 60_000, now, sleep, fetchImpl: async () => { throw new Error("refused"); } });
  assert.equal(plain.outcome, "timeout");
  assert.ok(clock < 62_000, "without an upgrade the budget is unchanged");
});

test("main.mjs shows the upgrade screen, keeps waiting for it, and reports a blocked upgrade on the recovery page", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /watchMemoryUpgrade\(\{ dataDir: desktopDataDir, pid: \(\) => proc\.pid, onUpdate: showMemoryUpgradeProgress \}\)/);
  assert.match(main, /extendWhile: \(\) => upgradeWatch\?\.active\(\) \?\? false/);
  assert.match(main, /reason: "memory-blocked"/);
  assert.match(main, /memoryUpgradeBlocked \? "MEMORY_UPGRADE_BLOCKED"/);
  assert.match(main, /reasonCode === "MEMORY_UPGRADE_BLOCKED"\s*\?\s*memoryUpgradeBlockedSentence\(memoryUpgradeBlocked, app\.getLocale\(\)\)/);
  // closing the screen must not read as "the person closed the last window"
  assert.match(main, /window-all-closed", \(\) => \{\s*if\(memoryUpgradeWindowClosing\)return;/);
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
  const screen = main.slice(main.indexOf("function showMemoryUpgradeProgress"), main.indexOf("function closeMemoryUpgradeWindow"));
  assert.doesNotMatch(screen, /closable: false/, "Windows and Linux have no other way out of this screen");
  assert.match(screen, /memoryUpgradeWindow\.on\("close", \(\) => \{[^}]*app\.quit\(\)/);
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
  const fetchImpl = async () => { if (clock < 130_000) throw new Error("refused"); return { ok: true, json: async () => ({ app: "murage", pid: 9, static: true }) }; };
  const result = await pollServerIdentity({ port: 1, pid: () => 9, bootTimeoutMs: 60_000, now, sleep, fetchImpl, extendWhile: () => clock < 100_000 });
  assert.equal(result.outcome, "ready", "a finished upgrade must not leave the child only the last 5 s extension step");
});
