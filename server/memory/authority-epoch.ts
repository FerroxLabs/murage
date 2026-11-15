// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The authority epoch (PROPOSAL-v2 10.1, AUDIT B1). `databaseStamp()` is
// `total_changes():data_version`, so any write through the main connection
// moves it, and every turn writes (receipts, counters, jobs). A dispatch check
// guarded by it therefore never skipped. The epoch moves only when something
// that could REVOKE what a bundle or a resumed session was shown changes: a
// record or source leaving or changing, a tombstone, a disclosure revoked, a
// scope binding, a policy revision or deletion epoch, a message deleted or
// turned into a copy, root-set and output-lineage edits. Plain growth (new
// records, new jobs, projection receipts, retrieval counters, new messages) does not move it.
//
// Temp triggers belong to this connection only and are not part of the
// validated memory schema, so no migration is involved (the lineage cache uses
// the same pattern). Another connection's commits are covered by
// `data_version`. If any trigger cannot be installed the stamp falls back to
// "every write", which is slower and never wrong.
import { withoutDroppedTableTriggers } from "./read-time-retired.ts";
import type { DatabaseSync } from "node:sqlite";
import { ancestryUnrepaired, connectionId, database } from "../database.ts";
import { databaseStamp } from "./replay-lineage.ts";
import { NOISY_SYSTEM_SUBJECTS } from "./noisy-subjects.ts";

// n moves for every revocation-relevant write; hard moves for all of them except the SOFT ones below, which are also logged by id
// (authority_soft) so a session hold can tell whether the change touched anything it holds (disclosures.ts continuationMemoryRevoked).
const BUMP = "UPDATE authority_epoch SET n=n+1, hard=hard+1";
const SOFT_BUMP = "UPDATE authority_epoch SET n=n+1";
const SOFT_LOG_MAX = 4096;
const softLog = (id: string) => `INSERT INTO authority_soft(id) VALUES(${id}); DELETE FROM authority_soft WHERE seq<(SELECT max(seq) FROM authority_soft)-${SOFT_LOG_MAX}`;
function trigger(name: string, event: string, table: string, when?: string, body: string = BUMP): string {
  return `CREATE TEMP TRIGGER IF NOT EXISTS authority_${name} AFTER ${event} ON main.${table}${when ? ` WHEN ${when}` : ""} BEGIN ${body}; END;`;
}
const ALL_EVENTS = ["INSERT", "UPDATE", "DELETE"] as const;
function writes(table: string, events: readonly string[] = ALL_EVENTS, when?: string, body?: string): string[] {
  return events.map(event => trigger(`${table}_${event[0].toLowerCase()}`, event, table, when, body));
}
const deniedScope = (scope: string) => `EXISTS (SELECT 1 FROM main.memory_deny WHERE kind='scope' AND id=${scope})`;
const scopeChange = (scope: string) => `${SOFT_BUMP}; ${softLog("'scope:'||COALESCE(" + scope + ",'?')")}`;
// Blanking already denied material adds no restriction outside that scope. Unknown targets and moves between scopes stay hard.
const deniedCleanup = (scope: string, when = deniedScope(scope)) => `${scopeChange(scope)}; UPDATE authority_epoch SET hard=hard+1 WHERE NOT (${when})`;
const TOMBSTONE_SCOPE = "CASE NEW.target_type WHEN 'record' THEN (SELECT scope_id FROM main.memory_records WHERE id=NEW.target_id LIMIT 1) WHEN 'source' THEN (SELECT scope_id FROM main.memory_sources WHERE id=NEW.target_id) WHEN 'import' THEN NEW.target_id END";
// A tombstone without a revision ends every version: a record id ever moved to another scope must keep the hard fallback.
const TOMBSTONE_DENIED = `${deniedScope(`(${TOMBSTONE_SCOPE})`)} AND (NEW.target_type!='record' OR NOT EXISTS (SELECT 1 FROM main.memory_records WHERE id=NEW.target_id AND scope_id IS NOT (${TOMBSTONE_SCOPE})))`;
const WITHDRAW_DENIED_BINDING = `OLD.scope_id IS NEW.scope_id AND OLD.subject_type IS NEW.subject_type AND OLD.subject_id IS NEW.subject_id AND NEW.subject_type IN ('bot','person') AND NEW.state='revoked' AND ${deniedScope("NEW.scope_id")}`;
export { NOISY_SYSTEM_SUBJECTS };
// A bot cleanup may outlive the inline slice. Its queue row grants nothing and the scopes it walks are already denied;
// advancing or removing that cursor adds no restriction. Other jobs and unreadable/undenied scope lists keep the hard fallback.
const BOT_CLEANUP = (row: "NEW" | "OLD") => `${row}.subject_id='memory-revocation' AND COALESCE(CASE WHEN json_valid(${row}.intent) THEN
  json_extract(${row}.intent,'$.v')=2 AND json_type(${row}.intent,'$.phases')='array'
  AND json_extract(${row}.intent,'$.cause')='bot-deletion' AND json_type(${row}.intent,'$.scopes')='array'
  AND NOT EXISTS (SELECT 1 FROM json_each(${row}.intent,'$.scopes') s WHERE NOT EXISTS (SELECT 1 FROM main.memory_deny d WHERE d.kind='scope' AND d.id=s.value)) ELSE 0 END,0)`;
