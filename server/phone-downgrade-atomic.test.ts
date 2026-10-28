// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The backup downgrade of the 1.0.9 phone objects (downgradePhoneObjectsTo108) is one step: either the file is fully 1.0.9 or fully back to 1.0.8's shape.
// A failure partway keeps every table and every revocation row, a pending phone line is refused whichever phone columns the table holds, and the ask
// revocations survive a downgrade and a later upgrade the way the phone revocations do.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { downgradePhoneObjectsTo108 } from "./installation-app-schema-downgrade.ts";
import { AskRevocations } from "./phones/ask-revocations.ts";
import { PhoneReceipts } from "./phones/receipts.ts";
import { initializePhones, PhoneRevocations } from "./phones/registry.ts";
import { initializeOwnerSends } from "./send-store.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "murage-phone-atomic-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
let n = 0;
const PHONE_TABLES = ["phone_ask_revocations", "phone_receipts", "phone_registrations", "phone_revocations"];

function seeded() {
  const dir = join(SCRATCH, `d${++n}`);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "messages.db"));
  initializeOwnerSends(db);
  initializePhones(db);
  new AskRevocations(db);
  new PhoneReceipts(db, { database: () => db });
  db.prepare("INSERT INTO phone_registrations (device_id, body, updated_at) VALUES ('dev-a','{}',5)").run();
  new PhoneRevocations(db, () => 6).bar("dev-b", "removed");
  new AskRevocations(db).apply("dev-a", 3);
  db.prepare("INSERT INTO phone_receipts (device_id, kind, id, fingerprint, generation, state, at) VALUES ('dev-a','share','r1','fp',1,'received',1)").run();
  return { dir, db };
}
const dump = (db: DatabaseSync) => ({
  schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
  rows: Object.fromEntries(["owner_sends", ...PHONE_TABLES].map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])),
});

describe("a failure partway through the phone downgrade", () => {
  it("leaves the file fully 1.0.9 with every revocation row, when the last drop fails", () => {
    const { db } = seeded();
    db.prepare("INSERT INTO owner_sends (kind, owner_id, thread_id, queue_id, fingerprint, text, status, created_at, updated_at, via) VALUES ('bot','o','t','q','f','','delivered',1,1,'phone')").run();
    const before = dump(db);
    expect(() => downgradePhoneObjectsTo108(db, { beforeDrop: name => { if (name === "phone_revocations") throw new Error("disk full"); } })).toThrow("disk full");
    expect(dump(db)).toEqual(before);
    expect(db.isTransaction).toBe(false);
    db.close();
  });

  it("drops the two revocation tables last", () => {
    const { db } = seeded();
    const order: string[] = [];
    downgradePhoneObjectsTo108(db, { beforeDrop: name => order.push(name) });
    expect(order.slice(-2).sort()).toEqual(["phone_ask_revocations", "phone_revocations"]);
    expect(order).toHaveLength(4);
    db.close();
  });
});

describe("a pending phone line is refused whichever phone columns the table holds", () => {
  for (const [column, ddl, value] of [["via", "via TEXT", "'phone'"], ["queue_only", "queue_only INTEGER NOT NULL DEFAULT 0", "1"], ["via_device", "via_device TEXT", "'dev'"], ["attachments", "attachments TEXT", "'[]'"]] as const) {
    it(`only ${column}`, () => {
      const db = new DatabaseSync(":memory:");
      db.exec(`CREATE TABLE owner_sends (seq INTEGER PRIMARY KEY, status TEXT, text TEXT, message_id TEXT, ${ddl})`);
      db.exec(`INSERT INTO owner_sends (status, text, ${column}) VALUES ('queued','hi',${value})`);
      expect(() => downgradePhoneObjectsTo108(db)).toThrow(/waiting to send/);
      expect(db.prepare("SELECT COUNT(*) AS c FROM pragma_table_info('owner_sends')").get()).toEqual({ c: 5 });
    });
  }
  it("a finished line with only one phone column does not block", () => {
    const db = new DatabaseSync(":memory:");
    initializeOwnerSends(db);
    for (const column of ["attachments", "via_device", "queue_only"]) db.exec(`ALTER TABLE owner_sends DROP COLUMN ${column}`);
    db.exec("INSERT INTO owner_sends (kind, owner_id, thread_id, queue_id, fingerprint, text, status, created_at, updated_at, via) VALUES ('bot','o','t','q','f','','delivered',1,1,'phone')");
    expect(() => downgradePhoneObjectsTo108(db)).not.toThrow();
  });
});

describe("the ask revocations through a downgrade and a later upgrade", () => {
  it("a revoked ask generation stays refused", () => {
    const { dir, db } = seeded();
    downgradePhoneObjectsTo108(db);
    expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='phone_ask_revocations'").get()).toBeUndefined();
    expect(existsSync(join(dir, "phone-ask-revocations.tombstone.json"))).toBe(true);
    db.close();
    const again = new DatabaseSync(join(dir, "messages.db"));
    const ask = new AskRevocations(again);
    expect(ask.refuses("dev-a", 3)).toBe(true);
    expect(ask.refuses("dev-a", 4)).toBe(false);
    // the highest through wins over a lower one already in the table, and the file only grows
    ask.apply("dev-a", 9);
    again.close();
    const third = new DatabaseSync(join(dir, "messages.db"));
    expect(new AskRevocations(third).refuses("dev-a", 9)).toBe(true);
    third.close();
    expect(JSON.parse(readFileSync(join(dir, "phone-ask-revocations.tombstone.json"), "utf8"))).toEqual([{ device_id: "dev-a", through: 3 }]);
  });
});
