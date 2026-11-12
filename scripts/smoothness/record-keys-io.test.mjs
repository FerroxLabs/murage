// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real SQLite WAL writes, synthetic history and a virtual maintenance clock.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../../server/config.ts";
import { closeDatabase, database, transaction } from "../../server/database.ts";
import { IoBudget, osWriteBlocks, walFrameReader } from "../../server/io-budget.ts";
import { searchIndexTestHooks } from "../../server/message-search-index.ts";
import { checkpointPassive, walMaintenanceReady } from "../../server/wal-maintenance.ts";
import { closeMemoryIndexReader } from "../../server/memory/index-reader.ts";
import { ensureScope, reconcileMemoryRoster } from "../../server/memory/policy.ts";
import * as keys from "../../server/memory/record-keys.ts";
import { fillRecordKeysSlice, recordKeysRoom, RECORD_KEYS_WRITE_BUDGET, resetRecordKeysWriteBudget, startRecordKeysBuild } from "../../server/memory/record-keys.ts";
import { dropRecordKeys, ensureRecordKeys, recordKeysReady } from "../../server/memory/schema.ts";
import { removeTempDir, removeTempDirSync } from "../../server/testing/cleanup.ts";
import { countSignatures, judgeRow } from "./smooth-config.mjs";
import { loadBudgets } from "./smooth-gate.mjs";

const originalBudget = RECORD_KEYS_WRITE_BUDGET.bytesPerMinute;
let build;
let wal;
beforeEach(async () => {
  closeMemoryIndexReader(); await removeTempDir(DATA_DIR, { strict: true });
  mkdirSync(DATA_DIR, { recursive: true });
  resetRecordKeysWriteBudget();
  // Reviewed 5d5a791f19 adds independent search-reset marker transactions.
  // This meter attributes record-key writes only; hold search activation.
  searchIndexTestHooks.failStart = true;
});
afterEach(async () => {
  build?.stop(); if (build) await build.done;
  build = undefined;
  vi.useRealTimers(); closeMemoryIndexReader(); closeDatabase();
  wal?.close(); wal = undefined;
  await removeTempDir(DATA_DIR); resetRecordKeysWriteBudget();
  searchIndexTestHooks.failStart = false;
  RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = originalBudget;
  keys.setRecordKeysBudgetClock();
});

function history(rows, { sameMs = false, pageSize } = {}) {
  // Choose a new file's page size before database() starts its WAL reader.
  // Changing journal mode after worker launch races that reader's connection.
  if (pageSize) {
    const seed = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try { seed.exec(`PRAGMA page_size=${pageSize}; VACUUM`); } finally { seed.close(); }
  }
  reconcileMemoryRoster({ bots: [{ id: "io-fixture", threadId: "io-thread" }], groups: [] });
  const db = database(), scope = ensureScope("bot", "io-fixture");
  if (pageSize) expect(Number(db.prepare("PRAGMA page_size").get().page_size)).toBe(pageSize);
  dropRecordKeys(db);
  transaction(tx => {
    const insert = tx.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','synthetic note','owner-statement','active',0,?,NULL,NULL,?)");
    for (let i = 0; i < rows; i++) insert.run(`synthetic-${i}`, scope, sameMs ? 1000 : i, sameMs ? 1000 : i);
  });
  ensureRecordKeys(db);
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = db.prepare("PRAGMA database_list").all().find(row => row.name === "main").file;
  wal = walFrameReader(file);
  return db;
}
const start = db => startRecordKeysBuild(db, { gate: null, admit: async () => {}, log: () => {} });

/** Complete worker startup and the seed copy on the real clock before measuring virtual maintenance. */
async function settleRecordKeysSeed(db) {
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  await vi.waitFor(async () => {
    const copied = await checkpointPassive();
    expect(copied.busy).toBe(0);
    expect(copied.checkpointed).toBe(copied.log);
    expect(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0, log: 0, checkpointed: 0 });
  }, { timeout: 10_000 });
  wal();
}


