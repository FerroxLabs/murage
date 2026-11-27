// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyrule, schema 14 witnesses (MAIN-RULING OPUS DENYRULE H1, H2, H5, D-1, M6). Owner: q1023-denyrule.
// Entry points: the store's own open (database.ts database(): migrateMemorySchema runs there, before anything listens), the
// memory-downgrade command's function (schema.ts downgradeMemorySchema), deleteThread, commitRevoke / undoRevoke and the reader memoryLookup.
// RED on the base (0e6228fcf8) at the first assertion of W-C1: the base store is schema 13 and holds the two 1.0.22 mark tables.
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
  AND revoke_id NOT IN (SELECT revoke_id FROM memory_revoke_audience)`, kind, id) > 0;
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

describe("W-C1 schema 14: 1.0.23 -> memory-downgrade --to 13 -> 1.0.23 keeps every verdict, every revoke id and the deletion receipt", () => {
  for (const n of [10, 1000]) it(`${n} dependent objects`, { timeout: 240_000 }, () => {
    const { f, forget, deletion } = revoked(n);
    // D-1: a 1.0.23 store is schema 14 and holds neither 1.0.22 mark table
    expect(version()).toBe(14);
    expect([...OLD.map(has), ...NEW.map(has)]).toEqual([false, false, true, true]);
    const before = verdicts(f);
    expect(before[`record:${f.records[3]}`]).toBe("withheld");
    expect(before[`source:${f.kept.source}`]).toBe("withheld");
    expect(before[`record:${f.pre.record}`]).toBe("shown");
    // the note is withheld by a row of its own (nothing implies it), its record through that row
    expect([before[`source:${f.free.source}`], before[`record:${f.free.record}`]]).toEqual(["withheld", "withheld"]);
    expect(count("SELECT count(*) AS n FROM memory_deny_object WHERE kind='source' AND id=?", f.free.source)).toBe(1);
    expect(rowsOf(forget)).toBeLessThanOrEqual(4);

    // H5: the step back rebuilds the 1.0.22 marks before a 1.0.22 build may open the file
    expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
    expect(version()).toBe(13);
    expect([...OLD.map(has), ...NEW.map(has)]).toEqual([true, true, false, false]);
    validateMemorySchema(database());
    // every object 1.0.23 withheld through the rule has the explicit row a 1.0.22 reader needs, and no shown object has one
    const wrong = Object.entries(before).filter(([key, state]) => markedAs1022(key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)) !== (state === "withheld")).map(([key]) => key);
    expect(wrong).toEqual([]);
    // (under each revoke's own id: the forgotten line's marks are the forget's, the deleted conversation's are the deletion's)
    expect(count("SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND revoke_id=?", forget)).toBe(n);
    expect(count("SELECT count(*) AS n FROM memory_deny_memory WHERE kind='record' AND id='rec-kept' AND revoke_id=?", deletion)).toBe(1);

    // M6: the next 1.0.23 open migrates before anything else reads the store; the old tables are gone at its commit
    closeDatabase();
    expect(() => database()).not.toThrow();
    expect(version()).toBe(14);
    expect([...OLD.map(has), ...NEW.map(has)]).toEqual([false, false, true, true]);
    expect(verdicts(f)).toEqual(before);
    // the materialized LINE marks collapse again: the rule implies them under the same revoke id. The object marks do not (D1,
    // MAIN-RULING 2026-11-26T22:27:29Z rename-carry: memory_deny_memory is renamed, every row stays explicit under its own revoke id;
    // was: rowsOf(forget) <= 4 over both tables; deny-rule-rename-carry-1023.test.ts holds the object rows exactly)
    expect(count("SELECT count(*) AS n FROM memory_deny_point WHERE revoke_id=?", forget)).toBeLessThanOrEqual(4);
    // H1: the start-up replay of the deletion finds its receipt and commits nothing
    const jobs = lastRevoke(), generation = () => Number(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()!.value), g = generation();
    messages.deleteThread("K");
    expect([lastRevoke(), generation()]).toEqual([jobs, g]);
    // H2: undo after the migration restores exactly what the forget withheld, under its own id, and nothing of the deletion
    transaction(tx => undoRevoke(tx, forget));
    drain();
    const after = verdicts(f);
    expect(Object.keys(after).filter(key => after[key] !== "shown").sort()).toEqual([`record:${f.kept.record}`, `source:${f.kept.source}`, `record:${f.free.record}`, `source:${f.free.source}`].sort());
    expect(rowsOf(forget)).toBe(0);
  });

  it("M6: a crash before the migration's commit leaves the 1.0.22 file as it was, and the next open migrates it", async () => {
    const { f } = revoked(10);
    const before = verdicts(f);
    // (the base store is schema 13 and never migrates: RED here on 0e6228fcf8, before anything below is tried)
    expect(version()).toBe(14);
    expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
    const marks = count("SELECT count(*) AS n FROM memory_deny_memory") + count("SELECT count(*) AS n FROM memory_deny_line");
    closeDatabase();
    // (a computed specifier, so the identical file runs on the base, which has no migration step: there the open below does not throw)
    const hookModule = "./deny-rule-migrate" + ".ts";
    const DENY_RULE_MIGRATE_TESTING: { beforeCommit: null | (() => void) } = await import(/* @vite-ignore */ hookModule).then(m => m.DENY_RULE_MIGRATE_TESTING, () => ({ beforeCommit: null }));
    DENY_RULE_MIGRATE_TESTING.beforeCommit = () => { throw new Error("crash before commit"); };
    try { expect(() => database()).toThrow(); } finally { DENY_RULE_MIGRATE_TESTING.beforeCommit = null; closeDatabase(); }
    // the old tables are still the whole truth (read with a plain connection: the store did not open)
    const { DatabaseSync } = await import("node:sqlite");
    const { join } = await import("node:path");
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(Number(raw.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()!.v)).toBe(13);
      expect(Number(raw.prepare("SELECT (SELECT count(*) FROM memory_deny_memory)+(SELECT count(*) FROM memory_deny_line) AS n").get()!.n)).toBe(marks);
      expect(raw.prepare("SELECT name FROM sqlite_schema WHERE name IN ('memory_deny_point','memory_deny_object')").all()).toEqual([]);
    } finally { raw.close(); }
    expect(version()).toBe(14);
    expect(verdicts(f)).toEqual(before);
  });

  it("a bulk job's line rows are carried whole: its range row may still be rewritten with a lower bound, so no row of it is left to the rule", { timeout: 240_000 }, () => {
    const { f, forget, deletion } = revoked(10);
    expect(version()).toBe(14);
    const before = verdicts(f);
    expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
    // the 1.0.22 file: one line mark per generated line of the forgotten turn; make the forget a bulk job's (its job row, kind 'bulk')
    const db = database();
    expect(count("SELECT count(*) AS n FROM memory_deny_line WHERE revoke_id=? AND thread_id='T'", forget)).toBeGreaterThanOrEqual(10);
    const columns = (db.prepare("SELECT name FROM pragma_table_info('memory_revoke_jobs')").all() as Array<{ name: string }>).map(column => column.name);
    db.prepare("DELETE FROM memory_revoke_jobs WHERE revoke_id=?").run(forget);
    db.prepare(`INSERT INTO memory_revoke_jobs(${columns.join(",")}) SELECT ${columns.map(name => name === "revoke_id" ? "?" : name === "kind" ? "'bulk'" : name).join(",")} FROM memory_revoke_jobs WHERE revoke_id=?`).run(forget, deletion);
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND kind='bulk'", forget)).toBe(1);
    const lines = count("SELECT count(*) AS n FROM memory_deny_line WHERE revoke_id=?", forget);
    closeDatabase();
    expect(version()).toBe(14);
    expect(count("SELECT count(*) AS n FROM memory_deny_point WHERE revoke_id=?", forget)).toBe(lines);
    expect(verdicts(f)).toEqual(before);
  });
});

// FABLE c096551b81 H3 (deny-rule-migrate.ts unfinishedBulk): a 1.0.22 store with a bulk job still walking. Its range row on T covers the
// generated reply g0; a later root of the bulk may rewrite that row with a proven, lower bound (revoke-marker.ts writeRange, BOUNDED_RANGE).
// The 13 -> 14 step must not drop a mark of that bulk because its range implies it today. One row per site that reads the range for a drop:
// the line row (DENY_RULE_UP_SQL.point) and the source row (before D1 a filtered copy; since the rename-carry every object row is carried). Entry points: the store's
// own open (migration), revoke-marker.ts writeRange, deny-read.ts memoryLookup. On the base the open after the step back does not migrate
// (schema 13), so the first assertion after it (version 14) is RED there.
describe("W-C3 an unfinished bulk job keeps every mark its range implies at the upgrade", () => {
  for (const site of ["line row", "source row only"] as const) it(site, { timeout: 120_000 }, async () => {
    const f = build(3);
    stopJobs();
    expect(downgradeMemorySchema(database(), 13).status).toBe("downgraded");
    const db = database(), no = testThreadNo(db, "T");
    const at = (id: string) => db.prepare("SELECT lsn,turn_lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no, id) as { lsn: number; turn_lsn: number | null };
    const root = at("root"), g0 = at("g0"), B = lastRevoke() + 1;
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(?,'bulk','{}',?,?,'mark','','active')").run(B, root.lsn, root.lsn);
    db.prepare("INSERT INTO memory_deny_range(thread_id,from_lsn,until_turn_lsn,revoke_id,reason) VALUES('T',?,?,?,'forget')").run(root.lsn, Number(g0.turn_lsn) + 1000, B);
    if (site === "line row") db.prepare("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('T',?,?,0,'forget')").run(g0.lsn, B);
    db.prepare("INSERT INTO memory_deny_memory(kind,id,version,revoke_id) VALUES('source',?,0,?),('record','rec-0',1,?)").run(f.sources[0], B, B);
    db.exec("COMMIT");
    closeDatabase();
    database();
    expect(version()).toBe(14);
    expect(verdicts(f)[`source:${f.sources[0]}`]).toBe("withheld");
    // the bulk's next root proves a lower bound for the same row: its range no longer covers g0's turn
    const { writeRange, BOUNDED_RANGE } = await import("./revoke-marker.ts");
    transaction(tx => writeRange(tx, B, "T", root.lsn, Number(g0.turn_lsn), `forget${BOUNDED_RANGE}`));
    const after = verdicts(f);
    expect([after[`source:${f.sources[0]}`], after["record:rec-0"]]).toEqual(["withheld", "withheld"]);
  });
});
