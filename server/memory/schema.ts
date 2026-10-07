import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LEARNING_EVENT_KINDS_V4, LEARNING_EVENT_KINDS_V5 } from "./learning-kinds.ts";
import { startupMark } from "../startup-trace.ts";
import { DEFAULT_MEMORY_LEARNING, memoryLearningSchema, memoryLearningV1Schema, upgradeMemoryLearning, downgradeMemoryLearning } from "./learning-policy.ts";

/** Ordinary authoritative tables only. Search indexes are rebuilt separately. */
export const MEMORY_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS memory_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
 installation_id TEXT NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 0 CHECK(policy_revision>=0),
 deletion_epoch INTEGER NOT NULL DEFAULT 0 CHECK(deletion_epoch>=0),
 data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision>=0),
 mode TEXT NOT NULL DEFAULT 'off' CHECK(mode IN ('off','capture','active','paused')));
CREATE TABLE IF NOT EXISTS memory_scopes (
 id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('conversation','bot','room','team','project','workspace','preferences')),
 owner_key TEXT NOT NULL, audience TEXT NOT NULL CHECK(json_valid(audience)), revision INTEGER NOT NULL CHECK(revision>=0));
CREATE TABLE IF NOT EXISTS memory_scope_bindings (
 id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES memory_scopes(id), subject_type TEXT NOT NULL,
 subject_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL CHECK(state IN ('granted','pending','revoked')),
 intent TEXT NOT NULL CHECK(json_valid(intent)));
CREATE INDEX IF NOT EXISTS memory_bindings_subject ON memory_scope_bindings(subject_type,subject_id);
CREATE TABLE IF NOT EXISTS memory_sources (
 id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES memory_scopes(id), thread_id TEXT,
 message_id TEXT, turn_id TEXT, revision INTEGER NOT NULL CHECK(revision>=0), content_hash TEXT NOT NULL,
 kind TEXT NOT NULL, speaker TEXT NOT NULL, outcome TEXT NOT NULL, branch_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('active','retired','deleted')));
CREATE INDEX IF NOT EXISTS memory_sources_thread ON memory_sources(thread_id,message_id);
CREATE TABLE IF NOT EXISTS memory_source_versions (
 source_id TEXT NOT NULL REFERENCES memory_sources(id), revision INTEGER NOT NULL CHECK(revision>=0),
 content_hash TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(source_id,revision));
CREATE TABLE IF NOT EXISTS memory_jobs (
 id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, stage TEXT NOT NULL,
 stage_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','leased','partial','deferred','complete','failed','cancelled')),
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0), coverage TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(coverage)),
 retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0), lease_until INTEGER NOT NULL DEFAULT 0,
 policy_revision INTEGER NOT NULL, deletion_epoch INTEGER NOT NULL, error TEXT,
 FOREIGN KEY(source_id,source_revision) REFERENCES memory_source_versions(source_id,revision),
 UNIQUE(source_id,source_revision,stage,stage_version));
CREATE INDEX IF NOT EXISTS memory_jobs_pending ON memory_jobs(status,retry_at);
CREATE TABLE IF NOT EXISTS memory_records (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), scope_id TEXT NOT NULL REFERENCES memory_scopes(id),
 kind TEXT NOT NULL, text TEXT NOT NULL, assertion TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('candidate','active','superseded','archived','deleted')),
 owner_pinned INTEGER NOT NULL DEFAULT 0 CHECK(owner_pinned IN (0,1)), valid_from INTEGER NOT NULL,
 valid_to INTEGER, supersedes_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(id,version));
CREATE INDEX IF NOT EXISTS memory_records_scope ON memory_records(scope_id,state);
CREATE TABLE IF NOT EXISTS memory_evidence (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
 start_byte INTEGER NOT NULL CHECK(start_byte>=0), end_byte INTEGER NOT NULL CHECK(end_byte>=start_byte),
 PRIMARY KEY(record_id,record_version,source_id,source_revision,start_byte),
 FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version),
 FOREIGN KEY(source_id,source_revision) REFERENCES memory_source_versions(source_id,revision));
CREATE TABLE IF NOT EXISTS memory_derivations (
 parent_id TEXT NOT NULL, parent_version INTEGER NOT NULL, child_id TEXT NOT NULL, child_version INTEGER NOT NULL,
 PRIMARY KEY(parent_id,parent_version,child_id,child_version),
 FOREIGN KEY(parent_id,parent_version) REFERENCES memory_records(id,version),
 FOREIGN KEY(child_id,child_version) REFERENCES memory_records(id,version));
CREATE TABLE IF NOT EXISTS memory_tombstones (
 id TEXT PRIMARY KEY NOT NULL, target_type TEXT NOT NULL CHECK(target_type IN ('source','record','import')),
 target_id TEXT NOT NULL, revision INTEGER, content_hash TEXT, epoch INTEGER NOT NULL CHECK(epoch>=0), reason TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(target_type,target_id,revision));
CREATE TABLE IF NOT EXISTS memory_projection_receipts (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL, index_generation INTEGER NOT NULL,
 lexical_status TEXT NOT NULL, embedding_status TEXT NOT NULL, error TEXT,
 PRIMARY KEY(record_id,record_version,index_generation), FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version));
CREATE TABLE IF NOT EXISTS memory_disclosures (
 bundle_id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, driver_instance TEXT NOT NULL, native_session TEXT,
 record_versions TEXT NOT NULL CHECK(json_valid(record_versions)), source_versions TEXT NOT NULL CHECK(json_valid(source_versions)),
 output_message_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(output_message_ids)),
 policy_revision INTEGER NOT NULL, deletion_epoch INTEGER NOT NULL, token_count INTEGER NOT NULL CHECK(token_count>=0),
 state TEXT NOT NULL CHECK(state IN ('prepared','delivered','revoked')), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS memory_projection_pending ON memory_projection_receipts(lexical_status,record_id,record_version);
