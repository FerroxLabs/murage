// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 F3 rows P7, P7b, P8b, P8d, P12d, P12e, P12g: durable booking/cancel state and bounded per-call work, through
// PhoneCallService on a SQLite file store with a loopback vendor. A restart is a new service, store and adapter on the same file.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { CallRow } from "./contracts.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { SqliteCallStore } from "./store.ts";
import { CREATE_CALL_RESPONSE } from "./fixtures/vapi-pinned.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter, type FetchLike } from "./vapi-adapter.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(() => _resetPhoneSecretsForTest());

const BISTRO = "+12025550101";
const BOT = "fixture-bot-a";
type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;
const creates = (vendor: Vendor) => vendor.requests.filter(r => r.method === "POST" && r.path === "/call");

/** One process lifetime on `file`. `wrap` may replace the vendor transport, `store` may be wrapped to record or fault writes. */
function boot(vendor: Vendor, file: string, wrap?: (f: FetchLike) => FetchLike, around?: (s: SqliteCallStore) => SqliteCallStore) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const db = new DatabaseSync(file);
  const raw = new SqliteCallStore(db);
  while (!raw.migrateBatch());
  const store = around ? around(raw) : raw;
  const revisions = new RevisionStore(raw.loadRevisions(), state => raw.saveRevisions(state));
  const service = new PhoneCallService(new VapiAdapter(wrap ? wrap(vendor.fetchImpl) : vendor.fetchImpl), revisions, () => "en", () => {}, store);
  return { db, raw, store, service };
}

/** The first process lifetime also saves the owner's settings; a restart reads them back from the file. */
async function firstBoot(...args: Parameters<typeof boot>) {
  const life = boot(...args);
  await life.service.saveSettings(defaultSettings("number-1", "Sam"));
  return life;
}

function withDir<T>(run: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "phone-durable-"));
  return run(join(dir, "calls.db")).finally(() => removeTempDirSync(dir));
}

/** The loopback vendor holds the create at a vendor boundary and tells the test when it is holding: "request" = the vendor has the
 * request and has not read its body (nothing created), "answer" = the vendor created the call and withholds the answer. */
function holdingVendor(boundary: "request" | "answer") {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held!: () => void;
  const holding = new Promise<void>(resolve => { held = resolve; });
  const hold = async (r: { method: string; path: string }) => { if (r.method === "POST" && r.path === "/call") { held(); await gate; } };
  const options = boundary === "request" ? { beforeBody: async (r: { method: string; path: string }) => { await hold(r); } } : { beforeReply: hold };
  return { options, holding, release };
}

