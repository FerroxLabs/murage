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

// LEFT JOIN evidence: an identity record with no evidence yet still comes back (source_id null), so the incremental refresh holds it.
const IDENTITY_SQL = "SELECT r.id AS record_id,r.version AS record_version,e.source_id,e.source_revision FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version LEFT JOIN memory_evidence e ON e.record_id=r.id AND e.record_version=r.version WHERE r.kind='character-canon' OR d.partition='identity'";
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
const identity = { db: null as DatabaseSync | null, stamp: "", epoch: -1, sources: null as Set<string> | null, builds: 0, refreshes: 0, inc: null as IdentityHeld | null };
// What the incremental refresh carries from one full build: the identity records (id and version), the rowid watermarks of the three tables
// when the build began, and when the set was last verified by a full build. A commit by another connection then costs the rows added since
// plus a primary-key look at each identity record, never a pass over the records.
interface IdentityHeld { held: Map<string, [string, number]>; records: number; details: number; evidence: number; fullAt: number }
const VERIFY_EVERY_MS = 60_000;
function watermarks(db: DatabaseSync): { records: number; details: number; evidence: number } {
  const row = db.prepare("SELECT (SELECT coalesce(max(rowid),0) FROM memory_records) AS records,(SELECT coalesce(max(rowid),0) FROM memory_record_details) AS details,(SELECT coalesce(max(rowid),0) FROM memory_evidence) AS evidence").get();
  return { records: Number(row?.records ?? 0), details: Number(row?.details ?? 0), evidence: Number(row?.evidence ?? 0) };
}
const heldKey = (id: unknown, version: unknown) => `${id}\u0000${version}`;
function collectRow(row: Record<string, unknown>, sources: Set<string>, held: Map<string, [string, number]>): void {
  if (row.record_id !== undefined && row.record_id !== null) held.set(heldKey(row.record_id, row.record_version), [String(row.record_id), Number(row.record_version)]);
  if (row.source_id !== null && row.source_id !== undefined) sources.add(`${row.source_id}:${row.source_revision}`);
}
const IS_IDENTITY_NOW = "SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.id=? AND r.version=? AND (r.kind='character-canon' OR d.partition='identity')";
/** The identity set after commits by other connections: records and details and evidence added since the watermarks join the held records,
 * each held record is looked at again by its primary key, and the set is rebuilt from the held records' evidence. The work follows the change
 * and the (small) identity records, not the size of the store. An in-place promotion of an old row by another connection is picked up by the
 * periodic full verification (warmIdentitySourceSet), which runs sliced off the request. */
function refreshIdentity(db: DatabaseSync, inc: IdentityHeld): Set<string> {
  const now = watermarks(db);
  const pair = (row: Record<string, unknown>) => inc.held.set(heldKey(row.id, row.version), [String(row.id), Number(row.version)]);
  for (const row of db.prepare("SELECT r.id,r.version FROM memory_records r LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE r.rowid>? AND (r.kind='character-canon' OR d.partition='identity')").all(inc.records)) pair(row);
  for (const row of db.prepare("SELECT r.id,r.version FROM memory_record_details d JOIN memory_records r ON r.id=d.record_id AND r.version=d.record_version WHERE d.rowid>? AND d.partition='identity'").all(inc.details)) pair(row);
  for (const row of db.prepare("SELECT DISTINCT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version LEFT JOIN memory_record_details d ON d.record_id=r.id AND d.record_version=r.version WHERE e.rowid>? AND (r.kind='character-canon' OR d.partition='identity')").all(inc.evidence)) pair(row);
  const still = db.prepare(IS_IDENTITY_NOW), evidenceOf = db.prepare("SELECT source_id,source_revision FROM memory_evidence WHERE record_id=? AND record_version=?");
  const sources = new Set<string>();
  for (const [key, [id, version]] of inc.held) {
    if (!still.get(id, version)) { inc.held.delete(key); continue; }
    for (const row of evidenceOf.all(id, version)) sources.add(`${row.source_id}:${row.source_revision}`);
  }
  inc.records = now.records; inc.details = now.details; inc.evidence = now.evidence;
  return sources;
}

let lastReasonAt = 0;
/** Every `source:revision` cited by an identity record. One scan of the
 * records when the identity counter has moved; the remembered set otherwise,
 * inside a transaction too. */
export function identitySourceSet(db: DatabaseSync): ReadonlySet<string> {
  const reading = identityReading(db);
  const stamp = reading ? `${reading.epoch}:${reading.version}` : undefined;
  if (stamp !== undefined && identity.db === db && identity.stamp === stamp && identity.sources) return identity.sources;
  // Only another connection's commit moved the reading (this connection's identity counter is unchanged): refresh by the change.
  if (reading && !db.isTransaction && identity.db === db && identity.sources && identity.inc && identity.epoch === reading.epoch) {
    const started = performance.now();
    const sources = refreshIdentity(db, identity.inc);
    identity.sources = sources; identity.stamp = stamp!; identity.refreshes++;
    traceBuild(reading, true, db, started, true, "refresh");
    if (performance.now() - identity.inc.fullAt > VERIFY_EVERY_MS) { identity.inc.fullAt = performance.now(); void warmIdentitySourceSet(db, { force: true }).catch(() => false); }
    return sources;
  }
  const started = performance.now();
  const previouslyHeld = identity.db === db;
  const sources = new Set<string>(), held = new Map<string, [string, number]>();
  const marks = watermarks(db);
  for (const row of db.prepare(IDENTITY_SQL).all()) collectRow(row, sources, held);
  identity.builds++;
  if (!db.isTransaction && reading) committedEpoch.set(db, reading.epoch);
  const keep = reading !== undefined && (!db.isTransaction || committedEpoch.get(db) === reading.epoch);
  if (keep) { identity.db = db; identity.stamp = stamp!; identity.epoch = reading!.epoch; identity.sources = sources; identity.inc = { held, ...marks, fullAt: performance.now() }; }
  else if (identity.db === db && !db.isTransaction) { identity.sources = null; identity.inc = null; }
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
      const sources = new Set<string>(), held = new Map<string, [string, number]>();
      const marks = watermarks(db);
      // A verification (force) holds while only other connections commit: it ends with a refresh that adds what they wrote since its watermarks.
      const unmoved = (now: { epoch: number; version: number }) => now.epoch === first.epoch && (options.force || now.version === first.version);
      const hiStmt = db.prepare(CHUNK_HI_SQL), rowsStmt = db.prepare(CHUNK_SQL);
      let after = 0, moved = false;
      for (;;) {
        const hi = hiStmt.get(after, chunk)?.hi;
        if (hi === null || hi === undefined) break;
        for (const row of rowsStmt.all(after, hi)) collectRow(row, sources, held);
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
      identity.db = db; identity.epoch = last.epoch; identity.inc = { held, ...marks, fullAt: performance.now() };
      if (last.version === first.version) { identity.stamp = stamp; identity.sources = sources; }
      else { identity.sources = refreshIdentity(db, identity.inc); identity.stamp = `${last.epoch}:${last.version}`; }
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
/** How many times the set was refreshed by the change alone (for cost tests). */
export function identityRefreshCount(): number { return identity.refreshes; }
