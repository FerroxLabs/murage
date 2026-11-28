// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, beforeEach, expect, it } from "vitest";
import { bindServiceTurn, serviceNoLimits } from "../service-no-limits.ts";
import { _resetPhoneSecretsForTest, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { forgetAllPhoneTurns, recordPhoneTurn } from "./phone-turns.ts";
import { PhoneCallService, servePhoneTool } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

const claim = { botId: "fixture-bot", threadId: "fixture-thread", generation: "fixture-generation" };
let vendor: Awaited<ReturnType<typeof startFakeVapi>>;
let service: PhoneCallService;
let active: boolean;

beforeEach(async () => {
  setPhoneKeyFromShell({ key: "fixture", origin: "https://api.vapi.ai" });
  vendor = await startFakeVapi();
  service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en");
  await service.saveSettings(defaultSettings("number-1", "Fixture"));
  vendor.requests.length = 0;
  active = true;
  recordPhoneTurn(claim.generation, claim);
});

afterEach(async () => {
  active = false;
  forgetAllPhoneTurns();
  _resetPhoneSecretsForTest();
  await vendor?.close();
});

const place = (to: string) => servePhoneTool(() => service, "phone_call_place", claim, { to, goal: "Check opening hours" }, { botMayPhone: () => true });

it.each([false, true])("P5 refuses emergency, short and unknown destinations (No limits %s)", async noLimits => {
  bindServiceTurn(claim.generation, claim.threadId, claim.botId, () => active, () => ({
    ownerAudience: true, origin: "owner", noLimits,
  }));
  expect(serviceNoLimits(claim.generation, claim.threadId, claim.botId)).toBe(noLimits);
  const destinations = ["+19115550142", "+12115550142", "+49116000", "+44123456", "+999123456"];
  for (const to of destinations) expect(await place(to), to).toEqual({ error: "number_not_allowed" });
  expect(vendor.requests).toHaveLength(0);
  expect(await place("+12025550142")).toMatchObject({ call: expect.any(String) });
  expect(vendor.creates).toBe(1);
});

it("P5b refuses numbers outside the E.164 shape", async () => {
  const destinations = ["+1911", "+44999", "+33112", "911", "+441234", "+4412345678901234", "+1202555abcd",
    "tel:+12025550142", "sip:+12025550142"];
  for (const to of destinations) expect(await place(to), to).toEqual({ error: "vendor_refused" });
  expect(vendor.requests).toHaveLength(0);
});

it("P5c permits ordinary businesses with short-service prefixes", async () => {
  const destinations = ["+911123456789", "+551932345678", "+33112345678"];
  for (const to of destinations) expect(await place(to)).toMatchObject({ call: expect.any(String) });
  expect(vendor.creates).toBe(destinations.length);
  expect(vendor.requests.filter(r => r.path === "/call").map(r => r.body?.customer)).toEqual(destinations.map(number => ({ number })));
});
