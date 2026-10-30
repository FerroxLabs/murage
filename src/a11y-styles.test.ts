// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX overhaul slice 8, part 1: what src/styles.css promises a person who uses the keyboard, a touch screen, a screen
// magnifier or asks for less motion. Read from the stylesheet itself, in the WhatsNewDialog.test.ts pattern.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { measure, parsePalettes } from "../scripts/a11y/contrast.mjs";

const raw = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
const REDUCE = "@media (prefers-reduced-motion: reduce)";

/** The body of the `@media` block that starts at `at`, braces balanced. */
function blockAt(at: number): string {
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced block");
}

/** The declarations of the first top-level rule whose selector is exactly `selector`. */
function ruleBody(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? "";
}

describe("reduced motion", () => {
  const reduced = blockAt(css.indexOf(REDUCE));

  it("lives in one block, at the end of the stylesheet, so it wins against everything above it", () => {
    expect(css.split(REDUCE).length - 1).toBe(1);
    const after = css.slice(css.indexOf(REDUCE));
    // nothing but the block itself follows it
    expect(after.slice(after.indexOf("{") + reduced.length + 2).trim()).toBe("");
  });

  it("stops spatial motion everywhere and keeps loaders as a slow fade", () => {
    expect(reduced).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*animation: none !important;[^}]*transition-duration: 0\.01ms !important;/);
    expect(reduced).toMatch(/\.animate-spin\s*\{\s*animation: reduced-loader-pulse/);
  });

  it("turns a panel slide into a fade, with a class that outranks the blanket rule", () => {
    expect(ruleBody(".help-panel-in")).toContain("animation: help-panel-in 180ms ease-out");
    expect(reduced).toMatch(/\.animate-panel-in,\s*\.help-panel-in\s*\{\s*animation: fade-in 120ms ease-out both !important;/);
    expect(css).toMatch(/@keyframes fade-in\s*\{\s*from\s*\{\s*opacity: 0;\s*\}\s*to\s*\{\s*opacity: 1;\s*\}/);
  });

  it("stops every pulse", () => {
    expect(reduced).toMatch(/\.animate-status-pulse\s*\{\s*animation: none;/);
    expect(reduced).toMatch(/\.working-pulse\s*\{\s*animation: none; opacity: 1;/);
  });

  it("holds the landing highlight as a static ring", () => {
    expect(ruleBody("[data-landing]")).toContain("animation: landing-fade 2s ease-out forwards");
    const still = /\[data-landing\]\s*\{([^}]*)\}/.exec(reduced)?.[1] ?? "";
    expect(still).toContain("animation: none !important");
    expect(still).toContain("box-shadow: 0 0 0 var(--focus-ring-width) var(--color-accent)");
  });

  it("keeps every rule the older per-feature blocks had", () => {
    for (const rule of [".whats-new-card { animation: none; }", ".announce-in { animation: none; }", ".msg-sheet, .msg-sheet-backdrop { animation: none; }", "aside { transition: none; }", ".ember-eyes { transform: none; }"]) {
      expect(reduced, rule).toContain(rule);
    }
    expect(reduced).toMatch(/\.ember-orbit\s*\{\s*display: none;/);
  });
});

describe("focus ring", () => {
  it("is one token set: colour per palette, width and offset once", () => {
    expect(ruleBody(":root", css.slice(css.indexOf("--focus-ring-width") - 40))).toMatch(/--focus-ring-width: 2px;\s*--focus-ring-offset: 2px;/);
    expect(ruleBody(":focus-visible")).toMatch(/outline: var\(--focus-ring-width\) solid var\(--color-focus\);\s*outline-offset: var\(--focus-ring-offset\);/);
    for (const [id, tokens] of parsePalettes(raw)) expect(tokens["--color-focus"], id).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("never hard-codes a ring width or colour beside the token", () => {
    expect(css).not.toMatch(/outline: 2px solid/);
  });

  it("rings the label of a visually hidden checkbox or radio", () => {
    expect(ruleBody("label:has(> input.sr-only:focus-visible)")).toContain("outline: var(--focus-ring-width) solid var(--color-focus)");
  });
});

describe("contrast in both palettes", () => {
  const rows = measure(raw);

  it("measures the soft chips, the badge, the landing ring and the toast in light and dark", () => {
    expect(new Set(rows.map((row) => row.palette))).toEqual(new Set(["dark", "light"]));
    for (const tone of ["accent", "success", "warning", "danger"]) expect(rows.some((row) => row.bg === `--color-${tone}-soft`), tone).toBe(true);
    expect(rows.some((row) => row.why === "Needs you badge count")).toBe(true);
  });

  it("clears every target, and an unmeasurable pair counts as a failure", () => {
    expect(rows.filter((row) => !row.pass).map((row) => `${row.palette} ${row.fg} on ${row.bg} = ${row.ratio}`)).toEqual([]);
    const broken = measure(raw.replace("--color-warning-soft: #fbf0d9;", "--color-warning-soft: transparent;"));
    expect(broken.filter((row) => !row.pass).length).toBeGreaterThan(0);
  });

  it("defines the soft tokens in the base, so Tailwind generates bg-*-soft, and in each palette", () => {
    const theme = /@theme\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const tone of ["accent", "success", "warning", "danger"]) {
      expect(theme, tone).toContain(`--color-${tone}-soft:`);
      for (const id of ["dark", "light"]) expect(ruleBody(`[data-skin="${id}"]`), `${id} ${tone}`).toContain(`--color-${tone}-soft:`);
    }
  });
});

describe("touch targets and sizes", () => {
  const coarse = [...css.matchAll(/@media \(pointer: coarse\)/g)].map((match) => blockAt(match.index!)).join("\n");

  it("gives a control 44 px on a touch screen, by growing it or widening only its hit area", () => {
    expect(coarse).toMatch(/\.tap-target\s*\{\s*min-height: 44px;\s*min-width: 44px;/);
    expect(coarse).toMatch(/\.tap-area::before\s*\{[^}]*width: max\(100%, 44px\);[^}]*height: max\(100%, 44px\);/);
  });

  it("draws status marks at 32 px and phone tab labels at 12 px", () => {
    expect(ruleBody(".status-mark")).toMatch(/width: 32px;\s*height: 32px;/);
    expect(ruleBody(".phone-tab-label")).toContain("font-size: 12px;");
    for (const tone of ["accent", "success", "warning", "danger"]) expect(css, tone).toContain(`.status-mark[data-tone="${tone}"] { background-color: var(--color-${tone}-soft);`);
  });
});