const NOISY = (row: "NEW" | "OLD") => `${row}.subject_type='system' AND (${row}.subject_id IN (${NOISY_SYSTEM_SUBJECTS.map(subject => `'${subject}'`).join(",")}) OR (${BOT_CLEANUP(row)}))`;
// A thread's checkpoint rolls to a new version on every captured message and the old version is archived; a receipt that cites
// the old version still holds (bundle.ts supersededThreadCheckpoint), so that one transition is not a revocation.
// A candidate becoming active only adds to what a session may be shown (a receipt can cite no candidate, and every writer that ends receipts
// on approval revokes them itself): SOFT, logged by id so a session that cites the record judges it again.
const RECORD_REST = "OLD.owner_pinned IS NOT NEW.owner_pinned OR OLD.assertion IS NOT NEW.assertion OR OLD.supersedes_id IS NOT NEW.supersedes_id OR OLD.kind IS NOT NEW.kind OR OLD.text IS NOT NEW.text OR OLD.scope_id IS NOT NEW.scope_id";
// An ordinary candidate activated (automatic learning: assertion and kind are set when it goes active) is SOFT too; one that supersedes another, or a
// checkpoint, is not.
const RECORD_ACTIVATED = "OLD.state='candidate' AND NEW.state='active' AND OLD.owner_pinned IS NEW.owner_pinned AND OLD.supersedes_id IS NULL AND NEW.supersedes_id IS NULL AND OLD.text IS NEW.text AND OLD.scope_id IS NEW.scope_id AND OLD.kind IS NOT 'checkpoint' AND NEW.kind IS NOT 'checkpoint'";
const RECORD_CHANGED = "(OLD.state IS NOT NEW.state AND NOT (OLD.kind='checkpoint' AND OLD.state='active' AND NEW.state='archived') AND NOT (OLD.state='candidate' AND NEW.state='active' AND OLD.supersedes_id IS NULL AND NEW.supersedes_id IS NULL)) OR ((" + RECORD_REST + ") AND NOT (" + RECORD_ACTIVATED + "))";
const SOURCE_CHANGED = "OLD.state IS NOT NEW.state OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash OR OLD.speaker IS NOT NEW.speaker OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id OR OLD.scope_id IS NOT NEW.scope_id";
// A row being ADDED never takes anything away from a bundle or a session that was already checked: a new record, source,
// job, receipt or disclosure grants nothing retroactively. Changes and removals are what the epoch counts, plus the rows
// whose arrival is itself a restriction (tombstones, audience bindings).
const SOFT_SOURCE = "OLD.scope_id IS NEW.scope_id AND OLD.speaker IS NEW.speaker AND OLD.thread_id IS NEW.thread_id AND OLD.message_id IS NEW.message_id AND (OLD.state IS NEW.state OR (OLD.state='retired' AND NEW.state='active'))";
// A receipt that a lookup companion replaces (noteMemoryLookup inserts the grown successor first, then deletes the old row) takes nothing
// away: the successor cites everything it did and is a new row, judged on its own.
const GROWN_SUCCESSOR = "EXISTS (SELECT 1 FROM main.memory_disclosures s WHERE s.bundle_id=OLD.bundle_id||char(0)||'grown')";
// A receipt joining a session as its newest row is judged as a new row; one that joins (or leaves, or moves) anywhere else in the session
// is not, so it counts.
const REBOUND = "OLD.native_session IS NOT NEW.native_session AND (OLD.native_session IS NOT NULL OR NEW.native_session IS NULL OR NEW.rowid < COALESCE((SELECT max(x.rowid) FROM main.memory_disclosures x WHERE x.thread_id=NEW.thread_id AND x.driver_instance=NEW.driver_instance AND x.native_session=NEW.native_session),0))";
const TRIGGERS: string[] = [
  // Deny insertion/removal logs its thread or scope dependency; arbitrary edits keep the hard fallback.
  ...ALL_EVENTS.map(event => trigger(`memory_deny_${event[0].toLowerCase()}`, event, "memory_deny", undefined,
    event === "UPDATE" ? `${BUMP}` : `${SOFT_BUMP}; ${softLog((event === "INSERT" ? "NEW" : "OLD") + ".kind||':'||" + (event === "INSERT" ? "NEW" : "OLD") + ".id")}`)),
  ...writes("memory_records", ["UPDATE"], RECORD_CHANGED, deniedCleanup("OLD.scope_id", `OLD.scope_id IS NEW.scope_id AND ${deniedScope("OLD.scope_id")}`)),
  trigger("memory_records_soft", "UPDATE", "memory_records", RECORD_ACTIVATED, `${SOFT_BUMP}; ${softLog("'record:'||NEW.id")}`), ...writes("memory_records", ["DELETE"]),
  // A source's new revision or content, and a source joining the active branch (retired to active), are SOFT: they take nothing away from a
  // session that was already checked unless the session holds that source (or a record resting on it); the id is logged so the hold can ask.
  trigger("memory_sources_u", "UPDATE", "memory_sources", `(${SOURCE_CHANGED}) AND NOT (${SOFT_SOURCE})`, deniedCleanup("OLD.scope_id", `OLD.scope_id IS NEW.scope_id AND ${deniedScope("OLD.scope_id")}`)),
  trigger("memory_sources_soft", "UPDATE", "memory_sources", `(${SOURCE_CHANGED}) AND ${SOFT_SOURCE}`, `${SOFT_BUMP}; ${softLog("NEW.id")}`),
  ...writes("memory_sources", ["DELETE"]),
  trigger("memory_source_versions_u", "UPDATE", "memory_source_versions", "OLD.source_id IS NOT NEW.source_id OR OLD.revision IS NOT NEW.revision OR OLD.content_hash IS NOT NEW.content_hash"),
  trigger("memory_source_versions_soft", "UPDATE", "memory_source_versions", "OLD.source_id IS NEW.source_id AND OLD.revision IS NEW.revision AND OLD.content_hash IS NEW.content_hash", `${SOFT_BUMP}; ${softLog("NEW.source_id")}`),
  ...writes("memory_source_versions", ["DELETE"]),
  ...writes("memory_evidence", ["UPDATE", "DELETE"]),
  ...writes("memory_derivations", ["UPDATE", "DELETE"]),
  trigger("memory_tombstones_i", "INSERT", "memory_tombstones", undefined, deniedCleanup(`(${TOMBSTONE_SCOPE})`, TOMBSTONE_DENIED)),
  ...writes("memory_tombstones", ["UPDATE", "DELETE"]),
  // (a trigger of the schema rewrites a record's details whenever its state changes; the state change is what counts)
  ...writes("memory_record_details", ["UPDATE"], "OLD.partition IS NOT NEW.partition"), ...writes("memory_record_details", ["DELETE"]),
  ...writes("memory_scopes", ["UPDATE", "DELETE"]),
  trigger("bindings_i", "INSERT", "memory_scope_bindings", `NOT (${NOISY("NEW")})`),
  trigger("bindings_u", "UPDATE", "memory_scope_bindings", `NOT (${NOISY("NEW")}) OR NOT (${NOISY("OLD")})`, deniedCleanup("NEW.scope_id", WITHDRAW_DENIED_BINDING)),
  trigger("bindings_d", "DELETE", "memory_scope_bindings", `NOT (${NOISY("OLD")})`),
  // A receipt matters when it is revoked or its contents change; becoming delivered, or getting its session bound, does not.
  ...writes("memory_disclosures", ["UPDATE"], "OLD.thread_id IS NOT NEW.thread_id OR OLD.driver_instance IS NOT NEW.driver_instance OR (" + REBOUND + ") OR OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions OR OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch"),
  trigger("memory_disclosures_revoked", "UPDATE", "memory_disclosures", "NEW.state='revoked' AND OLD.state IS NOT 'revoked'", `${SOFT_BUMP}; ${softLog("'thread:'||NEW.thread_id")}`),
  trigger("memory_disclosures_d", "DELETE", "memory_disclosures", `NOT ${GROWN_SUCCESSOR}`, `${SOFT_BUMP}; ${softLog("'thread:'||OLD.thread_id")}`),
  trigger("memory_disclosures_d_grown", "DELETE", "memory_disclosures", GROWN_SUCCESSOR, SOFT_BUMP),
  // Output links and roots are added for the reply a turn just produced, a new message nothing existing rests on; the lineage
  // cache treats them as dirty for that one message. Changing or removing one is what counts here.
  ...writes("memory_disclosure_outputs", ["UPDATE", "DELETE"]),
  ...writes("memory_output_roots", ["UPDATE", "DELETE"]),
  ...writes("memory_root_set_members", ["DELETE"]),
  ...writes("memory_root_sets", ["DELETE"]),
  ...writes("memory_lineage_meta", ["UPDATE", "DELETE"]),
  trigger("meta_u", "UPDATE", "memory_meta", "OLD.policy_revision IS NOT NEW.policy_revision OR OLD.deletion_epoch IS NOT NEW.deletion_epoch OR OLD.mode IS NOT NEW.mode"),
  trigger("messages_u", "UPDATE", "messages", "OLD.json IS NOT NEW.json AND (instr(OLD.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)"),
  trigger("messages_d", "DELETE", "messages", undefined, `${SOFT_BUMP}; ${softLog("'thread:'||OLD.thread_id")}`),
  // INSERT OR REPLACE (writeMessage) deletes and re-inserts without firing the UPDATE or DELETE triggers (recursive triggers are off):
  // the row being replaced is looked at before it goes, with the condition of messages_u.
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_messages_r BEFORE INSERT ON main.messages WHEN EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id AND o.json IS NOT NEW.json AND (instr(o.json,'copyOf')>0 OR instr(NEW.json,'copyOf')>0)) BEGIN ${BUMP}; END;`,
];

/** A second counter for one question the turn asks every time and the index cannot answer: which records does the owner pin. It moves when a
 * pinned record is added, changed or removed, or a record is pinned or unpinned, and for nothing else. */
/** A checkpoint archived is only "rolled" if a newer version of it arrives: the roll writes both in one transaction. The archive leaves a mark
 * that the arrival of the successor clears; while a mark stands, the stamp differs from the one before it (an archive with no successor
 * takes the checkpoint away). */
const CHECKPOINT_TRIGGERS: string[] = [
  "CREATE TEMP TRIGGER IF NOT EXISTS authority_ckpt_archived AFTER UPDATE ON main.memory_records WHEN OLD.kind='checkpoint' AND OLD.state='active' AND NEW.state='archived' BEGIN INSERT OR IGNORE INTO authority_pending VALUES(OLD.id); END;",
  "CREATE TEMP TRIGGER IF NOT EXISTS authority_ckpt_arrived AFTER INSERT ON main.memory_records WHEN NEW.kind='checkpoint' BEGIN DELETE FROM authority_pending WHERE id=NEW.id; END;",
];
const PIN_BUMP = "UPDATE authority_epoch SET pins=pins+1";
const PIN_TRIGGERS: string[] = [
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_i AFTER INSERT ON main.memory_records WHEN NEW.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_u AFTER UPDATE ON main.memory_records WHEN OLD.owner_pinned=1 OR NEW.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_d AFTER DELETE ON main.memory_records WHEN OLD.owner_pinned=1 BEGIN ${PIN_BUMP}; END;`,
  `CREATE TEMP TRIGGER IF NOT EXISTS authority_pins_details AFTER UPDATE ON main.memory_record_details WHEN OLD.partition IS NOT NEW.partition BEGIN ${PIN_BUMP}; END;`,
];

