// SPDX-License-Identifier: AGPL-3.0-or-later
// Opus gate 0.1.62-A: the "macOS Dictation is off" note (upstream #2033) is
// shown in the composer and on calls, so it ships in every language pack and
// follows the chosen language instead of being an English literal.
import { afterEach, expect, it } from "vitest";
import { en, type LocaleKey } from "@/locales";
import { allLocalePacks } from "@/locales/testing";
import { micEndStep } from "./call-turns";
import { dictationDisabledNote } from "./dictation-notes";
import { setLocale } from "./i18n";

const KEY = "dictation.disabled" as LocaleKey;
afterEach(() => setLocale("en"));
const packs = await allLocalePacks();

it("ships the Dictation-off note in all eight languages, within the copy rules", () => {
  expect(en[KEY]).toBe("Turn on Dictation in System Settings → Keyboard, then try again.");
  for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    const value = packs[code]?.[KEY];
    expect(value, code).toBeTypeOf("string");
    expect(value?.trim(), code).toBeTruthy();
    expect(value, code).not.toMatch(/[—–]/);
  }
});

it("the composer and call note follows the chosen language", async () => {
  const base = { code: 1, hostOn: true, phase: "listening" as const, heard: false, sinceRestartMs: 10_000 };
  for (const code of ["de", "ja"]) {
    await setLocale(code);
    expect(dictationDisabledNote()).toBe(packs[code]![KEY]);
    expect(micEndStep({ ...base, reason: "dictation-disabled" }).note).toBe(packs[code]![KEY]);
  }
});
