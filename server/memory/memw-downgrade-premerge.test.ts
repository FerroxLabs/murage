// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW downgrade pre-merge (MurageMain ruling 22:03Z): before crisismerge 16 is restored, the downgrade merges every level of `lexical`
// down in bounded, resumable steps, so 1.0.17's first write never owes an unbounded merge.
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downgradeMemoryIndexFile } from "./age-index.ts";
import { structureSegments } from "./memw-steps.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-dg-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A MEMW-shaped file (automerge 0, crisismerge 1999) whose `lexical` holds `segments` level-0 segments, one txn each. */
function pile(path: string, segments: number) {
  const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL");
  db.exec(`CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
    CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
    CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version));
    INSERT INTO index_meta VALUES('lexical_keys_complete','1');
    INSERT INTO lexical(lexical,rank) VALUES('automerge',0); INSERT INTO lexical(lexical,rank) VALUES('crisismerge',1999);`);
  for (let s = 0; s < segments; s++) {
    const text = `seg${s} word${s % 13} common`, id = `memory:${1000 + s}`;
    db.exec("BEGIN");
    db.prepare("INSERT INTO entries VALUES(?,1,'scope:0',?)").run(id, text);
    db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)").run(1000 + s, id, text);
    db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)").run(id, 1000 + s);
    db.exec("COMMIT");
  }
  db.close();
}
const segments = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return structureSegments(db.prepare("SELECT block FROM lexical_data WHERE id=10").get()?.block as Uint8Array)!; } finally { db.close(); } };
/** Segments per level, from the FTS5 structure record (fts5StructureDecode: cookie, optional V2 marker, nLevel, nSegment, write counter, then per level nMerge, nSeg and 3 varints a segment, +5 in V2). */
function levels(path: string): number[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const bytes = db.prepare("SELECT block FROM lexical_data WHERE id=10").get()!.block as Uint8Array;
    let at = 4;
    const v2 = bytes[at] === 0xff && bytes[at + 1] === 0 && bytes[at + 2] === 0 && bytes[at + 3] === 1;
    if (v2) at += 4;
    const varint = (): number => { let value = 0; for (let n = 0; n < 9; n++) { const b = bytes[at++]; value = value * 128 + (b & 0x7f); if (!(b & 0x80)) return value; } return value; };
    const nLevel = varint(), nSegment = varint(); varint();
    const out: number[] = [];
    for (let l = 0; l < nLevel; l++) { varint(); const n = varint(); out.push(n); for (let i = 0; i < n * (v2 ? 8 : 3); i++) varint(); }
    expect(out.reduce((a, b) => a + b, 0)).toBe(nSegment);
    return out;
  } finally { db.close(); }
}
const config = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number((db.prepare("SELECT v FROM lexical_config WHERE k=?").get(key) as { v: number } | undefined)?.v); } finally { db.close(); } };
const count = (path: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare("SELECT count(*) AS n FROM lexical WHERE lexical MATCH 'common'").get()!.n); } finally { db.close(); } };

describe("downgrade pre-merge: no level is left at 16 or more when crisismerge 16 returns", () => {
  it("an 80-segment pile ends under 16 segments (so every level is under 16) with the 1.0.17 config and the same rows", async () => {
    const path = join(dir(), "memory-index.db");
    pile(path, 80);
    expect(segments(path)).toBeGreaterThanOrEqual(80);
    expect(levels(path)[0]).toBeGreaterThanOrEqual(80); // all in level 0 before
    expect(await downgradeMemoryIndexFile(path)).toBe(true);
    expect(segments(path)).toBeLessThan(16);
    const after = levels(path);
    console.log(`PER-LEVEL SEGMENTS AFTER DOWNGRADE: [${after.join(", ")}] `);
    for (const n of after) { expect(n).toBeLessThan(16); expect(n).toBeLessThan(4); }
    expect([config(path, "automerge"), config(path, "crisismerge")]).toEqual([4, 16]);
    expect(count(path)).toBe(80);
  });

  it("a stop midway (maxSteps 1: the debt is kept, not ready) leaves a valid index at the old config with its markers; the next run resumes and finishes", async () => {
    const path = join(dir(), "memory-index.db");
    pile(path, 80);
    expect(await downgradeMemoryIndexFile(path, { maxSteps: 1 })).toBe(false);
    const mid = segments(path);
    expect(mid).toBeGreaterThanOrEqual(1);
    expect(mid).toBeLessThan(80);
    expect(config(path, "crisismerge")).toBe(1999);
    expect(count(path)).toBe(80);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT value FROM index_meta WHERE key='lexical_keys_complete'").get()).toEqual({ value: "1" });
    db.close();
    expect(await downgradeMemoryIndexFile(path)).toBe(true);
    expect(segments(path)).toBeLessThan(16);
    expect([config(path, "automerge"), config(path, "crisismerge")]).toEqual([4, 16]);
    expect(count(path)).toBe(80);
  });
});