CREATE INDEX IF NOT EXISTS memory_disclosures_thread ON memory_disclosures(thread_id,driver_instance,native_session);
CREATE INDEX IF NOT EXISTS memory_derivations_child ON memory_derivations(child_id,child_version);
`;

const LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_record_details (
 record_id TEXT NOT NULL, record_version INTEGER NOT NULL,
 partition TEXT NOT NULL CHECK(partition IN ('working','episodic','semantic','procedural','identity')),
 attention TEXT NOT NULL CHECK(attention IN ('current','useful','historical')),
 claim_status TEXT NOT NULL CHECK(claim_status IN ('provisional','current','disputed')),
 entities TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entities) AND json_type(entities)='array'),
 confidence REAL CHECK(confidence IS NULL OR (confidence>=0 AND confidence<=1)),
 confidence_basis TEXT, observed_at INTEGER CHECK(observed_at IS NULL OR observed_at>=0),
 PRIMARY KEY(record_id,record_version), FOREIGN KEY(record_id,record_version) REFERENCES memory_records(id,version) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS memory_learning_config (
 id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0),
 settings TEXT NOT NULL CHECK(json_valid(settings) AND json_type(settings)='object'));
CREATE TRIGGER IF NOT EXISTS memory_record_details_insert AFTER INSERT ON memory_records BEGIN
 INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at)
 VALUES(NEW.id,NEW.version,CASE NEW.kind WHEN 'source' THEN 'episodic' WHEN 'checkpoint' THEN 'working'
 WHEN 'procedure' THEN 'procedural' WHEN 'identity' THEN 'identity' ELSE 'semantic' END,
 CASE WHEN NEW.state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
 CASE WHEN NEW.state='candidate' THEN 'provisional' ELSE 'current' END,NULL);
END;
CREATE TRIGGER IF NOT EXISTS memory_record_details_state AFTER UPDATE OF state ON memory_records BEGIN
 UPDATE memory_record_details SET
 attention=CASE WHEN NEW.state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
 claim_status=CASE WHEN NEW.state='candidate' THEN 'provisional' WHEN OLD.state='candidate' AND NEW.state='active' THEN 'current' ELSE claim_status END,
 entities=CASE WHEN NEW.state='deleted' THEN '[]' ELSE entities END,
 confidence=CASE WHEN NEW.state='deleted' THEN NULL ELSE confidence END,
 confidence_basis=CASE WHEN NEW.state='deleted' THEN NULL ELSE confidence_basis END,
 observed_at=CASE WHEN NEW.state='deleted' THEN NULL ELSE observed_at END
 WHERE record_id=NEW.id AND record_version=NEW.version;
END;
`;
/** v3 (0.1.61 lane M): one row per (receipt, generated message it produced),
 * kept by triggers from memory_disclosures.output_message_ids, so "which
 * receipts produced this message" is an index lookup instead of a scan of
 * every receipt's JSON in the thread (replay-lineage.ts; 0.1.61 T2 R2-12:
 * ~9 ms at 2,049 receipts, ~660 ms at 100k for 30 lines). Replay reads only
 * this table since 0.1.61.1 (memreplay), so it is the authority for which
 * receipts produced a message: the triggers keep it equal to the JSON
 * column, the migration backfills it, and archive, restore and merge prove
 * the two equal before use. */
const OUTPUT_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_disclosure_outputs (
 bundle_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY(bundle_id,message_id));
CREATE INDEX IF NOT EXISTS memory_disclosure_outputs_message ON memory_disclosure_outputs(thread_id,message_id);
CREATE TRIGGER IF NOT EXISTS memory_disclosure_outputs_insert AFTER INSERT ON memory_disclosures BEGIN
 INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id)
 SELECT NEW.bundle_id,NEW.thread_id,value FROM json_each(NEW.output_message_ids) WHERE type='text';
END;
CREATE TRIGGER IF NOT EXISTS memory_disclosure_outputs_update AFTER UPDATE OF output_message_ids,thread_id,bundle_id ON memory_disclosures BEGIN
 DELETE FROM memory_disclosure_outputs WHERE bundle_id=OLD.bundle_id AND (bundle_id!=NEW.bundle_id OR thread_id!=NEW.thread_id
  OR message_id NOT IN (SELECT value FROM json_each(NEW.output_message_ids) WHERE type='text'));
 INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id)
 SELECT NEW.bundle_id,NEW.thread_id,value FROM json_each(NEW.output_message_ids) WHERE type='text';
END;
CREATE TRIGGER IF NOT EXISTS memory_disclosure_outputs_delete AFTER DELETE ON memory_disclosures BEGIN
 DELETE FROM memory_disclosure_outputs WHERE bundle_id=OLD.bundle_id;
END;
`;
const OUTPUT_INDEX_BACKFILL = `DELETE FROM memory_disclosure_outputs;
 INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id)
 SELECT d.bundle_id,d.thread_id,j.value FROM memory_disclosures d, json_each(d.output_message_ids) j WHERE j.type='text';`;
const quoteKinds = (kinds: readonly string[]) => kinds.map(kind => `'${kind}'`).join(",");
/** Event ledger text; the kind list is the only part that differs between versions. */
const ledgerSchema = (kinds: readonly string[]) => `
CREATE TABLE IF NOT EXISTS memory_learning_events (
 id TEXT PRIMARY KEY NOT NULL, run_id TEXT, bot_id TEXT, scope_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN (${quoteKinds(kinds)})),
 record_id TEXT, record_version INTEGER, prior_id TEXT, prior_version INTEGER,
 source_id TEXT, source_revision INTEGER,
 procedure_review_id TEXT, receipt_id TEXT, count INTEGER CHECK(count IS NULL OR count>=0),
 detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail) AND json_type(detail)='object'),
 created_at INTEGER NOT NULL CHECK(created_at>=0), undone_at INTEGER, kept_at INTEGER, digest_day TEXT);
CREATE INDEX IF NOT EXISTS memory_learning_events_created ON memory_learning_events(created_at);
CREATE INDEX IF NOT EXISTS memory_learning_events_record ON memory_learning_events(record_id,record_version);
CREATE INDEX IF NOT EXISTS memory_learning_events_source ON memory_learning_events(source_id);
`;
/** Frozen v4 text, byte for byte: a development file already at v4 is recognised by it. */
const LEDGER_SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS memory_learning_events (
 id TEXT PRIMARY KEY NOT NULL, run_id TEXT, bot_id TEXT, scope_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('activated','superseded','merged','retired-stale','retired-time','archived-contradicted',
 'procedure-proposed','procedure-published','pruned-batch','connection-defaulted','settings-migrated','owner-undo','owner-keep')),
 record_id TEXT, record_version INTEGER, prior_id TEXT, prior_version INTEGER,
 source_id TEXT, source_revision INTEGER,
 procedure_review_id TEXT, receipt_id TEXT, count INTEGER CHECK(count IS NULL OR count>=0),
 detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail) AND json_type(detail)='object'),
 created_at INTEGER NOT NULL CHECK(created_at>=0), undone_at INTEGER, kept_at INTEGER, digest_day TEXT);
CREATE INDEX IF NOT EXISTS memory_learning_events_created ON memory_learning_events(created_at);
CREATE INDEX IF NOT EXISTS memory_learning_events_record ON memory_learning_events(record_id,record_version);
CREATE INDEX IF NOT EXISTS memory_learning_events_source ON memory_learning_events(source_id);
`;
const LEDGER_SCHEMA = ledgerSchema(LEARNING_EVENT_KINDS_V5);
const LEDGER_INDEXES = ["memory_learning_events_created", "memory_learning_events_record", "memory_learning_events_source"];
/** v5 (0.1.63, bot learning): what the owner marked, said and taught, in the
 * same messages.db so one backup, restore, forget and downgrade covers it.
 * No foreign keys: bots live in bots.json, and lessons point at the event
 * ledger by id so the existing undo path serves them. */
const BOT_LEARNING_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_outcomes (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, episode_id TEXT,
 kind TEXT NOT NULL CHECK(kind IN ('won','lost','good','bad','open','metric')),
 label TEXT, reason TEXT, value_num REAL, currency TEXT, metric_key TEXT, metric_window TEXT,
 proposed_by TEXT NOT NULL CHECK(proposed_by IN ('owner','bot','app')),
 confirmed_by TEXT CHECK(confirmed_by IS NULL OR confirmed_by='owner'),
 source_event_key TEXT UNIQUE, guide_revision INTEGER, superseded_by TEXT, expires_at INTEGER,
 created_at INTEGER NOT NULL CHECK(created_at>=0), revoked_at INTEGER);
