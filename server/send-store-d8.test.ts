import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SendStore, type AcceptInput, type SendRow } from "./send-store.ts";
import { assertNoPendingPhoneWork, downgradePhoneObjectsTo108, PHONE_OWNER_SENDS_COLUMNS } from "./installation-app-schema-downgrade.ts";
import { inspectInstallationDatabase } from "./installation-database-snapshot.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const fx = JSON.parse(readFileSync(new URL("../apps/mobile/contract/phone-ask-proof.json", import.meta.url), "utf8"));
let db: DatabaseSync;
let store: SendStore;
const roots: string[] = [];
const input = (over: Partial<AcceptInput> = {}): AcceptInput => ({
  kind: "bot", ownerId: "bot-lena", threadId: fx.confirm.threadId, sendId: fx.request.askId,
  fingerprint: "same words", text: fx.request.text, status: "queued", origin: "unproven",
  via: "ask-intent", queueOnly: true, viaDevice: fx.record.deviceId, viaProof: fx.record, ...over,
});
const accept = (value = input()): SendRow => {
  const result = store.accept(value);
  expect(result.kind).toBe("new");
  return result.row;
};
beforeEach(() => { db = new DatabaseSync(":memory:"); store = new SendStore(() => db); });
afterEach(() => { db.close(); for (const root of roots.splice(0)) removeTempDirSync(root); });

describe("T-D8-ROW", () => {
  it("persists the v1 proof through a closed database and reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "murage-d8-row-")); roots.push(root);
    db.close(); db = new DatabaseSync(join(root, "messages.db")); store = new SendStore(() => db);
    const row = accept();
    expect(row.viaProof).toEqual(fx.record);
    expect(JSON.parse((db.prepare("SELECT via_proof FROM owner_sends").get() as { via_proof: string }).via_proof)).toEqual(fx.record);
    db.close(); db = new DatabaseSync(join(root, "messages.db")); store = new SendStore(() => db);
    expect(store.bySeq(row.seq)?.viaProof).toEqual(fx.record);
  });

  it.each([
    ["malformed JSON", "{no"], ["null", "null"], ["array", "[]"],
    ...fx.invalidRecords.map((bad: { name: string; patch: object; omit?: string }) => {
      const record = { ...fx.record, ...bad.patch };
      if (bad.omit) delete record[bad.omit];
      return [bad.name, JSON.stringify(record)];
    }),
  ])("reads %s as absent while keeping the ask", (_name, raw) => {
    const row = accept();
    expect(store.bySeq(row.seq)?.viaProof).toEqual(fx.record);
    db.prepare("UPDATE owner_sends SET via_proof=? WHERE seq=?").run(raw, row.seq);
    expect(store.bySeq(row.seq)).toMatchObject({ text: fx.request.text, viaProof: null });
  });

  it.each([["via_device", "other-phone"], ["via", "share"], ["via", null]])("does not expose proof after changing %s to %s", (column, value) => {
    const row = accept();
    expect(store.bySeq(row.seq)?.viaProof).toEqual(fx.record);
    db.prepare(`UPDATE owner_sends SET ${column}=? WHERE seq=?`).run(value, row.seq);
    expect(store.bySeq(row.seq)?.viaProof).toBeNull();
  });

  it.each([false, true])("Send again drops proof even when supplied again: %s", supplied => {
    const first = accept();
    expect(store.accept(input())).toMatchObject({ kind: "existing", row: { viaProof: fx.record } });
    store.refuse(first.seq);
    const row = accept(input({ resend: true, actionId: "again", viaProof: supplied ? fx.record : undefined }));
    expect(row).toMatchObject({ via: "ask-intent", viaDevice: fx.record.deviceId, queueOnly: true, origin: "unproven", viaProof: null });
    expect(row.queueId).not.toBe(first.queueId);
    expect(db.prepare("SELECT via_proof FROM owner_sends").get()).toEqual({ via_proof: null });
  });

  it("migrates an older row with no proof column to null", () => {
    const row = accept(input({ viaProof: undefined }));
    db.exec("ALTER TABLE owner_sends DROP COLUMN via_proof");
    store = new SendStore(() => db);
    expect(store.bySeq(row.seq)).toMatchObject({ text: fx.request.text, viaProof: null });
  });
});

describe("T-D8-DOWNGRADE", () => {
  it("drops proof and reopening the downgraded row cannot recover it", () => {
    const row = accept();
    expect(row.viaProof).toEqual(fx.record);
    store.cancel(row.ownerId, row.queueId);
    expect(PHONE_OWNER_SENDS_COLUMNS).toContain("via_proof");
    expect(downgradePhoneObjectsTo108(db).columns).toBe(5);
    expect(db.prepare("SELECT name FROM pragma_table_info('owner_sends') WHERE name='via_proof'").get()).toBeUndefined();
    store = new SendStore(() => db);
    expect(store.bySeq(row.seq)?.viaProof).toBeNull();
  });

  it("counts a pending row carrying only via_proof as phone work", () => {
    db.exec("CREATE TABLE owner_sends (status TEXT, text TEXT, message_id TEXT, via_proof TEXT)");
    db.prepare("INSERT INTO owner_sends VALUES ('queued', 'hello', NULL, ?)").run(JSON.stringify(fx.record));
    expect(() => assertNoPendingPhoneWork(db)).toThrow(/waiting to send/);
    db.exec("UPDATE owner_sends SET via_proof=NULL");
    expect(() => assertNoPendingPhoneWork(db)).not.toThrow();
  });

  it("accepts snapshots with and without the optional proof column, but not an unknown column", () => {
    initializeMessageTables(db);
    accept();
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("ALTER TABLE owner_sends DROP COLUMN via_proof");
    expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.exec("ALTER TABLE owner_sends ADD COLUMN arbitrary_proof TEXT");
    expect(() => inspectInstallationDatabase(db)).toThrow();
  });
});
