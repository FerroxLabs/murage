// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 startup (H12): the record-keys backfill reserved the 7-frame ceiling for every record, so a tick held 3 records and a
// 187k-record store needed days of app-open time to leave "preparing". Admission now reserves the measured WAL bytes per record
// from the last trusted slice. The witness drives startRecordKeysBuild (the production backfill runner) on a fake clock and counts
// records keyed in the same two minutes, while the WAL still grows no more than the allowance in any sliding minute. Synthetic data.
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { walFrameReader } from "../io-budget.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import * as keys from "./record-keys.ts";
import { dropRecordKeys, ensureRecordKeys, recordKeysReady } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const BUDGET = keys.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute;
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster({ bots: [{ id: "a", threadId: "ta" }], groups: [] }); keys.resetRecordKeysWriteBudget(); });
afterEach(() => { keys.resetRecordKeysWriteBudget(); vi.useRealTimers(); });

const idOf = (n: number) => { const h = createHash("sha256").update(`rk-${n}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

it("H12: the backfill reserves measured WAL bytes per record, so two minutes key well over twice what the 7-frame ceiling allows, within the allowance", { timeout: 600_000 }, async () => {
  const db = database(), scope = ensureScope("bot", "a");
  dropRecordKeys(db);
  const base = Date.UTC(2024, 0, 1);
  transaction(tx => {
    const add = tx.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement',?,?,?,NULL,NULL,?)");
    for (let n = 0; n < 20_000; n++) add.run(idOf(n), scope, `note ${n}`, "active", 0, base + n * 1000, base + n * 1000);
  });
  ensureRecordKeys(db);
  expect(recordKeysReady(db)).toBe(false);
  db.exec("PRAGMA wal_autocheckpoint=0");
  const file = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")!.file);
  const wal = walFrameReader(file);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: wal() }];
  const build = keys.startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: () => {} });
  const started = Date.now();
  let built = false;
  void build.done.then(value => { built = value; });
  while (!built && Date.now() - started < 120_000) { await vi.advanceTimersByTimeAsync(1000); samples.push({ at: Date.now(), bytes: wal() }); }
  build.stop(); await build.done;
  samples.push({ at: Date.now(), bytes: wal() });
  wal.close();
  let worst = 0;
  for (let i = 0, j = 0; i < samples.length; i++) {
    while (samples[i]!.at - samples[j]!.at >= 60_000) j++;
    worst = Math.max(worst, samples[i]!.bytes - samples[j]!.bytes);
  }
  const keyed = Number(db.prepare("SELECT count(*) AS n FROM memory_record_keys").get()?.n);
  // At the ceiling a tick admits floor((128 KiB - c) / c) = 3 records and two minutes of the allowance hold
  // 2 * 512 KiB / c = 37 records (c = 7 frames of 4 KiB pages).
  const ceilingTwoMinutes = Math.ceil(2 * BUDGET / keys.recordKeysCostCeiling(db));
  console.log(`[record-keys measured] keyed=${keyed} in 120 s, ceiling-rate bound=${ceilingTwoMinutes}, worst minute=${worst}, per-row now=${keys.recordKeysCostPerRow(db)}`);
  // the WAL allowance itself bounds the rate (a record costs about 2 frames on random keys); reserving 7 frames a record wasted over half of it
  expect(keyed, "records keyed in two minutes at the measured reservation").toBeGreaterThan(2.5 * ceilingTwoMinutes);
  expect(worst).toBeLessThanOrEqual(BUDGET);
});
