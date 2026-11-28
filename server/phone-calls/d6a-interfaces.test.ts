// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 F3 interfaces for D6a r3 3.2-3.3 (owner: F3; consumer: the D6a seat): refreshOne reads one call without the reconcile pass,
// and the tagged counter measures actual vendor requests whatever path made them.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { isFinal, PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter, vendorRequestCount, withVendorTag } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

it("refreshOne makes one tagged read of one call and never runs the reconcile pass", async () => {
  const vendor = await startFakeVapi();
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const rows = new MemoryCallStore();
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, rows);
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    const placed = await service.place({ to: "+12025550104", goal: "Ask about opening hours" }, { botId: "fixture-bot-a" });
    const id = String(placed.ok && placed.value.call);
    const vendorId = service._row(id)!.vendorId;
    // An abandoned row with no vendor id would make a reconcile pass search the vendor's call list.
    rows.insert({ ...service._row(id)!, id: `call_${"b".repeat(24)}`, vendorId: "", status: "abandoned", intent: undefined, identity: undefined });
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, status: "ended", endedReason: "customer-ended-call" });
    // Base evidence: with the pre-fix tree given only a refreshOne alias of refreshOwnerCalls, the next assertion fails behaviorally
    // (a list request beside the one read). Without that alias the API checks below fail first.
    // Net-new interfaces (absent before this lane): name them as assertions before any use.
    expect(typeof service.refreshOne).toBe("function");
    expect(typeof vendorRequestCount).toBe("function");
    expect(typeof withVendorTag).toBe("function");
    const tagged = vendorRequestCount("d6a"), before = vendor.requests.length;
    await withVendorTag("d6a", () => service.refreshOne(id));
    const made = vendor.requests.slice(before);
    expect(made.map(r => `${r.method} ${r.path}`)).toEqual([`GET /call/${vendorId}`]);
    expect(vendorRequestCount("d6a") - tagged).toBe(1);
    expect(service._row(id)!.status).toBe("ended");
    expect(isFinal(service._row(id)!)).toBe(false);
    vendor.calls.set(vendorId, { ...vendor.calls.get(vendorId)!, analysis: { structuredData: { outcome: "not_done" } } });
    await withVendorTag("d6a", () => service.refreshOne(id));
    expect(isFinal(service._row(id)!)).toBe(true);
    // A final call is not read again.
    const settled = vendorRequestCount("d6a");
    await withVendorTag("d6a", () => service.refreshOne(id));
    expect(vendorRequestCount("d6a")).toBe(settled);
  } finally { await vendor.close(); }
});
