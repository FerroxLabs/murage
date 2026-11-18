import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { consumingFixture } from "./testing/consuming-fixture.ts";
import { persistLedgerRefusal } from "./ledger-persistence.ts";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
it("retries captured refusal persistence after a real competing writer releases", async () => {
  const f = consumingFixture(); cleanup.push(() => f.close());
  f.f.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE refusal_test(id TEXT PRIMARY KEY)");
  const file = String(f.f.db.prepare("PRAGMA database_list").get()!.file);
  const other = new DatabaseSync(file); cleanup.push(() => other.close());
  other.exec("BEGIN IMMEDIATE");
  const started = performance.now();
  const pending = persistLedgerRefusal(f.f.db, () => {
    f.f.db.prepare("INSERT INTO refusal_test VALUES('original-generation')").run();
  });
  expect(performance.now() - started).toBeLessThan(500);
  expect(f.f.db.prepare("SELECT * FROM refusal_test").all()).toEqual([]);
  other.exec("ROLLBACK");
  await pending;
  expect(f.f.db.prepare("SELECT * FROM refusal_test").all()).toEqual([{ id: "original-generation" }]);
});
it("cannot retarget refusal writes when the captured connection closed", async () => {
  const db = new DatabaseSync(":memory:"); db.close();
  let calls = 0;
  await expect(persistLedgerRefusal(db, () => { calls++; })).rejects.toThrow("DATABASE_CLOSED");
  expect(calls).toBe(0);
});
it("rejects a replaced installation even while its original database stays open", async () => {
  const db = new DatabaseSync(":memory:"); cleanup.push(() => db.close());
  let current = true, calls = 0;
  db.exec("BEGIN IMMEDIATE");
  const pending = persistLedgerRefusal(db, () => { calls++; }, () => current);
  const refused = expect(pending).rejects.toThrow("DATABASE_CHANGED");
  current = false;
  db.exec("ROLLBACK");
  await refused;
  expect(calls).toBe(0);
});