it.each(["S9.io", "ALL.io"])("%s: pending record-key maintenance stays inside the unchanged rig budget", { timeout: 120_000 }, async rowId => {
  const db = history(100_000), lines = [];
  await settleRecordKeysSeed(db);
  const baseOsBlocks = osWriteBlocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  // Exercise the real watchdog with both OS writes and measured WAL bytes,
  // including checkpoint copies and with no planned-byte exemption.
  const watchdog = new IoBudget({
    read: () => ({ at: Date.now(), fsWriteBlocks: osWriteBlocks() - baseOsBlocks, cpuMicros: 0 }),
    isIdle: () => true, systemOverloaded: () => null, log: line => lines.push(line),
  });
  watchdog.registerByteSource("record-keys-backfill", wal);
  watchdog.tick(); build = start(db);
  let peak = 0;
  for (let minute = 0; minute < 5; minute++) {
    await vi.advanceTimersByTimeAsync(60_000);
    db.exec("PRAGMA wal_checkpoint(PASSIVE)");
    peak = Math.max(peak, watchdog.tick().writeBytesPerMinute);
  }
  const io = countSignatures(lines.join("\n")).ioBudget;
  // The 1.0.19 HARD contract supplied by combined-gate.md: S9=0, ALL<=3.
  // This checkout still labels IO report-only at the older ALL<=8 threshold.
  const row = { ...loadBudgets().rows.find(row => row.id === rowId), reportOnly: false, value: rowId === "ALL.io" ? 3 : 0 };
  const results = { scenarios: { idle: { ioBudget: countSignatures(lines.slice(-3).join("\n")).ioBudget } }, all: { ioWrite: { lines: io } } };
  console.log(JSON.stringify({ rowId, io, peakBytesPerMinute: peak, keyed: build.stats.keyed, pending: !recordKeysReady(db) }));
  expect(judgeRow(row, results).pass).toBe(true);
  expect(peak).toBeLessThanOrEqual(1024 * 1024);
  expect(build.stats.keyed).toBeGreaterThan(0);
  expect(recordKeysReady(db)).toBe(false);
});

it("equal-timestamp ticks use bounded probes across slices and a database reopen", () => {
  let db = history(10_009, { sameMs: true });
  // Reach a long contiguous overflow range without spending thousands of virtual minutes.
  expect(fillRecordKeysSlice(db, 10_000, { budgetMs: Infinity }).keyed).toBe(10_000);
  let probes = 0;
  for (let slice = 0; slice < 3; slice++) {
    closeDatabase(); db = database();
    db.function("record_keys_gap_probe", _key => { probes++; return 1; });
    const prepare = db.prepare.bind(db);
    // Count real SQLite gap-walk visits, rather than relying on machine timing.
    const spy = vi.spyOn(db, "prepare").mockImplementation(sql => prepare(sql.replace(
      "WHERE a.age_key>", "WHERE record_keys_gap_probe(a.age_key) AND a.age_key>",
    )));
    try {
      const step = fillRecordKeysSlice(db, 3, { budgetMs: Infinity });
      expect(step.keyed).toBe(3);
      expect(probes).toBeLessThanOrEqual(3 * (slice + 1));
    } finally { spy.mockRestore(); }
  }
  expect(Number(db.prepare("SELECT max(age_key) AS k FROM memory_record_keys").get().k)).toBe(1000 * 2048 + 10_008);
  expect(fillRecordKeysSlice(db, 1).ready).toBe(true);
  console.log(JSON.stringify({ sameTimestampPrefix: 10_000, resumedSlices: 3, gapProbes: probes }));
});

