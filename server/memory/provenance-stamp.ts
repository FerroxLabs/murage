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
import type { DatabaseSync } from "node:sqlite";
import { turnTraceEnabled } from "../turn-trace.ts";

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
const IS_IDENTITY = (id: string) => `(EXISTS(SELECT 1 FROM main.memory_records WHERE id=${id} AND kind='character-canon') OR EXISTS(SELECT 1 FROM main.memory_record_details WHERE record_id=${id} AND partition='identity'))`;
const IDENTITY_SCHEMA = `
CREATE TEMP TABLE IF NOT EXISTS identity_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO temp.identity_epoch VALUES(1,0);
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_i AFTER INSERT ON main.memory_records
 WHEN NEW.kind='character-canon' OR ${IS_IDENTITY("NEW.id")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_u AFTER UPDATE ON main.memory_records
 WHEN OLD.kind='character-canon' OR NEW.kind='character-canon' OR ${IS_IDENTITY("OLD.id")} OR ${IS_IDENTITY("NEW.id")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_records_d AFTER DELETE ON main.memory_records
 WHEN OLD.kind='character-canon' OR ${IS_IDENTITY("OLD.id")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_i AFTER INSERT ON main.memory_record_details
 WHEN NEW.partition='identity' BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_u AFTER UPDATE ON main.memory_record_details
 WHEN OLD.partition='identity' OR NEW.partition='identity' OR OLD.record_id IS NOT NEW.record_id OR OLD.record_version IS NOT NEW.record_version BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_details_d AFTER DELETE ON main.memory_record_details
 WHEN OLD.partition='identity' BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_i AFTER INSERT ON main.memory_evidence
 WHEN ${IS_IDENTITY("NEW.record_id")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_u AFTER UPDATE ON main.memory_evidence
 WHEN ${IS_IDENTITY("OLD.record_id")} OR ${IS_IDENTITY("NEW.record_id")} BEGIN ${IDENTITY_BUMP}; END;
CREATE TEMP TRIGGER IF NOT EXISTS ident_evidence_d AFTER DELETE ON main.memory_evidence
 WHEN ${IS_IDENTITY("OLD.record_id")} BEGIN ${IDENTITY_BUMP}; END;
`;
const ready = new WeakMap<object, boolean>();
function install(db: DatabaseSync): boolean {
  let ok = ready.get(db);
  if (ok === undefined) {
    try { db.exec(SCHEMA); db.exec(IDENTITY_SCHEMA); ok = true; }
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
  return `${row?.epoch}:${row?.version}`;
}

const IDENTITY_SQL = "SELECT e.source_id,e.source_revision FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version CROSS JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='character-canon' OR d.partition='identity'";
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
const identity = { db: null as DatabaseSync | null, stamp: "", sources: null as Set<string> | null, builds: 0 };
let lastReasonAt = 0;
/** Every `source:revision` cited by an identity record. One scan of the
 * records when the identity counter has moved; the remembered set otherwise,
 * inside a transaction too. */
export function identitySourceSet(db: DatabaseSync): ReadonlySet<string> {
  const reading = identityReading(db);
  const stamp = reading ? `${reading.epoch}:${reading.version}` : undefined;
  if (stamp !== undefined && identity.db === db && identity.stamp === stamp && identity.sources) return identity.sources;
  const started = performance.now();
  const previouslyHeld = identity.db === db;
  const sources = new Set<string>();
  for (const row of db.prepare(IDENTITY_SQL).all()) sources.add(`${row.source_id}:${row.source_revision}`);
  identity.builds++;
  if (!db.isTransaction && reading) committedEpoch.set(db, reading.epoch);
  const keep = reading !== undefined && (!db.isTransaction || committedEpoch.get(db) === reading.epoch);
  if (keep) { identity.db = db; identity.stamp = stamp!; identity.sources = sources; }
  else if (identity.db === db && !db.isTransaction) identity.sources = null;
  traceBuild(reading, keep, db, started, previouslyHeld);
  return sources;
}
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
const CHUNK_SQL = IDENTITY_SQL.replace("WHERE r.kind='character-canon' OR d.partition='identity'", "WHERE r.rowid>? AND r.rowid<=? AND (r.kind='character-canon' OR d.partition='identity')");
export const IDENTITY_CHUNK_SQL = CHUNK_SQL;
export const IDENTITY_CHUNK_HI_SQL = CHUNK_HI_SQL;
const warming = new WeakSet<DatabaseSync>();
/** Builds the identity set in the background, yielding to the event loop
 * between chunks, and keeps it only if nothing identity-related moved while it
 * ran. Resolves true when a memo was stored. A request that needs the set
 * meanwhile simply builds it synchronously. */
export async function warmIdentitySourceSet(db: DatabaseSync, options: { chunk?: number; retries?: number } = {}): Promise<boolean> {
  if (warming.has(db)) return false;
  warming.add(db);
  const chunk = options.chunk ?? 2000;
  try {
    for (let attempt = 0; attempt <= (options.retries ?? 3); attempt++) {
      const started = performance.now();
      const first = db.isTransaction ? undefined : identityReading(db);
      if (!first) { await new Promise<void>(r => setImmediate(r)); continue; }
      const stamp = `${first.epoch}:${first.version}`;
      if (identity.db === db && identity.stamp === stamp && identity.sources) return true;
      const sources = new Set<string>();
      const hiStmt = db.prepare(CHUNK_HI_SQL), rowsStmt = db.prepare(CHUNK_SQL);
      let after = 0, moved = false;
      for (;;) {
        const hi = hiStmt.get(after, chunk)?.hi;
        if (hi === null || hi === undefined) break;
        for (const row of rowsStmt.all(after, hi)) sources.add(`${row.source_id}:${row.source_revision}`);
        after = Number(hi);
        await new Promise<void>(r => setImmediate(r));
        const now = db.isTransaction ? undefined : identityReading(db);
        if (!now || now.epoch !== first.epoch || now.version !== first.version) { moved = true; break; }
      }
      if (moved) continue;
      const last = db.isTransaction ? undefined : identityReading(db);
      if (!last || last.epoch !== first.epoch || last.version !== first.version) continue;
      identity.builds++;
      committedEpoch.set(db, last.epoch);
      identity.db = db; identity.stamp = stamp; identity.sources = sources;
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
