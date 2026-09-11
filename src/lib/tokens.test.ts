// Token drift.
//
// Under Tailwind v4, a utility whose token does not exist does not error — the
// class is simply never generated, the element gets no background, and the page
// renders wrong in silence. The same is true of a `var(--typo)` in an arbitrary
// value. `src/` carries roughly three thousand colour-utility class names
// against twenty-three tokens, so the surface is large and the failure mode is
// invisible. This file is the guard.
//
// It is deliberately NOT a port of Wayland Desktop's check-ui-tokens.js: that
// script's BANNED_TOKENS table encodes their specific historical typos and has
// no meaning against different token names.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
// Comments stripped: the stylesheet explains in prose that there is no
// [data-skin="auto"] block, and a parser that reads comments would find one.
const css = readFileSync(join(root, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Vitest files and the Playwright specs under `src/e2e/`. Both are excluded
 *  from every sweep below for the same reason: the rules are about SHIPPED
 *  UI, and a spec that paints a fixture canvas, asserts `toHaveCSS(
 *  'border-radius')` or names a fixture model id is asserting against the
 *  app, not styling it. Neither kind is reachable from `src/main.tsx`. */
function isTestFile(entry: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(entry);
}

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry) && !isTestFile(entry)) out.push(path);
    }
  })(join(root, "src"));
  return out;
}

function declarationsIn(body: string): string[] {
  return [...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name);
}

/** The `@theme` + `:root` base, restricted to the families a palette owns.
 *  Animation tokens live in the base too and do not vary by theme. */
const baseTokens = new Set(
  [...css.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)]
    .flatMap(([, body]) => declarationsIn(body))
    .filter((name) => /^--(color|font|radius)-/.test(name)),
);

const palettes = new Map(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => [
    id,
    new Set(declarationsIn(body)),
  ]),
);

/** id → {token: value}. The name sets above answer "is it declared"; the
 *  surface-order assertion needs to know what it was declared AS. */
const paletteValues = new Map(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)].map(([, id, body]) => [
    id,
    Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, n, v]) => [n, v.trim()])),
  ]),
);

/** Relative luminance, per WCAG — the same maths scripts/check-skin-contrast.mjs
 *  uses. That script measures whether two surfaces differ; this file measures
 *  which way round they are, which no contrast ratio can say. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex: ${hex}`);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Every `--color-*` the stylesheet defines anywhere. */
const colorTokens = new Set([...css.matchAll(/(--color-[\w-]+)\s*:/g)].map(([, name]) => name));

