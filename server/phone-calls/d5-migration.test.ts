// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";
import type { CallRow } from "./contracts.ts";
import { SqliteCallStore } from "./store.ts";

const original = (id: string, createdAt: number): CallRow => ({
  id, createdAt, vendorId: "", revision: 1, assistantId: "assistant",
  status: "ended", language: "en", to: "", goal: "", details: "", limits: "",
});

function seedLegacy(db: DatabaseSync, count: number): void {
  db.exec(`CREATE TABLE phone_calls (
    id TEXT PRIMARY KEY, vendor_id TEXT NOT NULL, revision INTEGER NOT NULL, assistant_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, status TEXT NOT NULL, row_json TEXT NOT NULL
  );
  CREATE INDEX phone_calls_live ON phone_calls(status) WHERE status IN ('uncertain', 'scheduled', 'ringing', 'in_progress');
  BEGIN IMMEDIATE`);
  const insert = db.prepare("INSERT INTO phone_calls VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (let n = 1; n <= count; n++) {
    const row = original(`historic-${n}`, n);
    if (n === count) { row.status = "scheduled"; row.revision = 7; }
    if (n === 1) row.status = "uncertain";
    if (n === 2 || n === 3) row.status = "abandoned";
    if (n === 4) { row.status = "abandoned"; row.abandonCancel = "confirmed"; }
    if (n >= 5 && n <= 7) row.transcript = "historic transcript";
    insert.run(row.id, row.vendorId, row.revision, row.assistantId, row.createdAt, row.status, JSON.stringify(row));
  }
  db.exec("COMMIT");
}

it("P8b a killed migration resumes at the committed 500-row cursor and gates revision reads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-migrate-"));
  const file = join(dir, "calls.db");
  try {
    {
      using db = new DatabaseSync(file);
      seedLegacy(db, 10_000);
      const store = new SqliteCallStore(db);
      expect(() => store.revisionLive(7)).toThrow("migration_incomplete");
      expect(store.get("historic-10000")?.status).toBe("scheduled");
    }
    const { migratePhoneCalls } = await import("./migrate.ts");
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { SqliteCallStore } from "./server/phone-calls/store.ts";
      import { migratePhoneCalls } from "./server/phone-calls/migrate.ts";
      const store = new SqliteCallStore(new DatabaseSync(process.argv[1]));
      const batch = store.migrateBatch.bind(store);
      store.migrateBatch = () => {
        const changed = batch();
        writeSync(1, "committed\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        return changed;
      };
      await migratePhoneCalls(store);
    `, file], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = once(child, "close");
    let reached = "child exited";
    try {
      reached = await Promise.race([
        once(child.stdout, "data").then(([data]) => String(data).trim()),
        closed.then(() => "child exited"),
      ]);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    const killedBy = (await closed)[1];

    using db = new DatabaseSync(file);
    const store = new SqliteCallStore(db);
    const cursorAfterKill = store.meta("migrated");
    const keysAfterKill = (db.prepare("SELECT count(*) AS n FROM phone_call_keys").get() as { n: number }).n;
    const gatedAfterKill = (() => { try { store.revisionLive(7); return "open"; } catch (error) { return String((error as Error).message); } })();
    const stop = new AbortController();
    const realBatch = store.migrateBatch.bind(store);
    const batch = vi.spyOn(store, "migrateBatch").mockImplementation(() => {
      if (batch.mock.calls.length > 40) stop.abort();
      return realBatch();
    });
    const completed = migratePhoneCalls(store, stop.signal);
    await new Promise<void>(resolve => setImmediate(resolve));
    const callsBeforeYield = batch.mock.calls.length;
    await completed;
    // Crash-resume assertion (P8b): the killed child committed exactly one 500-row batch, and the restart resumes
    // at that cursor, so 19 full batches plus the final empty one finish the 10,000 rows (20 calls, not 21+).
    const resumed = { reached, killedBy, cursorAfterKill, keysAfterKill, resumedBatches: batch.mock.calls.length, finished: store.meta("migrated") };
    expect(resumed).toEqual({ reached: "committed", killedBy: "SIGKILL", cursorAfterKill: "500", keysAfterKill: 500, resumedBatches: 20, finished: "done" });
    expect(gatedAfterKill).toBe("migration_incomplete");
    expect(callsBeforeYield).toBeLessThan(20);

    expect(store.meta("migrated")).toBe("done");
    expect(db.prepare("SELECT count(*) AS n FROM phone_call_keys").get()).toEqual({ n: 10_000 });
    expect(store.revisionLive(7)).toBe(true);
    expect(store.duePending(10_000).map(row => row.id)).toEqual(["historic-1", "historic-2", "historic-3"]);
    expect(store.transcriptsOlderThan(10_000).map(row => row.id)).toEqual(["historic-5", "historic-6", "historic-7"]);
    console.log("P8b committed first 500, resumed remaining 9500 in 500-row steps");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it("REGRESSION (open already read no history at c2df052d2a store.ts:32; green on bd8d175fc9): P8e cold store open reads no history and an uncertain legacy call is found immediately", () => {
  using db = new DatabaseSync(":memory:");
  seedLegacy(db, 10_000);
  const prepare = vi.spyOn(db, "prepare");
  const exec = vi.spyOn(db, "exec");
  const store = new SqliteCallStore(db);
  expect(prepare).not.toHaveBeenCalled();
  expect(exec.mock.calls.map(([sql]) => sql).join("\n").match(/CREATE INDEX[^\n]+ON phone_calls\(/g))
    .toEqual([expect.stringContaining("IF NOT EXISTS phone_calls_live")]);
  expect(store.firstUncertain()?.id).toBe("historic-1");
  expect(store.get("historic-10000")?.revision).toBe(7);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${prepare.mock.calls[0][0]}`).all();
  expect(plan).toEqual([expect.objectContaining({ detail: expect.stringContaining("phone_calls_live") })]);
});

