// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { afterEach, beforeEach, expect, it } from "vitest";
import { _resetPhoneSecretsForTest, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { forgetAllPhoneTurns, recordPhoneTurn } from "./phone-turns.ts";
import { PhoneCallService, phoneMount, servePhoneTool } from "./service.ts";
import { defaultSettings, RevisionStore } from "./settings.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter } from "./vapi-adapter.ts";

let vendor: Awaited<ReturnType<typeof startFakeVapi>>;
let service: PhoneCallService;
const allowed = new Set<string>();
const deps = { botMayPhone: (botId: string) => allowed.has(botId) };
const claim = { botId: "fixture-a", threadId: "fixture-thread", generation: "fixture-generation" };
const args = { to: "+12025550142", goal: "Check opening hours" };

beforeEach(async () => {
  setPhoneKeyFromShell({ key: "fixture", origin: "https://api.vapi.ai" });
  vendor = await startFakeVapi();
  service = new PhoneCallService(new VapiAdapter(vendor.fetchImpl), new RevisionStore(), () => "en");
  await service.saveSettings(defaultSettings("number-1", "Fixture"));
  vendor.requests.length = 0;
});

afterEach(async () => {
  allowed.clear();
  forgetAllPhoneTurns();
  _resetPhoneSecretsForTest();
  await vendor?.close();
});

// F2 owns the stored per-bot choice. This fixture supplies the live setting to F1's real admission path.
it("P4 checks the bot's setting at mount and again inside a running turn", async () => {
  allowed.add(claim.botId);
  const mount = (botId: string) => phoneMount({ agentsMcp: true, ownerAudience: true, botAllowed: deps.botMayPhone(botId) });
  expect(mount(claim.botId)).toEqual({ mounted: true });
  expect(mount("fixture-b")).toEqual({ mounted: false, line: "This bot isn't allowed to phone businesses. Change it in Settings > Connected apps > Phone calls." });
  recordPhoneTurn(claim.generation, claim);
  expect(await servePhoneTool(() => service, "phone_call_place", claim, args, deps)).toMatchObject({ call: expect.any(String) });

  allowed.delete(claim.botId);
  expect(await servePhoneTool(() => service, "phone_call_place", claim, args, deps)).toMatchObject({ error: "not_set_up" });
  expect(await servePhoneTool(() => service, "phone_call_result", claim, { call: "fixture-missing" }, deps)).toMatchObject({ error: "not_set_up" });
  expect(vendor.creates).toBe(1);
});

it("P4c fails closed on a generation without a bot id", async () => {
  const { threadId, generation } = claim;
  const malformed = { threadId, generation };
  recordPhoneTurn(generation, malformed as typeof claim);
  const unchecked = { botMayPhone: () => true };
  expect(await servePhoneTool(() => service, "phone_call_place", malformed, args, unchecked)).toMatchObject({ error: "not_set_up" });
  expect(vendor.requests).toHaveLength(0);
});
