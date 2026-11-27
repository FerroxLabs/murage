// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 MEMORY-V2 lane D, B1 and gate G-OS (owners: witness and measure = memv2-D; the callers of the measure = lane C).
// One measure everywhere, never another writer's bytes: a drain transaction that changed 0 rows costs 0; otherwise it costs its OWN log
// frames, and only when they are provably its own (log salt unchanged, PRAGMA data_version unmoved across it), else rows x W. No OS counter
// is an input, so darwin (whole-process diskWritten), win32 (none) and linux (the thread's write_bytes) are charged the same.
// Closes the Astra High on mem-f3-opusrace 8747d3f87d (revoke-budget.ts:694): COMMIT releases the writer lock before the frame sample, so a
// foreign commit landing in between was charged to the drain, and a zero-row drain paid for it. The darwin backlog witness is harvested from
// mem-f3-opusrace's revoke-backlog-drain-1021.test.ts (a Mac's process-wide counter under a busy foreign writer).
// Real path: the real measure on a real WAL file and a real second connection; only the OS counter and process.platform are injected.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExclusionAddon } from "../engine-exclusion.ts";
import { darwinWrittenBytes, resetDarwinWrittenForTest } from "../os-disk-written.ts";

/** A Mac's process-wide diskWritten under a 4 GB/min foreign writer: every read is 64 MiB past the last one. Injected on the loaded
 * engine-exclusion addon object, the one the real darwinWrittenBytes() reads (a vi.mock of os-disk-written does not reach a module the
 * setup file already loaded). */
const disk = { bytes: 0, step: 64 * 1024 * 1024 };
type Addon = { diskWritten?: () => number };
let addon: Addon | null = null, realDiskWritten: Addon["diskWritten"];
beforeEach(() => {
  addon = loadExclusionAddon() as unknown as Addon | null;
  expect(addon, "the engine-exclusion addon is loaded (the darwin counter is injected on it)").not.toBeNull();
  realDiskWritten = addon!.diskWritten;
  addon!.diskWritten = () => (disk.bytes += disk.step);
  disk.bytes = 0; resetDarwinWrittenForTest();
  expect(darwinWrittenBytes(), "the injected counter reaches the real reader").toBe(disk.step);
  disk.bytes = 0; resetDarwinWrittenForTest();
});

import { drainRevokeMarkerBounded, stopMemoryRevocation } from "./memory-revocation.ts";
import * as rb from "./revoke-budget.ts";
import { inheritMarks, } from "./revoke-commit.ts";
import * as revokeCommit from "./revoke-commit.ts";
import { markerWorkPending } from "./revoke-marker.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";

const PLATFORMS = ["darwin", "win32", "linux"] as const;
type Platform = typeof PLATFORMS[number];
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function asPlatform<T>(platform: Platform, run: () => T): T {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return run(); } finally { Object.defineProperty(process, "platform", realPlatform); }
}

const fixtures: WritetimeFixture[] = [];
const others: DatabaseSync[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", realPlatform);
  if (addon) addon.diskWritten = realDiskWritten;
  rb.setRevokeBudgetClock(); rb.resetRevokeWriteBudget(); stopMemoryRevocation(); disk.bytes = 0; resetDarwinWrittenForTest();
  for (const o of others.splice(0)) { try { o.close(); } catch { /* closed */ } }
  for (const f of fixtures.splice(0)) f.close();
});
const n = (f: WritetimeFixture, sql: string) => Number((f.db.prepare(sql).get() as { n: number }).n);
const active = (f: WritetimeFixture) => n(f, "SELECT count(*) AS n FROM memory_revoke_jobs WHERE state='active'");
const pendingRows = (f: WritetimeFixture) => n(f, "SELECT (SELECT count(*) FROM memory_deny_pending)+(SELECT count(*) FROM memory_deny_pending_scope) AS n");
const fileOf = (db: DatabaseSync) => String((db.prepare("PRAGMA database_list").get() as { file: string }).file);

/** `jobs` inherit/mark revokes as 1.0.20 left them (mem-f3-opusrace's fixture): each a generated reply that carried a line under a coalesced
 * deletion range and so became the root of an inherit job, with its frontier node and its pending hold. A WAL file, no autocheckpoint. */
