// What a procedure-evidence verdict and the set of identity sources rest on,
// as one counter that moves only when those rows can have changed. Ordinary
// message writes and new source captures do not move it, so the memos built
// on it survive the constant writing a running server does.
//
// The counter lives in a temp table of this connection, bumped by temp
// triggers on the rows a verdict reads: records (any insert, update, delete),
// record details, evidence, derivations, tombstones, a source whose revision
// or state changes (or that is deleted), and the policy revision, deletion
// epoch and mode. Inside a transaction there is no stamp (a write may roll
// back), so nothing is remembered from there.
import { withoutDroppedTableTriggers } from "./read-time-retired.ts";
import type { DatabaseSync } from "node:sqlite";
import { turnTraceEnabled } from "../turn-trace.ts";
import { ancestryUnrepaired, connectionId } from "../database.ts";
import { Worker } from "node:worker_threads";
import { buildOptionalIndexOffThread, databaseFile, optionalIndexReady } from "./optional-index.ts";
import { IDENTITY_CANON, IDENTITY_CANON_INDEX, IDENTITY_PARTITION, IDENTITY_PARTITION_INDEX } from "./schema.ts";

// Trigger bodies name their write target unqualified: SQLite forbids a
// qualified one there, and an unqualified name resolves to the temp table.
const BUMP = "UPDATE provenance_epoch SET n=n+1";
const SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS provenance_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.provenance_epoch VALUES(1,0);
CREATE TEMP TRIGGER IF NOT EXISTS prov_records_i AFTER INSERT ON main.memory_records BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_records_u AFTER UPDATE ON main.memory_records BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_records_d AFTER DELETE ON main.memory_records BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_details_i AFTER INSERT ON main.memory_record_details BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_details_u AFTER UPDATE ON main.memory_record_details BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_details_d AFTER DELETE ON main.memory_record_details BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_evidence_i AFTER INSERT ON main.memory_evidence BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_evidence_u AFTER UPDATE ON main.memory_evidence BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_evidence_d AFTER DELETE ON main.memory_evidence BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_derivations_i AFTER INSERT ON main.memory_derivations BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_derivations_u AFTER UPDATE ON main.memory_derivations BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_derivations_d AFTER DELETE ON main.memory_derivations BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_tombstones_i AFTER INSERT ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_tombstones_u AFTER UPDATE ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_tombstones_d AFTER DELETE ON main.memory_tombstones BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_sources_u AFTER UPDATE ON main.memory_sources
 WHEN OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.scope_id IS NOT NEW.scope_id OR OLD.kind IS NOT NEW.kind BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_sources_d AFTER DELETE ON main.memory_sources BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_versions_d AFTER DELETE ON main.memory_source_versions BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_versions_u AFTER UPDATE ON main.memory_source_versions BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_meta_u AFTER UPDATE ON main.memory_meta
 WHEN OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch OR OLD.mode IS NOT NEW.mode BEGIN ${BUMP}; END;
