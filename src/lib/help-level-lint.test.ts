// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 3.5 (L02): help never proposes a level higher than
// the question needs. A sentence that proposes a level (switch, turn on,
// use, choose, pick or set within six words of "Full access" or "No limits")
// may appear only in an entry whose `where` or url is the approvals or
// levels page; every other entry that names those levels states a fact.
// The concierge answers from this same index (shared/help-index.ts).
//
// The help index and the docs belong to L-COPY-D. The entries that propose a
// level today are listed in KNOWN_OFFENDERS (owner: L-COPY-D, train 1.0.13),
// so this test reports any NEW offender and any listed one that was fixed.
import { describe, expect, it } from "vitest";
import { HELP_INDEX, type HelpEntry } from "../../shared/help-index";

const VERBS = /^(?:switch|switching|turn|turning|use|using|choose|choosing|pick|picking|set|setting)$/i;
const LEVEL = /\b(?:Full access|No limits)\b/i;
const NEGATION = /^(?:never|not|cannot|can't|won't|don't|doesn't)$/i;

/** The approvals or levels page: where proposing a level is the point. */
export function levelsPage(entry: Pick<HelpEntry, "where" | "url">): boolean {
  return /approv|permission|level/i.test(`${entry.where} ${entry.url}`);
}

/** A sentence that proposes a level: a verb within six words of a level's name. */
export function proposesLevel(sentence: string): boolean {
  const match = LEVEL.exec(sentence);
  if (!match) return false;
  const before = sentence.slice(0, match.index).split(/\s+/).filter(Boolean).slice(-6);
  const after = sentence.slice(match.index + match[0].length).split(/\s+/).filter(Boolean).slice(0, 6);
  const word = (token: string) => token.replace(/[^A-Za-z']/g, "");
  const near = [...before, ...after].map(word);
  // "the phone can never switch on Full access" states a fact
  if (near.some((token) => NEGATION.test(token))) return false;
  return near.some((token) => VERBS.test(token));
}

export function levelOffenders(index: readonly HelpEntry[]): string[] {
  const found: string[] = [];
  for (const entry of index) {
    if (levelsPage(entry)) continue;
    const sentences = entry.text.split(/(?<=[.!?])\s+|\n+/);
    sentences.forEach((sentence, line) => {
      if (proposesLevel(sentence)) found.push(`${entry.id}:${line}`);
    });
  }
  return found;
}

/** Owner: L-COPY-D (docs and help index), 1.0.13. Each is an entry id and the
 * sentence's position in its text; fix the sentence, then drop it here. */
export const KNOWN_OFFENDERS: readonly string[] = [];

describe("3.5 help lint: no level is proposed outside the levels page", () => {
  it("finds a proposal and lets a fact stand", () => {
    expect(proposesLevel("Switch to Full access to stop the cards.")).toBe(true);
    expect(proposesLevel("You can turn on No limits in Settings.")).toBe(true);
    expect(proposesLevel("Full access still asks before paying.")).toBe(false);
    expect(proposesLevel("The phone can never switch on Full access or No limits.")).toBe(false);
    expect(levelsPage({ where: "Settings › Nova › Level", url: "https://murage.ai/docs/x" })).toBe(true);
  });
  it("lists every offender with its id and line; only the known ones remain", () => {
    const found = levelOffenders(HELP_INDEX);
    const fresh = found.filter((id) => !KNOWN_OFFENDERS.includes(id));
    expect(fresh, `new help text proposes a level outside the levels page: ${fresh.join(", ")}`).toEqual([]);
    expect(KNOWN_OFFENDERS.filter((id) => !found.includes(id)), "fixed: drop these from KNOWN_OFFENDERS").toEqual([]);
  });
});
