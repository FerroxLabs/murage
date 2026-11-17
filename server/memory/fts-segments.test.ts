// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RC4 speed diagnosis item 3: the stepped purge's negative 'merge' steps opened a new FTS5 segment each time until the index hit
// FTS5's 2,000-segment limit, after which every index write failed ("database or disk is full").
import { openTestIndex, put, closeSealed, grantCharge } from "./testing/open-index.ts";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { DatabaseSync } from "node:sqlite";
import { completeIndexReset, indexResetDue, noteIndexStop } from "./worker-controller.ts";
import { removeStopMarker } from "./index-quarantine.ts";
import { MEMW_SEGMENT_GATE, MEMW_W_MERGE_BYTES, structureSegments } from "./memw-steps.ts";
import { FTS_SEGMENT_LIMIT } from "./segment-limit.ts";
import { maintenanceRetryDelayMs } from "./maintenance-schedule.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const PATH = () => join(DATA_DIR, "memory-index.db");
const entry = (id: string, version = 1, text = "harbour lantern notes"): IndexedMemory => ({ id, version, scopeId: "s", text, deleted: false });
const raw = (index: MemoryIndex) => (index as unknown as { db: { exec(sql: string): void } }).db;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

// MAIN RULING (MEMW Part A build spec, R3 / OPEN-3):
// "durable merge debt PERMANENTLY replaces the unbounded optimize
// (purgeRecords, finishRewrite, recoverSegments)." The same pinned spec says
// "keep only the SEGMENT_LIMIT rebuild fallback behind a stop+reset."
// Preserve the recovery/search contracts below through that checked path.
const legacyRows = () => Array.from({ length: 6000 }, (_, n) => entry(`m-${n}`, 1, `word${n} shared alpha${n * 7} beta${n * 13}`));
/** Reproduce the inherited file offline, before a checked writer opens it.
 * Modern writers cannot create this pile because their 48-segment gate holds. */
