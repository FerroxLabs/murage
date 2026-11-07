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
import { appendMessage, readThreadNewest } from "./message-db.ts";
import { OPTIONAL_INDEXES } from "./memory/optional-index.ts";
import { roomShare } from "./room-shares.ts";
import type { Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

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
 *  optional indexes it builds (eager ones, or every one) made too. closeDatabase stops the checkpointer without waiting (wal3), so it is
 *  waited out here: a later connection must not meet its lock (seen as "database is locked" on a loaded host). */
async function file103(indexes: "eager" | "all") {
  const db = database();
  initializeImageOperations(db);
  ensureForgetTable(db);
  const table = db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name=?");
  for (const index of OPTIONAL_INDEXES) if ((indexes === "all" || index.eager) && table.get(index.table)) db.exec(index.sql);
  closeDatabase();
  await stopWalMaintenance();
}

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

it("the fixture is a fresh 1.0.2 install: the branch, line and card indexes and the eager memory indexes are there, no 1.0.3 object is", () => {
  const names = new Set(fresh102.map(key));
  for (const name of ["table:seg", "table:line", "table:open_card", "table:keyed_card", "table:thread_key", "table:transcript_index_state", "index:seg_attach", "index:keyed_card_family", "index:memory_records_canon", "index:memory_details_identity", "index:memory_records_waiting_review"]) expect(names.has(name), name).toBe(true);
  for (const name of ["index:messages_thread_seq", "index:messages_id", "table:memory_revoke_fold", "table:memory_record_keys", "table:memory_session_incarnation"]) expect(names.has(name), name).toBe(false);
});

it("a 1.0.3 file differs from fresh 1.0.2 before the downgrade (the comparison sees it)", async () => {
  await file103("eager");
  const { extra } = against102(schemaOf(join(DATA_DIR, "messages.db")));
  expect(extra).toEqual(expect.arrayContaining(["index:messages_thread_seq", "table:memory_record_keys"]));
});

it("memory-downgrade --to 10 leaves sqlite_master exactly a fresh 1.0.2 install's: every table and index, each with 1.0.2's text", async () => {
  await file103("eager");
  // the owner-pin index is made at every open from 1.0.15 (MEM-PIN-INDEX-BOOT): it is 1.0.2's own idle-built index, kept with 1.0.2's text
  const kept = { missing: [], extra: ["index:memory_records_pinned"], differ: [] };
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  expect(against102(schemaOf(join(DATA_DIR, "messages.db")))).toEqual(kept);
  // a second run changes nothing
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ to: 10 });
  expect(against102(schemaOf(join(DATA_DIR, "messages.db")))).toEqual(kept);
});

it("keeps the indexes 1.0.2 builds when idle, and the fill places of the derived tables, so 1.0.2 reads no history again", async () => {
  await file103("all");
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

/** A Post in… post in the given state, as venue-post-held.ts writes it. */
function venuePost(id: string, state: string) {
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    db.prepare("INSERT INTO venue_posts (id,bot_id,thread_id,origin,request_message_id,request_hash,venue_id,target_thread_id,text,stable_id,lineage,state,created_at,updated_at) VALUES (?,'b','t','bot','m','h','v','tt','the whole post the owner has not answered',?,'[]',?,1,1)").run(id, `s-${id}`, state);
  } finally { db.close(); }
}

for (const state of ["held", "posting"]) {
  it(`refuses, before any change, while a Post in… post is ${state}: the row is the only copy of the bot's full post`, async () => {
    await file103("eager");
    venuePost("p1", state);
    const before = schemaOf(join(DATA_DIR, "messages.db")).map(key).sort();
    let thrown: unknown;
    try { downgradeInstallationMemorySchema(DATA_DIR, 10); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "DOWNGRADE_WORK_PENDING", message: "You have 1 post from a bot still waiting for your answer. Post or decline it, then try again." });
    expect(schemaOf(join(DATA_DIR, "messages.db")).map(key).sort()).toEqual(before);
    const check = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(check.prepare("SELECT state, text FROM venue_posts WHERE id='p1'").get()).toEqual({ state, text: "the whole post the owner has not answered" }); } finally { check.close(); }
  });
}

it("a 'shared' room share goes with the table, and after a re-upgrade the room line and its sharedFrom label are still read, with the ask card left to show the closed line", async () => {
  await file103("eager");
  const NOW = 1_790_000_000_000;
  appendMessage("rt", { id: "ask", role: "bot", kind: "text", text: "Dax asked you to share something from its chats.", at: NOW, roomShareId: "r1", murageLine: true } as Message);
  appendMessage("rt", { id: "line", role: "user", kind: "text", text: "> the shared words", at: NOW + 1, origin: "desktop", copyOf: { threadId: "ot", messageIds: ["x"] }, sharedFrom: { botId: "dax", shareId: "r1" } } as Message);
  database().prepare("INSERT INTO room_shares (id,bot_id,room_id,room_thread_id,origin_thread_id,query,excerpts,excerpts_hash,nonce,status,stable_id,created_at,expires_at) VALUES ('r1','dax','room','rt','ot','q','[]','h','n','shared','line',1,9999999999999)").run();
  closeDatabase();
  await stopWalMaintenance();
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  expect(new Set(schemaOf(join(DATA_DIR, "messages.db")).map(row => row.name)).has("room_shares")).toBe(false);
  // the 1.0.18 start again: the table is made empty, and the share row is not there to be read
  const db = database();
  expect(db.prepare("SELECT COUNT(*) AS n FROM room_shares").get()).toEqual({ n: 0 });
  expect(roomShare(db, "r1")).toBeNull();
  const lines = readThreadNewest("rt", 50)!.messages;
  expect(lines.find(line => line.id === "line")).toMatchObject({ text: "> the shared words", sharedFrom: { botId: "dax", shareId: "r1" }, copyOf: { threadId: "ot", messageIds: ["x"] } });
  // the ask card message stays and still points at the (now missing) row: RoomShareCard shows the closed line for that 404 (RoomShareCard.test.tsx)
  expect(lines.find(line => line.id === "ask")).toMatchObject({ roomShareId: "r1" });
});

it("goes back once every Post in… post is answered, and an open room-share draft (which every 1.0.18 start discards) does not hold it", async () => {
  await file103("eager");
  venuePost("p1", "posted");
  venuePost("p2", "declined");
  const db = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try { db.prepare("INSERT INTO room_shares (id,bot_id,room_id,room_thread_id,origin_thread_id,query,excerpts,excerpts_hash,nonce,status,stable_id,created_at,expires_at) VALUES ('r1','b','room','rt','ot','q','[]','h','n','pending','s',1,9999999999999)").run(); } finally { db.close(); }
  expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
  const names = new Set(schemaOf(join(DATA_DIR, "messages.db")).map(row => row.name));
  for (const name of ["venue_posts", "venue_posts_open", "room_shares", "room_shares_status"]) expect(names.has(name), name).toBe(false);
});
