// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Memory schema v9 (1.0.2 cold lineage): the covering index on the output index and the index on sources by kind and outcome.
// The plans are pinned (the figure is the contract: no table read for the listings, no full read of the sources at start), the
// upgrade from v8 leaves them to a background build after start (a v9 file may lack them: the validator accepts it, settlement falls back to the
// key range, writers wait while a statement runs), and the downgrade to v8 drops them again.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, holdWritersForIndexBuild, writersHeldForIndexBuild } from "../database.ts";
import type { BlockingStep } from "./blocking-heartbeat.ts";
import { buildColdLineageIndexesNow, startColdLineageIndexBuild } from "./cold-index-build.ts";
import { reconcileInterruptedMemoryTurns } from "./settlement.ts";
import { LISTING_SQL } from "./replay-lineage.ts";
import { downgradeMemorySchema, MEMORY_SCHEMA, MEMORY_SCHEMA_V8, MEMORY_SCHEMA_VERSION, migrateMemorySchema, OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX, validateMemorySchema } from "./schema.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const open = (): DatabaseSync => { const db = new DatabaseSync(":memory:"); dbs.push(db); return db; };
const plan = (db: DatabaseSync, sql: string, binds = 0): string[] => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array<string>(binds).fill("x")).map(row => String(row.detail));
const indexes = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name IN (?,?)").all(OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX) as { name: string }[]).map(row => row.name).sort();
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version);

it("the merged listing statement reads the output index from the covering index alone, and the output-thread scans are covered", () => {
  const db = open();
  db.exec(MEMORY_SCHEMA);
  const listing = plan(db, LISTING_SQL, 4).join("\n");
  expect(listing).toContain(`SEARCH memory_disclosure_outputs USING COVERING INDEX ${OUTPUT_COVER_INDEX} (thread_id=? AND message_id=?)`);
  expect(listing).not.toMatch(/SCAN memory_disclosure_outputs/);
  // the lookups by (thread, message) that need the bundle
  for (const sql of [
    "SELECT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id=?",
    "SELECT DISTINCT bundle_id FROM memory_disclosure_outputs WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?))",
  ]) expect(plan(db, sql, 2).join("\n")).toContain(`USING COVERING INDEX ${OUTPUT_COVER_INDEX}`);
  // the scans of one thread's outputs, and the thread-to-thread skip scan: answered from an index, never the table
  for (const sql of [
    "SELECT DISTINCT message_id FROM memory_disclosure_outputs WHERE thread_id=?",
    "SELECT count(DISTINCT message_id) AS n FROM memory_disclosure_outputs WHERE thread_id=?",
    "SELECT thread_id FROM memory_disclosure_outputs WHERE thread_id>? ORDER BY thread_id LIMIT 1",
  ]) expect(plan(db, sql, 1).join("\n")).toMatch(/SEARCH memory_disclosure_outputs USING COVERING INDEX memory_disclosure_outputs_(message|cover)/);
});

it("the settlement scan at start finds the working turns through the kind and outcome index", () => {
  const db = open();
  db.exec(MEMORY_SCHEMA);
  expect(plan(db, "SELECT id,thread_id,turn_id FROM memory_sources WHERE kind='turn' AND outcome='working'").join("\n"))
    .toContain(`SEARCH memory_sources USING INDEX ${SOURCE_KIND_INDEX} (kind=? AND outcome=?)`);
});