/** A real child process places one call through the real network path; the test SIGKILLs it while the vendor is holding the create. */
async function killedPlace(file: string, origin: string, holding: Promise<void>, goal: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    import { setPhoneKeyFromShell, PHONE_KEY_ORIGIN } from "./server/phone-calls/phone-secrets.ts";
    import { PhoneCallService } from "./server/phone-calls/service.ts";
    import { RevisionStore } from "./server/phone-calls/settings.ts";
    import { SqliteCallStore } from "./server/phone-calls/store.ts";
    import { VapiAdapter } from "./server/phone-calls/vapi-adapter.ts";
    const [file, origin, key, goal, bot, to] = process.argv.slice(1);
    setPhoneKeyFromShell({ key, origin: PHONE_KEY_ORIGIN });
    const raw = new SqliteCallStore(new DatabaseSync(file));
    while (!raw.migrateBatch());
    const revisions = new RevisionStore(raw.loadRevisions(), state => raw.saveRevisions(state));
    const adapter = new VapiAdapter((target, init) => fetch(origin + new URL(target).pathname + new URL(target).search, init));
    await new PhoneCallService(adapter, revisions, () => "en", () => {}, raw).place({ to, goal }, { botId: bot });
  `, file, origin, "fixture", goal, BOT, BISTRO], { stdio: ["ignore", "ignore", "inherit"] });
  const closed = once(child, "close");
  await holding;
  child.kill("SIGKILL");
  const [, signal] = await closed;
  expect(signal).toBe("SIGKILL");
}

function endAt(vendor: Vendor, vendorId: string, structuredData: Record<string, unknown>) {
  vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call", analysis: { structuredData } });
}

async function booked(vendor: Vendor, service: PhoneCallService) {
  const placed = await service.place({ purpose: "book", to: BISTRO, goal: "Book a table for four on Friday at 7" }, { botId: BOT });
  const id = String(placed.ok && placed.value.call);
  endAt(vendor, service._row(id)!.vendorId, { outcome: "done", reference: "REF-1", time: "2026-12-05T19:00:00Z" });
  await service.result({ call: id });
  return id;
}

const cancelArgs = (booking: string) => ({ purpose: "cancel", booking, goal: "Cancel my table on Friday" });

it("P12d a cancel's terminal write and its booking state are one settle, and survive a restart", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      const writes: string[] = [];
      const record = (s: SqliteCallStore) => new Proxy(s, { get(t, k, r) {
        const v = Reflect.get(t, k, r);
        return typeof v === "function" && (k === "update" || k === "settle")
          ? (...a: unknown[]) => { writes.push(`${String(k)}:${(a[0] as CallRow).purpose ?? ""}:${(a[0] as CallRow).status}`); return v.apply(t, a); } : typeof v === "function" ? v.bind(t) : v;
      } });
      const a = await firstBoot(vendor, file, undefined, record);
      const booking = await booked(vendor, a.service);
      const placed = await a.service.place(cancelArgs(booking), { botId: BOT });
      const cancel = String(placed.ok && placed.value.call);
      endAt(vendor, a.service._row(cancel)!.vendorId, { outcome: "done" });
      writes.length = 0;
      await a.service.result({ call: cancel });
      expect(writes.filter(w => w.startsWith("settle:cancel:ended"))).toHaveLength(1);
      expect(writes.filter(w => w.startsWith("update:cancel:ended"))).toHaveLength(0);
      a.db.close();
      const requests = vendor.requests.length;
      const b = boot(vendor, file);
      expect(await b.service.place(cancelArgs(booking), { botId: BOT })).toMatchObject({ ok: false, error: "no_such_booking" });
      expect(vendor.requests.length).toBe(requests);
      expect(b.service.ownerCard(booking)?.bookingState).toBe("cancelled");
      b.db.close();
    });
  } finally { await vendor.close(); }
});

it("P12e a cancel interrupted before its intent row frees the booking", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      let crash = false;
      const a = await firstBoot(vendor, file, undefined, s => new Proxy(s, { get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "insert") return (row: CallRow, o?: never) => { if (crash && row.purpose === "cancel") throw new Error("killed"); return t.insert(row, o); };
        return typeof v === "function" ? v.bind(t) : v;
      } }));
      const booking = await booked(vendor, a.service);
      crash = true;
      const before = creates(vendor).length;
      await expect(a.service.place(cancelArgs(booking), { botId: BOT })).rejects.toThrow("killed");
      expect(creates(vendor).length).toBe(before);
      a.db.close();
      const b = boot(vendor, file);
      const retry = await b.service.place(cancelArgs(booking), { botId: BOT });
      expect(retry.ok).toBe(true);
      expect(creates(vendor).length).toBe(before + 1);
      b.db.close();
    });
  } finally { await vendor.close(); }
});

it("P12g deleting history never reopens a cancelled booking", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      const a = await firstBoot(vendor, file);
      const booking = await booked(vendor, a.service);
      const placed = await a.service.place(cancelArgs(booking), { botId: BOT });
      const cancel = String(placed.ok && placed.value.call);
      endAt(vendor, a.service._row(cancel)!.vendorId, { outcome: "done" });
      await a.service.result({ call: cancel });
      expect(a.raw.delete(cancel)).toBe(true);
      a.db.close();
      const requests = vendor.requests.length;
      const b = boot(vendor, file);
      expect(await b.service.place(cancelArgs(booking), { botId: BOT })).toMatchObject({ ok: false, error: "no_such_booking" });
      expect(vendor.requests.length).toBe(requests);
      expect(b.service.ownerCard(booking)?.bookingState).toBe("cancelled");
      expect(b.raw.delete(booking)).toBe(true);
      expect(await b.service.place(cancelArgs(booking), { botId: BOT })).toMatchObject({ ok: false, error: "no_such_booking" });
      b.db.close();
    });
  } finally { await vendor.close(); }
});

it("P7 a process killed while the vendor holds the create request creates nothing and is never re-placed", async () => {
  const hold = holdingVendor("request");
  const vendor = await startFakeVapi(hold.options);
  try {
    await withDir(async file => {
      const a = await firstBoot(vendor, file);
      a.db.close();
      await killedPlace(file, vendor.origin, hold.holding, "Ask about Friday");
      hold.release();
      expect(creates(vendor)).toHaveLength(0);
      const b = boot(vendor, file);
      const stuck = b.raw.firstUncertain()!;
      expect(stuck).toBeTruthy();
      expect(stuck.vendorId).toBe("");
      expect(await b.service.result({ call: stuck.id })).toMatchObject({ ok: false, error: "not_confirmed" });
      const again = await b.service.place({ to: BISTRO, goal: "Ask about Friday" }, { botId: BOT });
      expect(again).toMatchObject({ ok: false, error: "not_confirmed" });
      const other = await b.service.place({ to: BISTRO, goal: "Ask about Saturday" }, { botId: BOT });
      expect(other).toMatchObject({ ok: false, error: "not_confirmed" });
      expect(creates(vendor)).toHaveLength(0);
      b.db.close();
    });
  } finally { await vendor.close(); }
});

it("P7b a process killed while the vendor withholds the create answer adopts its own call (not another call to the same number), never re-places", async () => {
  const hold = holdingVendor("answer");
  // The decoy is listed first: matching by number or by list position would adopt it instead of the call this operation created.
  const vendor = await startFakeVapi({ ...hold.options, orderCalls: calls => [...calls].sort((x, y) => (x.id.startsWith("decoy") ? -1 : 0) - (y.id.startsWith("decoy") ? -1 : 0)) });
  try {
    await withDir(async file => {
      const a = await firstBoot(vendor, file);
      a.db.close();
      vendor.calls.set("decoy-1", { ...CREATE_CALL_RESPONSE, id: "decoy-1", name: "another-operation", customer: { number: BISTRO }, createdAt: new Date().toISOString(), status: "ended" });
      await killedPlace(file, vendor.origin, hold.holding, "Ask about Friday");
      hold.release();
      expect(creates(vendor)).toHaveLength(1);
      const b = boot(vendor, file);
      const stuck = b.raw.firstUncertain()!;
      expect(stuck).toBeTruthy();
      expect(stuck.vendorId).toBe("");
      expect(await b.service.result({ call: stuck.id })).toMatchObject({ ok: true });
      const rows = [...b.raw.recent(10)];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.vendorId).toBe("fixture-call-1");
      const again = await b.service.place({ to: BISTRO, goal: "Ask about Friday" }, { botId: BOT });
      expect(again.ok).toBe(true);
      expect(creates(vendor)).toHaveLength(1);
      b.db.close();
    });
  } finally { await vendor.close(); }
});

it("P8d a turn's place and result never probe revisions, and an owner refresh probes and deletes at most 4", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      const probes = { n: 0 };
      const a = await firstBoot(vendor, file, undefined, s => new Proxy(s, { get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "revisionLive") return (n: number) => { probes.n++; return t.revisionLive(n); };
        return typeof v === "function" ? v.bind(t) : v;
      } }));
      // Six calls, each on its own revision, keep six assistants pinned; a seventh save makes all six superseded.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const placed = await a.service.place({ to: BISTRO, goal: `Ask about day ${i}` }, { botId: BOT });
        ids.push(String(placed.ok && placed.value.call));
        await a.service.saveSettings(defaultSettings("number-1", `Owner ${i}`));
      }
      const deletes = () => vendor.requests.filter(r => r.method === "DELETE" && r.path.startsWith("/assistant/")).length;
      const before = deletes();
      probes.n = 0;
      for (const id of ids) { endAt(vendor, a.service._row(id)!.vendorId, { outcome: "done" }); await a.service.result({ call: id }); }
      await a.service.place({ to: BISTRO, goal: "Ask again" }, { botId: BOT });
      expect(probes.n).toBe(0);
      expect(deletes()).toBe(before);
      await a.service.releaseOldAssistants();
      expect(probes.n).toBeLessThanOrEqual(4);
      expect(deletes() - before).toBeLessThanOrEqual(4);
      expect(deletes() - before).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) await a.service.releaseOldAssistants();
      expect(a.raw.loadRevisions()?.revisions.filter(r => r.state === "superseded")).toHaveLength(0);
      a.db.close();
    });
  } finally { await vendor.close(); }
});

it("P8d a save that lands while a turn's place() is starting leaves that place with no revision scan and no vendor delete", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      const probes = { n: 0 };
      const spy = (s: SqliteCallStore) => new Proxy(s, { get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "revisionLive") return (n: number) => { probes.n++; return t.revisionLive(n); };
        return typeof v === "function" ? v.bind(t) : v;
      } });
      const deletes = () => vendor.requests.filter(r => r.method === "DELETE" && r.path.startsWith("/assistant/")).length;
      const turn = { armed: false, deletes: -1 };
      const scans = vi.spyOn(RevisionStore.prototype, "releasable");
      const holder: { service?: PhoneCallService } = {};
      const a = boot(vendor, file, f => async (url, init) => {
        if (turn.armed && init.method === "POST" && url.endsWith("/call")) {
          turn.armed = false;
          // The owner saves settings inside the vendor create: the call's revision is superseded before its row is stored.
          await holder.service!.saveSettings(defaultSettings("number-1", "Saved mid-start"));
          probes.n = 0; scans.mockClear(); turn.deletes = deletes();
        }
        return f(url, init);
      }, spy);
      holder.service = a.service;
      await a.service.saveSettings(defaultSettings("number-1", "Sam"));
      // Six calls each pin their own superseded revision, so a scan on the turn path has revisions to probe.
      const day: string[] = [];
      for (let i = 0; i < 6; i++) {
        const p = await a.service.place({ to: BISTRO, goal: `Ask about day ${i}` }, { botId: BOT });
        day.push(String(p.ok && p.value.call));
        await a.service.saveSettings(defaultSettings("number-1", `Owner ${i}`));
      }
      // End the six calls so their revisions are releasable: a cleanup on the turn path would have real deletes to make.
      for (const id of day) { endAt(vendor, a.service._row(id)!.vendorId, { outcome: "done" }); await a.service.result({ call: id }); }
      turn.armed = true;
      const placed = await a.service.place({ to: BISTRO, goal: "Ask while a save lands" }, { botId: BOT });
      expect(placed.ok).toBe(true);
      expect(turn.deletes).toBeGreaterThanOrEqual(0);
      expect(probes.n).toBe(0);
      expect(scans).not.toHaveBeenCalled();
      expect(deletes()).toBe(turn.deletes);
      scans.mockRestore();
      a.db.close();
    });
  } finally { await vendor.close(); }
});

it("P8b assistant cleanup waits for the key-table migration", async () => {
  const vendor = await startFakeVapi();
  try {
    await withDir(async file => {
      const db = new DatabaseSync(file);
      const raw = new SqliteCallStore(db);
      setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
      const probe = vi.spyOn(raw, "revisionLive").mockReturnValue(false);
      const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, raw);
      await service.saveSettings(defaultSettings("number-1", "A"));
      await service.saveSettings(defaultSettings("number-1", "B"));
      expect(raw.meta("migrated")).not.toBe("done");
      await service.releaseOldAssistants();
      expect(probe).not.toHaveBeenCalled();
      expect(vendor.requests.filter(r => r.method === "DELETE")).toHaveLength(0);
      while (!raw.migrateBatch());
      await service.releaseOldAssistants();
      expect(probe).toHaveBeenCalled();
      db.close();
    });
  } finally { await vendor.close(); }
});
