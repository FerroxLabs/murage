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

// L-COPY LINT r3 (1.0.18): the Help words live in their own packs (help/<code>.json, English in en-help/*.json),
// and every rule below runs on them too. A catalogue id is "help/<code>" for a Help pack.
const helpCodes = readdirSync(join(LOCALES_DIR, "help"))
  .filter((file) => file.endsWith(".json") && file !== "source-hashes.json")
  .map((file) => file.slice(0, -".json".length))
  .sort();
const englishHelp = () => Object.assign({}, ...readdirSync(join(LOCALES_DIR, "en-help"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(LOCALES_DIR, "en-help", file), "utf8")) as Record<string, string>)) as Record<string, string>;
const catalogues: { id: string; code: string; load: () => Record<string, string> }[] = [
  ...codes.map((code) => ({ id: code, code, load: () => load(code) })),
  { id: "en-help", code: "en", load: englishHelp },
  ...helpCodes.map((code) => ({ id: `help/${code}`, code, load: () => load(`help/${code}`) })),
];

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
  it("finds the shipped locale packs and their Help packs", () => {
    expect(codes).toEqual(expect.arrayContaining(["de", "fr", "en"]));
    expect(helpCodes).toEqual(codes.filter((code) => code !== "en"));
  });

  for (const { id, code, load: read } of catalogues) {
    const pattern = FORMAL[code];
    if (!pattern) continue;
    it(`${id} uses informal address only`, () => {
      const offenders = Object.entries(read())
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

  for (const { id, load: read } of catalogues) {
    it(`${id} has no em dash or spaced dash`, () => {
      const offenders = Object.entries(read())
        .filter(([, value]) => DASH.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      expect(offenders).toEqual([]);
    });

    it(`${id} has no "safe" wording`, () => {
      const offenders = Object.entries(read())
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

  // L-COPY r3: Help is its own partition. Loading the help chunk reads English Help from its own table and never
  // merges it into the English pack, so t() can never answer a Help key and boot English stays main keys only.
  it("stays out of the English pack when the help chunk loads", async () => {
    const { en } = await import("./index");
    const before = { ...en };
    const { enHelp } = await import("@/lib/help-copy-store");
    for (const [key, value] of Object.entries(screens)) {
      expect(enHelp[key]).toBe(value);
      expect(Object.hasOwn(en, key), key).toBe(false);
    }
    expect({ ...en }).toEqual(before);
  });
});

it("budget copy is registered and translated with matching source hashes", async () => {
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const root = new URL("./", import.meta.url);
  const read = (name: string) => JSON.parse(fs.readFileSync(new URL(name, root), "utf8"));
  const en = read("en.json");
  const hashes = read("source-hashes.json");
  for (const locale of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
    for (const key of ["call.budgetStop", "settings.fluxSpendLimits", "voice.budgetReached"]) {
      expect(read(`${locale}.json`)[key]).toBeTruthy();
      expect(hashes.locales[locale][key]).toBe(createHash("sha256").update(en[key]).digest("hex"));
    }
  }
});

it("the two budget strings obey the copy rules in all eight packs", async () => {
  const shipped = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
  expect(codes).toEqual([...shipped].sort());
  const banned = /—|\s[–−]\s|\b(?:safe|safely|safety|unsafe|free|Forge)\b|सुरक्षित|सुरक्षा/iu;
  for (const code of shipped) {
    for (const key of ["call.budgetStop", "settings.fluxSpendLimits", "voice.budgetReached"]) {
      const value = load(code)[key];
      expect(value.trim(), `${code}:${key}`).toBeTruthy();
      expect(value, `${code}:${key}`).not.toMatch(banned);
      if (code !== "en") expect(value).not.toBe(load("en")[key]);
    }
  }
  const { CALL_BUDGET_STOP } = await import("../lib/voice-host");
  expect(load("en")["call.budgetStop"]).toBe(CALL_BUDGET_STOP);
  const speech = readFileSync(new URL("../../server/tts/flux-speech.ts", import.meta.url), "utf8");
  expect(speech).toContain(`export const VOICE_BUDGET_REACHED = ${JSON.stringify(load("en")["voice.budgetReached"])};`);
});

it("uses the approved section 6.3 wording", () => {
  expect(load("en")["call.budgetStop"]).toBe("The call ended because this Flux key has reached its budget. You can start another call when the budget resets or changes.");
  expect(load("en")["settings.fluxSpendLimits"]).toBe("Spend limits here cover Flux. When a bot uses your own sign-in or key, that provider bills you and its own limits apply.");
});

// COPY-FINAL cf2 (Astra Low): the call ends when the budget is reached and a separate start is needed. The ja, zh and fr lines say the
// call can be started again; they never say it resumes by itself.
it("the call budget stop in ja, zh and fr says the call can be started again, never that it resumes by itself", () => {
  const resumes: Record<string, RegExp> = { ja: /通話が再開/u, zh: /通话会重新开始/u, fr: /\bIl reprend\b/u };
  const startsAgain: Record<string, RegExp> = { ja: /再び通話を開始できます。$/u, zh: /可以再次开始通话。$/u, fr: /Tu peux relancer l’appel quand le budget est réinitialisé ou modifié\.$/u };
  for (const code of ["ja", "zh", "fr"]) {
    const value = load(code)["call.budgetStop"];
    expect(value, `${code}: must not say the call resumes`).not.toMatch(resumes[code]);
    expect(value, `${code}: must say the call can be started again`).toMatch(startsAgain[code]);
  }
});

// COPY-FINAL cf2 (Astra and Fable Low): en, de, es, pt-br and hi say the same as ja, zh and fr: the call ended, and a person can start another one.
it("the call budget stop in en, de, es, pt-br and hi says another call can be started, never that it starts by itself", () => {
  const startsAgain: Record<string, RegExp> = {
    en: /You can start another call when the budget resets or changes\.$/u,
    de: /Du kannst einen neuen Anruf starten, wenn das Budget zur\u00fcckgesetzt oder ge\u00e4ndert wird\.$/u,
    es: /Puedes iniciar otra llamada cuando el presupuesto se restablezca o cambie\.$/u,
    "pt-br": /Voc\u00ea pode iniciar outra chamada quando o or\u00e7amento for redefinido ou alterado\.$/u,
    hi: /\u092c\u091c\u091f \u0930\u0940\u0938\u0947\u091f \u0939\u094b\u0928\u0947 \u092f\u093e \u092c\u0926\u0932\u0928\u0947 \u092a\u0930 \u0906\u092a \u0928\u0908 \u0915\u0949\u0932 \u0936\u0941\u0930\u0942 \u0915\u0930 \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964$/u,
  };
  const byItself: Record<string, RegExp> = { en: /starts again/u, de: /Er startet wieder/u, es: /Vuelve a empezar/u, "pt-br": /Ela come\u00e7a de novo/u, hi: /\u092b\u093f\u0930 \u0936\u0941\u0930\u0942 \u0939\u094b/u };
  for (const code of Object.keys(startsAgain)) {
    const value = load(code)["call.budgetStop"];
    expect(value, code + ": must not say it starts by itself").not.toMatch(byItself[code]);
    expect(value, code + ": must say another call can be started").toMatch(startsAgain[code]);
  }
});
