// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Going back to a build without connected-app triggers. Older builds refuse a messages.db holding tables they do not know, so
// the seven tables and every index leave, in one commit, while everything else in the file and the routine stay.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APP_TRIGGER_OBJECTS, APP_TRIGGER_TABLES, downgradeAppTriggers, initializeAppTriggers } from "./app-trigger-store.ts";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const objects = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);
const holdOneDelivery = (db: DatabaseSync) => db.exec(`INSERT INTO app_event_tombstones (delivery_id, disposition, at) VALUES ('d-1', 'filtered', 1)`);

describe("downgradeAppTriggers", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE kept (id TEXT)"); initializeAppTriggers(db); });
  afterEach(() => { db.close(); });

  it("the object list is exactly what the store makes", () => {
    expect([...APP_TRIGGER_OBJECTS].sort()).toEqual(objects(db).filter(name => name !== "kept"));
  });

  it("every table and index leaves, rows held or not, and a second run changes nothing", () => {
    holdOneDelivery(db);
    expect(downgradeAppTriggers(db)).toEqual({ dropped: APP_TRIGGER_TABLES.length });
    expect(objects(db)).toEqual(["kept"]);
    expect(downgradeAppTriggers(db)).toEqual({ dropped: 0 });
  });

  it("a failure part way changes nothing; the run after it finishes the job", () => {
    holdOneDelivery(db);
    const before = objects(db);
    const failing = new Proxy(db, {
      get(target, name) {
        if (name === "exec") return (sql: string) => { if (sql === "DROP TABLE app_event_runs") throw new Error("injected"); target.exec(sql); };
        const value = Reflect.get(target, name) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => downgradeAppTriggers(failing)).toThrow("injected");
    expect(objects(db)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_event_tombstones").get()).toEqual({ n: 1 });
    expect(downgradeAppTriggers(db)).toEqual({ dropped: APP_TRIGGER_TABLES.length });
  });
});

describe("memory-downgrade", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });

  it.each([12, 10, 1] as const)("--to %i leaves no app trigger object, and the app_event routine stays in routines.json", (to) => {
    database();
    closeDatabase();
    const routine = { id: "r-app", botId: "b", schedule: { type: "app_event", triggerId: "754ff2fc-423d-5573-bded-ccf9fb7cde23" } };
    writeFileSync(join(DATA_DIR, "routines.json"), JSON.stringify({ routines: [routine] }));
    downgradeInstallationMemorySchema(DATA_DIR, to);
    const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(objects(after).filter(name => APP_TRIGGER_OBJECTS.includes(name))).toEqual([]); } finally { after.close(); }
    expect((JSON.parse(readFileSync(join(DATA_DIR, "routines.json"), "utf8")) as { routines: unknown[] }).routines).toEqual([routine]);
  });
});
