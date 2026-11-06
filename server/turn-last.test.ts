// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The last row of each turn (turn-last.ts) on its own: the triggers, the floor, the walk, the fill, and a downgrade followed by a new
// upgrade. Reads go through turnSpanEnd, the one rule message-db.ts turnRows and turnTextRows use. The scale of the reads through the
// store is turn-span-bounded.test.ts.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { refillThread } from "./testing/bounded-reads.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { walkMessagesChunk, walkerPending } from "./message-walker.ts";
import { readIndexState } from "./transcript-backfill.ts";
import { TURN_LAST_FLOOR, TURN_LAST_TRIGGERS, TURN_LAST_WALK, downgradeTurnLastTo117, ensureTurnLast, turnSpanEnd } from "./turn-last.ts";

let written = 0;
function put(db: DatabaseSync, thread: string, turnId: string | null): number {
  const id = `m${++written}`;
  const result = db.prepare("INSERT INTO messages(thread_id, id, at, role, kind, text, json) VALUES (?, ?, 1, 'bot', 'text', 'x', ?)")
    .run(thread, id, JSON.stringify({ id, parentId: null, role: "bot", kind: "text", at: 1, text: "x", ...(turnId ? { turnId } : {}) }));
  return Number(result.lastInsertRowid);
}
const kept = (db: DatabaseSync, thread: string, turn: string) => db.prepare("SELECT first_rowid AS first, last_rowid AS last FROM turn_first WHERE thread_id = ? AND turn_id = ?").get(thread, turn) as { first: number; last: number | null } | undefined;
const triggers = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'turn_last_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
const hasColumn = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(turn_first)").all() as Array<{ name: string }>).some((column) => column.name === "last_rowid");
const walkAll = (db: DatabaseSync) => { while (walkMessagesChunk(db, 1_000).more) { /* one window at a time */ } };
const fresh = () => { const db = new DatabaseSync(":memory:"); initializeMessageTables(db); return db; };
const endOf = (db: DatabaseSync, thread: string, turn: string) => { const span = kept(db, thread, turn)!; return turnSpanEnd(db, Number(span.first), span.last === null ? null : Number(span.last)); };

describe("a new file", () => {
  it("has nothing to walk: the floor is zero, the walk is done, and every turn's span is exact from its first row", () => {
    const db = fresh();
    try {
      expect(readIndexState(db, TURN_LAST_FLOOR)).toMatchObject({ done: 1, cursor: 0 });
      expect(readIndexState(db, TURN_LAST_WALK)).toMatchObject({ done: 1, cursor: 0 });
      const a = put(db, "t", "turn-a");
      put(db, "t", "other");
      const b = put(db, "t", "turn-a");
      put(db, "t", "other");
      expect(walkerPending(db)).not.toContain(TURN_LAST_WALK);
      expect(kept(db, "t", "turn-a")).toEqual({ first: a, last: b });
      expect(endOf(db, "t", "turn-a")).toBe(b);
    } finally { db.close(); }
  });

  it("opening it again changes nothing", () => {
    const db = fresh();
    try {
      put(db, "t", "turn-a");
      const floor = readIndexState(db, TURN_LAST_FLOOR);
      initializeMessageTables(db);
      ensureTurnLast(db);
      expect(readIndexState(db, TURN_LAST_FLOOR)).toEqual(floor);
      expect(readIndexState(db, TURN_LAST_WALK).done).toBe(1);
    } finally { db.close(); }
  });
});

describe("turn_last_fill: a turn_first row with no last row (an earlier build's fill or writer)", () => {
  it("takes the newest row of messages at that moment, and later rows of the turn raise it", () => {
    const db = fresh();
    try {
      const first = put(db, "t", null);
      const newest = put(db, "t", null);
      db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('t', 'old-writer', ?)").run(first);
      expect(kept(db, "t", "old-writer")).toEqual({ first, last: newest });
      const later = put(db, "t", "old-writer");
      expect(kept(db, "t", "old-writer")).toEqual({ first, last: later });
    } finally { db.close(); }
  });

  it("an earlier build's first-row upsert never loses the last row", () => {
    const db = fresh();
    try {
      const a = put(db, "t", "turn-a");
      const b = put(db, "t", "turn-a");
      db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('t', 'turn-a', ?) ON CONFLICT(thread_id, turn_id) DO UPDATE SET first_rowid = MIN(first_rowid, excluded.first_rowid)").run(a);
      expect(kept(db, "t", "turn-a")).toEqual({ first: a, last: b });
    } finally { db.close(); }
  });
});

