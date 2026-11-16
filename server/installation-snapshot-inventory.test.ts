import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { initializeMessageTables } from "./message-tables.ts";
import { initializePhones } from "./phones/registry.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { APP_SCHEMA_102_ADDITIONS } from "./installation-app-schema-downgrade.ts";
import { ADDED_TABLE_LIFECYCLE } from "./added-table-lifecycle.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const mutant = vi.hoisted(() => ({ unclassified: false }));
vi.mock("./phones/registry.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./phones/registry.ts")>();
  return { ...original, initializePhones(db: DatabaseSync) {
    original.initializePhones(db);
    if (mutant.unclassified) db.exec("CREATE TABLE unclassified_phone_state (id TEXT PRIMARY KEY)");
  } };
});
afterEach(() => { mutant.unclassified = false; vi.resetModules(); });

it("classifies every table the snapshot schema initializers create, including optional phone state", async () => {
  const { registeredSnapshotObjects, inspectInstallationDatabase } = await import("./installation-database-snapshot.ts");
  // Building the reference walks every initializer, including flag-gated tables.
  const known = registeredSnapshotObjects();
  expect(APP_SCHEMA_102_ADDITIONS.tables).toContain("phone_ask_optins");
  expect(ADDED_TABLE_LIFECYCLE.phone_ask_optins).toMatchObject({ kind: "marker" });
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db);
    initializePhones(db);
    for (const row of db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()) {
      expect(known.has(String(row.name)), String(row.name)).toBe(true);
    }
    db.exec("INSERT INTO phone_ask_optins VALUES ('fixture-phone', 1)");
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    expect(db.prepare("SELECT * FROM phone_ask_optins").all()).toEqual([{ device_id: "fixture-phone", opted_in: 1 }]);
    db.exec("DROP TABLE phone_ask_optins");
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("CREATE TABLE phone_ask_optins (device_id TEXT PRIMARY KEY, opted_in TEXT)");
    expect(() => inspectInstallationDatabase(db)).toThrow(/DATABASE_SCHEMA_UNSUPPORTED/);
  } finally { db.close(); }
});

it("fails closed when an initializer adds an unclassified table", async () => {
  mutant.unclassified = true;
  const { registeredSnapshotObjects } = await import("./installation-database-snapshot.ts");
  expect(() => registeredSnapshotObjects()).toThrow("initializer created an object outside APP_TABLES: unclassified_phone_state");
});

it("keeps both disclosure choices in an owned installation snapshot", async () => {
  const { snapshotInstallationDatabase } = await import("./installation-database-snapshot.ts");
  const root = mkdtempSync(join(tmpdir(), "murage-optin-snapshot-"));
  try {
    const data = join(root, "installation");
    mkdirSync(data);
    const source = new DatabaseSync(join(data, "messages.db"));
    try {
      initializeMessageTables(source);
      initializePhones(source);
      source.exec("INSERT INTO phone_ask_optins VALUES ('allows',1),('declines',0)");
    } finally { source.close(); }
    const output = join(root, "snapshot.db");
    expect(await snapshotInstallationDatabase(data, output)).toMatchObject({ status: "copied" });
    const copy = new DatabaseSync(output, { readOnly: true });
    try {
      expect(copy.prepare("SELECT * FROM phone_ask_optins ORDER BY device_id").all()).toEqual([
        { device_id: "allows", opted_in: 1 }, { device_id: "declines", opted_in: 0 },
      ]);
    } finally { copy.close(); }
  } finally { removeTempDirSync(root); }
});

it("accepts the exact pre-pack queue and refuses a changed owner proof column", async () => {
  const { inspectInstallationDatabase } = await import("./installation-database-snapshot.ts");
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db);
    initializePendingDelegations(db);
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("ALTER TABLE pending_delegations DROP COLUMN owner_rooted");
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("ALTER TABLE pending_delegations ADD COLUMN owner_rooted TEXT");
    expect(() => inspectInstallationDatabase(db)).toThrow(/DATABASE_SCHEMA_UNSUPPORTED/);
  } finally { db.close(); }
});
