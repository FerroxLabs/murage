// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rehearsal: the record-keys backfill wrote 1,190 MB/min and 1,138 MB/min in the first minute after 1.0.3 started on a store whose
// derived key table "Prepare to reinstall 1.0.2" had dropped. It now runs under half the idle write allowance, with a fixed per-tick
// reservation cap. While keys are missing or partial, every owner read (browse, search, each view) answers exactly as with no key table (owner-list.ts preparing mode): no read depends on the keys until the backfill is done. Synthetic data only.
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { walFrameReader } from "../io-budget.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { ownerMemoryList, type OwnerListInput } from "./owner-list.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import * as keys from "./record-keys.ts";
import { fillRecordKeysNow, fillRecordKeysSlice, startRecordKeysBuild } from "./record-keys.ts";
import { dropRecordKeys, ensureRecordKeys, recordKeysPresent, recordKeysReady } from "./schema.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster = { bots: [{ id: "a", threadId: "ta" }, { id: "b", threadId: "tb" }], groups: [] };
const BUDGET = keys.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute;
type Budgeted = { RECORD_KEYS_WRITE_BUDGET?: { bytesPerMinute: number }; resetRecordKeysWriteBudget?: () => void };
const budgeted = keys as unknown as Budgeted;
const keep = budgeted.RECORD_KEYS_WRITE_BUDGET ? { ...budgeted.RECORD_KEYS_WRITE_BUDGET } : null;
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); budgeted.resetRecordKeysWriteBudget?.(); });
afterEach(() => { if (keep) Object.assign(budgeted.RECORD_KEYS_WRITE_BUDGET!, keep); budgeted.resetRecordKeysWriteBudget?.(); vi.useRealTimers(); });