const state = new WeakMap<object, boolean>();
let warned = false;
function install(db: DatabaseSync): boolean {
  const known = state.get(db);
  if (known !== undefined) return known;
  let ok = true;
  try {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS authority_epoch(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL, pins INTEGER NOT NULL DEFAULT 0, hard INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO temp.authority_epoch(id,n,pins,hard) VALUES(1,0,0,0);\nCREATE TEMP TABLE IF NOT EXISTS authority_soft(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL);\nCREATE TEMP TABLE IF NOT EXISTS authority_pending(id TEXT PRIMARY KEY);");
    for (const trigger of [...TRIGGERS, ...PIN_TRIGGERS, ...CHECKPOINT_TRIGGERS]) { const sql = withoutDroppedTableTriggers(db, trigger); if (sql.trim()) db.exec(sql); }
  } catch (error) {
    ok = false;
    if (!warned) { warned = true; console.warn(`[memory] authority epoch triggers could not be installed; every write moves the dispatch stamp (${error instanceof Error ? error.message : String(error)})`); }
  }
  state.set(db, ok);
  return ok;
}

/** Whether the epoch triggers are in place on the shared connection. */
export function authorityEpochInstalled(): boolean { return install(database()); }
/** A hard move of the epoch for a withdrawal no trigger can see (a thread leaving the roster whose receipts are already gone): every session
 * hold and checked stamp is dropped. A no-op where the triggers could not be installed (every write moves the stamp there). */
export function bumpAuthorityHard(db: DatabaseSync): void { bumpLearningFence(db); if (install(db)) db.exec(BUMP); }
/** A roster removal logs its thread so unrelated cached sessions keep their proof. */
export function bumpAuthorityThreads(db: DatabaseSync, threads: readonly string[]): void {
  bumpAuthorityDependencies(db, threads.map(thread => `thread:${thread}`));
}
/** Roster container removals name their notebook dependencies as well as their conversations. */
export function bumpAuthorityScopes(db: DatabaseSync, scopes: readonly string[]): void {
  bumpAuthorityDependencies(db, scopes.map(scope => `scope:${scope}`));
}
function bumpAuthorityDependencies(db: DatabaseSync, ids: readonly string[]): void {
  bumpLearningFence(db);
  if (!install(db)) return;
  db.exec(SOFT_BUMP);
  const insert = db.prepare("INSERT INTO temp.authority_soft(id) VALUES(?)");
  for (const id of ids) insert.run(id);
  db.exec(`DELETE FROM temp.authority_soft WHERE seq<(SELECT max(seq) FROM temp.authority_soft)-${SOFT_LOG_MAX}`);
}
/** The learning send counter (learning-send.ts) for the same withdrawals: the roster is a quiet binding there too, so its removals move the
 * counter here, first and whether or not the authority triggers are installed. A no-op where the counter is missing (its check fails closed). */
export function bumpLearningFence(db: DatabaseSync): void {
  try { db.exec("UPDATE temp.memory_learning_fence SET epoch=epoch+1 WHERE id=1"); } catch { /* no counter on this connection */ }
}

/** A stamp that is equal at two moments only if nothing revocation-relevant was written in between by this
 * connection or committed by another. Undefined inside a transaction (a verdict may rest on writes that roll back). */
export function authorityStamp(): string | undefined {
  const db = database();
  if (db.isTransaction) return undefined;
  if (!install(db)) return databaseStamp();
  const row = db.prepare("SELECT (SELECT n FROM temp.authority_epoch) AS epoch, (SELECT count(*) FROM temp.authority_pending) AS pending, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `a${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}.${row?.epoch}.${row?.pending}:${row?.version}`;
}

/** The stamp, the same stamp without the soft writes (equal at two moments only if nothing but soft writes happened in between, here or by
 * another connection: its commit moves data_version, which both stamps include), and where the soft log stands.
 * Undefined inside a transaction and when the triggers are missing: the caller then does the full check. */
export function authorityParts(): { stamp: string; hard: string; seq: number } | undefined {
  const db = database();
  if (db.isTransaction || !install(db)) return undefined;
  const row = db.prepare("SELECT (SELECT n FROM temp.authority_epoch) AS epoch, (SELECT hard FROM temp.authority_epoch) AS hard, (SELECT count(*) FROM temp.authority_pending) AS pending, (SELECT data_version FROM pragma_data_version) AS version, COALESCE((SELECT max(seq) FROM temp.authority_soft),(SELECT seq FROM temp.sqlite_sequence WHERE name='authority_soft'),0) AS seq").get();
  const who = `${connectionId(db)}${ancestryUnrepaired(db) ? "u" : ""}`;
  return { stamp: `a${who}.${row?.epoch}.${row?.pending}:${row?.version}`, hard: `h${who}.${row?.hard}.${row?.pending}:${row?.version}`, seq: Number(row?.seq ?? 0) };
}

/** The ids of sources whose soft changes were logged after `since`, or null when the log no longer reaches back that far (the caller then
 * treats the change as hard). */
export function softChangedSince(since: number): Set<string> | null {
  try {
    const rows = database().prepare("SELECT seq,id FROM temp.authority_soft WHERE seq>? ORDER BY seq").all(since);
    // sequence numbers are consecutive (AUTOINCREMENT, and only the oldest rows are pruned): a first row above since+1 means some were pruned
    if (rows.length && Number(rows[0]!.seq) > since + 1) return null;
    return new Set(rows.map(row => String(row.id)));
  } catch { return null; }
}

/** True when `since` no longer describes the database: an unknown stamp always counts as moved. */
export function authorityMoved(since: string | undefined): boolean {
  if (since === undefined) return true;
  return authorityStamp() !== since;
}

/** Equal at two moments only if no pinned record was added, changed or removed in between (here or by another connection). Undefined
 * inside a transaction and when the triggers are missing: the caller then asks the database. */
export function pinStamp(): string | undefined {
  const db = database();
  if (db.isTransaction || !install(db)) return undefined;
  const row = db.prepare("SELECT (SELECT pins FROM temp.authority_epoch) AS pins, (SELECT data_version FROM pragma_data_version) AS version").get();
  return `p${connectionId(db)}.${row?.pins}:${row?.version}`;
}
