// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rehearsal: the record-keys backfill wrote 1,190 MB/min and 1,138 MB/min in the first minute after 1.0.3 started on a store whose
// derived key table "Prepare to reinstall 1.0.2" had dropped. It now runs under the maintenance write budget (revoke-budget.ts's figure,
// 20 MB a sliding minute). And while the keys are missing or partial, every owner read (browse, search, each view) answers exactly as it
// does with no key table at all (owner-list.ts preparing mode): no read depends on the keys until the backfill is done. Synthetic data only.
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
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
const BUDGET = 20 * 1024 * 1024;
type Budgeted = { RECORD_KEYS_WRITE_BUDGET?: { bytesPerMinute: number }; resetRecordKeysWriteBudget?: () => void };
const budgeted = keys as unknown as Budgeted;
const keep = budgeted.RECORD_KEYS_WRITE_BUDGET ? { ...budgeted.RECORD_KEYS_WRITE_BUDGET } : null;
beforeEach(() => { closeMemoryIndexReader(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); budgeted.resetRecordKeysWriteBudget?.(); });
afterEach(() => { if (keep) Object.assign(budgeted.RECORD_KEYS_WRITE_BUDGET!, keep); budgeted.resetRecordKeysWriteBudget?.(); });

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

it("a rebuild of 200,000 records stays within 20 MB in every sliding minute, and logs its start and end", { timeout: 900_000 }, async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(200_000, [scope]);
  expect(recordKeysReady(db)).toBe(false);
  db.exec("PRAGMA wal_autocheckpoint=0");  // the log only grows: its frame count is every byte written
  const file = String((db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main")!.file);
  const wal = walFrameReader(file);
  const samples: Array<{ at: number; bytes: number }> = [{ at: Date.now(), bytes: wal() }];
  const lines: string[] = [];
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: line => lines.push(line) });
  const RUN_MS = Number(process.env.RECORD_KEYS_BUDGET_RUN_MS ?? 75_000);
  const started = Date.now();
  let built = false;
  void build.done.then(value => { built = value; });
  while (!built && Date.now() - started < RUN_MS) {
    await new Promise(resolve => setTimeout(resolve, 25));
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
  console.log(`[record-keys budget] keyed=${keyed}/200000 in ${elapsed.toFixed(1)} s, written=${(total / 1048576).toFixed(1)} MB, worst minute=${(worst / 1048576).toFixed(1)} MB, ${perRow.toFixed(0)} B/record; at 20 MB/min: 200k ~${(200_000 * perRow / BUDGET).toFixed(1)} min`);
  expect(keyed).toBeGreaterThan(0);
  // the budget, and at most one slice's excess over its estimate (C is measured from the first slices on)
  expect(worst).toBeLessThanOrEqual(BUDGET * 1.1);
  expect(lines[0]).toMatch(/^\[memory\] record keys rebuild started: about 200000 records to key, budget 20\.0 MB\/min$/);
});

it("estimate (RECORD_KEYS_ESTIMATE_ROWS): WAL bytes a whole rebuild writes, and its duration at 20 MB/min", { timeout: 3_600_000 }, async () => {
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
  console.log(`[record-keys estimate] rows=${rows} unbudgeted ${s.toFixed(1)} s, ${(build.stats.bytes / 1048576).toFixed(1)} MB, ${(build.stats.bytes / rows).toFixed(0)} B/record, at 20 MB/min ~${(build.stats.bytes / BUDGET).toFixed(1)} min`);
  console.log(lines.join("\n"));
});

it("the rebuild's end line names the records keyed, MB written and duration, and no record content", async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(3000, [scope]);
  const lines: string[] = [];
  const build = startRecordKeysBuild(db, { gate: null, busy: () => false, admit: async () => {}, log: line => lines.push(line), pauseMs: 1 });
  expect(await build.done).toBe(true);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\[memory\] record keys rebuild started: about 3000 records to key, budget 20\.0 MB\/min$/);
  expect(lines[1]).toMatch(/^\[memory\] record keys rebuild done: 3000 records keyed, \d+\.\d MB written, \d+\.\d s, \d+ slices, \d+ budget waits$/);
  expect(lines.join("\n")).not.toMatch(/note\d|pipeline|renewals|hiring|weekly|client|report|review|launch|design/);
});

it("a minute with no room makes the next slice wait, and none runs until the window has room again", async () => {
  const db = database(), scope = ensureScope("bot", "a");
  history(3000, [scope]);
  budgeted.RECORD_KEYS_WRITE_BUDGET!.bytesPerMinute = 64 * keys.recordKeysCostCeiling(db) * 2;  // room for about two least slices
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