it("P8d P9b P16c and P12h use bounded indexed queries for live, identity, schedule and analysis rows", async () => {
  using db = new DatabaseSync(":memory:");
  seedLegacy(db, 10_000);
  const store = new SqliteCallStore(db, () => 1_000);
  const { migratePhoneCalls } = await import("./migrate.ts");
  await migratePhoneCalls(store);
  const archived = { ...original("a", 1), status: "scheduled" as const, botId: "caller", intent: "request", identity: "shape" };
  store.insert(archived);
  for (let n = 101; n <= 710; n++) store.insert({ ...archived, id: `call-${n}`, createdAt: n, identity: undefined, intent: undefined });
  store.insert({ ...original("late-analysis", 1), purpose: "cancel", booking: "a", analysisDue: 100 });
  const prepare = vi.spyOn(db, "prepare");
  const check = (index: string, params: SQLInputValue[]) => {
    const sql = prepare.mock.calls.at(-1)![0];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => String(row.detail));
    expect(plan.some(detail => detail.includes(index))).toBe(true);
    expect(plan.some(detail => detail.startsWith("SCAN phone_calls"))).toBe(false);
    console.log(plan.join(" | "));
  };
  expect(store.liveForBot("caller", 50, "call-109").map(row => row.id)).toEqual(
    Array.from({ length: 50 }, (_, index) => `call-${110 + index}`),
  );
  check("phone_call_keys_live_bot", ["caller", "call-109", 50]);
  expect(store.liveLegacy(50).map(row => row.id)).toEqual(["historic-1", "historic-10000"]);
  check("phone_call_keys_live_bot", [null, "", 50]);
  expect(store.scheduledOlderThan(5).length).toBe(50);
  check("phone_call_keys_scheduled", [5, 50]);
  expect(store.countScheduledOlderThan(5)).toBe(501);
  check("phone_call_keys_scheduled", [5, 501]);
  expect(store.liveByIdentity("caller", "shape")?.id).toBe("a");
  check("phone_call_keys_live_identity", ["caller", "shape"]);
  expect(store.update({ ...archived, status: "ended" })).toBe(true);
  expect(store.liveByIdentity("caller", "shape")).toBeUndefined();
  expect(store.byIntent("caller", "request", "shape")?.id).toBe("a");
  check("phone_call_keys_intent", ["caller", "request", "shape"]);
  expect(store.byIntent("caller", "other-request", "shape")).toBeUndefined();
  expect(store.analysisDue(99)).toEqual([]);
  expect(store.analysisDue(100).map(row => row.id)).toEqual(["late-analysis"]);
  check("phone_call_keys_analysis", [100, 8]);
  expect(store.settle({ ...store.get("late-analysis")!, analysisDue: undefined }, store.get("a")!)).toBe(true);
  expect(store.analysisDue(100)).toEqual([]);
});

