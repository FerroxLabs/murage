// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 P19, P19b: no monitoring, no live link, no webhook. The vendor's monitor URLs never pass the adapter's projection.
import { afterEach, expect, it } from "vitest";
import { GET_CALL_RESPONSE } from "./fixtures/vapi-pinned.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { engineResult, PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter, vapiCallBody, verifyCallBody } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

const SENTINELS = ["LISTEN-SECRET", "CONTROL-SECRET", "listenUrl", "controlUrl"];

it("P19 no monitoring, no live link, no webhook", async () => {
  const logs: string[] = [];
  const vendor = await startFakeVapi();
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en", line => logs.push(JSON.stringify(line)), new MemoryCallStore());
    await service.saveSettings(defaultSettings("number-1", "Sam"));
    const placed = await service.place({ to: "+12025550101", goal: "Ask about opening hours" });
    const call = String(placed.ok && placed.value.call);
    // The create response carried the monitor sentinels; the read does too.
    const fake = vendor.calls.get("fixture-call-1")!;
    expect(JSON.stringify(fake)).toContain("LISTEN-SECRET");
    vendor.calls.set(fake.id, { ...GET_CALL_RESPONSE, id: fake.id, name: fake.name, createdAt: fake.createdAt });
    const read = await service.result({ call });
    const assistant = vendor.requests.find(r => r.method === "POST" && r.path === "/assistant")!.body!;
    const create = vendor.requests.find(r => r.method === "POST" && r.path === "/call")!.body!;
    const overrides = create.assistantOverrides as Record<string, unknown>;
    for (const body of [assistant, overrides]) {
      expect(body.monitorPlan).toEqual({ listenEnabled: false, controlEnabled: false });
      expect(body).not.toHaveProperty("server");
    }
    expect(create).not.toHaveProperty("server");
    // The adapter boundary itself: what the real adapter hands the service holds no monitor link or unknown vendor field.
    const adapter = new VapiAdapter(vendor.fetchImpl);
    const projected = JSON.stringify(await adapter.result(fake.id));
    for (const sentinel of [...SENTINELS, "UNKNOWN-SECRET", "org-secret-1"]) expect(projected).not.toContain(sentinel);
    const card = service.ownerCard(call)!;
    const seen = JSON.stringify([placed, read, service._row(call), card, engineResult(service._row(call)!), service.recentOwnerCards(), logs]);
    for (const sentinel of SENTINELS) expect(seen).not.toContain(sentinel);
    // The card's only link is the dashboard record.
    expect(seen.match(/(wss?|https?):\/\/[^"\\]+/g)).toEqual([card.dashboard, card.dashboard]);
    expect(card.dashboard).toBe(`https://dashboard.vapi.ai/calls/${fake.id}`);
  } finally { await vendor.close(); }
});

it("P19b a call body without monitoring off is refused before sending", () => {
  const revision = { number: 1, settings: defaultSettings("number-1", "Sam"), assistantId: "assistant-1", state: "active" as const };
  const request = { to: "+12025550101", goal: "Ask about opening hours", details: "", limits: "", language: "en" };
  const body = vapiCallBody(request, revision);
  expect(() => verifyCallBody(body, request, revision)).not.toThrow();
  const overrides = { ...(body.assistantOverrides as Record<string, unknown>) };
  delete overrides.monitorPlan;
  expect(() => verifyCallBody({ ...body, assistantOverrides: overrides }, request, revision)).toThrow("vendor_refused");
  // VapiAdapter.start runs this check before its only fetch, so a refused body makes 0 vendor requests.
  for (const monitorPlan of [{ listenEnabled: true, controlEnabled: false }, { listenEnabled: false, controlEnabled: true }]) {
    expect(() => verifyCallBody({ ...body, assistantOverrides: { ...overrides, monitorPlan } }, request, revision)).toThrow("vendor_refused");
  }
});
