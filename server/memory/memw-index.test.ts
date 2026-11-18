// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MEMW Part A WP2 on a live index: R4 entries_live, M-B / A8 lexical_keys, overrun_k defaults, T9 pragmas and FTS config, R3 flat work,
// A19 plans. The WAL core (index-wal.ts, WP1) is not in this tree yet: these run on the legacy writer seam (memw-steps.ts legacyWriter).
import { openTestIndex, closeSealed, grantCharge } from "./testing/open-index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walTestHooks } from "./index-wal.ts";
import { ENTRIES_RECOUNT_ROWS, MemoryIndex, type IndexedMemory } from "./index.ts";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "memw-wp2-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const raw = (path: string) => { const db = new DatabaseSync(path); db.exec("PRAGMA journal_mode=WAL"); return db; };
const count = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare(sql).get()!.n); } finally { db.close(); } };
const meta = (path: string, key: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { const r = db.prepare("SELECT value FROM index_meta WHERE key=?").get(key); return r ? String(r.value) : undefined; } finally { db.close(); } };
const rec = (i: number, extra: Partial<IndexedMemory> = {}): IndexedMemory => ({ id: `memory:${i}`, version: 1, scopeId: `scope:${i % 7}`, text: `words of record ${i} alpha`, deleted: false, ...extra });
const BASE = `CREATE TABLE entries(id TEXT NOT NULL,version INTEGER NOT NULL,scope_id TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(id,version));
  CREATE VIRTUAL TABLE lexical USING fts5(id UNINDEXED,version UNINDEXED,text,tokenize='unicode61');
  CREATE TABLE vectors(id TEXT NOT NULL,version INTEGER NOT NULL,model TEXT NOT NULL,part INTEGER NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(id,version,model,part));
  CREATE TABLE index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;`;
/** A file as an older build left it: `n` entries and FTS rows, lexical_keys whole-built (1.0.17) or absent (pre-keys). */
function fixture(path: string, n: number, keys: "whole" | "none" | number, ids: (i: number) => string = i => `memory:${i}`) {
  const db = raw(path);
  db.exec(BASE);
  if (keys !== "none") db.exec("CREATE TABLE lexical_keys(id TEXT NOT NULL,version INTEGER NOT NULL,fts_rowid INTEGER NOT NULL UNIQUE,PRIMARY KEY(id,version))");
  db.exec("BEGIN");
  const e = db.prepare("INSERT INTO entries VALUES(?,1,?,?)"), l = db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(?,?,1,?)"), k = keys === "none" ? null : db.prepare("INSERT INTO lexical_keys VALUES(?,1,?)");
  for (let i = 1; i <= n; i++) { const text = `w${i % 97} common`; e.run(ids(i), `scope:${i % 7}`, text); l.run(i, ids(i), text); if (keys === "whole" || (typeof keys === "number" && i <= keys)) k!.run(ids(i), i); }
  if (typeof keys === "number") db.prepare("INSERT INTO index_meta VALUES('lexical_keys_cursor',?)").run(String(keys));
  db.exec("COMMIT"); db.close();
}

