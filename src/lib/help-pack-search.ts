// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Search help in a language other than English (L-COPY r3, design section 5,
// option C). The docs route (/api/help/search) searches the English user docs,
// so in any other language the panel never calls it: it searches the active
// language's ready Help pack instead, here on the device. For each screen in
// the screens index it reads that pack's title, intro, tips and why, with
// placeholders filled the way the panel fills them, and ranks screens by the
// query words they share (a title word counts 3, any other 1). A result is
// only that pack's text: the screen's title and the line that matched. No
// URL, no docs text. Help chunk only.
import { stem, tokenize } from "../../shared/help-tokenize";
import { SCREENS, type ScreenIndexEntry } from "./screens-index";

export interface HelpPackResult {
  /** The screens index key, to open that screen's help. */
  key: string;
  title: string;
  /** The line that matched best (the intro when only the title did). */
  line: string;
  score: number;
}

export const HELP_PACK_RESULTS_MAX = 5;
const TITLE_WEIGHT = 3;

type Say = (key: string, params?: Record<string, string | number>) => string;

/** A query word meets a text word when they are the same, or (spaced
 *  scripts) share a stem: "backups" meets "backup". */
function meets(queryWord: string, words: ReadonlySet<string>, stems: ReadonlySet<string>): boolean {
  return words.has(queryWord) || (queryWord.length >= 4 && stems.has(stem(queryWord)));
}

function indexText(text: string): { words: Set<string>; stems: Set<string> } {
  const words = new Set(tokenize(text));
  return { words, stems: new Set([...words].filter((word) => word.length >= 4).map(stem)) };
}

/** The screens whose words in this pack match the query, best first, at most five. */
export function searchHelpPack(query: string, say: Say, params: Record<string, string>, screens: readonly ScreenIndexEntry[] = SCREENS): HelpPackResult[] {
  const wanted = [...new Set(tokenize(query))];
  if (!wanted.length) return [];
  const results: HelpPackResult[] = [];
  for (const entry of screens) {
    const title = say(entry.title, params);
    const titleIndex = indexText(title);
    const lines = [entry.intro, ...entry.tips, entry.why].map((key) => say(key, params));
    const lineIndexes = lines.map(indexText);
    let score = 0;
    let bestLine = -1;
    let bestLineHits = 0;
    const lineHits = lines.map(() => 0);
    for (const word of wanted) {
      if (meets(word, titleIndex.words, titleIndex.stems)) score += TITLE_WEIGHT;
      let inLines = false;
      lineIndexes.forEach((index, at) => {
        if (meets(word, index.words, index.stems)) { lineHits[at] = lineHits[at]! + 1; inLines = true; }
      });
      if (inLines) score += 1;
    }
    if (!score) continue;
    lineHits.forEach((hits, at) => { if (hits > bestLineHits) { bestLineHits = hits; bestLine = at; } });
    results.push({ key: entry.key, title, line: lines[bestLine >= 0 ? bestLine : 0]!, score });
  }
  results.sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
  return results.slice(0, HELP_PACK_RESULTS_MAX);
}
