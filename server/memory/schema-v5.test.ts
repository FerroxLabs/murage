// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { DEFAULT_MEMORY_LEARNING } from "./learning-policy.ts";
import { LEARNING_EVENT_KINDS_V5 } from "./learning-kinds.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA_V4, migrateMemorySchema, validateMemorySchema } from "./schema.ts";

const V5_TABLES = ["memory_outcomes", "memory_feedback", "memory_lessons", "memory_episodes", "memory_learning_runs", "memory_backfill_cursors"];
const tables = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as { name: string }[]).map(row => row.name));
const settingsOf = (db: DatabaseSync) => String(db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get()?.settings);

/** A real v4 file: the frozen v4 text, one scope and some ledger rows. */
function v4Fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(MEMORY_SCHEMA_V4);
  db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,4,?,'off')").run(randomUUID());
  db.prepare("INSERT INTO memory_learning_config VALUES(1,3,?)").run(JSON.stringify(DEFAULT_MEMORY_LEARNING));
  db.exec("INSERT INTO memory_scopes VALUES('s','conversation','t','[]',0)");
  for (const [id, kind] of [["e1", "activated"], ["e2", "owner-undo"]]) db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,created_at) VALUES(?,'s',?,5)").run(id, kind);
  return db;
}

it("the v4 fixture really is v4 and validates", () => {
  const db = v4Fixture();
  try {
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(4);
    for (const name of V5_TABLES) expect(tables(db).has(name), name).toBe(false);
  } finally { db.close(); }
});

it("upgrades a v4 file to v5: six new tables, indexes, existing events and settings kept", () => {
  const db = v4Fixture();
  try {
    const settingsBefore = settingsOf(db);
    migrateMemorySchema(db);
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
    for (const name of V5_TABLES) expect(tables(db).has(name), name).toBe(true);
    const indexes = (db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'memory_%'").all() as { name: string }[]).map(row => row.name);
    expect(indexes).toEqual(expect.arrayContaining(["memory_outcomes_bot_created", "memory_feedback_bot_created", "memory_episodes_bot_group_week", "memory_lessons_bot_state"]));
    expect((db.prepare("SELECT id FROM memory_learning_events ORDER BY id").all() as { id: string }[]).map(row => row.id)).toEqual(["e1", "e2"]);
    expect(settingsOf(db)).toBe(settingsBefore);
    expect(db.prepare("SELECT revision FROM memory_learning_config").get()?.revision).toBe(3);
    validateMemorySchema(db);
    migrateMemorySchema(db); // idempotent
  } finally { db.close(); }
});

it("a fresh install is v5 with the new kinds accepted by the events table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateMemorySchema(db);
    db.exec("INSERT INTO memory_scopes VALUES('s','conversation','t','[]',0)");
    for (const kind of LEARNING_EVENT_KINDS_V5) db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,created_at) VALUES(?,'s',?,1)").run(randomUUID(), kind);
    expect(() => db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,created_at) VALUES('x','s','not-a-kind',1)").run()).toThrow();
    validateMemorySchema(db);
  } finally { db.close(); }
});

