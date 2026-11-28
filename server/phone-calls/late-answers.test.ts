// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 rows P24b/P24c (F3): a late vendor answer never restores a deleted call or a cleared transcript. Loopback vendor, real adapter.
import { afterEach, expect, it } from "vitest";
import type { CallRow, CallWriteOptions } from "./contracts.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

const DAY = 24 * 60 * 60 * 1000;
type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;

/** Records every write attempt per call id (put, insert, update, settle). */
class CountingStore extends MemoryCallStore {
  writes: string[] = [];
  override put(row: CallRow): void { this.writes.push(row.id); super.put(row); }
  override insert(row: CallRow, o?: CallWriteOptions): void { this.writes.push(row.id); super.insert(row, o); }
  override update(row: CallRow, o?: CallWriteOptions): boolean { this.writes.push(row.id); return super.update(row, o); }
  override settle(c: CallRow, b: CallRow, o?: CallWriteOptions): boolean { this.writes.push(c.id, b.id); return super.settle(c, b, o); }
}

/** Holds the next matching vendor reply after each arm() until that arm's release(). */
function holdOnce(match: (method: string, path: string) => boolean) {
  let armed: { seen: () => void; gate: Promise<void> } | undefined;
  let release = () => {}, reached = Promise.resolve();
  return {
    get release() { return release; }, get reached() { return reached; },
    arm: () => {
      let seen!: () => void, open!: () => void;
      reached = new Promise<void>(r => { seen = r; });
      const gate = new Promise<void>(r => { open = r; });
      release = open; armed = { seen, gate };
    },
    beforeReply: async (r: { method: string; path: string }) => {
      const a = armed;
      if (a && match(r.method, r.path)) { armed = undefined; a.seen(); await a.gate; }
    },
  };
}

async function setup(vendor: Vendor, rows: MemoryCallStore = new CountingStore()) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const revisions = new RevisionStore();
  const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), revisions, () => "en", () => {}, rows);
  await service.saveSettings(defaultSettings("number-1", "Sam"));
  const placed = await service.place({ to: "+12025550102", goal: "Ask about opening hours" }, { botId: "fixture-bot-a" });
  const id = String(placed.ok && placed.value.call);
  return { service, rows, revisions, id, vendorId: service._row(id)!.vendorId };
}

const reads = (vendor: Vendor, vendorId: string) => vendor.requests.filter(r => r.method === "GET" && r.path === `/call/${vendorId}`).length;

it("P24b a late vendor answer never restores a deleted call (owner refresh and the owner cancel's 409 read)", async () => {
  const hold = holdOnce((m, p) => m === "GET" && p.startsWith("/call/"));
  let refuse = false;
  const vendor = await startFakeVapi({ beforeReply: hold.beforeReply, beforeBody: r => (refuse && r.method === "DELETE" ? 409 : undefined) });
  try {
    // (1) an ended call still waiting for its analysis: the owner refresh reads it; the owner deletes it while the read is held.
    const { service, rows, revisions, id, vendorId } = await setup(vendor);
    const store = rows as CountingStore;
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call" });
    await service.result({ call: id });
    hold.arm();
    const refresh = service.refreshOwnerCalls();
    await hold.reached;
    expect(service.deleteCall(id)).toEqual({ ok: true });
    const after = store.writes.length;
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, analysis: { structuredData: { outcome: "done" } } });
    hold.release();
    await refresh;
    expect(service._row(id)).toBeUndefined();
    expect(store.writes.slice(after)).not.toContain(id);
    // (2) the owner's Cancel meets a 409 and reads the call; the call ends and the owner deletes it while that read is held.
    const second = await service.place({ to: "+12025550103", goal: "Ask about parking", when: "2026-12-05T19:00:00Z" }, { botId: "fixture-bot-a" });
    const id2 = String(second.ok && second.value.call);
    refuse = true;
    const v2 = service._row(id2)!.vendorId;
    hold.arm();
    const cancelling = service.cancel(id2);
    await hold.reached;
    rows.update({ ...service._row(id2)!, status: "ended", structured: { outcome: "not_done" } });
    expect(service.deleteCall(id2)).toEqual({ ok: true });
    const after2 = store.writes.length;
    vendor.calls.set(v2, { ...vendor.calls.get(v2)!, status: "in-progress" });
    hold.release();
    expect(await cancelling).toBe("not_found");
    expect(store.writes.slice(after2)).not.toContain(id2);
    // Restart on the same rows: neither call is listed.
    const restarted = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), revisions, () => "en", () => {}, rows);
    await restarted.refreshOwnerCalls();
    expect(rows.recent(50).map(r => r.id)).not.toContain(id);
    expect(rows.recent(50).map(r => r.id)).not.toContain(id2);
  } finally { await vendor.close(); }
});

it("P24c (i) a cleared transcript stays cleared across a retention change and a held read", async () => {
  const hold = holdOnce((m, p) => m === "GET" && p.startsWith("/call/"));
  const vendor = await startFakeVapi({ beforeReply: hold.beforeReply });
  try {
    const { service, rows, id, vendorId } = await setup(vendor);
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call",
      artifact: { transcript: "Business: we open at nine." }, analysis: { structuredData: { outcome: "done" } } });
    rows.setMeta("retention", "30");
    const old = Date.now() - 40 * DAY;
    rows.update({ ...service._row(id)!, status: "ended", structured: { outcome: "done" }, createdAt: old, endedAt: old, transcriptCleared: true });
    rows.setMeta("retention", "90");
    const before = reads(vendor, vendorId);
    for (let i = 0; i < 3; i++) await service.refreshOwnerCalls();
    expect(reads(vendor, vendorId)).toBe(before);
    hold.arm();
    const late = service.result({ call: id });
    await hold.reached;
    rows.setMeta("retention", "90");
    hold.release();
    await late;
    expect(service._row(id)!.transcript).toBeUndefined();
    expect(service._row(id)!.transcriptCleared).toBe(true);
    expect(service.ownerCard(id)!.transcript).toBeUndefined();
  } finally { await vendor.close(); }
});

it("P24c (ii) a read of a call past retention absorbs the outcome but never stores its transcript", async () => {
  const vendor = await startFakeVapi();
  try {
    const { service, rows, id, vendorId } = await setup(vendor);
    rows.setMeta("retention", "30");
    const old = Date.now() - 40 * DAY;
    rows.update({ ...service._row(id)!, status: "ended", createdAt: old, endedAt: old });
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call",
      artifact: { transcript: "Business: we open at nine." }, analysis: { structuredData: { outcome: "done" } } });
    await service.refreshOwnerCalls();
    expect(service._row(id)!.structured?.outcome).toBe("done");
    expect(service._row(id)!.transcript).toBeUndefined();
  } finally { await vendor.close(); }
});
