// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A store a pre-release build left with automerge 0 and no search_merge marker may hold a pile of level-0 segments of the message-search
// index. The first live flush would meet it as one long crisis merge. settleInheritedSearchMerge pays it down at open in bounded
// 'merge' steps, before the defaults are written back, so a kill midway leaves automerge at 0 and the next open finishes the work.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { MESSAGE_SEARCH_DDL } from "./message-tables.ts";
import { settleInheritedSearchMerge } from "./message-search-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

// Reproduce the schema actually left by the pre-worker build. The current
// database() initializer creates an intent queue and deliberately retires FTS.
function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT); CREATE TABLE transcript_index_state(name TEXT PRIMARY KEY,done INTEGER,cursor INTEGER DEFAULT 0,skipped INTEGER DEFAULT 0)");
  db.exec(MESSAGE_SEARCH_DDL);
  return db;
}

const STEP_LINE_MS = 250, CRISIS = 16;
const setting = (db: DatabaseSync, k: string, v: number) => db.prepare(`INSERT INTO messages_fts(messages_fts, rank) VALUES('${k}', ${v})`).run();
const config = (db: DatabaseSync) => Object.fromEntries(db.prepare("SELECT k, v FROM messages_fts_config WHERE k IN ('automerge', 'deletemerge')").all().map((row) => [String(row.k), Number(row.v)]));
const marker = (db: DatabaseSync) => db.prepare("SELECT done FROM transcript_index_state WHERE name = 'search_merge'").get();

/** Segments per level, read from FTS5's structure record (messages_fts_data id 10): cookie, optional V2 marker, nLevel, nSegment, write
 * counter, then per level nMerge, nSeg and each segment (id, two page numbers, plus five more varints in V2). SQLite varints. */
function levels(db: DatabaseSync): number[] {
  const row = db.prepare("SELECT block FROM messages_fts_data WHERE id = 10").get() as { block?: Uint8Array } | undefined;
  if (!row?.block) return [];
  const b = row.block, v2 = b[4] === 0xff && b[5] === 0 && b[6] === 0 && b[7] === 1;
  let i = v2 ? 8 : 4;
  const next = (): number => { let v = 0; for (let k = 0; k < 8; k++) { const c = b[i++]!; v = v * 128 + (c & 0x7f); if (c < 0x80) return v; } return v * 256 + b[i++]!; };
  const count = next(); next(); next();
  const out: number[] = [];
  for (let level = 0; level < count; level++) { next(); const n = next(); for (let s = 0; s < n; s++) { next(); next(); next(); if (v2) for (let k = 0; k < 5; k++) next(); } out.push(n); }
  return out;
}

/** A store as the pre-release build left it: `segments` transactions of `per` rows each indexed under automerge 0 (so none merged), the
 * stored automerge still 0, and no search_merge marker. Rows go in in rowid order (FTS5 starts a new segment whenever a rowid goes back). */
