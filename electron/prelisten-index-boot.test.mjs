// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOOT-INDEX BUILD-FIX 1: a launch that builds the owner-pin index has no health responder (it is not migrating), so the shell knows the server only through
// the start-up note. The shell's own probe and watcher on a real note file, on a fake clock: past 30 minutes, with the heartbeat lost, and at the 6-hour limit.
// The page each ending leads to is in data-owner-integration.node-test.mjs, which runs startServerOn itself.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import * as statusModule from "./memory-upgrade-status.mjs";
const { MEMORY_UPGRADE_STATUS_FILE, readMemoryUpgradeStatus, UPGRADE_PROGRESS_FRESH_MS, watchMemoryUpgrade } = statusModule;
// Defaults model the ordinary migration policy on versions before the one-time step contract.
const isOneTimeIndexNote = statusModule.isOneTimeIndexNote ?? (() => false);
const upgradeTimeoutCode = statusModule.upgradeTimeoutCode ?? (() => "MEMORY_MIGRATION_TIMEOUT");
const MEMORY_INDEX_STOPPED = "MEMORY_INDEX_STOPPED";
import { createUpgradeScreen } from "./upgrade-screen.mjs";
import { unknownUpgradeState } from "../shared/upgrade-contract.mjs";
import { BOOT_EXTEND_ABSOLUTE_MS, BOOT_EXTEND_LIMIT_MS } from "./server-boot-probe.mjs";
import { launchOf, pollServerIdentity } from "./signed-fetch.test.mjs";

// Build the wire note even when an older reader does not yet recognize its phase.
const noteState = input => ({ ...unknownUpgradeState({ ...input, phase: "checking" }), phase: input.phase });
const MIN = 60_000, PID = 4242, LIMIT_MS = 5 * MIN;
const refused = async () => { throw new Error("connection refused"); };
const ourAnswer = async () => ({ ok: true, status: 200, json: async () => ({ app: "murage", pid: PID, launch: launchOf("n7"), static: true }) });

