// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How the helper answers one search: the records the reader's scopes make eligible, ranked by words and by meaning, as
// two candidate lists. The helper cannot tell which candidates the reader may read (that is readable.ts, in the main
// thread), so it ranks nothing the reader sees: the lists, and the counts beside them, stay inside the process until the
// main thread has checked each candidate and ranked what is left (search.ts).
//
// The eligible set can be larger than the vectors the helper keeps resident. The helper does not page it for the reader
// (how many records are eligible includes records the reader may not read, and a page boundary or a cursor would show
// it): it scans the set in resident-sized chunks inside one budget, keeping the most similar candidates over all of them,
// and reports only where it stopped. Whether that stop matters (a record the reader may READ lies past it) is decided
// in the main process, after authorization.
import type { MemoryEligibility } from "./eligibility.ts";
import type { IndexHit, MemoryIndex } from "./index.ts";
import { byScore, compareRefs } from "./ref-order.ts";
import { SEARCH_LIST_DEPTH, UNVECTORED_LIMIT, type MemorySearchInput, type MemorySearchResult, type RankedRef } from "./worker-protocol.ts";

/** What one search's scan may spend: chunks (8 x 12,000 records) and milliseconds from the start of the answer, whichever
 * ends first (it also ends at the search's own deadline). Mutable only so tests can end a scan early. */
export const scanLimits = { chunks: 8, budgetMs: 700 };

export function answerQuery(index: MemoryIndex, eligibility: MemoryEligibility, input: MemorySearchInput, vector: number[] | null, identity: string, degraded?: string, now: () => number = Date.now): { result: MemorySearchResult; eligibilityMs: number; timings: Record<string, number> } {
  const started = performance.now(), wallStart = now();
  let eligible = eligibility.read(input);
  const eligibilityMs = performance.now() - started;
  let degradedReason = degraded;
  const usable = input.semantic ? vector : null;
  let found;
  try { found = index.search(input.query, eligible.allowed, usable, identity, input.limit); }
  catch { found = index.search(input.query, eligible.allowed, null, identity, input.limit); degradedReason = "semantic-index-unavailable"; }
  const semanticRan = usable !== null && degradedReason !== "semantic-index-unavailable";
  const { timings, ...rest } = found;
  let { hits, vectorRows, vectorRanked, unvectored, unvectoredMore } = rest;
  const lexicalRanked = rest.lexicalRanked;
  let resumeAfter: string | undefined;
  if (semanticRan && eligible.capacity) {
    // Continue over the rest of the eligible set, a chunk at a time, until it ends or the budget does.
    const deadline = Math.min(input.deadlineAt ?? Infinity, wallStart + scanLimits.budgetMs);
    let best: Array<{ id: string; version: number; similarity: number }> = vectorRanked.map(ref => ({ id: ref[0], version: ref[1], similarity: ref[2]! }));
    const missing = [...unvectored ?? []];
    let more = Boolean(unvectoredMore);
    for (let chunk = 1; eligible.capacity; chunk++) {
      if (chunk >= scanLimits.chunks || now() >= deadline) { resumeAfter = eligible.nextCursor; break; }
      const previous = eligible;
      eligible = eligibility.read({ ...input, cursor: previous.nextCursor! });
      let part;
      // A chunk that cannot be scored ends the scan where the last good chunk ended: what is left is reported, never skipped.
      try { part = index.search(input.query, eligible.allowed, usable, identity, input.limit, { words: false, resident: false }); }
      catch { resumeAfter = previous.nextCursor; break; }
      vectorRows += part.vectorRows;
      best = best.concat(part.vectorRanked.map(ref => ({ id: ref[0], version: ref[1], similarity: ref[2]! })));
      best.sort((a, b) => b.similarity - a.similarity || compareRefs(a, b));
      best.length = Math.min(best.length, SEARCH_LIST_DEPTH);
      for (const ref of part.unvectored ?? []) { if (missing.length >= UNVECTORED_LIMIT) { more = true; break; } missing.push(ref); }
      more = more || Boolean(part.unvectoredMore);
    }
    vectorRanked = best.map(row => [row.id, row.version, row.similarity] as RankedRef) as typeof vectorRanked;
    unvectored = missing; unvectoredMore = more;
    hits = fuse(lexicalRanked, best).slice(0, input.limit);
  }
  // Neither list went past the first chunk when meaning search did not run: say so.
  if (!semanticRan && eligible.capacity) resumeAfter = eligible.nextCursor;
  const semanticFinal = semanticRan;
  const result: MemorySearchResult = {
    hits, vectorRows, lexicalRanked, vectorRanked,
    ...semanticFinal && unvectored !== undefined ? { unvectored, unvectoredMore: Boolean(unvectoredMore), vectorModel: identity } : {},
    ...semanticFinal ? {} : { coverageComplete: false },
    ...degradedReason ? { degradedReason } : {},
    ...resumeAfter !== undefined ? { resumeAfter } : {},
  };
  return { result, eligibilityMs, timings };
}

/** The helper's own scored list (older callers and the answer cache read it): reciprocal rank fusion of the two lists' tops. */
function fuse(lexical: RankedRef[], meaning: Array<{ id: string; version: number; similarity: number }>): IndexHit[] {
  const fused = new Map<string, IndexHit>();
  lexical.slice(0, 60).forEach((ref, index) => fused.set(`${ref[0]}:${ref[1]}`, { id: ref[0], version: ref[1], score: 1 / (60 + index + 1), lexical: true }));
  meaning.slice(0, 60).forEach((row, index) => {
    const key = `${row.id}:${row.version}`, previous = fused.get(key);
    fused.set(key, { id: row.id, version: row.version, score: (previous?.score ?? 0) + 1 / (60 + index + 1), similarity: row.similarity, lexical: previous?.lexical ?? false });
  });
  return [...fused.values()].sort(byScore);
}