it("v5 tables enforce the section 15 constraints", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateMemorySchema(db);
    const outcome = (kind: string, proposedBy = "owner", confirmedBy: string | null = "owner", key: string | null = null) =>
      db.prepare("INSERT INTO memory_outcomes(id,bot_id,kind,proposed_by,confirmed_by,source_event_key,created_at) VALUES(?,'b',?,?,?,?,1)").run(randomUUID(), kind, proposedBy, confirmedBy, key);
    for (const kind of ["won", "lost", "good", "bad", "open", "metric"]) outcome(kind);
    expect(() => outcome("great")).toThrow();
    expect(() => outcome("won", "stranger")).toThrow();
    expect(() => outcome("won", "bot", "bot")).toThrow(); // only the owner confirms
    outcome("won", "bot", null, "k1");
    expect(() => outcome("won", "bot", null, "k1")).toThrow(); // source_event_key is unique
    const feedback = (polarity: string, strength: number, state: string, scope: string) =>
      db.prepare("INSERT INTO memory_feedback(id,bot_id,polarity,strength,state,scope,created_at) VALUES(?,'b',?,?,?,?,1)").run(randomUUID(), polarity, strength, state, scope);
    feedback("+", 1, "detected", "chat"); feedback("-", 3, "lesson", "bot");
    expect(() => feedback("0", 1, "detected", "chat")).toThrow();
    expect(() => feedback("+", 4, "detected", "chat")).toThrow();
    expect(() => feedback("+", 1, "applied", "chat")).toThrow();
    expect(() => feedback("+", 1, "detected", "team")).toThrow();
    const lesson = (text: string, scope = "bot", kind = "note", origin = "typed", state = "active") =>
      db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES(?,1,'b',?,?,?,?,?,1)").run(randomUUID(), scope, kind, text, origin, state);
    lesson("x".repeat(280));
    expect(() => lesson("x".repeat(281))).toThrow();
    expect(() => lesson("ok", "world")).toThrow();
    expect(() => lesson("ok", "bot", "mood")).toThrow();
    expect(() => lesson("ok", "bot", "tone")).toThrow(); // the old kinds are gone
    expect(() => lesson("ok", "bot", "note", "guess")).toThrow();
    expect(() => lesson("ok", "bot", "note", "typed", "deleted")).toThrow();
    expect(() => db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,recipients,created_at) VALUES('r',1,'b','bots','note','t','typed','active','not json',1)").run()).toThrow();
    // Tier 1: scopes thread and owner exist; a style needs its spec, a note must not have one; where must be one of three; the spec must be JSON
    lesson("ok", "thread"); lesson("ok", "owner");
    const styled = (kind: string, spec: string | null, where: string | null = "everywhere") => db.prepare("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at,spec,where_) VALUES(?,1,'b','bot',?,'t','feedback','suggested',1,?,?)").run(randomUUID(), kind, spec, where);
    styled("style", '{"kind":"length","value":"brief"}'); styled("note", null, null);
    expect(() => styled("style", null)).toThrow(); expect(() => styled("note", '{"kind":"length","value":"brief"}')).toThrow();
    expect(() => styled("style", '{"kind":"length","value":"brief"}', "elsewhere")).toThrow(); expect(() => styled("style", "not json")).toThrow();
    expect(() => db.prepare("INSERT INTO memory_episodes(id,bot_id,classification) VALUES('ep','b','stranger')").run()).toThrow();
    db.prepare("INSERT INTO memory_episodes(id,bot_id,classification,leakage_group,week) VALUES('ep','b','owner','g','2026-W40')").run();
  } finally { db.close(); }
});

it("downgrades v5 to v4 exactly: tables gone, new-kind events removed, old events kept, then re-upgrades", () => {
  const db = v4Fixture();
  try {
    migrateMemorySchema(db);
    db.exec("INSERT INTO memory_learning_events(id,scope_id,kind,created_at) VALUES('n1','s','lesson-learned',9)");
    db.exec("INSERT INTO memory_outcomes(id,bot_id,kind,proposed_by,created_at) VALUES('o','b','won','owner',1)");
    expect(downgradeMemorySchema(db, 4)).toEqual({ status: "downgraded", from: 6, to: 4 });
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(4);
    for (const name of V5_TABLES) expect(tables(db).has(name), name).toBe(false);
    expect((db.prepare("SELECT id FROM memory_learning_events ORDER BY id").all() as { id: string }[]).map(row => row.id)).toEqual(["e1", "e2"]);
    validateMemorySchema(db);
    expect(downgradeMemorySchema(db, 4)).toEqual({ status: "already-v4", from: 4, to: 4 });
    migrateMemorySchema(db);
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
    validateMemorySchema(db);
    for (const to of [4, 3, 2, 1] as const) { downgradeMemorySchema(db, to); validateMemorySchema(db); migrateMemorySchema(db); validateMemorySchema(db); }
  } finally { db.close(); }
});

