// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The terms screen's strings exist in every shipped language and keep the two
// link placeholders the screen splits the sentence on. (generate-locale.mjs
// --check proves the source hashes; locale-copy.test.ts proves the house
// rules for dashes, address and wording across the whole pack.)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const KEYS = ["terms.title", "terms.intro", "terms.updatedIntro", "terms.checkbox", "terms.link.terms", "terms.link.privacy", "terms.accept", "terms.quit", "terms.error", "terms.unreachable", "terms.retry", "terms.desktopOnly"];
const codes = readdirSync(DIR).filter((file) => file.endsWith(".json") && file !== "source-hashes.json").map((file) => file.slice(0, -5));

describe("terms screen strings", () => {
  for (const code of codes) {
    it(`${code} has every key, with both link placeholders in the checkbox`, () => {
      const pack = JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8")) as Record<string, string>;
      for (const key of KEYS) expect(pack[key], `${code}:${key}`).toBeTruthy();
      expect(pack["terms.checkbox"]).toContain("{terms}");
      expect(pack["terms.checkbox"]).toContain("{privacy}");
    });
  }
  it("English carries the approved sentence", () => {
    const en = JSON.parse(readFileSync(join(DIR, "en.json"), "utf8")) as Record<string, string>;
    expect(en["terms.checkbox"].replace("{terms}", en["terms.link.terms"]).replace("{privacy}", en["terms.link.privacy"]))
      .toBe("I am 18 or older and I agree to the Terms of Service and Privacy Policy");
  });
});
