// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 P18 (service and body half; the owner-route half is F5): recording is off and the time cap is sent on every assistant and call.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { parseOwnerSettings } from "./owner-routes.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

it("P18 recording off and time cap sent", async () => {
  const vendor = await startFakeVapi();
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    const placed = await service.place({ to: "+12025550101", goal: "Ask about opening hours" });
    const call = String(placed.ok && placed.value.call);
    const assistant = vendor.requests.find(r => r.method === "POST" && r.path === "/assistant")!.body!;
    const create = vendor.requests.find(r => r.method === "POST" && r.path === "/call")!.body!;
    const overrides = create.assistantOverrides as Record<string, unknown>;
    for (const body of [assistant, overrides]) {
      expect(body.artifactPlan).toEqual({ recordingEnabled: false });
      expect(body.maxDurationSeconds).toBe(300);
    }
    // The card shows the vendor's cost.
    const fake = vendor.calls.get("fixture-call-1")!;
    vendor.calls.set(fake.id, { ...fake, status: "ended", cost: 0.37 });
    await service.result({ call });
    expect(service.ownerCard(call)).toMatchObject({ cost: { amount: 0.37, currency: "USD" } });
  } finally { await vendor.close(); }
  // Out-of-range caps never reach a revision (route parser, shared with F5).
  const base = { ...defaultSettings("number-1", "Sam") };
  for (const maxSeconds of [29, 3601]) expect(parseOwnerSettings({ ...base, maxSeconds })).toBeNull();
  expect(parseOwnerSettings({ ...base, maxSeconds: 300 })).toMatchObject({ maxSeconds: 300, recordAudio: false });
});