it("P24 indexes only old terminal transcripts and yields three bounded prune pages", () => {
  using db = new DatabaseSync(":memory:");
  const store = new SqliteCallStore(db);
  const day = 86_400_000;
  for (let n = 1; n <= 10_000; n++) {
    const row = original(`call-${n}`, n);
    if (n <= 450) { row.transcript = "retained text"; row.reference = "booking-reference"; }
    if (n >= 9_998) { row.transcript = "current text"; row.endedAt = 10 * day; }
    store.insert(row);
  }
  store.setMeta("retention", "30");
  const now = 31 * day;
  for (const count of [200, 200, 50]) {
    const page = store.transcriptsOlderThan(now - Number(store.meta("retention")) * day);
    expect(page.length).toBe(count);
    for (const row of page) expect(store.update({ ...row, transcript: undefined, transcriptCleared: true })).toBe(true);
  }
  expect(store.transcriptsOlderThan(now - day)).toHaveLength(3);
  expect(store.get("call-1")).toMatchObject({ transcriptCleared: true, reference: "booking-reference" });
  expect(store.get("call-1")?.transcript).toBeUndefined();
});

it("P9b Archive reads only bounded bot pages after migrating a 10,000-row history", async () => {
  const vendor = await startFakeVapi();
  _resetPhoneSecretsForTest();
  setPhoneKeyFromShell({ key: "offline-fixture-credential", origin: PHONE_KEY_ORIGIN });
  try {
    using db = new DatabaseSync(":memory:");
    seedLegacy(db, 10_000);
    const rows = new SqliteCallStore(db);
    const { migratePhoneCalls } = await import("./migrate.ts");
    await migratePhoneCalls(rows);
    for (let n = 0; n < 10_000; n++) {
      rows.insert({ ...original(`settled-${n}`, n), status: "abandoned", botId: n % 2 ? "owner-bot" : undefined,
        abandonCancel: n % 3 ? "confirmed" : "not_found" });
    }
    const abandoned = Array.from({ length: 53 }, (_, n) => `abandoned-${100 + n}`);
    for (const id of [...abandoned, "legacy-stop", "foreign-pending", "legacy-pending", "owned-pending"]) {
      const pending = id.endsWith("-pending");
      const botId = id.startsWith("legacy") ? undefined : id.startsWith("foreign") ? "other" : "owner-bot";
      rows.insert({ ...original(id, 1), status: "abandoned", botId, vendorId: pending ? "" : id,
        abandonCancel: pending ? undefined : "attempted" });
      if (!pending) vendor.calls.set(id, { id, createdAt: new Date(1).toISOString(), status: "ended" });
    }
    const ids = Array.from({ length: 53 }, (_, n) => `owned-${100 + n}`);
    for (const id of [...ids, "different-bot"]) {
      rows.insert({ ...original(id, 1), status: "scheduled", vendorId: id, botId: id === "different-bot" ? "other" : "owner-bot" });
      vendor.calls.set(id, { id, createdAt: new Date(1).toISOString(), status: "scheduled" });
    }
    const pages = vi.spyOn(rows, "liveForBot");
    const legacyScan = vi.spyOn(rows, "live");
    const prepare = db.prepare.bind(db);
    const selections: { plan: string; count: number }[] = [];
    vi.spyOn(db, "prepare").mockImplementation(sql => {
      const statement = prepare(sql);
      if (/^SELECT .*row_json.*(?:phone_call_abandoned|\bWHERE\b.*abandoned)/s.test(sql)) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args: Parameters<typeof all>) => {
          const selected = all(...args);
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join(" | ");
          selections.push({ plan, count: selected.length });
          return selected;
        });
      }
      return statement;
    });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", undefined, rows);
    expect(await service.cancelForBot("owner-bot")).toEqual([
      ...ids.map(call => ({ call, status: "confirmed" })),
      ...abandoned.map(call => ({ call, status: "confirmed" })),
      { call: "owned-pending", status: "unconfirmed" },
    ]);
    expect(selections.map(page => page.count)).toEqual([1, 50, 4]);
    for (const { plan } of selections) expect(plan).toMatch(/SEARCH .*phone_call_.*abandoned.*bot_id/);
    expect(pages.mock.calls).toEqual([["owner-bot", 50, undefined], ["owner-bot", 50, "owned-149"]]);
    expect(legacyScan).not.toHaveBeenCalled();
    expect(vendor.requests.filter(req => req.method === "DELETE")).toHaveLength(53);
    expect(vendor.requests.filter(req => req.method === "GET" && req.path === "/call")).toHaveLength(1);
    expect(rows.get("different-bot")?.status).toBe("scheduled");
    expect(rows.get("legacy-stop")?.abandonCancel).toBe("attempted");
    selections.length = 0;
    expect(await service.holdLegacyCalls()).toEqual({ held: [], live: [], failed: ["historic-1", "historic-10000", "historic-2", "historic-3", "legacy-pending"] });
    expect(selections.map(page => page.count)).toEqual([3, 4]);
    for (const { plan } of selections) expect(plan).toMatch(/SEARCH .*phone_call_.*abandoned.*bot_id/);
    expect(rows.get("legacy-stop")?.abandonCancel).toBe("confirmed");
  } finally {
    _resetPhoneSecretsForTest();
    await vendor.close();
  }
});