// R4/R5: oversized atomic writes carry debt instead of being denied forever.
async function pageProgress(pageSize, equivalentPage = pageSize) {
  const db = history(12, { pageSize });
  await settleRecordKeysSeed(db);
  if (equivalentPage !== pageSize) RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = Math.round(524_288 * 65_560 / (equivalentPage + 24));
  expect(recordKeysRoom(db)).toBeGreaterThan(0);
  const admission = keys.recordKeysAdmission(db);
  const oversized = admission.oversized;
  if (pageSize === 65_536) expect(admission).toEqual({ rows: 1, waitMs: 0, oversized: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  keys.setRecordKeysBudgetClock(() => Date.now());
  const began = Date.now(), initialWal = wal(), samples = [], slices = [];
  let lastSlices = 0, lastBytes = 0, built;
  build = start(db);
  void build.done.then(value => { built = value; });
  // Sample every scheduled timer: this observes every commit, including its exact release time.
  for (let timer = 0; timer < 200 && built === undefined; timer++) {
    await vi.advanceTimersToNextTimerAsync();
    samples.push({ at: Date.now(), bytes: wal() - initialWal });
    if (build.stats.slices !== lastSlices) {
      const bytes = build.stats.bytes - lastBytes;
      slices.push({ at: Date.now(), bytes, keyed: build.stats.keyed });
      lastSlices = build.stats.slices; lastBytes = build.stats.bytes;
    }
  }
  expect(built).toBe(true);
  expect(build.stats.keyed).toBe(12);
  expect(recordKeysReady(db)).toBe(true);
  const maxSliceBytes = Math.max(...slices.map(s => s.bytes)), budget = RECORD_KEYS_WRITE_BUDGET.bytesPerMinute;
  if (oversized) {
    expect((Date.now() - began) / 60_000).toBeLessThanOrEqual(equivalentPage === 524_288 ? 100 : 40);
    for (let i = 0; i < slices.length; i++) {
      expect(slices[i].keyed - (slices[i - 1]?.keyed ?? 0)).toBe(i < 12 ? 1 : 0);
      if (i) expect(slices[i].at - slices[i - 1].at).toBeGreaterThanOrEqual(60_000 * Math.max(1, Math.ceil(slices[i - 1].bytes / budget)));
    }
    for (const s of samples) expect(s.bytes).toBeLessThanOrEqual(budget * Math.ceil((s.at - began) / 60_000) + maxSliceBytes);
    const minutes = (Date.now() - began) / 60_000;
    expect(build.stats.bytes / minutes).toBeLessThanOrEqual(budget * 1.05 + maxSliceBytes / minutes);
  } else {
    for (const a of samples) for (const b of samples) if (b.at >= a.at && b.at - a.at < 60_000) expect(b.bytes - a.bytes).toBeLessThanOrEqual(budget);
  }
  // walFrameReader counts frames; admission also charges the first 32-byte WAL header.
  expect(build.stats.bytes).toBe(wal() - initialWal + 32);
  console.log(JSON.stringify({ pageSize, equivalentPage, budget, minutes: (Date.now() - began) / 60_000, slices }));
}
it.each([4_096, 16_384, 32_768, 65_536])("R4 %i-byte pages make budgeted progress and finish", async pageSize => pageProgress(pageSize));
it.each([131_072, 524_288])("R5 equivalent %i-byte pages carry debt and finish", async equivalent => pageProgress(65_536, equivalent));

it("each tick stays bounded on a large history and a stopped build resumes from its committed cursor", async () => {
  const db = history(1000);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  build = start(db);
  await vi.advanceTimersByTimeAsync(1);
  expect(build.stats.keyed).toBeGreaterThan(0);
  expect(build.stats.keyed).toBeLessThanOrEqual(4);
  expect(build.stats.bytes).toBeLessThanOrEqual(128 * 1024);
  build.stop(); expect(await build.done).toBe(false);
  const cursor = Number(db.prepare("SELECT cursor_rowid AS c FROM memory_record_keys_build WHERE id=1").get().c);
  const keyed = Number(db.prepare("SELECT count(*) AS n FROM memory_record_keys").get().n);
  expect(cursor).toBeGreaterThan(0);
  closeDatabase();
  const reopened = database();
  expect(Number(reopened.prepare("SELECT cursor_rowid AS c FROM memory_record_keys_build WHERE id=1").get().c)).toBe(cursor);
  build = start(reopened);
  let built;
  void build.done.then(value => { built = value; });
  for (let minute = 0; minute < 100 && built === undefined; minute++) await vi.advanceTimersByTimeAsync(60_000);
  expect(built).toBe(true);
  expect(build.stats.keyed).toBe(1000 - keyed);
  expect(Number(reopened.prepare("SELECT count(*) AS n FROM memory_record_keys").get().n)).toBe(1000);
});

// Count real index visits and forbid preparing the reference's unbounded gap arm.
function boundedSpy(db) {
  let visits = 0, unbounded = 0;
  db.function("record_keys_gap_probe", _key => { visits++; return 1; });
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.includes("b.age_key=a.age_key+1")) unbounded++;
    return prepare(sql.replace("WHERE a.age_key>", "WHERE record_keys_gap_probe(a.age_key) AND a.age_key>"));
  });
  return { spy, counts: () => ({ visits, unbounded }) };
}
function deletePrefix(db, prefix, count) {
  db.prepare("DELETE FROM memory_records WHERE rowid BETWEEN ? AND ?").run(prefix - count + 1, prefix);
}
it.each(["cursor", "thousand", "all", "reopen"])("R1 deleted %s predecessor seeds continuation by value", variant => {
  let db = history(12_000, { sameMs: true });
  expect(fillRecordKeysSlice(db, 10_000, { budgetMs: Infinity }).keyed).toBe(10_000);
  deletePrefix(db, 10_000, variant === "all" ? 10_000 : variant === "cursor" ? 1 : 1000);
  if (variant === "reopen") { closeDatabase(); db = database(); }
  const probe = boundedSpy(db);
  try {
    const step = fillRecordKeysSlice(db, 3, { budgetMs: Infinity });
    expect(step.keyed).toBe(3);
    expect(probe.counts().visits).toBeLessThanOrEqual(3);
    expect(step.probed).toBeLessThanOrEqual(keys.RECORD_KEYS_WALK_KEYS);
    expect(probe.counts().unbounded).toBe(0);
    console.log(JSON.stringify({ variant, probed: step.probed, ...probe.counts() }));
  } finally { probe.spy.mockRestore(); }
});
it("R2 continuation work is identical at 5k and 50k including a trigger collision", () => {
  const results = [];
  for (const prefix of [5000, 50_000]) {
    const db = history(prefix + 3, { sameMs: true });
    fillRecordKeysSlice(db, prefix, { budgetMs: Infinity });
    deletePrefix(db, prefix, 1);
    // Occupy the first key after the run. The second resumed row must walk around it.
    db.prepare("INSERT INTO memory_records VALUES('trigger-collision',1,?,'fact','x','owner-statement','active',0,1000,NULL,NULL,1000)").run(ensureScope("bot", "io-fixture"));
    const probe = boundedSpy(db);
    try {
      const step = fillRecordKeysSlice(db, 3, { budgetMs: Infinity });
      expect(step.keyed).toBe(3);
      expect(step.probed).toBeLessThanOrEqual(keys.RECORD_KEYS_WALK_KEYS);
      expect(probe.counts().visits).toBeLessThanOrEqual(3);
      expect(probe.counts().unbounded).toBe(0);
      results.push({ probed: step.probed, ...probe.counts() });
    } finally { probe.spy.mockRestore(); }
    wal.close(); wal = undefined;
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "io-fixture", threadId: "io-thread" }], groups: [] });
  }
  expect(results[0]).toEqual(results[1]);
  console.log(JSON.stringify({ prefixes: [5000, 50_000], results }));
});
function longHistory() {
  const db = history(10_040, { sameMs: true });
  // Rekeying is disabled while constructing the legacy history.
  dropRecordKeys(db);
  db.exec("UPDATE memory_records SET created_at=1001 WHERE rowid>10000");
  ensureRecordKeys(db);
  return db;
}
const keyTable = db => db.prepare("SELECT record_id,age_key FROM memory_record_keys ORDER BY record_id").all();
// Same row-by-row reference as age-order.test.ts; that regression remains unchanged.
function referenceFill(db) {
  const put = db.prepare(keys.keyRecordSql());
  const nextUp = db.prepare("INSERT INTO memory_record_keys SELECT r.id,r.version,r.scope_id,r.state,r.owner_pinned,r.kind,?2 FROM memory_records r WHERE r.rowid=?1 AND NOT EXISTS(SELECT 1 FROM memory_record_keys k WHERE k.record_id=r.id AND k.record_version=r.version) AND NOT EXISTS(SELECT 1 FROM memory_record_keys WHERE age_key=?2)");
  const keyOf = db.prepare("SELECT k.age_key AS k FROM memory_records r JOIN memory_record_keys k ON k.record_id=r.id AND k.record_version=r.version WHERE r.rowid=?");
  let runAt = null, runKey = null;
  transaction(() => {
    for (const row of db.prepare("SELECT rowid AS rr,created_at AS at FROM memory_records ORDER BY rowid").all()) {
      let done = runAt === row.at && runKey !== null ? Number(nextUp.run(row.rr, runKey + 1).changes) : 0;
      if (done) runKey++; else if (Number(put.run(row.rr).changes)) { runAt = row.at; runKey = Number(keyOf.get(row.rr).k); }
    }
  });
}
it.each([Infinity, 0])("R3 resumable long walk with budget %s is bounded, free and reference equivalent", budgetMs => {
  const db = longHistory();
  referenceFill(db); const expected = keyTable(db);
  db.exec("DELETE FROM memory_record_keys");
  // End the equal-time prefix at a slice boundary so both count-limited walk slices are read-only.
  for (let left = 10_000; left > 0; left -= Math.min(left, 2048)) fillRecordKeysSlice(db, Math.min(left, 2048), { budgetMs: Infinity });
  const probe = boundedSpy(db);
  let step, slices = 0, free = 0, priorCursor = 10_000;
  const max = budgetMs === 0 ? 200 : 20;
  try {
    do {
      let progressUpdates = 0;
      // The spy also verifies no progress UPDATE for a read-only walk slice (I8).
      const prepare = probe.spy.getMockImplementation();
      probe.spy.mockImplementation(sql => { if (sql.startsWith("UPDATE memory_record_keys_build")) progressUpdates++; return prepare(sql); });
      step = fillRecordKeysSlice(db, 2048, { budgetMs }); slices++;
      probe.spy.mockImplementation(prepare);
      expect(step.probed).toBeLessThanOrEqual(keys.RECORD_KEYS_WALK_KEYS * (budgetMs === 0 ? 1 : keys.RECORD_KEYS_WALK_PROBES));
      const cursor = Number(db.prepare("SELECT cursor_rowid AS c FROM memory_record_keys_build").get().c);
      if (step.walkPending && step.keyed === 0) {
        free++; expect(step.walBytes).toBe(0); expect(cursor).toBe(priorCursor); expect(progressUpdates).toBe(0);
      } else if (!step.ready) expect(cursor).toBeGreaterThan(priorCursor);
      priorCursor = cursor;
    } while (!step.ready && slices < max);
    expect(step.ready).toBe(true);
    expect(free).toBeGreaterThanOrEqual(2);
    if (budgetMs === 0) expect(slices).toBeGreaterThan(20);
    expect(keyTable(db)).toEqual(expected);
    expect(probe.counts().unbounded).toBe(0);
    console.log(JSON.stringify({ budgetMs, slices, free, visits: probe.counts().visits }));
  } finally { probe.spy.mockRestore(); }
});
it.each(["row", "time"])("R3 checkpoints match %s; stale hints stay collision free; reopen rewalks boundedly", mismatch => {
  let db = longHistory();
  fillRecordKeysSlice(db, 10_000, { budgetMs: Infinity });
  expect(fillRecordKeysSlice(db, 2048, { budgetMs: Infinity }).walkPending).toBe(true);
  // An unmatched row must start from its own window, including a newly freed early gap.
  if (mismatch === "row") db.exec("DELETE FROM memory_records WHERE rowid=10001");
  else db.exec("UPDATE memory_records SET created_at=1001.5 WHERE rowid=10001; DELETE FROM memory_record_keys WHERE record_id='synthetic-10000'");
  db.exec("DELETE FROM memory_record_keys WHERE age_key=2053000");
  let step;
  for (let i = 0; i < 10 && !step?.ready; i++) step = fillRecordKeysSlice(db, 2048, { budgetMs: Infinity });
  expect(step.ready).toBe(true);
  expect(Number(db.prepare("SELECT age_key AS k FROM memory_record_keys WHERE record_id=?").get(mismatch === "row" ? "synthetic-10001" : "synthetic-10000").k)).toBe(2053000);
  // Start another long walk and free a key behind the matching checkpoint: skipping it is allowed (I5).
  dropRecordKeys(db); ensureRecordKeys(db);
  fillRecordKeysSlice(db, 10_000, { budgetMs: Infinity });
  expect(fillRecordKeysSlice(db, 2048, { budgetMs: Infinity }).walkPending).toBe(true);
  db.exec("DELETE FROM memory_record_keys WHERE age_key=2053001");
  const resumed = fillRecordKeysSlice(db, 2048, { budgetMs: Infinity });
  expect(resumed.probed).toBeLessThanOrEqual(keys.RECORD_KEYS_WALK_KEYS * keys.RECORD_KEYS_WALK_PROBES);
  closeDatabase(); db = database(); step = undefined;
  for (let i = 0; i < 10 && !step?.ready; i++) step = fillRecordKeysSlice(db, 2048, { budgetMs: Infinity });
  // No duplicate allocation, regardless of whether the matching hint survived.
  expect(step.ready).toBe(true);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_record_keys").get().n)).toBe(Number(db.prepare("SELECT count(DISTINCT age_key) AS n FROM memory_record_keys").get().n));
});
it.each([4096, 65_536])("R6 %i-byte pages sleep until exact admission release without busy polling", async pageSize => {
  const db = history(12, { pageSize });
  await settleRecordKeysSeed(db);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  keys.setRecordKeysBudgetClock(() => Date.now());
  const began = Date.now();
  if (pageSize === 4096) {
    // Fill to one byte short of the next unit. A staggered release must unblock at the earliest fitting time.
    expect(typeof keys.chargeRecordKeysWriteForTest).toBe("function");
    keys.chargeRecordKeysWriteForTest(RECORD_KEYS_WRITE_BUDGET.bytesPerMinute - 2 * keys.recordKeysCostPerRow(db) + 1, began);
  }
  build = start(db);
  await vi.advanceTimersByTimeAsync(5);
  if (pageSize === 65_536) expect(build.stats.keyed).toBe(1);
  const before = { ...build.stats }, wait = keys.recordKeysWriteWaitMs(db), until = Date.now() + wait;
  expect(wait).toBeGreaterThan(0);
  while (Date.now() < until - 1) await vi.advanceTimersByTimeAsync(Math.min(1000, until - 1 - Date.now()));
  expect(build.stats.slices).toBe(before.slices);
  expect(build.stats.ticks - before.ticks).toBeLessThanOrEqual(pageSize === 65_536 ? 1 : 2);
  await vi.advanceTimersByTimeAsync(1);
  expect(build.stats.slices - before.slices).toBe(1);
});

it("R3 background walk-only slices charge zero measured WAL bytes", async () => {
  const db = longHistory();
  fillRecordKeysSlice(db, 10_000, { budgetMs: Infinity });
  const initial = wal();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  keys.setRecordKeysBudgetClock(() => Date.now());
  build = startRecordKeysBuild(db, { gate: null, admit: async () => {}, log: () => {}, targetMs: Infinity });
  let built;
  void build.done.then(value => { built = value; });
  for (let i = 0; i < 100 && built === undefined; i++) await vi.advanceTimersToNextTimerAsync();
  expect(built).toBe(true);
  expect(build.stats.keyed).toBe(40);
  expect(build.stats.bytes).toBe(wal() - initial);
});
