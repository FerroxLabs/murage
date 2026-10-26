// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S0 contract (DESIGN-WRITETIME 7): schema v10 opens on an empty file, on a v9 RC file and on a 1.0.1 (v6) file; the
// validator refuses a tampered v10 index; no S0 stub is left live once S1 to S5 are merged.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { downgradeMemorySchema, LINEAGE_META_KEYS_V12, MEMORY_SCHEMA_V9, MEMORY_SCHEMA_V10, MEMORY_SCHEMA_VERSION, migrateMemorySchema, validateMemorySchema, WRITETIME_TABLES } from "./schema.ts";
import { migrateMemorySchema as migrateAs101, MEMORY_SCHEMA_VERSION as VERSION_101 } from "./testing/schema-1.0.1.ts";
import { OPTIONAL_INDEXES as REGISTERED, buildOptionalIndexOffThread, optionalIndexReady } from "./optional-index.ts";
import { denyGeneration, denyLookup, fenceVerdict, memoryLookup, refsLookup, sessionLookup } from "./deny-read.ts";
import { addTurnParents, closeTurnLineage, currentLsn, currentTurnLineage, internFootprint, openTurnLineage, reserveLsns, writeCaptureLineage, writeLineage, writeRecordLineage, writeSessionLineage } from "./lineage-write.ts";
import { inheritMarks } from "./revoke-commit.ts";
import { lineageBackfillSlice, lineageCertProgress, promoteLineageThread } from "./lineage-backfill.ts";
import { buildPrompt, promptPart, toolText } from "./prompt-parts.ts";
import { decodeNode, encodeNode, FOOTPRINT_STAR, memoryRefKey, writetimeStubCalls, type FrontierNode, type LineageReader } from "./lineage-types.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const dirs: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
function file(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "murage-writetime-")); dirs.push(dir);
  const db = new DatabaseSync(join(dir, "messages.db")); dbs.push(db);
  return db;
}
const version = (db: DatabaseSync) => Number(db.prepare("SELECT schema_version FROM memory_meta").get()?.schema_version);
const tables = (db: DatabaseSync) => new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
function expectV10(db: DatabaseSync, cert: { phase: string; ready: boolean }) {
  expect(version(db)).toBe(13);
  expect(MEMORY_SCHEMA_VERSION).toBe(13);
  const names = tables(db);
  for (const table of Object.values(WRITETIME_TABLES)) expect(names.has(table), table).toBe(true);
  expect(currentLsn(db)).toBe(1);
  expect(db.prepare("SELECT key,value FROM memory_lineage_lsn_meta ORDER BY key").all().map(row => [row.key, row.value]))
    .toEqual([...LINEAGE_META_KEYS_V12].sort().map(key => [key, key === "lineage_upgrade_lsn" || key === "reader_door_epoch" ? 1 : 0])); // v12: the door epoch at the lsn counter
  expect(lineageCertProgress(db)).toMatchObject(cert);
  for (const table of ["memory_line_lineage", "memory_lineage_carry", "memory_deny_line", "memory_deny_range", "memory_deny_pending", "memory_revoke_jobs"]) expect(count(db, table), table).toBe(0);
  expect(() => validateMemorySchema(db)).not.toThrow();
}

it("WRITETIME_TABLES is exactly what v10 adds to v9", () => {
  const objects = (text: string) => { const db = new DatabaseSync(":memory:"); dbs.push(db); db.exec(text); return tables(db); };
  const v9 = objects(MEMORY_SCHEMA_V9), v10 = objects(MEMORY_SCHEMA_V10);
  expect([...v10].filter(name => !v9.has(name)).sort()).toEqual(Object.values(WRITETIME_TABLES).sort());
  for (const name of v9) expect(v10.has(name), name).toBe(true);
});

it("v10 opens on an empty database: every table empty, lsn 1, certificate ready", () => {
  const db = file();
  migrateMemorySchema(db);
  expectV10(db, { phase: "done", ready: true });
  migrateMemorySchema(db); // a second open is a no-op
  expectV10(db, { phase: "done", ready: true });
});

