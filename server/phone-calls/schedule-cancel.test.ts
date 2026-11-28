// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 rows P6/P6b (F3): the owner's Cancel against a stale vendor read and against a call that already started. Loopback vendor.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

const BISTRO = "+12025550101";

async function scheduled(vendor: Awaited<ReturnType<typeof startFakeVapi>>) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
  await service.saveSettings(defaultSettings("number-1", "Sam"));
  const placed = await service.place({ to: BISTRO, goal: "Ask about opening hours", when: "2026-12-05T19:00:00Z" }, { botId: "fixture-bot-a" });
  expect(placed.ok && placed.value.status).toBe("scheduled");
  const id = String(placed.ok && placed.value.call);
  return { service, id, vendorId: service._row(id)!.vendorId };
}

it("P6 the owner's Cancel beats a stale read", async () => {
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen!: () => void;
  const reading = new Promise<void>(resolve => { seen = resolve; });
  const vendor = await startFakeVapi({ beforeReply: async r => {
    if (!held && r.method === "GET" && r.path.startsWith("/call/")) { held = true; seen(); await gate; }
  } });
  try {
    const { service, id, vendorId } = await scheduled(vendor);
    // The read leaves the vendor saying `ringing`; it is held until the owner's Cancel has completed.
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ringing" });
    const stale = service.result({ call: id });
    await reading;
    expect(await service.cancel(id)).toBe("cancelled");
    release();
    await stale;
    expect(service._row(id)!.status).toBe("cancelled");
    expect(service.ownerCard(id)!.status).toBe("cancelled");
    expect(vendor.requests.filter(r => r.method === "DELETE" && r.path === `/call/${vendorId}`)).toHaveLength(1);
  } finally { await vendor.close(); }
});

it("P6b a cancel that loses to a started call is shown truthfully", async () => {
  const vendor = await startFakeVapi({ beforeBody: r => (r.method === "DELETE" && r.path.startsWith("/call/") ? 409 : undefined) });
  try {
    const { service, id, vendorId } = await scheduled(vendor);
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "in-progress" });
    expect(await service.cancel(id)).toBe("in_progress");
    expect(service._row(id)!.status).toBe("in_progress");
    const card = service.ownerCard(id)!;
    expect(card.status).toBe("in_progress");
    expect(card.line).toBe("phoneCalls.result.alreadyStarted");
  } finally { await vendor.close(); }
});

it("P6c a call the owner deleted while its Cancel was in flight is never written back", async () => {
  let release!: () => void;
  let held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let seen!: () => void;
  const reading = new Promise<void>(resolve => { seen = resolve; });
  const vendor = await startFakeVapi({
    beforeBody: r => (r.method === "DELETE" && r.path.startsWith("/call/") ? 409 : undefined),
    beforeReply: async r => { if (!held && r.method === "GET" && r.path.startsWith("/call/")) { held = true; seen(); await gate; } },
  });
  try {
    const { service, id, vendorId } = await scheduled(vendor);
    // The vendor refuses the cancel (the call is over); the Cancel's follow-up read is held.
    const cancelling = service.cancel(id);
    await reading;
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call" });
    // A refresh settles the row ended, so the owner may delete it while the Cancel's read is still out.
    await service.result({ call: id });
    expect(service._row(id)!.status).toBe("ended");
    expect(service.deleteCall(id)).toEqual({ ok: true });
    release();
    expect(await cancelling).toBe("not_found");
    expect(service._row(id)).toBeUndefined();
    expect(service.ownerCard(id)).toBeNull();
  } finally { await vendor.close(); }
});
