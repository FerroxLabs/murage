// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helper (WP2b): a 1.0.17-shaped index file plus a key authority, and a driver that runs the MEMW staged bulk (age-index.ts ageStep)
// on the REAL WAL core (index-wal.ts) measuring every line: rise per step <= its W, L <= C after every commit, every call <= 250 ms.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { agePhase, ageStep, ftsSegments, lexicalRowidsAged, type AgeStepResult } from "../age-index.ts";
import { openIndexWal, type IndexWal } from "../index-wal.ts";
import { POSTINGS_SCHEMA, postingFiller } from "../postings.ts";
import { MEMW_C_BYTES, MEMW_CALL_MS, MEMW_SEGMENT_GATE, MEMW_TICK_TRUNCATE_BYTES, MEMW_W_MERGE_BYTES, MEMW_W_STEP_BYTES, StepSizer, MEMW_MERGE_PAGES } from "../memw-steps.ts";

export const INDEX_SCHEMA = `CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
CREATE TABLE vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));`;
export const AUTH_SCHEMA = `CREATE TABLE memory_record_keys(record_id TEXT NOT NULL,record_version INTEGER NOT NULL,scope_id TEXT NOT NULL,state TEXT NOT NULL,owner_pinned INTEGER NOT NULL,kind TEXT NOT NULL,age_key INTEGER NOT NULL,PRIMARY KEY(record_id,record_version)) WITHOUT ROWID;
CREATE UNIQUE INDEX memory_record_keys_age ON memory_record_keys(age_key);`;

/** A deterministic PRNG (mulberry32). */
export function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export type TextMix = "mix" | "one-word" | "zipf" | "huge";
/** Record texts: mix (30 B .. 2 KiB, 1 in 2,000 at 64 KiB), one word everywhere, or Zipf 1.3 over 50,000 words. */
export function textOf(mix: TextMix, random: () => number): (i: number) => string {
  if (mix === "one-word") return () => "alpha";
  if (mix === "huge") return i => `note ${i} ${"large ".repeat(10_900)}`.slice(0, 65_536); // every record 64 KiB
  if (mix === "zipf") {
    const words = 50_000, cum: number[] = []; let sum = 0;
    for (let r = 1; r <= words; r++) { sum += 1 / r ** 1.3; cum.push(sum); }
    const word = () => { const x = random() * sum; let lo = 0, hi = words - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid]! < x) lo = mid + 1; else hi = mid; } return `w${lo}`; };
    return () => Array.from({ length: 8 + Math.floor(random() * 40) }, word).join(" ");
  }
  return i => {
    if (i % 2000 === 7) return "large ".repeat(10_900).slice(0, 65_536);
    const len = 30 + Math.floor(random() ** 3 * 2000);
    let s = `note ${i}`; while (s.length < len) s += ` w${Math.floor(random() * 5000)}`; return s.slice(0, len);
  };
}
export interface Fixture { indexPath: string; authPath: string; n: number; keyOf: (i: number) => number; idOf: (i: number) => string }
/** `n` records as a 1.0.17 build left them: automatic FTS rowids in projection order (i ascending), age keys a shuffle of that order. */
export function buildFixture(dir: string, n: number, opts: { mix?: TextMix; seed?: number; idOf?: (i: number) => string; debt?: number; completePostings?: boolean } = {}): Fixture {
  const random = rng(opts.seed ?? 1), text = textOf(opts.mix ?? "mix", random);
  const idOf = opts.idOf ?? ((i: number) => `memory:${i.toString(36).padStart(8, "0")}`);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  const keyOf = (i: number) => 1_000_000 + order[i]! * 2_048;
  const indexPath = join(dir, "memory-index.db"), authPath = join(dir, "auth.db");
  const db = new DatabaseSync(indexPath); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF"); db.exec(INDEX_SCHEMA);
  const auth = new DatabaseSync(authPath); auth.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF"); auth.exec(AUTH_SCHEMA);
  db.exec("BEGIN"); auth.exec("BEGIN");
  const e = db.prepare("INSERT INTO entries VALUES(?,1,?,?)"), l = db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)"), k = db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)");
  const a = auth.prepare("INSERT INTO memory_record_keys VALUES(?,1,?,'active',0,'fact',?)");
  for (let i = 0; i < n; i++) { const id = idOf(i), t = text(i), scope = `scope:${i % 13}`; e.run(id, scope, t); l.run(i + 1, id, t); k.run(id, i + 1); a.run(id, scope, keyOf(i)); }
  db.prepare("INSERT INTO index_meta VALUES('lexical_keys_complete','1')").run();
  db.prepare("INSERT INTO index_meta VALUES('entries_live',?)").run(String(n));
  db.exec("COMMIT"); auth.exec("COMMIT");
  // retained deletion debt: a share of the records forgotten in both files, never merged out of `lexical`
  if (opts.debt) {
    db.exec("BEGIN"); auth.exec("BEGIN");
    for (let i = 0; i < n; i++) if (random() < opts.debt) {
      const id = idOf(i);
      db.prepare("DELETE FROM lexical WHERE rowid=?").run(i + 1); db.prepare("DELETE FROM lexical_keys WHERE id=?").run(id); db.prepare("DELETE FROM entries WHERE id=?").run(id);
      auth.prepare("DELETE FROM memory_record_keys WHERE record_id=?").run(id);
    }
    db.prepare("UPDATE index_meta SET value=(SELECT count(*) FROM entries) WHERE key='entries_live'").run();
    db.exec("COMMIT"); auth.exec("COMMIT");
  }
  // The staged-age fixtures start with a completed postings projection. Postings backfill
  // has its own worker tests; draining it here obscures the age operation being measured.
  // This is fixture construction, outside the measured bounded worker steps.
  if (opts.completePostings !== false) {
    db.exec(POSTINGS_SCHEMA);
    db.exec("BEGIN");
    const fillPostings = postingFiller(db);
    for (const row of db.prepare("SELECT rowid AS seq,scope_id,text FROM entries").iterate()) {
      fillPostings(String(row.scope_id), String(row.text), Number(row.seq));
    }
    db.prepare("INSERT INTO index_meta VALUES('postings_triggers','2')").run();
    db.exec("COMMIT");
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); auth.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close(); auth.close();
  return { indexPath, authPath, n, keyOf, idOf };
}

