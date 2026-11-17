// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings and the model picker's dialog keep their words out of the first
// paint (SETTINGS-ENGINES-1019 section 8.1, slice P). Every new Settings or
// picker string goes in src/locales/en-settings/, which only
// src/lib/settings-copy.ts imports, and settings-copy.ts is imported only by
// the Settings chunk (SettingsModal.tsx) and the picker dialog
// (ModelPickerDialog.tsx). Both are lazy (first-paint.test.ts), so en.json,
// which ships with the first paint, does not grow when Settings gains words.
// The other seven languages keep their translations in their own packs, which
// already load on choice: the translator's tool reads en-settings as English.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import enCatalogue from "@/locales/en.json";

const src = fileURLToPath(new URL("..", import.meta.url));
const packDir = join(src, "locales/en-settings");
const sources: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { if (name !== "node_modules") walk(full); }
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(full);
  }
};
walk(src);
const importersOf = (pattern: RegExp) => sources.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => relative(src, file).split(sep).join("/")).sort();
const packFiles = readdirSync(packDir).filter((name) => name.endsWith(".json")).sort();
const pack = (name: string) => JSON.parse(readFileSync(join(packDir, name), "utf8")) as Record<string, unknown>;
// settings.stub.* predates the lazy pack (1.0.17); these stay where they are and none is added.
const SHIPPED_STUB_KEYS = 17;

describe("the lazy English Settings pack", () => {
  it("holds a settings file and a picker file", () => {
    expect(packFiles).toEqual(["picker.json", "settings.json"]);
  });

  it("is imported by settings-copy.ts alone", () => {
    expect(importersOf(/["'][^"']*en-settings\/[^"']*\.json["']/)).toEqual(["lib/settings-copy.ts"]);
  });

  it("is reached only through the Settings chunk and the picker dialog", () => {
    expect(importersOf(/(?:from|import)\s*\(?\s*["'][^"']*\bsettings-copy(?:\.ts)?["']/)).toEqual(["components/ModelPickerDialog.tsx", "components/SettingsModal.tsx", "components/settings/rows/BotRows.tsx", "components/settings/rows/GeneralRows.tsx"]);
  });

  it("holds only strings, none of them a key en.json already has", () => {
    for (const name of packFiles) {
      for (const [key, value] of Object.entries(pack(name))) {
        expect(typeof value, `${name}:${key}`).toBe("string");
        expect(Object.hasOwn(enCatalogue, key), `${name}:${key} is already in en.json`).toBe(false);
      }
    }
    const keys = packFiles.flatMap((name) => Object.keys(pack(name)));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("joins the English pack when Settings loads, without changing a string it already has", async () => {
    // The shipped packs may be empty, so the merge is proven on one probe string per file.
    vi.doMock("@/locales/en-settings/settings.json", () => ({ default: { "settings.p.probe": "Settings probe" } }));
    vi.doMock("@/locales/en-settings/picker.json", () => ({ default: { "picker.p.probe": "Picker probe" } }));
    const { en } = await import("@/locales");
    const words = en as Record<string, string>;
    const before = { ...en };
    expect(words["settings.p.probe"]).toBeUndefined();
    await import("@/lib/settings-copy");
    expect(words["settings.p.probe"]).toBe("Settings probe");
    expect(words["picker.p.probe"]).toBe("Picker probe");
    for (const [key, value] of Object.entries(before)) expect(words[key]).toBe(value);
    vi.doUnmock("@/locales/en-settings/settings.json");
    vi.doUnmock("@/locales/en-settings/picker.json");
  });

  it("reads through t(): a language pack's translation wins, and English fills every key it lacks", async () => {
    // A fresh registry and i18n, so this proves the merge t() actually reads, not the earlier test's import.
    vi.resetModules();
    vi.doMock("@/locales/en-settings/settings.json", () => ({ default: { "settings.p.probe": "Settings probe" } }));
    vi.doMock("@/locales/en-settings/picker.json", () => ({ default: { "picker.p.probe": "Picker probe" } }));
    const locales = await import("@/locales");
    const i18n = await import("@/lib/i18n");
    await import("@/lib/settings-copy");
    const tr = i18n.t as unknown as (key: string) => string;
    const shipped = Object.keys(enCatalogue)[0] as keyof typeof enCatalogue;
    // A partial test language: it translates the Settings probe only.
    locales.localeLoaders.xx = async () => ({ "settings.p.probe": "Sonde des réglages" }) as never;
    try {
      expect(await i18n.setLocale("xx")).toBe("xx");
      expect(tr("settings.p.probe")).toBe("Sonde des réglages");
      expect(tr("picker.p.probe")).toBe("Picker probe");
      expect(tr(shipped)).toBe(enCatalogue[shipped]);
      expect(await i18n.setLocale("en")).toBe("en");
      expect(tr("settings.p.probe")).toBe("Settings probe");
      expect(tr("picker.p.probe")).toBe("Picker probe");
    } finally {
      delete locales.localeLoaders.xx;
      await i18n.setLocale("en");
      vi.doUnmock("@/locales/en-settings/settings.json");
      vi.doUnmock("@/locales/en-settings/picker.json");
    }
  });

  it("keeps the first-paint catalogue free of new Settings engine, picker and stub words", () => {
    const keys = Object.keys(enCatalogue);
    expect(keys.filter((key) => key.startsWith("settings.engines.") || key.startsWith("picker."))).toEqual([]);
    expect(keys.filter((key) => key.startsWith("settings.stub."))).toHaveLength(SHIPPED_STUB_KEYS);
  });
  // The translator's side (the other seven packs may carry these keys) is in scripts/generate-locale.test.mjs.
});
