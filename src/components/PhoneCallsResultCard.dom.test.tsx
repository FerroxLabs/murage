// @vitest-environment jsdom
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 slice F4 (design 1023-phone-fslices 3.4, P15): the result card names the call language, shows the language fallback line only
// when the owner's wish was unsupported, and tells the booking and the plain result lines in the app language, 8 locales.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/state/store", () => ({ api: {}, useStore: () => ({ state: { bots: [] }, dispatch: vi.fn() }) }));
import { ResultCard } from "./PhoneCallsSettings";
import en from "@/locales/lazy/phone-calls/en.json";
import { PHONE_PACK_LOADERS, phoneText, type PhoneCallCard, type PhoneCopy } from "@/lib/phone-calls";

const base = { id: "c-1", status: "ended", to: "+15550123456", language: "de", dashboard: "https://dashboard.vapi.ai/calls/v" } as PhoneCallCard;
const localeCopy = async (code: string): Promise<PhoneCopy> => {
  const pack = code === "en" ? {} : await PHONE_PACK_LOADERS[code]!();
  return (key, params) => phoneText(pack, key, params);
};
const html = (copy: PhoneCopy, card: Partial<PhoneCallCard>) => renderToStaticMarkup(createElement(ResultCard, { copy, card: { ...base, ...card } }));
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const CODES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];

describe("P15 the card names the language, any fallback and the booking", () => {
  it("names the resolved language and shows the fallback line only when a wish was unsupported", async () => {
    for (const code of CODES) {
      const copy = await localeCopy(code);
      const plain = decode(html(copy, {}));
      expect(plain, `${code} language`).toContain(copy("phoneCalls.card.language", { language: "German" }));
      expect(plain, `${code} no fallback`).not.toContain('data-testid="phone-language-fallback"');
      const fallback = decode(html(copy, { languageFallback: { wanted: "sw", language: "de" } }));
      expect(fallback, `${code} fallback`).toContain('data-testid="phone-language-fallback"');
      expect(fallback, `${code} fallback text`).toContain(copy("phoneCalls.card.languageFallback", { wanted: "Swahili", language: "German" }));
    }
  });
  it("tells the booking and the result reason in the app language, never a raw key and never English outside en", async () => {
    const cases: [Partial<PhoneCallCard>, string][] = [
      [{ bookingState: "booked" }, "phoneCalls.booking.booked"],
      [{ bookingState: "cancelling" }, "phoneCalls.booking.cancelling"],
      [{ bookingState: "cancelled" }, "phoneCalls.booking.cancelled"],
      [{ bookingState: "unclear" }, "phoneCalls.booking.unclear"],
      [{ reason: "already_started" }, "phoneCalls.result.alreadyStarted"],
      [{ reason: "unclear" }, "phoneCalls.result.unclear"],
      [{ reason: "phone_menu" }, "phoneCalls.result.phoneMenu"],
      [{ reason: "unpageable" }, "phoneCalls.result.unpageable"],
    ];
    for (const code of CODES) {
      const copy = await localeCopy(code);
      for (const [card, key] of cases) {
        const plain = decode(html(copy, card));
        const line = copy(key as keyof typeof en);
        expect(plain, `${code} ${key}`).toContain(line);
        expect(plain, `${code} ${key} raw`).not.toMatch(/phoneCalls\./);
        if (code !== "en") expect(line, `${code} ${key} English`).not.toBe((en as Record<string, string>)[key]);
      }
    }
  });
});