/** The server's note as the heartbeat writes it, while `beatingUntil` lasts; the shell's probe and watcher look at it on a clock each sleep moves by 5 s. */
async function boot({ beatingUntil, readyAt = Infinity, writable = true, doneAt = Infinity }) {
  const dir = mkdtempSync(join(tmpdir(), "boot-index-"));
  try {
    let clock = 0, stopped = false;
    const note = () => {
      if (!writable) return;
      // the build is done: upgrade.done() takes the note down, and the rest of the boot follows
      if (clock >= doneAt) { rmSync(join(dir, MEMORY_UPGRADE_STATUS_FILE), { force: true }); return; }
      // the note as the beat writes it, its contract state built by the contract's own code; the time awake moves with the clock
      if (clock <= beatingUntil) writeFileSync(join(dir, MEMORY_UPGRADE_STATUS_FILE), JSON.stringify({ v: 1, state: "upgrading", phase: "indexing", step: "backfill", pid: PID, startedAt: 0, updatedAt: clock,
        upgrade: noteState({ launch: "unknown", source: "note", stage: "starting", complete: false, keepOpen: true, heartbeatAt: clock, phase: "indexing", step: { awakeElapsedMs: clock, unit: "none" } }) }));
    };
    note();
    const watch = watchMemoryUpgrade({ dataDir: dir, pid: PID, now: () => clock, setTimer: () => ({}), clearTimer: () => {} });
    watch.tick();
    const result = await pollServerIdentity({
      port: 1, nonce: () => "n7", bootTimeoutMs: LIMIT_MS, now: () => clock,
      sleep: async () => { clock += 5_000; note(); if (!stopped) watch.tick(); },
      fetchImpl: () => (clock >= readyAt ? ourAnswer() : refused()),
      extendWhile: () => watch.active(), progressFresh: () => watch.fresh(),
      // the same closure main.mjs passes
      liveWithoutLimit: () => watch.fresh() && isOneTimeIndexNote(watch.status()),
    });
    stopped = true;
    return { outcome: result.outcome, at: clock, finalNote: readMemoryUpgradeStatus(dir, { pid: PID }) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("a build that outlasts the 5-minute limit and the 30-minute cap with its note moving reaches ready, no stop", async () => {
  for (const readyAt of [10 * MIN, BOOT_EXTEND_LIMIT_MS + 15 * MIN]) {
    const end = await boot({ beatingUntil: Infinity, readyAt });
    assert.equal(end.outcome, "ready");
    assert.ok(end.at >= readyAt);
  }
});

test("past 30 minutes a heartbeat that stops ends in a timeout about a minute later, with the note still saying upgrading", async () => {
  const stoppedAt = BOOT_EXTEND_LIMIT_MS + 5 * MIN;
  const end = await boot({ beatingUntil: stoppedAt });
  assert.equal(end.outcome, "timeout");
  assert.ok(end.at >= stoppedAt + UPGRADE_PROGRESS_FRESH_MS && end.at <= stoppedAt + UPGRADE_PROGRESS_FRESH_MS + 2 * MIN, `ended at ${end.at}`);
  assert.equal(end.finalNote?.state, "upgrading");
});

test("before 30 minutes a heartbeat that stops is waited out to the 30-minute cap, then the same ending", async () => {
  const end = await boot({ beatingUntil: 10 * MIN });
  assert.equal(end.outcome, "timeout");
  assert.ok(end.at >= BOOT_EXTEND_LIMIT_MS && end.at <= BOOT_EXTEND_LIMIT_MS + 2 * MIN, `ended at ${end.at}`);
  assert.equal(end.finalNote?.state, "upgrading");
});

test("a beat still moving past 6 hours keeps the launch waiting: slow is never a stop", async () => {
  const readyAt = BOOT_EXTEND_ABSOLUTE_MS + 20 * MIN;
  const end = await boot({ beatingUntil: Infinity, readyAt });
  assert.equal(end.outcome, "ready");
  assert.ok(end.at >= readyAt);
});

test("a build that finishes past 6 hours gives the rest of the boot its fresh 5-minute budget", async () => {
  const doneAt = BOOT_EXTEND_ABSOLUTE_MS + 20 * MIN;
  const end = await boot({ beatingUntil: Infinity, doneAt, readyAt: doneAt + 3 * MIN });
  assert.equal(end.outcome, "ready");
});

for (const offset of [-5_000, 0, 5_000]) {
  test(`an index finishing ${offset} ms from the six-hour boundary gets a fresh startup budget`, async () => {
    const doneAt = BOOT_EXTEND_ABSOLUTE_MS + offset;
    const end = await boot({ beatingUntil: Infinity, doneAt, readyAt: doneAt + 3 * MIN });
    assert.equal(end.outcome, "ready");
    assert.equal(end.at, doneAt + 3 * MIN);
  });
  test(`an index finishing ${offset} ms from the six-hour boundary still bounds the remaining startup`, async () => {
    const doneAt = BOOT_EXTEND_ABSOLUTE_MS + offset;
    const end = await boot({ beatingUntil: Infinity, doneAt });
    assert.equal(end.outcome, "timeout");
    assert.equal(end.at, doneAt + LIMIT_MS);
  });
}

test("a beat that stops past 6 hours ends about a minute later, as the one-time step and not as a migration", async () => {
  const stoppedAt = BOOT_EXTEND_ABSOLUTE_MS + 10 * MIN;
  const end = await boot({ beatingUntil: stoppedAt });
  assert.equal(end.outcome, "timeout");
  assert.ok(end.at >= stoppedAt + UPGRADE_PROGRESS_FRESH_MS && end.at <= stoppedAt + UPGRADE_PROGRESS_FRESH_MS + 2 * MIN, `ended at ${end.at}`);
  assert.equal(upgradeTimeoutCode(end.finalNote), MEMORY_INDEX_STOPPED);
});

test("the wait window names the step, its time moves, and its quit note says the step starts over", () => {
  const dir = mkdtempSync(join(tmpdir(), "boot-index-"));
  try {
    const at = (clock) => { writeFileSync(join(dir, MEMORY_UPGRADE_STATUS_FILE), JSON.stringify({ v: 1, state: "upgrading", phase: "indexing", step: "backfill", pid: PID, startedAt: 0, updatedAt: clock,
      upgrade: noteState({ launch: "unknown", source: "note", stage: "starting", complete: false, keepOpen: true, heartbeatAt: clock, phase: "indexing", step: { awakeElapsedMs: clock, unit: "none" } }) })); return readMemoryUpgradeStatus(dir, { pid: PID }); };
    let clock = 1_000;
    const screen = createUpgradeScreen({ language: "en", now: () => clock });
    const first = screen.update(at(1_000), null, {});
    clock = 7_000;
    const later = screen.update(at(7_000), null, {});
    assert.ok(first, "the one-time step has a visible wait screen");
    assert.equal(first.mode, "blocking");
    assert.equal(first.line, "Finishing a one-time step");
    assert.equal(first.controls.quitNote, "You can close Murage. This step starts over the next time you open it.");
    assert.ok(later.elapsedMs > first.elapsedMs, `${first.elapsedMs} then ${later.elapsedMs}`);
    // a known launch whose earlier note (a check, seq 4) was shown first: the beat's note, with a later seq from the same allocator, still takes over the screen
    const launch = "a".repeat(64);
    const known = (seq, phase) => { writeFileSync(join(dir, MEMORY_UPGRADE_STATUS_FILE), JSON.stringify({ v: 1, state: "upgrading", phase: "checking", pid: PID, startedAt: 0, updatedAt: clock,
      upgrade: noteState({ launch, seq, source: "note", stage: "starting", complete: false, keepOpen: true, heartbeatAt: clock, phase, step: { awakeElapsedMs: clock, unit: "none" } }) })); return readMemoryUpgradeStatus(dir, { pid: PID }); };
    const screen2 = createUpgradeScreen({ language: "en", now: () => clock });
    screen2.update(known(4, "checking"), null, {});
    clock = 9_000;
    assert.equal(screen2.update(known(5, "indexing"), null, {}).line, "Finishing a one-time step");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a note that cannot be written leaves the ordinary 5-minute stop, with no note to read: the slow-start page", async () => {
  const end = await boot({ beatingUntil: Infinity, writable: false });
  assert.equal(end.outcome, "timeout");
  assert.ok(end.at >= LIMIT_MS && end.at <= LIMIT_MS + MIN, `ended at ${end.at}`);
  assert.equal(end.finalNote, null);
});