/** Record ids as the app makes them (random UUIDs: the key table's primary key takes them in no order). */
const idOf = (n: number) => { const h = createHash("sha256").update(`rec-${n}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const STATES = ["active", "active", "active", "candidate", "archived"];
const WORDS = ["pipeline", "renewals", "hiring", "weekly", "client", "report", "budget", "review", "launch", "design"];
/** `count` records written as an older build left them: no key table (the "Prepare to reinstall 1.0.2" drop), then the table made empty. */
function history(count: number, scopes: string[], options: { sameMs?: boolean } = {}): void {
  const db = database();
  dropRecordKeys(db);
  const base = Date.UTC(2024, 0, 1);
  for (let from = 0; from < count; from += 20_000) transaction(tx => {
    const add = tx.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement',?,?,?,NULL,NULL,?)");
    for (let n = from; n < Math.min(count, from + 20_000); n++) {
      const at = options.sameMs ? base : base + n * 1000;
      add.run(idOf(n), scopes[n % scopes.length], `${WORDS[n % 10]} ${WORDS[(n * 7) % 10]} note${n}`, STATES[n % 5], n % 97 === 0 ? 1 : 0, at, at);
    }
  });
  ensureRecordKeys(db);
}

it("a rebuild of 200,000 records stays within the idle allowance in every sliding minute, and logs its start and end", { timeout: 900_000 }, async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(200_000, [scope]);
  expect(recordKeysReady(db)).toBe(false);
  db.exec("PRAGMA wal_autocheckpoint=0");  // the log only grows: its frame count is every byte written
  const file = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")!.file);
  const wal = walFrameReader(file);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: wal() }];
  const lines: string[] = [];
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: line => lines.push(line) });
  const RUN_MS = Number(process.env.RECORD_KEYS_BUDGET_RUN_MS ?? 125_000);
  const started = Date.now();
  let built = false;
  void build.done.then(value => { built = value; });
  while (!built && Date.now() - started < RUN_MS) {
    await vi.advanceTimersByTimeAsync(1000);
    samples.push({ at: Date.now(), bytes: wal() });
  }
  build.stop();
  await build.done;
  samples.push({ at: Date.now(), bytes: wal() });
  wal.close();
  // the most written in any 60 s
  let worst = 0;
  for (let i = 0, j = 0; i < samples.length; i++) {
    while (samples[i]!.at - samples[j]!.at > 60_000) j++;
    worst = Math.max(worst, samples[i]!.bytes - samples[j]!.bytes);
  }
  const keyed = Number(db.prepare("SELECT count(*) AS n FROM memory_record_keys").get()?.n);
  const elapsed = (Date.now() - started) / 1000;
  const total = samples.at(-1)!.bytes - samples[0]!.bytes;
  const perRow = keyed ? total / keyed : 0;
  console.log(`[record-keys budget] keyed=${keyed}/200000 in ${elapsed.toFixed(1)} s, written=${(total / 1048576).toFixed(1)} MB, worst minute=${(worst / 1048576).toFixed(1)} MB, ${perRow.toFixed(0)} B/record; at 0.5 MB/min: 200k ~${(200_000 * perRow / BUDGET).toFixed(1)} min`);
  expect(keyed).toBeGreaterThan(0);
  // Measured WAL writes stay within the allowance in every sampled sliding minute.
  expect(worst).toBeLessThanOrEqual(BUDGET);
  expect(lines[0]).toMatch(/^\[memory\] record keys rebuild started: about 200000 records to key, budget 0\.5 MB\/min$/);
});

it("estimate (RECORD_KEYS_ESTIMATE_ROWS): WAL bytes a whole rebuild writes, and its duration at the idle allowance", { timeout: 3_600_000 }, async () => {
  const rows = Number(process.env.RECORD_KEYS_ESTIMATE_ROWS ?? 0);
  if (!rows || !budgeted.RECORD_KEYS_WRITE_BUDGET) return;
  const db = database(), scope = ensureScope("bot", "a"), other = ensureScope("bot", "b");
  history(rows, [scope, scope, scope, other]);
  budgeted.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = Number.MAX_SAFE_INTEGER;  // unbounded: the bytes the same slices write
  const lines: string[] = [];
  const started = performance.now();
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: line => lines.push(line) });
  expect(await build.done).toBe(true);
  const s = (performance.now() - started) / 1000;
  console.log(`[record-keys estimate] rows=${rows} unbudgeted ${s.toFixed(1)} s, ${(build.stats.bytes / 1048576).toFixed(1)} MB, ${(build.stats.bytes / rows).toFixed(0)} B/record, at 0.5 MB/min ~${(build.stats.bytes / BUDGET).toFixed(1)} min`);
  console.log(lines.join("\n"));
});

it("estimate (RECORD_KEYS_SIM_ROWS): a whole rebuild under the idle budget on a simulated clock: bytes per record and its duration", { timeout: 3_600_000 }, async () => {
  const rows = Number(process.env.RECORD_KEYS_SIM_ROWS ?? 0);
  if (!rows) return;
  const db = database(), scope = ensureScope("bot", "a"), other = ensureScope("bot", "b");
  history(rows, [scope, scope, scope, other]);
  // the budget's waits pass on a simulated clock; the slices themselves run (and are timed) in real time
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const t0 = Date.now(), real = performance.now();
    const targetMs = Number(process.env.RECORD_KEYS_SIM_TARGET_MS ?? keys.RECORD_KEYS_SLICE_TARGET_MS);
    const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: () => {}, targetMs });
    let built: boolean | null = null;
    void build.done.then(value => { built = value; });
    while (built === null) await vi.advanceTimersByTimeAsync(1000);
    expect(built).toBe(true);
    const minutes = (Date.now() - t0) / 60_000, bytes = build.stats.bytes;
    console.log(`[record-keys sim] rows=${rows} target=${targetMs} ms, longest slice ${build.stats.maxSliceMs.toFixed(1)} ms, budgeted: ${(bytes / 1048576).toFixed(1)} MB, ${(bytes / rows).toFixed(0)} B/record, ${build.stats.slices} slices (${(rows / build.stats.slices).toFixed(0)} records/slice), simulated ${minutes.toFixed(1)} min (${(bytes / 1048576 / minutes).toFixed(1)} MB/min), real ${((performance.now() - real) / 1000).toFixed(1)} s`);
  } finally { vi.useRealTimers(); }
});

it("the rebuild's end line names the records keyed, MB written and duration, and no record content", async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(3000, [scope]);
  const lines: string[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: line => lines.push(line), pauseMs: 1 });
  let built: boolean | undefined;
  void build.done.then(value => { built = value; });
  for (let minute = 0; minute < 1000 && built === undefined; minute++) await vi.advanceTimersByTimeAsync(60_000);
  build.stop();
  expect(built).toBe(true);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\[memory\] record keys rebuild started: about 3000 records to key, budget 0\.5 MB\/min$/);
  expect(lines[1]).toMatch(/^\[memory\] record keys rebuild done: 3000 records keyed, \d+\.\d MB written, \d+\.\d s, \d+ slices, \d+ budget waits$/);
  expect(lines.join("\n")).not.toMatch(/note\d|pipeline|renewals|hiring|weekly|client|report|review|launch|design/);
});

it("a minute with no room makes the next slice wait, and none runs until the window has room again", async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(3000, [scope]);
  budgeted.RECORD_KEYS_WRITE_BUDGET!.bytesPerMinute = 16 * keys.recordKeysCostCeiling(db);  // a few bounded commits, then a budget wait
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: () => {}, pauseMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 1500));
  build.stop(); await build.done;
  expect(recordKeysReady(db)).toBe(false);
  expect(build.stats.budgetWaits).toBeGreaterThan(0);
  expect(keys.recordKeysBytesWritten()).toBeLessThanOrEqual(budgeted.RECORD_KEYS_WRITE_BUDGET!.bytesPerMinute * 1.1);
});

// Condition 1 (MurageMain): what the owner's reads do while the keys are missing or partial.
async function everyRead(): Promise<unknown[]> {
  const inputs: OwnerListInput[] = [
    { botId: "a" }, { botId: "a", view: "recent" }, { botId: "a", view: "important" }, { botId: "a", view: "review" }, { botId: "a", state: "archived" },
    { botId: "a", query: "pipeline" }, { botId: "a", query: "hiring report" }, { botId: "a", query: "note1234" }, { botId: "a", view: "review", query: "client" },
    { botId: "b" }, { botId: "b", query: "launch" },
  ];
  const out: unknown[] = [];
  for (const input of inputs) {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 80; page++) {
      const got = await ownerMemoryList({ ...input, ...(cursor ? { cursor } : {}) }, roster);
      pages.push({ ids: got.rows.map(row => row.id), mode: got.searchMode, notice: got.searchNotice ?? null, complete: got.coverageComplete ?? null, count: got.matchCount ?? null });
      cursor = got.nextCursor; if (!cursor) break;
    }
    out.push({ input, pages });
  }
  return out;
}
const idsOnly = (reads: unknown[]) => (reads as Array<{ pages: Array<{ ids: string[] }> }>).map(read => read.pages.flatMap(page => page.ids));

it("condition 1: with keys partial, every browse, search and view answers exactly as with no key table, and lists what a keyed store lists", { timeout: 120_000 }, async () => {
  const db = database(), a = ensureScope("bot", "a"), b = ensureScope("bot", "b");
  history(3000, [a, a, b]);
  dropRecordKeys(db);
  expect(recordKeysPresent(db)).toBe(false);
  const absent = await everyRead();
  ensureRecordKeys(db);
  const empty = await everyRead();
  expect(empty).toEqual(absent);
  for (const rows of [100, 700, 1200]) {
    fillRecordKeysSlice(db, rows, { budgetMs: Number.POSITIVE_INFINITY });
    expect(recordKeysReady(db)).toBe(false);
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_record_keys").get()?.n)).toBeGreaterThan(0);
    expect(await everyRead()).toEqual(absent);
  }
  // a record written mid-backfill is keyed by its trigger and read the same way as before
  db.prepare("INSERT INTO memory_records VALUES('late',1,?,'fact','pipeline late note','owner-statement','active',0,?,NULL,NULL,?)").run(a, Date.UTC(2030, 0, 1), Date.UTC(2030, 0, 1));
  const partialLate = await everyRead();
  dropRecordKeys(db);
  expect(await everyRead()).toEqual(partialLate);
  ensureRecordKeys(db);
  fillRecordKeysSlice(db, 500, { budgetMs: Number.POSITIVE_INFINITY });
  // and once every key is there the same records come back, browse in the same order (distinct timestamps)
  fillRecordKeysNow(db);
  expect(recordKeysReady(db)).toBe(true);
  const ready = idsOnly(await everyRead()), before = idsOnly(partialLate);
  for (let i = 0; i < ready.length; i++) {
    if (i < 5 || i === 9) expect(ready[i]).toEqual(before[i]);
    else expect(new Set(ready[i])).toEqual(new Set(before[i]));
  }
});

it("R7 admission properties: one formula, exact releases, debt, bounded ledger and eventual progress", () => {
  expect(typeof keys.recordKeysAdmission).toBe("function");
  expect(typeof keys.chargeRecordKeysWriteForTest).toBe("function");
  let seed = 0x1019;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (const pageSize of [4096, 16_384, 32_768, 65_536]) {
    // Pure admission fixture: frameBytes needs only the PRAGMA, no real database or timers.
    const db = { prepare: () => ({ get: () => ({ page_size: pageSize }) }) } as unknown as Parameters<typeof keys.recordKeysAdmission>[0];
    const per = keys.recordKeysCostPerRow(db), unit = 2 * per;
    for (const budget of [65_536, 262_144, 524_288, 2 * 1024 * 1024]) {
      keys.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = budget;
      for (let sequence = 0; sequence < 200; sequence++) {
        keys.resetRecordKeysWriteBudget();
        let now = 1000, model: Array<{ bytes: number; until: number }> = [];
        for (let step = 0; step < 16; step++) {
          now += Math.floor(random() * 20_000);
          model = model.filter(c => c.until > now);
          const used = model.reduce((sum, c) => sum + c.bytes, 0);
          const a = keys.recordKeysAdmission(db, now);
          expect(keys.recordKeysRoom(db, now)).toBe(a.rows);
          expect(keys.recordKeysWriteWaitMs(db, now)).toBe(a.waitMs);
          expect(a.oversized).toBe(unit > budget);
          if (a.rows === 0) {
            expect(a.waitMs).toBeGreaterThanOrEqual(1);
            const releases = [...new Set(model.map(c => c.until))].sort((x, y) => x - y);
            const until = releases.find(t => unit > budget ? model.every(c => c.until <= t) : model.filter(c => c.until > t).reduce((n, c) => n + c.bytes, 0) + unit <= budget)!;
            expect(a.waitMs).toBe(until - now);
            now += a.waitMs;
            expect(keys.recordKeysAdmission(db, now).rows).toBeGreaterThanOrEqual(1);
            model = model.filter(c => c.until > now);
          } else {
            expect(a.waitMs).toBe(0);
            if (a.oversized) { expect(a.rows).toBe(1); expect(used).toBe(0); }
            else {
              expect(used + a.rows * per + per).toBeLessThanOrEqual(budget);
              expect(a.rows * per + per).toBeLessThanOrEqual(Math.max(keys.RECORD_KEYS_SLICE_WRITE_BYTES, unit));
              expect(used + (a.rows + 1) * per + per > budget || (a.rows + 1) * per + per > Math.max(keys.RECORD_KEYS_SLICE_WRITE_BYTES, unit)).toBe(true);
            }
            const bytes = Math.ceil((1 + Math.floor(random() * a.rows) + 1) * per * (1 + random()));
            const ledger = keys.chargeRecordKeysWriteForTest(bytes, now);
            model.push({ bytes, until: now + 60_000 * Math.max(1, Math.ceil(bytes / budget)) });
            expect(ledger.length).toBeLessThanOrEqual(Math.ceil(budget / unit) + 2);
          }
        }
      }
    }
  }
});

it("R7 I15 ledger has the exact constant bound under adversarial admitted charge sequences", () => {
  for (const pageSize of [4096, 16_384, 32_768, 65_536]) {
    const db = { prepare: () => ({ get: () => ({ page_size: pageSize }) }) } as unknown as Parameters<typeof keys.recordKeysAdmission>[0];
    const frame = pageSize + 24, per = keys.recordKeysCostPerRow(db), unit = 2 * per;
    for (const minimum of [frame, per]) {
      for (const budget of [unit - 1, unit, unit + minimum - 1, unit + minimum, 524_288, 2 * 1024 * 1024]) {
        keys.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = budget;
        const bound = Math.max(1, Math.floor((budget - unit) / minimum) + 1);
        if (pageSize === 4096 && budget === 524_288) {
          expect(per).toBe(28_840); expect(unit).toBe(57_680);
          expect(bound).toBe(minimum === per ? 17 : 114);
        }
        // Tight witness: distinct timestamps prevent merging; the final admitted write may overshoot arbitrarily.
        for (const lastBytes of [minimum, 8 * budget + minimum]) {
          keys.resetRecordKeysWriteBudget();
          let ledger: ReturnType<typeof keys.chargeRecordKeysWriteForTest> = [];
          for (let i = 0; i <= bound; i++) {
            if (!keys.recordKeysAdmission(db, 1000 + i).rows) break;
            ledger = keys.chargeRecordKeysWriteForTest(i === bound - 1 ? lastBytes : minimum, 1000 + i);
            expect(ledger.length).toBeLessThanOrEqual(bound);
          }
          expect(ledger).toHaveLength(bound);
          expect(keys.recordKeysAdmission(db, 1000 + bound).rows).toBe(0);
        }
        // Seeded properties include sub-reservation writes, zeros, merges, varying debt and expiry boundaries.
        for (let sequence = 1; sequence <= 32; sequence++) {
          keys.resetRecordKeysWriteBudget();
          let seed = sequence, now = 1000;
          const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
          for (let step = 0; step < 128; step++) {
            now += [0, 0, 1, 5, 59_999, 60_000, 60_001][random() % 7]!;
            let admission = keys.recordKeysAdmission(db, now);
            if (!admission.rows) {
              // Probe just before release, then release exactly; earlier entries may still hold long debt.
              expect(keys.recordKeysAdmission(db, now + admission.waitMs - 1).rows).toBe(0);
              now += admission.waitMs;
              admission = keys.recordKeysAdmission(db, now);
              expect(admission.rows).toBeGreaterThan(0);
            }
            const choices = [0, minimum, minimum, per, unit, budget, budget + minimum, 8 * budget + minimum];
            const bytes = choices[random() % choices.length]!;
            const ledger = keys.chargeRecordKeysWriteForTest(bytes, now);
            expect(ledger.length).toBeLessThanOrEqual(bound);
          }
        }
      }
    }
  }
});

it("R7 a 4 MiB charge holds eight minutes of debt; same-time differing debts release independently", () => {
  expect(typeof keys.chargeRecordKeysWriteForTest).toBe("function");
  const db = database(), now = 1000;
  keys.RECORD_KEYS_WRITE_BUDGET.bytesPerMinute = 524_288;
  keys.chargeRecordKeysWriteForTest(4 * 1024 * 1024, now);
  expect(keys.recordKeysAdmission(db, now).rows).toBe(0);
  expect(keys.recordKeysWriteWaitMs(db, now)).toBe(8 * 60_000);
  expect(keys.recordKeysWriteWaitMs(db, now + 8 * 60_000 - 1)).toBe(1);
  expect(keys.recordKeysRoom(db, now + 8 * 60_000)).toBeGreaterThan(0);
  keys.resetRecordKeysWriteBudget();
  keys.chargeRecordKeysWriteForTest(4 * 1024 * 1024, now);
  keys.chargeRecordKeysWriteForTest(1000, now);
  expect(keys.recordKeysBytesWritten(now + 60_000)).toBe(4 * 1024 * 1024);
  expect(keys.recordKeysWriteWaitMs(db, now + 60_000)).toBe(7 * 60_000);
});
