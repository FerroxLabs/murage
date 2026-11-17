// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeRoutineMessageLinks, routineMessageAnchor } from "../routine-message-links.ts";

it("a new message never reads the erase path; replacement still removes its old anchor", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,id))");
    initializeRoutineMessageLinks(db);
    // Instrument the real trigger body, leaving its admission predicate and
    // every tree mutation intact. Count entry into erase, independently of time.
    let erases = 0;
    db.function("fixture_erase_probe", () => { erases++; return 0; });
    const sql = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='routine_link_before_insert'").get()!.sql);
    db.exec("DROP TRIGGER routine_link_before_insert");
    db.exec(sql.replace("BEGIN ", "BEGIN SELECT fixture_erase_probe(); "));
    const put = db.prepare("INSERT OR REPLACE INTO messages VALUES('thread',?,?)");
    put.run("first", 500); put.run("second", 100);
    expect(erases).toBe(0);
    expect(routineMessageAnchor(db, "thread", 400)).toBe("first");
    put.run("first", 50);
    expect(erases).toBe(1);
    expect(routineMessageAnchor(db, "thread", 75)).toBe("second");
    expect(db.prepare("SELECT count(*) AS n FROM routine_link_members").get()!.n).toBe(2);
    db.exec("BEGIN"); put.run("second", 10);
    expect(routineMessageAnchor(db, "thread", 40)).toBe("first");
    db.exec("ROLLBACK");
    expect(routineMessageAnchor(db, "thread", 75)).toBe("second");
  } finally { db.close(); }
});

it("an existing anchor tree gains the insert guard without rewriting its rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(thread_id,id))");
    initializeRoutineMessageLinks(db);
    db.exec("INSERT INTO messages VALUES('thread','first',500),('thread','second',100)");
    const current = String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='routine_link_before_insert'").get()!.sql);
    expect(current).toContain(" WHEN EXISTS(SELECT 1 FROM routine_link_members WHERE thread_id=NEW.thread_id AND id=NEW.id) BEGIN ");
    const old = current.replace(" WHEN EXISTS(SELECT 1 FROM routine_link_members WHERE thread_id=NEW.thread_id AND id=NEW.id)", "");
    db.exec(`DROP TRIGGER routine_link_before_insert; ${old}`);
    const snapshot = () => db.prepare("SELECT * FROM routine_link_nodes ORDER BY thread_id,node").all();
    const before = snapshot(), changes = db.prepare("SELECT total_changes() AS n").get()!.n;
    initializeRoutineMessageLinks(db);
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE name='routine_link_before_insert'").get()!.sql).toBe(current);
    expect(snapshot()).toEqual(before);
    expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(changes);
    expect(routineMessageAnchor(db, "thread", 400)).toBe("first");
    db.exec("INSERT OR REPLACE INTO messages VALUES('thread','first',50)");
    expect(routineMessageAnchor(db, "thread", 75)).toBe("second");
    initializeRoutineMessageLinks(db);
    expect(routineMessageAnchor(db, "thread", 75)).toBe("second");
  } finally { db.close(); }
});
