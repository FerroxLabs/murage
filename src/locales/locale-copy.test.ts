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
  // vous, votre, vos, and a vous imperative ("Examinez", "Réessayez", "Dites-lui"): any word ending in -ez but
  // chez, assez, nez and rez, which are not verbs.
  fr: /(?<![\p{L}])(vous|votre|vos|veuillez|dites|faites)(?![\p{L}])|(?<![\p{L}])(?!(?:chez|assez|nez|rez)(?![\p{L}]))\p{L}+ez(?![\p{L}])/iu,
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
    expect(FORMAL.fr.test("Examinez les approbations dans Murage.")).toBe(true);
    expect(FORMAL.fr.test("Touchez une réponse, puis réessayez.")).toBe(true);
    expect(FORMAL.fr.test("Dites-lui quelque chose")).toBe(true);
    expect(FORMAL.fr.test("Examine-la chez toi, assez vite.")).toBe(false);
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

// 1.0.12 to 1.0.14: the UX lanes' English fragments (src/locales/en-ux). Each lane writes only
// its own `<lane>.json`, every key prefixed `ux.<lane>.`; ../index.ts merges them under en.json.
const FRAGMENT_DIR = join(LOCALES_DIR, "en-ux");
const fragmentFiles = readdirSync(FRAGMENT_DIR).filter((file) => file.endsWith(".json")).sort();

describe("English UX fragments", () => {
  it("registers every fragment file in the loader, and loads nothing that is not a file", async () => {
    const { enUxFragments } = await import("./en-ux");
    expect(Object.keys(enUxFragments).sort()).toEqual(fragmentFiles.map((file) => file.slice(0, -".json".length)).sort());
  });

  for (const file of fragmentFiles) {
    const lane = file.slice(0, -".json".length);
    it(`${file} holds only strings under ux.${lane}., none of them already in en.json`, () => {
      const fragment = JSON.parse(readFileSync(join(FRAGMENT_DIR, file), "utf8")) as Record<string, unknown>;
      const catalogue = load("en");
      const problems = Object.entries(fragment).flatMap(([key, value]) => [
        ...(key.startsWith(`ux.${lane}.`) && key.length > `ux.${lane}.`.length ? [] : [`${key}: must start ux.${lane}.`]),
        ...(typeof value === "string" && value.trim() ? [] : [`${key}: must be a non-empty string`]),
        ...(Object.hasOwn(catalogue, key) ? [`${key}: already in en.json (ask the copy lane to change it)`] : []),
        ...(typeof value === "string" && DASH.test(value) ? [`${key}: em dash or spaced dash`] : []),
        ...(typeof value === "string" && SAFE.test(value) ? [`${key}: "safe" wording`] : []),
      ]);
      expect(problems).toEqual([]);
    });
  }

  it("merges the fragments into the English pack the app reads, without changing an en.json string", async () => {
    const { en } = await import("./index");
    const catalogue = load("en");
    for (const [key, value] of Object.entries(catalogue)) expect(en[key as keyof typeof en]).toBe(value);
    for (const file of fragmentFiles) {
      const fragment = JSON.parse(readFileSync(join(FRAGMENT_DIR, file), "utf8")) as Record<string, string>;
      for (const [key, value] of Object.entries(fragment)) expect(en[key as keyof typeof en]).toBe(value);
    }
  });
});

// The help panel's per-screen words: English, but on the help chunk, not the first paint.
describe("English help screens", () => {
  const screens = JSON.parse(readFileSync(join(LOCALES_DIR, "en-help/screens.json"), "utf8")) as Record<string, string>;

  it("holds only ux.l4a.screen. strings, none of them already in the English pack", async () => {
    const { en } = await import("./index");
    const keys = Object.keys(screens);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((key) => !key.startsWith("ux.l4a.screen.") || typeof screens[key] !== "string" || Object.hasOwn(en, key))).toEqual([]);
  });

  it("joins the English pack when the help chunk loads, without changing a string it already has", async () => {
    const { en } = await import("./index");
    const before = { ...en };
    await import("@/lib/help-screen-copy");
    for (const [key, value] of Object.entries(screens)) expect(en[key as keyof typeof en]).toBe(value);
    for (const [key, value] of Object.entries(before)) expect(en[key as keyof typeof en]).toBe(value);
  });
});
