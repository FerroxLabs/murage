import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { preservePhoneCallsForDowngrade, removeDataDirNamesAfter102 } from "./installation-memory-downgrade.ts";
import { SqliteCallStore } from "./phone-calls/store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
it("refuses every unfinished call and preserves completed history outside the legacy directory", () => {
  const parent = mkdtempSync(join(tmpdir(), "murage-phone-downgrade-"));
  const root = join(parent, "data"); mkdirSync(root);
  const file = join(root, "phone-calls.db");
  const db = new DatabaseSync(file); const store = new SqliteCallStore(db);
  try {
    for (const status of ["scheduled", "ringing", "in_progress", "uncertain"] as const) {
      store.put({ id: "call", vendorId: "vendor", revision: 1, assistantId: "assistant", createdAt: 1, status, language: "en", to: "+15550123456", goal: "book", details: "", limits: "", transcript: "kept" });
      expect(() => removeDataDirNamesAfter102(root)).toThrow("PHONE_CALLS_PENDING");
      expect(existsSync(file)).toBe(true);
    }
    store.put({ ...store.get("call")!, status: "ended" });
    db.close();
    const bytes = readFileSync(file);
    const backup = preservePhoneCallsForDowngrade(root)!;
    expect(backup.startsWith(root + "/")).toBe(false);
    expect(readFileSync(join(backup, "phone-calls.db"))).toEqual(bytes);
    removeDataDirNamesAfter102(root);
    expect(existsSync(file)).toBe(false);
    const recovered = new DatabaseSync(join(backup, "phone-calls.db"));
    expect(new SqliteCallStore(recovered).get("call")?.transcript).toBe("kept"); recovered.close();
  } finally { try { db.close(); } catch {} removeTempDirSync(parent); }
});
it("refuses an unreadable phone database without deleting it", async () => {
  const { writeFileSync } = await import("node:fs");
  const parent = mkdtempSync(join(tmpdir(), "murage-phone-downgrade-corrupt-"));
  const root = join(parent, "data"); mkdirSync(root);
  const file = join(root, "phone-calls.db"); writeFileSync(file, "damaged");
  try {
    expect(() => removeDataDirNamesAfter102(root)).toThrow("PHONE_CALLS_UNREADABLE");
    expect(readFileSync(file, "utf8")).toBe("damaged");
  } finally { removeTempDirSync(parent); }
});
it("does not treat a zero-byte database with a nonempty recovery sidecar as empty history", async () => {
  const { writeFileSync } = await import("node:fs");
  const parent = mkdtempSync(join(tmpdir(), "murage-phone-downgrade-sidecar-"));
  const root = join(parent, "data"); mkdirSync(root);
  writeFileSync(join(root, "phone-calls.db"), "");
  writeFileSync(join(root, "phone-calls.db-journal"), "recoverable pages");
  try {
    expect(() => removeDataDirNamesAfter102(root)).toThrow("PHONE_CALLS_UNREADABLE");
    expect(readFileSync(join(root, "phone-calls.db-journal"), "utf8")).toBe("recoverable pages");
  } finally { removeTempDirSync(parent); }
});

it("abandoned uncertainty permits downgrade and preserves its durable cancellation intent", () => {
  const parent = mkdtempSync(join(tmpdir(), "murage-abandoned-downgrade-"));
  const root = join(parent, "data"); mkdirSync(root);
  const db = new DatabaseSync(join(root, "phone-calls.db"));
  const store = new SqliteCallStore(db);
  store.put({ id: "abandoned", vendorId: "", revision: 1, assistantId: "a", createdAt: 1,
    status: "abandoned", language: "en", to: "+15550123456", goal: "book", details: "", limits: "" });
  db.close();
  try {
    const backup = preservePhoneCallsForDowngrade(root)!;
    removeDataDirNamesAfter102(root);
    const recovered = new DatabaseSync(join(backup, "phone-calls.db"));
    try { expect([...new SqliteCallStore(recovered).abandoned()]).toMatchObject([{ id: "abandoned", status: "abandoned" }]); }
    finally { recovered.close(); }
  } finally { removeTempDirSync(parent); }
});
