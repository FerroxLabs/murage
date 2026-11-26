// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// C0 Astra High 2: an owner Cancel on a held legacy call that is acknowledged while Keep is still placing the replacement
// must stop that replacement, and Keep must never overwrite the cancellation afterwards. Loopback vendor, real adapter.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(open => { resolve = open; });
  return { promise, resolve };
}

const WHEN = "2026-12-01T10:00:00Z";

async function heldLegacyCall(vendor: Awaited<ReturnType<typeof startFakeVapi>>, rows = new MemoryCallStore()) {
  setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
  const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, rows);
  await service.saveSettings(defaultSettings("number-1", "Sam"));
  const placed = await service.place({ to: "+12025550101", goal: "Ask about opening hours", when: WHEN });
  const legacy = String(placed.ok && placed.value.call);
  expect(await service.holdLegacyCalls()).toEqual({ held: [legacy], live: [], failed: [] });
  return { service, legacy };
}

it("a Cancel acknowledged while Keep's create is in flight stops the replacement and stays cancelled", async () => {
  let armed = false;
  const created = barrier();
  const reply = barrier();
  const vendor = await startFakeVapi({
    beforeReply: async ({ method, path }) => {
      if (armed && method === "POST" && path === "/call") { created.resolve(); await reply.promise; }
    },
  });
  try {
    const { service, legacy } = await heldLegacyCall(vendor);
    armed = true;
    const keeping = service.decideHeld(legacy, "keep");
    await created.promise;
    // The vendor has recorded the replacement; its create response is still held.
    expect(vendor.calls.get("fixture-call-2")?.status).toBe("scheduled");
    const cancelled = await service.decideHeld(legacy, "cancel");
    expect(cancelled).toMatchObject({ ok: true, value: { call: legacy, held: "cancelled" } });
    // Acknowledged means stopped: the replacement is already deleted at the vendor before the create answers.
    expect(vendor.calls.get("fixture-call-2")).toMatchObject({ status: "ended", endedReason: "scheduled-call-deleted" });
    reply.resolve();
    await expect(keeping).resolves.toMatchObject({ ok: false, error: "cancelled" });
    expect(service._row(legacy)?.held).toBe("cancelled");
    expect(vendor.calls.get("fixture-call-2")?.status).toBe("ended");
    expect(vendor.creates).toBe(2);
  } finally {
    reply.resolve();
    await vendor.close();
  }
});

it("a Cancel that lands before Keep reaches the vendor means no replacement is ever created", async () => {
  let armed = false;
  const listed = barrier();
  const release = barrier();
  const vendor = await startFakeVapi({
    beforeReply: async ({ method, path }) => {
      if (armed && method === "GET" && path === "/call") { listed.resolve(); await release.promise; }
    },
  });
  try {
    const rows = new MemoryCallStore();
    const { service, legacy } = await heldLegacyCall(vendor, rows);
    // An earlier abandoned create whose discovery is pending makes place() await a vendor read before its last fence.
    rows.put({ id: "call_earlier", vendorId: "", revision: 1, assistantId: "assistant-1", createdAt: Date.now(), status: "abandoned",
      language: "en", to: "+12025550102", goal: "Earlier call", details: "", limits: "" });
    armed = true;
    const keeping = service.decideHeld(legacy, "keep");
    await listed.promise;
    await expect(service.decideHeld(legacy, "cancel")).resolves.toMatchObject({ ok: true, value: { call: legacy, held: "cancelled" } });
    release.resolve();
    await expect(keeping).resolves.toMatchObject({ ok: false });
    expect(service._row(legacy)?.held).toBe("cancelled");
    expect(vendor.creates).toBe(1);
    expect(vendor.requests.filter(r => r.method === "POST" && r.path === "/call")).toHaveLength(1);
  } finally {
    release.resolve();
    await vendor.close();
  }
});
