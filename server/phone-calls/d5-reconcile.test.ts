// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { gate } from "../testing/exec-check-spy.ts";
import type { CallRow } from "./contracts.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { reconcileOne, reconcilePending } from "./reconcile.ts";
import { SqliteCallStore } from "./store.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

const from = Date.UTC(2025, 0, 1);
const to = from + 1_200_000;
const intentTime = from + 300_000;
const tick = 60_001;
const fixtureKey = "offline-fixture-credential";
type Range = [number, number];
type FakeVapi = Awaited<ReturnType<typeof startFakeVapi>>;

beforeEach(() => {
  _resetPhoneSecretsForTest();
  setPhoneKeyFromShell({ key: fixtureKey, origin: PHONE_KEY_ORIGIN });
});
afterEach(_resetPhoneSecretsForTest);

function pending(id: string, reconcileScan?: CallRow["reconcileScan"]): CallRow {
  return {
    id, vendorId: "", revision: 1, assistantId: "assistant", createdAt: intentTime,
    status: "abandoned", language: "en", to: "", goal: "", details: "", limits: "", reconcileScan,
  };
}

function seedVendor(vendor: FakeVapi, timestamps: readonly number[], targetIndex: number, operation: string): void {
  timestamps.forEach((at, index) => {
    const id = `vendor-${index}`;
    vendor.calls.set(id, { id, name: index === targetIndex ? operation : `other-${index}`,
      createdAt: new Date(at).toISOString(), status: "scheduled" });
  });
}

function reads(vendor: FakeVapi): Range[] {
  return vendor.requests.filter(req => req.path === "/call" && req.method === "GET").map(({ query }) => {
    expect([...query.keys()].sort()).toEqual(["createdAtGe", "createdAtLe", "limit"]);
    expect(query.get("limit")).toBe("100");
    return [Date.parse(query.get("createdAtGe")!), Date.parse(query.get("createdAtLe")!)];
  });
}

it.each(["delete", "newer discovery"] as const)("REGRESSION (green on f1903e85e7): a held discovery response cannot overwrite %s", async change => {
  const arrival = gate();
  const release = gate();
  let held: Promise<void> | undefined;
  const vendor = await startFakeVapi({ beforeReply: async request => {
    if (request.method !== "GET" || request.path !== "/call") return;
    arrival.open();
    await release.promise;
  } });
  try {
    using db = new DatabaseSync(":memory:");
    const rows = new SqliteCallStore(db);
    const call = pending("held-discovery");
    rows.insert(call);
    seedVendor(vendor, [intentTime], 0, call.id);
    held = reconcileOne({ rows, adapter: new VapiAdapter(vendor.fetchImpl) }, call.id);
    await arrival.promise;
    const newer = { ...call, reconcileScan: { ranges: [[from, from + 1]] as Range[] } };
    if (change === "delete") expect(rows.delete(call.id)).toBe(true);
    else expect(rows.update(newer)).toBe(true);
    const update = vi.spyOn(rows, "update");
    release.open();
    await held;
    expect(rows.get(call.id)).toEqual(change === "delete" ? undefined : newer);
    expect(vendor.requests.map(request => request.method)).toEqual(["GET"]);
    expect(update).not.toHaveBeenCalled();
  } finally {
    release.open();
    await held;
    await vendor.close();
  }
});

