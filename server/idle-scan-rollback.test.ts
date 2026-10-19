// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Astra idle-scan r7: a cache filled from rows read inside a transaction must not outlive that transaction's rollback.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { IoBudget, instrumentDatabase, sharedRowsStamp, writeStamp } from "./io-budget.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { insertRoomRequest } from "./room-requests.ts";
import { scopedTx } from "./tx-scope.ts";
import { budgetUsageTotals, projectUsage, rollupSettledUsage, settleProjectUsage } from "./usage-ledger.ts";

/** Runs `work` in a real transaction inside a tx-scope frame and rolls both back, as a failed caller would. */
function rolledBack<T>(db: DatabaseSync, work: () => T): T {
  let out!: T;
  scopedTx(() => { db.exec("BEGIN"); try { out = work(); } finally { db.exec("ROLLBACK"); } return out; }, () => true);
  return out;
}
const scope = { groupId: "g" };

describe("usage ledger totals", () => {
  const terminal = { threadId: "room", botId: "bot", engine: "fuigo", turnGeneration: "gen", providerTurnId: "one", at: 6000, ok: true, usage: { input: 1000, output: 0 } };
  function fixture() {
    const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
    const request = insertRoomRequest(db, { groupId: "g", projectGoalId: "goal", workItemId: "card", attempt: 1, verb: "room_turn", fromKind: "owner", toBotId: "bot",
      targetThreadId: "room", admissionKey: "k1", now: 1000, state: "running",
      lineage: { rootThreadId: "room", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } }).request;
    return { db, request };
  }

  it("Astra's repro: replacing unknown usage, reading the totals and rolling back leaves the cache on the ledger's rows", () => {
    const { db, request } = fixture();
    try {
      settleProjectUsage(db, request, { ...terminal, unknown: true, at: 1100, lastActivityAt: 1100 });
      const before = budgetUsageTotals(db, scope);
      expect(before.workMs).toBe(100);
      const inside = rolledBack(db, () => {
        settleProjectUsage(db, request, { ...terminal, at: 2000 });
        return budgetUsageTotals(db, scope);
      });
      expect(inside).toMatchObject({ workMs: 1000, input: 1000 }); // the transaction sees its own rows
      expect(budgetUsageTotals(db, scope)).toEqual({ workMs: 100, input: 0, output: 0 });
      expect(projectUsage(db, scope).totals).toMatchObject({ workMs: 100 });
    } finally { db.close(); }
  });

  it("a total read inside a transaction is not kept when the transaction rolls back (new rows)", () => {
    const { db, request } = fixture();
    try {
      budgetUsageTotals(db, scope);
      rolledBack(db, () => { settleProjectUsage(db, request, { ...terminal, at: 2000 }); expect(budgetUsageTotals(db, scope).workMs).toBe(1000); });
      expect(budgetUsageTotals(db, scope)).toEqual({ workMs: 0, input: 0, output: 0 });
    } finally { db.close(); }
  });

  it("a rollup rolled back leaves the cache rebuilt from the restored rows", () => {
    const { db, request } = fixture();
    try {
      settleProjectUsage(db, request, { ...terminal, at: 2000 });
      const before = budgetUsageTotals(db, scope);
      rolledBack(db, () => { rollupSettledUsage(db, 10 ** 13); budgetUsageTotals(db, scope); });
      expect(budgetUsageTotals(db, scope)).toEqual(before);
    } finally { db.close(); }
  });
});

describe("the project close record cache", () => {
  it("a value read inside a transaction is not kept after a rollback", async () => {
    const { closeRecordCache, noteProjectCloseRecords } = await import("./project-records.ts");
    const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
    try {
      let rows = "committed";
      const cache = closeRecordCache<string>();
      expect(cache(db, "g", () => rows)).toBe("committed");
      rolledBack(db, () => { rows = "uncommitted"; noteProjectCloseRecords(db); expect(cache(db, "g", () => rows)).toBe("uncommitted"); });
      rows = "committed"; // the rows are back
      expect(cache(db, "g", () => rows)).toBe("committed");
    } finally { db.close(); }
  });
});

async function stores() {
  const home = mkdtempSync(join(tmpdir(), "murage-idle-rollback-"));
  vi.resetModules(); vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
  const { Store } = await import("./store.ts");
  const { database } = await import("./database.ts");
  return { store: new Store(() => ({ instanceId: "claude", model: "m" })), database };
}

describe("the newest-at cache", () => {
  it("a newest time read inside a transaction is not kept when it rolls back", async () => {
    const { store, database } = await stores();
    const mdb = await import("./message-db.ts");
    const bot = store.createBot(undefined, { seedMessages: false });
    const task = store.createTask(bot.id)!;
    store.appendMessage(task.threadId, { role: "user", kind: "text", text: "old", at: 1_000 });
    expect(mdb.newestMessageAt(task.threadId)).toBe(1_000);
    const db = database();
    scopedTx(() => {
      db.exec("BEGIN");
      try {
        store.appendMessage(task.threadId, { role: "user", kind: "text", text: "new", at: 9_000 });
        expect(mdb.newestMessageAt(task.threadId)).toBe(9_000);
      } finally { db.exec("ROLLBACK"); }
    }, () => true);
    expect(mdb.newestMessageAt(task.threadId)).toBe(1_000);
  });
});

