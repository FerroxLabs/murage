// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { PHONE_BOT_DEFAULT, type CallRow } from "./contracts.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { SqliteCallStore } from "./store.ts";

const original = (id: string): CallRow => ({
  id, vendorId: "", revision: 1, assistantId: "assistant", createdAt: 1,
  status: "uncertain", language: "en", to: "", goal: "", details: "", limits: "",
});

describe.each(["sqlite", "memory"])("%s call store", (backend) => {
  it("P24d never revives deleted calls and rolls back a settle whose booking is gone", () => {
    using db = new DatabaseSync(":memory:");
    const store = backend === "sqlite" ? new SqliteCallStore(db) : new MemoryCallStore();
    const booking = original("booking");
    const cancel = original("cancel");
    store.insert(booking);
    store.insert(cancel);
    expect(store.delete(booking.id)).toBe(true);
    expect(store.update(booking)).toBe(false);
    expect(store.settle({ ...cancel, status: "ended" }, booking)).toBe(false);
    expect(store.get(booking.id)).toBeUndefined();
    expect(store.get(cancel.id)).toEqual(cancel);
    if (backend === "sqlite") {
      for (const table of ["phone_calls", "phone_call_keys"]) {
        expect(db.prepare(`SELECT id, status FROM ${table}`).all()).toEqual([{ id: "cancel", status: "uncertain" }]);
      }
    }
  });

  it("P4b newly installed and existing bots use the configured default and keep explicit choices", () => {
    using db = new DatabaseSync(":memory:");
    const store = backend === "sqlite" ? new SqliteCallStore(db) : new MemoryCallStore();
    store.put({ ...original("previous-call"), botId: "existing" });
    expect(store.botMayPhone("fresh")).toBe(PHONE_BOT_DEFAULT);
    expect(store.botMayPhone("existing")).toBe(PHONE_BOT_DEFAULT);
    store.setBotMayPhone("existing", !PHONE_BOT_DEFAULT);
    expect(store.botMayPhone("existing")).toBe(!PHONE_BOT_DEFAULT);
    expect(store.botMayPhone("fresh")).toBe(PHONE_BOT_DEFAULT);
  });
});

it("W5(g) rolls back a hand-off slot when the subsequent phone intent insert throws", () => {
  using db = new DatabaseSync(":memory:");
  const store = new SqliteCallStore(db);
  db.exec("CREATE TABLE handoffs (call_id TEXT); INSERT INTO handoffs VALUES (NULL)");
  const row = original("new-call");
  const place = () => store.insert(row, { within(tx) {
    expect(tx.prepare("UPDATE handoffs SET call_id = ? WHERE call_id IS NULL").run(row.id).changes).toBe(1);
  } });
  db.exec(`CREATE TRIGGER fail_keys BEFORE INSERT ON phone_call_keys
    BEGIN SELECT raise(ABORT, 'key write failed'); END`);
  expect(place).toThrow("key write failed");
  expect(db.prepare("SELECT call_id FROM handoffs").get()).toEqual({ call_id: null });
  expect(store.get(row.id)).toBeUndefined();
  expect(db.prepare("SELECT id FROM phone_call_keys").all()).toEqual([]);

  db.exec("DROP TRIGGER fail_keys");
  place();
  expect(db.prepare("SELECT call_id FROM handoffs").get()).toEqual({ call_id: row.id });
  expect(store.get(row.id)).toEqual(row);
  expect(db.prepare("SELECT id FROM phone_call_keys").all()).toEqual([{ id: row.id }]);
  expect(() => store.insert({ ...row, status: "ended" })).toThrow();
  expect(store.get(row.id)).toEqual(row);
});

it.each(["update", "settle", "delete"] as const)("W7 rolls back %s if its report re-arm throws", (write) => {
  using db = new DatabaseSync(":memory:");
  const store = new SqliteCallStore(db);
  const row = original("cancel");
  const booking = original("booking");
  store.insert(row);
  store.insert(booking);
  db.exec("CREATE TABLE reports (due INTEGER); INSERT INTO reports VALUES (0)");
  const apply = (fail: boolean) => {
    const options = { within(tx: DatabaseSync) {
      tx.prepare("UPDATE reports SET due = 1").run();
      if (fail) throw new Error("report write failed");
    } };
    const ended = { ...row, status: "ended" as const };
    if (write === "update") return store.update(ended, options);
    if (write === "settle") return store.settle(ended, { ...booking, status: "ended" }, options);
    return store.delete(row.id, options);
  };
  expect(() => apply(true)).toThrow("report write failed");
  expect(store.get(row.id)).toEqual(row);
  expect(store.get(booking.id)).toEqual(booking);
  expect(db.prepare("SELECT due FROM reports").get()).toEqual({ due: 0 });
  expect(db.prepare("SELECT status FROM phone_call_keys WHERE id = ?").get(row.id)).toEqual({ status: "uncertain" });
  expect(apply(false)).toBe(true);
  expect(store.get(row.id)?.status).toBe(write === "delete" ? undefined : "ended");
  expect(store.get(booking.id)?.status).toBe(write === "settle" ? "ended" : "uncertain");
  expect(db.prepare("SELECT due FROM reports").get()).toEqual({ due: 1 });
  expect(db.prepare("SELECT status FROM phone_call_keys WHERE id = ?").get(row.id)).toEqual(
    write === "delete" ? undefined : { status: "ended" },
  );
});

it("W7 settles a terminal reconciliation miss and re-arms its report together", () => {
  using db = new DatabaseSync(":memory:");
  const store = new SqliteCallStore(db);
  const cancel = { ...original("cancel"), status: "abandoned" as const, purpose: "cancel" as const, booking: "booking" };
  const booking = { ...original("booking"), status: "ended" as const, cancel: { by: cancel.id, state: "pending" as const } };
  store.insert(cancel);
  store.insert(booking);
  db.exec("CREATE TABLE reports (due INTEGER); INSERT INTO reports VALUES (0)");
  for (let n = 0; n < 11; n++) store.markReconcileMiss(cancel.id, 0);
  let fail = true;
  const lastMiss = () => store.markReconcileMiss(cancel.id, 0, next => {
    expect(next.abandonCancel).toBe("not_found");
    return {
      booking: { ...booking, cancel: { by: cancel.id, state: "free" } },
      within(tx) {
        tx.prepare("UPDATE reports SET due = 1").run();
        if (fail) throw new Error("report write failed");
      },
    };
  });
  expect(lastMiss).toThrow("report write failed");
  expect(store.get(cancel.id)?.abandonCancel).toBeUndefined();
  expect(store.get(booking.id)?.cancel?.state).toBe("pending");
  expect(db.prepare("SELECT due FROM reports").get()).toEqual({ due: 0 });
  fail = false;
  lastMiss();
  expect(store.get(cancel.id)?.abandonCancel).toBe("not_found");
  expect(store.get(booking.id)?.cancel?.state).toBe("free");
  expect(db.prepare("SELECT due FROM reports").get()).toEqual({ due: 1 });
});
