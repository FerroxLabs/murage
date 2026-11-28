// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// D5 P14, P14b, P14c (I8): the call language is the owner's fixed language, then the bot's, then the number's country, then the app
// language, then English; the result is always supported and always has a shipped opening. Loopback vendor, real adapter.
import { afterEach, expect, it } from "vitest";
import { MemoryCallStore } from "./memory-store.ts";
import { _resetPhoneSecretsForTest, PHONE_KEY_ORIGIN, setPhoneKeyFromShell } from "./phone-secrets.ts";
import { PhoneCallService } from "./service.ts";
import { defaultSettings, RevisionStore, SHIPPED_AI_LINE, SHIPPED_NOTICE, type PhoneCallSettings } from "./settings.ts";
import { CALL_LANGUAGES } from "./tables.ts";
import { startFakeVapi } from "./testing/fake-vapi-server.ts";
import { VapiAdapter, type FetchLike } from "./vapi-adapter.ts";

afterEach(() => _resetPhoneSecretsForTest());

type Vendor = Awaited<ReturnType<typeof startFakeVapi>>;
const OWNER = "Sam";
const shipped = (language: string) => {
  const ai = (SHIPPED_AI_LINE as Record<string, string | undefined>)[language];
  const notice = (SHIPPED_NOTICE as Record<string, string | undefined>)[language];
  return ai && notice ? `${ai.split("{owner}").join(OWNER)} ${notice}` : undefined;
};

/** A real adapter whose account supports fewer languages. */
function narrowAdapter(fetchImpl: FetchLike, supported: readonly string[]): VapiAdapter {
  return Object.defineProperty(new VapiAdapter(fetchImpl), "supportedLanguages", { value: supported });
}

async function withService(settings: Partial<PhoneCallSettings>, appLanguage: string, run: (service: PhoneCallService, vendor: Vendor) => Promise<void>, supported?: readonly string[]) {
  const vendor = await startFakeVapi();
  try {
    setPhoneKeyFromShell({ key: "fixture", origin: PHONE_KEY_ORIGIN });
    const adapter = supported ? narrowAdapter(vendor.fetchImpl, supported) : new VapiAdapter(vendor.fetchImpl);
    const service = new PhoneCallService(adapter, new RevisionStore(), () => appLanguage, () => {}, new MemoryCallStore());
    await service.saveSettings({ ...defaultSettings("number-1", OWNER), ...settings });
    await run(service, vendor);
  } finally { await vendor.close(); }
}

async function placed(service: PhoneCallService, vendor: Vendor, args: Record<string, unknown>) {
  const before = vendor.requests.length;
  const outcome = await service.place({ goal: "Ask about opening hours", ...args });
  expect(outcome.ok).toBe(true);
  const create = vendor.requests.slice(before).find(r => r.method === "POST" && r.path === "/call");
  const overrides = create?.body?.assistantOverrides as Record<string, unknown>;
  return { language: outcome.ok ? outcome.value.language : undefined, firstMessage: overrides.firstMessage };
}

it("P14 owner, then bot, then country, then app language", async () => {
  // Fixed owner language beats the bot's wish and the number's country.
  await withService({ language: "de" }, "fr", async (service, vendor) => {
    expect(await placed(service, vendor, { to: "+33142000001", language: "es" })).toEqual({ language: "de", firstMessage: shipped("de") });
  });
  await withService({}, "fr", async (service, vendor) => {
    // Auto with a supported bot language.
    expect(await placed(service, vendor, { to: "+4930100001", language: "es" })).toEqual({ language: "es", firstMessage: shipped("es") });
    // Auto with a German number and no bot language: the country's language.
    expect(await placed(service, vendor, { to: "+4930100002" })).toEqual({ language: "de", firstMessage: shipped("de") });
    // Multilingual countries are not guessed: Swiss, Belgian and Indian numbers use the app language.
    for (const to of ["+41441000001", "+3221000001", "+911100000001"]) {
      expect(await placed(service, vendor, { to })).toEqual({ language: "fr", firstMessage: shipped("fr") });
    }
  });
  // Auto with nothing supported: an unsupported bot wish, a country with no language, the app language.
  await withService({}, "ja", async (service, vendor) => {
    expect(await placed(service, vendor, { to: "+255221000001", language: "sw" })).toEqual({ language: "ja", firstMessage: shipped("ja") });
  });
});

// Joint F3+F4: the Italian opening is F4 copy. Until shipped-lines.ts carries it, an Italian number never opens in English
// under an Italian label; resolution falls through (P14b closure case below).
it.skipIf(shipped("it") === undefined)("P14 an Italian number opens in Italian", async () => {
  await withService({}, "fr", async (service, vendor) => {
    expect(await placed(service, vendor, { to: "+390610000001" })).toEqual({ language: "it", firstMessage: shipped("it") });
  });
});

it("P14b every call language opens in that language, or is never used without its own opening", async () => {
  for (const language of CALL_LANGUAGES) {
    await withService({ language }, "en", async (service, vendor) => {
      const call = await placed(service, vendor, { to: "+12025550101" });
      const line = shipped(language);
      if (line === undefined) {
        // I8 closure: a language with no shipped opening is never resolved, so no call opens in English under its label.
        expect(call.language).not.toBe(language);
        expect(call.firstMessage).toBe(shipped(String(call.language)));
        return;
      }
      expect(call).toEqual({ language, firstMessage: line });
      if (language !== "en") {
        // Each half is that language's own text, not the English pair (the frozen native-reviewed copy is F4's fixtures/call-lines.ts).
        const ai = (SHIPPED_AI_LINE as Record<string, string>)[language]!, notice = (SHIPPED_NOTICE as Record<string, string>)[language]!;
        expect(ai).not.toBe(SHIPPED_AI_LINE.en);
        expect(notice).not.toBe(SHIPPED_NOTICE.en);
        expect(ai).toContain("{owner}");
      }
    });
  }
});

it("P14c an unsupported wish falls back to a supported language and the card says so", async () => {
  await withService({}, "ja", async (service, vendor) => {
    const card = service.askPreview({ to: "+255221000001", goal: "Ask about opening hours", language: "sw" });
    expect(card).toMatchObject({ language: "en", languageFallback: { wanted: "sw", language: "en" } });
    const call = await placed(service, vendor, { to: "+255221000001", language: "sw" });
    expect(call).toEqual({ language: "en", firstMessage: shipped("en") });
    // A supported wish shows no fallback line.
    expect(service.askPreview({ to: "+4930100001", goal: "Ask about opening hours", language: "de" })).not.toHaveProperty("languageFallback");
  }, ["en", "de"]);
});
