import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { propose, record } from "./copy-review.mjs";
import { PACK_CODES } from "./locale-partitions.mjs";
import {
  catalogProblems,
  checkCatalogs,
  readEnglishCatalog,
  main,
  mergeSourceCatalogs,
  modelInvocation,
  sourceCatalog,
  normalizeLocaleCode,
  parseModelCatalog,
  placeholders,
  readSourceCatalog,
  readSourceCatalogs,
  sourceHash,
  staleTranslationKeys,
  validateSourceCatalog,
  validateTranslationCatalog,
  validateTranslationHashes,
  writeTextAtomically,
} from "./generate-locale.mjs";
import { removeTempDirSync } from "../server/testing/cleanup.ts";

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "murage-locale-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTempDirSync(directory);
  }
});

describe("locale draft validation", () => {
  it("accepts every shipped catalog", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(() => checkCatalogs()).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("translates the UX fragments too: the source is en.json plus src/locales/en-ux, and en.json wins", () => {
    const source = readSourceCatalog();
    const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8"));
    const l6a = JSON.parse(readFileSync(new URL("../src/locales/en-ux/l6a.json", import.meta.url), "utf8"));
    for (const [key, value] of Object.entries(l6a)) expect(source[key]).toBe(Object.hasOwn(en, key) ? en[key] : value);
    for (const [key, value] of Object.entries(en)) expect(source[key]).toBe(value);
    expect(validateTranslationCatalog(source, { "ux.l6a.hire.title": "Einen Bot einstellen" })).toEqual([]);
  });

  it("keeps the Help panel's words in their own partition: every src/locales/en-help catalogue, never the main source", () => {
    const { main, help } = readSourceCatalogs();
    const dir = new URL("../src/locales/en-help/", import.meta.url);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const words = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
      for (const [key, value] of Object.entries(words)) {
        expect(help[key]).toBe(value);
        expect(Object.hasOwn(main, key)).toBe(false);
      }
    }
    expect(readSourceCatalog()).toEqual(main);
    expect(validateTranslationCatalog(help, { "ux.l4a.screen.today.title": "Heute" })).toEqual([]);
    expect(validateTranslationCatalog(main, { "ux.l4a.screen.today.title": "Heute" })).toEqual([
      "ux.l4a.screen.today.title: key does not exist in English",
    ]);
  });

  it("ships every pack's Help words in help/<code>.json and none of them in the main pack", () => {
    const { main, help } = readSourceCatalogs();
    for (const code of PACK_CODES) {
      const pack = JSON.parse(readFileSync(new URL(`../src/locales/${code}.json`, import.meta.url), "utf8"));
      const helpPack = JSON.parse(readFileSync(new URL(`../src/locales/help/${code}.json`, import.meta.url), "utf8"));
      expect(Object.keys(pack).filter((key) => !Object.hasOwn(main, key))).toEqual([]);
      expect(Object.keys(helpPack).sort()).toEqual(Object.keys(help).sort());
    }
  });

  it("normalizes locale ids to stable lowercase filenames", () => {
    expect(normalizeLocaleCode("pt-BR")).toBe("pt-br");
    expect(normalizeLocaleCode("ZH-hant-TW")).toBe("zh-hant-tw");
    expect(() => normalizeLocaleCode("../fr")).toThrow(/unsupported locale code/i);
  });

  it("requires a non-empty flat English catalog", () => {
    expect(validateSourceCatalog({ hello: "Hello" })).toEqual([]);
    expect(validateSourceCatalog({ empty: "" })).toEqual([
      "empty: English value must be a non-empty string",
    ]);
    expect(validateSourceCatalog([])).toEqual(["English source must be a JSON object"]);
  });

  it("preserves the exact placeholder multiset while allowing reordered text", () => {
    const source = { hello: "Hello {name}; ask {name} about {count}" };
    expect(placeholders(source.hello)).toEqual(["count", "name", "name"]);
    expect(validateTranslationCatalog(source, {
      hello: "{count} Fragen für {name}; hallo {name}",
    })).toEqual([]);
    expect(validateTranslationCatalog(source, {
      hello: "Hallo {name}; {count}",
    })).toEqual([
      'hello: placeholders must stay ["count","name","name"] (received ["count","name"])',
    ]);
  });

  it("allows partial community packs but requires complete model drafts", () => {
    const source = { first: "One", second: "Two" };
    expect(validateTranslationCatalog(source, { first: "Uno" })).toEqual([]);
    expect(validateTranslationCatalog(source, { first: "Uno" }, { requireComplete: true })).toEqual([
      "second: translation is missing",
    ]);
  });

  it("rejects unknown, empty, and chatty model output", () => {
    const source = { first: "One" };
    expect(validateTranslationCatalog(source, { invented: "No", first: "" })).toEqual([
      "invented: key does not exist in English",
      "first: translation must be a non-empty string",
    ]);
    expect(parseModelCatalog('{"first":"Uno"}')).toEqual({ first: "Uno" });
    expect(() => parseModelCatalog('Here you go:\n{"first":"Uno"}')).toThrow(/exactly one JSON object/i);
  });

  it("detects missing acceptance records and English copy changes", () => {
    const source = { first: "One", second: "Two" };
    const translation = { first: "Uno" };
    const hashes = { first: sourceHash(source.first) };

    expect(validateTranslationHashes(source, translation, hashes)).toEqual([]);
    expect(staleTranslationKeys(source, translation, hashes)).toEqual(["second"]);

    const changedSource = { ...source, first: "One changed" };
    expect(validateTranslationHashes(changedSource, translation, hashes)).toEqual([
      "first: English source changed; refresh the translation or remove it for English fallback",
    ]);
    expect(staleTranslationKeys(changedSource, translation, hashes)).toEqual(["first", "second"]);
    expect(validateTranslationHashes(source, translation, {})).toEqual([
      "first: translation has not been accepted against its English source",
    ]);
  });

  it("builds an explicit no-tools restricted Claude invocation", () => {
    const claude = modelInvocation("darwin");
    expect(claude.command).toBe("claude");
    expect(claude.args).toContain("--safe-mode");
    expect(claude.args).toContain("--restricted");
    expect(claude.args).toContain("--tools");
    expect(claude.args.at(claude.args.indexOf("--tools") + 1)).toBe("");
    expect(claude.args).toContain("--no-session-persistence");

    const windows = modelInvocation("win32", "C:\\Windows\\System32\\cmd.exe");
    expect(windows.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windows.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(windows.args[3]).toContain('--tools ""');
    expect(windows.args[3]).not.toContain("One");
  });

  it("lets structural validation report null catalogs without a hash crash", () => {
    const source = { first: "One" };
    expect(validateTranslationCatalog(source, null)).toEqual(["translation must be a JSON object"]);
    expect(validateTranslationHashes(source, null, {})).toEqual([]);
  });

  it("replaces files atomically on the Windows code path", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "catalog.json");
    writeFileSync(path, "before");

    writeTextAtomically(path, "after", "win32");

    expect(readFileSync(path, "utf8")).toBe("after");
    expect(readdirSync(directory)).toEqual(["catalog.json"]);
  });

  it("never generates or accepts the English source catalog", () => {
    expect(() => main(["en", "English", "--force"])).toThrow(/English is the source catalog/i);
    expect(() => main(["en", "--accept"])).toThrow(/English is the source catalog/i);
  });

  // 1.0.19 slice P: Settings and picker words live in the lazy src/locales/en-settings pack, out of the
  // first paint. The other seven packs translate them like any en.json string, so they are English here.
  it("reads the lazy Settings pack as English, so the other seven packs can carry its keys", () => {
    const dir = new URL("../src/locales/", import.meta.url);
    const en = JSON.parse(readFileSync(new URL("en.json", dir), "utf8"));
    const source = sourceCatalog();
    for (const [key, value] of Object.entries(en)) expect(source[key]).toBe(value);
    for (const name of readdirSync(new URL("en-settings/", dir)).filter((file) => file.endsWith(".json"))) {
      for (const [key, value] of Object.entries(JSON.parse(readFileSync(new URL(`en-settings/${name}`, dir), "utf8")))) expect(source[key]).toBe(value);
    }
    expect(mergeSourceCatalogs({ a: "A" }, { "picker.json": { "picker.b": "B" } })).toEqual({ a: "A", "picker.b": "B" });
    expect(() => mergeSourceCatalogs({ a: "A" }, { "picker.json": { a: "other" } })).toThrow(/already in en\.json/);
    // a pack key that only en-settings has is English, not "key does not exist in English"
    expect(validateTranslationCatalog(mergeSourceCatalogs({ a: "A" }, { "picker.json": { "picker.b": "B" } }), { "picker.b": "Be" })).toEqual([]);
  });
});

