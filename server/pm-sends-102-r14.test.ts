// Astra r13 P2 x4: (1) the owed-set backfill of a heavy 1.0.1 history runs under the upgrade reporter, before the start-up note is
// removed, with progress between bounded batches; (2) the old partial index is dropped on upgrade and accepted, exactly, in older
// archives; (3) a held shared result keeps its hold until it is truly delivered; (4) transient unavailability never clears the
// delivery debt, only a confirmed delivery or a durable terminal decision does.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMemoryUpgradeStatus } from "../electron/memory-upgrade-status.mjs";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { memoryUpgradeReporter } from "./memory/upgrade-status.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { fenceRestoredSql, releaseSharedResultAfterDelivery, sqlRowRestoreHeld } from "./restore-fence.ts";
import { roomRequest } from "./room-requests.ts";
import { BACKFILL_NAME, LEGACY_SHARED_OWED_INDEX_DDL, OWED_RETRY_FIRST_MS, backfillRoomRequestOwed, settleOwedSharedResults, upgradeRoomRequestOwed, type OwedSharedDeps } from "./room-request-owed.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => closeDatabase());

const TRIGGERS = ["room_request_owed_classify", "room_request_owed_shared_ins", "room_request_owed_shared_upd", "room_request_owed_shared_clear", "room_request_owed_fanout_ins", "room_request_owed_fanout_upd", "room_request_owed_fanout_child", "room_request_owed_gone"];
const COLUMNS = "id,root_id,parent_id,group_id,verb,from_kind,to_bot_id,target_thread_id,state,payload_text,refusal,outcome_note,result_message_id,created_at,finished_at,root_thread_id,origin,audience_fingerprint,not_owner_audience,unattended,admission_key";
function rowInserter(db: DatabaseSync) {
  const stmt = db.prepare(`INSERT INTO room_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'desktop','fp',0,0,?)`);
  const provenance = db.prepare("INSERT OR REPLACE INTO shared_request_provenance(request_id, origin) VALUES(?, 'none')");
  return (id: string, o: { verb: string; to?: string | null; target?: string | null; state: string; refusal?: string | null; shared?: boolean }) => {
    if (o.shared) provenance.run(id);   // shared work is recorded as such when it is created
    return stmt.run(id, id, null, "g", o.verb, "bot", o.to ?? null, o.target ?? null, o.state, null, o.refusal ?? null, null, null, 1, 1, "t", `key-${id}`);
  };
}
function asOlderRelease(db: DatabaseSync): void {
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  db.exec("DELETE FROM room_request_owed; DELETE FROM room_request_backfills");
}
const owed = (db: DatabaseSync) => db.prepare("SELECT request_id AS id, shared, destination_thread_id AS destination, attempts, retry_at AS retryAt FROM room_request_owed WHERE kind='shared_delivery' ORDER BY request_id").all() as Array<{ id: string; shared: number | null; destination: string | null; attempts: number; retryAt: number }>;