describe("token drift", () => {
  it("has palettes to measure", () => {
    // A parser that silently matched nothing would make every assertion below
    // vacuously true.
    expect([...palettes.keys()].sort()).toEqual(["dark", "light"]);
    expect(baseTokens.size).toBeGreaterThan(20);
  });

  it("defines every base token in every palette", () => {
    // The reference is the BASE, not the default palette. Referencing the
    // default is what let `midnight` omit --color-focus and inherit the
    // upstream Grok blue #459ffe with the suite green: the reference set had a
    // hole in exactly the same place.
    for (const [id, tokens] of palettes) {
      const missing = [...baseTokens].filter((token) => !tokens.has(token));
      expect(`${id}: ${missing.join(", ")}`).toBe(`${id}: `);
    }
  });

  it("defines the same tokens in every palette, in both directions", () => {
    // Catches a token added to one palette and forgotten in the other even when
    // the base never mentions it — which is how --radius-lg / --radius-xl lived
    // in all four skins with no base declaration at all, one omission away from
    // falling through to Tailwind's own defaults instead of failing.
    for (const [a, tokensA] of palettes) {
      for (const [b, tokensB] of palettes) {
        if (a === b) continue;
        const missing = [...tokensA].filter((token) => !tokensB.has(token));
        expect(`${b} is missing: ${missing.join(", ")}`).toBe(`${b} is missing: `);
      }
    }
  });

  it("orders the three structural surfaces the way each palette intends", () => {
    // Which surface is BRIGHTER than which is a design decision that no
    // contrast check can hold: check-skin-contrast.mjs asks only that
    // `--color-panel` and `--color-app` differ by 1.03:1, and a palette that
    // swaps them passes it unchanged. Light shipped inverted for exactly that
    // reason — the sidebar (`bg-panel`) read as the white surface and the
    // transcript (`bg-app`) as the grey one, so the eye was pulled to the
    // navigation instead of the conversation.
    //
    // The rule both palettes obey: `--color-card` is the brightest surface, so
    // a bubble or a tile is always the figure. Where they differ is which side
    // of the content ground the chrome sits on, and that is forced by the
    // ground itself — chrome always steps TOWARDS mid-grey. Light's ground is
    // near-white, so the sidebar is darker than it; dark's ground is near-black,
    // so the sidebar is lighter. Wayland Desktop does the same in both modes.
    const ORDER: Record<string, string[]> = {
      // dimmest → brightest
      light: ["--color-panel", "--color-app", "--color-card"],
      dark: ["--color-app", "--color-panel", "--color-card"],
    };
    for (const [id, order] of Object.entries(ORDER)) {
      const tokens = paletteValues.get(id);
      expect(`${id} exists`).toBe(tokens ? `${id} exists` : `${id} missing`);
      // Strictly increasing, so this catches a swap AND a tie — two surfaces
      // given the same value are an order on paper and a flat wall on screen.
      const measured = order.map((token) => luminance(tokens![token]));
      const dimmestFirst = order
        .map((token, i) => ({ token, value: tokens![token], lum: measured[i] }))
        .sort((a, b) => a.lum - b.lum)
        .map(({ token, value }) => `${token} ${value}`)
        .join(" < ");
      const want = order.map((token) => `${token} ${tokens![token]}`).join(" < ");
      expect(dimmestFirst).toBe(want);
      // Sorting is stable, so it would report two identical surfaces as ordered.
      const ties = order
        .map((token, i) => (i > 0 && measured[i] <= measured[i - 1] ? `${order[i - 1]} == ${token}` : null))
        .filter((pair) => pair !== null);
      expect(`${id} ties: ${ties.join(", ")}`).toBe(`${id} ties: `);
    }
  });

  it("names only tokens that exist from every colour utility in src", () => {
    // Longest prefix first, so `ring-offset-app` is not read as `ring` plus a
    // bare word. The lookbehind rejects a hyphen as well as a word character:
    // without it `switch-to-bot` parses as the utility `to-bot`.
    const utility =
      /(?<![\w-])(?:ring-offset|placeholder|decoration|divide|outline|shadow|accent|border|stroke|caret|from|fill|ring|text|via|bg|to)-([a-z][a-z0-9-]*)(?![\w-])/g;
    // Tailwind's own vocabulary for these prefixes — sizes, sides, widths,
    // keywords and its built-in palette. Each entry is a real utility whose
    // suffix is not a colour, so it can never name a token.
    const NOT_A_TOKEN = new Set([
      // border sides and widths: border-b, border-l-2, border-r-0, border-x…
      // Tailwind ships every side × {0,2,4,8}; the whole set is listed so a
      // new `max-md:border-l-0` is not read as a token named `l-0`.
      "b", "l", "r", "t", "x", "y",
      "b-0", "l-0", "r-0", "t-0", "x-0", "y-0",
      "b-2", "l-2", "r-2", "t-2", "x-2", "y-2",
      "b-4", "l-4", "r-4", "t-4", "x-4", "y-4",
      "b-8", "l-8", "r-8", "t-8", "x-8", "y-8",
      // border styles and border-collapse
      "dashed", "dotted", "solid", "collapse", "separate", "none",
      // CSS-wide colour keywords Tailwind ships as utilities
      "transparent", "current", "inherit", "black", "white",
      // text-align
      "left", "right", "center", "justify", "start", "end",
      // type and shadow scales (2xl etc. start with a digit and never match)
      "xs", "sm", "base", "lg", "xl", "inner",
      // ring-offset-N / outline-offset-N widths
      "offset-0", "offset-1", "offset-2", "offset-4",
      // bg-gradient-to-*
      "gradient-to-b", "gradient-to-t", "gradient-to-l", "gradient-to-r",
      "gradient-to-br", "gradient-to-bl", "gradient-to-tr", "gradient-to-tl",
      // SVG presentation attributes in raw markup strings (EmberAvatar): these
      // are `stroke-linecap` / `stroke-width` / `fill-rule`, not utilities.
      "linecap", "linejoin", "width", "rule", "opacity",
      // CSS box-sizing: border-box is not a border colour utility.
      "box",
    ]);
    // Strings the utility regex reads as `text-…` that are DATA, not class
    // names: the local-model probe outcome ids from `shared/local-models.ts`
    // (`text-instead-of-tool`, `text-instead-of-tools`) that the Local models
    // view switches on. They never reach a className, and renaming a shared
    // probe contract to dodge a heuristic would be the wrong trade. Each entry
    // must still exist in the contract, so this list cannot rot.
    const localModels = readFileSync(join(root, "shared/local-models.ts"), "utf8");
    const PROBE_OUTCOME_IDS = ["instead-of-tool", "instead-of-tools"];
    for (const id of PROBE_OUTCOME_IDS) expect(localModels, id).toContain(`"text-${id}"`);
    const NOT_A_CLASS = new Set(PROBE_OUTCOME_IDS);
    // Tailwind's built-in palette. TeamLibraryPanel paints four categorical bot
    // glyphs from it on purpose — they are identity colours like the mascot's,
    // not theme surfaces, and Tailwind does generate them.
    const TAILWIND_PALETTE =
      /^(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(50|\d00)$/;

    // Properties no stylesheet declares because JavaScript writes them at
    // runtime (--vvh / --kb, from trackVisualViewport). Collected rather than
    // hardcoded, so adding one cannot make this assertion stale.
    const runtimeProperties = new Set(
      sourceFiles().flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/setProperty\(\s*"(--[\w-]+)"/g)].map(([, n]) => n),
      ),
    );

    const bad: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const [, name] of source.matchAll(utility)) {
        if (colorTokens.has(`--color-${name}`)) continue;
        if (NOT_A_TOKEN.has(name) || NOT_A_CLASS.has(name) || TAILWIND_PALETTE.test(name)) continue;
        bad.push(`${relative(root, file)}: -${name}`);
      }
      // Arbitrary values and inline styles reach for the property directly.
      // `var(--accent)` (the token is --color-accent) rendered nothing at all
      // in LocalVmWorkspace until this assertion existed.
      for (const [, name] of source.matchAll(/var\((--[\w-]+)/g)) {
        if (!css.includes(`${name}:`) && !runtimeProperties.has(name)) {
          bad.push(`${relative(root, file)}: var(${name})`);
        }
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  it("keeps raw hex out of everything but the allowlist", () => {
    // Warning-only upstream. Here it fails, because an allowlist someone has to
    // edit is a decision and a warning nobody reads is not.
    const ALLOWED: Record<string, string> = {
      "src/styles.css": "the palettes themselves",
      "src/mascot-preview.css": "a dev-only preview page, not shipped UI",
      "src/lib/mascot.ts": "EMBER_COLORS — agent identity, theme-invariant by design",
      "src/components/EmberAvatar.tsx": "the mascot's own gradients and flame tones",
      "src/components/Avatar.tsx": "mascot fallback tones",
      "src/components/ProviderIcons.tsx": "vendor brand marks (Anthropic, OpenAI, …)",
      "src/components/HermesMark.tsx": "vendor brand mark",
      "src/components/CursorMark.tsx": "vendor brand mark",
      "src/components/Sidebar.tsx":
        "macOS traffic-light decoration — it mimics the OS, so it cannot follow the theme",
      "src/components/PhoneSetupFlow.tsx":
        "QR code foreground/background — a scanner needs pure black on pure white",
      "src/components/CompanionSection.tsx":
        "the same QR, on the WebUI page — a scanner needs pure black on pure white",
      "src/components/RoutineCalendarPage.tsx":
        "calendar chip gradients mixed from EMBER_COLORS; theme-invariant like the mascot",
    };
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        // Tests are excluded: the rule is about SHIPPED UI, and a test that
        // asserts a palette value is asserting it, not styling with it.
        // `pwa-install.test.ts` has to name #f7f7f7 and #0a0a0a because those
        // are the exact theme-colour values index.html must carry — putting
        // it on the allowlist instead would say it was a styling exception,
        // which is the wrong reason for the right outcome. The Playwright
        // specs fill fixture canvases and iframe bodies with literal colours
        // for the same reason.
        else if (/\.(tsx?|css)$/.test(entry) && !isTestFile(entry)) files.push(path);
      }
    })(join(root, "src"));

    const offenders: string[] = [];
    for (const file of files) {
      // Comments are stripped first: `issue #527` in a ChatView comment is a
      // ticket number, not a colour.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      const hits = source.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (!hits) continue;
      const name = relative(root, file).replace(/\\/g, "/");
      if (!(name in ALLOWED)) offenders.push(`${name} (${hits.length}: ${hits[0]})`);
    }
    expect(offenders).toEqual([]);
    // The allowlist must not rot into a list of files that no longer exist.
    for (const name of Object.keys(ALLOWED)) {
      expect(`${name} exists`).toBe(
        files.some((file) => relative(root, file).replace(/\\/g, "/") === name) ? `${name} exists` : `${name} missing`,
      );
    }
  });
});
