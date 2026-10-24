// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { setLocale, t } from "./i18n";
import { usageCaption } from "./usage-card";

afterEach(() => setLocale("en"));

const KEYS = [
  "usageCard.title", "usageCard.allBots", "usageCard.colTurns", "usageCard.colCost",
  "usageCard.unknown", "usageCard.unpriced", "usageCard.empty",
] as const;

describe("the bot usage card follows the app language", () => {
  it("reads in English by default", () => {
    expect(t("usageCard.title")).toBe("Usage");
    expect(usageCaption("metered")).toBe("counted on your API key");
    expect(usageCaption(undefined)).toBe("as reported by the engine");
  });

  for (const locale of ["ja", "de"] as const) {
    it(`has no English left under ${locale}`, async () => {
      await setLocale(locale);
      for (const key of KEYS) expect(t(key), key).not.toBe(readEnglish(key));
      for (const billing of ["subscription", "metered", undefined] as const) {
        expect(usageCaption(billing)).not.toMatch(/counted on your|as reported by|covered by your/);
      }
      expect(t("usageCard.costLine", { caption: "X" })).toContain("X");
    });
  }

  it("the card source holds no English literal for its labels", () => {
    const panel = readFileSync(new URL("../components/SettingsPanel.tsx", import.meta.url), "utf8");
    const card = panel.slice(panel.indexOf("function BotUsageCard("), panel.indexOf("const inputCls"));
    for (const literal of [">Turns<", ">Tokens<", ">Cost<", '"Unknown"', "All bots", "Tokens are still counted"]) {
      expect(card).not.toContain(literal);
    }
    expect(panel).toContain('t("usageCard.empty")');
  });
});

function readEnglish(key: string): string {
  const en = JSON.parse(readFileSync(new URL("../locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
  return en[key]!;
}
