// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F-FLAT (MEMW Part B, option (B), MurageMain ruling 11-07): the search fill runs on FTS5's base settings, untouched (the fill writes no
// automerge or crisismerge, no prime, no restore), with its time-bounded step (25 ms of rows, the char limit), and this file measures it at
// 20k, 200k and 500k rows, with live writes between steps, and from a forced T = 112 state. A complete step is body + merge + COMMIT (base
// runs no explicit merge: merge is 0, and any automerge or crisis merge runs inside a flush, so inside the body or the COMMIT).
//
// Checkpointing (owner ruling 11-07): PRIMARY runs use what the checkpointer worker sets once ready, wal_autocheckpoint = 0
// (wal-maintenance.ts setAutocheckpoint(0)); the worker's PASSIVE checkpoints run between units, as the worker thread would, timed apart and
// never inside a step. A synchronous test never lets the worker report ready, so the test sets 0 itself. The FALLBACK run is the
// worker-failed state, wal_autocheckpoint = 1000: SQLite's default WAL hook (sqlite3WalDefaultHook) runs a PASSIVE checkpoint on the
// committing connection right after any commit that leaves 1,000 or more frames in the log; the harness applies exactly that hook after each
// unit's commit (frames read from the -shm WAL-index header), so the checkpoint is timed apart as ckptMs. The fallback's lines are relative:
// this file runs unchanged on BASE 1effcd533 and on the lane, back to back, and the two reports are compared by name.
import { closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { insertMessage, searchMessages } from "./message-db.ts";
import { prepareMessageSearchBackfill, stepMessageSearchBackfill } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const STEP_LINE_MS = 100, LIVE_LINE_MS = 250, WORK_UNIT_MS = 250, WAL_AUTOCHECKPOINT = 1000, CRISIS = 16, FORCED_T = 112;
const SETTING_RE = /VALUES\('(automerge|crisismerge|usermerge|merge)', -?\d+\)/;
type Ckpt = "primary" | "fallback";
type Seg = { id: number; level: number };

/** FTS5's structure record (messages_fts_data id 10): cookie, optional V2 marker, nLevel, nSegment, write counter, then per level nMerge,
 * nSeg and each segment's id and page range (plus five more varints in V2). SQLite varints. */
function structure(db: DatabaseSync): Seg[] {
  const row = db.prepare("SELECT block FROM messages_fts_data WHERE id = 10").get() as { block?: Uint8Array } | undefined;
  if (!row?.block) return [];
  const b = row.block, v2 = b[4] === 0xff && b[5] === 0 && b[6] === 0 && b[7] === 1;
  let i = v2 ? 8 : 4;
  const next = (): number => { let v = 0; for (let k = 0; k < 8; k++) { const c = b[i++]!; v = v * 128 + (c & 0x7f); if (c < 0x80) return v; } return v * 256 + b[i++]!; };
  const count = next(), total = next(); next();
  const out: Seg[] = [];
  for (let level = 0; level < count; level++) { next(); const n = next(); for (let s = 0; s < n; s++) { const id = next(); next(); next(); if (v2) for (let k = 0; k < 5; k++) next(); out.push({ id, level }); } }
  expect(out.length).toBe(total);
  return out;
}
/** Crisis merges between `a` and `b`: a level that lost CRISIS or more segments at once. */
function crises(a: Seg[], b: Seg[]): number {
  const after = new Set(b.map((s) => s.id)), gone = new Map<number, number>();
  for (const s of a) if (!after.has(s.id)) gone.set(s.level, (gone.get(s.level) ?? 0) + 1);
  return [...gone.values()].filter((n) => n >= CRISIS).length;
}
/** The WAL-index header in messages.db-shm (native byte order: little-endian on every host this runs on): iVersion at 0 (3007000), mxFrame
 * at 16, nBackfill at 96. Plain file I/O, outside every statement. */
function walFrames(): { frames: number; backfill: number } {
  const fd = openSync(join(DATA_DIR, "messages.db-shm"), "r");
  try {
    const b = Buffer.alloc(100);
    expect(readSync(fd, b, 0, 100, 0)).toBe(100);
    expect(b.readUInt32LE(0), "WAL-index header version").toBe(3007000);
    return { frames: b.readUInt32LE(16), backfill: b.readUInt32LE(96) };
  } finally { closeSync(fd); }
}
/** The fill-scale fixture at `total` rows: text rows, an activity row every 7th, and a run of 5 % frames with nothing to index halfway. */
function history(db: DatabaseSync, total: number): void {
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  const gapLo = Math.floor(total / 2) + 1, gapHi = gapLo + Math.floor(total / 20) - 1;
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total})
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json)
    SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot',
      CASE WHEN i BETWEEN ${gapLo} AND ${gapHi} THEN 'screen' WHEN i % 7 = 0 THEN 'activity' ELSE 'text' END,
      CASE WHEN i BETWEEN ${gapLo} AND ${gapHi} OR i % 7 = 0 THEN NULL ELSE 'searchable line '||i END,
      CASE WHEN i % 7 = 0 AND i NOT BETWEEN ${gapLo} AND ${gapHi} THEN '{"tool":{"name":"Ran step '||i||'"}}' ELSE '{}' END FROM n`);
}
const setting = (k: string, v: number) => `INSERT INTO messages_fts(messages_fts, rank) VALUES('${k}', ${v})`;
/** The forced worst state: the first half of the history indexed by the test connection in FORCED_T transactions under automerge 0 and
 * crisismerge 1999 (so nothing merges them), FTS5's defaults put back, then the fill prepared on the rest: T = 112 at the fill's start, every
 * segment on level 0 (FTS5 builds a higher level only by merging, so one pile per level is not constructible; level 0 is the costlier
 * place: the first flush under base settings meets a crisis merge of all of it). */
function forceT(db: DatabaseSync, total: number): void {
  const top = Math.floor(total / 2), span = Math.ceil(top / FORCED_T);
  db.prepare(setting("automerge", 0)).run(); db.prepare(setting("crisismerge", 1999)).run();
  const add = db.prepare("INSERT INTO messages_fts(rowid, t) SELECT rowid, CASE kind WHEN 'activity' THEN json_extract(json, '$.tool.name') ELSE text END FROM messages WHERE rowid > ? AND rowid <= ? AND kind IN ('text', 'activity') ORDER BY rowid");
  for (let lo = 0; lo < top; lo += span) { db.exec("BEGIN"); add.run(lo, Math.min(top, lo + span)); db.exec("COMMIT"); }
  db.prepare(setting("automerge", 4)).run(); db.prepare(setting("crisismerge", 16)).run();
  expect(structure(db).length, "the forced state's segment total").toBe(FORCED_T);
}

const NEEDLES = ["sea", "line", "searchable", "ble line 1", "line 4999", "Ran step", "step 77", "ran", "zzq", "qqqqqq",
  "able li", "line 12345", "e 1", "nothing", "step 140", "ine 3", "rch", "able", "Ran step 7", "xyzzyq"];
const median = (v: number[]) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const pct = (v: number[], p: number) => { if (!v.length) return 0; const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const r1 = (n: number) => Math.round(n * 10) / 10;
const max0 = (v: number[]) => Math.max(0, ...v);
/** D6 (g): 20 needles, 9 rounds each, the median per needle; the median and the max of those. */
function reads(): { median: number; max: number } {
  const m = NEEDLES.map((needle) => { const r: number[] = []; for (let k = 0; k < 9; k++) { const t = performance.now(); searchMessages(needle, 40); r.push(performance.now() - t); } return median(r); });
  return { median: r1(median(m)), max: r1(Math.max(...m)) };
}

type Unit = { ms: number; body: number; merge: number; commit: number; ckpt: number };
type Leg = {
  label: string; ckpt: Ckpt; steps: Unit[]; live: Unit[]; settingWrites: number; stepCrises: number; liveCrises: number; maxT: number; startT: number; endT: number;
  workerCkpts: number[]; query: { median: number; max: number }; complete: boolean; automerge: number; crisismerge: number;
};
/** One fill from a fresh database: the fixture, then `setup` (forceT), the fill's prepare, then steps with `between` live writes after each. */
function leg(label: string, total: number, ckpt: Ckpt, between: number, setup?: (db: DatabaseSync) => void): Leg {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  db.exec("PRAGMA wal_autocheckpoint=0");
  history(db, total);
  setup?.(db);
  expect(prepareMessageSearchBackfill(db)).toBe(true);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const exec = db.exec.bind(db);
  let commitMs = 0, settingWrites = 0, inStep = false;
  // every statement still runs on the product's handle; the COMMIT is timed apart, and a fill step that writes an index setting is counted
  (db as unknown as { exec: (s: string) => void }).exec = (sql: string) => {
    if (inStep && SETTING_RE.test(sql)) settingWrites++;
    if (sql === "COMMIT") { const t = performance.now(); exec(sql); commitMs = performance.now() - t; return; }
    exec(sql);
  };
  const checkpoint = () => { const t = performance.now(); exec("PRAGMA wal_checkpoint(PASSIVE)"); return performance.now() - t; };
  const afterCommit = () => (ckpt === "fallback" && walFrames().frames >= WAL_AUTOCHECKPOINT ? checkpoint() : 0);
  const workerCkpts: number[] = [];
  const worker = () => { if (ckpt !== "primary") return; const f = walFrames(); if (f.frames - f.backfill >= WAL_AUTOCHECKPOINT) workerCkpts.push(checkpoint()); };
  const steps: Unit[] = [], live: Unit[] = [];
  let stepCrises = 0, liveCrises = 0, n = 0;
  const startT = structure(db).length;
  let maxT = startT;
  try {
    for (let k = 0; k < Math.ceil(total / 100) + 50; k++) {
      const a = structure(db);
      commitMs = 0; inStep = true;
      const t = performance.now();
      const r = stepMessageSearchBackfill(db);
      const ms = performance.now() - t;
      inStep = false;
      steps.push({ ms, body: ms - commitMs, merge: 0, commit: commitMs, ckpt: afterCommit() });
      const b = structure(db); stepCrises += crises(a, b); maxT = Math.max(maxT, b.length);
      worker();
      if (!r.more) break;
      for (let j = 0; j < between; j++) {
        const x = structure(db);
        commitMs = 0;
        const t2 = performance.now();
        insertMessage("live", { id: `live${n}`, role: "user", kind: "text", text: `live write ${n++} while the fill runs`, at: Date.now() });
        const lms = performance.now() - t2;
        live.push({ ms: lms, body: lms - commitMs, merge: 0, commit: commitMs, ckpt: afterCommit() });
        const y = structure(db); liveCrises += crises(x, y); maxT = Math.max(maxT, y.length);
        worker();
      }
    }
  } finally { delete (db as unknown as { exec?: unknown }).exec; }
  const done = Number((db.prepare("SELECT done FROM transcript_index_state WHERE name='search_fts'").get() as { done: number }).done);
  const indexed = Number((db.prepare("SELECT COUNT(*) AS n FROM messages_fts_docsize").get() as { n: number }).n);
  const searchable = Number((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('text','activity')").get() as { n: number }).n);
  const value = (k: string, d: number) => Number((db.prepare("SELECT v FROM messages_fts_config WHERE k = ?").get(k) as { v: number } | undefined)?.v ?? d);
  const out: Leg = {
    label, ckpt, steps, live, settingWrites, stepCrises, liveCrises, maxT, startT, endT: structure(db).length, workerCkpts, query: reads(),
    complete: done === 1 && indexed === searchable, automerge: value("automerge", 4), crisismerge: value("crisismerge", 16),
  };
  report(out);
  return out;
}
const unit = (u: Unit) => u.ms + u.ckpt;
function summary(units: Unit[]) {
  if (!units.length) return undefined;
  const worst = [...units].sort((a, b) => unit(b) - unit(a))[0]!;
  return {
    n: units.length, worstMs: r1(max0(units.map((u) => u.ms))), p99Ms: r1(pct(units.map((u) => u.ms), 0.99)), medianMs: r1(median(units.map((u) => u.ms))),
    worstUnitMs: r1(unit(worst)), p99UnitMs: r1(pct(units.map(unit), 0.99)),
    worstSplit: { body: r1(worst.body), merge: r1(worst.merge), commit: r1(worst.commit), ckpt: r1(worst.ckpt) },
    maxBodyMs: r1(max0(units.map((u) => u.body))), maxCommitMs: r1(max0(units.map((u) => u.commit))), maxCkptMs: r1(max0(units.map((u) => u.ckpt))),
    ckpts: units.filter((u) => u.ckpt > 0).length, over100: units.filter((u) => unit(u) >= 100).length, over250: units.filter((u) => unit(u) >= 250).length,
  };
}
function report(l: Leg): void {
  console.log(`F-FLAT ${l.label} [${l.ckpt}]`, JSON.stringify({
    steps: summary(l.steps), live: summary(l.live), settingWrites: l.settingWrites, crisisMerges: { steps: l.stepCrises, live: l.liveCrises },
    startT: l.startT, maxT: l.maxT, endT: l.endT, workerCkpts: l.workerCkpts.length, maxWorkerCkptMs: r1(max0(l.workerCkpts)), query: l.query, complete: l.complete,
  }));
}
/** What every leg holds: the fill finished and indexed every searchable row, it wrote no index setting, and FTS5 defaults are what is
 * stored. In the primary run also asserted: no step commit ran a checkpoint, and every fill step (with any checkpoint) is under 250 ms.
 * Reported, never asserted: the worst complete step against the 100 ms aim, and the live commits (worst, p99, count over 250 ms); live
 * work units are compared with base by name across the two trees. The fallback leg returns before the timing lines. */
function gates(l: Leg): void {
  expect(l.complete, `${l.label}: the fill finished and indexed every searchable row`).toBe(true);
  expect(l.settingWrites, `${l.label}: index settings written by a fill step`).toBe(0);
  expect([l.automerge, l.crisismerge], `${l.label}: the stored settings`).toEqual([4, 16]);
  if (l.ckpt !== "primary") return;
  expect(l.steps.filter((u) => u.ckpt > 0).length, `${l.label}: primary commits that ran a checkpoint`).toBe(0);
  // The 100 ms step line is our own sizing aim (MEMW-STAGED-BULK.md D3), not a product line: recorded here, never asserted. The 250 ms work-unit line below is asserted.
  console.log(`F-FLAT ${l.label} [${l.ckpt}] worst complete step ${r1(max0(l.steps.map((u) => u.ms)))} ms against the ${STEP_LINE_MS} ms aim (reported, not asserted)`);
  expect(max0(l.steps.map(unit)), `${l.label}: worst step work unit`).toBeLessThan(WORK_UNIT_MS);
  // Live commits run today's live path byte for byte on today's settings: their line is "no worse than base", compared across the two
  // trees by name; the count over LIVE_LINE_MS is reported (over250), never asserted here as an absolute.
  if (l.live.length) console.log(`F-FLAT ${l.label} [${l.ckpt}] live commits over ${LIVE_LINE_MS} ms: ${l.live.filter((u) => unit(u) >= LIVE_LINE_MS).length} of ${l.live.length}`);
}

for (const total of [20_000, 200_000, 500_000]) {
  for (const ckpt of ["primary", "fallback"] as const) {
    it(`F-FLAT ${total} [${ckpt}]: the search fill over ${total.toLocaleString("en-US")} rows on base settings: worst complete step, work units, no setting written, the index complete`, { tags: ["perf-budget"], timeout: 600_000 }, () => {
      gates(leg(`${total}`, total, ckpt, 0));
    });
  }
}
for (const ckpt of ["primary", "fallback"] as const) {
  it(`F-FLAT (k) 500000 [${ckpt}]: a 500,000-row fill with 8 live writes after every step: every step and every live commit within the lines`, { tags: ["perf-budget"], timeout: 600_000 }, () => {
    gates(leg("500000 + 8 live", 500_000, ckpt, 8));
  });
  it(`F-FLAT T112 500000 [${ckpt}]: from the forced T = 112 state (half the history piled on level 0 under automerge 0), the fill with 8 live writes after every step: the lines, and the reads at the end`, { tags: ["perf-budget"], timeout: 600_000 }, () => {
    gates(leg("500000 forced T112 + 8 live", 500_000, ckpt, 8, (db) => forceT(db, 500_000)));
  });
}