/** A small locales folder: main = en.json + en-ux/a.json, Help = en-help/h.json, one pack (de), both accepted. */
function fixture({ de = { "a.one": "Eins", "ux.a.two": "Zwei" }, helpDe = { "ux.h.tip": "Tipp" }, extra = () => undefined } = {}) {
  const dir = temporaryDirectory();
  const put = (rel, value) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const en = { "a.one": "One" };
  const ux = { "ux.a.two": "Two" };
  const help = { "ux.h.tip": "Tip" };
  put("en.json", en);
  put("en-ux/a.json", ux);
  put("en-help/h.json", help);
  put("de.json", de);
  const all = { ...en, ...ux, ...help };
  const hashes = (catalog) => Object.fromEntries(Object.keys(catalog).filter((key) => all[key]).map((key) => [key, sourceHash(all[key])]));
  put("source-hashes.json", { version: 1, locales: { de: hashes(de) } });
  if (helpDe) {
    put("help/de.json", helpDe);
    put("help/source-hashes.json", { version: 1, locales: { de: hashes(helpDe) } });
  }
  extra(put, dir);
  return dir;
}

describe("generator partitions (main vs Help, design section 6)", () => {
  const problems = (dir) => catalogProblems(dir).errors;

  it("a complete, accepted fixture in both partitions is valid", () => {
    expect(problems(fixture())).toEqual([]);
  });

  it("--check names a whole language that is gone, whichever files remain", () => {
    expect(catalogProblems(fixture(), { requiredCodes: ["de", "fr"] }).errors).toEqual([
      "fr.json: the whole language pack is missing",
      "help/fr.json: the whole language pack is missing",
    ]);
  });

  it("--check requires both partitions complete", () => {
    expect(problems(fixture({ de: { "a.one": "Eins" } }))).toEqual(["de.json: ux.a.two: translation is missing"]);
    expect(problems(fixture({ helpDe: {} }))).toEqual(["help/de.json: ux.h.tip: translation is missing"]);
  });

  it("a Help key in a main pack, or a main key in a Help pack, fails", () => {
    expect(problems(fixture({ de: { "a.one": "Eins", "ux.a.two": "Zwei", "ux.h.tip": "Tipp" } }))).toEqual(expect.arrayContaining([
      "de.json: ux.h.tip: a Help key in a main pack",
      "de.json: ux.h.tip: key does not exist in English",
    ]));
    expect(problems(fixture({ helpDe: { "ux.h.tip": "Tipp", "a.one": "Eins" } }))).toEqual(expect.arrayContaining([
      "help/de.json: a.one: a main key in a help pack",
    ]));
  });

  it("a key in both partitions fails, and so does a key twice in one file", () => {
    const overlap = fixture({ extra: (put) => put("en-help/h.json", { "ux.h.tip": "Tip", "a.one": "One" }) });
    expect(problems(overlap)).toEqual(expect.arrayContaining(["a.one: in both the main and the Help partition (en-help/h.json)"]));
    const dup = fixture({ extra: (put) => put("help/de.json", '{\n  "ux.h.tip": "Tipp",\n  "ux.h.tip": "Tipp"\n}\n') });
    expect(problems(dup)).toEqual(expect.arrayContaining(["help/de.json: ux.h.tip: key appears twice in the file"]));
  });

  it("a stale Help hash fails, and a missing Help pack fails", () => {
    const stale = fixture({ extra: (put) => put("en-help/h.json", { "ux.h.tip": "Tip changed" }) });
    expect(problems(stale)).toEqual([
      "help/de.json: ux.h.tip: English source changed; refresh the translation or remove it for English fallback",
    ]);
    const missing = fixture({ helpDe: null });
    expect(problems(missing)).toEqual(expect.arrayContaining(["help/de.json: missing (every pack has a Help pack)"]));
  });

  it("--accept writes each partition's hashes to its own file", () => {
    const dir = fixture({ extra: (put) => {
      put("source-hashes.json", { version: 1, locales: {} });
      put("help/source-hashes.json", { version: 1, locales: {} });
      put("copy-lint/reviewers.json", { version: 1, reviewers: [{ kind: "agent", name: "sol-fixture", account: "fixture" }] });
      put("copy-lint/links.json", {});
      put("copy-lint/same-as-english.json", {});
      put("copy-lint/english-only.json", { keys: [] });
      put("copy-lint/pending-review.json", { version: 1, strings: {} });
    } });
    expect(problems(dir)).not.toEqual([]);
    const { bundle } = propose({ dir, base: "abc123", author: "fixture-translator" });
    for (const item of [...Object.values(bundle.strings), ...Object.values(bundle.files)]) item.verdict = "pass";
    record({ dir, bundle, reviewer: "sol-fixture", slug: "fixture", date: "2026-11-06" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      main(["de", "--accept"], { dir });
    } finally {
      log.mockRestore();
    }
    expect(problems(dir)).toEqual([]);
    const mainHashes = JSON.parse(readFileSync(join(dir, "source-hashes.json"), "utf8")).locales.de;
    const helpHashes = JSON.parse(readFileSync(join(dir, "help/source-hashes.json"), "utf8")).locales.de;
    expect(Object.keys(mainHashes).sort()).toEqual(["a.one", "ux.a.two"]);
    expect(Object.keys(helpHashes)).toEqual(["ux.h.tip"]);
  });

  it("generation drafts Help keys into help/<code>.json only, and main keys into <code>.json only", () => {
    const dir = fixture({ de: { "a.one": "Eins" }, helpDe: {} });
    const asked = [];
    const model = (prompt) => {
      const requested = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
      asked.push(Object.keys(requested));
      return JSON.stringify(Object.fromEntries(Object.keys(requested).map((key) => [key, `de ${key}`])));
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      main(["de", "German"], { dir, model });
    } finally {
      log.mockRestore();
    }
    expect(asked).toEqual([["ux.a.two"], ["ux.h.tip"]]);
    expect(JSON.parse(readFileSync(join(dir, "de.json"), "utf8"))).toEqual({ "a.one": "Eins", "ux.a.two": "de ux.a.two" });
    expect(JSON.parse(readFileSync(join(dir, "help/de.json"), "utf8"))).toEqual({ "ux.h.tip": "de ux.h.tip" });
    expect(problems(dir)).toEqual([]);
  });
});

it("D24 catalog and hashes include the English fragment actually shipped to the renderer", () => {
  const source = readEnglishCatalog();
  expect(source["ux.d24.label"]).toBe("Spoken replies");
  expect(source["ux.d24.disclosure"]).toBe("Speech uses a voice service. Avoid reading sensitive replies aloud.");
  expect(() => checkCatalogs()).not.toThrow();
});