export interface LineStats { steps: number; byKind: Record<string, { n: number; maxRise: number; maxMs: number; medianMs: number; ms: number[] }>; maxL: number; maxCallMs: number; phases: string[]; overruns: string[]; wallMs: number; gateMerges: number; seals: number }
export interface Driven { stats: LineStats; db: DatabaseSync; wal: IndexWal; authority: DatabaseSync; close: () => void }
/** Opens the fixture on the real WAL core and runs the staged bulk to its end (phase null and aged), with the 50 ms tick's
 * sealAndTruncate above 8 MiB and gate merges on lexical_age, measuring every committed call. */
export async function driveStaged(fx: Fixture, opts: { maxSteps?: number; until?: (r: AgeStepResult) => boolean; onStep?: (r: AgeStepResult, db: DatabaseSync) => void } = {}): Promise<Driven> {
  const opened = openIndexWal(fx.indexPath, { charge: async () => true });
  if (opened.verdict.state === "stopped") throw new Error("stopped at open");
  const verdict = await opened.wal.openCheck();
  if (verdict.state !== "writable") throw new Error(`open: ${JSON.stringify(verdict)}`);
  const db = opened.writable, wal = opened.wal, authority = new DatabaseSync(fx.authPath, { readOnly: true });
  const sizer = new StepSizer(wal.pageSize, () => 0);
  const stats: LineStats = { steps: 0, byKind: {}, maxL: wal.L(), maxCallMs: 0, phases: [], overruns: [], wallMs: 0, gateMerges: 0, seals: 0 };
  const note = (kind: string, rise: number, ms: number) => {
    const k = stats.byKind[kind] ??= { n: 0, maxRise: 0, maxMs: 0, medianMs: 0, ms: [] };
    k.n++; k.maxRise = Math.max(k.maxRise, rise); k.maxMs = Math.max(k.maxMs, ms); k.ms.push(ms);
    stats.maxL = Math.max(stats.maxL, wal.L()); stats.maxCallMs = Math.max(stats.maxCallMs, ms);
    const limit = kind === "merge" ? MEMW_W_MERGE_BYTES : MEMW_W_STEP_BYTES;
    if (rise > limit) stats.overruns.push(`${kind} rise ${rise} > ${limit}`);
    if (wal.L() > MEMW_C_BYTES) stats.overruns.push(`L ${wal.L()} > C`);
  };
  const ctx = { db, writer: wal, sizer, authority };
  const wall = performance.now();
  const max = opts.maxSteps ?? 10_000_000;
  for (let n = 0; n < max; n++) {
    if (wal.L() > MEMW_TICK_TRUNCATE_BYTES) { await wal.sealAndTruncate(); stats.seals++; }
    const Lb = wal.L(), t0 = performance.now();
    const r = ageStep(ctx);
    if (r.ran) {
      await wal.check();
      const ms = performance.now() - t0, rise = wal.L() >= Lb ? wal.L() - Lb : wal.L() - 32;
      stats.steps++; note(r.ran, rise, ms);
    }
    const phase = agePhase(db) ?? "none";
    if (stats.phases.at(-1) !== phase) stats.phases.push(phase);
    opts.onStep?.(r, db);
    if (opts.until?.(r)) break;
    if (r.waiting === "gate") {
      const g0 = performance.now(), gLb = wal.L();
      wal.write("merge", MEMW_W_MERGE_BYTES, () => db.exec(`INSERT INTO lexical_age(lexical_age,rank) VALUES('merge',${MEMW_MERGE_PAGES})`));
      await wal.check(); stats.gateMerges++; note("merge", wal.L() - gLb, performance.now() - g0);
      if (stats.gateMerges > 1_000_000) throw new Error("gate merges do not end");
      continue;
    }
    if (r.waiting === "blocked") break;
    if (r.waiting === "admit") { await wal.sealAndTruncate(); stats.seals++; continue; }
    if (agePhase(db) === null && lexicalRowidsAged(db)) break;
  }
  stats.wallMs = performance.now() - wall;
  for (const k of Object.values(stats.byKind)) { const s = [...k.ms].sort((a, b) => a - b); k.medianMs = s[Math.floor(s.length / 2)] ?? 0; }
  return { stats, db, wal, authority, close: () => { try { authority.close(); } catch { /* closed */ } } };
}
export const CALL_LINE_MS = MEMW_CALL_MS;
export const SEGMENT_GATE = MEMW_SEGMENT_GATE;
export { ftsSegments };