describe("(1) the backfill of a heavy history is an upgrade step with progress, not a silent pause", () => {
  it("reports progress between bounded batches and the later initializers have nothing left to scan", () => {
    const db = database(), insert = rowInserter(db);
    asOlderRelease(db);
    db.exec("BEGIN");
    for (let i = 0; i < 5_000; i++) insert(`h-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    db.exec("COMMIT");
    const seen: Array<[number, number]> = [];
    expect(upgradeRoomRequestOwed(db, (done, total) => seen.push([done, total]))).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);                               // 5,000 rows in 2,000-row batches: 2000, 4000, 5000
    expect(seen.map(([done]) => done)).toEqual([...seen.map(([done]) => done)].sort((a, b) => a - b));
    expect(new Set(seen.map(([, total]) => total))).toEqual(new Set([5_000]));
    expect(seen.at(-1)).toEqual([5_000, 5_000]);
    expect(db.prepare("SELECT completed FROM room_request_backfills WHERE name=?").get(BACKFILL_NAME)).toEqual({ completed: 1 });
    expect(upgradeRoomRequestOwed(db, () => { throw new Error("must not run again"); })).toBe(false);
    expect(backfillRoomRequestOwed(db)).toBe(0);
  });
  it("a failing status note never fails the backfill", () => {
    const db = database(), insert = rowInserter(db);
    asOlderRelease(db);
    for (let i = 0; i < 3; i++) insert(`h-${i}`, { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    expect(() => upgradeRoomRequestOwed(db, () => { throw new Error("status file unwritable"); })).not.toThrow();
    expect(owed(db)).toHaveLength(3);
  });
  it("the reporter writes done/total for the shell and database() runs the backfill before the note is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-owed-status-"));
    try {
      const report = memoryUpgradeReporter(root, basename);
      report.indexing({ done: 2_000, total: 5_000 });
      expect(readMemoryUpgradeStatus(root, { pid: process.pid })).toMatchObject({ state: "upgrading", phase: "indexing", done: 2_000, total: 5_000 });
      report.indexing();
      expect(readMemoryUpgradeStatus(root, { pid: process.pid })).toMatchObject({ phase: "indexing" });
    } finally { removeTempDirSync(root); }
    const source = readFileSync(new URL("./database.ts", import.meta.url), "utf8");
    const backfill = source.indexOf("upgradeRoomRequestOwed(db, (done, total) => upgrade.indexing({ done, total })");
    expect(backfill).toBeGreaterThan(-1);
    expect(source.indexOf("upgrade.done();", backfill)).toBeGreaterThan(backfill);
    expect(backfill).toBeLessThan(source.indexOf("initializeProjectTables(db);"));
  });
  it("a fresh installation (no room_requests yet) is left to the normal initializers", () => {
    const db = new DatabaseSync(":memory:");
    expect(upgradeRoomRequestOwed(db, () => { throw new Error("nothing to report"); })).toBe(false);
    db.close();
  });
});

describe("(2) the old shared-owed index is dropped on upgrade and accepted, exactly, in older archives", () => {
  it("an upgraded database loses the index and keeps passing snapshot inspection", () => {
    const db = database();
    db.exec(LEGACY_SHARED_OWED_INDEX_DDL);
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='room_requests_shared_owed'").get()).toBeDefined();
    initializeProjectTables(db);                                              // what every start runs
    expect(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='room_requests_shared_owed'").get()).toBeUndefined();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
  });
  it("snapshot inspection accepts the exact legacy definition of an older archive, and nothing near it", () => {
    const db = database();
    db.exec(LEGACY_SHARED_OWED_INDEX_DDL);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("DROP INDEX room_requests_shared_owed; CREATE INDEX room_requests_shared_owed ON room_requests(id) WHERE state IN ('done','failed')");
    expect(() => inspectInstallationDatabase(db)).toThrow();
    db.exec("DROP INDEX room_requests_shared_owed; CREATE UNIQUE INDEX room_requests_shared_owed ON room_requests(id) WHERE state IN ('done','failed') AND verb!='wake' AND target_thread_id IS NOT NULL AND refusal IS NOT 'delivered'");
    expect(() => inspectInstallationDatabase(db)).toThrow();
  });
  it("an owed table from the first build of this release (no provenance columns) is rebuilt and reseeded", () => {
    const db = database(), insert = rowInserter(db);
    insert("a", { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    db.exec("DROP TABLE room_request_owed; CREATE TABLE room_request_owed (kind TEXT NOT NULL CHECK(kind IN ('shared_delivery','fanout')), request_id TEXT NOT NULL, PRIMARY KEY(kind, request_id)) WITHOUT ROWID");
    initializeProjectTables(db);
    expect(owed(db).map(row => row.id)).toEqual(["a"]);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
  });
});

describe("(3) a held shared result keeps its hold until it is delivered", () => {
  function held() {
    const db = database(), insert = rowInserter(db);
    insert("r1", { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    fenceRestoredSql(db, "gen-1");
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
    return db;
  }
  it("a publication that throws, or reports nothing delivered, leaves it held and the retry delivers", () => {
    const db = held();
    expect(releaseSharedResultAfterDelivery(db, "r1", () => { throw new Error("injected publication failure"); })).toBe(false);
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
    expect(releaseSharedResultAfterDelivery(db, "r1", () => false)).toBe(false);
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(true);
    expect(releaseSharedResultAfterDelivery(db, "r1", () => { db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id='r1'").run(); return true; })).toBe(true);
    expect(sqlRowRestoreHeld(db, "shared_result", "r1")).toBe(false);
  });
  it("the Release route checks authority, publishes, and only then drops the hold (409 otherwise)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const route = source.slice(source.indexOf("restore-holds\\/(output_receipt|shared_result)"), source.indexOf("held-continuations"));
    const check = route.indexOf("checkHeldRelease(db, kind, rowId, presented"), after = route.indexOf("releaseSharedResultAfterDelivery(db, rowId");
    expect(check).toBeGreaterThan(-1);
    expect(after).toBeGreaterThan(check);
    expect(route.indexOf("publishHeldSharedResult(rowId)")).toBeGreaterThan(after);
    expect(source.slice(source.indexOf("function publishHeldSharedResult"), source.indexOf("function deliverOwedSharedResults"))).toContain("deliverSharedResult(request)");
    expect(route.slice(0, route.indexOf("saved output")).includes("releaseHeldItem(")).toBe(false);
    expect(route).toMatch(/if \(!finished\) return json\(res, 409/);
  });
});

describe("(4) delivery debt survives transient unavailability", () => {
  type Req = { id: string };
  function harness(db: DatabaseSync) {
    const state = { live: false, deleted: false, delivered: false, deliverWorks: true, now: 1_000_000 };
    const delivered: string[] = [];
    const deps: OwedSharedDeps<Req> = {
      held: () => false, load: id => roomRequest(db, id) ?? undefined, destination: () => "dest",
      live: () => state.live, deleted: () => state.deleted, delivered: () => state.delivered, now: () => state.now,
      deliver: request => { delivered.push(request.id); if (state.deliverWorks) db.prepare("UPDATE room_requests SET refusal='delivered' WHERE id=? AND state IN ('done','failed')").run(request.id); },
    };
    return { state, delivered, settle: () => settleOwedSharedResults(db, deps) };
  }
  function oneOwed() {
    const db = database();
    rowInserter(db)("r1", { verb: "ask", to: "b", target: "tt", state: "done", shared: true });
    expect(owed(db)).toHaveLength(1);
    return db;
  }
  it("a destination that is not loaded yet keeps the row, backs off, and delivers once available", () => {
    const db = oneOwed(), h = harness(db);
    h.settle();                                                                // destination thread not loaded yet
    expect(owed(db)).toMatchObject([{ id: "r1", attempts: 1, retryAt: h.state.now + OWED_RETRY_FIRST_MS }]);
    expect(h.settle()).toBe(0);                                                // inside the backoff window: not selected, nothing is tried
    expect(h.delivered).toEqual([]);
    h.state.now += OWED_RETRY_FIRST_MS + 1;
    h.settle();
    expect(owed(db)).toMatchObject([{ attempts: 2 }]);                         // still waiting for the destination
    h.state.live = true; h.state.now += 10 * OWED_RETRY_FIRST_MS;
    h.settle();
    expect(h.delivered).toEqual(["r1"]);
    expect(owed(db)).toEqual([]);                                              // cleared by the confirmed delivery
  });
  it("shared provenance is written on the row when the debt is recorded and nothing later can undo it", () => {
    const db = oneOwed(), h = harness(db);
    expect(owed(db)).toMatchObject([{ shared: 1, destination: "t" }]);          // stamped by the database, never by the registry
    h.state.live = true; h.state.deliverWorks = false;
    h.settle();                                                                // delivery attempted but did not go through
    expect(owed(db)).toMatchObject([{ shared: 1, destination: "t", attempts: 1 }]);
    h.state.now += 10 * OWED_RETRY_FIRST_MS; h.state.deliverWorks = true;
    h.settle();
    expect(h.delivered).toEqual(["r1", "r1"]);
    expect(owed(db)).toEqual([]);
  });
  it("only durable terminal decisions clear without a delivery", () => {
    for (const [name, set] of [
      ["requester deleted (tombstone)", (s: ReturnType<typeof harness>["state"]) => { s.deleted = true; }],
      ["receipt exists", (s: ReturnType<typeof harness>["state"]) => { s.live = true; s.delivered = true; }],
    ] as const) {
      closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
      const db = oneOwed(), h = harness(db);
      set(h.state); h.settle();
      expect(owed(db), name).toEqual([]);
      expect(h.delivered, name).toEqual([]);
    }
    const db = (closeDatabase(), removeTempDirSync(DATA_DIR), mkdirSync(DATA_DIR, { recursive: true }), oneOwed());
    db.prepare("DELETE FROM room_requests WHERE id='r1'").run();
    expect(owed(db)).toEqual([]);                                              // request row gone
  });
  it("a fan-out whose room is not in the registry yet stays owed (source check)", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("settleOwedFanouts(db, (row, decided)");
    const body = source.slice(start, start + 4_500);
    expect(body).toMatch(/if \(!group\) return;/);
    expect(body).toMatch(/if \(!responders\.length\) return;/);
  });
});