function backlog(jobs: number, threads = 8): WritetimeFixture {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  f.cert(true);
  for (let t = 0; t < threads; t++) f.reply(`bl-${t}`, "parent", 20, { turnLsn: 19 }).denyLine(`bl-${t}`, 20, -1);
  f.db.prepare("UPDATE memory_lsn SET next=100000 WHERE id=1").run();
  // Lane C (mechanics only, CONTRACT-REQ D): since MEMORY V2 V3 ("An inherit job closes in the write that creates it") and V3b ("One
  // inherit job per transaction, not per child") these writes leave no standing job. The backlog here is the one 1.0.20 left, so it is
  // written with lane C's test seam off (revoke-commit.ts INHERIT_CLOSE; absent on a tree without lane C, where nothing closes inline).
  const seam = (revokeCommit as unknown as { INHERIT_CLOSE?: { inline: boolean; share: boolean } }).INHERIT_CLOSE, was = seam ? { ...seam } : null;
  if (seam) { seam.inline = false; seam.share = false; }
  f.db.exec("BEGIN");
  try {
    for (let i = 0; i < jobs; i++) {
      const T = `bl-${i % threads}`, lsn = 100 + i;
      f.reply(T, `c${i}`, lsn, { turnLsn: lsn - 1 });
      inheritMarks(f.db, { kind: "line", threadId: T, lsn }, [], [{ threadId: T, from: 20, to: 20 }]);
    }
  } finally { if (seam && was) Object.assign(seam, was); }
  f.db.exec("COMMIT");
  f.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  return f;
}

type Charge = { measured: number; unmeasured: number; paced: number; ledger: number; cost: number; wait: number; ownFrames: number; rows: number };
/** One drain-owned transaction measured exactly as the runner does (BEGIN IMMEDIATE, beginRevokeMeasure, work, COMMIT, endRevokeMeasure).
 * `rows`: job rows it updates (0: a zero-row drain). `foreign`: another connection commits `foreign` bytes after the COMMIT and before the
 * sample (the window COMMIT opens by releasing the writer lock). A reader holds a snapshot so the drain's own copy cannot move the log. */
function oneDrain(platform: Platform, o: { rows: number; foreign: number; between?: boolean }): Charge {
  const f = backlog(8);
  const other = new DatabaseSync(fileOf(f.db)); others.push(other);
  other.exec("CREATE TABLE IF NOT EXISTS foreign_writer(v BLOB)");
  const pin = new DatabaseSync(fileOf(f.db)); others.push(pin);
  pin.exec("BEGIN"); pin.prepare("SELECT count(*) FROM memory_revoke_jobs").get();
  const now = 3_000_000;
  rb.setRevokeBudgetClock(() => now); rb.resetRevokeWriteBudget(); disk.bytes = 0; resetDarwinWrittenForTest();
  const cost0 = rb.revokeCostPerChange(f.db);
  return asPlatform(platform, () => {
    const m0 = { measured: rb.revokeWriteMeter.paceMeasured, unmeasured: rb.revokeWriteMeter.paceUnmeasured };
    f.db.exec("BEGIN IMMEDIATE");
    const m = rb.beginRevokeMeasure(f.db);
    const before = rb.walIndexMark(f.db)!.mxFrame;
    if (o.rows > 0) f.db.prepare(`UPDATE memory_revoke_jobs SET cursor='d1' WHERE rowid IN (SELECT rowid FROM memory_revoke_jobs WHERE state='active' LIMIT ${o.rows})`).run();
    f.db.exec("COMMIT");
    const ownFrames = rb.walIndexMark(f.db)!.mxFrame - before;
    if (o.foreign > 0 && !o.between) other.prepare("INSERT INTO foreign_writer VALUES (randomblob(?))").run(o.foreign);
    // `between`: the foreign commit lands after the measure's frame sample and before its data_version read
    if (o.between) rb.revokePaceTestHooks.betweenSampleAndVersion = () => { rb.revokePaceTestHooks.betweenSampleAndVersion = null; other.prepare("INSERT INTO foreign_writer VALUES (randomblob(?))").run(o.foreign); };
    try { rb.endRevokeMeasure(f.db, m); } finally { rb.revokePaceTestHooks.betweenSampleAndVersion = null; }
    const out: Charge = {
      measured: rb.revokeWriteMeter.paceMeasured - m0.measured, unmeasured: rb.revokeWriteMeter.paceUnmeasured - m0.unmeasured,
      paced: rb.revokePacedBytes(now), ledger: rb.revokeBytesWritten(now), cost: rb.revokeCostPerChange(f.db) - cost0,
      wait: rb.revokePaceWaitMs(rb.revokePaceNeed(f.db), now), ownFrames: ownFrames * rb.frameBytes(f.db), rows: o.rows,
    };
    pin.exec("COMMIT");
    return out;
  });
}
const everyOs = (o: { rows: number; foreign: number; between?: boolean }) => Object.fromEntries(PLATFORMS.map(p => [p, oneDrain(p, o)])) as Record<Platform, Charge>;
const W = () => { const f = backlog(1); return rb.revokeChangeCeiling(f.db); };