it("re-upgrade catches legacy inserts, changes and deletes after a completed migration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-reupgrade-"));
  const file = join(dir, "calls.db");
  const { migratePhoneCalls } = await import("./migrate.ts");
  try {
    {
      using db = new DatabaseSync(file);
      const store = new SqliteCallStore(db);
      store.insert({ ...original("legacy-updated", 1), status: "scheduled", botId: "old-bot" });
      store.insert({ ...original("legacy-deleted", 2), status: "scheduled", revision: 2 });
      await migratePhoneCalls(store);
      expect(store.meta("migrated")).toBe("done");
    }
    {
      using db = new DatabaseSync(file);
      const write = db.prepare(`INSERT INTO phone_calls VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET vendor_id = excluded.vendor_id, status = excluded.status, row_json = excluded.row_json`);
      for (const row of [
        { ...original("legacy-updated", 1), status: "abandoned", botId: "new-bot" },
        { ...original("legacy-inserted", 3), status: "scheduled", botId: "new-bot", revision: 7 },
      ]) write.run(row.id, row.vendorId, row.revision, row.assistantId, row.createdAt, row.status, JSON.stringify(row));
      db.prepare("DELETE FROM phone_calls WHERE id = ?").run("legacy-deleted");
    }
    using db = new DatabaseSync(file);
    const store = new SqliteCallStore(db);
    expect(() => store.revisionLive(7)).toThrow("migration_incomplete");
    await migratePhoneCalls(store);
    expect(store.revisionLive(7)).toBe(true);
    expect(store.revisionLive(2)).toBe(false);
    expect(store.liveForBot("old-bot")).toEqual([]);
    expect(store.liveForBot("new-bot").map(row => row.id)).toEqual(["legacy-inserted"]);
    expect([...store.abandoned()].map(row => row.id)).toEqual(["legacy-updated"]);
    expect(store.recent().map(row => row.id)).toEqual(["legacy-inserted", "legacy-updated"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("P12d and W7 a killed process leaves both settlement rows and the report due committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-settle-"));
  const file = join(dir, "calls.db");
  try {
    {
      using db = new DatabaseSync(file);
      const store = new SqliteCallStore(db);
      store.insert({ ...original("cancel", 1), status: "ringing", purpose: "cancel", booking: "booking" });
      store.insert({ ...original("booking", 1), cancel: { by: "cancel", state: "pending" } });
      db.exec("CREATE TABLE reports (due INTEGER); INSERT INTO reports VALUES (0)");
    }
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { writeSync } from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      import { SqliteCallStore } from "./server/phone-calls/store.ts";
      const db = new DatabaseSync(process.argv[1]);
      const store = new SqliteCallStore(db);
      const cancel = store.get("cancel"), booking = store.get("booking");
      if (!store.settle({ ...cancel, status: "ended" }, { ...booking, cancel: { by: cancel.id, state: "cancelled" } },
        { within(tx) { tx.prepare("UPDATE reports SET due = 1").run(); } })) throw new Error("settlement failed");
      writeSync(1, "committed\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `, file], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = once(child, "close");
    try {
      await expect(Promise.race([
        once(child.stdout, "data").then(([data]) => String(data)),
        closed.then(() => "child exited"),
      ])).resolves.toBe("committed\n");
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    expect((await closed)[1]).toBe("SIGKILL");

    using db = new DatabaseSync(file);
    const store = new SqliteCallStore(db);
    expect(store.get("cancel")?.status).toBe("ended");
    expect(store.get("booking")?.cancel?.state).toBe("cancelled");
    expect(db.prepare("SELECT id, status FROM phone_call_keys ORDER BY id").all())
      .toEqual([{ id: "booking", status: "ended" }, { id: "cancel", status: "ended" }]);
    expect(db.prepare("SELECT due FROM reports").get()).toEqual({ due: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