CREATE INDEX IF NOT EXISTS memory_outcomes_bot_created ON memory_outcomes(bot_id,created_at);
CREATE TABLE IF NOT EXISTS memory_feedback (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, message_id TEXT, target_message_id TEXT,
 target_turn_id TEXT, target_action TEXT,
 polarity TEXT NOT NULL CHECK(polarity IN ('+','-')), strength INTEGER NOT NULL CHECK(strength IN (1,2,3)),
 correction TEXT, confidence REAL,
 state TEXT NOT NULL CHECK(state IN ('detected','lesson','ignored','unsure','expired')),
 scope TEXT NOT NULL CHECK(scope IN ('chat','bot')),
 acknowledged_at INTEGER, created_at INTEGER NOT NULL CHECK(created_at>=0),
 source_on_path_rev TEXT);
CREATE INDEX IF NOT EXISTS memory_feedback_bot_created ON memory_feedback(bot_id,created_at);
CREATE TABLE IF NOT EXISTS memory_lessons (
 id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>=1), parent_id TEXT, bot_id TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('thread','owner','bot','bots','team')),
 recipients TEXT CHECK(recipients IS NULL OR json_valid(recipients)),
 kind TEXT NOT NULL CHECK(kind IN ('style','note')),
 text TEXT NOT NULL CHECK(length(text)<=280),
 origin TEXT NOT NULL CHECK(origin IN ('feedback','edit','mark','typed','suggested')),
 state TEXT NOT NULL CHECK(state IN ('active','suggested','undone','retired','unsupported','stale')),
 evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
 prospect_derived INTEGER NOT NULL DEFAULT 0 CHECK(prospect_derived IN (0,1)), learning_event_id TEXT,
 created_at INTEGER NOT NULL CHECK(created_at>=0), decided_at INTEGER,
 spec TEXT CHECK(spec IS NULL OR json_valid(spec)),
 where_ TEXT CHECK(where_ IS NULL OR where_ IN ('everywhere','with-me','with-others')),
 thread_id TEXT, source_message_id TEXT, target_message_id TEXT,
 CHECK((kind='style')=(spec IS NOT NULL)),
 PRIMARY KEY(id,version));
CREATE INDEX IF NOT EXISTS memory_lessons_bot_state ON memory_lessons(bot_id,state);
CREATE TABLE IF NOT EXISTS memory_episodes (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, thread_id TEXT, start_message_id TEXT, end_message_id TEXT,
 kind TEXT, leakage_group TEXT, person_id TEXT, week TEXT,
 classification TEXT NOT NULL CHECK(classification IN ('owner','prospect')),
 eligible INTEGER NOT NULL DEFAULT 0 CHECK(eligible IN (0,1)), excluded_at INTEGER,
 source_revisions TEXT CHECK(source_revisions IS NULL OR json_valid(source_revisions)));
CREATE INDEX IF NOT EXISTS memory_episodes_bot_group_week ON memory_episodes(bot_id,leakage_group,week);
CREATE TABLE IF NOT EXISTS memory_learning_runs (
 id TEXT PRIMARY KEY NOT NULL, bot_id TEXT NOT NULL, target TEXT CHECK(target IS NULL OR json_valid(target)),
 state TEXT NOT NULL, corpus_digest TEXT, holdout_digest TEXT,
 holdout_groups TEXT CHECK(holdout_groups IS NULL OR json_valid(holdout_groups)),
 definition_revision INTEGER, rubric_version TEXT, connection TEXT,
 usage TEXT CHECK(usage IS NULL OR json_valid(usage)), receipt_id TEXT, reason TEXT,
 created_at INTEGER NOT NULL CHECK(created_at>=0), finished_at INTEGER);
CREATE TABLE IF NOT EXISTS memory_backfill_cursors (
 bot_id TEXT NOT NULL, thread_id TEXT NOT NULL, cursor_message_id TEXT, snapshot_message_id TEXT,
 pages INTEGER NOT NULL DEFAULT 0 CHECK(pages>=0), last_examined_at INTEGER,
 PRIMARY KEY(bot_id,thread_id));
`;
const BOT_LEARNING_TABLES = ["memory_outcomes", "memory_feedback", "memory_lessons", "memory_episodes", "memory_learning_runs", "memory_backfill_cursors"];
/** v6 (1.0, memory-revocation round 3): output lineage in every memory mode.
 * A reply made without a receipt (memory off, capture, paused) still rests on
 * the replies its context carried. Its ROOTS are the replies made under a
 * receipt that its context carried, copied flat (depth 1), held as a
 * DEDUPLICATED ROOT SET: memory_root_sets and memory_root_set_members store
 * each distinct set once, content-addressed by the digest of its sorted
 * members (rootSetId), and memory_output_roots points each reply at one set
 * id; an empty set id is the unprovable marker. A set's member rows are
 * written before its memory_root_sets row, so a set row always means a
 * complete set. memory_session_roots points each retained engine session at
 * the set it was shown (every v6 session has a row, an empty set included:
 * a session with receipts and no row predates lineage). memory_lineage_meta
 * keeps when lineage began (dispatch.ts retainedSessionInvalid). */
const LINEAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_root_sets (
 set_id TEXT PRIMARY KEY NOT NULL, size INTEGER NOT NULL CHECK(size>=0));
CREATE TABLE IF NOT EXISTS memory_root_set_members (
 set_id TEXT NOT NULL, root_thread_id TEXT NOT NULL, root_message_id TEXT NOT NULL,
 PRIMARY KEY(set_id,root_thread_id,root_message_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_root_set_members_root ON memory_root_set_members(root_thread_id,root_message_id);
CREATE TABLE IF NOT EXISTS memory_output_roots (
 thread_id TEXT NOT NULL, message_id TEXT NOT NULL, set_id TEXT NOT NULL,
 PRIMARY KEY(thread_id,message_id));
CREATE INDEX IF NOT EXISTS memory_output_roots_set ON memory_output_roots(set_id);
CREATE TABLE IF NOT EXISTS memory_session_roots (
 thread_id TEXT NOT NULL, driver_instance TEXT NOT NULL, native_session TEXT NOT NULL, set_id TEXT NOT NULL,
 PRIMARY KEY(thread_id,driver_instance,native_session));
CREATE TABLE IF NOT EXISTS memory_lineage_meta (
 id INTEGER PRIMARY KEY CHECK(id=1), since INTEGER NOT NULL CHECK(since>=0));
`;
const LINEAGE_TABLES = ["memory_output_roots", "memory_session_roots", "memory_root_set_members", "memory_root_sets", "memory_lineage_meta"];
/** A root key: `thread\u0000message`. */
const ROOT_KEY_SEP = "\u0000";
/** The content address of a root set: the digest of its sorted, distinct members. */
export function rootSetId(keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].sort();
  return `rs1:${createHash("sha256").update(sorted.join("\n")).digest("hex")}`;
}
/** Stores a root set once (a set already held is reused) and returns its id.
 * Members first, then the set row, inside one savepoint: a set row is only
 * ever there for a complete set. */
export function storeRootSet(db: DatabaseSync, keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].sort(), id = rootSetId(sorted);
  if (db.prepare("SELECT 1 FROM memory_root_sets WHERE set_id=?").get(id)) return id;
  db.exec("SAVEPOINT memory_root_set");
  try {
    // one statement for all members
    const pairs = sorted.map(key => { const at = key.indexOf(ROOT_KEY_SEP); return [key.slice(0, at), key.slice(at + 1)]; });
    db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?,value->>0,value->>1 FROM json_each(?)").run(id, JSON.stringify(pairs));
    db.prepare("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, sorted.length);
    db.exec("RELEASE memory_root_set");
  } catch (error) { db.exec("ROLLBACK TO memory_root_set; RELEASE memory_root_set"); throw error; }
  return id;
}
/** Pre-v6 replies: in each thread, every bot text reply after the thread's
 * first receipt output references the root set of the receipt outputs before
 * it in that thread (replies between two outputs share one set). Additive and
 * fail closed: it writes only the lineage tables (an OFF reply of the old
 * format carried no lineage, so whatever came before it may be what it
 * repeats). No marker is written for valid memory: a set is never truncated. */
