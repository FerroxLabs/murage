import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Copy rules for every shipped language pack:
// - German and French address the reader informally (du, tu), never formally.
// - No em dash and no spaced en dash used as a dash (ranges such as 1–9 are fine).
// - No "safe" wording (safe, safely, safety, unsafe, and the Hindi equivalent).

const LOCALES_DIR = fileURLToPath(new URL(".", import.meta.url));

function load(code: string): Record<string, string> {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), "utf8")) as Record<string, string>;
}

const codes = readdirSync(LOCALES_DIR)
  .filter((file) => file.endsWith(".json") && file !== "source-hashes.json")
  .map((file) => file.slice(0, -".json".length))
  .sort();

const FORMAL: Record<string, RegExp> = {
  de: /(?<![\p{L}])(Sie|Ihnen|Ihr\p{L}*)(?![\p{L}])/u,
  fr: /(?<![\p{L}])(vous|votre|vos|veuillez)(?![\p{L}])/iu,
};

// Reviewed exceptions, keyed "locale:key". Keep this list tiny and justify each entry.
// All five are German "Sie" meaning "she/it/they" at the start of a sentence.
const FORMAL_ALLOWLIST = new Set<string>([
  "de:markdownEditor.saveError.tooLarge",
  "de:hostStop.midDesktopAction",
  "de:settings.connections.moved",
  "de:settings.pageNote.experimental",
  "de:phone.lan.on",
  "de:importGuard.scanNote",
  "de:learningScreen.why.outbound",
]);

const DASH = /—|\s[–−]\s/u;
const SAFE = /(?<![\p{L}])(safe|safely|safety|unsafe)(?![\p{L}])|सुरक्षित|सुरक्षा/iu;

describe("locale copy rules", () => {
  it("finds the shipped locale packs", () => {
    expect(codes).toEqual(expect.arrayContaining(["de", "fr", "en"]));
  });

  for (const [code, pattern] of Object.entries(FORMAL)) {
    it(`${code} uses informal address only`, () => {
      const offenders = Object.entries(load(code))
        .filter(([key, value]) => pattern.test(value) && !FORMAL_ALLOWLIST.has(`${code}:${key}`))
        .map(([key, value]) => `${key}: ${value}`);
      expect(offenders).toEqual([]);
    });
  }

  it("flags formal address (self-check of the patterns)", () => {
    expect(FORMAL.de.test("Öffnen Sie die Datei")).toBe(true);
    expect(FORMAL.de.test("Ihre Daten und Ihnen")).toBe(true);
    expect(FORMAL.de.test("Öffne deine Datei, Siegel")).toBe(false);
    expect(FORMAL.fr.test("Ouvrez votre fichier, vous")).toBe(true);
    expect(FORMAL.fr.test("Ouvre ton fichier, nous")).toBe(false);
  });

  for (const code of codes) {
    it(`${code} has no em dash or spaced dash`, () => {
      const offenders = Object.entries(load(code))
        .filter(([, value]) => DASH.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      expect(offenders).toEqual([]);
    });

    it(`${code} has no "safe" wording`, () => {
      const offenders = Object.entries(load(code))
        .filter(([, value]) => SAFE.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      expect(offenders).toEqual([]);
    });
  }
});