describe("a downgrade to an earlier build, then a new upgrade", () => {
  it("the triggers, column, floor and walk marker all leave, and no other turn data does", () => {
    const db = fresh();
    try {
      const a = put(db, "t", "turn-a");
      expect(downgradeTurnLastTo117(db).dropped).toBe(TURN_LAST_TRIGGERS.length + 1);
      expect(triggers(db)).toEqual([]);
      expect(hasColumn(db)).toBe(false);
      for (const name of [TURN_LAST_FLOOR, TURN_LAST_WALK]) expect(db.prepare("SELECT 1 AS x FROM transcript_index_state WHERE name = ?").get(name)).toBeUndefined();
      expect(db.prepare("SELECT first_rowid AS first FROM turn_first WHERE turn_id = 'turn-a'").get()).toEqual({ first: a });
      expect(downgradeTurnLastTo117(db)).toEqual({ dropped: 0 });
    } finally { db.close(); }
  });

  it("works inside the caller's transaction, and rolls back with it", () => {
    const db = fresh();
    try {
      put(db, "t", "turn-a");
      db.exec("BEGIN IMMEDIATE");
      downgradeTurnLastTo117(db);
      db.exec("ROLLBACK");
      expect(triggers(db)).toEqual(["turn_last_fill", "turn_last_msg"]);
      expect(hasColumn(db)).toBe(true);
    } finally { db.close(); }
  });

  it("what the earlier build wrote stays in the bound until the walk, and the walk makes every span exact", () => {
    const db = fresh();
    try {
      const first = put(db, "t", "straddle");
      downgradeTurnLastTo117(db);
      // the earlier build: its row of the turn, a turn of its own filed as it files them, and history of other turns
      const during = put(db, "t", "straddle");
      const own = put(db, "t", "earlier-build");
      db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('t', 'earlier-build', ?)").run(own);
      for (let i = 0; i < 20; i++) put(db, "t", null);
      const floor = put(db, "t", null);

      initializeMessageTables(db);
      expect(readIndexState(db, TURN_LAST_FLOOR)).toMatchObject({ done: 1, cursor: floor });
      expect(readIndexState(db, TURN_LAST_WALK)).toMatchObject({ done: 0, cursor: 0 });
      expect(walkerPending(db)).toContain(TURN_LAST_WALK);
      // before the walk: no last row kept, so the floor is the bound and both turns are inside it
      expect(kept(db, "t", "straddle")!.last).toBeNull();
      expect(endOf(db, "t", "straddle")).toBe(floor);
      expect(endOf(db, "t", "earlier-build")).toBe(floor);
      // history since the upgrade does not move that bound
      for (let i = 0; i < 20; i++) put(db, "t", null);
      expect(endOf(db, "t", "straddle")).toBe(floor);

      walkAll(db);
      expect(readIndexState(db, TURN_LAST_WALK).done).toBe(1);
      expect(kept(db, "t", "straddle")).toEqual({ first, last: during });
      expect(endOf(db, "t", "straddle")).toBe(during);
      expect(endOf(db, "t", "earlier-build")).toBe(own);
    } finally { db.close(); }
  });

  it("a last row kept across a window with no triggers is not trusted until the walk has run again", () => {
    const db = fresh();
    try {
      const first = put(db, "t", "stale");
      db.exec("DROP TRIGGER turn_last_msg");
      const missed = put(db, "t", "stale");
      initializeMessageTables(db);
      expect(kept(db, "t", "stale")).toEqual({ first, last: first });
      expect(endOf(db, "t", "stale")).toBe(missed);
      expect(readIndexState(db, TURN_LAST_WALK).done).toBe(0);
      walkAll(db);
      expect(kept(db, "t", "stale")).toEqual({ first, last: missed });
      expect(endOf(db, "t", "stale")).toBe(missed);
    } finally { db.close(); }
  });

  it("a turn_first made again with no column (a dropped table) records a new floor even if the old one is still there", () => {
    const db = fresh();
    try {
      put(db, "t", "turn-a");
      db.exec("DROP TRIGGER turn_last_msg; DROP TRIGGER turn_last_fill; ALTER TABLE turn_first DROP COLUMN last_rowid");
      const newest = put(db, "t", "turn-a");
      ensureTurnLast(db);
      expect(hasColumn(db)).toBe(true);
      expect(readIndexState(db, TURN_LAST_FLOOR)).toMatchObject({ done: 1, cursor: newest });
      expect(readIndexState(db, TURN_LAST_WALK).done).toBe(0);
    } finally { db.close(); }
  });
});

describe("the walk", () => {
  it("resumes from its cursor, and a turn with no readable row ends where it began", () => {
    const db = fresh();
    try {
      downgradeTurnLastTo117(db);
      const rows: number[] = [];
      for (let i = 0; i < 50; i++) rows.push(put(db, "t", "long-turn"));
      db.prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('t', 'no-rows-left', ?)").run(rows[0]!);
      initializeMessageTables(db);
      const step = walkMessagesChunk(db, 10);
      expect(step.more).toBe(true);
      expect(readIndexState(db, TURN_LAST_WALK).done).toBe(0);
      walkAll(db);
      expect(kept(db, "t", "long-turn")).toEqual({ first: rows[0], last: rows[49] });
      expect(kept(db, "t", "no-rows-left")!.last).toBeNull();
      expect(endOf(db, "t", "no-rows-left")).toBe(rows[0]);
    } finally { db.close(); }
  });
});

describe("the fill of a thread", () => {
  it("files each turn's first and last rows, over more than one turn", () => {
    const db = fresh();
    try {
      const a1 = put(db, "t", "turn-a");
      const b1 = put(db, "t", "turn-b");
      const a2 = put(db, "t", "turn-a");
      const b2 = put(db, "t", "turn-b");
      refillThread(db, "t");
      expect(kept(db, "t", "turn-a")).toEqual({ first: a1, last: a2 });
      expect(kept(db, "t", "turn-b")).toEqual({ first: b1, last: b2 });
    } finally { db.close(); }
  });
});
