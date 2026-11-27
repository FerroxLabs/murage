// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyfable D1 (MAIN-RULING 2026-11-26T22:27:29Z + 2026-11-27T01:12:43Z): schema 13 -> 14 is a RENAME-CARRY. Owner: q1023-denyfable.
// Entry point of every row: the store's own open (database.ts database() -> migrateMemorySchema -> deny-rule-migrate.ts denyRuleUpgradeRows)
// on a 1.0.22-shaped file (schema 13, made by the memory-downgrade function from a walked store), N=10 and N=1000 dependent objects.
// Readers: deny-read.ts memoryLookup; undo: revoke-commit.ts undoRevoke + the runner. The fixture is deny-rule-migrate-1023.test.ts's.
// RED on the base (d2c1083fbc): W-D1a at the row comparison (the base copies memory_deny_memory through a filter and leaves out every
// object mark the rule implies), W-D1b at the storage comparison (the base fills a new table and builds both indexes again).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import * as messages from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { memoryLookup } from "./deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { commitRevoke, undoRevoke } from "./revoke-commit.ts";
import { DENY_RULE_V13_TABLES } from "./deny-rule-schema.ts";
import { downgradeMemorySchema, validateMemorySchema } from "./schema.ts";
import { testThreadNo } from "./testing/writetime-fixture.ts";

const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); });
const stopJobs = () => { INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation(); };
const drain = () => { transaction(db => runRevocationJobsNow(db)); };
const count = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)!.n);
const has = (name: string) => Boolean(database().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
const version = () => Number(database().prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()!.v);
const lastRevoke = () => Number(database().prepare("SELECT max(revoke_id) AS r FROM memory_revoke_jobs").get()!.r);
const OLD = ["memory_deny_line", "memory_deny_memory"], NEW = ["memory_deny_point", "memory_deny_object"];

// conversation T (an earlier reply, the owner line "root", N replies with one record each) and conversation K in another scope
// a note with no place in any conversation (no anchor line: its mark is an explicit row, which the migration must carry) and its record
interface Fixture { scope: string; n: number; sources: string[]; records: string[]; pre: { source: string; record: string }; kept: { source: string; record: string }; free: { source: string; record: string } }
const sourceOf = (thread: string, message: string) => `message:${thread}:${message}`;
function build(n: number): Fixture {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  setMemoryMode("active");
  const scope = ensureScope("bot", "bot");
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO memory_scopes VALUES('k-scope','room','k','[]',0)").run();
  let lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
  const message = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,?,'text','',?)");
  const lineage = db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','bot','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const capture = db.prepare("INSERT INTO memory_line_capture VALUES(?,?,?)");
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','a remembered detail','assistant-inference','active',0,1,NULL,NULL,1)");
  const evidence = db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)");
  let turn = 0;
  const owner = (thread: string, id: string) => { message.run(thread, id, "user", JSON.stringify({ id, role: "user" })); lineage.run(testThreadNo(db, thread), lsn, id, null); turn = lsn++; };
  /** A reply of the turn the last owner line began, captured as a source, with one record resting on it. */
  const reply = (thread: string, id: string, recordId: string, scopeId: string) => {
    message.run(thread, id, "bot", JSON.stringify({ id, role: "bot" }));
    lineage.run(testThreadNo(db, thread), lsn, id, turn);
    const sourceId = sourceOf(thread, id);
    source.run(sourceId, scopeId, thread, id, `h-${sourceId}`); version.run(sourceId, `h-${sourceId}`, JSON.stringify({ text: "words" }));
    capture.run(testThreadNo(db, thread), lsn, sourceId);
    record.run(recordId, scopeId); evidence.run(recordId, sourceId);
    lsn++;
    return { source: sourceId, record: recordId };
  };
  owner("T", "o-pre");
  const pre = reply("T", "pre", "rec-pre", scope);
  owner("T", "root");
  const sources: string[] = [], records: string[] = [];
  for (let i = 0; i < n; i++) { const made = reply("T", `g${i}`, `rec-${i}`, scope); sources.push(made.source); records.push(made.record); }
  owner("K", "k-o");
  const kept = reply("K", "k-g", "rec-kept", "k-scope");
  const free = { source: "note:free", record: "rec-free" };
  source.run(free.source, scope, null, null, "h-free"); version.run(free.source, "h-free", JSON.stringify({ text: "words" }));
  record.run(free.record, scope); evidence.run(free.record, free.source);
  db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn);
  db.exec("COMMIT");
  return { scope, n, sources, records, pre, kept, free };
}

