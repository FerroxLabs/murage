// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// room_requests.parked_refusal across versions. A file from the starting commit (the column absent, a spend park written as
// refusal='spend_limit' beside its retry row) is opened by this build and must still pass the snapshot inspection every backup runs;
// "Prepare to reinstall" must hand the older build the table it wrote, with the park in the form it reads.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { deferRetainedRoomRequest, insertRoomRequest, roomRequest, runnableRoomRequestIds, type RoomRequestLineage } from "./room-requests.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { settleTestHandles } from "./test-handle-registry.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

/** room_requests as the starting commit (0fc91ffa6c) leaves it: its CREATE TABLE, then `handoff`, then `shared_work`. */
const STARTING_COLUMNS = ["id", "root_id", "parent_id", "card_generation", "attempt", "group_id", "target_thread_id", "project_goal_id", "work_item_id", "verb",
  "from_kind", "from_bot_id", "to_bot_id", "payload_text", "reply_to_id", "send_id", "mode", "origin", "root_thread_id", "audience_fingerprint", "not_owner_audience",
  "unattended", "execution_audience", "source_message_id", "return_thread_id", "return_bot_id", "admission_key", "priority", "state", "refusal", "created_at",
  "dispatched_at", "deadline_at", "finished_at", "owner_wait_ms", "waiting_since", "result_message_id", "outcome_note", "handoff", "shared_work"];
