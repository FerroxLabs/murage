// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dates and numbers follow the app language with an Intl tag (both Portuguese keys
// format as pt-BR), while the voice cue cache and the send-key default stay keyed by
// the registry code, so a Portuguese owner's cached clips and Enter behaviour do not move.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { languageCode, localeCode, resolveLocale, setLocale } from "./i18n";
import { currentSendKey } from "./send-key";
import { localeCodes } from "@/locales";

afterEach(() => setLocale("en"));

const src = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("Intl tag for the app language", () => {
  it("formats bare Portuguese as pt-BR and keeps the cache key", async () => {
    expect(await setLocale("pt")).toBe("pt");
    expect(localeCode()).toBe("pt-BR");
    expect(languageCode()).toBe("pt");
    expect(await setLocale("pt-PT")).toBe("pt");
    expect(localeCode()).toBe("pt-BR");
    expect(await setLocale("pt-BR")).toBe("pt-br");
    expect(localeCode()).toBe("pt-BR");
    expect(languageCode()).toBe("pt-br");
  });

  it("leaves every other language's tag and key as the registry code", async () => {
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "zh"]) {
      await setLocale(code);
      expect(localeCode()).toBe(code);
      expect(languageCode()).toBe(code);
    }
  });

  it("reads a POSIX-style pt_BR choice as pt-BR, not English", async () => {
    expect(resolveLocale("pt_BR", localeCodes())).toBe("pt-br");
    expect(resolveLocale("de_AT", localeCodes())).toBe("de");
    expect(await setLocale("pt_BR")).toBe("pt-br");
    expect(localeCode()).toBe("pt-BR");
  });
});

describe("cache and default keys stay on the registry code", () => {
  it("keeps the Japanese send-key default", async () => {
    await setLocale("ja");
    expect(currentSendKey()).toBe("mod-enter");
    await setLocale("pt");
    expect(currentSendKey()).toBe("enter");
  });

  it("keys voice cue clips and the send key by languageCode, never the Intl tag", () => {
    for (const file of ["../components/CallView.tsx", "../components/GroupCallView.tsx"]) {
      const source = src(file);
      expect(source).toMatch(/cueCache\.(get|put|prewarm)\(\{[^}]*locale: languageCode\(\)/);
      expect(source).not.toMatch(/locale: localeCode\(\)/);
    }
    expect(src("./send-key.ts")).toContain("resolveSendKey(storage(), languageCode())");
  });
});