function backfillOutputRoots(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get()) return;
  const insert = db.prepare("INSERT OR IGNORE INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  const threads = db.prepare("SELECT DISTINCT thread_id FROM memory_disclosure_outputs").all().map(row => String(row.thread_id));
  for (const thread of threads) {
    const outputs = new Set(db.prepare("SELECT DISTINCT message_id FROM memory_disclosure_outputs WHERE thread_id=?").all(thread).map(row => String(row.message_id)));
    const before: string[] = [];
    let setId: string | undefined;
    for (const row of db.prepare("SELECT id,role,kind FROM messages WHERE thread_id=? ORDER BY at,rowid").all(thread)) {
      const id = String(row.id);
      if (before.length && row.role === "bot" && row.kind === "text") {
        setId ??= storeRootSet(db, before.map(root => `${thread}${ROOT_KEY_SEP}${root}`));
        insert.run(thread, id, setId);
      }
      if (outputs.has(id)) { before.push(id); setId = undefined; }
    }
  }
}
export const MEMORY_SCHEMA_VERSION = 6;
const SHAPE_MARKER = "memory-shape-check";
/** The frozen v2 text (0.1.54 to 0.1.60), for validation and the v3 -> v2 inverse. */
export const MEMORY_SCHEMA_V2 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=2)") + LEARNING_SCHEMA;
export const MEMORY_SCHEMA_V3 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=3)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA;
/** The frozen v4 text (0.1.62 development), for validation and the v5 -> v4 inverse. */
export const MEMORY_SCHEMA_V4 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=4)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA_V4;
/** The frozen v5 text (0.1.62 to the 1.0 merge), for validation and the v6 -> v5 inverse. */
export const MEMORY_SCHEMA_V5 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=5)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA;
export const MEMORY_SCHEMA = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=6)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA + LINEAGE_SCHEMA;
const SCHEMA_TEXT: Record<number, string> = { 1: MEMORY_SCHEMA_V1, 2: MEMORY_SCHEMA_V2, 3: MEMORY_SCHEMA_V3, 4: MEMORY_SCHEMA_V4, 5: MEMORY_SCHEMA_V5, 6: MEMORY_SCHEMA };

type SchemaRow = {type: string; name: string; tbl_name: string; sql: string | null};
const expected = new Map<number, Map<string, SchemaRow>>();
function expectedSchema(version: number) {
  const cached = expected.get(version);
  if (cached) return cached;
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(SCHEMA_TEXT[version]!);
    const schema = new Map((db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[]).map(row => [row.name,row]));
    expected.set(version, schema);
    return schema;
  } finally { db.close(); }
}

/** Read-only archive validation. Never executes schema supplied by an archive.
 *
 * `references` controls the FULL-FILE foreign key sweep. It is the one check
 * here that is not proportional to the schema: `PRAGMA foreign_key_check`
 * walks every reference in the database, measured at 1.86s on a real 312MB
 * store, while every other check in this function costs single-digit
 * milliseconds. It ran on EVERY database open, including the overwhelmingly
 * common one where the schema is already current and nothing is going to be
 * rewritten — around two seconds of every app start, spent re-proving what
 * `PRAGMA foreign_keys=ON` (set in database()) already enforces on every
 * write this installation makes.
 *
 * So it is spent where it can still buy something: a schema rewrite, and any
 * file that came from outside this installation — restore, merge, archive,
 * downgrade. Those keep the sweep, and it defaults to on, so a new caller
 * gets the strict behaviour unless it opts out on purpose. A boolean is
 * evaluated lazily as a callback when the decision depends on the meta row,
 * which this function only trusts after it has validated its shape. */
