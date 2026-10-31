#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contrast for the UX overhaul surfaces (slice 8), in both palettes: the soft chips and bands (a status colour as
// text on its own tinted ground), the Needs you badge, the landing ring and the Undo toast. It reads the palettes out
// of src/styles.css, the same way scripts/check-skin-contrast.mjs does, so it can never pass against values that are
// not the shipped ones. That script covers the base pairs (ink on every surface, the focus ring on the grounds); this
// one covers what the overhaul adds on top.
//
//   node scripts/a11y/contrast.mjs        prints every pair, exits 1 when one is under its target
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TONES = [
  ["accent", "--color-accent-text"],
  ["success", "--color-success"],
  ["warning", "--color-warning"],
  ["danger", "--color-danger"],
];

/** [foreground, background, minimum ratio, why]. Text asks 4.5:1 (WCAG 1.4.3); a ring, a badge edge or a mark asks
 * 3:1 (1.4.11); a tinted ground only has to be seen as a ground, a just-perceptible step against the card it sits on. */
export const PAIRS = [
  ...TONES.flatMap(([tone, text]) => [
    [text, `--color-${tone}-soft`, 4.5, `${tone} chip label on its soft ground`],
    ["--color-ink", `--color-${tone}-soft`, 4.5, `body text in a ${tone} band`],
    ["--color-ink-secondary", `--color-${tone}-soft`, 4.5, `secondary text in a ${tone} band`],
    ["--color-focus", `--color-${tone}-soft`, 3, `focus ring on a control inside a ${tone} band`],
    [`--color-${tone}-soft`, "--color-card", 1.06, `${tone} soft ground seen on a card`],
    [`--color-${tone}-soft`, "--color-app", 1.04, `${tone} soft ground seen on the app ground`],
  ]),
  ["--color-accent-ink", "--color-accent", 4.5, "Needs you badge count"],
  ["--color-accent", "--color-panel", 3, "Needs you badge on the rail"],
  ["--color-accent", "--color-app", 3, "landing ring on the app ground"],
  ["--color-accent", "--color-card", 3, "landing ring on a card"],
  ["--color-accent-soft", "--color-ink", 4.5, "Undo on the toast (ink ground)"],
  ["--color-app", "--color-ink", 4.5, "toast message (app colour on ink)"],
];

function declarations(body) {
  const tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[name] = value.trim();
  return tokens;
}

/** id → tokens, every `[data-skin]` block over the `@theme` and `:root` base, as each palette renders. */
export function parsePalettes(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const base = {};
  for (const [, body] of source.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)) Object.assign(base, declarations(body));
  const palettes = new Map();
  for (const [, id, body] of source.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)) palettes.set(id, { ...base, ...declarations(body) });
  return palettes;
}

function parseHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const h = match[1].length === 3 ? Array.from(match[1], (c) => c + c).join("") : match[1];
  return [0, 2, 4].map((at) => parseInt(h.slice(at, at + 2), 16));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast of two opaque hex colours, or null when either is not one. */
export function contrast(fgHex, bgHex) {
  const fg = parseHex(fgHex), bg = parseHex(bgHex);
  if (!fg || !bg) return null;
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every pair in every palette. A pair that cannot be measured (a token missing, or not an opaque hex) is a failure,
 * never a skip: an unmeasured pair once counted as a passing one in the older script. */
export function measure(css) {
  const rows = [];
  for (const [palette, tokens] of parsePalettes(css)) {
    for (const [fg, bg, min, why] of PAIRS) {
      const ratio = tokens[fg] && tokens[bg] ? contrast(tokens[fg], tokens[bg]) : null;
      rows.push({ palette, fg, bg, min, why, ratio, pass: ratio !== null && ratio >= min });
    }
  }
  return rows;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rows = measure(readFileSync(join(root, "src/styles.css"), "utf8"));
  for (const row of rows) {
    const shown = row.ratio === null ? "unmeasurable" : `${row.ratio.toFixed(2)}:1`;
    console.log(`${row.pass ? "ok  " : "FAIL"} ${row.palette.padEnd(6)} ${row.fg} on ${row.bg}: ${shown} (needs ${row.min}:1) ${row.why}`);
  }
  const failed = rows.filter((row) => !row.pass).length;
  console.log(failed ? `${failed} pair(s) under target` : `${rows.length} pairs, none under target`);
  process.exit(failed ? 1 : 0);
}
