// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema 12 over int/1.0.3's REAL v11 (Astra lineage-combined-early): testdata/v11-int-103.db.gz was written by int/1.0.3's own code
// (2856b1f03: migrateMemorySchema at v11, custom v3 learning settings, a month ledger row, two sessions), never by this branch's downgrade.
// It goes 11 -> 12 -> 11 -> 12 with its v3 settings and int's v11 text intact, and down to 10 into a file 1.0.2's own validator accepts
// (testing/schema-1.0.2.ts). A downgrade to 10 or 11 never leaves a raw resume cursor whose later incarnation (`s#2`) holds what was revoked,
// and a re-upgrade never hands out an incarnation a downgrade left behind.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { beforeEach, expect, it, onTestFinished } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { downgradeInstallationMemorySchema } from "../installation-memory-downgrade.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { memoryLearningV2Schema, memoryLearningV3Schema } from "./learning-policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MEMORY_SCHEMA_V11, downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { allocateIncarnation, latestIncarnation } from "./session-incarnation.ts";
import * as v102 from "./testing/schema-1.0.2.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

const MESSAGES = "CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id));";
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version);
const settings = (db: DatabaseSync) => JSON.parse(String(db.prepare("SELECT settings FROM memory_learning_config").get()!.settings));
const memoryObjects = (db: DatabaseSync) => new Map((db.prepare("SELECT name,sql FROM sqlite_schema WHERE name LIKE 'memory\\_%' ESCAPE '\\' OR tbl_name LIKE 'memory\\_%' ESCAPE '\\'").all() as Array<{ name: string; sql: string | null }>).map(row => [row.name, row.sql]));
const sessions = (db: DatabaseSync) => db.prepare("SELECT native_session FROM memory_session_lineage ORDER BY native_session").all().map(row => row.native_session);

/** The real v11 file, unpacked into its own directory. */
function realV11(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "real-v11-"));
  onTestFinished(() => removeTempDirSync(dir));
  const file = join(dir, "messages.db");
  writeFileSync(file, gunzipSync(readFileSync(new URL("./testdata/v11-int-103.db.gz", import.meta.url))));
  const db = new DatabaseSync(file);
  onTestFinished(() => { if (db.isOpen) db.close(); });
  return db;
}
/** 1.0.2's own checks: its validator (it refuses any memory object it does not know or whose text differs), and every object of 1.0.2's
 * schema text is in the file with that exact text. */
function expectOpensIn102(db: DatabaseSync) {
  expect(() => v102.validateMemorySchema(db)).not.toThrow();
  const fresh = new DatabaseSync(":memory:");
  try {
    fresh.exec(MESSAGES); fresh.exec(v102.MEMORY_SCHEMA);
    const file = memoryObjects(db);
    for (const [name, sql] of memoryObjects(fresh)) expect({ name, sql: file.get(name) }).toEqual({ name, sql });
  } finally { fresh.close(); }
}