export function validateMemorySchema(db: DatabaseSync, options: { references?: boolean | (() => boolean); incrementalShapes?: boolean } = {}): Set<string> {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const memoryRows = rows.filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return new Set(); // private.7 legacy archive
  // Recognize only an exact known meta table before reading its version field.
  const metaSchema = memoryRows.find(row => row.name === "memory_meta");
  const version = [1, 2, 3, 4, 5, 6].find(value => metaSchema?.sql === expectedSchema(value).get("memory_meta")?.sql);
  if (!version) {
    // A newer Murage wrote this file: say so, and name the way out, instead of
    // the bare unsupported-schema code an older build prints.
    const newer = /^CREATE TABLE memory_meta\b[^;]*CHECK\(schema_version=(\d+)\)/.exec(metaSchema?.sql ?? "");
    if (newer && Number(newer[1]) > MEMORY_SCHEMA_VERSION) throw memorySchemaNewerError(Number(newer[1]));
    throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const schema = expectedSchema(version);
  if (memoryRows.length !== schema.size) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== version || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  const sweep = options.references ?? true;
  const full = typeof sweep === "function" ? sweep() : sweep;
  if (full && db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("INVALID_MEMORY_REFERENCE");
  // The output index is derived: a file from outside this installation (an
  // archive, a merge) whose index lost a row would hide a receipt from the
  // per-message replay check, so the full sweep proves it matches the JSON.
  if (full && version >= 3 && (db.prepare(`SELECT 1 FROM memory_disclosures d, json_each(d.output_message_ids) j WHERE j.type='text'
    AND NOT EXISTS (SELECT 1 FROM memory_disclosure_outputs o WHERE o.bundle_id=d.bundle_id AND o.thread_id=d.thread_id AND o.message_id=j.value) LIMIT 1`).get()
    || db.prepare(`SELECT 1 FROM memory_disclosure_outputs o WHERE NOT EXISTS (SELECT 1 FROM memory_disclosures d, json_each(d.output_message_ids) j
    WHERE d.bundle_id=o.bundle_id AND d.thread_id=o.thread_id AND j.type='text' AND j.value=o.message_id) LIMIT 1`).get())) throw new Error("INVALID_MEMORY_OUTPUT_INDEX");
  // The shape of the JSON columns. A file from outside this installation is always read in full. This
  // installation's own file, on a plain open, is read in full only when the memory schema version or the
  // revision of the shapes list below differs from the last open's (a marker beside the other cursors);
  // otherwise only the rows added since the last open (a rowid seek past the recorded high-water mark) are read.
  // The marker is deliberately NOT keyed on the app version: rows below a mark were already validated against
  // this same shapes list, and the columns carry CHECK(json_valid) and are written as JSON.stringify of an
  // object or array, so a row below the mark cannot have changed shape. Rows written by any other build,
  // including older ones that keep no marks, land above the mark or make a table's newest rowid fall below it
  // (rows deleted, rowids reused), and that table is then read in full. So an app update alone needs no full
  // read (on a large messages.db it blocked startup for minutes); a change to the shapes list or the schema
  // version still forces one.
  const shapes: Array<[string,string,string]> = [
    ["memory_scopes","audience","array"], ["memory_scope_bindings","intent","object"],
    ["memory_source_versions","payload","object"], ["memory_disclosures","record_versions","array"],
    ["memory_disclosures","source_versions","array"], ["memory_disclosures","output_message_ids","array"],
  ];
  const shapesRevision = createHash("sha256").update(JSON.stringify(shapes)).digest("hex").slice(0, 12);
  const track = Boolean(options.incrementalShapes);
  let marks: Record<string,number> | null = null, legacyMarker = false;
  if (track) {
    try {
      const saved = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(SHAPE_MARKER)?.intent ?? "null"));
      if (saved && saved.schema === version && saved.marks && typeof saved.marks === "object") {
        // Markers written before the revision field ({schema, app, marks}) were taken against exactly this
        // shapes list (unchanged since that format landed in fc88150b0), so they are accepted and upgraded.
        if (saved.shapes === shapesRevision) marks = saved.marks;
        else if (saved.shapes === undefined && "app" in saved) { marks = saved.marks; legacyMarker = true; }
      }
    } catch { /* checked in full */ }
  }
  const next: Record<string,number> = {};
  for (const [table,column,kind] of shapes) {
    const key = `${table}.${column}`, newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0), mark = marks?.[key];
    const from = typeof mark === "number" && Number.isSafeInteger(mark) && newest >= mark ? mark : null;
    const bad = from === null ? db.prepare(`SELECT 1 FROM ${table} WHERE json_type(${column})!=? LIMIT 1`).get(kind)
      : db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND json_type(${column})!=? LIMIT 1`).get(from, kind);
    if (bad) throw new Error("INVALID_MEMORY_JSON_SHAPE");
    next[key] = newest;
  }
  // Column value checks keep their marks in the same marker but are NOT part of the shapes list above: the
  // shapes revision is unchanged, so markers written before this check stay valid for the JSON shapes. A marker
  // without an entry for a check reads that column in full once and records it.
  const key = "memory_records.assertion", table = "memory_records";
  const newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0), mark = marks?.[key];
  const from = typeof mark === "number" && Number.isSafeInteger(mark) && newest >= mark ? mark : null;
  const BAD_ASSERTION = "assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import')";
  if (from === null ? db.prepare(`SELECT 1 FROM ${table} WHERE ${BAD_ASSERTION} LIMIT 1`).get() : db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND ${BAD_ASSERTION} LIMIT 1`).get(from)) throw new Error("INVALID_MEMORY_ASSERTION");
  next[key] = newest;
  if (version >= 2) {
    const settings = db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get();
    if (!settings || !(version>=4?memoryLearningSchema:memoryLearningV1Schema).safeParse(JSON.parse(String(settings.settings))).success) throw new Error("INVALID_MEMORY_LEARNING_CONFIG");
    // The record-details anti-join keeps its newest-rowid mark in the same marker, like the assertion check
    // above: a marker without the key, or a table whose newest rowid fell below the mark, reads in full once.
    const detailsKey = "memory_records.details", detailsMark = marks?.[detailsKey];
    const detailsFrom = typeof detailsMark === "number" && Number.isSafeInteger(detailsMark) && newest >= detailsMark ? detailsMark : null;
    const noDetails = "SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON r.id=d.record_id AND r.version=d.record_version WHERE d.record_id IS NULL";
    if (detailsFrom === null ? db.prepare(`${noDetails} LIMIT 1`).get() : db.prepare(`${noDetails} AND r.rowid>? LIMIT 1`).get(detailsFrom)) throw new Error("INVALID_MEMORY_RECORD_DETAILS");
    next[detailsKey] = newest;
  }
  // Written last, so a refused check never records a mark past rows it did not accept.
  if (track && (legacyMarker || JSON.stringify(next) !== JSON.stringify(marks))) {
    // The marker rides on the workspace scope, which is never retired. An unordered LIMIT 1 picked whichever scope
    // the index returned first (a team or room scope), and that scope could then not be removed or renamed away.
    const scope = db.prepare("SELECT id FROM memory_scopes ORDER BY kind='workspace' DESC, rowid LIMIT 1").get()?.id;
    if (scope != null) db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','memory-shape-check',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent,scope_id=excluded.scope_id")
      .run(SHAPE_MARKER, scope, JSON.stringify({ schema: version, shapes: shapesRevision, marks: next }));
  }
  if(full && version>=4 && db.prepare(`SELECT 1 FROM memory_learning_events e WHERE
    NOT EXISTS(SELECT 1 FROM memory_scopes s WHERE s.id=e.scope_id)
    OR (e.record_id IS NOT NULL AND e.record_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_records r WHERE r.id=e.record_id AND r.version=e.record_version)) LIMIT 1`).get())throw new Error("INVALID_MEMORY_LEARNING_EVENT");
  // Every active lesson is served by the event ledger's undo path (design 15).
  if (full && version >= 5 && db.prepare(`SELECT 1 FROM memory_lessons l WHERE l.state='active'
    AND (l.learning_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM memory_learning_events e WHERE e.id=l.learning_event_id)) LIMIT 1`).get()) throw new Error("INVALID_MEMORY_LESSON_EVENT");
  return new Set(memoryRows.map(row => row.name));
}

/** Consistent single-file copy of a v1 messages.db, taken before the one-way
 * v1 -> v2 memory migration so a 0.1.53 install can be restored by hand.
 * Lives beside messages.db in the data dir; backup sweeps classify it as
 * excluded so it is never archived twice or restored as live data. */
export const MEMORY_PRE_V2_SNAPSHOT = "messages.pre-memory-v2.db";
/** The same, taken before the v2 -> v3 migration (0.1.61), so a 0.1.60
 * reinstall can use the file as it was. */
export const MEMORY_PRE_V3_SNAPSHOT = "messages.pre-memory-v3.db";

export const MEMORY_PRE_V4_SNAPSHOT = "messages.pre-memory-v4.db";

/** Why an upgrade did not run or did not finish, for the app to show a person.
 * `code` comes from a closed set; the message is plain sentences. */
export type MemoryMigrationCode = "MEMORY_MIGRATION_DISK_SPACE" | "MEMORY_SCHEMA_NEWER";
export class MemoryMigrationError extends Error {
  readonly code: MemoryMigrationCode;
  readonly needBytes?: number;
  readonly freeBytes?: number | null;
  readonly shortBytes?: number;
  readonly newerVersion?: number;
  constructor(code: MemoryMigrationCode, message: string, detail: { needBytes?: number; freeBytes?: number | null; shortBytes?: number; newerVersion?: number } = {}) {
    super(message);
    this.name = "MemoryMigrationError";
    this.code = code;
    Object.assign(this, detail);
  }
}

/** "1.3 GB" / "640 MB", rounded up so a person who frees exactly that much has enough. */
export function describeBytes(bytes: number): string {
  const mb = Math.max(1, Math.ceil(bytes / 1048576));
  return mb >= 1024 ? `${(Math.ceil(bytes / 107374182.4) / 10).toFixed(1)} GB` : `${mb} MB`;
}

