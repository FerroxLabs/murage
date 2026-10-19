// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The numbering walk at scale (ROOM-ORDER-DESIGN r7 R1 "Qualification"). Off unless SEQ_RIG=1: it writes a messages.db of
// SEQ_RIG_ROWS rows (default 5.2M, about 5.5 GB; one thread of 1M, the rest over 5,000 threads, interleaved in storage order
// as years of use leave them) shaped as a 1.0.2 file after the upgrade's ALTER (seq NULL, no index, the walk not begun), then measures
// the CREATE INDEX hold (off-thread, the writer hold the server uses), the walk's wall and per-chunk times, owner writes during the
// walk (to a thread still pending and to one already numbered), a restart mid-walk, and S1 over every thread at the end.
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { database } from "./database.ts";
import * as mdb from "./message-db.ts";
import { buildOptionalIndexOffThread } from "./memory/optional-index.ts";
import { Store } from "./store.ts";
import type { ModelSelection } from "./contracts.ts";
import { numberSeqChunk, readIndexState, writeIndexState } from "./transcript-backfill.ts";
import { onSeqChunk, SEQ_INDEX, SEQ_OPTIONAL_INDEX, threadNumbered } from "./transcript-seq.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
const RIG = process.env.SEQ_RIG === "1";
const ROWS = Number(process.env.SEQ_RIG_ROWS ?? 5_200_000);
const BIG = Math.min(1_000_000, Math.floor(ROWS / 5));
const SMALL_THREADS = 5_000;
const EARLY = 1_000; // a thread written first, so the walk numbers it in its first chunks