it("an active lesson without its learning event row is refused by the full validation sweep", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateMemorySchema(db);
    db.exec("INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('l',1,'b','bot','note','t','typed','active',1)");
    expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_LESSON_EVENT");
  } finally { db.close(); }
});

/** The v5 text the earlier development build wrote (before Tier 1): old kinds, no spec, no scope thread/owner. */
const DEV_V5_LESSONS = `CREATE TABLE memory_lessons (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), parent_id TEXT, bot_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('bot','bots','team')),
 recipients TEXT CHECK(recipients IS NULL OR json_valid(recipients)),
 kind TEXT NOT NULL CHECK(kind IN ('preference','tone','timing','tool-hint','priority')),
 text TEXT NOT NULL CHECK(length(text)<=280),
 origin TEXT NOT NULL CHECK(origin IN ('feedback','edit','mark','typed','suggested')),
 state TEXT NOT NULL CHECK(state IN ('active','suggested','undone','retired','unsupported','stale')),
 evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
 prospect_derived INTEGER NOT NULL DEFAULT 0 CHECK(prospect_derived IN (0,1)), learning_event_id TEXT,
 created_at INTEGER NOT NULL CHECK(created_at>=0), decided_at INTEGER,
 PRIMARY KEY(id,version))`;
const DEV_V5_FEEDBACK = `CREATE TABLE memory_feedback (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, message_id TEXT, target_message_id TEXT,
 target_turn_id TEXT, target_action TEXT,
 polarity TEXT NOT NULL CHECK(polarity IN ('+','-')), strength INTEGER NOT NULL CHECK(strength IN (1,2,3)),
 correction TEXT, confidence REAL,
 state TEXT NOT NULL CHECK(state IN ('detected','lesson','ignored','unsure','expired')),
 scope TEXT NOT NULL CHECK(scope IN ('chat','bot')),
 acknowledged_at INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0))`;

it("a database the earlier development v5 wrote is rebuilt in place on open, keeping its rows (Tier 1 amended v5 in place)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateMemorySchema(db);
    downgradeMemorySchema(db, 5); // a real v5 file (the development v5 predates the v6 lineage tables)
    // put the two tables back into the earlier shape
    db.exec(`DROP INDEX memory_lessons_bot_state; DROP INDEX memory_feedback_bot_created; DROP TABLE memory_lessons; DROP TABLE memory_feedback; ${DEV_V5_LESSONS}; ${DEV_V5_FEEDBACK};
      CREATE INDEX memory_lessons_bot_state ON memory_lessons(bot_id,state); CREATE INDEX memory_feedback_bot_created ON memory_feedback(bot_id,created_at);`);
    expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
    db.exec(`INSERT INTO memory_lessons(id,version,bot_id,scope,kind,text,origin,state,created_at) VALUES('l1',1,'b','bot','tone','No emojis','typed','suggested',1),('l2',1,'b','bots','preference','Shared','suggested','suggested',2);
      INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,polarity,strength,correction,state,scope,created_at) VALUES('f1','b','t','m','-',2,'x','detected','chat',3)`);
    migrateMemorySchema(db);
    validateMemorySchema(db, { references: true });
    expect(db.prepare("SELECT id,scope,kind,text FROM memory_lessons ORDER BY id").all()).toEqual([
      { id: "l1", scope: "owner", kind: "note", text: "No emojis" }, { id: "l2", scope: "bots", kind: "note", text: "Shared" }]);
    expect(db.prepare("SELECT id,correction FROM memory_feedback").all()).toEqual([{ id: "f1", correction: "x" }]);
    expect(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version).toBe(6);
    // and a second open changes nothing
    migrateMemorySchema(db);
    expect(db.prepare("SELECT COUNT(*) c FROM memory_lessons").get()?.c).toBe(2);
  } finally { db.close(); }
});