describe("the shared rows cache", () => {
  it("rows built inside a transaction are not kept when it rolls back", async () => {
    const { store, database } = await stores();
    const iris = store.createBot(undefined, { seedMessages: false });
    store.patchBot(iris.id, { name: "Iris", section: "Design", sharedWith: { mode: "all", teams: [] } } as never);
    for (let i = 0; i < 3; i++) { const b = store.createBot(undefined, { seedMessages: false }); store.patchBot(b.id, { section: `Team${i}` }); }
    const wire = await import("./shared-wire.ts");
    const team = wire.sharedRowsFor(store, store.bot(iris.id)!)[0]!;
    const { teamIdFor } = await import("./team-identities.ts");
    const task = store.createSharedWorkTask(iris.id, team.teamId ?? teamIdFor(team.teamName))!;
    const read = () => wire.sharedRowsFor(store, store.bot(iris.id)!).find(item => item.threadId === task.threadId)!;
    expect(read().waiting).toBe(0);
    const db = database();
    scopedTx(() => {
      db.exec("BEGIN");
      try {
        insertRoomRequest(db, { groupId: "g1", verb: "ask", fromKind: "bot", toBotId: iris.id, targetThreadId: task.threadId, admissionKey: "rb-1",
          lineage: { rootThreadId: task.threadId, origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false }, now: 1 });
        expect(read().waiting).toBe(1);
      } finally { db.exec("ROLLBACK"); }
    }, () => true);
    expect(read().waiting).toBe(0);
  });
});

describe("the write stamps and undone writes (Astra idle-scan r8)", () => {
  function stamped() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE room_requests (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE other (id INTEGER PRIMARY KEY)");
    const unregister = instrumentDatabase(db, new IoBudget());
    return { db, done: () => { unregister(); db.close(); } };
  }
  it("a ROLLBACK moves both stamps even though it reports no changes", () => {
    const { db, done } = stamped();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO room_requests (v) VALUES (?)").run("a");
      const general = writeStamp(db), shared = sharedRowsStamp(db);
      db.exec("ROLLBACK");
      expect(writeStamp(db)).not.toBe(general);
      expect(sharedRowsStamp(db)).not.toBe(shared);
    } finally { done(); }
  });
  it("ROLLBACK TO a savepoint moves the stamps, and so does the RELEASE pair the transaction helper runs", () => {
    const { db, done } = stamped();
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("SAVEPOINT p");
      db.prepare("INSERT INTO room_requests (v) VALUES (?)").run("a");
      const general = writeStamp(db);
      db.exec("ROLLBACK TO p; RELEASE p");
      expect(writeStamp(db)).not.toBe(general);
      const after = writeStamp(db);
      db.exec("COMMIT");
      expect(writeStamp(db)).toBe(after); // a commit keeps what was seen
    } finally { done(); }
  });
  it("a rollback after a thrown error inside a transaction moves the stamps", () => {
    const { db, done } = stamped();
    try {
      const run = () => {
        db.exec("BEGIN IMMEDIATE");
        try { db.prepare("INSERT INTO room_requests (v) VALUES (?)").run("a"); throw new Error("boom"); }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      };
      const general = writeStamp(db);
      expect(run).toThrow("boom");
      expect(writeStamp(db)).toBeGreaterThan(general! + 1); // the insert moved it once, the rollback again
    } finally { done(); }
  });
  it("SQLite aborting the transaction itself (INSERT OR ROLLBACK on a conflict) moves the stamps", () => {
    const { db, done } = stamped();
    try {
      db.prepare("INSERT INTO room_requests (id, v) VALUES (1, 'x')").run();
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO other (id) VALUES (1)").run();
      const general = writeStamp(db), shared = sharedRowsStamp(db);
      expect(() => db.prepare("INSERT OR ROLLBACK INTO room_requests (id, v) VALUES (1, 'y')").run()).toThrow();
      expect(db.isTransaction).toBe(false);
      expect(writeStamp(db)).not.toBe(general);
      expect(sharedRowsStamp(db)).not.toBe(shared);
    } finally { done(); }
  });
  it("reads and an empty autocommit do not move the stamps", () => {
    const { db, done } = stamped();
    try {
      const general = writeStamp(db);
      db.prepare("SELECT * FROM room_requests").all();
      db.prepare("DELETE FROM room_requests WHERE id = 99").run();
      expect(writeStamp(db)).toBe(general);
    } finally { done(); }
  });
});