-- A procedure verdict also rests on reply lineage (is the reply behind a source or record withheld?): output roots and root sets (a
-- repair writes them), receipt outputs, receipts whose versions change, and a message that is deleted or whose copyOf changes.
CREATE TEMP TRIGGER IF NOT EXISTS prov_outputs_i AFTER INSERT ON main.memory_disclosure_outputs BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_outputs_d AFTER DELETE ON main.memory_disclosure_outputs BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_roots_i AFTER INSERT ON main.memory_output_roots BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_roots_u AFTER UPDATE ON main.memory_output_roots BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_roots_d AFTER DELETE ON main.memory_output_roots BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_sets_i AFTER INSERT ON main.memory_root_sets BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_sets_u AFTER UPDATE ON main.memory_root_sets BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_sets_d AFTER DELETE ON main.memory_root_sets BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_members_i AFTER INSERT ON main.memory_root_set_members BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_members_d AFTER DELETE ON main.memory_root_set_members BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_parents_i AFTER INSERT ON main.memory_root_set_parents BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_parents_u AFTER UPDATE ON main.memory_root_set_parents BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_root_parents_d AFTER DELETE ON main.memory_root_set_parents BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_receipts_u AFTER UPDATE ON main.memory_disclosures
 WHEN OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.native_session IS NOT NEW.native_session BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_messages_u AFTER UPDATE ON main.messages WHEN OLD.json IS NOT NEW.json AND (instr(OLD.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0) BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_messages_d AFTER DELETE ON main.messages BEGIN ${BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS prov_messages_r BEFORE INSERT ON main.messages
 WHEN EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND o.json IS NOT NEW.json AND (instr(o.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)) BEGIN ${BUMP}; END;
`;
// The identity set reads only identity records, their details and their
// evidence, and its scan cannot use an index (no index on kind or partition),
// so it has its own counter that moves only when a written row is, or was,
// identity-related. Each WHEN is a primary-key prefix probe (records by id,
// details by record_id). A backlog of ordinary memory jobs at startup writes
// records and evidence constantly; with the broad counter above every one of
// those writes threw the set away and the next check rescanned (158 s in the
// first three minutes on a 735 MB store).
const IDENTITY_BUMP = "UPDATE identity_epoch SET n=n+1";
// (one version, by its full primary key: an id-level probe read every version of a record on each write of one, so seeding or ending a
// record with 150k versions cost 150k reads per row: 1.0.2 revoke-bounded r3)
const IS_IDENTITY = (id: string, version: string) => `(EXISTS(SELECT 1 FROM main.memory_records WHERE id=${id} AND version=${version} AND kind='character-canon') OR EXISTS(SELECT 1 FROM main.memory_record_details WHERE record_id=${id} AND record_version=${version} AND partition='identity'))`;
const IDENTITY_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS identity_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.identity_epoch VALUES(1,0);
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_i AFTER INSERT ON main.memory_records
 WHEN NEW.kind='character-canon' OR ${IS_IDENTITY("NEW.id", "NEW.version")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_u AFTER UPDATE ON main.memory_records
 WHEN OLD.kind='character-canon' OR NEW.kind='character-canon' OR ${IS_IDENTITY("OLD.id", "OLD.version")} OR ${IS_IDENTITY("NEW.id", "NEW.version")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_d AFTER DELETE ON main.memory_records
 WHEN OLD.kind='character-canon' OR ${IS_IDENTITY("OLD.id", "OLD.version")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_i AFTER INSERT ON main.memory_record_details
 WHEN NEW.partition='identity' BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_u AFTER UPDATE ON main.memory_record_details
 WHEN OLD.partition='identity' OR NEW.partition='identity' OR OLD.record_id IS NOT NEW.record_id OR OLD.record_version IS NOT NEW.record_version BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_d AFTER DELETE ON main.memory_record_details
 WHEN OLD.partition='identity' BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_i AFTER INSERT ON main.memory_evidence
 WHEN ${IS_IDENTITY("NEW.record_id", "NEW.record_version")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_u AFTER UPDATE ON main.memory_evidence
 WHEN ${IS_IDENTITY("OLD.record_id", "OLD.record_version")} OR ${IS_IDENTITY("NEW.record_id", "NEW.record_version")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_d AFTER DELETE ON main.memory_evidence
 WHEN ${IS_IDENTITY("OLD.record_id", "OLD.record_version")} BEGIN ${IDENTITY_BUMP}; END;
`;
const ready = new WeakMap<object, boolean>();
function install(db: DatabaseSync): boolean {
  let ok = ready.get(db);
  if (ok === undefined) {
    try { db.exec(withoutDroppedTableTriggers(db, SCHEMA)); db.exec(IDENTITY_SCHEMA); ok = true; }
    catch (error) {
      ok = false;
      if (!installWarned) { installWarned = true; console.warn(`[memory] provenance cache triggers could not be installed; every check rescans (${error instanceof Error ? error.message : String(error)})`); }
    }
    ready.set(db, ok);
  }
  return ok;
}
let installWarned = false;
/** Whether the provenance and identity triggers are installed on this connection (installs them if not tried yet). */
export function provenanceTriggersInstalled(db: DatabaseSync): boolean { return install(db); }
/** The stamp, or undefined when it cannot be trusted (inside a transaction,
 * or the triggers could not be installed). */
export function provenanceStamp(db: DatabaseSync): string | undefined {
  if (db.isTransaction || !install(db)) return undefined;
  const row = db.prepare("SELECT (SELECT n FROM temp.provenance_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version").get();
  // The connection and its ancestry-repair state ride in the stamp: a verdict reached while the lineage repair had failed (replay of
  // unrepaired threads withheld) is not reused after the repair succeeds, nor on another connection.
  return `${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row?.epoch}:${row?.version}`;
}

// The ids of every identity record, from the two sources of identity: kind='character-canon' on the record, partition='identity' on its details.
// With the two partial indexes (IDENTITY_INDEXES, built off the main thread) each arm is a walk of the identity rows only, so the whole read
// is O(identity records) however large the store. Without them each arm is one plain pass over its table (no per-row join), still far
// cheaper than the old record-by-record join. A record with no evidence yet still comes back (source_id null).
const IDENTITY_IDS = "SELECT id,version FROM memory_records WHERE kind='character-canon' UNION SELECT record_id,record_version FROM memory_record_details WHERE partition='identity'";
export const IDENTITY_SQL = `SELECT r.id AS record_id,r.version AS record_version,e.source_id,e.source_revision FROM (${IDENTITY_IDS}) i JOIN memory_records r ON r.id=i.id AND r.version=i.version LEFT JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version`;
// The chunked (rowid range) form for the background build when the indexes do not exist yet.
const CHUNK_BASE_SQL = "SELECT r.id AS record_id,r.version AS record_version,e.source_id,e.source_revision FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version LEFT JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='character-canon' OR d.partition='identity'";
/** Whether both identity indexes exist (an index that exists is complete, see optional-index.ts). */
export function identityIndexesReady(db: DatabaseSync): boolean {
  return optionalIndexReady(db, IDENTITY_CANON_INDEX) && optionalIndexReady(db, IDENTITY_PARTITION_INDEX);
}
/** Builds both identity indexes off the main thread (tests pass inline). Production builds them through the idle-gated sweep. */
export async function ensureIdentityIndexes(db: DatabaseSync, options: { inline?: boolean } = {}): Promise<boolean> {
  const both = [buildOptionalIndexOffThread(db, IDENTITY_CANON, options), buildOptionalIndexOffThread(db, IDENTITY_PARTITION, options)];
  return (await Promise.all(both)).every(Boolean);
}
// The identity counter's value and data_version, read even inside a
// transaction. A memo taken outside any transaction stays exact inside one
// while both still match: every identity write this transaction makes bumps
// the counter, and a rollback only undoes this transaction's own writes.
function identityReading(db: DatabaseSync): { epoch: number; version: number } | undefined {
  if (!install(db)) return undefined;
  try {
    const row = db.prepare("SELECT (SELECT n FROM temp.identity_epoch) AS epoch, (SELECT data_version FROM pragma_data_version) AS version").get();
    return row && typeof row.epoch === "number" ? { epoch: row.epoch, version: Number(row.version) } : undefined;
  } catch { ready.delete(db); return undefined; }
}
// The committed counter last seen outside a transaction (or just before one
// begins). The committed counter never goes down, and a transaction only adds
// to it, so a counter inside a transaction equal to this value means the
// transaction has written no identity row and nothing identity-related has
// committed since: a set scanned then is the committed set, safe to keep.
const committedEpoch = new WeakMap<object, number>();
/** Called by transaction() just before BEGIN, outside any transaction. */
export function noteIdentityEpoch(db: DatabaseSync): void {
  if (db.isTransaction) return;
  const reading = identityReading(db);
  if (reading) committedEpoch.set(db, reading.epoch);
}
const identity = { db: null as DatabaseSync | null, stamp: "", epoch: -1, sources: null as Set<string> | null, builds: 0, refreshes: 0, generation: 0 };
function collectRow(row: Record<string, unknown>, sources: Set<string>): void {
  if (row.source_id !== null && row.source_id !== undefined) sources.add(`${row.source_id}:${row.source_revision}`);
}
/** The version of the identity set a verdict was reached against. It moves whenever the set is replaced; -1 means the remembered set is
 * out of date (the database moved since it was read), so a verdict taken against it must not be reused. 0 until a set is first read. */
export function identityGeneration(db: DatabaseSync): number {
  if (identity.db !== db || !identity.sources) return identity.generation;
  const reading = identityReading(db);
  return reading && identity.stamp === `${reading.epoch}:${reading.version}` ? identity.generation : -1;
}

let lastReasonAt = 0;
/** Every `source:revision` cited by an identity record, exact at the moment of the call. Remembered while neither this connection's identity
 * counter nor the database's data_version has moved (inside a transaction too); any other change, an in-place promotion by another connection
 * included, is read afresh. The fresh read is O(identity records) once the indexes exist and one pass over each of two tables before, never
 * a guess from watermarks: a promotion of an old row writes no new rowid, so only a read of the identity rows themselves can see it. */
export function identitySourceSet(db: DatabaseSync): ReadonlySet<string> {
  const reading = identityReading(db);
  const stamp = reading ? `${reading.epoch}:${reading.version}` : undefined;
  if (stamp !== undefined && identity.db === db && identity.stamp === stamp && identity.sources) return identity.sources;
  const started = performance.now();
  const previouslyHeld = identity.db === db;
  const indexed = identityIndexesReady(db);
  const sources = new Set<string>();
  for (const row of db.prepare(IDENTITY_SQL).all()) collectRow(row, sources);
  if (indexed) identity.refreshes++; else identity.builds++;
  if (!db.isTransaction && reading) committedEpoch.set(db, reading.epoch);
  const keep = reading !== undefined && (!db.isTransaction || committedEpoch.get(db) === reading.epoch);
  if (keep) { identity.db = db; identity.stamp = stamp!; identity.epoch = reading!.epoch; identity.sources = sources; identity.generation++; }
  else if (identity.db === db && !db.isTransaction) { identity.sources = null; identity.generation++; }
  traceBuild(reading, keep, db, started, previouslyHeld, indexed ? "indexed" : "scan");
  return sources;
}
// ---- The set for a consumer that ALLOWS something on it -------------------------------------------------------------------------------
// A store past SMALL_STORE_ROWS with no indexes yet is never reread on the calling thread: the set is marked stale (the identity counter or the
// data_version moved), recomputed on a worker connection in one read snapshot, and meanwhile the consumer is told "unknown" (null) so it withholds.
// A consumer that only withholds may keep using the last known set (identity.sources, even when stale).
export const SMALL_STORE_ROWS = 20_000;
function smallStore(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT (SELECT coalesce(max(rowid),0) FROM memory_records) AS r,(SELECT coalesce(max(rowid),0) FROM memory_record_details) AS d").get();
  return Number(row?.r ?? 0) <= SMALL_STORE_ROWS && Number(row?.d ?? 0) <= SMALL_STORE_ROWS;
}
const RECOMPUTE_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.file);
  db.exec("PRAGMA busy_timeout=30000");
  db.exec("BEGIN");
  const rows = db.prepare(workerData.sql).all();
  db.exec("COMMIT");
  db.close();
  const sources = []; for (const row of rows) if (row.source_id !== null && row.source_id !== undefined) sources.push(row.source_id + ":" + row.source_revision);
  parentPort.postMessage({ ok: true, sources });
} catch (error) {
  try { db && db.close(); } catch {}
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
}
`;
const recomputing = new WeakMap<DatabaseSync, Promise<boolean>>();
export const identityRecomputeStats = { started: 0, kept: 0, moved: 0 };
/** Recomputes the set off the calling thread (a worker connection reads one snapshot). The result is kept only if neither this connection's
 * identity counter nor the data_version moved between the request and the answer: then no commit lies between the snapshot and now, so the
 * snapshot is the committed state. Otherwise it asks again (a few times). Resolves true once a current set is held. Many callers share one run. */
export function recomputeIdentityOffThread(db: DatabaseSync, attempts = 6): Promise<boolean> {
  const running = recomputing.get(db);
  if (running) return running;
  const file = databaseFile(db);
  const run = (async (): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const first = db.isTransaction ? undefined : identityReading(db);
      if (!first) { await new Promise<void>(r => setTimeout(r, 25 * (attempt + 1))); continue; }
      identityRecomputeStats.started++;
      let sources: Set<string> | undefined;
      if (!file) { const set = new Set<string>(); for (const row of db.prepare(IDENTITY_SQL).all()) collectRow(row, set); sources = set; }
      else sources = await new Promise<Set<string> | undefined>(resolve => {
        try {
          const worker = new Worker(RECOMPUTE_WORKER, { eval: true, workerData: { file, sql: IDENTITY_SQL } });
          let settled = false;
          const finish = (value: Set<string> | undefined) => { if (!settled) { settled = true; resolve(value); } };
          worker.on("message", (m: { ok: boolean; sources?: string[] }) => finish(m.ok ? new Set(m.sources) : undefined));
          worker.on("error", () => finish(undefined));
          worker.on("exit", () => finish(undefined));
          worker.unref();
        } catch { resolve(undefined); }
      });
      const last = db.isTransaction ? undefined : identityReading(db);
      if (sources && last && last.epoch === first.epoch && last.version === first.version) {
        identity.builds++; identityRecomputeStats.kept++;
        committedEpoch.set(db, last.epoch);
        identity.db = db; identity.epoch = last.epoch; identity.stamp = `${last.epoch}:${last.version}`; identity.sources = sources; identity.generation++;
        return true;
      }
      identityRecomputeStats.moved++;
      await new Promise<void>(r => setTimeout(r, 20 * (attempt + 1)));
    }
    return false;
  })().finally(() => { recomputing.delete(db); });
  recomputing.set(db, run);
  return run;
}
/** The identity set for a consumer that ALLOWS something because a source is not in it, or null when it is not known right now (stale and
 * being recomputed): the consumer must then withhold. Exact and synchronous when the memo is current, the identity indexes exist (an
 * O(identity records) read), or the store is small; never a full pass over a large store on the calling thread. */
export function identityForAllow(db: DatabaseSync): ReadonlySet<string> | null {
  const reading = identityReading(db);
  const stamp = reading ? `${reading.epoch}:${reading.version}` : undefined;
  if (stamp !== undefined && identity.db === db && identity.stamp === stamp && identity.sources) return identity.sources;
  if (!reading || identityIndexesReady(db) || smallStore(db)) return identitySourceSet(db);
  void recomputeIdentityOffThread(db).catch(() => false);
  return null;
}
/** The last set read, current or not (for a consumer that only withholds), or null when none was read yet. */
export function lastKnownIdentitySet(db: DatabaseSync): ReadonlySet<string> | null { return identity.db === db ? identity.sources : null; }
function traceBuild(reading: unknown, keep: boolean, db: DatabaseSync, started: number, previouslyHeld: boolean, kind = "scan"): void {
  if (!turnTraceEnabled() || performance.now() - lastReasonAt <= 5000) return;
  lastReasonAt = performance.now();
  const reason = !reading ? "no-counter" : !previouslyHeld ? "first" : db.isTransaction && !keep ? "in-transaction" : "moved";
  console.log(`[turn-trace] phase=memory.identity-${kind} reason=${reason} kept=${keep} ms=${Math.round(performance.now() - started)} builds=${identity.builds} caller=${scanCallers()}`);
}
// Chunked background build. The same joins and filter as IDENTITY_SQL, over a
// rowid range of memory_records (a range seek, so each chunk costs its own
// size and not the table's). The partial set is kept only when the identity
// reading is the same at every chunk and at the end: then it equals the
// committed state at that reading, the rule the one-shot scan already obeys.
const CHUNK_HI_SQL = "SELECT max(rowid) AS hi FROM (SELECT rowid FROM memory_records WHERE rowid>? ORDER BY rowid LIMIT ?)";
const CHUNK_SQL = CHUNK_BASE_SQL.replace("WHERE r.kind='character-canon' OR d.partition='identity'", "WHERE r.rowid>? AND r.rowid<=? AND (r.kind='character-canon' OR d.partition='identity')");
export const IDENTITY_CHUNK_SQL = CHUNK_SQL;
export const IDENTITY_CHUNK_HI_SQL = CHUNK_HI_SQL;
const warming = new WeakSet<DatabaseSync>();
/** Builds the identity set in the background, yielding to the event loop
 * between chunks, and keeps it only if nothing identity-related moved while it
 * ran. Resolves true when a memo was stored. A request that needs the set
 * meanwhile simply builds it synchronously. */
export async function warmIdentitySourceSet(db: DatabaseSync, options: { chunk?: number; retries?: number; force?: boolean } = {}): Promise<boolean> {
  if (warming.has(db)) return false;
  warming.add(db);
  const chunk = options.chunk ?? 2000;
  try {
    for (let attempt = 0; attempt <= (options.retries ?? 3); attempt++) {
      const started = performance.now();
      const first = db.isTransaction ? undefined : identityReading(db);
      if (!first) { await new Promise<void>(r => setImmediate(r)); continue; }
      const stamp = `${first.epoch}:${first.version}`;
      if (!options.force && identity.db === db && identity.stamp === stamp && identity.sources) return true;
      // With the indexes the read is already O(identity records): no slicing needed.
      if (identityIndexesReady(db)) { identitySourceSet(db); return true; }
      const sources = new Set<string>();
      // The partial result is exact only if nothing at all (this connection or another) committed while it ran: an in-place promotion of a
      // row already passed would otherwise be missed.
      const unmoved = (now: { epoch: number; version: number }) => now.epoch === first.epoch && now.version === first.version;
      const hiStmt = db.prepare(CHUNK_HI_SQL), rowsStmt = db.prepare(CHUNK_SQL);
      let after = 0, moved = false;
      for (;;) {
        const hi = hiStmt.get(after, chunk)?.hi;
        if (hi === null || hi === undefined) break;
        for (const row of rowsStmt.all(after, hi)) collectRow(row, sources);
        after = Number(hi);
        await new Promise<void>(r => setImmediate(r));
        const now = db.isTransaction ? undefined : identityReading(db);
        if (!now || !unmoved(now)) { moved = true; break; }
      }
      if (moved) continue;
      const last = db.isTransaction ? undefined : identityReading(db);
      if (!last || !unmoved(last)) continue;
      identity.builds++;
      committedEpoch.set(db, last.epoch);
      identity.db = db; identity.epoch = last.epoch; identity.stamp = stamp; identity.sources = sources; identity.generation++;
      traceBuild(last, true, db, started, false, "warm");
      return true;
    }
    return false;
  } finally { warming.delete(db); }
}
/** The first few function names above this module on the stack, for the trace line only. */
export function scanCallers(stack: string = new Error().stack ?? ""): string {
  const names: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const match = /^\s*at (?:async )?([\w$.<>]+) \(/.exec(line);
    if (!match || /identitySourceSet|scanCallers|traceBuild/.test(match[1]) || line.includes("node:internal")) continue;
    names.push(match[1]);
    if (names.length === 8) break;
  }
  return names.join("<") || "unknown";
}
/** How many times the identity scan has run (for cost tests). */
export function identityScanCount(): number { return identity.builds; }
/** How many times the set was read through the identity indexes (for cost tests). */
export function identityRefreshCount(): number { return identity.refreshes; }
