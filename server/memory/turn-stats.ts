// Counts for the memory.bundle and memory.assemble trace lines
// (MURAGE_TURN_TRACE=1). Numbers only: hits returned, search milliseconds,
// lineage rows read, lineage verdict cache hits and misses. A turn takes a
// snapshot before the work and reports the difference after it.
import { lineageCacheCounts, replayRowsRead } from "./replay-lineage.ts";

let searchHits = 0, searchMs = 0, searches = 0, prepMs = 0, bridgeMs = 0, hydrationMs = 0;
/** `phases` splits the milliseconds: synchronous preparation, the wait for the worker, hydration. */
export function noteMemorySearch(hits: number, ms: number, phases?: { prepMs: number; bridgeMs: number; hydrationMs: number }): void {
  searches++; searchHits += hits; searchMs += ms;
  if (phases) { prepMs += phases.prepMs; bridgeMs += phases.bridgeMs; hydrationMs += phases.hydrationMs; }
}

export interface MemoryStats { searches: number; hits: number; searchMs: number; lineageRows: number; prepMs: number; bridgeMs: number; hydrationMs: number; cacheHits: number; cacheMisses: number }
export function memoryStatsSnapshot(): MemoryStats {
  const cache = lineageCacheCounts();
  return { searches, hits: searchHits, searchMs, lineageRows: replayRowsRead(), prepMs, bridgeMs, hydrationMs, cacheHits: cache.hits, cacheMisses: cache.misses };
}
/** What happened since `before`, as trace details. */
export function memoryStatsSince(before: MemoryStats): Record<string, number> {
  const now = memoryStatsSnapshot();
  return { hits: now.hits - before.hits, searchMs: Math.round(now.searchMs - before.searchMs), lineageRows: now.lineageRows - before.lineageRows,
    searchPrepMs: Math.round(now.prepMs - before.prepMs), searchBridgeMs: Math.round(now.bridgeMs - before.bridgeMs), searchHydrationMs: Math.round(now.hydrationMs - before.hydrationMs),
    lineageHit: now.cacheHits - before.cacheHits, lineageMiss: now.cacheMisses - before.cacheMisses };
}
