// SPDX-License-Identifier: AGPL-3.0-or-later
// The bot colour names and the hex the app paints each one with. The app's mascot (src/lib/mascot.ts) and the
// server (the browser side panel, which draws #rrggbb only) read this one table, so a bot is the same colour everywhere.
export const EMBER_COLOR_HEX = {
  green: "#009957",
  blue: "#377FE6",
  red: "#D94B52",
  orange: "#FF6B35",
  purple: "#8057C8",
  cyan: "#0EA5C6",
  pink: "#D84F8B",
  yellow: "#D8A729",
  teal: "#01A492",
  coral: "#E5634E",
} as const;

/** #rrggbb for a bot colour: a name from the table, or a hex that is already valid. Anything else is undefined. */
export function botColorHex(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  const value = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  const named = (EMBER_COLOR_HEX as Record<string, string>)[value.toLowerCase()];
  return named;
}