function diskSpaceError(needBytes: number, freeBytes: number | null, happened: "before" | "during"): MemoryMigrationError {
  // "During": the check passed (or the volume could not say), so the free figure
  // already proved wrong; never ask for less than one more working margin.
  const shortBytes = happened === "before"
    ? Math.max(0, needBytes - (freeBytes ?? 0))
    : Math.max(needBytes - (freeBytes ?? 0), MIN_HEADROOM_BYTES);
  const message = happened === "before"
    ? `MEMORY_MIGRATION_DISK_SPACE: Murage needs about ${describeBytes(needBytes)} of free disk space to upgrade your memory and only ${describeBytes(freeBytes ?? 0)} is free. Free up at least ${describeBytes(shortBytes)} (empty the Trash or remove files you no longer need), then open Murage again. Nothing has been changed.`
    : `MEMORY_MIGRATION_DISK_SPACE: The disk filled up while Murage was upgrading your memory. Nothing was changed and the partial copy was removed. Free up at least ${describeBytes(shortBytes)}, then open Murage again.`;
  return new MemoryMigrationError("MEMORY_MIGRATION_DISK_SPACE", message, { needBytes, freeBytes, shortBytes });
}

function memorySchemaNewerError(newerVersion: number): MemoryMigrationError {
  return new MemoryMigrationError("MEMORY_SCHEMA_NEWER",
    `MEMORY_SCHEMA_NEWER: Your data was last opened by a newer version of Murage (memory format ${newerVersion}; this version reads up to ${MEMORY_SCHEMA_VERSION}). Install the latest version of Murage to open it. To keep using this version instead, quit Murage and run the newer version's downgrade step: installation-recovery memory-downgrade --data-dir <your Murage data folder> --to ${MEMORY_SCHEMA_VERSION}.`,
    { newerVersion });
}

/** SQLITE_FULL (errcode 13), ENOSPC, or their messages, whichever layer reported it. */
export function isDiskFullError(error: unknown): boolean {
  const e = error as { errcode?: number; code?: string; message?: string } | null;
  if (!e) return false;
  return e.errcode === 13 || e.code === "ENOSPC" || /disk is full|SQLITE_FULL|ENOSPC|no space left/i.test(String(e.message ?? ""));
}

export type MemoryMigrationPhase = { phase: "checking" | "copying" | "migrating"; from: number; dbBytes: number; copyBytes: number; needBytes: number; freeBytes: number | null; partialPath?: string };

export interface MigrateMemoryOptions {
  snapshotV3Path?: string;
  /** Where to write the pre-migration copy of a v1 file. Omitted: no copy (restore/merge paths, tests). */
  snapshotPath?: string;
  /** Where to write the pre-migration copy of a v2 file. Omitted: no copy. */
  snapshotV2Path?: string;
  /** Free bytes on the volume that holds the copy. Default: statfs of the copy's folder; no copy path, no check. */
  freeBytes?: () => number | null;
  /** Writes the consistent copy to the given path. Default: VACUUM INTO. A test injects a failing disk here. */
  copy?: (db: DatabaseSync, path: string) => void;
  /** Called as each step starts, for the start-up screen. Never throws into the upgrade. */
  onPhase?: (event: MemoryMigrationPhase) => void;
}

/** The copy is written beside its final name and renamed into place, so a file
 * at the final name is always complete (an app quit or killed mid-copy leaves
 * only the `.partial` name, which the next start discards). */
export const MEMORY_SNAPSHOT_PARTIAL_SUFFIX = ".partial";

/** The copy must open, pass SQLite's quick check and carry the version being left, or it is not a way back. */
function verifySnapshot(path: string, version: number) {
  let copy: DatabaseSync | undefined;
  try {
    copy = new DatabaseSync(path, { readOnly: true });
    const check = copy.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    if (Object.values(check ?? {})[0] !== "ok") throw new Error("the copy failed SQLite's quick check");
    const found = Number(copy.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version);
    if (found !== version) throw new Error(`the copy is version ${found}, expected ${version}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`MEMORY_SCHEMA_SNAPSHOT_FAILED: ${reason}`), { code: "MEMORY_SCHEMA_SNAPSHOT_FAILED", cause: error });
  } finally { try { copy?.close(); } catch { /* never opened */ } }
}

function snapshotBeforeMigration(db: DatabaseSync, path: string, options: MigrateMemoryOptions, plan: { needBytes: number }, version: number) {
  const partial = `${path}${MEMORY_SNAPSHOT_PARTIAL_SUFFIX}`;
  removePartial(partial); // a killed earlier attempt
  if (existsSync(path)) { verifySnapshot(path, version); return; } // an earlier attempt already preserved the older file; it is checked, not trusted
  if (db.isTransaction) throw new Error("MEMORY_SCHEMA_SNAPSHOT_FAILED: VACUUM INTO cannot run inside a transaction");
  try {
    (options.copy ?? ((handle, target) => { handle.prepare("VACUUM INTO ?").run(target); }))(db, partial);
    try { chmodSync(partial, 0o600); } catch { /* matches messages.db handling on platforms without POSIX modes */ }
    // VACUUM INTO never fsyncs its output, and the upgrade that follows commits
    // with synchronous=FULL: flush the copy before it gets its final name, and
    // the folder after, so a power cut cannot leave a v4 messages.db beside a
    // copy whose pages never reached the disk.
    flushFile(partial);
    verifySnapshot(partial, version);
    renameWithRetry(partial, path);
    flushFolder(dirname(path));
  } catch (error) {
    try { removePartial(partial); } catch { /* partial output already absent */ }
    try { rmSync(path, { force: true }); } catch { /* never created */ }
    if (isDiskFullError(error)) {
      let free: number | null = null;
      try { free = options.freeBytes ? options.freeBytes() : freeBytesFor(path); } catch { /* unknown */ }
      throw Object.assign(diskSpaceError(plan.needBytes, free, "during"), { cause: error });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw Object.assign(new Error(`MEMORY_SCHEMA_SNAPSHOT_FAILED: ${reason}`), { code: "MEMORY_SCHEMA_SNAPSHOT_FAILED", cause: error });
  }
}

/** The file calls that make the copy durable, as one object so a test can
 * observe their order (vi.mock cannot reach node:fs here). */
export const memorySnapshotIo = { fsyncSync, renameSync };
/** The copy and the side files SQLite writes beside it: VACUUM INTO keeps a
 * rollback journal for its output, and a real full disk leaves
 * `<name>.partial-journal` behind (seen on a 48 MB tmpfs). */
function removePartial(partial: string) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${partial}${suffix}`, { force: true });
}
function flushFile(path: string) {
  const fd = openSync(path, "r+");
  try { memorySnapshotIo.fsyncSync(fd); } finally { closeSync(fd); }
}
function flushFolder(path: string) {
  if (process.platform === "win32") return; // NTFS commits the rename itself; a folder cannot be opened for fsync
  let fd: number | undefined;
  try { fd = openSync(path, "r"); memorySnapshotIo.fsyncSync(fd); } catch { /* some file systems refuse a folder fsync */ } finally { if (fd !== undefined) closeSync(fd); }
}
/** Windows: a virus scanner or indexer can hold a just-written file for a
 * moment, failing the rename with EPERM/EBUSY/EACCES. Retry for about 2 s. */
function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try { memorySnapshotIo.renameSync(from, to); return; } catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 20 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

/** Free bytes from a statfs result, or null when the volume does not report a
 * usable size (some network and FUSE mounts answer all zeros): unknown, not full. */
export function freeBytesFromStatfs(stats: { blocks: number | bigint; bavail: number | bigint; bsize: number | bigint }): number | null {
  const blocks = Number(stats.blocks), bavail = Number(stats.bavail), bsize = Number(stats.bsize);
  if (!Number.isFinite(blocks) || !Number.isFinite(bavail) || !Number.isFinite(bsize) || blocks <= 0 || bsize <= 0 || bavail < 0) return null;
  return bavail * bsize;
}
function freeBytesFor(path: string): number | null {
  return freeBytesFromStatfs(statfsSync(dirname(path)));
}

/** Bytes the pre-migration copy will take (VACUUM INTO writes live pages only). */
function liveBytes(db: DatabaseSync): { dbBytes: number; copyBytes: number } {
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 4096);
  const pages = Number(db.prepare("PRAGMA page_count").get()?.page_count ?? 0);
  const free = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
  return { dbBytes: pages * pageSize, copyBytes: Math.max(0, pages - free) * pageSize };
}
/** Room the upgrade transaction itself needs in the write-ahead log. */
const MIN_HEADROOM_BYTES = 64 * 1048576;
const migrationHeadroom = (copyBytes: number) => Math.max(MIN_HEADROOM_BYTES, Math.ceil(copyBytes * 0.1));

