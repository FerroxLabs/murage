import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { initializePhones, PhoneRegistry } from "./phones/registry.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeDatabase(); });

it.each([10, 13] as const)("removes 1.0.19 opt-in state when stepping back to memory schema %s", async to => {
  const db = database();
  initializePhones(db);
  db.exec("INSERT INTO phone_ask_optins VALUES ('fixture-phone', 1)");
  closeDatabase();
  await stopWalMaintenance();
  expect(downgradeInstallationMemorySchema(DATA_DIR, to)).toMatchObject({ status: "downgraded", to });
  const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true, timeout: 5000 });
  try {
    expect(after.prepare("SELECT name FROM sqlite_schema WHERE name='phone_ask_optins'").all()).toEqual([]);
  } finally { after.close(); }
});

it("does not resurrect stale opt-in consent when a downgraded registration is upgraded again", async () => {
  const db = database();
  initializePhones(db);
  db.exec(`INSERT INTO phone_registrations VALUES ('fixture-phone', '{"deviceIdOptIn":true}', 1);
    INSERT INTO phone_ask_optins VALUES ('fixture-phone', 0)`);
  closeDatabase();
  await stopWalMaintenance();
  downgradeInstallationMemorySchema(DATA_DIR, 13);
  const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { timeout: 5000 });
  try {
    initializePhones(after);
    expect(new PhoneRegistry(after, () => 1).deviceIdOptIn("fixture-phone")).toBe(false);
  } finally { after.close(); }
});
