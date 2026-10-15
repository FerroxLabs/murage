// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { EventLogMatcher, MATCH_SLICE_CHARS } from "./event-log-matcher.ts";

for (const count of [1000, 10000]) it(`${count} forgotten patterns: the same event visits the same character count in bounded slices`, async () => {
  const matcher = await EventLogMatcher.build(Array.from({ length: count }, (_, i) => `forgotten message ${i}`));
  const line = "f".repeat(MATCH_SLICE_CHARS * 3 + 17), slices: number[] = [];
  expect(await matcher.matchesSliced(line, chars => slices.push(chars))).toBe(false);
  expect(slices).toEqual([MATCH_SLICE_CHARS, MATCH_SLICE_CHARS, MATCH_SLICE_CHARS, 17]);
  expect(slices.reduce((sum, chars) => sum + chars, 0)).toBe(line.length);
});

it("matches overlapping prefixes, suffixes, escaped JSON and split surrogate pairs across slice boundaries", async () => {
  const patterns = ["abab", "bab", "aab", "界😀", '"turnId":"u1"', '\\"quoted\\"'];
  const matcher = await EventLogMatcher.build(patterns);
  for (const line of ["keep", "aaabab", "bbab", 'turnId:u1', '{"turnId":"u1"}', 'text \\"quoted\\"', ...patterns.map(p => "x".repeat(MATCH_SLICE_CHARS - 2) + p)]) {
    const expected = patterns.some(pattern => line.includes(pattern));
    expect(matcher.matches(line)).toBe(expected);
    expect(await matcher.matchesSliced(line)).toBe(expected);
  }
});
