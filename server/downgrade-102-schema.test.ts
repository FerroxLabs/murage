// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Prepare to reinstall" (memory-downgrade --to 10) must hand 1.0.2 the messages.db schema a fresh 1.0.2 install has, every table and
// index included. testing/schema-1.0.2-fresh.json is sqlite_master of a fresh 1.0.2 install (afbf549ba started once on an empty data
// folder, then stopped), so this compares the downgrade's result with what 1.0.2 itself makes, never with the current code.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ensureForgetTable } from "./harness/event-log.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { OPTIONAL_INDEXES } from "./memory/optional-index.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

type Row = { type: string; name: string; tbl_name: string; sql: string | null };
const fresh102 = (JSON.parse(readFileSync(join(import.meta.dirname, "testing", "schema-1.0.2-fresh.json"), "utf8")) as { objects: Row[] }).objects;
/** The optional indexes 1.0.2 builds in an idle window after start (not yet there on a fresh install), with the text 1.0.2 gives them. */
const IDLE_BUILT_BY_102 = ["memory_disclosures_live", "memory_records_pinned"];

const key = (row: Row) => `${row.type}:${row.name}`;
const text = (row: Row) => `${row.tbl_name} ${(row.sql ?? "").replace(/\s+/g, " ")}`;
function schemaOf(file: string): Row[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as Row[]; } finally { db.close(); }
}
/** Every object fresh 1.0.2 has that the file lacks, every object the file has that fresh 1.0.2 lacks, and every shared one whose text differs. */
function against102(rows: Row[]) {
  const want = new Map(fresh102.map(row => [key(row), row])), have = new Map(rows.map(row => [key(row), row]));
  return {
    missing: [...want.keys()].filter(name => !have.has(name)).sort(),
    extra: [...have.keys()].filter(name => !want.has(name)).sort(),
    differ: [...have.keys()].filter(name => want.has(name) && text(have.get(name)!) !== text(want.get(name)!)).sort(),
  };
}
/** A 1.0.3 file as a 1.0.3 start leaves it (the database plus the tables the image recovery and the event log make at start), with the
 *  optional indexes it builds (eager ones, or every one) made too. */
function file103(indexes: "eager" | "all") {
  const db = database();
  initializeImageOperations(db);
  ensureForgetTable(db);
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?");
  for (const index of OPTIONAL_INDEXES) if ((indexes === "all" || index.eager) && table.get(index.table)) db.exec(index.sql);
  closeDatabase();
}

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

it("the fixture is a fresh 1.0.2 install: the branch, line and card indexes and the eager memory indexes are there, no 1.0.3 object is", () => {
  const names = new Set(fresh102.map(key));
  for (const name of ["table:seg", "table:line", "table:open_card", "table:keyed_card", "table:thread_key", "table:transcript_index_state", "index:seg_attach", "index:keyed_card_family", "index:memory_records_canon", "index:memory_details_identity", "index:memory_records_waiting_review"]) expect(names.has(name), name).toBe(true);
  for (const name of ["index:messages_thread_seq", "index:messages_id", "table:memory_revoke_fold", "table:memory_record_keys", "table:memory_session_incarnation"]) expect(names.has(name), name).toBe(false);
});

it("a 1.0.3 file differs from fresh 1.0.2 before the downgrade (the comparison sees it)", () => {
  file103("eager");
  const { extra } = against102(schemaOf(join(DATA_DIR, "messages.db")));
  expect(extra).toEqual(expect.arrayContaining(["index:messages_thread_seq", "table:memory_record_keys"]));
});

it("memory-downgrade --to 10 leaves sqlite_master exactly a fresh 1.0.2 install's: every table and index, each with 1.0.2's text", () => {
  file103("eager");
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  expect(against102(schemaOf(join(DATA_DIR, "messages.db")))).toEqual({ missing: [], extra: [], differ: [] });
  // a second run changes nothing
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expect(against102(schemaOf(join(DATA_DIR, "messages.db")))).toEqual({ missing: [], extra: [], differ: [] });
});

it("keeps the indexes 1.0.2 builds when idle, and the fill places of the derived tables, so 1.0.2 reads no history again", () => {
  file103("all");
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { db.exec("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES ('open_card', 1, 7, 0), ('search_fts', 1, 7, 0), ('seq', 1, 7, 0)"); } finally { db.close(); }
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  // the only objects beyond a fresh install are 1.0.2's own idle-built indexes
  expect(against102(schemaOf(join(DATA_DIR, "messages.db")))).toEqual({ missing: [], extra: IDLE_BUILT_BY_102.map(name => `index:${name}`).sort(), differ: [] });
  const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
  try {
    // 1.0.2's fill places stay; 1.0.3's own (the seq walk) leaves with its column
    expect(after.prepare("SELECT name FROM transcript_index_state WHERE name IN ('open_card','search_fts','seq') ORDER BY name").all().map(row => row.name)).toEqual(["open_card", "search_fts"]);
  } finally { after.close(); }
});
