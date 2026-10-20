// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 4 #1 and #3: every table 1.0.2 adds is on ONE list (APP_SCHEMA_102_ADDITIONS.tables, which the downgrade drops and the snapshot
// accepts), and each has a lifecycle entry. The list is checked against the real 1.0.1 (git archive d950cbf67 in the gitignored .v101-ref
// directory), in both directions; the real 1.0.1 inspector accepts a downgraded file with rows in every registered table; rows of a child table never
// outlive their request.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDED_TABLE_LIFECYCLE, ensureChildTable, sweepAddedOrphans } from "./added-table-lifecycle.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { APP_SCHEMA_102_ADDITIONS, CARD_DELIVERY_OWED_LINE, DOWNGRADE_CARD_DELIVERY_OWED, downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { validateMemorySchema } from "./memory/schema.ts";
import { deleteProjectRows } from "./project-tables.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { insertRoomRequest, pruneTerminalRoomRequests, ROOM_REQUEST_RETENTION_MS } from "./room-requests.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { haveV101, realV101 } from "./testing/pm-sends-v101.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { settleTestHandles } from "./test-handle-registry.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });

const CHILDREN = Object.entries(ADDED_TABLE_LIFECYCLE).filter(([, entry]) => entry.kind === "child").map(([name]) => name);
const lineage = { rootThreadId: "t", origin: "desktop" as const, audienceFingerprint: "owner", notOwnerAudience: false, unattended: false };
function request(id: string, groupId = "g", finishedAt?: number): void {
  const db = database();
  insertRoomRequest(db, { id, groupId, verb: "ask", fromKind: "bot", fromBotId: "a", toBotId: "b", admissionKey: `k-${id}`, now: 1, lineage });
  if (finishedAt !== undefined) db.prepare("UPDATE room_requests SET state='done', finished_at=? WHERE id=?").run(finishedAt, id);
}
/** The one required column (beside request_id) each child table takes, and a value for it. */
const CHILD_COLUMN: Record<string, [string, string]> = { shared_request_events: ["event_id", "'e'"], project_card_delivery_owed: ["created_at", "1"], room_request_status: ["status_key", "'request_failed'"] };
const childInsert = (name: string, requestIds: string[]): string => `INSERT INTO ${name} (request_id, ${CHILD_COLUMN[name][0]}) VALUES ${requestIds.map(id => `('${id}', ${CHILD_COLUMN[name][1]})`).join(", ")}`;
function mapping(id: string): void {
  const db = database();
  db.prepare("INSERT INTO shared_request_events (request_id, event_id) VALUES (?,?)").run(id, "event");
  db.prepare("INSERT INTO project_card_delivery_owed (request_id, payload, created_at) VALUES (?,?,?)").run(id, null, 1);
  db.prepare("INSERT INTO room_request_status (request_id, status_key) VALUES (?,?)").run(id, "request_failed");
}
const rows = (table: string): number => Number((database().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("the lifecycle map beside the list of added tables", () => {
  it("has one entry for every listed table and no entry for a table that is not listed", () => {
    const listed = [...APP_SCHEMA_102_ADDITIONS.tables].sort();
    expect(Object.keys(ADDED_TABLE_LIFECYCLE).sort()).toEqual(listed);
  });

  it("a retained entry names a function that exists, and a child entry carries its cascade in a fresh database", () => {
    const sources = readdirSync(__dirname).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts")).map(file => readFileSync(join(__dirname, file), "utf8")).join("\n");
    for (const [name, entry] of Object.entries(ADDED_TABLE_LIFECYCLE)) {
      if (entry.kind === "retained") expect(sources, `${name} is retained by ${entry.by}`).toMatch(new RegExp(`\\b${entry.by}\\b`));
      if (entry.kind === "marker") expect(entry.reason.length, `${name} says why it is a marker`).toBeGreaterThan(10);
    }
    expect(CHILDREN.sort()).toEqual(["project_card_delivery_owed", "room_request_status", "shared_request_events"]);
    for (const name of CHILDREN) {
      const keys = database().prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string; from: string; on_delete: string }>;
      expect(keys, name).toEqual([expect.objectContaining({ table: "room_requests", from: "request_id", on_delete: "CASCADE" })]);
    }
  });

  it("every child entry is reached by the sweep, and the sweep is reached from pruning and from project deletion", () => {
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF");
    for (const name of CHILDREN) {
      db.prepare(childInsert(name, ["orphan"])).run();
      expect(rows(name)).toBe(1);
    }
    expect(sweepAddedOrphans(db)).toBe(CHILDREN.length);
    for (const name of CHILDREN) expect(rows(name), name).toBe(0);
    // pruning and group deletion each run the sweep on their own
    for (const run of [() => pruneTerminalRoomRequests(db, Date.now()), () => deleteProjectRows(db, "g", Date.now())]) {
      for (const name of CHILDREN) db.prepare(childInsert(name, ["orphan"])).run();
      run();
      for (const name of CHILDREN) expect(rows(name), name).toBe(0);
    }
    db.exec("PRAGMA foreign_keys=ON");
  });
});

describe("rows that belong to a request leave with it", () => {
  it("pruning 1,000 finished requests leaves no mapping behind", () => {
    const db = database();
    const old = Date.now() - ROOM_REQUEST_RETENTION_MS - 60_000;
    db.exec("BEGIN");
    for (let i = 0; i < 1000; i++) { request(`r${i}`, "g", old); mapping(`r${i}`); }
    request("fresh", "g"); mapping("fresh");
    db.exec("COMMIT");
    expect(rows("shared_request_events")).toBe(1001);
    pruneTerminalRoomRequests(db, Date.now());
    for (const name of CHILDREN) expect(rows(name), name).toBe(1);
  });

  it("deleting a project group takes its mappings with it", () => {
    request("in-group", "doomed"); request("elsewhere", "kept");
    mapping("in-group"); mapping("elsewhere");
    deleteProjectRows(database(), "doomed", Date.now());
    for (const name of CHILDREN) expect(rows(name), name).toBe(1);
    expect(database().prepare("SELECT request_id FROM shared_request_events").get()).toEqual({ request_id: "elsewhere" });
  });

  it("a restored file with orphan rows (made with foreign keys off) is cleaned by the next prune", async () => {
    request("old", "g", 1); mapping("old");
    // the server connection, then the WAL checkpointer's (it leaves after closeDatabase returns): a raw writer waits for both
    await settleTestHandles(DATA_DIR);
    const raw = new DatabaseSync(join(DATA_DIR, "messages.db"));
    raw.exec("PRAGMA foreign_keys=OFF; DELETE FROM room_requests WHERE id='old'");
    expect(Number((raw.prepare("SELECT COUNT(*) AS n FROM shared_request_events").get() as { n: number }).n)).toBe(1);
    raw.close();
    pruneTerminalRoomRequests(database(), Date.now());
    for (const name of CHILDREN) expect(rows(name), name).toBe(0);
  });

  it("a table an earlier build made without the cascade is rebuilt once, keeping only rows whose request exists", () => {
    request("live", "g");
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF");
    for (const name of CHILDREN) {
      const legacy = ADDED_TABLE_LIFECYCLE[name];
      if (legacy.kind !== "child" || !legacy.legacyDdl.length) continue;
      db.exec(`DROP TABLE ${name}`);
      db.exec(legacy.legacyDdl[0]);
      db.prepare(childInsert(name, ["live", "orphan"])).run();
    }
    db.exec("PRAGMA foreign_keys=ON");
    initializeSharedRequestProvenance(db); initializeProjectCardDelivery(db);
    for (const name of CHILDREN.filter(child => { const entry = ADDED_TABLE_LIFECYCLE[child]; return entry.kind === "child" && entry.legacyDdl.length > 0; })) {
      expect((db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name) as { sql: string }).sql, name).toMatch(/ON DELETE CASCADE/);
      expect((db.prepare(`SELECT request_id FROM ${name}`).all() as Array<{ request_id: string }>).map(row => row.request_id), name).toEqual(["live"]);
    }
    // and a second run changes nothing
    ensureChildTable(db, "shared_request_events");
    expect(rows("shared_request_events")).toBe(1);
  });

  it("an archive written before the cascade still passes the inspector", () => {
    const file = join(DATA_DIR, "legacy.db");
    const db = database();
    db.exec("PRAGMA foreign_keys=OFF; DROP TABLE shared_request_events");
    const legacy = ADDED_TABLE_LIFECYCLE.shared_request_events;
    if (legacy.kind !== "child") throw new Error("shared_request_events is a child table");
    db.exec(legacy.legacyDdl[0]);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`VACUUM INTO '${file}'`);
    const copy = new DatabaseSync(file);
    try { expect(() => inspectInstallationDatabase(copy)).not.toThrow(); } finally { copy.close(); }
  });
});

