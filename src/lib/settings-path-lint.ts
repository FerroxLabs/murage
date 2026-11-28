// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 L1: the one place a path to a setting is written is lib/settings-links.ts, so no other file spells a
// literal "Settings" followed by a path separator. Four separators are caught, as the character or as its \\u escape: ">", "›", "→" and "->" (the shipped
// refusal at server/bot-access.ts:208 uses "→", which the older lint missed). Plain text work, no index and no words.
export const SETTINGS_PATH_SEPARATORS = [">", "›", "→", "->", "\\u203a", "\\u2192"] as const;

const PATH_LITERAL = /\bSettings\s*(?:->|>|›|→|\\u203a|\\u2192)/g;

/** How many times a source text spells "Settings" followed by a path separator. */
export function countSettingsPathLiterals(text: string): number {
  return (text.match(PATH_LITERAL) ?? []).length;
}

/** 1-based lines that spell one, for a failure message. */
export function settingsPathLiteralLines(text: string): number[] {
  const lines: number[] = [];
  text.split("\n").forEach((line, index) => { if (countSettingsPathLiterals(line) > 0) lines.push(index + 1); });
  return lines;
}