describe("B1 one measure, never another writer's bytes (G-OS, lane D)", { timeout: 300_000 }, () => {
  it("a zero-row drain is charged nothing on any OS, even when a foreign commit lands between its COMMIT and the frame sample", () => {
    const r = everyOs({ rows: 0, foreign: 256 * 1024 });
    console.log(`[G-OS-MEASURE] zero-row+foreign ${JSON.stringify(r)}`);
    for (const p of PLATFORMS) {
      // base f6ae52c670: the post-COMMIT sample counts the foreign frames (and darwin the process counter): the pace is spent by them
      expect({ p, paced: r[p].paced, ledger: r[p].ledger, measured: r[p].measured, unmeasured: r[p].unmeasured }).toEqual({ p, paced: 0, ledger: 0, measured: 0, unmeasured: 0 });
      expect(r[p].wait).toBe(0);
    }
  });
  it("a drain that changed rows, with a foreign commit before its sample, is charged rows x W per half (not its frames plus the foreign's) and C learns nothing", () => {
    const w = W(), r = everyOs({ rows: 4, foreign: 256 * 1024 });
    console.log(`[G-OS-MEASURE] rows=4+foreign W=${w} ${JSON.stringify(r)}`);
    for (const p of PLATFORMS) {
      expect({ p, unmeasured: r[p].unmeasured, measured: r[p].measured, cost: r[p].cost }).toEqual({ p, unmeasured: 2 * 4 * w, measured: 0, cost: 0 });
      expect(r[p].paced).toBe(2 * 4 * w);
    }
  });
  it("a foreign commit landing between the frame sample and the data_version read refuses the sample: rows x W, never a mixed count", () => {
    const w = W(), r = everyOs({ rows: 4, foreign: 256 * 1024, between: true });
    console.log(`[G-OS-MEASURE] rows=4+foreign-between W=${w} ${JSON.stringify(r)}`);
    for (const p of PLATFORMS) {
      // a measure that read data_version BEFORE its sample would count this commit's frames as its own (the ordering mutant)
      expect({ p, unmeasured: r[p].unmeasured, measured: r[p].measured, cost: r[p].cost }).toEqual({ p, unmeasured: 2 * 4 * w, measured: 0, cost: 0 });
    }
  });
  it("a drain that changed rows with no foreign commit is charged exactly its own frames, identically on darwin, win32 and linux", () => {
    const r = everyOs({ rows: 4, foreign: 0 });
    console.log(`[G-OS-MEASURE] rows=4 own ${JSON.stringify(r)}`);
    for (const p of PLATFORMS) {
      expect(r[p].ownFrames).toBeGreaterThan(0);
      // darwin on base: max(64 MiB of the process counter, frames); linux on base: max(the thread's write_bytes, frames)
      expect({ p, measured: r[p].measured, unmeasured: r[p].unmeasured, paced: r[p].paced }).toEqual({ p, measured: 2 * r[p].ownFrames, unmeasured: 0, paced: 2 * r[p].ownFrames });
    }
    const strip = (c: Charge) => ({ ...c });
    expect(strip(r.darwin)).toEqual(strip(r.linux));
    expect(strip(r.win32)).toEqual(strip(r.linux));
  });
});

/** mem-f3-opusrace's darwin witness (harvested): `minutes` of idle, one second at a time on the budget's clock, the runner's rule each
 * second, a turn's send-fence drain every `turnEvery` s, with a Mac's process counter moving 64 MiB at every read (a 4 GB/min foreign
 * writer). Returns the active jobs and pending rows left at each minute. */
function idleMac(f: WritetimeFixture, minutes: number, turnEvery: number): { jobsLeft: number[]; pendingLeft: number[] } {
  let now = 5_000_000;
  rb.setRevokeBudgetClock(() => now); rb.resetRevokeWriteBudget(); disk.bytes = 0; resetDarwinWrittenForTest();
  const out = { jobsLeft: [] as number[], pendingLeft: [] as number[] };
  asPlatform("darwin", () => {
    for (let s = 1; s <= minutes * 60; s++) {
      now += 1000;
      if (s % turnEvery === 0) drainRevokeMarkerBounded(f.db);
      if (markerWorkPending(f.db) && rb.revokePaceWaitMs(rb.revokePaceNeed(f.db)) === 0) drainRevokeMarkerBounded(f.db, { rows: 4096, ms: 60_000 }, { background: true });
      if (s % 60 === 0) { out.jobsLeft.push(active(f)); out.pendingLeft.push(pendingRows(f)); }
    }
  });
  return out;
}

describe("G-OS backlog on a Mac under a 4 GB/min foreign writer (harvested from mem-f3-opusrace)", { timeout: 900_000 }, () => {
  it("the 2,247-job inherit backlog drains to near zero within 60 idle minutes with a turn every 10 s", () => {
    const SEEDED = 2247, NEAR_ZERO = Math.ceil(SEEDED / 100);
    const f = backlog(SEEDED);
    expect([active(f), pendingRows(f)]).toEqual([SEEDED, SEEDED]);
    const r = idleMac(f, 60, 10);
    console.log(`[G-OS-MEASURE] darwin backlog jobs/min ${r.jobsLeft.join(",")} | pending/min ${r.pendingLeft.join(",")}`);
    // base f6ae52c670: every zero-row turn drain charged the process counter's foreign bytes to the 0.8 MB pace; the queue never moved
    expect(r.jobsLeft.at(-1)!).toBeLessThanOrEqual(NEAR_ZERO);
    expect(r.pendingLeft.at(-1)!).toBeLessThanOrEqual(NEAR_ZERO);
  });
});
