// Astra r14 P2 x4: (1) the owed backfill checks existence and shape before the marker, reports before it starts and keeps reporting
// inside a slow batch; (2) the two-column owed table of an older build is accepted by snapshot inspection and rebuilt in restore
// preparation; (3) shared-work status is a tri-state and "unknown" keeps a held result; (4) delivery debt is never pruned and Resume
// keeps a hold until the result is published.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { channelToProjectRows, setProjectRunState } from "./project-settings.ts";
import { prepareProjectTablesForRestore } from "./project-tables.ts";
import { fenceRestoredSql, sqlRowRestoreHeld } from "./restore-fence.ts";
import { pruneTerminalRoomRequests, roomRequest } from "./room-requests.ts";
import { BACKFILL_NAME, LEGACY_OWED_TABLE_DDL, upgradeRoomRequestOwed } from "./room-request-owed.ts";
import { sharedResolution } from "./shared-work.ts";
import { recordOwnerDeletion } from "./owner-deletions.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,outcome_note,result_message_id,created_at,finished_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
function rowInserter(db: DatabaseSync) {
  const stmt = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
  const provenance = db.prepare("INSERT OR REPLACE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  return (id: string, o: { verb: string; to?: string | null; target?: string | null; state: string; shared?: boolean }) => {
    if (o.shared) provenance.run(id);   // shared work is recorded as such when it is created
    return stmt.run(id, id, null, "g", o.verb, "bot", o.to ?? null, o.target ?? null, o.state, null, null, null, null, 1, 1, "t", `key-${id}`);
  };
}
const TRIGGERS = ["classify", "shared_ins", "shared_upd", "shared_clear", "fanout_ins", "fanout_upd", "fanout_child", "gone"].map(t => `room_request_owed_${t}`);
function asOlderRelease(db: DatabaseSync): void { for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`); db.exec("DELETE FROM room_request_owed; DELETE FROM room_request_backfills"); }
const ids = (db: DatabaseSync) => (db.prepare("SELECT request_id AS id FROM room_request_owed ORDER BY request_id").all() as Array<{ id: string }>).map(r => r.id);
function seed(db: DatabaseSync, n: number) {
  const insert = rowInserter(db);
  db.exec("BEGIN");
  for (let i = 0; i < n; i++) insert(`h-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
  db.exec("COMMIT");
}

describe("(1) the owed backfill runs under the upgrade reporter whatever the marker says", () => {
  it("a missing marker table does not throw: the seeding runs in the upgrade step", () => {
    const db = database();
    seed(db, 30); asOlderRelease(db);
    db.exec("DROP TABLE room_request_backfills");
    const seen: number[] = [];
    expect(() => upgradeRoomRequestOwed(db, done => seen.push(done))).not.toThrow();
    expect(ids(db)).toHaveLength(30);
    expect(db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME)).toEqual({ completed: 1 });
  });
  it("a completed marker over an older-shaped owed table is rebuilt and reseeded in the upgrade step, not after it", () => {
    const db = database();
    seed(db, 30); asOlderRelease(db);
    db.exec(`DROP TABLE room_request_owed; ${LEGACY_OWED_TABLE_DDL}`);
    db.prepare("INSERT INTO room_request_backfills(name,cursor,completed) VALUES(?,?,1)").run(BACKFILL_NAME, 99);
    expect(upgradeRoomRequestOwed(db, () => {})).toBe(true);
    expect(ids(db)).toHaveLength(30);
    expect(() => db.prepare("SELECT destination_thread_id FROM room_request_owed").all()).not.toThrow();
  });
  it("a note exists before the first batch, and a slow batch keeps refreshing at a bounded interval", () => {
    const db = database();
    seed(db, 700); asOlderRelease(db);
    let clock = 0;
    const notes: Array<{ done: number; owedAtNote: number }> = [];
    // every clock read costs a second: a slow disk, so each slice looks slow and the next one shrinks
    upgradeRoomRequestOwed(db, done => notes.push({ done, owedAtNote: ids(db).length }), { now: () => (clock += 1_000), sliceMs: 500 });
    expect(notes[0]).toEqual({ done: 0, owedAtNote: 0 });                   // reported before any work
    const steps = notes.slice(1).map((n, i) => n.done - notes[i]!.done);
    expect(Math.max(...steps)).toBeLessThanOrEqual(250);                       // no slice is ever the whole 2,000-row batch
    expect(steps.some((s, i) => i > 0 && s < steps[0]!)).toBe(true);          // and a slow slice makes the next smaller
    expect(notes.length).toBeGreaterThanOrEqual(6);
    expect(ids(db)).toHaveLength(700);
  });
});

