// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_HOUSE_RULES } from "../../server/house-rules/default";
import { ALWAYS_ON_RULES, HOUSE_RULES_LONG_WORDS, HouseRulesSettings, lengthHint, wordCount } from "./HouseRulesSettings";
import { richEditable } from "./skills/SkillEditor";

describe("house rules settings", () => {
  it("opens with the intro and loads the rules from the server", () => {
    const html = renderToStaticMarkup(createElement(HouseRulesSettings));
    expect(html).toContain("House rules");
    expect(html).toContain("Every bot follows these. Write them once, in your own words.");
    expect(html).toContain("Loading");
  });

  it("counts words, not Markdown marks", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("## Who you work for\n\n- You work for **one** person.")).toBe(9);
  });

  it("gives a gentle length hint, and says what a long text costs", () => {
    expect(lengthHint(120)).toEqual({ text: "120 words. Every bot reads these on every reply, so shorter is better.", long: false });
    const long = lengthHint(HOUSE_RULES_LONG_WORDS + 200);
    expect(long.long).toBe(true);
    expect(long.text).toContain("1,200 words.");
    expect(long.text).toContain("slower and costlier");
  });

  it("opens the shipped default in the rich editor, and keeps it short", () => {
    expect(richEditable(DEFAULT_HOUSE_RULES)).toBe(true);
    expect(wordCount(DEFAULT_HOUSE_RULES)).toBeLessThan(950);
  });

  it("uses plain words: no em dashes and no \"safe\" in the copy", () => {
    for (const text of [DEFAULT_HOUSE_RULES, ...ALWAYS_ON_RULES, lengthHint(5).text, lengthHint(5000).text]) {
      expect(text).not.toMatch(/—/);
      expect(text).not.toMatch(/\bsafe\b/i);
    }
  });
});
