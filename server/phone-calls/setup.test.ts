// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 P25: setup only reads the owner's numbers, never dials, and needs a number the owner can call out from.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

async function setup(numbers: unknown[]) {
  const vendor = await startFakeVapi({ numbers });
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", () => {}, new MemoryCallStore());
    const answer = await service.numbers();
    expect(vendor.requests.every(r => r.method === "GET")).toBe(true);
    expect(vendor.requests.length).toBeGreaterThan(0);
    expect(vendor.creates).toBe(0);
    return answer;
  } finally { await vendor.close(); }
}

it("P25 setup never dials and needs the owner's number", async () => {
  expect(await setup([])).toEqual({ numbers: [], line: "phoneCalls.setup.noNumber" });
  // A free inbound-only number cannot call out, so it does not count.
  expect(await setup([{ id: "number-free", number: "+12025550111", provider: "vapi" }])).toMatchObject({ line: "phoneCalls.setup.noNumber" });
  expect(await setup([{ id: "number-1", number: "+12025550100", provider: "twilio" }]))
    .toEqual({ numbers: [{ id: "number-1", number: "+12025550100", canCallOut: true }] });
});