const pct = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fmt = (xs: number[]) => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(1)} p99=${pct(xs, 0.99).toFixed(1)} max=${Math.max(...xs).toFixed(1)}`;
const report = (line: string) => console.log(`[seq-rig] ${line}`);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A seeded generator, so a rerun writes the same file. */
function generator(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function generate(): void {
  mdb.closeMessageDb();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
  const db = database();
  const r = generator(1);
  const filler = Array.from({ length: 64 }, (_, i) => Array.from({ length: 900 }, (_, k) => String.fromCharCode(97 + ((i * 7 + k * 13 + (k >> 3)) % 26))).join(""));
  // power-law sizes for the small threads, summing to ROWS - BIG - EARLY
  const weights = Array.from({ length: SMALL_THREADS }, (_, i) => 1 / Math.pow(i + 3, 0.8));
  const wsum = weights.reduce((a, b) => a + b, 0);
  const left = ROWS - BIG - EARLY;
  const remaining = weights.map((w) => Math.max(4, Math.floor((left * w) / wsum)));
  remaining.unshift(BIG);
  const names = ["big", ...Array.from({ length: SMALL_THREADS }, (_, i) => `t${String(i).padStart(4, "0")}`)];
  const counters = names.map(() => 0);
  const insert = db.prepare("INSERT INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const write = (thread: string, n: number, at: number) => {
    const id = `${thread}-${n}`;
    const text = `${id} ${filler[n % 64]}`;
    insert.run(thread, id, at, n % 2 ? "bot" : "user", "text", text, JSON.stringify({ id, role: n % 2 ? "bot" : "user", kind: "text", text, at }));
  };
  const began = performance.now();
  let at = 1_697_068_800_000, written = 0;
  db.exec("BEGIN");
  for (let n = 0; n < EARLY; n++) { write("early", n, at++); written++; }
  // interleave: each step picks a thread weighted by what it has left (a cumulative table rebuilt every 50k rows keeps this cheap)
  let total = remaining.reduce((a, b) => a + b, 0);
  while (total > 0) {
    const cum: number[] = []; let acc = 0;
    for (const n of remaining) { acc += n; cum.push(acc); }
    for (let step = 0; step < 50_000 && total > 0; step++) {
      const x = r() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > x) hi = mid; else lo = mid + 1; }
      let i = lo; while (remaining[i] === 0) i = (i + 1) % remaining.length;
      write(names[i], counters[i]++, at++); remaining[i]--; total--; written++;
    }
    db.exec("COMMIT"); db.exec("BEGIN");
  }
  db.exec("COMMIT");
  // as 1.0.2 left it after the 1.0.3 ALTER: every seq NULL, no index, the walk not begun
  db.exec(`DROP INDEX IF EXISTS ${SEQ_INDEX}`);
  db.exec("UPDATE messages SET seq = NULL");
  writeIndexState(db, "seq", { done: 0, cursor: 0, skipped: 0 });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  mdb.closeMessageDb();
  const bytes = statSync(join(DATA_DIR, "messages.db")).size;
  report(`generated rows=${written} threads=${names.length + 1} big=${BIG} file_bytes=${bytes} ms=${Math.round(performance.now() - began)}`);
}

describe.skipIf(!RIG)("transcript-seq numbering walk at scale", () => {
  it("builds the index, walks every row in bounded chunks, keeps owner writes responsive, resumes after a restart, and S1 holds", async () => {
    generate();
    const store = new Store((): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" }));

    // 1. the CREATE INDEX, off-thread under the writer hold; the serving thread's event loop is sampled meanwhile
    let holdOn = 0, holdMs = 0;
    const lag: number[] = [];
    let last = performance.now();
    const sampler = setInterval(() => { const now = performance.now(); lag.push(now - last - 10); last = now; }, 10);
    const readMs: number[] = [];
    const reader = setInterval(() => { const b = performance.now(); database().prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid DESC LIMIT 50").all("t0001"); readMs.push(performance.now() - b); }, 250);
    const built = await buildOptionalIndexOffThread(database(), SEQ_OPTIONAL_INDEX, { retries: 0, hold: (on) => { if (on) holdOn = performance.now(); else holdMs = performance.now() - holdOn; } });
    clearInterval(sampler); clearInterval(reader);
    expect(built).toBe(true);
    report(`index build hold_ms=${Math.round(holdMs)} event_loop_lag_ms ${fmt(lag)} reads_during_build_ms ${fmt(readMs)}`);

    // 2. the walk: bounded chunks with the event loop free between them, owner writes every 20 ms meanwhile
    const chunkMs: number[] = [], loopMs: number[] = [], commitMs: number[] = [], checksMs: number[] = [], threadsPer: number[] = []; let chunks = 0, cuts = 0;
    const off = onSeqChunk((f) => {
      chunkMs.push(f.ms); chunks++; if (f.cut) cuts++;
      loopMs.push(f.loopMs ?? NaN); commitMs.push(f.commitMs ?? NaN); checksMs.push(f.checksMs ?? NaN); threadsPer.push(f.threads ?? NaN);
    });
    const writePending: number[] = [], writeNumbered: number[] = [];
    let pendingStoredNull = 0, numberedAllocated = 0, k = 0;
    // each write's latency is measured from when its 20 ms tick was due, so time spent waiting behind a chunk counts
    let expected = performance.now() + 20, reopening = false;
    const writer = setInterval(() => {
      if (reopening) return;
      const toPending = k++ % 2 === 0;
      const row = store.appendMessage(toPending ? "big" : "early", { role: "user", kind: "text", text: `owner ${k}` });
      const end = performance.now();
      (toPending ? writePending : writeNumbered).push(end - expected);
      while (expected <= end) expected += 20; // a tick missed entirely is not counted twice
      if (toPending && row.seq === undefined && !threadNumbered(database(), "big")) pendingStoredNull++;
      if (!toPending && typeof row.seq === "number") numberedAllocated++;
    }, 20);
    const began = performance.now();
    let restarted = false, cursorAtKill = 0;
    try { for (;;) {
      const more = numberSeqChunk(database());
      await tick();
      if (!restarted && chunks >= Math.floor(ROWS / 2000)) {
        // a restart mid-walk: the handle closes, the cursor is what was saved
        cursorAtKill = readIndexState(database(), "seq").cursor;
        report(`half walk ms=${Math.round(performance.now() - began)} chunks=${chunks} chunk_ms ${fmt(chunkMs)} pending_thread_ms ${fmt(writePending)} numbered_thread_ms ${fmt(writeNumbered)}`);
        reopening = true;
        mdb.closeMessageDb();
        restarted = true;
        // the reopen a restart makes; a connection another thread still holds (the index build's worker) can keep the open waiting
        const reopenBegan = performance.now();
        for (let attempt = 0; ; attempt++) {
          try { database(); break; } catch (error) { if (attempt >= 60 || !/locked|busy/i.test(String(error))) throw error; mdb.closeMessageDb(); await new Promise((resolve) => setTimeout(resolve, 500)); }
        }
        report(`reopen after restart ms=${Math.round(performance.now() - reopenBegan)}`);
        expect(readIndexState(database(), "seq").cursor).toBe(cursorAtKill);
        reopening = false;
        continue;
      }
      if (!more) break;
    } } finally { clearInterval(writer); off(); }
    const wallMs = performance.now() - began;
    report(`walk wall_ms=${Math.round(wallMs)} chunks=${chunks} deadline_cuts=${cuts} chunk_ms ${fmt(chunkMs)}`);
    report(`chunk parts: loop_ms ${fmt(loopMs)} commit_ms ${fmt(commitMs)} checks_ms ${fmt(checksMs)} threads_per_chunk ${fmt(threadsPer)}`);
    report(`owner writes during walk: pending_thread_ms ${fmt(writePending)} stored_null=${pendingStoredNull}; numbered_thread_ms ${fmt(writeNumbered)} allocated=${numberedAllocated}`);
    report(`restart mid-walk cursor_resumed=${cursorAtKill}`);

    // 3. S1 over every thread
    const db = database();
    expect(readIndexState(db, "seq").done).toBe(1);
    const bad = db.prepare("SELECT thread_id, COUNT(*) AS n, COUNT(seq) AS c, MIN(seq) AS lo, MAX(seq) AS hi, COUNT(DISTINCT seq) AS d FROM messages GROUP BY thread_id HAVING c <> n OR lo <> 1 OR hi <> n OR d <> n").all();
    const totals = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT thread_id) AS t FROM messages").get() as { n: number; t: number };
    report(`S1 threads=${totals.t} rows=${totals.n} violations=${bad.length}`);
    expect(bad).toEqual([]);
    const big = store.appendMessage("big", { role: "user", kind: "text", text: "after the walk" });
    expect(big.seq).toBe(Number((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id='big'").get() as { n: number }).n));
    store.stopSeqStamps();
  }, 4 * 3600_000);
});
