// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The help search tokenizer for every script (L-COPY r3, design section 5).
import { describe, expect, it } from "vitest";
import { helpRoute } from "../server/help-routes.ts";
import { searchHelp, tokenize as searchTokenize } from "./help-search.ts";
import { stem, tokenize } from "./help-tokenize.ts";

describe("tokenize", () => {
  it("keeps Latin words of 2 or more letters and drops the stopwords, as before", () => {
    expect(tokenize("How do I change the working folder?")).toEqual(["change", "working", "folder"]);
    expect(tokenize("a x 42 7")).toEqual(["42"]);
    expect(searchTokenize).toBe(tokenize);
    expect(stem("routines")).toBe(stem("routine"));
  });

  it("keeps accented and other-script letters inside their word, NFKC folded", () => {
    expect(tokenize("Sicherungs-Ordner öffnen")).toEqual(["sicherungs", "ordner", "öffnen"]);
    expect(tokenize("ＡＢＣ résumé")).toEqual(["abc", "résumé"]);
    // a decomposed accent (e + combining acute) stays in the word and composes
    expect(tokenize("résumé")).toEqual(["résumé"]);
  });

  it("keeps a Hindi word with its matras as one token", () => {
    expect(tokenize("याद")).toEqual(["याद"]);
    expect(tokenize("टीम")).toEqual(["टीम"]);
    expect(tokenize("मुझे याद रखो, टीम!")).toEqual(["मुझे", "याद", "रखो", "टीम"]);
    // two code points (a consonant and its matra) is a word; one is not
    expect(tokenize("कि क")).toEqual(["कि"]);
  });

  it("splits a CJK run into its characters plus its bigrams", () => {
    expect(tokenize("备份")).toEqual(["备", "份", "备份"]);
    expect(tokenize("バックアップ")).toEqual(["バ", "ッ", "ク", "ア", "ッ", "プ", "バッ", "ック", "クア", "アッ", "ップ"]);
    expect(tokenize("バックアップを復元")).toContain("バッ");
    expect(tokenize("백업")).toEqual(["백", "업", "백업"]);
    // a single CJK character is kept
    expect(tokenize("日")).toEqual(["日"]);
  });

  it("splits a piece that mixes scripts into its runs, each by its own rule", () => {
    expect(tokenize("autoで")).toEqual(["auto", "で"]);
    expect(tokenize("Murage的备份")).toEqual(["的", "备", "份", "的备", "备份"]);
    expect(tokenize("ok日本x")).toEqual(["ok", "日", "本", "日本"]);
  });

  it("treats constructor and other Object.prototype names as plain words", () => {
    expect(tokenize("x.constructor")).toEqual(["constructor"]);
    expect(() => searchHelp("constructor")).not.toThrow();
    expect(() => searchHelp("constructor __proto__ tostring valueof hasownproperty")).not.toThrow();
    expect(Array.isArray(searchHelp("constructor"))).toBe(true);
  });
});

describe("the docs route's word filter", () => {
  const ask = (q: string) => helpRoute({ method: "GET", url: new URL(`http://x/api/help/search?q=${encodeURIComponent(q)}`) })!;

  it("keeps every script's words and still leaves constructor out", () => {
    for (const q of ["constructor", "_constructor_", "x.constructor", "ｃｏｎｓｔｒｕｃｔｏｒ", "constructor 备份"]) {
      const answer = ask(q);
      expect(answer.status, q).toBe(200);
      expect(Array.isArray((answer.body as { results: unknown[] }).results), q).toBe(true);
    }
    expect((ask("constructor").body as { results: unknown[] }).results).toEqual([]);
    for (const q of ["バックアップ", "याद", "Sicherung", "working folder"]) expect(ask(q).status, q).toBe(200);
    expect((ask("working folder").body as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it("splits with the u flag on letters, marks and digits, as tokenize does", () => {
    const source = (path: string) => import("node:fs").then((fs) => fs.readFileSync(new URL(path, import.meta.url), "utf8"));
    return Promise.all([source("../server/help-routes.ts"), source("./help-tokenize.ts")]).then(([route, tokenizer]) => {
      expect(route).toContain("/[^\\p{L}\\p{M}\\p{N}]+/u");
      expect(tokenizer).toContain("/[^\\p{L}\\p{M}\\p{N}]+/u");
    });
  });
});