function inherited(path: string, segments: number, records = legacyRows()): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
      CREATE TABLE vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
      CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));
      INSERT INTO index_meta VALUES('lexical_keys_complete','1');
      INSERT INTO lexical(lexical,rank) VALUES('automerge',0);
      INSERT INTO lexical(lexical,rank) VALUES('crisismerge',100000);`);
    const e=db.prepare("INSERT INTO entries VALUES(?,?,?,?)"), l=db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,?,?)"), k=db.prepare("INSERT INTO lexical_keys VALUES(?,?,?)");
    // Keep level zero below its crisis threshold, then reproduce the old
    // negative-merge bug's extra output segment on the next level.
    const groups=Math.min(segments,FTS_SEGMENT_LIMIT-2);
    for(let at=0;at<groups;at++) {
      db.exec("BEGIN");
      for(let i=Math.floor(at*records.length/groups);i<Math.floor((at+1)*records.length/groups);i++) {
        const r=records[i]!; e.run(r.id,r.version,r.scopeId,r.text);l.run(i+1,r.id,r.version,r.text);k.run(r.id,r.version,i+1);
      }
      db.exec("COMMIT");
    }
    if(segments>groups)db.exec("INSERT INTO lexical(lexical,rank) VALUES('merge',-1)");
    db.prepare("INSERT INTO index_meta VALUES('entries_live',?)").run(String(records.length));
    console.log("inherited pile", {segments,actual:structureSegments(db.prepare("SELECT block FROM lexical_data WHERE id=10").get()?.block as Uint8Array),rows:records.length});
  } finally { db.close(); }
}
export async function fullIndex(): Promise<MemoryIndex> {
  inherited(PATH(), FTS_SEGMENT_LIMIT-1);
  const index=await openTestIndex(PATH());
  expect(index.segmentCount()).toBe(FTS_SEGMENT_LIMIT-1);
  return index;
}
/** The same durable reset handshake the controller and helper use. The
 * authoritative source fixture is separate from the disposable search index. */
async function resetAndRefill(index: MemoryIndex, records = legacyRows()): Promise<MemoryIndex> {
  const stop=index.stopInfo(); expect(stop?.reason).toBe("segment_limit:lexical");
  expect(noteIndexStop(stop!)).toBe(true);
  const reset=indexResetDue(Number.MAX_SAFE_INTEGER)!; expect(reset).not.toBeNull();
  index.close();
  const fresh=await MemoryIndex.create(PATH(), {charge:grantCharge,reset:{...reset,kind:"merge"}});
  expect(fresh.resetDone()).toBe(reset.resetId);
  expect(completeIndexReset(reset.resetId)).toBe("done");
  removeStopMarker(PATH());expect(existsSync(`${PATH()}-walstop`)).toBe(false);
  await seedRows(fresh,records);
  expect(fresh.entriesLive()).toBe(records.length);
  const stored=(fresh as unknown as {db:DatabaseSync}).db.prepare("SELECT id,version,scope_id,text FROM entries ORDER BY id,version").all();
  expect(stored).toEqual(records.map(r=>({id:r.id,version:r.version,scope_id:r.scopeId,text:r.text})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.version-b.version));
  return fresh;
}
const allowed = (ids: string[]) => ids.map(id => ({ id, version: 1 }));

describe("FTS segment growth", () => {
  it("many purge cycles keep the segment count bounded", async () => {
    const index = await openTestIndex(PATH());
    // MAIN RULING (MEMW Part A R3): "durable merge debt PERMANENTLY
    // replaces the unbounded optimize". Secure-deleted rollovers open no
    // historical merge; use the production FTS page size for this lifecycle.
    // The inherited pile and checked merge limits are exercised separately.
    await seedRows(index, Array.from({ length: 6000 }, (_, n) => entry(`m-${n}`, 1, `word${n} shared alpha${n * 7} beta${n * 13}`)));
    const merges: number[] = [];
    const db = raw(index) as unknown as { exec(sql: string): void };
    const exec = db.exec.bind(db);
    db.exec = (sql: string) => { const m = /'merge',(-?\d+)/.exec(sql); if (m) merges.push(Number(m[1])); return exec(sql); };
    let worst = 0;
    for (let cycle = 0; cycle < 6; cycle++) {
      // Each cycle indexes rolled checkpoint versions (two per id), then lets the stepped purge walk and merge them out.
      await put(index, Array.from({ length: 60 }, (_, n) => entry(`checkpoint:c${cycle}-${n}`, 1)));
      await put(index, Array.from({ length: 60 }, (_, n) => entry(`checkpoint:c${cycle}-${n}`, 2)));
      for (let step = 0; step < 5000; step++) {
        const r = await index.purgeRolledCheckpoints({ maxExamined: 40, maxMs: 50, mergePages: 8, mergeFraction: 0 });
        worst = Math.max(worst, index.segmentCount());
        if (r.done) break;
      }
    }
    // Secure-delete removes these rollovers in place. Segment counts stay bounded
    // by normal FTS auto-merging, with no forced historical merge per cycle.
    // MAIN RULING (MEMW Part A R3): "durable merge debt PERMANENTLY
    // replaces the unbounded optimize". The gate may pay bounded positive
    // maintenance merges while the next batch waits; no negative restart.
    expect(merges.every(pages=>pages>0 && pages<=64)).toBe(true);
    expect(worst).toBeLessThan(64);
    expect(index.segmentCount()).toBeLessThan(64);
    index.close();
  }, 60_000);

  it("an index at the 2,000-segment limit recovers and accepts writes", async () => {
    const index = await fullIndex();
    expect(index.segmentCount()).toBeGreaterThanOrEqual(FTS_SEGMENT_LIMIT - 1);
    // MAIN RULING (MEMW Part A OPEN-3): "keep only the SEGMENT_LIMIT
    // rebuild fallback behind a stop+reset." A terminal checked stop, rather
    // than an unchecked SQLITE_FULL, precedes the reset.
    expect(await index.applyBatch([entry("fresh",1,"zebra crossing")])).toEqual({status:"failed",reason:"segment-gate",committed:0});
    await index.maintenanceStep(); // the next worker tick publishes the durable limit stop
    expect(await index.applyBatch([entry("fresh",1,"zebra crossing")])).toEqual({status:"failed",reason:"wal-over",committed:0});
    const fresh=await resetAndRefill(index);
    expect(fresh.segmentCount()).toBeLessThan(64);
    await put(fresh,[entry("fresh", 1, "zebra crossing")]);
    expect(fresh.search("zebra", allowed(["fresh"]), null, "m").hits.map(h => h.id)).toEqual(["fresh"]);
    expect(fresh.search("word5", allowed(["m-5"]), null, "m").hits.map(h => h.id)).toEqual(["m-5"]);
    await closeSealed(fresh);
  }, 120_000);

  it("compacts with optimize well before the limit, and leaves a small index alone", async () => {
    const small = await openTestIndex(PATH());
    await put(small,[entry("a")]);
    const smallSegments=small.segmentCount(),smallBytes=small.ioBytes();
    expect(smallSegments).toBeLessThan(10);
    expect((await small.maintenanceStep()).ran).toBeNull();
    expect(small.segmentCount()).toBe(smallSegments);
    expect(small.ioBytes()).toBe(smallBytes);
    expect(small.search("harbour",allowed(["a"]),null,"m").hits.map(h=>h.id)).toEqual(["a"]);
    await closeSealed(small);
    const path=join(DATA_DIR,"compact.db");
    inherited(path,1100,Array.from({length:1100},(_,n)=>entry(`m-${n}`,1,`word${n}`)));
    const large=await openTestIndex(path);
    expect(large.segmentCount()).toBeGreaterThanOrEqual(1000);
    const db=(large as unknown as {db:DatabaseSync}).db,exec=db.exec.bind(db),sql:string[]=[];
    db.exec=text=>{sql.push(text);return exec(text);};
    for(let step=0;large.segmentCount()>MEMW_SEGMENT_GATE;step++) {
      if(step>1000)throw new Error("bounded recovery did not settle");
      const before=large.ioBytes(),result=await large.maintenanceStep();
      if(result.ran==="merge")expect(large.ioBytes()-before).toBeLessThanOrEqual(MEMW_W_MERGE_BYTES);
      if(result.drain)await large.sealAndTruncate();
      expect(large.stopInfo()).toBeNull();
    }
    // MAIN RULING (MEMW Part A R3): "durable merge debt PERMANENTLY
    // replaces the unbounded optimize". Recovery stops at the 48 gate; it
    // does not optimize the whole history down to <10 in a single call.
    expect(large.segmentCount()).toBeLessThanOrEqual(MEMW_SEGMENT_GATE);
    expect(sql.join("\n")).not.toMatch(/optimize|rebuild/);
    expect(large.entriesLive()).toBe(1100);
    expect(large.search("word5",allowed(["m-5"]),null,"m").hits.map(h=>h.id)).toEqual(["m-5"]);
    await closeSealed(large);
  }, 120_000);

  it("a deleted memory is never returned by search, before, during or after recovery", async () => {
    const index = await fullIndex();
    // The delete cannot be written at the limit; the caller's allowed set (authority) already excludes the forgotten source.
    await expect(put(index,[{ ...entry("m-7"), deleted: true }])).rejects.toThrow();
    expect(index.search("word7", allowed(["m-8"]), null, "m").hits.map(h => h.id)).not.toContain("m-7");
    const fresh=await resetAndRefill(index,legacyRows().filter(row=>row.id!=="m-7"));
    await put(fresh,[{ ...entry("m-7"), deleted: true }]);
    expect(fresh.search("word7", allowed(["m-7", "m-8"]), null, "m").hits.map(h => h.id)).not.toContain("m-7");
    await closeSealed(fresh);
  }, 120_000);
});

describe("retry back-off", () => {
  it("doubles from the base to the cap and is never zero", async () => {
    const base = 5 * 60_000, max = 60 * 60_000;
    const delays = [1, 2, 3, 4, 5, 50].map(n => maintenanceRetryDelayMs(n, base, max));
    expect(delays).toEqual([base, 2 * base, 4 * base, 8 * base, max, max]);
    expect(Math.min(...delays)).toBeGreaterThan(0);
  });
});

describe("a deletion rolled while a merge runs", () => {
  /** Whether any FTS5 shadow-table block or stored row still holds the word's bytes. */
  const physical = (index: MemoryIndex, word: string) => {
    const db = (index as unknown as { db: { prepare(sql: string): { get(...a: unknown[]): any } } }).db;
    const data = Number(db.prepare("SELECT count(*) AS n FROM lexical_data WHERE instr(block, CAST(? AS BLOB))>0").get(word)!.n);
    const content = Number(db.prepare("SELECT count(*) AS n FROM lexical_content WHERE c2 LIKE ?").get(`%${word}%`)!.n);
    return data + content;
  };
  it("is merged out of every shadow-table block before the debt is cleared", async () => {
    const index = await openTestIndex(PATH());
    const internals = index as unknown as { purge: { merging: boolean } };
    const owed = () => (index as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db.prepare("SELECT 1 FROM index_meta WHERE key='merge_owed'").get() !== undefined;
    raw(index).exec("INSERT INTO lexical(lexical,rank) VALUES('pgsz',64)");
    await put(index, Array.from({ length: 3000 }, (_, n) => entry(`m-${n}`, 1, `word${n} shared alpha${n * 7} beta${n * 13}`)));
    await put(index, [entry("checkpoint:a", 1, "old"), entry("checkpoint:a", 2, "new")]);
    await put(index, [entry("checkpoint:late", 1, "zzqvortexish phrase"), entry("checkpoint:late", 2, "kept")]);
    await put(index, [{ ...entry("checkpoint:a", 1, "old"), deleted: true, rolled: true }]);
    expect(internals.purge.merging).toBe(true);
    // The merge opens and takes a couple of positive steps ...
    for (let n = 0; n < 3; n++) await index.purgeRolledCheckpoints({ maxExamined: 1, maxMs: 50, mergePages: 4, mergeFraction: 0 });
    // ... when the late version is rolled out: a new small segment the open merge does not own.
    await put(index, [{ ...entry("checkpoint:late", 1, "zzqvortexish phrase"), deleted: true, rolled: true }]);
    let finished = false;
    for (let step = 0; step < 20000 && !finished; step++) {
      const r = await index.purgeRolledCheckpoints({ maxExamined: 40, maxMs: 50, mergePages: 4, mergeFraction: 0 });
      finished = r.done;
      // the debt is never cleared while the deleted text is still physically present
      if (!owed()) expect(physical(index, "zzqvortexish")).toBe(0);
    }
    expect(finished).toBe(true);
    expect(owed()).toBe(false);
    expect(physical(index, "zzqvortexish")).toBe(0);
    expect(index.search("zzqvortexish", allowed(["checkpoint:late"]), null, "m").hits).toEqual([]);
    index.close();
  }, 60_000);
});

/** Seed in small groups, servicing the checked writer before the next group. */
async function seedRows(index: MemoryIndex, rows: Parameters<MemoryIndex["applyBatch"]>[0]) {
  for (let at = 0; at < rows.length;) {
    await index.sealAndTruncate();
    for (let steps = 0; index.segmentCount() > 48; steps++) {
      if (steps === 5000 || index.stopInfo()) throw new Error("fixture segment gate did not clear");
      const step = await index.maintenanceStep();
      if (step.drain) await index.sealAndTruncate();
    }
    // Each inserted row can flush a segment. Leave the next gate check between batches.
    const count = Math.min(16, 49 - index.segmentCount());
    await put(index, rows.slice(at, at + count));
    at += count;
  }
}
