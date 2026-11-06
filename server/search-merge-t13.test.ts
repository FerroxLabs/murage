// SPDX-License-Identifier: AGPL-3.0-or-later
// T13 (designs/SMOOTH-FTS-MERGE-R6.md §8): pins, on the SQLite this Node ships, every FTS5 behaviour the live-file merge relies on. Ported
// from reviews/smooth-fts-merge-build-1016/t13-probe.mjs (run on the shipped build: Node v24.20.0, SQLite 3.53.4). It records
// sqlite_version() and sqlite_source_id(); a different build that changes any pinned fact fails here before it can fool the proof.
// Pinned: the structure record (id 10) is a blob and a `('merge', -8)` leaves it byte-equal exactly when the index is empty or one
// tombstone-free segment remains; a tombstone in a mixed segment makes the probe owed; FTS5_TOMBSTONE_ROWID encoding (ids >= 2^53, read
// as a number they throw ERR_OUT_OF_RANGE); both R4 H1 counterexamples delay the proof and never fool it; automerge, deletemerge and
// usermerge literals read back and a bound parameter fails; with deletemerge=0 a fully deleted segment is not dropped at once.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ftsLevels } from "./testing/search-merge-fixtures.ts";

const DEL = Buffer.from("жжж", "utf8");
const open = () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA secure_delete=ON");
  // the shape of messages_fts (message-tables.ts): contentless, contentless_delete, detail=none, trigram
  db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(t, tokenize='trigram', content='', contentless_delete=1, detail=none)");
  return db;
};
const struct = (db: DatabaseSync) => { const r = db.prepare("SELECT block FROM messages_fts_data WHERE id=10").get() as { block?: unknown } | undefined; return r && r.block instanceof Uint8Array ? Buffer.from(r.block) : null; };
const tomb = (db: DatabaseSync) => db.prepare("SELECT 1 AS t FROM messages_fts_data WHERE id >= 9007199254740992 LIMIT 1").get() !== undefined;
const residue = (db: DatabaseSync) => db.prepare("SELECT block FROM messages_fts_data").all().some(r => Buffer.from(r.block as Uint8Array).includes(DEL));
const merge = (db: DatabaseSync, n: number) => { const a = struct(db); db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', ${n})`); const b = struct(db); if (!a || !b) throw new Error("no structure"); return !a.equals(b); };
const cfg = (db: DatabaseSync) => Object.fromEntries(db.prepare("SELECT k, v FROM messages_fts_config WHERE k IN ('automerge','deletemerge','usermerge')").all().map(r => [String(r.k), Number(r.v)]));
const setFast = (db: DatabaseSync) => { for (const [k, v] of [["automerge", 0], ["deletemerge", 0], ["usermerge", 4]] as const) db.exec(`INSERT INTO messages_fts(messages_fts, rank) VALUES('${k}', ${v})`); };
let rid = 1;
const word = (i: number) => "kept" + i.toString(36) + "xq" + ((i * 7919) % 99991).toString(36);
/** One transaction = one level-0 segment, kept and deleted rows together. Returns the deleted rows' ids. */
const seg = (db: DatabaseSync, kept: number, del: number) => {
  const ids: number[] = []; db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO messages_fts(rowid, t) VALUES(?, ?)");
  for (let i = 0; i < kept; i++) { ins.run(rid, word(rid) + " " + word(rid * 3)); rid++; }
  for (let i = 0; i < del; i++) { ids.push(rid); ins.run(rid++, "жжж"); }
  db.exec("COMMIT"); return ids;
};
const drop = (db: DatabaseSync, ids: number[]) => { db.exec("BEGIN"); const d = db.prepare("DELETE FROM messages_fts WHERE rowid = ?"); for (const i of ids) d.run(i); db.exec("COMMIT"); };
/** The scheduler's run in miniature: one -N, positives while they write, the prove (-N that writes nothing). */
const run = (db: DatabaseSync, allowance = 8) => {
  let lies = 0, proofs = 0;
  for (let restart = 0; restart < 50; restart++) {
    merge(db, -allowance);
    for (let k = 0; k < 100_000 && merge(db, allowance); k++);
    const wrote = merge(db, -allowance); proofs++;
    if (!wrote) { if (tomb(db) || residue(db)) lies++; return { proofs, lies, settled: true }; }
  }
  return { proofs, lies, settled: false };
};

describe("T13 pinning on the shipped SQLite", () => {
  it("records sqlite_version() and sqlite_source_id(), the shipped build is 3.53.4", () => {
    const db = open();
    const version = String((db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v);
    const source = String((db.prepare("SELECT sqlite_source_id() AS s").get() as { s: string }).s);
    console.log(`[T13] node=${process.version} sqlite_version=${version} sqlite_source_id=${source}`);
    expect(version).toBe("3.53.4");
    expect(source).toMatch(/^2026-07-24 19:02:57 bf7c7f30/);
  });

  it("the structure record is a blob; a -8 writes nothing on an empty index and on one tombstone-free segment", () => {
    const db = open();
    expect(struct(db)).not.toBeNull();
    expect(merge(db, -8)).toBe(false);
    setFast(db);
    seg(db, 200, 0);
    expect(merge(db, -8)).toBe(false);
    expect(String((db.prepare("SELECT typeof(block) AS t FROM messages_fts_data WHERE id=10").get() as { t: string }).t)).toBe("blob");
    // a no-op -8 in its own BEGIN IMMEDIATE..COMMIT leaves the blob byte-equal
    const a = struct(db)!; db.exec("BEGIN IMMEDIATE"); db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES('merge', -8)"); db.exec("COMMIT");
    expect(a.equals(struct(db)!)).toBe(true);
  });

  it("the merge settings read back as literals; a bound parameter fails", () => {
    const db = open();
    setFast(db);
    expect(cfg(db)).toEqual({ automerge: 0, deletemerge: 0, usermerge: 4 });
    expect(() => db.prepare("INSERT INTO messages_fts(messages_fts, rank) VALUES('deletemerge', ?)").run(0)).toThrow(/SQL logic error/);
  });

  it("a tombstone in a mixed segment: the probe is owed, the deleted bytes stay, the -8 writes; the run settles with no lie", () => {
    const db = open(); setFast(db);
    drop(db, seg(db, 300, 40));
    expect(tomb(db)).toBe(true);
    expect(residue(db)).toBe(true);
    expect(merge(db, -8)).toBe(true);
    const r = run(db);
    expect(r).toMatchObject({ settled: true, lies: 0 });
    expect(tomb(db)).toBe(false);
    expect(residue(db)).toBe(false);
  });

  it("FTS5_TOMBSTONE_ROWID: ((segid + 65536) << 37) + ipg, all >= 2^53; read as a number such an id throws ERR_OUT_OF_RANGE", () => {
    const db = open(); setFast(db);
    drop(db, seg(db, 300, 40));
    let code: unknown = null;
    try { db.prepare("SELECT id FROM messages_fts_data WHERE id >= 9007199254740992").all(); } catch (error) { code = (error as { code?: unknown }).code; }
    expect(code).toBe("ERR_OUT_OF_RANGE");
    const q = db.prepare("SELECT id FROM messages_fts_data WHERE id >= 9007199254740992"); q.setReadBigInts(true);
    const ids = q.all().map(r => r.id as bigint);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) { expect(id >= 9007199254740992n).toBe(true); expect(id >> 37n >= 65536n).toBe(true); }
  });

  it("with deletemerge=0 a fully deleted segment is not dropped at once (still owed); the next -8 removes it", () => {
    const db = open(); setFast(db);
    seg(db, 100, 0);
    const all = seg(db, 0, 60);
    drop(db, all);
    expect(tomb(db)).toBe(true);
    expect(residue(db)).toBe(true);
    expect(merge(db, -8)).toBe(true);
    expect(tomb(db)).toBe(false);
    expect(residue(db)).toBe(false);
  });

  it("R4 H1 counterexample 1 (a write after a merge started): the proof is delayed, never fooled", () => {
    const db = open(); setFast(db);
    const del: number[] = []; for (let i = 0; i < 8; i++) del.push(...seg(db, 400, 30));
    merge(db, -1);
    drop(db, del); seg(db, 3, 0);
    expect(run(db, 8)).toMatchObject({ settled: true, lies: 0 });
  });

  it("R4 H1 counterexample 2 (tombstones on postings already emitted into the merge output): every no-op -8 coincides with a clean index", () => {
    const db = open(); setFast(db);
    const del: number[] = []; for (let i = 0; i < 6; i++) del.push(...seg(db, 500, 40));
    for (let k = 0; k < 4; k++) merge(db, -2);
    drop(db, del);
    expect(tomb(db)).toBe(true);
    let lies = 0, noops = 0;
    for (let k = 0; k < 2000; k++) { if (!merge(db, -1)) { noops++; if (tomb(db) || residue(db)) lies++; break; } }
    expect({ noops, lies }).toEqual({ noops: 1, lies: 0 });
    expect(residue(db)).toBe(false);
  });

  it("the structure reader used by the tests (ftsLevels) agrees with the segments written", () => {
    const db = open(); setFast(db);
    db.exec("CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY, done INTEGER, cursor INTEGER, skipped INTEGER)");
    for (let i = 0; i < 3; i++) seg(db, 5, 0);
    expect(ftsLevels(db)[0]?.segments).toBe(3);
    merge(db, -8);
    expect(ftsLevels(db).reduce((n, l) => n + l.segments, 0)).toBe(1);
  });
});