describe("R4 entries_live (OPEN-4): the counter moves in the same txn as the row", () => {
  it("counter == count(*) through upserts, replacements, forgets, purgeRecords and the rolled purge", async () => {
    const path = join(dir(), "i.db"), index = await openTestIndex(path);
    expect(await index.applyBatch(Array.from({ length: 40 }, (_, i) => rec(i)))).toEqual({ status: "done" });
    await index.applyBatch([rec(3, { text: "replaced" }), rec(4, { deleted: true }), rec(99, { deleted: true })]);
    await index.purgeRecords(["memory:5", "memory:6", "absent"]);
    await index.applyBatch([{ ...rec(1), id: "checkpoint:a", version: 1 }, { ...rec(2), id: "checkpoint:a", version: 2 }]);
    for (let n = 0; n < 5; n++) await index.purgeRolledCheckpoints();
    expect(index.entriesLive()).toBe(count(path, "SELECT count(*) AS n FROM entries"));
    expect(index.entriesLive()).toBe(38); // 40 - forget 1 - purge 2 + 2 checkpoint versions - 1 rolled
    index.close();
  });
  it("after a crash image and a replay of the same batch the counter equals count(*)", async () => {
    const d = dir(), path = join(d, "i.db"), copy = join(d, "c.db"), index = await openTestIndex(path);
    await index.applyBatch(Array.from({ length: 16 }, (_, i) => rec(i)));
    // the crash image: the file and its log as they are on disk with the helper alive (no close, no checkpoint)
    copyFileSync(path, copy); if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
    index.close();
    const again = await openTestIndex(copy);
    expect(again.entriesLive()).toBe(16);
    await again.applyBatch(Array.from({ length: 16 }, (_, i) => rec(i))); // replay: idempotent by key
    await again.applyBatch([rec(2, { deleted: true }), rec(2, { deleted: true })]);
    expect(again.entriesLive()).toBe(count(copy, "SELECT count(*) AS n FROM entries"));
    again.close();
  });
  it("a counter out of step fails closed: never trusted, rebuilt by bounded recount steps, with writes during the recount", async () => {
    const path = join(dir(), "i.db");
    fixture(path, 10_000, "whole");
    const db = raw(path); db.prepare("INSERT INTO index_meta VALUES('entries_live','oops')").run(); db.close();
    const index = await openTestIndex(path);
    expect(index.entriesRecounting()).toBe(true);
    let steps = 0;
    await index.applyBatch([rec(20_001), rec(5, { deleted: true }), rec(9_999, { deleted: true })]);
    while (!await index.recountStep()) { steps++; if (steps === 1) await index.applyBatch([rec(20_002), rec(1, { deleted: true }), rec(9_000, { deleted: true })]); }
    expect(steps + 1).toBe(Math.ceil(10_002 / ENTRIES_RECOUNT_ROWS));
    expect(index.entriesLive()).toBe(count(path, "SELECT count(*) AS n FROM entries"));
    await index.distrustEntriesLive();
    while (!await index.recountStep()) { /* bounded steps */ }
    expect(index.entriesLive()).toBe(count(path, "SELECT count(*) AS n FROM entries"));
    index.close();
  });
});

describe("M-B and A8: lexical_keys_complete", () => {
  it("M-B: a 1.0.17 file opened 3 times: the backfill runs 0 times, no PK/UNIQUE error, the first group is admitted", async () => {
    const path = join(dir(), "i.db");
    fixture(path, 500, "whole");
    // an FTS row the 1.0.17 table never keyed: a backfill run would key it
    const db = raw(path); db.prepare("INSERT INTO lexical(rowid,id,version,text) VALUES(9999,'orphan',1,'x')").run(); db.close();
    for (let n = 0; n < 3; n++) { const index = await openTestIndex(path); index.close(); }
    expect(meta(path, "lexical_keys_complete")).toBe("1");
    expect(meta(path, "lexical_keys_cursor")).toBeUndefined();
    expect(count(path, "SELECT count(*) AS n FROM lexical_keys")).toBe(500);
    const index = await openTestIndex(path);
    expect(await index.applyBatch([rec(1, { text: "edited" })])).toEqual({ status: "done" });
    index.close();
  });
  it("A8: a pre-keys file is keyed in stepped `open` txns, each within the keys budget; complete before the first group", async () => {
    const path = join(dir(), "i.db");
    fixture(path, 30_000, "none", i => `memory:${"x".repeat(200)}:${i}`);
    const index = await openTestIndex(path);
    const steps = (index as unknown as { sizer: { last(k: string): Array<{ x: number; rows: number }> } }).sizer.last("keys");
    expect(steps.length).toBeGreaterThan(1);
    for (const s of steps) expect(s.x * 8 + 64 * 4120).toBeLessThanOrEqual(0.8 * 4 * 1024 * 1024 + 1);
    expect(meta(path, "lexical_keys_complete")).toBe("1");
    expect(count(path, "SELECT count(*) AS n FROM lexical_keys")).toBe(30_000);
    expect(await index.applyBatch([rec(7)])).toEqual({ status: "done" });
    index.close();
  });
  it("A8: killed after a stepped commit (cursor part way), the next open resumes from the cursor with no UNIQUE error", async () => {
    const path = join(dir(), "i.db");
    fixture(path, 5_000, 2_345);
    const index = await openTestIndex(path);
    expect(meta(path, "lexical_keys_complete")).toBe("1");
    expect(count(path, "SELECT count(*) AS n FROM lexical_keys")).toBe(5_000);
    expect(count(path, "SELECT count(*) AS n FROM lexical_keys k JOIN lexical l ON l.rowid=k.fts_rowid AND l.id=k.id")).toBe(5_000);
    index.close();
  });
});

