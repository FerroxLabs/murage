// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Short "what is new" lines from an update's release notes (plain text, see electron/release-notes-text.mjs).
// Idea from OpenMaus (Apache-2.0, src/lib/release-highlights.ts). Text only: nothing here is ever rendered as markup.

export const HIGHLIGHT_MAX = 5;
export const HIGHLIGHT_LENGTH = 140;

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const NOISE = /^(?:full changelog|what'?s changed|changelog|new contributors?|assets?|downloads?)\b/i;

function plain(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\s*(?:\(|\[)?#\d+(?:\)|\])?/g, "")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(line: string): string {
  if (line.length <= HIGHLIGHT_LENGTH) return line;
  const cut = line.slice(0, HIGHLIGHT_LENGTH - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Up to five short lines: the bullets if the notes have any, otherwise their first lines. */
export function releaseHighlights(text: string | undefined, max = HIGHLIGHT_MAX): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  const bullets = lines.map((line) => BULLET.exec(line)?.[1]).filter((line): line is string => line !== undefined);
  const source = bullets.length ? bullets : lines.filter((line) => !/^\s*#/.test(line));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source) {
    const line = clip(plain(raw));
    if (line.length < 4 || NOISE.test(line) || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}