/** The content verdict of every source and record of the fixture, through the production lookup. */
function verdicts(f: Fixture): Record<string, string> {
  const refs: MemoryRef[] = [...[f.pre.source, ...f.sources, f.kept.source, f.free.source].map(id => ({ kind: "source" as const, id, version: 1 })),
    ...[f.pre.record, ...f.records, f.kept.record, f.free.record].map(id => ({ kind: "record" as const, id, version: 1 }))];
  const got = memoryLookup(database(), refs, { audience: null });
  return Object.fromEntries(refs.map(ref => [`${ref.kind}:${ref.id}`, String(got.get(memoryRefKey(ref))?.state)]));
}
/** The 1.0.22 reader's own test of one object: an explicit mark row of a content revoke (deny-read.ts on 0e6228fcf8, memoryVerdict). */
const markedAs1022 = (kind: string, id: string) => count(`SELECT count(*) AS n FROM memory_deny_memory WHERE kind=? AND id=? AND version IN (0,1)
  AND revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience)`, kind, id) > 0; void markedAs1022;
const rowsOf = (revoke: number) => count("SELECT count(*) AS n FROM memory_deny_object WHERE revoke_id=?", revoke) + count("SELECT count(*) AS n FROM memory_deny_point WHERE revoke_id=?", revoke);
/** A forgotten line in T (undoable), a forgotten note with no anchor line and the deleted conversation K, all walked to their end. */
function revoked(n: number): { f: Fixture; forget: number; deletion: number } {
  const f = build(n);
  stopJobs();
  const forget = transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" }));
  transaction(tx => commitRevoke(tx, { kind: "memory", ref: { kind: "source", id: f.free.source }, cause: "forget" }));
  messages.deleteThread("K");
  const deletion = lastRevoke();
  drain();
  expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')")).toBe(0);
  return { f, forget, deletion };
}


const raw = (sql: string, ...args: Array<string | number>) => database().prepare(sql).all(...args) as Array<Record<string, unknown>>;
const objectRows = (table: string) => raw(`SELECT kind,id,version,revoke_id FROM ${table} ORDER BY kind,id,version,revoke_id`).map(row => `${row.kind}|${row.id}|${row.version}|${row.revoke_id}`);
const storage = (name: string) => { const row = raw("SELECT type,tbl_name,rootpage FROM sqlite_schema WHERE name=?", name)[0]; return row ? `${row.type} on ${row.tbl_name} @${row.rootpage}` : "missing"; };
const sqlOf = (name: string) => String(raw("SELECT sql FROM sqlite_schema WHERE name=?", name)[0]?.sql ?? "missing");
/** A walked 1.0.23 store stepped back to a 1.0.22 file (schema 13, both 1.0.22 mark tables filled with every mark the rule implied). */
function file1022(n: number) {
  const made = revoked(n);
  const before = verdicts(made.f);
  expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
  expect(version()).toBe(13);
  return { ...made, before };
}