it("an upgrade from v8 leaves the two indexes to the background build, keeps every row, and validates; a v8 archive is still accepted", () => {
  const db = open();
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 8); // the file a 1.0.2 build before the indexes wrote
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id ?? "s");
  if (!db.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(scope)) db.prepare("INSERT INTO memory_scopes VALUES(?,'workspace','o','[]',0)").run(scope);
  db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('turn:t:1',?,'t','m','1',0,'h','turn','harness','working',NULL,'active')").run(scope);
  expect(indexes(db)).toEqual([]);
  expect(version(db)).toBe(8);
  expect(validateMemorySchema(db)).toBeInstanceOf(Set); // a v8 archive is accepted as it is
  expect(MEMORY_SCHEMA_V8).not.toContain(OUTPUT_COVER_INDEX);
  const steps: BlockingStep[] = [];
  migrateMemorySchema(db, "off", { onBlocking: (first) => { steps.push(first); return { step: step => { steps.push(step); }, end: () => { steps.push("committing"); } }; } });
  expect(version(db)).toBe(MEMORY_SCHEMA_VERSION);
  // the upgrade itself reads no table for them: it is the server, once listening, that builds them
  expect(indexes(db)).toEqual([]);
  expect(steps).not.toContain("indexes");
  expect(db.prepare("SELECT count(*) AS n FROM memory_sources").get()?.n).toBe(1);
  validateMemorySchema(db); // a v9 file waiting for its indexes is accepted
  expect(buildColdLineageIndexesNow(db).sort()).toEqual([OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX].sort());
  expect(indexes(db)).toEqual([OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX].sort());
  validateMemorySchema(db);
});

it("a downgrade 9 -> 8 drops the two indexes and leaves a file the v8 shape accepts; the next start builds them again", () => {
  const db = open();
  migrateMemorySchema(db, "active");
  expect(version(db)).toBe(9);
  expect(indexes(db)).toHaveLength(2);
  expect(downgradeMemorySchema(db, 8)).toEqual({ status: "downgraded", from: 9, to: 8 });
  expect(version(db)).toBe(8);
  expect(indexes(db)).toEqual([]);
  validateMemorySchema(db);
  expect(downgradeMemorySchema(db, 8)).toEqual({ status: "already-v8", from: 8, to: 8 });
  migrateMemorySchema(db);
  expect(version(db)).toBe(9);
  expect(indexes(db)).toEqual([]); // built in the background after start
  expect(buildColdLineageIndexesNow(db)).toHaveLength(2);
  expect(indexes(db)).toHaveLength(2);
  // all the way down and back up, as "Prepare to reinstall Murage 1.0.1" does (to v6)
  expect(downgradeMemorySchema(db, 6)).toMatchObject({ status: "downgraded", from: 9, to: 6 });
  expect(indexes(db)).toEqual([]);
  migrateMemorySchema(db);
  expect(version(db)).toBe(9);
  validateMemorySchema(db);
  expect(buildColdLineageIndexesNow(db)).toHaveLength(2);
  expect(indexes(db)).toHaveLength(2);
  // a file that has only one of the two (a stop between them) is accepted too
  db.exec(`DROP INDEX ${SOURCE_KIND_INDEX}`);
  validateMemorySchema(db);
  expect(downgradeMemorySchema(db, 8)).toEqual({ status: "downgraded", from: 9, to: 8 });
});

