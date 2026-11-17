// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW 8v (r3.2 A13), controller side: the durable index stop and its reset in the main database (spec 1.13). The first reset is at
// once; from the second stop within 7 days the wait is 1 h doubling to 24 h; due_at is fixed when the stop is seen and a restart never
// moves it; the same stop seen again never counts twice; one receipt update per reset id. Restarts are a fresh read of the row.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { INDEX_OVERRUN_TABLE, ensureIndexOverrun } from "./schema.ts";
import { OVERRUN_K_UNKNOWN, resetMultiplier } from "./memw-steps.ts";
import { completeIndexReset, indexResetDue, indexResetPending, indexResetWaitMs, indexResetWakeAt, noteIndexStop } from "./worker-controller.ts";

const H = 3_600_000, D = 24 * H;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); });
afterEach(() => closeDatabase());
const row = () => database().prepare(`SELECT * FROM ${INDEX_OVERRUN_TABLE} WHERE id=1`).get() as Record<string, unknown>;
/** A restart: the connection goes and comes back, so nothing but the row carries over. */
const restart = () => { closeDatabase(); database(); };
/** A known, quiet history: a reset that completed more than 7 days ago, so the next stop is k = 1 (a missing row is an unknown history). */
const knownQuiet = (now: number) => {
  ensureIndexOverrun(database());
  database().prepare(`INSERT INTO ${INDEX_OVERRUN_TABLE}(id,resets,reset_id,state,due_at,kind,stop_file_id,stop_seq,last_stop_at) VALUES(1,1,7,'complete',?,'fill','old',1,?)`).run(now - 8 * D, now - 8 * D);
};

it("8v: four forced stops wait 0, 1 h, 2 h, 4 h; due_at survives restarts; the same stop is one increment; each reset completes once", () => {
  let now = Date.parse("2026-11-08T00:00:00Z");
  knownQuiet(now);
  const waits: number[] = [], resets: number[] = [];
  for (let k = 1; k <= 4; k++) {
    const stop = { fileId: `f${k}`, seq: 10 + k, kind: "fill" };
    expect(noteIndexStop(stop, now)).toBe(true);
    // the same stop seen three times (initialised, index-stop, a restart's initialised) is one increment
    expect(noteIndexStop(stop, now + 1)).toBe(false);
    restart();
    expect(noteIndexStop(stop, now + 2)).toBe(false);
    const due = Number(row().due_at);
    waits.push(due - now);
    expect(indexResetPending()).toBe(true);
    // a kill while it waits, and a restart between (1') and (1b): due_at is what it was
    if (due > now) { expect(indexResetDue(due - 1)).toBeNull(); restart(); expect(Number(row().due_at)).toBe(due); expect(indexResetDue(due - 1)).toBeNull(); }
    const request = indexResetDue(due)!;
    expect(request).not.toBeNull();
    expect(row().state).toBe("requested");
    restart();
    // resent at each start while requested: the same reset id and the same k
    expect(indexResetDue(due + 5)).toEqual(request);
    expect(request.kind).toBe("fill");
    resets.push(request.resets);
    // reset_done = R reported twice (a kill between reset_done and complete): the receipts are owed once
    expect(completeIndexReset(request.resetId + 1)).toBe("none");
    expect(completeIndexReset(request.resetId)).toBe("done");
    expect(completeIndexReset(request.resetId)).toBe("none");
    expect(row().state).toBe("complete");
    expect(indexResetPending()).toBe(false);
    now = due + 10 * 60_000;
  }
  expect(waits).toEqual([0, H, 2 * H, 4 * H]);
  // never frozen, never compounded: k counts the stops in the window, the sizer applies min(2^k, 8) from the shipped base
  expect(resets).toEqual([1, 2, 3, 4]);
});

it("8v: the wait caps at 24 h, and a stop more than 7 days after the last one starts again at k = 1", () => {
  let now = Date.parse("2026-11-08T00:00:00Z");
  knownQuiet(now);
  for (let k = 1; k <= 8; k++) { noteIndexStop({ fileId: "f", seq: k, kind: "merge" }, now); now += 60_000; }
  expect(Number(row().resets)).toBe(8);
  expect(Number(row().due_at) - (now - 60_000)).toBe(D);
  expect(indexResetWaitMs(7)).toBe(D);
  noteIndexStop({ fileId: "g", seq: 1, kind: "merge" }, now + 7 * D + 1);
  expect(Number(row().resets)).toBe(1);
  expect(Number(row().due_at)).toBe(now + 7 * D + 1);
});

