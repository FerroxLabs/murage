// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC4 speed diagnosis item 3: the stepped purge's negative 'merge' steps opened a new FTS5 segment each time until the index hit
// FTS5's 2,000-segment limit, after which every index write failed ("database or disk is full").
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex, isSegmentLimitError, type IndexedMemory } from "./index.ts";
import { FTS_SEGMENT_LIMIT } from "./segment-limit.ts";
import { maintenanceRetryDelayMs } from "./maintenance-schedule.ts";

const PATH = () => join(DATA_DIR, "memory-index.db");
const entry = (id: string, version = 1, text = "harbour lantern notes"): IndexedMemory => ({ id, version, scopeId: "s", text, deleted: false });
const raw = (index: MemoryIndex) => (index as unknown as { db: { exec(sql: string): void } }).db;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

/** An index at the limit, reached the way the old purge reached it: repeated negative 'merge' steps, each opening a new
 * output segment (plus the small deleting writes between them), until FTS5 refuses ("database or disk is full"). */
function fullIndex(): MemoryIndex {
  const index = new MemoryIndex(PATH());
  raw(index).exec("INSERT INTO lexical(lexical,rank) VALUES('pgsz',64)");
  index.upsert(Array.from({ length: 6000 }, (_, n) => entry(`m-${n}`, 1, `word${n} shared alpha${n * 7} beta${n * 13}`)));
  for (let n = 0; index.segmentCount() < FTS_SEGMENT_LIMIT && n < 6000; n++) {
    try {
      raw(index).exec("INSERT INTO lexical(lexical,rank) VALUES('merge',-8)");
      if (n % 3 === 0) index.upsert([entry(`m-${n % 300}`, 1, `word${n % 300} shared`)]);
    } catch (error) { if (!isSegmentLimitError(error)) throw new Error(`fixture stopped at ${n}, ${index.segmentCount()} segments: ${String(error)}`); break; }
  }
  let stuck: unknown;
  try { raw(index).exec("INSERT INTO lexical(lexical,rank) VALUES('merge',-8)"); } catch (error) { stuck = error; }
  expect(isSegmentLimitError(stuck)).toBe(true);
  return index;
}
const allowed = (ids: string[]) => ids.map(id => ({ id, version: 1 }));

describe("FTS segment growth", () => {
  it("many purge cycles keep the segment count bounded", () => {
    const index = new MemoryIndex(PATH());
    // Tiny FTS pages make every merge take many steps, as a large owner index does.
    raw(index).exec("INSERT INTO lexical(lexical,rank) VALUES('pgsz',64)");
    index.upsert(Array.from({ length: 6000 }, (_, n) => entry(`m-${n}`, 1, `word${n} shared alpha${n * 7} beta${n * 13}`)));
    const merges: number[] = [];
    const db = raw(index) as unknown as { exec(sql: string): void };
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => { const m = /'merge',(-?\d+)/.exec(sql); if (m) merges.push(Number(m[1])); return exec(sql); };
    let worst = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      // Each cycle indexes rolled checkpoint versions (two per id), then lets the stepped purge walk and merge them out.
      index.upsert(Array.from({ length: 60 }, (_, n) => entry(`checkpoint:c${cycle}-${n}`, 1)));
      index.upsert(Array.from({ length: 60 }, (_, n) => entry(`checkpoint:c${cycle}-${n}`, 2)));
      for (let step = 0; step < 5000; step++) {
        const r = index.purgeRolledCheckpoints({ maxExamined: 40, maxMs: 50, mergePages: 8, mergeFraction: 0 });
        worst = Math.max(worst, index.segmentCount());
        if (r.done) break;
      }
    }
    // Only the step that starts a merge is negative; negative steps repeated one after another each open a new segment.
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.filter((n, at) => n < 0 && merges[at - 1] < 0)).toEqual([]);
    expect(worst).toBeLessThan(64);
    expect(index.segmentCount()).toBeLessThan(64);
    index.close();
  }, 60_000);

  it("an index at the 2,000-segment limit recovers and accepts writes", () => {
    const index = fullIndex();
    expect(index.segmentCount()).toBeGreaterThanOrEqual(FTS_SEGMENT_LIMIT - 1);
    let failure: unknown;
    try { index.upsert([entry("fresh", 1, "zebra crossing")]); } catch (error) { failure = error; }
    expect(isSegmentLimitError(failure)).toBe(true);
    expect(index.recoverSegments()).toBe("rebuild");
    expect(index.segmentCount()).toBeLessThan(64);
    index.upsert([entry("fresh", 1, "zebra crossing")]);
    expect(index.search("zebra", allowed(["fresh"]), null, "m").hits.map(h => h.id)).toEqual(["fresh"]);
    expect(index.search("word5", allowed(["m-5"]), null, "m").hits.map(h => h.id)).toEqual(["m-5"]);
    index.close();
  }, 120_000);

  it("compacts with optimize well before the limit, and leaves a small index alone", () => {
    const small = new MemoryIndex(PATH());
    small.upsert([entry("a")]);
    expect(small.recoverSegments()).toBe("none");
    raw(small).exec("INSERT INTO lexical(lexical,rank) VALUES('automerge',0)");
    raw(small).exec("INSERT INTO lexical(lexical,rank) VALUES('crisismerge',100000)");
    for (let n = 0; n < 1100; n++) small.upsert([entry(`m-${n}`, 1, `word${n}`)]);
    expect(small.segmentCount()).toBeGreaterThanOrEqual(1000);
    expect(small.recoverSegments()).toBe("optimize");
    expect(small.segmentCount()).toBeLessThan(10);
    small.close();
  }, 120_000);

  it("a deleted memory is never returned by search, before, during or after recovery", () => {
    const index = fullIndex();
    // The delete cannot be written at the limit; the caller's allowed set (authority) already excludes the forgotten source.
    expect(() => index.upsert([{ ...entry("m-7"), deleted: true }])).toThrow();
    expect(index.search("word7", allowed(["m-8"]), null, "m").hits.map(h => h.id)).not.toContain("m-7");
    index.recoverSegments();
    index.upsert([{ ...entry("m-7"), deleted: true }]);
    expect(index.search("word7", allowed(["m-7", "m-8"]), null, "m").hits.map(h => h.id)).not.toContain("m-7");
    index.close();
  }, 120_000);
});

describe("retry back-off", () => {
  it("doubles from the base to the cap and is never zero", () => {
    const base = 5 * 60_000, max = 60 * 60_000;
    const delays = [1, 2, 3, 4, 5, 50].map(n => maintenanceRetryDelayMs(n, base, max));
    expect(delays).toEqual([base, 2 * base, 4 * base, 8 * base, max, max]);
    expect(Math.min(...delays)).toBeGreaterThan(0);
  });
});
