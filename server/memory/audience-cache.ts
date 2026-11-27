// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { dataVersion } from "./data-version.ts";
import type { MemoryRoster } from "./policy.ts";
import { eligibilityPassActive } from "./eligibility-pass.ts";

const epochs = new WeakMap<DatabaseSync, StatementSync>();
const answers = new WeakMap<DatabaseSync, WeakMap<MemoryRoster, Map<string, { stamp: string; value: readonly string[] }>>>();
const counters = { hits: 0, misses: 0, computes: 0 };
/** Tests only: snapshots, so callers can measure one turn without resetting other readers. */
export function audienceCacheCounters(): Readonly<typeof counters> { return { ...counters }; }

/** The complete audience read set. Per-turn learning bookkeeping does not move
 * this epoch. Human binding rows also affect principal validation/group identity.
 * Team identities and project settings select partitions even without a roster
 * save. data_version covers other connections; these triggers cover our writes.
 * OLD and NEW both count: changing a row out of the read set must invalidate. */
function epochStatement(db: DatabaseSync): StatementSync | undefined {
  if (db.isTransaction || eligibilityPassActive()) return undefined;
  try {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS memory_audience_epoch(n INTEGER NOT NULL);
      INSERT INTO memory_audience_epoch(n) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM memory_audience_epoch);`);
    const relevant = (row: string) => `${row}.id='memory-owner-settings' OR ${row}.subject_type IN ('human-thread','human-binding','room','bot','person')`;
    for (const [suffix, event, when] of [
      ["i", "INSERT", relevant("NEW")], ["u", "UPDATE", `${relevant("OLD")} OR ${relevant("NEW")}`], ["d", "DELETE", relevant("OLD")],
    ]) {
      for (const table of ["memory_scopes", "team_identities", "project_settings"]) {
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS memory_audience_${table}_${suffix} AFTER ${event} ON main.${table} BEGIN UPDATE memory_audience_epoch SET n=n+1; END;`);
      }
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS memory_audience_bindings_${suffix} AFTER ${event} ON main.memory_scope_bindings WHEN ${when} BEGIN UPDATE memory_audience_epoch SET n=n+1; END;`);
    }
    return db.prepare(`SELECT n,
      (SELECT policy_revision FROM memory_meta WHERE id=1) AS policy_revision,
      (SELECT deletion_epoch FROM memory_meta WHERE id=1) AS deletion_epoch,
      (SELECT epoch FROM memory_recall_epoch WHERE id=1) AS recall_epoch FROM temp.memory_audience_epoch`);
  } catch { return undefined; }
}

export function audienceStamp(db: DatabaseSync, roster: MemoryRoster): string | undefined {
  // A transactional answer can depend on writes that roll back, reusing an
  // epoch number later. Never reuse or store it, even if the epoch already exists.
  if (roster.memoryRosterRevision === undefined || db.isTransaction) return undefined;
  let epoch = epochs.get(db);
  if (!epoch) { epoch = epochStatement(db); if (epoch) epochs.set(db, epoch); }
  if (!epoch) return undefined;
  try {
    // other connections' commits: the PRAGMA statement on this connection, never the shadowable table-valued form (data-version.ts)
    const row = epoch.get(), version = dataVersion(db);
    return row && version !== undefined ? `${roster.memoryRosterRevision}:${row.policy_revision}:${row.deletion_epoch}:${row.n}:${version}:${row.recall_epoch}` : undefined;
  } catch { epochs.delete(db); return undefined; }
}

/** The same frozen answer across turns. Connection and roster identity isolate
 * equal numeric stamps belonging to different installations or Store instances. */
export function cachedEligible(key: string, stamp: string | undefined, compute: () => readonly string[], context: { db: DatabaseSync; roster: MemoryRoster }): readonly string[] {
  let byRoster = answers.get(context.db);
  if (!byRoster) answers.set(context.db, byRoster = new WeakMap());
  let cache = byRoster.get(context.roster);
  if (!cache) byRoster.set(context.roster, cache = new Map());
  const known = cache.get(key);
  if (stamp !== undefined && known?.stamp === stamp) { counters.hits++; return known.value; }
  counters.misses++; counters.computes++;
  const fresh = Object.freeze(compute());
  // Scope creation while deriving the answer is a write, not a stable read.
  if (stamp !== undefined && audienceStamp(context.db, context.roster) === stamp) {
    if (cache.size >= 4096) cache.clear();
    cache.set(key, { stamp, value: fresh });
  }
  return fresh;
}

/** Share an independently constructed exact immutable answer with an already proven legacy cache entry.
 * Never create an answer or bless a computation whose stamp changed while it ran. */
export function sharePreparedAudience(db:DatabaseSync,roster:MemoryRoster,key:string,value:readonly string[]):void {
  const entry=answers.get(db)?.get(roster)?.get(key),stamp=audienceStamp(db,roster);
  if(entry&&stamp!==undefined&&entry.stamp===stamp)entry.value=value;
}
