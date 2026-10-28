// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools and share and ask keep four tables in messages.db: phone_registrations and phone_revocations (phone tools),
// phone_receipts and phone_ask_revocations (share and ask). A backup taken with the flags on holds them, so the restore check
// (inspectInstallationDatabase) must accept them with their rows, a 1.0.8-shaped backup (no such tables) must still restore, and the
// downgrade ("memory-downgrade --to 10") must leave sqlite_master exactly what a fresh 1.0.2 install has, so none of the four stay behind.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { ensureForgetTable } from "./harness/event-log.ts";
import { initializeImageOperations } from "./image-operations-schema.ts";
import { downgradeInstallationMemorySchema } from "./installation-memory-downgrade.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { restoreEncryptedInstallationNew, writeEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { AskRevocations } from "./phones/ask-revocations.ts";
import { PhoneReceipts } from "./phones/receipts.ts";
import { initializePhones } from "./phones/registry.ts";
import { backupFixture, rawAgeHost, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const PHONE_TABLES = ["phone_ask_revocations", "phone_receipts", "phone_registrations", "phone_revocations"];
const selection = { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" } as const;

/** Creates the four tables with the code that makes them when the flags are on, and puts one row in each. */
function withPhoneTables(db: DatabaseSync): void {
  initializePhones(db);
  new AskRevocations(db);
  new PhoneReceipts(db, { database: () => db });
  db.prepare("INSERT INTO phone_registrations (device_id, body, updated_at) VALUES (?,?,?)").run("dev-a", "{}", 5);
  db.prepare("INSERT INTO phone_revocations (device_id, revoked_at, reason) VALUES (?,?,?)").run("dev-b", 6, "removed");
  db.prepare("INSERT INTO phone_ask_revocations (device_id, through) VALUES (?,?)").run("dev-a", 3);
  db.prepare("INSERT INTO phone_receipts (device_id, kind, id, fingerprint, generation, state, at) VALUES (?,?,?,?,?,?,?)").run("dev-a", "share", "r1", "fp", 1, "received", Date.now());
}
const counts = (db: DatabaseSync) => Object.fromEntries(PHONE_TABLES.map(name => [name, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n)]));
const ONE_EACH = { phone_ask_revocations: 1, phone_receipts: 1, phone_registrations: 1, phone_revocations: 1 };

describe("a backup taken with the phone flags on", () => {
  it("passes the restore check, rows intact", () => {
    const f = backupFixture();
    try {
      withPhoneTables(f.db);
      expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
      expect(counts(f.db)).toEqual(ONE_EACH);
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });

  it.skipIf(!rawAgeHost)("restores from an encrypted archive with the four tables and their rows", { timeout: 120_000 }, async () => {
    const f = backupFixture(), keys = testAgeKeys();
    try {
      withPhoneTables(f.db);
      f.db.close();
      const archive = join(f.parent, "backup.age");
      const written = await writeEncryptedInstallationBackup(f.data, archive, { ...keys, selection });
      const target = join(f.parent, "restored");
      const restored = await restoreEncryptedInstallationNew(target, archive, written.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(restored.status).toBe("restored-review-required");
      const db = new DatabaseSync(join(target, "messages.db"));
      try { expect(counts(db)).toEqual(ONE_EACH); } finally { db.close(); }
    } finally { try { f.db.close(); } catch { /* closed above */ } removeTempDirSync(f.parent); }
  });
});

describe("a backup from a build without the four tables (the 1.0.8 shape)", () => {
  it("still passes the restore check", () => {
    const f = backupFixture();
    try {
      for (const name of PHONE_TABLES) expect(f.db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name), name).toBeUndefined();
      expect(() => inspectInstallationDatabase(f.db)).not.toThrow();
    } finally { f.db.close(); removeTempDirSync(f.parent); }
  });
});

describe("the downgrade (memory-downgrade --to 10) with the phone tables present", () => {
  type Row = { type: string; name: string; tbl_name: string; sql: string | null };
  const fresh102 = (JSON.parse(readFileSync(join(import.meta.dirname, "testing", "schema-1.0.2-fresh.json"), "utf8")) as { objects: Row[] }).objects;
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
  afterEach(() => { closeDatabase(); });

  it("leaves none of the four tables behind", () => {
    const db = database();
    initializeImageOperations(db);
    ensureForgetTable(db);
    withPhoneTables(db);
    closeDatabase();
    expect(downgradeInstallationMemorySchema(DATA_DIR, 10)).toMatchObject({ status: "downgraded", to: 10 });
    const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try {
      const names = new Set((after.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(row => row.name));
      for (const name of PHONE_TABLES) expect(names.has(name), name).toBe(false);
      const want = new Set(fresh102.map(row => `${row.type}:${row.name}`));
      const extra = (after.prepare("SELECT type, name FROM sqlite_master").all() as Array<{ type: string; name: string }>).map(row => `${row.type}:${row.name}`).filter(key => !want.has(key)).sort();
      expect(extra.filter(key => key.includes("phone"))).toEqual([]);
      // owner_sends is a 1.0.2 table: 1.0.9's phone columns leave it, and 1.0.2's own text is what is left
      const sql = (rows: Row[] | undefined) => rows?.find(row => row.type === "table" && row.name === "owner_sends")?.sql?.replace(/\s+/g, " ");
      expect(sql(after.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as Row[])).toBe(sql(fresh102));
    } finally { after.close(); }
  });

  it("refuses while a phone line is still waiting to send, and changes nothing at all", () => {
    const db = database();
    initializeImageOperations(db);
    ensureForgetTable(db);
    initializeMobilePush(db);
    withPhoneTables(db);
    db.prepare("INSERT INTO push_bindings (binding_id, device_id, publisher_token, created_at) VALUES ('b1','dev-a','t',1)").run();
    db.prepare("INSERT INTO push_events (event_ref, binding_id, kind, category, bot_id, thread_id, collapse_key, thread_group, revision, time_sensitive, created_at, expires_at, hold_until, state, next_attempt_at, phone_used) VALUES ('e1','b1','message','message','bot','thr','ck','tg',1,0,1,2,1,'pending',1,1)").run();
    db.prepare("INSERT INTO owner_sends (kind, owner_id, thread_id, queue_id, fingerprint, text, status, queue_only, via, created_at, updated_at) VALUES ('bot','o','t','q','f','hi','queued',1,'phone',1,1)").run();
    closeDatabase();
    const before = snapshot(DATA_DIR);
    expect(before.pushColumns).toContain("phone_used");
    expect(before.pushRows).toEqual([{ event_ref: "e1", phone_used: 1 }]);
    expect(() => downgradeInstallationMemorySchema(DATA_DIR, 10)).toThrow(/waiting to send/);
    // the column and its values, owner_sends's text and rows, all four phone tables and both tombstone files: exactly as they were
    expect(snapshot(DATA_DIR)).toEqual(before);
    const after = new DatabaseSync(join(DATA_DIR, "messages.db"), { readOnly: true });
    try { expect(counts(after)).toEqual(ONE_EACH); } finally { after.close(); }
  });
});

/** Everything the refusal must leave alone, read from the file as it stands. */
function snapshot(dir: string) {
  const db = new DatabaseSync(join(dir, "messages.db"), { readOnly: true });
  try {
    const all = (sql: string) => db.prepare(sql).all() as Array<Record<string, unknown>>;
    const file = (name: string) => { const path = join(dir, name); return existsSync(path) ? readFileSync(path, "utf8") : null; };
    return {
      pushColumns: all("PRAGMA table_info(push_events)").map(column => column.name),
      pushRows: all("SELECT event_ref, phone_used FROM push_events ORDER BY event_ref"),
      schema: all("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name"),
      ownerSends: all("SELECT * FROM owner_sends ORDER BY seq"),
      phoneRows: Object.fromEntries(PHONE_TABLES.map(name => [name, all(`SELECT * FROM ${name} ORDER BY rowid`)])),
      tombstones: [file("phone-revocations.tombstone.json"), file("phone-ask-revocations.tombstone.json")],
    };
  } finally { db.close(); }
}
