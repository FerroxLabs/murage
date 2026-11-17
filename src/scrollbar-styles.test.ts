// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
interface Rule { selector: string; body: string; conditions: string[] }

// Walk nested media/supports blocks so a standard declaration outside the
// fallback cannot silently disable Chromium's custom scrollbar again.
function rulesIn(source: string, conditions: string[] = []): Rule[] {
  const rules: Rule[] = [];
  let start = 0;
  while (start < source.length) {
    const open = source.indexOf("{", start);
    if (open < 0) break;
    let depth = 1, end = open + 1;
    while (end < source.length && depth) {
      if (source[end] === "{") depth++;
      if (source[end] === "}") depth--;
      end++;
    }
    if (depth) throw new Error("Unbalanced stylesheet");
    const selector = source.slice(start, open).trim();
    const body = source.slice(open + 1, end - 1);
    if (/^@(media|supports)\b/.test(selector)) rules.push(...rulesIn(body, [...conditions, selector]));
    else rules.push({ selector, body, conditions });
    start = end;
  }
  return rules;
}

const rules = rulesIn(css);
const fallback = "@supports not selector(::-webkit-scrollbar)";
const pointer = "@media (hover: hover) and (pointer: fine)";
function scrollbarRule(pseudo: string): Rule {
  const rule = rules.find(({ selector }) => selector.split(",").map(s => s.trim()).includes(pseudo));
  expect(rule, pseudo).toBeDefined();
  return rule!;
}
function declaration(rule: Rule, name: string): string {
  return new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`).exec(rule.body)?.[1].trim() ?? "";
}

describe("shared scrollbars", () => {
  it("keeps every standard scrollbar declaration inside the non-WebKit fallback", () => {
    const standard = rules.filter(rule => /(?:^|[;\s])scrollbar-(?:width|color):/.test(rule.body));
    expect(standard.length).toBeGreaterThan(0);
    for (const rule of standard) expect(rule.conditions, rule.selector).toContain(fallback);
    const thin = standard.find(rule => declaration(rule, "scrollbar-width") === "thin");
    expect(thin).toBeDefined();
    expect(thin!.selector.split(",").map(s => s.trim())).toEqual(["*", ".thin-scroll"]);
    expect(declaration(thin!, "scrollbar-color")).toBe("var(--color-scrollbar) transparent");
    expect(thin!.conditions).toContain(pointer);
  });

  it("draws a 4px pill with a wider grab area, in both directions", () => {
    const bar = scrollbarRule("::-webkit-scrollbar");
    const thumb = scrollbarRule("::-webkit-scrollbar-thumb");
    expect(declaration(bar, "width")).toBe("10px");
    expect(declaration(bar, "height")).toBe("10px");
    expect(declaration(thumb, "border")).toBe("3px solid transparent");
    expect(declaration(thumb, "background-clip")).toBe("content-box");
    expect(declaration(thumb, "border-radius")).toBe("999px");
    expect(declaration(thumb, "min-height")).toBe("36px");
    expect(declaration(thumb, "min-width")).toBe("36px");
  });

  it("uses the existing skin token and brightens the thumb on list and thumb hover", () => {
    expect(declaration(scrollbarRule("::-webkit-scrollbar-thumb"), "background")).toBe("var(--color-scrollbar)");
    for (const [pseudo, amount] of [[":hover::-webkit-scrollbar-thumb", 15], ["::-webkit-scrollbar-thumb:hover", 30]] as const) {
      const hover = scrollbarRule(pseudo);
      expect(declaration(hover, "--scrollbar-thumb-fill")).toBe(`color-mix(in srgb, var(--color-scrollbar), white ${amount}%)`);
      expect(declaration(hover, "background")).toBe("var(--scrollbar-thumb-fill)");
    }
    const fallbackHover = rules.find(rule => rule.selector.split(",").map(s => s.trim()).includes(".thin-scroll:hover"));
    expect(fallbackHover).toBeDefined();
    expect(fallbackHover!.conditions).toEqual([pointer, fallback]);
    expect(declaration(fallbackHover!, "scrollbar-color")).toBe("color-mix(in srgb, var(--color-scrollbar), white 15%) transparent");
    for (const skin of ["dark", "light"]) {
      const palette = rules.find(rule => rule.selector === `[data-skin="${skin}"]`);
      expect(palette, skin).toBeDefined();
      expect(declaration(palette!, "--color-scrollbar")).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("has transparent tracks and corners, with no arrows", () => {
    for (const pseudo of ["::-webkit-scrollbar-track", "::-webkit-scrollbar-corner"]) {
      expect(declaration(scrollbarRule(pseudo), "background")).toBe("transparent");
    }
    const arrows = scrollbarRule("::-webkit-scrollbar-button");
    expect(declaration(arrows, "display")).toBe("none");
    expect(declaration(arrows, "width")).toBe("0");
    expect(declaration(arrows, "height")).toBe("0");
  });

  it("gives thin-scroll the same rules as every scroller, preserving native touch bars", () => {
    const webkit = rules.filter(rule => rule.selector.includes("::-webkit-scrollbar") && !rule.selector.includes("no-scrollbar-phone"));
    expect(webkit.length).toBe(7);
    for (const rule of webkit) {
      expect(rule.conditions).toEqual([pointer]);
      const selectors = rule.selector.split(",").map(s => s.trim());
      expect(selectors).toHaveLength(2);
      expect(selectors[1]).toBe(`.thin-scroll${selectors[0]}`);
    }
  });
});
