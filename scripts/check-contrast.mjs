#!/usr/bin/env node
// Measures the palette in src/styles.css against WCAG 2.1 AA.
//
//   node scripts/check-contrast.mjs        (or: pnpm check:contrast)
//
// It parses the stylesheet instead of keeping a second copy of the values, so
// the check can never pass against a palette that is no longer the shipped
// one. Two things it does that a quick eyeball does not:
//
//   - composites alpha. --color-ink-secondary is #fcfcfc99, and measuring it
//     as opaque #fcfcfc overstates every secondary-text pair in the app.
//   - measures white on filled surfaces, which is what the components
//     actually render (`bg-accent … text-white`), not the token against the
//     page ground.
//
// The two pairs already below AA are listed in KNOWN below, so adopting this
// check does not force a palette change in the same commit. Anything new
// fails the run.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

/** Custom properties from @theme and :root, in cascade order. */
function parseTokens(source) {
  const tokens = {};
  for (const [, body] of source.matchAll(/(?:@theme|:root)[^{]*\{([^}]*)\}/g)) {
    for (const [, name, value] of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
  }
  return tokens;
}

/** #rgb, #rrggbb and #rrggbbaa → {r,g,b,a} with channels in 0..1. */
function parseColor(value) {
  const h = value.replace("#", "").trim();
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return null;
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

/** Lay a possibly-translucent colour over an opaque one. */
function composite(fg, bg) {
  if (fg.a === 1) return fg;
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fgValue, bgValue) {
  const bg = parseColor(bgValue);
  const fg = parseColor(fgValue);
  if (!fg || !bg) return null;
  if (bg.a !== 1) return null; // a translucent ground has no single answer
  const [hi, lo] = [luminance(composite(fg, bg)), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "--color-app",
  "--color-panel",
  "--color-raised",
  "--color-card",
  "--color-inset",
];

// AA asks 4.5:1 of body text and 3:1 of non-text indicators (1.4.11).
const PAIRS = [
  // body and secondary text on every ground a panel can sit on
  ...SURFACES.map((s) => ["--color-ink", s, 4.5, "body text"]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5, "secondary text (60% alpha)"]),
  ["--color-ink", "--color-bubble-user", 4.5, "your own messages"],
  // what the filled buttons actually render: white on a solid accent/danger
  ["#ffffff", "--color-accent", 4.5, "primary buttons — bg-accent + text-white"],
  ["#ffffff", "--color-danger", 4.5, "destructive buttons — bg-danger + text-white"],
  // coloured text on a ground
  ["--color-accent", "--color-app", 4.5, "accent as text/links"],
  ["--color-accent", "--color-card", 4.5, "accent as text on a card"],
  ["--color-danger", "--color-card", 4.5, "error text"],
  ["--color-success", "--color-card", 4.5, "success text"],
  ["--color-warning", "--color-card", 4.5, "warning text"],
  // indicators: outline, not glyphs
  ["--color-focus", "--color-app", 3, "focus ring"],
  ["--color-focus", "--color-panel", 3, "focus ring on a panel"],
  ["--color-accent-border", "--color-card", 3, "accent border"],
];

// Below AA on the current palette. Listed so this check can be adopted
// without changing a colour in the same commit — and so that fixing one is a
// visible deletion here rather than a silent pass. Where each one shows up:
//
//   white on accent  3.65:1  every primary button, 12–13px — Composer send,
//                            EngineSetup install, ComputerPanel start, the
//                            Onboarding and Routines actions (28 sites)
//   white on danger  3.10:1  CallView.tsx:532 / GroupCallView.tsx:492, the
//                            hang-up buttons, 14px
//   accent on card   4.15:1  accent links inside a Card — ApiKeys.tsx:121
//                            (12px), EnginesSettings.tsx:241 (11.5px)
//
// Note the shape of the problem before changing anything: --color-accent
// reads fine as text on the page ground (5.33:1 on --color-app) and only
// falls short on the lighter card, while white falls short ON the accent.
// Darkening the one token fixes the buttons and hurts the links, so the fix
// is a separate fill colour, not a nudge — a design call, which is why this
// check only measures.
const KNOWN = new Set([
  "#ffffff on --color-accent",
  "#ffffff on --color-danger",
  "--color-accent on --color-card",
]);

const tokens = parseTokens(css);
const resolve = (name) => (name.startsWith("--") ? tokens[name] : name);

let failed = false;
const carried = [];
let measured = 0;

for (const [fg, bg, min, where] of PAIRS) {
  const fgValue = resolve(fg);
  const bgValue = resolve(bg);
  if (!fgValue || !bgValue) {
    // An unmeasurable pair is reported, never skipped: silently passing over
    // a renamed token is how a check quietly stops checking.
    console.log(`✗ undefined token in pair: ${fg} on ${bg}`);
    failed = true;
    continue;
  }
  const ratio = contrast(fgValue, bgValue);
  if (ratio === null) {
    console.log(`✗ cannot measure ${fg} on ${bg} (${fgValue} on ${bgValue})`);
    failed = true;
    continue;
  }
  measured++;
  if (ratio >= min) continue;

  const line = `${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1) — ${where}`;
  if (KNOWN.has(`${fg} on ${bg}`)) {
    carried.push(line);
  } else {
    console.log(`✗ ${line}`);
    failed = true;
  }
}

if (carried.length) {
  console.log("Known, carried (listed in KNOWN):");
  for (const line of carried) console.log(`  ~ ${line}`);
}
console.log(
  failed
    ? `\n${measured} pairs measured — new contrast failures above.`
    : `\n✓ ${measured} pairs measured, no new failures.`,
);
process.exit(failed ? 1 : 0);