it("v10 opens on a v9 RC database: rows kept, lineage tables empty, certificate not ready; v10 -> v9 inverts it while nothing is written", () => {
  const db = file();
  migrateMemorySchema(db, "active");
  expect(downgradeMemorySchema(db, 9)).toMatchObject({ status: "downgraded", from: 13, to: 9 });
  expect(version(db)).toBe(9);
  for (const table of Object.values(WRITETIME_TABLES)) expect(tables(db).has(table), table).toBe(false);
  validateMemorySchema(db);
  db.exec("INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0)");
  db.exec(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('b1','thread','drv',NULL,'[]','[]','["m1"]',0,0,1,'delivered',1)`);
  migrateMemorySchema(db);
  expectV10(db, { phase: "u1", ready: false });
  expect(db.prepare("SELECT bundle_id,state FROM memory_disclosures").all()).toEqual([{ bundle_id: "b1", state: "delivered" }]);
  expect(db.prepare("SELECT mode FROM memory_meta").get()?.mode).toBe("active");
});

it("v10 opens on a 1.0.1 (v6) database", () => {
  const db = file();
  migrateAs101(db, "active");
  expect(version(db)).toBe(VERSION_101);
  expect(VERSION_101).toBe(6);
  db.exec("INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0)");
  migrateMemorySchema(db);
  expectV10(db, { phase: "u1", ready: false });
  expect(count(db, "memory_scopes")).toBe(1);
});

it("a v10 -> v9 downgrade with a lineage row or mark runs S5's marking first, then drops the lineage tables (lineage-backfill.test.ts covers the marks)", () => {
  const db = file();
  migrateMemorySchema(db);
  db.exec("INSERT INTO memory_deny_line(thread_id,lsn,revoke_id,mark_lsn,reason) VALUES('t',1,1,1,'forget')");
  expect(downgradeMemorySchema(db, 9)).toMatchObject({ status: "downgraded", from: 13, to: 9 });
  expect(version(db)).toBe(9);
  expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='memory_deny_line'").get()).toBeUndefined();
});

it.each([
  ["an index moved to another column", "DROP INDEX memory_deny_range_revoke; CREATE INDEX memory_deny_range_revoke ON memory_deny_range(thread_id)"],
  ["an index removed", "DROP INDEX memory_deny_pending_revoke"],
  ["the unique message index made non-unique", "DROP INDEX memory_line_lineage_msg; CREATE INDEX memory_line_lineage_msg ON memory_line_lineage(thread_no,message_id)"],
  ["an index made partial", "DROP INDEX memory_deny_line_revoke; CREATE INDEX memory_deny_line_revoke ON memory_deny_line(revoke_id) WHERE revoke_id>0"],
  ["an extra index on a lineage table", "CREATE INDEX memory_lineage_carry_child ON memory_lineage_carry(child_ref)"],
  ["a trigger on a lineage table", "CREATE TRIGGER memory_deny_line_gone AFTER INSERT ON memory_deny_line BEGIN DELETE FROM memory_deny_line; END"],
])("the validator refuses a tampered v10 schema: %s", (_label, tamper) => {
  const db = file();
  migrateMemorySchema(db);
  db.exec(tamper);
  expect(() => validateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
  expect(() => migrateMemorySchema(db)).toThrow("MEMORY_SCHEMA_UNSUPPORTED");
});

it.each([
  ["no certificate row", "DELETE FROM memory_lineage_cert"],
  ["no lsn counter", "DELETE FROM memory_lsn"],
  ["a meta key missing", "DELETE FROM memory_lineage_lsn_meta WHERE key='deny_generation'"],
])("the validator refuses v10 lineage meta with %s", (_label, tamper) => {
  const db = file();
  migrateMemorySchema(db);
  db.exec(tamper);
  expect(() => validateMemorySchema(db)).toThrow("INVALID_MEMORY_LINEAGE_META");
});

it("no S0 stub is left live after S1 to S5: every lookup, write, revoke and backfill body is real, and an unknown never reads shown", () => {
  const db = file();
  migrateMemorySchema(db);
  const readers: LineageReader[] = [{ audience: null }, { audience: { owner: true, scopeIds: [] } }, { audience: { owner: false, scopeIds: ["scope"] } }];
  const turn = openTurnLineage(db, { threadId: "t", turnId: "turn" });
  for (const reader of readers) {
    // a line this file does not hold (no messages table here) is never shown, whatever its author
    const page = denyLookup(db, { threadId: "t", lines: [{ messageId: "o", author: "owner" }, { messageId: "g", author: "generated" }] }, reader);
    for (const id of ["o", "g"]) expect(page.get(id)?.state, id).not.toBe("shown");
    const refs = [{ kind: "record", id: "r", version: 2 }, { kind: "source", id: "s" }] as const;
    for (const ref of refs) expect(memoryLookup(db, refs, reader).get(memoryRefKey(ref))?.state).not.toBe("shown");
    expect(sessionLookup(db, { threadId: "t", driverInstance: "d", nativeSession: "n" }, reader).state).not.toBe("shown");
    expect(refsLookup(db, [], reader)).toEqual({ state: "shown" });
    // nothing was revoked since the prompt was built: the fence lets it through
    expect(fenceVerdict(db, buildPrompt(turn, [promptPart("hi", [{ kind: "none", reason: "static" }])]), reader)).toEqual({ state: "shown" });
  }
  expect(writeLineage(db, { threadId: "t", messageId: "o", author: "owner" }, {}).lsn).toBe(1);
  expect(reserveLsns(db, 10)).toBe(2);
  expect(internFootprint(db, ["a", "b"])).not.toBe(FOOTPRINT_STAR);
  addTurnParents(turn, [{ kind: "prefix", threadId: "u" }]);
  writeRecordLineage(db, { kind: "record", id: "r", version: 1 }, turn);
  writeCaptureLineage(db, { threadId: "t", messageId: "o" }, "s");
  writeSessionLineage(db, { threadId: "t", driverInstance: "d", nativeSession: "n" }, turn);
  expect(currentTurnLineage("t")?.turnId).toBe("turn");
  closeTurnLineage(turn);
  expect(currentTurnLineage("t")).toBeUndefined();
  inheritMarks(db, { kind: "line", threadId: "t", lsn: 1 }, []);
  // a new file has no history: the backfill has nothing to do and the certificate is ready at once
  promoteLineageThread("t");
  expect(lineageBackfillSlice(db)).toEqual({ more: false });
  expect(lineageCertProgress(db).ready).toBe(true);
  expect(denyGeneration(db)).toBe(0);
  expect([...writetimeStubCalls().keys()]).toEqual([]);
  expect(toolText("result", [{ kind: "none", reason: "murage" }])).toMatchObject({ text: "result" });
});

it("frontier nodes round-trip and a malformed row decodes to null", () => {
  const nodes: FrontierNode[] = [{ kind: "line", threadId: "t", lsn: 4 }, { kind: "range", threadId: "t", fromLsn: 2 }, { kind: "record", id: "r", version: 1 },
    { kind: "source", id: "s" }, { kind: "receipt", bundleId: "b" }, { kind: "session", session: { threadId: "t", driverInstance: "d", nativeSession: "n" } }, { kind: "scope", scopeId: "x" }];
  for (const node of nodes) expect(decodeNode(encodeNode(node))).toEqual(node);
  for (const bad of ["", "{", "null", '{"kind":"line","threadId":"t"}', '{"kind":"other"}', '{"kind":"range","threadId":"t","fromLsn":1.5}']) expect(decodeNode(bad), bad).toBeNull();
});

it("P3-11: v10 -> v9 leaves no optional index (the RC's known-object list does not name them); the idle sweep makes them again, never the open", async () => {
  const db = file();
  migrateMemorySchema(db);
  // the memory schema's optional indexes: the registry also holds messages_thread_seq (transcript-seq.ts, ROOM-ORDER-DESIGN r8 "Column and
  // index"), an index on the messages table this memory-only file does not have; its own downgrade is transcript-seq.server.test.ts
  const OPTIONAL_INDEXES = REGISTERED.filter(item => item.table.startsWith("memory_"));
  const index = () => db.prepare("SELECT 1 FROM sqlite_schema WHERE name IN ('memory_disclosures_live','memory_records_pinned')").get();
  expect(index()).toBeUndefined(); // optional: open builds none of them
  for (const item of OPTIONAL_INDEXES) expect(await buildOptionalIndexOffThread(db, item, { inline: true })).toBe(true);
  expect(index()).toBeTruthy();
  expect(downgradeMemorySchema(db, 9)).toMatchObject({ status: "downgraded", from: 13, to: 9 });
  for (const item of OPTIONAL_INDEXES) expect(optionalIndexReady(db, item.name)).toBe(false);
  expect(index()).toBeUndefined();
  expect(() => validateMemorySchema(db)).not.toThrow();
  migrateMemorySchema(db);
  expect(index()).toBeUndefined(); // the open still makes none
  for (const item of OPTIONAL_INDEXES) expect(await buildOptionalIndexOffThread(db, item, { inline: true })).toBe(true);
  expect(index()).toBeTruthy();
});