const FILE = join(DATA_DIR, "messages.db");
const lineage: RoomRequestLineage = { rootThreadId: "room-t", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
const columnsOf = (db: DatabaseSync) => (db.prepare("PRAGMA table_info(room_requests)").all() as Array<{ name: string }>).map(column => column.name);
const tableText = (db: DatabaseSync) => String((db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='room_requests'").get() as { sql: string }).sql);
const rawRow = (db: DatabaseSync, id: string) => db.prepare("SELECT state, refusal FROM room_requests WHERE id=?").get(id);
const retryRow = (db: DatabaseSync, id: string) => db.prepare("SELECT retry_at, attempts FROM room_request_retry WHERE request_id=?").get(id);
async function closed() { closeDatabase(); await stopWalMaintenance(); await settleTestHandles(DATA_DIR); }
function raw<T>(use: (db: DatabaseSync) => T): T { const db = new DatabaseSync(FILE); try { return use(db); } finally { db.close(); } }
/** Three queued turns: one spend-parked, one parked as unresolved, one runnable. */
function seed() {
  const db = database();
  const root = insertRoomRequest(db, { groupId: "g1", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g1:s-1", lineage, payloadText: "hello", sendId: "s-1", now: 1000 }).request;
  const [spend, unknown, plain] = ["a", "b", "c"].map(bot => insertRoomRequest(db, {
    groupId: "g1", verb: "room_turn", fromKind: "owner", toBotId: bot, targetThreadId: "room-t", parentId: root.id, admissionKey: `turn:${bot}`, now: 1100, priority: "coordinator",
  }).request.id) as [string, string, string];
  deferRetainedRoomRequest(db, spend, 5_000, "spend_limit");
  deferRetainedRoomRequest(db, spend, 6_000, "spend_limit");
  deferRetainedRoomRequest(db, unknown, 5_000, "retained_unresolved");
  return { spend, unknown, plain, spendRetry: retryRow(db, spend), unknownRetry: retryRow(db, unknown) };
}
/** The same file as the starting commit wrote it: no park column, the spend park as refusal='spend_limit' beside its retry row. */
function toStartingShape() {
  raw(db => {
    db.exec("UPDATE room_requests SET refusal=parked_refusal WHERE parked_refusal IS NOT NULL");
    db.exec("DROP TRIGGER room_request_park_left");
    db.exec("ALTER TABLE room_requests DROP COLUMN parked_refusal");
    expect(columnsOf(db)).toEqual(STARTING_COLUMNS);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%parked_refusal%'").all()).toEqual([]);
  });
}

beforeEach(async () => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { closeDatabase(); });

it("W-PARK-UPGRADE a starting-commit file opened by this build has the fresh column order, keeps its spend park, and passes snapshot inspection", async () => {
  const ids = seed();
  const freshColumns = columnsOf(database());
  const freshText = tableText(database());
  expect(() => inspectInstallationDatabase(database())).not.toThrow();
  await closed();
  toStartingShape();
  expect(raw(db => rawRow(db, ids.spend))).toEqual({ state: "queued", refusal: "spend_limit" });
  // the first open of the newer build: what every start runs
  const db = database();
  expect(columnsOf(db)).toEqual([...STARTING_COLUMNS, "parked_refusal"]);
  expect(columnsOf(db)).toEqual(freshColumns);
  expect(tableText(db)).toBe(freshText);
  expect(() => inspectInstallationDatabase(db)).not.toThrow();
  // the park written by the starting commit is out of the runnable set and still reads as the spend hold, its wait untouched
  expect(db.prepare("SELECT refusal, parked_refusal FROM room_requests WHERE id=?").get(ids.spend)).toEqual({ refusal: "retained_unresolved", parked_refusal: "spend_limit" });
  expect(roomRequest(db, ids.spend)).toMatchObject({ state: "queued", refusal: "spend_limit" });
  expect(retryRow(db, ids.spend)).toEqual(ids.spendRetry);
  expect(runnableRoomRequestIds(db)).toEqual(expect.arrayContaining([ids.plain]));
  expect(runnableRoomRequestIds(db)).not.toContain(ids.spend);
  await closed();
  // and the file a backup reads from disk
  raw(file => expect(() => inspectInstallationDatabase(file)).not.toThrow());
});

it.each([10, 12, 13] as const)("W-PARK-DOWNGRADE target %s: the column leaves, the table is the starting commit's again, and a spend park is the older build's park", async target => {
  const ids = seed();
  await closed();
  toStartingShape();
  const startingText = raw(tableText);
  database();                                                                  // upgrade: the column is appended, the park converted
  await closed();
  expect(raw(columnsOf)).toEqual([...STARTING_COLUMNS, "parked_refusal"]);
  expect(await downgradeInstallationMemorySchema(DATA_DIR, target)).toMatchObject({ status: "downgraded", to: target });
  const after = () => raw(db => ({
    columns: columnsOf(db), text: tableText(db), spend: rawRow(db, ids.spend), unknown: rawRow(db, ids.unknown), plain: rawRow(db, ids.plain),
    spendRetry: retryRow(db, ids.spend), unknownRetry: retryRow(db, ids.unknown),
  }));
  const first = after();
  expect(first.columns).toEqual(STARTING_COLUMNS);
  expect(raw(db => db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%parked_refusal%' OR name='room_request_park_left'").all())).toEqual([]);
  expect(first.text).toBe(startingText);
  // what the older build reads as a spend park: the reason on the row, its retry row beside it
  expect(first.spend).toEqual({ state: "queued", refusal: "spend_limit" });
  expect(first.spendRetry).toEqual(ids.spendRetry);
  expect(first.unknown).toEqual({ state: "queued", refusal: "retained_unresolved" });
  expect(first.unknownRetry).toEqual(ids.unknownRetry);
  expect(first.plain).toEqual({ state: "queued", refusal: null });
  // a second run changes nothing
  expect(await downgradeInstallationMemorySchema(DATA_DIR, target)).toMatchObject({ to: target });
  expect(after()).toEqual(first);
  // going forward again parks it again, and the file still passes inspection
  const db = database();
  expect(columnsOf(db)).toEqual([...STARTING_COLUMNS, "parked_refusal"]);
  expect(roomRequest(db, ids.spend)).toMatchObject({ state: "queued", refusal: "spend_limit" });
  expect(runnableRoomRequestIds(db)).not.toContain(ids.spend);
  expect(retryRow(db, ids.spend)).toEqual(ids.spendRetry);
  expect(() => inspectInstallationDatabase(db)).not.toThrow();
});

it("W-PARK-DOWNGRADE-101 a direct application downgrade to 1.0.1 leaves no park trigger or column, and a spend park keeps spend_limit in the frozen 1.0.1 schema", async () => {
  const ids = seed();
  await closed();
  raw(db => downgradeApplicationSchemaTo101(db, DATA_DIR));
  expect(raw(db => db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%parked_refusal%' OR name='room_request_park_left'").all())).toEqual([]);
  expect(raw(columnsOf)).not.toContain("parked_refusal");
  expect(raw(db => rawRow(db, ids.spend))).toEqual({ state: "queued", refusal: "spend_limit" });
  expect(raw(db => db.prepare("SELECT name FROM sqlite_schema WHERE name='room_request_retry'").all())).toEqual([]);
  // 1.0.1 has no unresolved mark: base clears it there too (installation-app-schema-downgrade.ts, the 1.0.1 step)
  expect(raw(db => rawRow(db, ids.unknown))).toEqual({ state: "queued", refusal: null });
  expect(raw(db => rawRow(db, ids.plain))).toEqual({ state: "queued", refusal: null });
});