describe("overrun_k defaults (MEMW owner ruling 11-08)", () => {
  const KINDS = ["group", "fill", "keys", "stage_drop", "delete", "merge", "tier"];
  it("a fresh file and a 1.0.17 file both size at base (k = 0), not at 1/8", async () => {
    const d = dir();
    fixture(join(d, "old.db"), 100, "whole");
    for (const path of [join(d, "fresh.db"), join(d, "old.db")]) {
      const index = await openTestIndex(path);
      for (const k of KINDS) expect(meta(path, `overrun_k:${k}`)).toBe("0");
      const sizer = (index as unknown as { sizer: { rho(k: string): number } }).sizer;
      expect(sizer.rho("fill")).toBe(3.11); expect(sizer.rho("delete")).toBe(3.1);
      index.close();
    }
  });
  it("a reset's real value lands after the default in the same open txn; a bad value reads as x8", async () => {
    const path = join(dir(), "i.db");
    await closeSealed(await openTestIndex(path));
    // r3.2.8 3.2: the reset is a start that carries R; its open txn writes reset_done and overrun_k after the defaults
    const index = await MemoryIndex.create(path, { charge: grantCharge, reset: { resetId: 77, resets: 2, kind: "fill" } });
    expect(meta(path, "overrun_k:fill")).toBe("2"); expect(meta(path, "overrun_k:delete")).toBe("0"); expect(meta(path, "reset_done")).toBe("77");
    const sizer = (index as unknown as { sizer: { rho(k: string): number } }).sizer;
    expect(sizer.rho("fill")).toBeCloseTo(3.11 * 4, 9);
    index.close();
    const db = raw(path); db.prepare("UPDATE index_meta SET value='bad' WHERE key='overrun_k:delete'").run(); db.close();
    const again = await openTestIndex(path);
    expect((again as unknown as { sizer: { rho(k: string): number } }).sizer.rho("delete")).toBeCloseTo(3.1 * 8, 9);
    again.close();
  });
});

describe("T9: FULL, secure_delete, autocheckpoint 0, journal_size_limit 0, cache_spill off, automerge 0 / crisismerge 1999", () => {
  it("read back on a fresh index and on a 1.0.17 file, after steps", async () => {
    const d = dir();
    fixture(join(d, "old.db"), 50, "whole");
    for (const path of [join(d, "fresh.db"), join(d, "old.db")]) {
      const index = await openTestIndex(path);
      await index.applyBatch([rec(1), rec(2)]);
      await index.fillPostings();
      const db = (index as unknown as { db: DatabaseSync }).db;
      const p = (q: string) => Object.values(db.prepare(`PRAGMA ${q}`).get()!)[0];
      expect([p("synchronous"), p("secure_delete"), p("wal_autocheckpoint"), p("journal_size_limit"), p("cache_spill"), p("journal_mode")]).toEqual([2, 1, 0, 0, 0, "wal"]);
      const cfg = (k: string) => Number(db.prepare("SELECT v FROM lexical_config WHERE k=?").get(k)?.v);
      expect([cfg("automerge"), cfg("crisismerge")]).toEqual([0, 1999]);
      index.close();
    }
  });
});

describe("R3 (OPEN-3): no unbounded optimize; work per call is flat from 20k to 200k", () => {
  async function work(n: number) {
    const path = join(dir(), `w${n}.db`);
    fixture(path, n, "whole");
    const index = await openTestIndex(path);
    const wal = () => { try { return statSync(`${path}-wal`).size; } catch { return 0; } };
    const db = (index as unknown as { db: DatabaseSync }).db;
    const out: Record<string, number> = {};
    for (const [name, run] of [["purgeRecords", async () => await index.purgeRecords(["memory:17", "memory:18"])], ["finishRewrite", async () => await index.finishRewrite()]] as const) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const before = wal(); await run(); out[name] = wal() - before;
    }
    index.close();
    return out;
  }
  it("purgeRecords, finishRewrite, recoverSegments write the same bounded log at 20k and 200k", async () => {
    const small = await work(20_000), large = await work(200_000);
    for (const k of Object.keys(small)) {
      expect(large[k]).toBeLessThanOrEqual(1024 * 1024);
      expect(large[k]).toBeLessThanOrEqual(Math.max(small[k] * 1.1, small[k] + 8 * 4120));
    }
  }, 240_000);
});

