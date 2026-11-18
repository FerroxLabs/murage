// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A backup written before the append guard carries the unguarded
// routine_link_before_insert trigger. The snapshot check runs before any
// migration, so it must accept exactly that predecessor text and nothing near
// it; the first open then replaces it. The predecessor text is pinned by a
// digest taken from the earlier build, independent of this build's generator.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL, routineMessageAnchor } from "./routine-message-links.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const TRIGGER = "routine_link_before_insert";
const PREDECESSOR_SHA256 = "d32f3c5fdaac63c4176cc3ce29b550d18d9ee6255caa59bc2d57240cb11cc650";
const triggerSql = (db: DatabaseSync) => String(db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(TRIGGER)!.sql);
function installPredecessor(db: DatabaseSync): string {
  const current = triggerSql(db);
  db.exec(`DROP TRIGGER ${TRIGGER}`);
  db.exec(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL);
  return current;
}

it("the predecessor trigger text is the earlier build's exact definition", () => {
  expect(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL).toHaveLength(10212);
  expect(createHash("sha256").update(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL).digest("hex")).toBe(PREDECESSOR_SHA256);
});

it("the database check accepts the predecessor insert trigger, and the first open replaces it without losing a row", () => {
  const f = backupFixture();
  try {
    const current = installPredecessor(f.db);
    expect(triggerSql(f.db)).not.toBe(current);
    expect(createHash("sha256").update(triggerSql(f.db)).digest("hex")).toBe(PREDECESSOR_SHA256);
    expect(inspectInstallationDatabase(f.db)).toMatchObject({ messages: 1, threads: 1 });
    initializeMessageTables(f.db);
    expect(triggerSql(f.db)).toBe(current);
    expect(inspectInstallationDatabase(f.db)).toMatchObject({ messages: 1, threads: 1 });
    expect(routineMessageAnchor(f.db, "thread", 1)).toBe("message");
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.each([
  ["an added statement", (sql: string) => sql.replace("BEGIN ", "BEGIN DELETE FROM messages; ")],
  ["another admission predicate", (sql: string) => sql.replace(" BEGIN ", " WHEN NEW.id IS NOT NULL BEGIN ")],
  ["another event", (sql: string) => sql.replace("BEFORE INSERT", "AFTER INSERT")],
])("the database check still refuses the predecessor trigger with %s", (_label, alter) => {
  const f = backupFixture();
  try {
    f.db.exec(`DROP TRIGGER ${TRIGGER}`);
    const altered = alter(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL);
    expect(altered).not.toBe(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL);
    f.db.exec(altered);
    expect(() => inspectInstallationDatabase(f.db)).toThrow(expect.objectContaining({ code: "DATABASE_SCHEMA_UNSUPPORTED" }));
  } finally { f.db.close(); removeTempDirSync(f.parent); }
});

it.skipIf(!rawAgeHost)("a real encrypted backup carrying the predecessor trigger restores, and the next open installs the guard", { timeout: 180_000 }, async () => {
  const f = backupFixture(), keys = testAgeKeys();
  try {
    const current = installPredecessor(f.db);
    f.db.close();
    const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;
    const archive = join(f.parent, "backup.age");
    const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
    const target = join(f.parent, "restored");
    const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(restored.status).toBe("restored-review-required");
    const opened = new DatabaseSync(join(target, "messages.db"));
    try {
      expect(opened.prepare("SELECT id FROM messages").all()).toEqual([{ id: "message" }]);
      initializeMessageTables(opened);
      expect(triggerSql(opened)).toBe(current);
      expect(routineMessageAnchor(opened, "thread", 1)).toBe("message");
    } finally { opened.close(); }
  } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
});