/** Tier 1 amended v5 in place (design note D5: no published release carries v5, the published and draft releases carry 2). A development
 * build that ran the earlier v5 holds memory_lessons and memory_feedback in the old shape. Rebuild just those two tables, in one
 * transaction, before anything validates: old free-text lessons become notes for the owner's chats (a shared copy keeps its scope). */
export function upgradeDevelopmentV5(db: DatabaseSync): boolean {
  const lessons = db.prepare("SELECT sql FROM sqlite_schema WHERE name='memory_lessons'").get();
  if (!lessons || String(lessons.sql).includes("where_")) return false;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get() || Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version) !== 5) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP INDEX IF EXISTS memory_lessons_bot_state; DROP INDEX IF EXISTS memory_feedback_bot_created;
      ALTER TABLE memory_lessons RENAME TO memory_lessons_dev; ALTER TABLE memory_feedback RENAME TO memory_feedback_dev;`);
    db.exec(BOT_LEARNING_SCHEMA);
    db.exec(`INSERT INTO memory_feedback(id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at)
        SELECT id,bot_id,thread_id,message_id,target_message_id,target_turn_id,target_action,polarity,strength,correction,confidence,state,scope,acknowledged_at,created_at FROM memory_feedback_dev;
      INSERT INTO memory_lessons(id,version,parent_id,bot_id,scope,recipients,kind,text,origin,state,evidence,prospect_derived,learning_event_id,created_at,decided_at)
        SELECT id,version,parent_id,bot_id,CASE WHEN scope='bot' AND parent_id IS NULL THEN 'owner' ELSE scope END,recipients,'note',text,origin,state,evidence,prospect_derived,learning_event_id,created_at,decided_at FROM memory_lessons_dev;
      DROP TABLE memory_lessons_dev; DROP TABLE memory_feedback_dev;`);
    db.exec("COMMIT");
    return true;
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}

export function migrateMemorySchema(db: DatabaseSync, initialMode: "off" | "active" = "off", options: MigrateMemoryOptions = {}) {
  upgradeDevelopmentV5(db);
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get();
  // Structure, meta and row shapes on every open; the whole-file reference
  // sweep only when this open is actually going to rewrite the schema.
  if (exists) validateMemorySchema(db, { incrementalShapes: true, references: () => db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version !== MEMORY_SCHEMA_VERSION });
  if (exists) startupMark("validateMemorySchema");
  const from = exists ? Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version) : 0;
  const plan: { needBytes: number; probe: () => number | null } = { needBytes: 0, probe: () => null };
  if (exists) {
    if (from === MEMORY_SCHEMA_VERSION) return;
    // One copy per upgrade, chosen by the version being left: a 0.1.61 (v2)
    // file goes straight to v4 with a single pre-v3 copy. The pre-v4 copy
    // exists only for a development build that stopped at v3.
    // Fail closed: without the copy the upgrade would be irreversible for a 0.1.53 (v1) or 0.1.61 (v2) reinstall.
    const snapshot = from === 1 ? options.snapshotPath : from === 2 ? options.snapshotV2Path : from === 3 ? options.snapshotV3Path : undefined;
    const sizes = liveBytes(db);
    const copying = Boolean(snapshot) && !existsSync(snapshot!);
    const needBytes = (copying ? sizes.copyBytes : 0) + migrationHeadroom(sizes.copyBytes);
    plan.needBytes = needBytes;
    plan.probe = () => options.freeBytes ? options.freeBytes() : snapshot ? freeBytesFor(snapshot) : null;
    const emit = (phase: MemoryMigrationPhase["phase"], free: number | null) => {
      try { options.onPhase?.({ phase, from, ...sizes, needBytes, freeBytes: free, ...(snapshot ? { partialPath: `${snapshot}${MEMORY_SNAPSHOT_PARTIAL_SUFFIX}` } : {}) }); } catch { /* a status write never stops an upgrade */ }
    };
    let free: number | null = null;
    emit("checking", null);
    if (snapshot || options.freeBytes) {
      try { free = options.freeBytes ? options.freeBytes() : freeBytesFor(snapshot!); } catch { free = null; /* unknown volume: do not block */ }
      // Checked BEFORE anything is written: a short disk leaves messages.db untouched at its old version.
      if (free !== null && free < needBytes) throw diskSpaceError(needBytes, free, "before");
    }
    if (snapshot) { emit("copying", free); snapshotBeforeMigration(db, snapshot, options, { needBytes }, from); }
    emit("migrating", free);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (exists) {
      // v4 -> v5 widens the ledger's kind CHECK, which SQLite only allows by rebuilding the table.
      if (from === 4) db.exec(`${LEDGER_INDEXES.map(name => `DROP INDEX ${name};`).join("")} ALTER TABLE memory_learning_events RENAME TO memory_learning_events_v4;`);
      db.exec("ALTER TABLE memory_meta RENAME TO memory_meta_previous;");
      db.exec(MEMORY_SCHEMA);
      if (from === 4) db.exec("INSERT INTO memory_learning_events SELECT * FROM memory_learning_events_v4; DROP TABLE memory_learning_events_v4;");
      db.exec(`INSERT INTO memory_meta SELECT id,${MEMORY_SCHEMA_VERSION},installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta_previous;
        DROP TABLE memory_meta_previous;`);
      if (from === 1) db.exec(`INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at)
        SELECT id,version,CASE kind WHEN 'source' THEN 'episodic' WHEN 'checkpoint' THEN 'working' WHEN 'procedure' THEN 'procedural' WHEN 'identity' THEN 'identity' ELSE 'semantic' END,
          CASE WHEN state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
          CASE WHEN state='candidate' THEN 'provisional' ELSE 'current' END,NULL FROM memory_records;`);
      db.exec(OUTPUT_INDEX_BACKFILL);
      backfillOutputRoots(db);
    } else {
      db.exec(MEMORY_SCHEMA);
      db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,?,?,?)").run(MEMORY_SCHEMA_VERSION,randomUUID(),initialMode);
    }
    // When output lineage began (v6).
    db.prepare("INSERT OR IGNORE INTO memory_lineage_meta(id,since) VALUES(1,?)").run(Date.now());
    if (from < 2) {
      const learning = exists ? { ...DEFAULT_MEMORY_LEARNING, reviewMode: true } : DEFAULT_MEMORY_LEARNING;
      db.prepare("INSERT INTO memory_learning_config VALUES(1,0,?)").run(JSON.stringify(learning));
    } else if (from < 4) {
      // Settings change shape only on the way to v4; a v4 file already holds the current shape.
      const row=db.prepare("SELECT revision,settings FROM memory_learning_config WHERE id=1").get()!;
      const old=memoryLearningV1Schema.parse(JSON.parse(String(row.settings)));
      db.prepare("UPDATE memory_learning_config SET settings=? WHERE id=1").run(JSON.stringify(upgradeMemoryLearning(old,Number(row.revision))));
      if(Number(row.revision)>0 && old.dailyCostUsd!==null){
        const meta=db.prepare("SELECT installation_id FROM memory_meta").get()!;
        let scope=db.prepare("SELECT id FROM memory_scopes WHERE kind='workspace' AND owner_key=?").get(meta.installation_id)?.id;
        if(!scope){scope=randomUUID();db.prepare("INSERT INTO memory_scopes VALUES(?,'workspace',?,'[]',0)").run(scope,meta.installation_id);}
        db.prepare("INSERT INTO memory_learning_events(id,scope_id,kind,detail,created_at) VALUES(?,?,'settings-migrated',?,?)").run(randomUUID(),scope,JSON.stringify({retired:"daily-ceiling"}),Date.now());
      }
    }
    const preserved=db.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-learning-v4-preserved' AND subject_type='system' AND subject_id='learning-v4-preserved' AND state='granted'").get();
    if(preserved){
      const value=JSON.parse(String(preserved.intent));
      const current=JSON.parse(String(db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get()!.settings));
      const restored=memoryLearningSchema.parse({...current,botsPaused:value.botsPaused,learnFrom:value.learnFrom});
      db.prepare("UPDATE memory_learning_config SET settings=? WHERE id=1").run(JSON.stringify(restored));
      db.exec("DELETE FROM memory_scope_bindings WHERE id='memory-learning-v4-preserved'");
    }
    if(from>=2&&from<=3)for(const row of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").all()){
      const budget=JSON.parse(String(row.intent));if(typeof budget.input!=="number")continue;
      budget.input=Math.ceil(budget.input/3.5);db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(budget),row.id);
    }
    validateMemorySchema(db);
    db.exec("COMMIT");
  } catch (error) {
    // SQLite rolls a transaction back by itself on SQLITE_FULL; a second ROLLBACK
    // would throw and hide the real error. The whole upgrade is this one
    // transaction, so messages.db is at its old version or fully at the new one.
    if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
    if (isDiskFullError(error) && !(error instanceof MemoryMigrationError)) {
      // The rolled-back frames still occupy the write-ahead log, and the server
      // exits on this error without closing the database: hand that space back
      // now, so the free figure below and the next start's check are real.
      try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
      let free: number | null = null;
      try { free = plan.probe(); } catch { /* unknown */ }
      throw Object.assign(diskSpaceError(plan.needBytes, free, "during"), { cause: error });
    }
    throw error;
  }
}

/** Exact inverse of the migrations above, one version at a time, for
 * reinstalling an older build: to 2 (0.1.54 to 0.1.60) drops the derived
 * output index and its triggers; to 1 (0.1.53 and older) also drops the two
 * learning tables and their triggers. Each step restores the frozen
 * memory_meta text of its version. Chats and memory rows written after the
 * upgrade survive; what is dropped is derived or learning-only, and the next
 * newer start re-runs the same migration. Caller owns no transaction. */
export function downgradeMemorySchema(db: DatabaseSync, to: 1 | 2 | 3 | 4 | 5 = 1): { status: "downgraded" | "already-v1" | "already-v2" | "already-v3" | "already-v4" | "already-v5"; from: number; to: 1 | 2 | 3 | 4 | 5 } {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get()) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  validateMemorySchema(db);
  const from = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version);
  if (from <= to) return { status: to === 1 ? "already-v1" : to === 2 ? "already-v2" : to === 3 ? "already-v3" : to === 4 ? "already-v4" : "already-v5", from, to };
  if (from > MEMORY_SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let version = from; version > to; version--) {
      // Output lineage is derived from replies already kept; the next newer start backfills it again.
      if (version === 6) for (const table of LINEAGE_TABLES) db.exec(`DROP TABLE ${table};`);
      if (version === 5) {
        // Bot-learning rows are learning-only; the next newer start migrates again. Ledger rows of the new kinds go with them.
        for (const table of BOT_LEARNING_TABLES) db.exec(`DROP TABLE ${table};`);
        db.exec(`DELETE FROM memory_learning_events WHERE kind NOT IN (${quoteKinds(LEARNING_EVENT_KINDS_V4)});
          ${LEDGER_INDEXES.map(name => `DROP INDEX ${name};`).join("")} ALTER TABLE memory_learning_events RENAME TO memory_learning_events_v5;`);
        db.exec(LEDGER_SCHEMA_V4);
        db.exec("INSERT INTO memory_learning_events SELECT * FROM memory_learning_events_v5; DROP TABLE memory_learning_events_v5;");
      }
      if (version === 4) {
        const settings=JSON.parse(String(db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get()!.settings));
        // Older validators accept opaque object-valued system bindings. Preserve only fields they cannot edit.
        const installation=db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()!.installation_id;
        let scope=db.prepare("SELECT id FROM memory_scopes WHERE kind='workspace' AND owner_key=?").get(installation)?.id;
        if(!scope){scope=randomUUID();db.prepare("INSERT INTO memory_scopes VALUES(?,'workspace',?,'[]',0)").run(scope,installation);}
        db.prepare("INSERT INTO memory_scope_bindings VALUES('memory-learning-v4-preserved',?,'system','learning-v4-preserved',0,'granted',?) ON CONFLICT(id) DO UPDATE SET scope_id=excluded.scope_id,subject_type=excluded.subject_type,subject_id=excluded.subject_id,state=excluded.state,intent=excluded.intent")
          .run(scope,JSON.stringify({botsPaused:settings.botsPaused,learnFrom:settings.learnFrom}));
        db.prepare("UPDATE memory_learning_config SET settings=? WHERE id=1").run(JSON.stringify(downgradeMemoryLearning(settings)));
        for(const row of db.prepare("SELECT id,intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").all()){
          const budget=JSON.parse(String(row.intent));if(typeof budget.input!=="number")continue;
          budget.input*=4;db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify(budget),row.id);
        }
        db.exec("DROP TABLE memory_learning_events");
      }
      if (version === 3) db.exec(`DROP TRIGGER memory_disclosure_outputs_insert; DROP TRIGGER memory_disclosure_outputs_update;
        DROP TRIGGER memory_disclosure_outputs_delete; DROP TABLE memory_disclosure_outputs;`);
      if (version === 2) db.exec(`DROP TRIGGER memory_record_details_insert; DROP TRIGGER memory_record_details_state;
        DROP TABLE memory_record_details; DROP TABLE memory_learning_config;`);
      db.exec("ALTER TABLE memory_meta RENAME TO memory_meta_newer;");
      db.exec(SCHEMA_TEXT[version - 1]!); // CREATE IF NOT EXISTS: only memory_meta (older text) is recreated
      db.exec(`INSERT INTO memory_meta SELECT id,${version - 1},installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta_newer;
        DROP TABLE memory_meta_newer;`);
      if (db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version !== version - 1) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
    }
    validateMemorySchema(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { status: "downgraded", from, to };
}