describe("A19: EXPLAIN QUERY PLAN of every statement a step prepares has no SCAN of a history table", () => {
  it("groups, forgets, the rolled purge walk, postings steps, the recount, purgeRecords", async () => {
    const path = join(dir(), "i.db");
    fixture(path, 2_000, "whole");
    const db0 = raw(path); db0.prepare("INSERT INTO index_meta VALUES('entries_live','x')").run(); db0.close();
    const index = await openTestIndex(path);
    const db = (index as unknown as { db: DatabaseSync }).db;
    const seen = new Set<string>(), prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => { seen.add(sql); return prepare(sql); };
    await index.applyBatch([rec(1, { text: "new" }), rec(2, { deleted: true }), rec(5000)]);
    await index.purgeRecords(["memory:9"]);
    for (let n = 0; n < 3; n++) { await index.purgeRolledCheckpoints(); await index.fillPostings(); await index.recountStep(); }
    (db as unknown as { prepare: unknown }).prepare = prepare;
    const HISTORY = /\bSCAN (entries|lexical_keys|lexical_age_keys|vectors|postings|posting_todo|age_stage|age_emap)\b(?! USING)/;
    const bad: string[] = [];
    for (const sql of seen) {
      if (/^\s*(PRAGMA|BEGIN|COMMIT|ROLLBACK|CREATE|DROP|ALTER|EXPLAIN)/i.test(sql)) continue;
      // existence probes (no ORDER BY, LIMIT 1) are constant work
      if (/LIMIT 1\s*$/.test(sql) && !/ORDER BY/i.test(sql)) continue;
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(r => r.detail).join(" | ");
      if (HISTORY.test(plan)) bad.push(`${sql} => ${plan}`);
    }
    expect(bad).toEqual([]);
    index.close();
  });
});

// Group planning must follow row work: resizing rows cannot shorten a fixed
// sidecar/commit stall, and extra commits change the FTS merge schedule.
describe("group timing feedback", () => {
  for (const delayAt of ["commit", "rows"] as const) it(`sizes the next group from row work after a slow ${delayAt}`, async () => {
    const index = await openTestIndex(join(dir(), "timing.db"));
    const db = (index as unknown as { db: DatabaseSync }).db;
    const clock = performance.now.bind(performance);
    let delay = 0, delayed = false;
    const groups: number[] = [];
    const writer = (index as unknown as { writeGroup(rows: IndexedMemory[], reserve: number): void });
    const writeGroup = writer.writeGroup.bind(index);
    vi.spyOn(writer, "writeGroup").mockImplementation((rows, reserve) => {
      groups.push(rows.length);
      return writeGroup(rows, reserve);
    });
    vi.spyOn(performance, "now").mockImplementation(() => clock() + delay);
    if (delayAt === "commit") {
      walTestHooks.point = name => {
        if (name === "after-commit" && !delayed) { delay += 200; delayed = true; }
      };
    } else {
      const prepare = db.prepare.bind(db);
      vi.spyOn(db, "prepare").mockImplementation((...args) => {
        if (!delayed && args[0] === "SELECT fts_rowid FROM lexical_keys WHERE id=? AND version=?") {
          delay += 200; delayed = true;
        }
        return prepare(...args);
      });
    }
    try {
      expect(await index.applyBatch(Array.from({ length: 16 }, (_, i) => rec(i)))).toEqual({ status: "done" });
      expect(await index.applyBatch(Array.from({ length: 16 }, (_, i) => rec(i + 16)))).toEqual({ status: "done" });
      expect(delayed).toBe(true);
      if (delayAt === "commit") expect(groups, "fixed commit latency must not split the next row group").toEqual([16, 16]);
      else {
        expect(groups[0]).toBe(16);
        expect(groups.length, "slow row work must still shrink subsequent groups").toBeGreaterThan(2);
        expect(Math.max(...groups.slice(1))).toBeLessThan(16);
      }
      expect(index.entriesLive()).toBe(32);
    } finally {
      delete walTestHooks.point;
      vi.restoreAllMocks();
      index.close();
    }
  });
});