it("while the index is missing the start-up settlement scan finds the working turns through the key range, and with it through the index", () => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  // (the connection wraps the statement function it finds when it is opened: the spy goes in first)
  const prepared: string[] = [];
  const realPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) { prepared.push(sql); return realPrepare.call(this, sql); } as typeof realPrepare;
  try {
    const shared = database();
    const scope = String(shared.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id ?? "s");
    if (!shared.prepare("SELECT 1 FROM memory_scopes WHERE id=?").get(scope)) shared.prepare("INSERT INTO memory_scopes VALUES(?,'workspace','o','[]',0)").run(scope);
    const add = shared.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES(?,?,?,?,?,0,'h',?,'harness',?,NULL,'active')");
    add.run("turn:t:1", scope, "t", "m", "1", "turn", "working");
    add.run("turn:t:2", scope, "t", "m", "2", "turn", "completed");
    add.run("message:t:m", scope, "t", "m", null, "text", "working");
    shared.exec(`DROP INDEX IF EXISTS ${SOURCE_KIND_INDEX}`);
    prepared.length = 0;
    reconcileInterruptedMemoryTurns();
    expect(prepared.filter(sql => sql.includes("outcome='working'") && sql.includes("id>='turn:'"))).toHaveLength(1);
    expect(shared.prepare("SELECT outcome FROM memory_sources WHERE id='turn:t:1'").get()?.outcome).toBe("interrupted");
    expect(shared.prepare("SELECT outcome FROM memory_sources WHERE id='message:t:m'").get()?.outcome).toBe("working");
    // built: the index answers it
    buildColdLineageIndexesNow(shared);
    prepared.length = 0;
    add.run("turn:t:3", scope, "t", "m", "3", "turn", "working");
    reconcileInterruptedMemoryTurns();
    expect(prepared.filter(sql => sql.includes("outcome='working'") && !sql.includes("id>='turn:'") && sql.includes("FROM memory_sources WHERE kind='turn'"))).toHaveLength(1);
    expect(shared.prepare("SELECT outcome FROM memory_sources WHERE id='turn:t:3'").get()?.outcome).toBe("interrupted");
  } finally { DatabaseSync.prototype.prepare = realPrepare; closeDatabase(); }
});

it("the background build holds the writers off only while a statement runs, waits for a moment when the owner is in a turn, and ends with both indexes built", async () => {
  const db = open();
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 8);
  migrateMemorySchema(db, "off");
  expect(indexes(db)).toEqual([]);
  const heldDuring: boolean[] = [], built: string[] = [];
  let inTurn = true, polls = 0;
  let finished = false;
  const build = startColdLineageIndexBuild(db, {
    gapMs: 1, busyPollMs: 5,
    busy: () => { polls++; if (polls >= 3) inTurn = false; return inTurn; },
    run: async statement => { heldDuring.push(writersHeldForIndexBuild()); db.exec(statement.sql); },
    onBuilt: name => built.push(name),
    onDone: () => { finished = true; },
  });
  await build.done;
  expect(finished).toBe(true);
  expect(polls).toBeGreaterThanOrEqual(3);
  expect(heldDuring).toEqual([true, true]);
  expect(writersHeldForIndexBuild()).toBe(false);
  expect(built.sort()).toEqual([OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX].sort());
  expect(indexes(db)).toEqual([OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX].sort());
  validateMemorySchema(db);
});

it("a failed statement reports, releases the writers and leaves the file as it was", async () => {
  const db = open();
  migrateMemorySchema(db, "active");
  downgradeMemorySchema(db, 8);
  migrateMemorySchema(db, "off");
  const errors: string[] = [];
  const build = startColdLineageIndexBuild(db, { gapMs: 1, run: async () => { throw new Error("disk full"); }, onError: error => errors.push(error.message) });
  await build.done;
  expect(errors).toEqual(["disk full"]);
  expect(writersHeldForIndexBuild()).toBe(false);
  expect(indexes(db)).toEqual([]);
  validateMemorySchema(db);
  holdWritersForIndexBuild(false);
});

it("the real build runs on a connection of its own in a worker thread and leaves the indexes in the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cold-index-"));
  const file = join(dir, "messages.db");
  const db = new DatabaseSync(file);
  dbs.push(db);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    migrateMemorySchema(db, "active");
    downgradeMemorySchema(db, 8);
    migrateMemorySchema(db, "off");
    expect(indexes(db)).toEqual([]);
    const errors: string[] = [];
    const build = startColdLineageIndexBuild(db, { file, gapMs: 1, onError: error => errors.push(error.message) });
    await build.done;
    expect(errors).toEqual([]);
    expect(indexes(db)).toEqual([OUTPUT_COVER_INDEX, SOURCE_KIND_INDEX].sort());
    expect(writersHeldForIndexBuild()).toBe(false);
    validateMemorySchema(db);
  } finally { db.close(); dbs.splice(dbs.indexOf(db), 1); rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