function piled(segments: number, per: number): DatabaseSync {
  const db = legacyDatabase();
  db.exec("DELETE FROM messages_fts; DELETE FROM transcript_index_state WHERE name='search_fts'; DELETE FROM messages");
  const total = segments * per;
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${total})
    INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) SELECT i, 'big', 'm'||i, 1700000000000+i, 'bot', 'text', 'searchable line '||i, '{}' FROM n`);
  setting(db, "automerge", 0); setting(db, "crisismerge", 1999);
  const add = db.prepare("INSERT INTO messages_fts(rowid, t) SELECT rowid, text FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid");
  for (let lo = 0; lo < total; lo += per) { db.exec("BEGIN"); add.run(lo, lo + per); db.exec("COMMIT"); }
  setting(db, "crisismerge", CRISIS);
  expect(levels(db)).toEqual([segments]);
  expect(config(db).automerge).toBe(0);
  expect(marker(db)).toBeUndefined();
  return db;
}

/** The handle with its 'merge' statements timed; after `killAfter` of them the next one throws (a kill midway). */
function watched(db: DatabaseSync, killAfter = Infinity): { handle: DatabaseSync; steps: number[] } {
  const steps: number[] = [];
  const handle = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "exec" || typeof value !== "function") return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
      return (sql: string) => {
        if (!/VALUES\('merge'/.test(sql)) return Reflect.apply(value, target, [sql]);
        if (steps.length >= killAfter) throw new Error("killed midway");
        const t = performance.now();
        Reflect.apply(value, target, [sql]);
        steps.push(performance.now() - t);
      };
    },
  });
  return { handle: handle as DatabaseSync, steps };
}

it("test 1: an automerge-0 store with no marker and 40 level-0 segments ends with every level under 16, the defaults back and search working", () => {
  const db = piled(40, 300), info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { handle, steps } = watched(db);
    settleInheritedSearchMerge(handle, true);
    expect(steps.length).toBeGreaterThan(0);
    expect(Math.max(...levels(db))).toBeLessThan(CRISIS);
    expect(config(db).automerge).toBe(4);
    expect(marker(db)).toBeUndefined();
    expect(db.prepare("SELECT count(*) AS n FROM messages_fts_docsize").get()!.n).toBe(12_000);
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH '\"119\" AND \"199\"'").all().length).toBeGreaterThan(0);
    expect(info).toHaveBeenCalledTimes(1);
    const again = watched(db); // settled: the next open runs no merge step and logs nothing
    settleInheritedSearchMerge(again.handle, true);
    expect(again.steps.length).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    console.log("pile test 1", JSON.stringify({ steps: steps.length, worstStepMs: Math.max(...steps), levels: levels(db) }));
  } finally { info.mockRestore(); db.close(); }
});

it("test 3: killed after k steps, the store still shows automerge 0, and the next open finishes the pay-down", () => {
  const db = piled(60, 1000), info = vi.spyOn(console, "info").mockImplementation(() => {}), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const killed = watched(db, 2);
    settleInheritedSearchMerge(killed.handle, true);
    expect(killed.steps.length).toBe(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(config(db).automerge).toBe(0); // the durable note that the pile is still owed
    expect(Math.max(...levels(db))).toBeGreaterThanOrEqual(CRISIS);
    const reopened = watched(db);
    settleInheritedSearchMerge(reopened.handle, true);
    expect(reopened.steps.length).toBeGreaterThan(0);
    expect(Math.max(...levels(db))).toBeLessThan(CRISIS);
    expect(config(db).automerge).toBe(4);
    console.log("pile test 3", JSON.stringify({ killedAfter: killed.steps.length, finishedIn: reopened.steps.length, levels: levels(db) }));
  } finally { info.mockRestore(); warn.mockRestore(); db.close(); }
});

it("an ordinary store (automerge 4) runs no merge step at open", () => {
  const db = legacyDatabase();
  try {
    expect(config(db).automerge ?? 4).toBe(4);
    const { handle, steps } = watched(db);
    settleInheritedSearchMerge(handle, true);
    expect(steps.length).toBe(0);
  } finally { db.close(); }
});

it("test 2: the forced T=112 pile of a 500,000-row history is paid down at open, no step over 250 ms, every level under 16", { tags: ["perf-budget"], timeout: 600_000 }, () => {
  const db = piled(112, Math.ceil(250_000 / 112)), info = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const { handle, steps } = watched(db);
    const began = performance.now();
    settleInheritedSearchMerge(handle, true);
    const total = performance.now() - began;
    console.log("pile test 2", JSON.stringify({ steps: steps.length, openMs: Math.round(total), worstStepMs: Math.round(Math.max(...steps) * 10) / 10, first: steps.slice(0, 4).map(Math.round), p99StepMs: Math.round([...steps].sort((a, b) => a - b)[Math.floor(steps.length * 0.99)]! * 10) / 10, levels: levels(db) }));
    expect(Math.max(...steps)).toBeLessThan(STEP_LINE_MS);
    expect(Math.max(...levels(db))).toBeLessThan(CRISIS);
    expect(config(db).automerge).toBe(4);
  } finally { info.mockRestore(); db.close(); }
});