it("REGRESSION (green on f1903e85e7): overlapping passes and direct checks share one vendor discovery", async () => {
  const arrival = gate();
  const release = gate();
  const pendingPasses: Promise<void>[] = [];
  const vendor = await startFakeVapi({ beforeReply: async request => {
    if (request.method !== "GET" || request.path !== "/call") return;
    arrival.open();
    await release.promise;
  } });
  try {
    using db = new DatabaseSync(":memory:");
    const rows = new SqliteCallStore(db);
    const due = vi.spyOn(rows, "duePending");
    const call = pending("single-discovery");
    rows.insert(call);
    seedVendor(vendor, [intentTime], 0, call.id);
    const deps = { rows, adapter: new VapiAdapter(vendor.fetchImpl) };
    pendingPasses.push(reconcilePending(deps));
    await arrival.promise;
    pendingPasses.push(reconcilePending(deps), reconcileOne(deps, call.id));
    release.open();
    await Promise.all(pendingPasses);
    expect(due).toHaveBeenCalledTimes(1);
    expect(vendor.requests.map(request => request.method)).toEqual(["GET", "DELETE"]);
    expect(rows.get(call.id)?.abandonCancel).toBe("confirmed");
  } finally {
    release.open();
    await Promise.all(pendingPasses);
    await vendor.close();
  }
});

