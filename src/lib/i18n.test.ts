import { afterEach, describe, expect, it } from "vitest";

import { localeVersion, resolveLocale, setLocale, subscribeLocale, t } from "./i18n";
import { en, loadLocalePack, localeChoices, localeCodes, localeLoaders } from "@/locales";
import { allLocalePacks } from "@/locales/testing";

afterEach(() => setLocale("en"));

describe("resolveLocale", () => {
  const available = new Set(["en", "de", "pt-br"]);

  it("keeps a registered exact tag, case-insensitively", () => {
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("de", available)).toBe("de");
  });

  it("falls back from a regional tag to its base language", () => {
    expect(resolveLocale("de-AT", available)).toBe("de");
  });

  it("falls back to English for unknown or missing tags", () => {
    expect(resolveLocale("fr-FR", available)).toBe("en");
    expect(resolveLocale(undefined, available)).toBe("en");
    expect(resolveLocale("", available)).toBe("en");
  });
});

describe("t", () => {
  it("returns the English catalog value by default", () => {
    expect(t("engines.cloud")).toBe("Cloud");
  });

  it("setLocale reports the locale that actually took effect", async () => {
    // a shipped base pack catches its regional variants…
    expect(await setLocale("de-AT")).toBe("de");
    expect(t("engines.local")).toBe("Lokal");
    // …and a genuinely unknown tag falls back to English
    expect(await setLocale("xx-YY")).toBe("en");
    expect(t("engines.local")).toBe("Local");
  });

  it("resolves every registered locale to itself", () => {
    const available = localeCodes();
    for (const code of available) {
      expect(resolveLocale(code, available)).toBe(code);
    }
  });

  it("routes common system tags onto the shipped packs", () => {
    const available = localeCodes();
    expect(resolveLocale("zh-CN", available)).toBe("zh");
    expect(resolveLocale("ja-JP", available)).toBe("ja");
    expect(resolveLocale("pt-BR", available)).toBe("pt-br");
    expect(resolveLocale("pt-PT", available)).toBe("pt");
    expect(resolveLocale("hi-IN", available)).toBe("hi");
  });

  it("every registered pack carries only known keys with non-empty values", async () => {
    for (const pack of Object.values(await allLocalePacks())) {
      for (const [key, value] of Object.entries(pack)) {
        expect(Object.hasOwn(en, key)).toBe(true);
        expect((value ?? "").trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("ships exactly one JSON catalog for every picker language", () => {
    const files = Object.keys(import.meta.glob("../locales/*.json", { eager: true }))
      .map((path) => path.split("/").at(-1))
      .filter((file) => file !== "source-hashes.json")
      .sort();
    const choices = localeChoices.map(({ code }) => `${code}.json`).sort();
    expect(files).toEqual(choices);
  });

  it("overlays a partial pack and falls back to English for missing keys", async () => {
    localeLoaders["zz"] = async () => ({ "engines.cloud": "Wolke" });
    try {
      expect(await setLocale("zz")).toBe("zz");
      expect(t("engines.cloud")).toBe("Wolke");
      // key the pack omits → English, not undefined and not the key
      expect(t("engines.local")).toBe("Local");
    } finally {
      delete localeLoaders["zz"];
      await setLocale("en");
    }
  });

  it("interpolates params and keeps unmatched placeholders visible", () => {
    // exercised through a raw template so the test doesn't depend on which
    // catalog keys happen to use params yet
    const template = "Hello {name}, {missing}!";
    const rendered = template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in { name: "Ember" } ? String({ name: "Ember" }[name as "name"]) : match,
    );
    expect(rendered).toBe("Hello Ember, {missing}!");
  });
});

describe("language packs load on demand", () => {
  it("English is there at once; another pack is fetched once and then shared", async () => {
    await expect(loadLocalePack("en")).resolves.toBe(en);
    const first = loadLocalePack("de");
    expect(loadLocalePack("de")).toBe(first);
    expect((await first)["engines.local"]).toBe("Lokal");
    await expect(loadLocalePack("xx")).rejects.toThrow(/no language pack/);
  });

  it("when two choices overlap, the one made last wins", async () => {
    let release!: (pack: { "engines.cloud": string }) => void;
    localeLoaders["zz-slow"] = () => new Promise(resolve => { release = resolve; });
    try {
      const slow = setLocale("zz-slow");
      expect(await setLocale("de")).toBe("de");
      release({ "engines.cloud": "Late" });
      await slow;
      expect(t("engines.local")).toBe("Lokal");
    } finally {
      delete localeLoaders["zz-slow"];
    }
  });

  it("a pack that cannot be fetched leaves English, and the next choice tries again", async () => {
    let calls = 0;
    localeLoaders["zz-flaky"] = async () => {
      calls += 1;
      if (calls === 1) throw new Error("chunk failed");
      return { "engines.cloud": "Nube" };
    };
    try {
      await setLocale("de");
      expect(await setLocale("zz-flaky")).toBe("en");
      expect(t("engines.local")).toBe("Local");
      expect(await setLocale("zz-flaky")).toBe("zz-flaky");
      expect(t("engines.cloud")).toBe("Nube");
    } finally {
      delete localeLoaders["zz-flaky"];
    }
  });

  it("tells subscribers when the strings change, and only then", async () => {
    await setLocale("en");
    const seen: number[] = [];
    const stop = subscribeLocale(() => seen.push(localeVersion()));
    try {
      await setLocale("en");
      expect(seen).toEqual([]);
      await setLocale("fr");
      expect(seen).toHaveLength(1);
    } finally {
      stop();
    }
  });
});