it("8v: one receipt update per reset id, in the same transaction as complete", () => {
  database().exec("CREATE TABLE IF NOT EXISTS memory_projection_receipts_probe(n INTEGER)");
  const now = Date.now();
  noteIndexStop({ fileId: "f", seq: 1, kind: "group" }, now);
  const r = indexResetDue(now)!;
  let updates = 0;
  const original = database().prepare.bind(database());
  const db = database() as unknown as { prepare: (sql: string) => unknown };
  db.prepare = (sql: string) => { if (sql.startsWith("UPDATE memory_projection_receipts")) updates++; return original(sql); };
  try { expect(completeIndexReset(r.resetId)).toBe("done"); expect(completeIndexReset(r.resetId)).toBe("none"); }
  finally { db.prepare = original as never; }
  expect(updates).toBe(1);
});

it("8v: a missing row is an unknown history, never no overruns: the first stop is k = OVERRUN_K_UNKNOWN (multiplier 8) at once, the next in 7 d k + 1", () => {
  const now = Date.parse("2026-11-08T00:00:00Z");
  expect(OVERRUN_K_UNKNOWN).toBe(3);
  expect(noteIndexStop({ fileId: "f", seq: 1, kind: "fill" }, now)).toBe(true);
  expect(Number(row().resets)).toBe(OVERRUN_K_UNKNOWN);
  expect(Number(row().due_at)).toBe(now);
  const request = indexResetDue(now)!;
  expect(request.resets).toBe(OVERRUN_K_UNKNOWN);
  expect(resetMultiplier(request.resets)).toBe(8);
  expect(completeIndexReset(request.resetId)).toBe("done");
  expect(noteIndexStop({ fileId: "g", seq: 2, kind: "fill" }, now + 60_000)).toBe(true);
  expect(Number(row().resets)).toBe(OVERRUN_K_UNKNOWN + 1);
  expect(Number(row().due_at) - (now + 60_000)).toBe(indexResetWaitMs(OVERRUN_K_UNKNOWN + 1));
});

it("8v control: a fresh install with no stop forms no reset and holds nothing (the normal fill path never reads the table's absence)", () => {
  const now = Date.now();
  for (const later of [0, 50, 60_000, 8 * D]) expect(indexResetDue(now + later)).toBeNull();
  expect(indexResetPending()).toBe(false);
  expect(indexResetWakeAt()).toBeNull();
  expect(row()).toBeUndefined();
});

for (const fileId of ["9007199254740993", "9223372036854775807", "18446744073709551615"]) {
  it(`a real unsigned file id ${fileId} survives restart and deduplicates exactly`, () => {
    const stop = { fileId, seq: 31, kind: "fill" };
    expect(noteIndexStop(stop)).toBe(true);
    expect(row().stop_file_id).toBe(fileId);
    restart();
    expect(noteIndexStop(stop)).toBe(false);
    expect(row().stop_file_id).toBe(fileId);
    expect(database().prepare("SELECT typeof(stop_file_id) AS t FROM index_overrun").get()!.t).toBe("text");
  });
}

it("migrates a pre-release INTEGER stop column without reading its 64-bit value as a number", () => {
  const db = database();
  db.exec("DROP TABLE IF EXISTS index_overrun; CREATE TABLE index_overrun(id INTEGER PRIMARY KEY CHECK(id=1),resets INTEGER NOT NULL,reset_id INTEGER,state TEXT,due_at INTEGER,kind TEXT,stop_file_id INTEGER,stop_seq INTEGER,last_stop_at INTEGER)");
  db.exec("INSERT INTO index_overrun VALUES(1,3,7,'waiting',10,'fill',9223372036854775807,31,10)");
  ensureIndexOverrun(db);
  expect(row().stop_file_id).toBe("9223372036854775807");
  expect(noteIndexStop({fileId:"9223372036854775807",seq:31,kind:"fill"})).toBe(false);
  expect(row().reset_id).toBe(7);
});