it.each(["abort", "newer outcome"] as const)("REGRESSION (green on f1903e85e7): durable DELETE claim survives %s while the reply is held", async change => {
  const dir = mkdtempSync(join(tmpdir(), "phone-delete-claim-"));
  const file = join(dir, "calls.db");
  const arrival = gate();
  const release = gate();
  const controller = new AbortController();
  let held: Promise<void> | undefined;
  let db: DatabaseSync | undefined;
  const vendor = await startFakeVapi({ beforeReply: async request => {
    if (request.method !== "DELETE" || request.path !== "/call/vendor-0") return;
    arrival.open();
    await release.promise;
  } });
  try {
    db = new DatabaseSync(file);
    const rows = new SqliteCallStore(db);
    const call = pending("claimed-delete");
    rows.insert(call);
    seedVendor(vendor, [intentTime], 0, call.id);
    const adapter = new VapiAdapter(vendor.fetchImpl);
    held = reconcilePending({ rows, adapter }, controller.signal);
    await arrival.promise;
    using reopenedDb = new DatabaseSync(file);
    const reopened = new SqliteCallStore(reopenedDb);
    expect(reopened.get(call.id)).toMatchObject({ abandonCancel: "attempted", vendorId: "vendor-0" });
    expect(reopened.duePending(Date.now())).toEqual([]);
    await reconcilePending({ rows: reopened, adapter });
    const expected = change === "abort" ? "attempted" : "not_found";
    if (change === "abort") {
      controller.abort();
      await held;
    } else expect(reopened.update({ ...reopened.get(call.id)!, abandonCancel: "not_found" })).toBe(true);
    release.open();
    await held;
    await reconcilePending({ rows: reopened, adapter });
    expect(reopened.get(call.id)?.abandonCancel).toBe(expected);
    expect(vendor.requests.map(request => request.method)).toEqual(["GET", "DELETE"]);
  } finally {
    release.open();
    try { await held; }
    finally {
      db?.close();
      await vendor.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Recursive fixture oracle has no access to the adapter, SQL state or runtime stack.
function halvingReads(timestamps: readonly number[], targetIndex: number): Range[] {
  const expected: Range[] = [];
  function walk(lo: number, hi: number): boolean {
    expected.push([lo, hi]);
    const contained = timestamps.filter(time => time >= lo && time <= hi);
    if (contained.length < 100) return timestamps[targetIndex] >= lo && timestamps[targetIndex] <= hi;
    if (lo === hi) return true;
    const cut = Math.floor((lo + hi) / 2);
    return walk(lo, cut) || walk(cut + 1, hi);
  }
  walk(from, to);
  return expected;
}

const spaced = (count: number, spacing: number) => Array.from({ length: count }, (_, n) => from + spacing * n);

it.each([
  ["150 spaced", spaced(150, 8_000), 19, 3],
  ["1,000 with a killed process", spaced(1_000, 1_200), 499, 31],
  ["101 in one millisecond", spaced(101, 0).map(() => from + 600_000), 50, 43],
  ["1,000 with a sub-second cluster", [...spaced(950, 2).map(at => at + 600_000), ...spaced(50, 24_000)], 499, 43],
] as const)("P7c checks the full vendor window: %s", async (_name, timestamps, targetIndex, cap) => {
  const vendor = await startFakeVapi({ orderCalls: calls => calls.reverse() });
  const dir = mkdtempSync(join(tmpdir(), "phone-reconcile-"));
  const file = join(dir, "calls.db");
  const intent = pending("pending-call");
  let now = to + 1;
  try {
    seedVendor(vendor, timestamps, targetIndex, intent.id);
    {
      using db = new DatabaseSync(file);
      new SqliteCallStore(db, () => now).put(intent);
    }
    if (targetIndex === 499 && cap === 31) {
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { writeSync } from "node:fs";
        import { DatabaseSync } from "node:sqlite";
        import { setPhoneKeyFromShell, PHONE_KEY_ORIGIN } from "./server/phone-calls/phone-secrets.ts";
        import { reconcilePending } from "./server/phone-calls/reconcile.ts";
        import { SqliteCallStore } from "./server/phone-calls/store.ts";
        import { VapiAdapter } from "./server/phone-calls/vapi-adapter.ts";
        const [file, origin, key, start, step] = process.argv.slice(1);
        setPhoneKeyFromShell({ key, origin: PHONE_KEY_ORIGIN });
        let now = Number(start);
        const rows = new SqliteCallStore(new DatabaseSync(file), () => now);
        const adapter = new VapiAdapter((target, init) => fetch(origin + new URL(target).pathname + new URL(target).search, init));
        for (let i = 0; i < 3; i++) {
          await reconcilePending({ rows, adapter, now: () => now });
          now += Number(step);
        }
        writeSync(1, "three committed\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      `, file, vendor.origin, fixtureKey, String(now), String(tick)], { stdio: ["ignore", "pipe", "inherit"] });
      const closed = once(child, "close");
      try {
        await expect(Promise.race([
          once(child.stdout, "data").then(([data]) => String(data)),
          closed.then(() => "child exited"),
        ])).resolves.toBe("three committed\n");
      } finally {
        child.kill("SIGKILL");
        await closed;
      }
      expect((await closed)[1]).toBe("SIGKILL");
      expect(reads(vendor)).toHaveLength(3);
      now += 3 * tick;
    }

    using db = new DatabaseSync(file);
    const rows = new SqliteCallStore(db, () => now);
    const adapter = new VapiAdapter(vendor.fetchImpl);
    for (let n = vendor.requests.length; n < cap && rows.duePending(now).length; n++, now += tick) {
      await reconcilePending({ rows, adapter, now: () => now });
    }
    const expected = halvingReads(timestamps, targetIndex);
    expect(reads(vendor)).toEqual(expected);
    expect(expected.length).toBeLessThanOrEqual(cap);
    expect(new Set(expected.map(String)).size).toBe(expected.length);
    expect(expected.every(([lo, hi]) => hi >= lo)).toBe(true);
    expect(vendor.creates).toBe(0);
    if (cap === 43 && timestamps[0] === timestamps[1]) {
      expect(rows.get(intent.id)).toMatchObject({ reconcileScan: "unpageable", vendorId: "" });
      expect(db.prepare("SELECT reconcile_due, reconcile_misses FROM phone_call_keys").get())
        .toEqual({ reconcile_due: null, reconcile_misses: 0 });
    } else {
      expect(rows.get(intent.id)).toMatchObject({ vendorId: `vendor-${targetIndex}`, abandonCancel: "confirmed" });
      expect(vendor.requests.filter(req => req.method === "DELETE")).toHaveLength(1);
    }
    console.log(`P7c ${_name}: ${expected.length} vendor reads`);
  } finally {
    await vendor.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it("P8c complete misses back off and let the ninth pending call through", async () => {
  const vendor = await startFakeVapi();
  try {
    using db = new DatabaseSync(":memory:");
    let now = to + 1;
    const rows = new SqliteCallStore(db, () => now);
    for (let n = 0; n < 9; n++) rows.insert(pending(`intent-${n}`), { reconcileDue: now + n - 9 });
    seedVendor(vendor, [intentTime], 0, "intent-8");
    const adapter = new VapiAdapter(vendor.fetchImpl);
    const step = () => reconcilePending({ rows, adapter, now: () => now });
    await step();
    expect(reads(vendor)).toHaveLength(8);
    expect(db.prepare("SELECT reconcile_misses FROM phone_call_keys WHERE id < 'intent-8'").all())
      .toEqual(Array.from({ length: 8 }, () => ({ reconcile_misses: 1 })));
    await step();
    expect(rows.get("intent-8")?.abandonCancel).toBe("confirmed");
    for (let n = 0; n < 12; n++) { now += 86_400_001; await step(); }
    expect(rows.get("intent-0")?.abandonCancel).toBe("not_found");
    expect(db.prepare("SELECT reconcile_misses FROM phone_call_keys WHERE id = 'intent-0'").get())
      .toEqual({ reconcile_misses: 12 });
    expect(reads(vendor)).toHaveLength(8 * 12 + 1);
    expect(vendor.requests.filter(req => req.method === "DELETE")).toHaveLength(1);
  } finally { await vendor.close(); }
});

it("P8c unfinished and unpageable rows move behind later work even with a fixed clock", async () => {
  const vendor = await startFakeVapi();
  try {
    using db = new DatabaseSync(":memory:");
    const now = to + 1;
    const rows = new SqliteCallStore(db, () => now);
    const crowded = from + 600_000;
    seedVendor(vendor, spaced(1_000, 1_200), -1, "");
    for (let n = 0; n < 101; n++) {
      const id = `cluster-${n}`;
      vendor.calls.set(id, { id, createdAt: new Date(crowded).toISOString(), status: "scheduled" });
    }
    vendor.calls.set("match", { id: "match", name: "tail", createdAt: new Date(from + 2).toISOString(), status: "scheduled" });
    for (let n = 0; n < 8; n++) {
      rows.insert(pending(`unpageable-${n}`, { ranges: [[crowded, crowded]] }), { reconcileDue: now - 100 + n });
      rows.insert(pending(`unfinished-${n}`), { reconcileDue: now - 20 + n });
    }
    rows.insert(pending("tail", { ranges: [[from, from + 10]] }), { reconcileDue: now });
    const adapter = new VapiAdapter(vendor.fetchImpl);
    const step = () => reconcilePending({ rows, adapter, now: () => now });
    await step();
    expect(rows.get("unpageable-0")?.reconcileScan).toBe("unpageable");
    expect(rows.duePending(now).map(row => row.id)).toEqual(Array.from({ length: 8 }, (_, n) => `unfinished-${n}`));
    await step();
    expect(rows.get("unfinished-0")?.reconcileScan).toMatchObject({ ranges: expect.any(Array) });
    expect(rows.duePending(now).map(row => row.id)).toEqual(["tail"]);
    await step();
    expect(rows.get("tail")?.abandonCancel).toBe("confirmed");
    expect(reads(vendor)).toHaveLength(17);
    expect(rows.duePending(now)).toEqual([]);
  } finally { await vendor.close(); }
});

it.each([10, 10_000])("P8 admits at most eight due rows and one uncertain row with %d historic calls", async (count) => {
  const vendor = await startFakeVapi();
  try {
    using db = new DatabaseSync(":memory:");
    const now = to + 1;
    const rows = new SqliteCallStore(db, () => now);
    db.exec("BEGIN IMMEDIATE");
    const write = db.prepare("INSERT INTO phone_calls VALUES (?, '', 1, 'assistant', ?, 'ended', ?)");
    for (let n = 0; n < count; n++) {
      const old = { ...pending(`historic-${n}`), status: "ended" };
      write.run(old.id, n, JSON.stringify(old));
    }
    db.exec("COMMIT");
    for (let n = 0; n < 20; n++) {
      rows.insert(pending(`pending-${n}`), { reconcileDue: now - 20 + n });
      const name = `pending-${n}`, id = `scheduled-${n}`;
      vendor.calls.set(id, { id, name, createdAt: new Date(intentTime).toISOString(), status: "scheduled" });
    }
    for (let n = 0; n < 10; n++) rows.insert({ ...pending(`uncertain-${n}`), status: "uncertain" }, { reconcileDue: now + tick });

    const prepare = db.prepare.bind(db);
    const queries: { sql: string; rows: number; plan: string[] }[] = [];
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (!sql.includes("WHERE k.reconcile_due") && !sql.includes("INDEXED BY phone_calls_live")) return statement;
      const sqliteAll = statement.all.bind(statement) as (...args: SQLInputValue[]) => ReturnType<typeof statement.all>;
      statement.all = ((...args: SQLInputValue[]) => {
        const result = sqliteAll(...args);
        queries.push({ sql, rows: result.length,
          plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail)) });
        return result;
      }) as typeof statement.all;
      return statement;
    };
    const adapter = new VapiAdapter(vendor.fetchImpl);
    for (let pass = 0; pass < 3; pass++) {
      await reconcilePending({ rows, adapter, now: () => now });
      expect(rows.firstUncertain()?.status).toBe("uncertain");
    }
    expect(queries.map(query => query.rows)).toEqual([8, 1, 8, 1, 4, 1]);
    expect(queries.every(({ sql, plan }) => plan.some(detail => detail.includes(
      sql.includes("WHERE k.reconcile_due") ? "phone_call_keys_due" : "phone_calls_live",
    )) && plan.every(detail => !detail.startsWith("SCAN phone_calls")))).toBe(true);
    expect(vendor.requests.filter(req => req.method === "DELETE")).toHaveLength(20);
    expect(reads(vendor)).toHaveLength(20);
    console.log(`P8 with ${count} historic rows: ${queries.map(query => query.rows).join(", ")} rows`);
  } finally { await vendor.close(); }
});

it("P8c shares the eight vendor reads with durable analysis due beyond the recent list", async () => {
  const vendor = await startFakeVapi();
  try {
    using db = new DatabaseSync(":memory:");
    const now = to + 1;
    const rows = new SqliteCallStore(db, () => now);
    const adapter = new VapiAdapter(vendor.fetchImpl);
    for (let n = 0; n < 6; n++) rows.insert(pending(`miss-${n}`));
    for (let n = 0; n < 3; n++) {
      const id = `analysis-${n}`, vendorId = `ended-${n}`;
      rows.insert({ ...pending(id), vendorId, status: "ended", analysisDue: now - 3 + n });
      vendor.calls.set(vendorId, { id: vendorId, createdAt: new Date(now).toISOString(), status: "ended" });
    }
    for (let n = 0; n < 60; n++) rows.insert({ ...pending(`newer-${n}`), createdAt: now + n, status: "ended" });
    expect(rows.recent().every(row => row.id.startsWith("newer-"))).toBe(true);
    const step = () => reconcilePending({ rows, adapter, now: () => now, refreshAnalysis: async row => {
      await adapter.result(row.vendorId);
      rows.update({ ...row, analysisDue: undefined });
    } });
    await step();
    expect(vendor.requests.map(req => req.path)).toEqual([...Array(6).fill("/call"), "/call/ended-0", "/call/ended-1"]);
    expect(rows.analysisDue(now).map(row => row.id)).toEqual(["analysis-2"]);
    await step();
    expect(vendor.requests.at(-1)?.path).toBe("/call/ended-2");
    expect(rows.analysisDue(now)).toEqual([]);
  } finally { await vendor.close(); }
});