describe("W-D1 13 -> 14 is a rename-carry: no object row is copied or left out, both tables and both revoke indexes stay where they are", () => {
  for (const n of [10, 1000]) {
    it(`W-D1a ${n} dependent objects: every 1.0.22 object row is an explicit schema 14 row under its own revoke id`, { timeout: 240_000 }, () => {
      const { forget, deletion } = file1022(n);
      const rows1022 = objectRows("memory_deny_memory");
      // (the fixture really holds marks the rule implies: one record row per dependent record under the forget, one under the deletion)
      expect(rows1022.filter(row => row.startsWith("record|") && row.endsWith(`|${forget}`)).length).toBe(n);
      expect(rows1022.filter(row => row.endsWith(`|${deletion}`)).length).toBeGreaterThan(0);
      closeDatabase();
      expect(version()).toBe(14);
      expect([...OLD.map(has), ...NEW.map(has)]).toEqual([false, false, true, true]);
      const carried = objectRows("memory_deny_object");
      expect(carried.length).toBe(rows1022.length);
      expect(carried).toEqual(rows1022);
    });

    it(`W-D1b ${n} dependent objects: the two tables and their revoke indexes are the 1.0.22 ones, renamed in place (nothing is filled or built again)`, { timeout: 240_000 }, () => {
      file1022(n);
      const at13 = { line: storage("memory_deny_line"), memory: storage("memory_deny_memory"), lineRevoke: storage("memory_deny_line_revoke"), memoryRevoke: storage("memory_deny_memory_revoke") };
      const page = (text: string) => text.slice(text.indexOf("@"));
      closeDatabase();
      expect(version()).toBe(14);
      const at14 = { point: storage("memory_deny_point"), object: storage("memory_deny_object"), lineRevoke: storage("memory_deny_line_revoke"), memoryRevoke: storage("memory_deny_memory_revoke") };
      // the same b-trees: a renamed table keeps its root page; a table filled by INSERT ... SELECT is another tree
      expect({ point: page(at14.point), object: page(at14.object) }).toEqual({ point: page(at13.line), object: page(at13.memory) });
      // the indexes followed their tables under their 1.0.22 names (an index cannot be renamed; building one again reads every row)
      expect({ lineRevoke: at14.lineRevoke, memoryRevoke: at14.memoryRevoke }).toEqual({ lineRevoke: `index on memory_deny_point ${page(at13.lineRevoke)}`, memoryRevoke: `index on memory_deny_object ${page(at13.memoryRevoke)}` });
      expect(raw("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name IN ('memory_deny_point','memory_deny_object') AND name NOT LIKE 'sqlite_%' ORDER BY name").map(row => row.name)).toEqual(["memory_deny_line_revoke", "memory_deny_memory_revoke"]);
      // one schema text for an upgraded file and a new one: the validator compares it exactly
      expect(() => validateMemorySchema(database())).not.toThrow();
      const upgraded = ["memory_deny_point", "memory_deny_object", "memory_deny_line_revoke", "memory_deny_memory_revoke"].map(sqlOf);
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      expect(version()).toBe(14);
      expect(["memory_deny_point", "memory_deny_object", "memory_deny_line_revoke", "memory_deny_memory_revoke"].map(sqlOf)).toEqual(upgraded);
    });

    it(`W-D1c ${n} dependent objects: every reader verdict is the same after the carry, an explicit row and the rule under one revoke id give one verdict, and undo takes both away`, { timeout: 240_000 }, () => {
      const { f, forget, before } = file1022(n);
      closeDatabase();
      expect(version()).toBe(14);
      expect(verdicts(f)).toEqual(before);
      // record 3 is withheld twice under the forget: by its carried explicit row and by the rule (its source's line is inside the range)
      expect(count("SELECT count(*) AS n FROM memory_deny_object WHERE kind='record' AND id=? AND revoke_id=?", f.records[3]!, forget)).toBe(1);
      const got = memoryLookup(database(), [{ kind: "record", id: f.records[3]!, version: 1 }], { audience: null }).get(memoryRefKey({ kind: "record", id: f.records[3]!, version: 1 }));
      expect(got?.state).toBe("withheld");
      transaction(tx => undoRevoke(tx, forget));
      drain();
      const after = verdicts(f);
      expect(Object.keys(after).filter(key => after[key] !== "shown").sort()).toEqual([`record:${f.kept.record}`, `source:${f.kept.source}`, `record:${f.free.record}`, `source:${f.free.source}`].sort());
      expect(rowsOf(forget)).toBe(0);
    });
  }

  it("W-D1d 14 -> 13, before and after the carry: the 1.0.22 names come back with their exact 1.0.22 text, the revoke indexes on the 1.0.22 tables, and every carried row", { timeout: 240_000 }, () => {
    revoked(10);
    const names = ["memory_deny_line", "memory_deny_memory", "memory_deny_line_revoke", "memory_deny_memory_revoke"] as const;
    const text1022 = names.map(name => DENY_RULE_V13_TABLES[name].replace(" IF NOT EXISTS", "").replace(/;$/, ""));
    /** The step back through the command's function; what the file holds afterwards, whether or not it threw. */
    const back = () => {
      let failed = "";
      try { downgradeMemorySchema(database(), 13); } catch (error) { failed = String((error as Error).message); }
      return { failed, version: version(), tables: [...OLD.map(has), ...NEW.map(has)], indexes: [storage("memory_deny_line_revoke").replace(/ @.*/, ""), storage("memory_deny_memory_revoke").replace(/ @.*/, "")] };
    };
    const whole = { failed: "", version: 13, tables: [true, true, false, false], indexes: ["index on memory_deny_line", "index on memory_deny_memory"] };
    expect(back()).toEqual(whole);
    expect(names.map(sqlOf)).toEqual(text1022);
    const rows1022 = objectRows("memory_deny_memory");
    closeDatabase();
    expect(version()).toBe(14);
    expect(back()).toEqual(whole);
    expect(names.map(sqlOf)).toEqual(text1022);
    expect(objectRows("memory_deny_memory")).toEqual(rows1022);
    expect(() => validateMemorySchema(database())).not.toThrow();
  });
});
