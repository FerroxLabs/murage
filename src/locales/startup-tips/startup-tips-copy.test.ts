// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice B, B9: copy lint over every tip string in all 8 languages (no em dash, no banned words), plus the shape the
// splash needs. The tips live in their own folder (the splash and the picture writer read them; they are not part of the main
// catalogue partitions), so this test is their gate, and it runs the shipped lint engine's own rules over them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ruleIds } from "../../../scripts/copy-lint.mjs";
import { STARTUP_TIP_IDS, tipText } from "../../lib/startup-tips";
import { loadTipStrings } from ".";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const CODES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
const read = (code: string) => JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
const en = read("en");
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();

const FORMAL: Record<string, RegExp> = {
  de: /(?<![\p{L}])(Sie|Ihnen|Ihr\p{L}*)(?![\p{L}])/u,
  fr: /(?<![\p{L}])(vous|votre|vos|veuillez|dites|faites)(?![\p{L}])|(?<![\p{L}])(?!(?:chez|assez|nez|rez)(?![\p{L}]))\p{L}+ez(?![\p{L}])/iu,
};
const BANNED = /—|\s[–−]\s|\b(?:safe|safely|safety|unsafe|free|Forge)\b|सुरक्षित|सुरक्षा/iu;

describe("B9 the tip packs", () => {
  it("ships exactly eight packs, English first", () => {
    expect(readdirSync(DIR).filter((file) => file.endsWith(".json")).sort()).toEqual([...CODES].map((code) => `${code}.json`).sort());
  });

  it("holds the 12 tips and no more: head, line and try each, plus the surfaces and the two fallbacks", () => {
    const expected = [
      ...STARTUP_TIP_IDS.flatMap((id) => [`${id}.head`, `${id}.line`, `${id}.try`]),
      "surfaces.mac", "surfaces.win", "surfaces.other", "fallback.chief", "fallback.mate",
    ];
    expect(Object.keys(en).sort()).toEqual([...expected].sort());
  });

  for (const code of CODES) {
    describe(code, () => {
      const pack = read(code);

      it("has every key of the English pack, nothing extra, nothing empty", () => {
        expect(Object.keys(pack).sort()).toEqual(Object.keys(en).sort());
        expect(Object.entries(pack).filter(([, value]) => typeof value !== "string" || value.trim() === "")).toEqual([]);
      });

      it("keeps every placeholder of the English string, and invents none", () => {
        const wrong = Object.keys(en).filter((key) => placeholders(pack[key]).join() !== placeholders(en[key]).join());
        expect(wrong).toEqual([]);
      });

      it("follows the copy rules: no em dash, none of the banned words, informal address, the shipped lint engine's rules", () => {
        const found: string[] = [];
        for (const [key, value] of Object.entries(pack)) {
          if (BANNED.test(value)) found.push(`${key}: banned: ${value}`);
          if (FORMAL[code]?.test(value)) found.push(`${key}: formal address: ${value}`);
          for (const id of ruleIds({ locale: code, value }, { english: en[key], sameOk: code === "en" })) found.push(`${key}: ${id}: ${value}`);
        }
        expect(found).toEqual([]);
      });

      it("is not the English copied (every tip is translated)", () => {
        if (code === "en") return;
        const copied = Object.keys(en).filter((key) => pack[key] === en[key]);
        expect(copied).toEqual([]);
      });

      it("fits the splash with the longest names: 21-character names, every tip, every OS", async () => {
        const strings = await loadTipStrings(code);
        const name = "N".repeat(40);
        for (const os of ["mac", "win", "other"] as const) {
          for (const id of STARTUP_TIP_IDS) {
            const tip = tipText(id, { chief: name, mates: [name, name], os, phoneAvailable: true }, strings);
            expect(tip.head.length, `${id} head`).toBeLessThanOrEqual(120);
            expect(tip.line.length, `${id} line`).toBeLessThanOrEqual(240);
            expect(tip.try.length, `${id} try`).toBeLessThanOrEqual(160);
            expect(`${tip.head}${tip.line}${tip.try}`).not.toMatch(/[{}]/);
          }
        }
      });
    });
  }

  it("loads a language through the loader, falls back to English per key, and answers pt as pt-br", async () => {
    expect((await loadTipStrings("de"))["search.head"]).toBe(read("de")["search.head"]);
    expect((await loadTipStrings("pt"))["search.head"]).toBe(read("pt-br")["search.head"]);
    expect((await loadTipStrings("xx"))["search.head"]).toBe(en["search.head"]);
    expect((await loadTipStrings("en"))["search.head"]).toBe(en["search.head"]);
  });
});