describe("R5-04: a card result still owed to its project room is never discarded by the downgrade", () => {
  it("refuses with a plain sentence, leaves the owed row and its payload where they were, and goes through once the delivery is done", () => {
    const db = database();
    request("card", "g", 1);
    db.prepare("INSERT INTO project_card_delivery_owed (request_id, payload, created_at) VALUES (?,?,?)").run("card", '{"text":"the card result"}', 1);
    let refusal: unknown;
    try { downgradeApplicationSchemaTo101(db, DATA_DIR); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: DOWNGRADE_CARD_DELIVERY_OWED, message: CARD_DELIVERY_OWED_LINE });
    expect(CARD_DELIVERY_OWED_LINE).toBe("Some card results have not reached their room yet. Reopen this version of Murage to retry delivery, then try again.");
    // the window shown by the desktop shell says the same words, word for word
    expect(readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8")).toContain(`DOWNGRADE_CARD_DELIVERY_OWED: "${CARD_DELIVERY_OWED_LINE}"`);
    expect(CARD_DELIVERY_OWED_LINE).not.toMatch(/[\u2014]|DOWNGRADE|_/);
    expect(db.prepare("SELECT payload FROM project_card_delivery_owed WHERE request_id='card'").get()).toEqual({ payload: '{"text":"the card result"}' });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='shared_request_events'").get()).toBeDefined();
    db.prepare("DELETE FROM project_card_delivery_owed WHERE request_id='card'").run();
    expect(() => downgradeApplicationSchemaTo101(db, DATA_DIR)).not.toThrow();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='project_card_delivery_owed'").get()).toBeUndefined();
  });
});

