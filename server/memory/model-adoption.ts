// When the app's own model first verifies, records that were indexed while no
// model existed (embedding_status 'unavailable') are owed an embedding. This
// re-queues them in bounded batches, yielding between batches, exactly once at
// a time, and records completion durably so a restart does not repeat it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import { setBundledModelVerifiedHook } from "./model-location.ts";
import type { SemanticIndexStatus } from "../../shared/memory-learning-contract.ts";

export const ADOPTION_MARKER = "memory-model-adopted.json";
export const ADOPTION_BATCH = 500;

let inflight: Promise<void> | null = null;
/** Records re-queued by the run in flight, for the status while it runs. */
let requeued = 0;

interface AdoptionMarker { revision?: string; completedAt?: number; total?: number; caughtUpAt?: number }
function readMarker(dataDir: string): AdoptionMarker | null {
  try { const value = JSON.parse(readFileSync(join(dataDir, ADOPTION_MARKER), "utf8")); return value && typeof value === "object" ? value : null; } catch { return null; }
}
function writeMarker(dataDir: string, marker: AdoptionMarker) {
  const path = join(dataDir, ADOPTION_MARKER);
  writeFileSync(`${path}.tmp`, JSON.stringify(marker));
  renameSync(`${path}.tmp`, path);
}

export function adoptionComplete(revision: string, dataDir = DATA_DIR): boolean {
  return readMarker(dataDir)?.revision === revision;
}

const ADOPT_FILTER = "embedding_status='unavailable' AND lexical_status='indexed'";
/** A rebuild re-embeds every indexed record, not only those indexed while no model existed. */
const REBUILD_FILTER = "embedding_status IN ('unavailable','indexed','ready') AND lexical_status IN ('indexed','ready')";

export function adoptBundledModel(manifest: { revision?: string }, options: { dataDir?: string; batch?: number; rebuild?: boolean } = {}): Promise<void> {
  const revision = manifest.revision ?? "", dataDir = options.dataDir ?? DATA_DIR, batch = options.batch ?? ADOPTION_BATCH;
  if (inflight) return inflight;
  if (adoptionComplete(revision, dataDir)) return Promise.resolve();
  requeued = 0;
  const run = (async () => {
    try {
      const update = database().prepare(`UPDATE memory_projection_receipts SET lexical_status='pending',embedding_status='pending'
        WHERE rowid IN (SELECT rowid FROM memory_projection_receipts WHERE ${options.rebuild ? REBUILD_FILTER : ADOPT_FILTER} LIMIT ?)`);
      for (;;) {
        const changed = Number(update.run(batch).changes);
        requeued += changed;
        if (changed < batch) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      writeMarker(dataDir, { revision, completedAt: Date.now(), total: requeued });
    } catch { /* not marked complete: the next start repeats it, and the update is idempotent */ }
  })().finally(() => { inflight = null; });
  inflight = run;
  return run;
}

/** Memory settings "rebuild-index": rewinds the marker and starts the same batched run in the background. It returns at once
 * (`done` settles when the run ends, for tests); a request while a run is in flight attaches to nothing and starts nothing. */
export function rebuildSearchIndex(manifest: { revision?: string }, options: { dataDir?: string; batch?: number } = {}): { running: true; started: boolean; done: Promise<void> } {
  if (inflight) return { running: true, started: false, done: inflight };
  writeMarker(options.dataDir ?? DATA_DIR, {});
  return { running: true, started: true, done: adoptBundledModel(manifest, { ...options, rebuild: true }) };
}

/** Pending projections counted per status read, at most (keyed by memory_projection_pending, never a whole-table count). */
export const SEMANTIC_PENDING_CAP = 50_000;

/** `status.semantic` (SETTINGS-LANES.md I0). "indexing" from adoption until the records it re-queued have their embeddings, with
 * done/total over those records; the first read that finds none pending records it, so later everyday indexing never shows as "indexing". */
export function semanticIndexStatus(input: { nativeSupported: boolean; model: "missing" | "unverified" | "downloading" | "ready" | "failed"; revision: string }, dataDir = DATA_DIR): SemanticIndexStatus {
  if (!input.nativeSupported || input.model === "missing" || input.model === "failed" || input.model === "downloading") return { state: "keyword-only", done: 0, total: 0 };
  const marker = readMarker(dataDir), mine = marker?.revision === input.revision ? marker : null;
  if (mine?.caughtUpAt) return { state: "ready", done: mine.total ?? 0, total: mine.total ?? 0 };
  if (input.model === "unverified") return { state: "indexing", done: 0, total: 0 };
  const total = inflight ? requeued : mine ? mine.total ?? 0 : null;
  if (total === null) return { state: "indexing", done: 0, total: 0 }; // adoption has not run yet for this revision
  let pending = 0;
  try {
    pending = Number(database().prepare("SELECT count(*) AS n FROM (SELECT 1 FROM memory_projection_receipts WHERE lexical_status='pending' AND embedding_status='pending' LIMIT ?)").get(SEMANTIC_PENDING_CAP)?.n ?? 0);
  } catch { return { state: "indexing", done: 0, total }; }
  if (!inflight && mine && pending === 0) {
    try { writeMarker(dataDir, { ...mine, caughtUpAt: Date.now() }); } catch { /* the next read records it */ }
    return { state: "ready", done: total, total };
  }
  return { state: "indexing", done: Math.max(0, total - Math.min(pending, total)), total };
}

setBundledModelVerifiedHook((manifest) => { void adoptBundledModel(manifest); });