it("a real v11 file (int/1.0.3's code) goes 11 -> 12 -> 11 -> 12 with its v3 settings and int's v11 text, and down to 10 for 1.0.2's validator", () => {
  const db = realV11();
  expect(version(db)).toBe(11);
  const v3 = settings(db);
  expect(memoryLearningV3Schema.parse(v3)).toMatchObject({ version: 3, reviewMode: true, botsPaused: ["bot-a"], ceiling: { input: 0, output: 0 } });
  const v11 = memoryObjects(db);
  expect(v11.get("memory_meta")).toContain("CHECK(schema_version=11)");
  expect(() => validateMemorySchema(db)).not.toThrow();

  migrateMemorySchema(db);
  expect(version(db)).toBe(13);
  expect(settings(db)).toEqual(v3);
  expect(db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id='learning-spend:2026-10'").get()).toBeTruthy();
  expect(() => validateMemorySchema(db)).not.toThrow();

  expect(downgradeMemorySchema(db, 11)).toMatchObject({ status: "downgraded", from: 13, to: 11 });
  expect(version(db)).toBe(11);
  expect(settings(db)).toEqual(v3);
  // every memory object left is one int's v11 holds, with int's exact text (derived lane-2 objects may leave; int's next open makes them)
  // int's v11 gained the revoke fold's map after this file was written (2856b1f03): int's current v11 makes it, with this text
  const laterV11 = new Map([["memory_revoke_fold", "CREATE TABLE memory_revoke_fold (old_id INTEGER PRIMARY KEY NOT NULL, bulk_id INTEGER NOT NULL)"], ["memory_revoke_fold_bulk", "CREATE INDEX memory_revoke_fold_bulk ON memory_revoke_fold(bulk_id)"]]);
  for (const [name, sql] of memoryObjects(db)) expect({ name, sql }).toEqual({ name, sql: v11.has(name) ? v11.get(name) : laterV11.get(name) });
  for (const name of ["memory_meta", "memory_lineage_lsn_meta", "memory_session_lineage", "memory_watermark_bump", "memory_learning_config"]) expect(memoryObjects(db).get(name)).toBe(v11.get(name));
  const text = new DatabaseSync(":memory:");
  try { text.exec(MEMORY_SCHEMA_V11); expect(memoryObjects(db).get("memory_session_lineage")).toBe(memoryObjects(text).get("memory_session_lineage")); } finally { text.close(); }
  expect(() => validateMemorySchema(db)).not.toThrow();

  migrateMemorySchema(db);
  expect(version(db)).toBe(13);
  expect(settings(db)).toEqual(v3);
  expect(sessions(db)).toEqual(["s1", "s2"]);
  expect(() => validateMemorySchema(db)).not.toThrow();

  expect(downgradeMemorySchema(db, 10)).toMatchObject({ status: "downgraded", from: 13, to: 10 });
  expect(memoryLearningV2Schema.parse(settings(db))).toMatchObject({ version: 2, reviewMode: true, dailyInputTokens: 0, dailyOutputTokens: 0, botsPaused: ["bot-a"] });
  expect(db.prepare("SELECT text FROM messages").get()!.text).toBe("a chat line");
  expect(db.prepare("SELECT text FROM memory_records WHERE id='r1'").get()!.text).toBe("Owner likes tea");
  expectOpensIn102(db);
});

/** The older readers (1.0.2 at v10, int/1.0.3 at v11) key a resumed session by its raw cursor: it resumes when the task still holds the
 * cursor and the raw key carries no deny mark and no revoked receipt. */
function olderReaderResumes(thread: string, instance: string, session: string): boolean {
  const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8")) as Array<{ tasks: Array<{ threadId: string; resumeCursors: Record<string, string> }> }>;
  if (bots.flatMap(bot => bot.tasks).find(task => task.threadId === thread)?.resumeCursors?.[instance] !== session) return false;
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    if (db.prepare("SELECT 1 FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, instance, session)) return false;
    return !db.prepare("SELECT 1 FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND state='revoked'").get(thread, instance, session);
  } finally { db.close(); }
}

for (const to of [10, 11] as const) {
  it(`12 -> ${to}: a raw cursor whose later incarnation was revoked is cleared, so the older reader never judges it by the earlier clean session`, () => {
    setMemoryMode("capture"); // the real current-version file: every application and memory table
    database().exec(`INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn,door_epoch) VALUES('th','drv','sess-1',1,2,1),('th','drv','sess-1#2',3,4,1),('th2','drv','sess-9',1,2,1);
      INSERT INTO memory_session_incarnation VALUES('th','drv','sess-1',1),('th','drv','sess-1',2),('th2','drv','sess-9',1);
      INSERT INTO memory_deny_session VALUES('th','drv','sess-1#2',7);`);
    closeDatabase();
    writeFileSync(join(DATA_DIR, "bots.json"), JSON.stringify([{ id: "b1", threadId: "th", resumeCursors: { drv: "sess-1" }, tasks: [
      { threadId: "th", resumeCursors: { drv: "sess-1" }, resumeIncarnations: { drv: 2 } }, { threadId: "th2", resumeCursors: { drv: "sess-9" } }] }]));
    // the engine session behind "sess-1" is incarnation 2 (revoked), but the raw key is incarnation 1's clean row
    expect(olderReaderResumes("th", "drv", "sess-1")).toBe(true);

    downgradeInstallationMemorySchema(DATA_DIR, to);

    expect(olderReaderResumes("th", "drv", "sess-1")).toBe(false);
    const bots = JSON.parse(readFileSync(join(DATA_DIR, "bots.json"), "utf8"));
    expect(bots[0].resumeCursors).toEqual({});
    expect(bots[0].tasks[0].resumeCursors).toEqual({});
    expect(bots[0].tasks[0].resumeIncarnations ?? {}).toEqual({});
    // a session with no later incarnation keeps its cursor
    expect(bots[0].tasks[1].resumeCursors).toEqual({ drv: "sess-9" });
    expect(olderReaderResumes("th2", "drv", "sess-9")).toBe(true);
    const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(version(db)).toBe(to);
      if (to === 10) expectOpensIn102(db); else expect(() => validateMemorySchema(db)).not.toThrow();
    } finally { db.close(); }
  });
}

for (const to of [11, 10] as const) {
  it(`12 -> ${to} -> 12 never hands out an incarnation a downgrade left behind`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(MESSAGES); migrateMemorySchema(db);
      const row = db.prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn,door_epoch) VALUES('t','d',?,1,2,1)");
      expect(allocateIncarnation(db, "t", "d", "s")).toBe(1); row.run("s");
      expect(allocateIncarnation(db, "t", "d", "s")).toBe(2); row.run("s#2");
      // incarnation 3 was allocated, its session row never written; a revoke still marked it
      expect(allocateIncarnation(db, "t", "d", "s")).toBe(3);
      db.exec("INSERT INTO memory_deny_session VALUES('t','d','s#3',1)");
      row.run("u");
      expect(downgradeMemorySchema(db, to)).toMatchObject({ status: "downgraded", from: 13, to });
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_session_incarnation'").get()).toBeUndefined();
      migrateMemorySchema(db);
      expect(version(db)).toBe(13);
      expect(latestIncarnation(db, "t", "d", "s")).toBe(3);
      expect(allocateIncarnation(db, "t", "d", "s")).toBe(4);
      // an id no later incarnation used is as before: its raw row counts as 1
      expect(allocateIncarnation(db, "t", "d", "u")).toBe(2);
      expect(() => validateMemorySchema(db)).not.toThrow();
    } finally { db.close(); }
  });
}