describe("against the real 1.0.1 (git archive d950cbf67)", () => {
  it.skipIf(!haveV101)("the list is exactly the objects 1.0.2 adds: nothing unlisted is added, nothing listed already existed in 1.0.1", async () => {
    const db = database();
    const memory = validateMemorySchema(db);
    const current = (db.prepare("SELECT type,name,tbl_name FROM sqlite_schema").all() as Array<{ type: string; name: string; tbl_name: string }>)
      .filter(row => !memory.has(row.name) && !row.name.startsWith("memory_") && !row.tbl_name.startsWith("memory_"));
    const { referenceSchema } = await realV101();
    const old = new Set(referenceSchema().keys());
    const listed = new Set<string>([...APP_SCHEMA_102_ADDITIONS.triggers, ...APP_SCHEMA_102_ADDITIONS.indexes, ...APP_SCHEMA_102_ADDITIONS.tables]);
    const addedTables = new Set<string>(APP_SCHEMA_102_ADDITIONS.tables);
    // 1.0.2 objects the list does not name (an auto-index of a listed table goes with its table)
    const unlisted = current.filter(row => !old.has(row.name) && !listed.has(row.name) && !(row.name.startsWith("sqlite_autoindex_") && addedTables.has(row.tbl_name))).map(row => row.name);
    expect(unlisted, "added in 1.0.2 but missing from APP_SCHEMA_102_ADDITIONS").toEqual([]);
    // listed objects that exist here must be new: a 1.0.1 object on the list would be dropped by the downgrade
    const present = new Set(current.map(row => row.name));
    expect([...listed].filter(name => present.has(name) && old.has(name)), "on the list but already in 1.0.1").toEqual([]);
    // the tables this lane registers are really there and really new
    for (const name of CHILDREN) { expect(present.has(name), name).toBe(true); expect(old.has(name), name).toBe(false); }
  });

  it.skipIf(!haveV101)("the real 1.0.1 inspector accepts a downgraded file that held rows in every registered table", async () => {
    request("one", "g", 1); mapping("one");
    request("two", "g"); mapping("two");
    expect(rows("shared_request_events")).toBe(2);
    // the owed deliveries must be delivered first: the downgrade refuses until they are
    closeDatabase();
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 6)).toThrow(expect.objectContaining({ code: DOWNGRADE_CARD_DELIVERY_OWED }));
    database().prepare("DELETE FROM project_card_delivery_owed").run();
    closeDatabase();
    const result = downgradeInstallationMemorySchema(DATA_DIR, 6);
    expect(result).toMatchObject({ status: "downgraded", to: 6 });
    const { inspectInstallationDatabase: inspect101 } = await realV101();
    const down = new DatabaseSync(join(DATA_DIR, "messages.db"));
    try {
      expect(() => inspect101(down)).not.toThrow();
      const names = (down.prepare("SELECT name FROM sqlite_schema").all() as Array<{ name: string }>).map(row => row.name);
      for (const table of CHILDREN) expect(names.includes(table), table).toBe(false);
    } finally { down.close(); }
  }, 120_000);
});
