// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The interface font, chosen apart from the light or dark skin (B86). Like the
// skins it is pure CSS: each choice but the default is one `:root[data-font]`
// block in styles.css that sets `--font-sans`; this module only says which one
// is on and remembers it on this machine. "default" removes the attribute, so
// the skin's own font applies untouched.

export const FONT_IDS = ["default", "system", "serif", "rounded"] as const;
export type FontId = (typeof FONT_IDS)[number];

export const DEFAULT_FONT: FontId = "default";

/** Settings > Appearance labels, in FONT_IDS order. */
export const FONT_LABELS: Record<FontId, string> = {
  default: "Default",
  system: "System",
  serif: "Serif",
  rounded: "Rounded",
};

const KEY = "murage-font";

export function isFontId(value: unknown): value is FontId {
  return typeof value === "string" && (FONT_IDS as readonly string[]).includes(value);
}

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readFont(): FontId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isFontId(stored) ? stored : DEFAULT_FONT;
  } catch {
    return DEFAULT_FONT;
  }
}

/** Stamp the font on <html> and remember it. Runs once before the first React
 *  paint (main.tsx) and again on each change in Settings. */
export function applyFont(id: FontId): void {
  const font = isFontId(id) ? id : DEFAULT_FONT;
  if (font === DEFAULT_FONT) delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = font;
  try {
    getStore()?.setItem(KEY, font);
  } catch {
    // storage full or blocked: the font still holds for this window
  }
}