describe("(2) the two-column owed table of an older build restores", () => {
  function legacyDb() {
    const db = database();
    db.exec(`DROP TABLE room_request_owed; ${LEGACY_OWED_TABLE_DDL}`);
    return db;
  }
  it("is accepted by snapshot inspection, and a near miss is not", () => {
    const db = legacyDb();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("DROP TABLE room_request_owed; CREATE TABLE room_request_owed (kind TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(kind, request_id)) WITHOUT ROWID");
    expect(() => inspectInstallationDatabase(db)).toThrow();
  });
  it("is rebuilt (record cleared) while the restore is prepared", () => {
    const db = legacyDb();
    db.prepare("INSERT OR REPLACE INTO room_request_backfills(name,cursor,completed) VALUES(?,5,1)").run(BACKFILL_NAME);
    prepareProjectTablesForRestore(db, { groups: [], botIds: new Set<string>(), now: 10 } as never);
    expect((db.prepare("PRAGMA table_info(room_request_owed)").all() as Array<{ name: string }>).map(c => c.name)).toContain("destination_thread_id");
    expect(db.prepare("SELECT 1 AS x FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME)).toBeUndefined();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
  });
});

describe("(3) shared work is classified by recorded provenance; resolution is a separate question", () => {
  const row = { toBotId: "b", targetThreadId: "tt", groupId: "g" };
  const store = (tasks: Array<{ threadId: string; sharedWork?: boolean }> | undefined, bot = true) => ({ bot: () => (bot ? { tasks } : undefined) }) as never;
  it("resolved / tombstoned / unresolved", () => {
    const db = database();
    expect(sharedResolution(row, store([{ threadId: "tt", sharedWork: true }]), db)).toBe("resolved");
    expect(sharedResolution(row, store([]), db)).toBe("unresolved");
    expect(sharedResolution(row, store(undefined, false), db)).toBe("unresolved");
    expect(sharedResolution(row, undefined, db)).toBe("unresolved");
    recordOwnerDeletion(db, "tt");
    expect(sharedResolution(row, store([]), db)).toBe("tombstoned");
    expect(sharedResolution(row, store([{ threadId: "tt", sharedWork: true }]), db)).toBe("resolved");
  });
  it("Release and Resume keep the hold when the destination is unresolved, and every caller classifies by provenance", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const helper = source.slice(source.indexOf("function publishHeldSharedResult"), source.indexOf("function deliverOwedSharedResults"));
    expect(helper).toMatch(/sharedByProvenance\(db, request\)/);
    expect(helper).toMatch(/store\.botByThread\(destination\) \|\| store\.groupByThread\(destination\)\)\) return false/);
    expect(source).toContain("publishHeldShared: publishHeldSharedResult");
    expect(readFileSync(new URL("./room-dispatcher.ts", import.meta.url), "utf8")).toMatch(/sharedByProvenance\(db, row\) \? expireSharedRequest\(row, db\)/);
    // a hand-off is classified in the one place it is admitted (handoff-dispatch.ts), by the same provenance
    expect(readFileSync(new URL("./handoff-dispatch.ts", import.meta.url), "utf8")).toMatch(/request !== null && isSharedWorkRow\(request\)/);
  });
});

describe("(4) outstanding delivery debt is never pruned and Resume holds until publication", () => {
  function heldResult() {
    const db = database();
    channelToProjectRows(db, { groupId: "g", bulletin: "", leadBotId: "lead", now: 1 });
    rowInserter(db)("r1", { verb: "ask", to: "b", target: "tt", state: "done", shared: true });   // finished_at=1: older than 30 days at any later now
    fenceRestoredSql(db, "gen-1");
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
    return db;
  }
  const LATE = 200 * 86_400_000;
  it("the reviewer's sequence: Resume with the result not yet published keeps the hold, and a later prune cannot erase it", () => {
    const db = heldResult();
    expect(setProjectRunState(db, { groupId: "g", runState: "running", actor: "owner", now: 5, publishHeldShared: () => false })).toMatchObject({ ok: true });
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
    expect(pruneTerminalRoomRequests(db, LATE)).toBe(0);
    expect(roomRequest(db, "r1")).toBeTruthy();
  });
  it("Resume with no publisher at all releases nothing", () => {
    const db = heldResult();
    setProjectRunState(db, { groupId: "g", runState: "running", actor: "owner", now: 5 });
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
  });
  it("Resume releases a hold once its publication completed, and the owed row still protects the result until delivered", () => {
    const db = heldResult();
    setProjectRunState(db, { groupId: "g", runState: "running", actor: "owner", now: 5, publishHeldShared: () => true });
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(false);
    expect(pruneTerminalRoomRequests(db, LATE)).toBe(0);                         // owed row = delivery debt
    expect(ids(db)).toEqual(["r1"]);
    db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id='r1'").run();   // delivered: the trigger clears the debt
    expect(ids(db)).toEqual([]);
    expect(pruneTerminalRoomRequests(db, LATE)).toBe(1);                         // and now it ages out like any other
  });
});
