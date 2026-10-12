import { beginIntegrityPass } from "./integrity-state.ts";
import { UPGRADE_APP_TABLES } from "./upgrade-app-tables.ts";
import { dropWriteRevisionTriggers } from "../app-write-revision.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { BlockingHeartbeat, BlockingStep } from "./blocking-heartbeat.ts";
import { LEARNING_EVENT_KINDS_V4, LEARNING_EVENT_KINDS_V5 } from "./learning-kinds.ts";
import { startupMark } from "../startup-trace.ts";
import { revocationIndexReady } from "./revocation.ts";
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
/** v9 (1.0.2 cold lineage): two indexes and no table. memory_disclosure_outputs_cover holds (thread, message, bundle) so the
 * lineage listings and the output-thread scans are answered from the index alone, without reading the table; memory_sources_kind_outcome
 * serves the start-up settlement scan (settlement.ts) and every other read of sources by kind and outcome. Both are derived from rows
 * already held, so a downgrade just drops them and the next newer start builds them again under the upgrade note. */
export const OUTPUT_COVER_INDEX = "memory_disclosure_outputs_cover";
export const SOURCE_KIND_INDEX = "memory_sources_kind_outcome";
export const COLD_LINEAGE_INDEX_STATEMENTS: ReadonlyArray<{ name: string; sql: string }> = [
  { name: OUTPUT_COVER_INDEX, sql: `CREATE INDEX IF NOT EXISTS ${OUTPUT_COVER_INDEX} ON memory_disclosure_outputs(thread_id,message_id,bundle_id);` },
  { name: SOURCE_KIND_INDEX, sql: `CREATE INDEX IF NOT EXISTS ${SOURCE_KIND_INDEX} ON memory_sources(kind,outcome);` },
];
const COLD_LINEAGE_INDEXES = `\n${COLD_LINEAGE_INDEX_STATEMENTS.map(statement => statement.sql).join("\n")}\n`;
/** Whether one of the v9 cold-lineage indexes is built. A v9 file may lack them while they are built in the background after start
 * (memory/cold-index-build.ts): the validator accepts that state, and the queries that use them fall back until they are there. */
export function coldLineageIndexPresent(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type='index' AND name=?").get(name) !== undefined;
}
/** The v9 indexes of a file that is not built yet. */
export function coldLineageIndexesMissing(db: DatabaseSync): string[] {
  return COLD_LINEAGE_INDEX_STATEMENTS.filter(statement => !coldLineageIndexPresent(db, statement.name)).map(statement => statement.name);
}
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
const LINEAGE_SCHEMA_V6 = `
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
/** v7 (1.0.2): root sets grow linearly. In a long thread every reply's set is
 * the previous reply's set plus the newest receipt output, and v6 stored each
 * one in full (O(n^2) member rows per thread: 10.9 million rows, 3.5 GB, on a
 * real install). A v7 set may name a PARENT set that is a proper subset of
 * it; its member rows then hold only what it adds to the parent, and its
 * members are the union along the chain (rootSetMembers). A set with no
 * parent row holds every member, exactly as in v6, so every v6 set is a valid
 * v7 set and the upgrade itself writes nothing but two empty tables: the
 * conversion of the old full sets runs afterwards in bounded steps
 * (root-set-compaction.ts), recorded in memory_root_set_compaction. A chain is
 * proven on every read: each link strictly smaller than its child, the root
 * of the chain present, and each set's own rows exactly its size minus its
 * parent's; anything else is unprovable and fails closed. */
const MEMBER_ROOT_INDEX = "CREATE INDEX IF NOT EXISTS memory_root_set_members_root ON memory_root_set_members(root_thread_id,root_message_id);\n";
// v7 drops the member index (it only served v6's which-set-holds-this-root
// lookup; v7 judges sets along their chains) and adds the chain tables.
const LINEAGE_SCHEMA = LINEAGE_SCHEMA_V6.replace(MEMBER_ROOT_INDEX, "") + `
CREATE TABLE IF NOT EXISTS memory_root_set_parents (
 set_id TEXT PRIMARY KEY NOT NULL, parent_id TEXT NOT NULL CHECK(parent_id<>set_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_root_set_parents_parent ON memory_root_set_parents(parent_id);
CREATE INDEX IF NOT EXISTS memory_session_roots_set ON memory_session_roots(set_id);
CREATE TABLE IF NOT EXISTS memory_root_set_compaction (
 id INTEGER PRIMARY KEY CHECK(id=1), total INTEGER NOT NULL CHECK(total>=0), done INTEGER NOT NULL CHECK(done>=0),
 cursor TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER, reclaimed_at INTEGER);
`;
const LINEAGE_TABLES_V6 = ["memory_output_roots", "memory_session_roots", "memory_root_set_members", "memory_root_sets", "memory_lineage_meta"];
const LINEAGE_TABLES_V7 = ["memory_root_set_parents", "memory_root_set_compaction"];
/** The (bundle, kind, id, version) rows a receipt cites, extracted from its JSON columns with exactly the
 * expressions revocation used to scan them with (json_extract of '$.id', and '$.version' or '$.revision').
 * `row` is a table alias or NEW; `live` limits it to receipts not yet revoked. */
const disclosureRefs = (row: string, live: string) =>
  `SELECT ${row}.bundle_id,'record',json_extract(j.value,'$.id'),json_extract(j.value,'$.version') FROM json_each(${row}.record_versions) j WHERE ${live} AND json_extract(j.value,'$.id') IS NOT NULL
 UNION ALL SELECT ${row}.bundle_id,'source',json_extract(j.value,'$.id'),json_extract(j.value,'$.revision') FROM json_each(${row}.source_versions) j WHERE ${live} AND json_extract(j.value,'$.id') IS NOT NULL`;
/** v8 (1.0.2 lane D): which live receipts cite which record or source, so a revocation
 * touches only the receipts that cite what changed instead of parsing the JSON of every
 * receipt ever written (scale finding F6). Kept by triggers from memory_disclosures in the
 * writer's own statement, so it can never lag a receipt: a receipt that is not revoked has
 * exactly the rows its JSON names, and a revoked one has none (revocation is final, and
 * keeping them would only make every later lookup walk dead receipts). ref_id and
 * ref_version have no declared type, so they hold the extracted value unconverted (a JSON
 * number stays a number, a string a string). A column with no declared type has BLOB
 * affinity, which json_extract's result does not have, so the revocation statements never
 * compare the bare columns: they compare `+x.ref_id` and `+x.ref_version` (no affinity,
 * exactly like the json_extract they replace) and reach the candidate rows through the
 * expression index on CAST(ref_id AS TEXT), which is what every id comparison against a
 * TEXT id column reduces to (revocation.ts). Ids only, never memory content.
 *
 * An upgrade does not fill it inside the schema transaction: memory_revocation_index_build
 * records how far a resumable, sliced backfill has come (revocation-index.ts, at start-up,
 * under the upgrade note), and until its `ready` flag is set every revocation reads the
 * receipts' JSON as 1.0.1 did, so correctness never rests on a half-built table. Archive,
 * restore, merge and downgrade prove a ready index equal to the JSON (validateMemorySchema,
 * slice by slice); a downgrade drops both tables and the next newer start rebuilds them. */
/** The lookup index. It exists from the moment the table does (empty, so created at once) and every
 * write keeps it: the triggers for new receipts, the backfill's short slices for the older ones
 * (revocation-index.ts). Until the ready flag is set nothing reads it. */
export const REVOCATION_REF_INDEX = "memory_disclosure_refs_ref";
export const REVOCATION_REF_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${REVOCATION_REF_INDEX} ON memory_disclosure_refs(kind,CAST(ref_id AS TEXT))`;
/** The lookup of a scope by (kind, owner): every conversation, bot and room has one, and the start looks up one per thread. Optional like the receipts-state
 * index (an upgrade does not build it inside the schema step; ensureScopeOwnerIndex builds it after the server listens), and exact when present. */
export const SCOPE_OWNER_INDEX = "memory_scopes_owner";
const SCOPE_OWNER_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${SCOPE_OWNER_INDEX} ON memory_scopes(kind,owner_key)`;
export function ensureScopeOwnerIndex(db: DatabaseSync): void {
  // only a file at the current schema may carry it (an older file's structure check accepts no extra object)
  if (Number(db.prepare("SELECT schema_version AS v FROM memory_meta WHERE id=1").get()?.v) !== MEMORY_SCHEMA_VERSION) return;
  db.exec(SCOPE_OWNER_INDEX_SQL);
}
const REVOCATION_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_disclosure_refs (
 bundle_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('record','source')), ref_id NOT NULL, ref_version);
${REVOCATION_REF_INDEX_SQL};
CREATE INDEX IF NOT EXISTS memory_disclosure_refs_bundle ON memory_disclosure_refs(bundle_id);
CREATE INDEX IF NOT EXISTS memory_disclosures_state ON memory_disclosures(state);
${SCOPE_OWNER_INDEX_SQL};
CREATE TABLE IF NOT EXISTS memory_revocation_index_build (
 id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL CHECK(ready IN (0,1)), cursor TEXT,
 done INTEGER NOT NULL DEFAULT 0 CHECK(done>=0), total INTEGER NOT NULL DEFAULT 0 CHECK(total>=0), started_at INTEGER, finished_at INTEGER);
CREATE TRIGGER IF NOT EXISTS memory_disclosure_refs_insert AFTER INSERT ON memory_disclosures WHEN NEW.state!='revoked' BEGIN
 INSERT INTO memory_disclosure_refs(bundle_id,kind,ref_id,ref_version) ${disclosureRefs("NEW", "NEW.state!='revoked'")};
END;
CREATE TRIGGER IF NOT EXISTS memory_disclosure_refs_update AFTER UPDATE OF bundle_id,state,record_versions,source_versions ON memory_disclosures
 WHEN OLD.bundle_id IS NOT NEW.bundle_id OR (OLD.state='revoked') IS NOT (NEW.state='revoked') OR OLD.record_versions IS NOT NEW.record_versions OR OLD.source_versions IS NOT NEW.source_versions BEGIN
 DELETE FROM memory_disclosure_refs WHERE bundle_id=OLD.bundle_id;
 INSERT INTO memory_disclosure_refs(bundle_id,kind,ref_id,ref_version) ${disclosureRefs("NEW", "NEW.state!='revoked'")};
END;
CREATE TRIGGER IF NOT EXISTS memory_disclosure_refs_delete AFTER DELETE ON memory_disclosures BEGIN
 DELETE FROM memory_disclosure_refs WHERE bundle_id=OLD.bundle_id;
END;
`;
/** One slice of receipts by bundle id: (lo, hi], an end open when null. Bundle ids, unlike rowids,
 * survive a VACUUM, so a cursor over them stays true across starts. */
export type BundleRange = { lo: string | null; hi: string | null };
/** The slice as a condition on `column`, bound as ?1 (lo) and ?2 (hi); both are always bound. */
export const bundleInRange = (column: string, range: BundleRange) =>
  `(${range.lo === null ? "?1 IS NULL" : `${column}>?1`}) AND (${range.hi === null ? "?2 IS NULL" : `${column}<=?2`})`;
/** What the refs table must hold for the receipts in `range`, from their JSON (bound: lo, hi). */
export const revocationRefsExpectedSql = (range: BundleRange) => disclosureRefs("d", `d.state!='revoked' AND ${bundleInRange("d.bundle_id", range)}`)
  .replace(/json_each\(d\.(record|source)_versions\) j/g, "memory_disclosures d, json_each(d.$1_versions) j");
/** True when the refs held for `range` differ, either way, from what those receipts' JSON names. */
export function revocationRefsDiffer(db: DatabaseSync, range: BundleRange): boolean {
  const expected = revocationRefsExpectedSql(range);
  const held = `SELECT bundle_id,kind,ref_id,ref_version FROM memory_disclosure_refs WHERE ${bundleInRange("bundle_id", range)}`;
  return Boolean(db.prepare(`SELECT 1 FROM (${expected} EXCEPT ${held}) UNION ALL SELECT 1 FROM (${held} EXCEPT SELECT * FROM (${expected})) LIMIT 1`).get(range.lo, range.hi));
}
/** The bundle id that ends a slice of `size` receipts after `lo`, or null when fewer remain. */
export function nextBundleBound(db: DatabaseSync, lo: string | null, size: number): string | null {
  const row = lo === null
    ? db.prepare("SELECT bundle_id FROM memory_disclosures ORDER BY bundle_id LIMIT 1 OFFSET ?").get(size - 1)
    : db.prepare("SELECT bundle_id FROM memory_disclosures WHERE bundle_id>? ORDER BY bundle_id LIMIT 1 OFFSET ?").get(lo, size - 1);
  return row ? row.bundle_id as string : null;
}
/** Receipts per slice when the full sweep proves a ready index: bounded temp space, not one sort of millions of rows. */
const VALIDATE_SLICE = 20_000;
const REVOCATION_INDEX_DROP = `DROP TRIGGER memory_disclosure_refs_insert; DROP TRIGGER memory_disclosure_refs_update; DROP TRIGGER memory_disclosure_refs_delete;
 DROP INDEX IF EXISTS memory_disclosures_state; DROP INDEX IF EXISTS memory_scopes_owner; DROP TABLE memory_disclosure_refs; DROP TABLE memory_revocation_index_build;`;
/** A root key: `thread\u0000message`. */
const ROOT_KEY_SEP = "\u0000";
/** The content address of a root set: the digest of its sorted, distinct members. */
export function rootSetId(keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].sort();
  return `rs1:${createHash("sha256").update(sorted.join("\n")).digest("hex")}`;
}
/** Stores a root set once (a set already held is reused) and returns its id.
 * `base` names a stored set the caller took whole into `keys` (the largest it
 * carried): when it is still held and a proper subset, the new set is written
 * as that parent plus the members it adds, so a thread's growing sets cost one
 * row per new root instead of a full copy each (v7). Members first, then the
 * set row, inside one savepoint: a set row is only ever there for a complete
 * set. */
export function storeRootSet(db: DatabaseSync, keys: Iterable<string>, base?: string, baseMembers?: ReadonlySet<string>): string {
  return storeSortedRootSet(db, [...new Set(keys)].sort(), base, baseMembers);
}
/** storeRootSet for a caller that already holds the members sorted and distinct (the lineage repair keeps one growing
 * sorted list and never re-sorts or copies it per set). `added`, when the caller knows it, is exactly the members of
 * `sorted` that `baseMembers` lacks, so the subset proof and the difference are not recomputed over the whole set. */
function storeSortedRootSet(db: DatabaseSync, sorted: readonly string[], base?: string, baseMembers?: ReadonlySet<string>, added?: readonly string[]): string {
  const id = `rs1:${createHash("sha256").update(sorted.join("\n")).digest("hex")}`;
  if (db.prepare("SELECT 1 FROM memory_root_sets WHERE set_id=?").get(id)) return id;
  let parent: string | undefined, delta: readonly string[] = sorted;
  if (base && base !== id) {
    // the caller may hand over the members it already holds (the upgrade backfill); otherwise they are read and proven
    const stored = baseMembers && Number(db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?").get(base)?.size ?? -1) === baseMembers.size;
    const held = stored ? baseMembers : rootSetMembers(db, base);
    if (held && held.size < sorted.length) {
      if (added && stored && held.size + added.length === sorted.length) { parent = base; delta = added; }
      else {
        const all = new Set(sorted);
        let subset = true;
        for (const key of held) if (!all.has(key)) { subset = false; break; }
        if (subset) { parent = base; delta = sorted.filter(key => !held.has(key)); }
      }
    }
  }
  db.exec("SAVEPOINT memory_root_set");
  try {
    // one statement for all members
    const pairs = delta.map(key => { const at = key.indexOf(ROOT_KEY_SEP); return [key.slice(0, at), key.slice(at + 1)]; });
    db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?,value->>0,value->>1 FROM json_each(?)").run(id, JSON.stringify(pairs));
    if (parent) db.prepare("INSERT OR REPLACE INTO memory_root_set_parents(set_id,parent_id) VALUES(?,?)").run(id, parent);
    db.prepare("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES(?,?)").run(id, sorted.length);
    db.exec("RELEASE memory_root_set");
  } catch (error) { db.exec("ROLLBACK TO memory_root_set; RELEASE memory_root_set"); throw error; }
  return id;
}
/** The stored sets `ids` and every set their chains rest on: each set's size,
 * parent, and own member rows. One recursive read: a chain only ever steps to
 * a strictly smaller set, so it ends. */
export interface RootSetForest { nodes: Map<string, { size: number; parent: string | null }>; own: Map<string, Array<[string, string]>>;
  /** Roots of a chain whose own rows were left in the file (larger than `lazyAbove`): the caller counts them and looks them up in place. */
  lazy?: Set<string> }
export function loadRootSetForest(db: DatabaseSync, ids: readonly string[], options: { lazyAbove?: number } = {}): RootSetForest {
  const nodes: RootSetForest["nodes"] = new Map(), own: RootSetForest["own"] = new Map();
  if (!ids.length) return { nodes, own };
  const chained = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='memory_root_set_parents'").get());
  const rows = chained ? db.prepare(`WITH RECURSIVE chain(id,size,parent) AS (
      SELECT r.set_id,r.size,p.parent_id FROM memory_root_sets r LEFT JOIN memory_root_set_parents p ON p.set_id=r.set_id WHERE r.set_id IN (SELECT value FROM json_each(?))
      UNION SELECT r.set_id,r.size,p.parent_id FROM chain c JOIN memory_root_sets r ON r.set_id=c.parent LEFT JOIN memory_root_set_parents p ON p.set_id=r.set_id WHERE r.size<c.size)
    SELECT id,size,parent FROM chain`).all(JSON.stringify([...new Set(ids)]))
    : db.prepare("SELECT set_id AS id,size,NULL AS parent FROM memory_root_sets WHERE set_id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...new Set(ids)]));
  for (const row of rows) nodes.set(String(row.id), { size: Number(row.size), parent: row.parent === null || row.parent === undefined ? null : String(row.parent) });
  const lazy = new Set<string>();
  if (options.lazyAbove !== undefined) for (const [id, node] of nodes) if (node.parent === null && node.size > options.lazyAbove) lazy.add(id);
  for (const row of db.prepare("SELECT set_id,root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id IN (SELECT value FROM json_each(?))").all(JSON.stringify([...nodes.keys()].filter(id => !lazy.has(id))))) {
    const id = String(row.set_id);
    let list = own.get(id);
    if (!list) own.set(id, list = []);
    list.push([String(row.root_thread_id), String(row.root_message_id)]);
  }
  return lazy.size ? { nodes, own, lazy } : { nodes, own };
}
/** Whether each of `ids` is a provable set in `forest`: present, its chain
 * ending at a set with no parent, every link strictly smaller, and every set's
 * own rows exactly its size minus its parent's. Iterative: a chain can be as
 * long as the set is large. */
export function provenRootSets(forest: RootSetForest, ids: Iterable<string>, memo = new Map<string, boolean>()): Map<string, boolean> {
  for (const start of ids) {
    const path: string[] = [], seen = new Set<string>();
    let at: string | null = start, below = true;
    while (at !== null) {
      const known = memo.get(at);
      if (known !== undefined) { below = known; break; }
      if (seen.has(at)) { below = false; break; }
      seen.add(at); path.push(at);
      const node = forest.nodes.get(at);
      if (!node) { below = false; break; }
      at = node.parent;
    }
    // from the bottom up: a set holds only when the set below it does
    for (let index = path.length - 1; index >= 0; index--) {
      below = below && ownRowsHold(forest, path[index]!);
      memo.set(path[index]!, below);
    }
  }
  return memo;
}
function ownRowsHold(forest: RootSetForest, id: string): boolean {
  const node = forest.nodes.get(id);
  if (!node) return false;
  if (forest.lazy?.has(id)) return true; // counted in place by the caller (root-set-handles.ts lazyBase)
  const count = forest.own.get(id)?.length ?? 0;
  if (node.parent === null) return count === node.size;
  const parent = forest.nodes.get(node.parent);
  return Boolean(parent) && parent!.size < node.size && count === node.size - parent!.size;
}
/** Every member of one stored set (`thread\u0000message` keys), or null when
 * it is not held or its chain cannot be proven (fail closed). */
export function rootSetMembers(db: DatabaseSync, setId: string): Set<string> | null {
  if (!setId) return null;
  const forest = loadRootSetForest(db, [setId]);
  if (!provenRootSets(forest, [setId]).get(setId)) return null;
  const out = new Set<string>();
  for (let at: string | null = setId; at !== null; at = forest.nodes.get(at)!.parent) {
    for (const [thread, message] of forest.own.get(at) ?? []) out.add(`${thread}${ROOT_KEY_SEP}${message}`);
  }
  return out.size === forest.nodes.get(setId)!.size ? out : null;
}
/** Pre-v6 replies: in each thread, a bot text reply rests on the receipt outputs that are its ANCESTORS, by the message's own parentId
 * chain, which a stored message keeps whatever happens to its row or its clock (a message stored again takes a new rowid, a clock can
 * go back, so neither position nor time proves anything). Additive and fail closed: it writes only the lineage tables (an OFF reply of
 * the old format carried no lineage, so whatever came before it may be what it repeats). No marker is written for valid memory: a set
 * is never truncated.
 *
 * A reply whose chain is not provable (it, or an ancestor, names no parent where one is due, names a message the thread does not hold,
 * or loops) rests on every receipt output of the thread but itself, and past LEGACY_OUTPUT_SETS_MAX outputs a reply that is itself an
 * output is unprovable (the empty set id), which withholds it. */
const LEGACY_OUTPUT_SETS_MAX = 64;
/** Per bot text reply of one thread that needs a lineage row, its set id ("" = withheld). */
export function legacyReplyRoots(db: DatabaseSync, thread: string, options: { tick?: () => void; checkpoint?: () => void; stats?: { peakRetained: number }; context?: LineageContext } = {}): Map<string, string> {
  const steps = legacyReplyRootsSteps(db, thread, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (step.value === "tick") options.tick?.(); else if (step.value === "checkpoint") options.checkpoint?.();
  }
}
/** What a long walk hands back to whoever drives it: a progress tick, a point where the work done so far may be committed, or a plain
 * point where it may be paused. The walk keeps its whole state between the points, so the driver may do anything in between. */
export type LineageYield = "tick" | "checkpoint" | "pulse";
export function* legacyReplyRootsSteps(db: DatabaseSync, thread: string, options: { stats?: { peakRetained: number }; context?: LineageContext } = {}): Generator<LineageYield, Map<string, string>> {
  const result = new Map<string, string>();
  const stats = options.stats;
  let built = 0;
  const outputList = [...new Set(db.prepare("SELECT DISTINCT message_id FROM memory_disclosure_outputs WHERE thread_id=?").all(thread).map(row => String(row.message_id)))].sort();
  if (!outputList.length) return result;
  const outputs = new Set(outputList);
  const rows: Array<Record<string, unknown>> = [];
  // read in a stretch that may be paused between rows: a thread of a million messages is not one blocking read
  for (const row of db.prepare("SELECT id,role,kind,json_type(json,'$.parentId') AS pt, json_extract(json,'$.parentId') AS parent FROM messages WHERE thread_id=? ORDER BY rowid").iterate(thread)) {
    rows.push(row);
    if (rows.length % LINEAGE_LOAD_ROWS === 0) yield "pulse";
  }
  const byId = new Map<string, { role: string; pt: string | null; parent: string | null }>();
  for (const row of rows) byId.set(String(row.id), { role: String(row.role), pt: row.pt === null || row.pt === undefined ? null : String(row.pt), parent: typeof row.parent === "string" ? row.parent : null });
  // up(id): is the chain from id to its root provable, and which receipt output is the nearest above it
  const up = new Map<string, { ok: boolean; nearest: string | null }>();
  const resolve = (start: string): { ok: boolean; nearest: string | null } => {
    const path: string[] = [], onPath = new Set<string>();
    let at: string | null = start, tail: { ok: boolean; nearest: string | null } | undefined;
    while (at !== null) {
      const known = up.get(at);
      if (known) { tail = known; break; }
      if (onPath.has(at)) { tail = { ok: false, nearest: null }; break; }
      const node = byId.get(at);
      if (!node) { tail = { ok: false, nearest: null }; break; }
      path.push(at); onPath.add(at);
      // Only an explicit null parent is a proven root. A row naming no parent at all (any role) is chained by the loader to whatever row
      // precedes it in stored order, which a replaced row or a clock can shuffle: its ancestry is not provable here (conservative fallback).
      if (node.pt === "null") { tail = { ok: true, nearest: null }; break; }
      if (node.pt !== "text" || node.parent === null) { tail = { ok: false, nearest: null }; break; }
      at = node.parent;
    }
    // walk back down the path: each node's nearest output above is its parent when that is an output, else the parent's nearest
    let below = tail ?? { ok: false, nearest: null };
    for (let n = path.length - 1; n >= 0; n--) {
      const id = path[n]!, node = byId.get(id)!;
      const isRoot = node.pt === "null";
      if (isRoot) { below = { ok: true, nearest: null }; up.set(id, below); continue; }
      const parent = node.parent!;
      below = !below.ok ? { ok: false, nearest: null } : { ok: true, nearest: outputs.has(parent) ? parent : below.nearest };
      up.set(id, below);
    }
    return up.get(start) ?? { ok: false, nearest: null };
  };
  const keyOf = (id: string) => `${thread}${ROOT_KEY_SEP}${id}`;
  // The set of an output is its parent set (the set of the nearest output above it) plus that one output: a stored chain whose
  // id is derived from (parent id, the added member). No set is ever copied, sorted or hashed whole, so building the sets of a
  // thread of N outputs costs N small steps however long the thread, and a restarted repair derives the same ids and finds the
  // sets already stored. An output is never a member of the set above it (a descendant is not its own ancestor), so no
  // membership test is needed to add it.
  const setIds = new Map<string, string>(), sizes = new Map<string, number>(), outputOfSet = new Map<string, string>();
  const store = chainStore(db);
  const setOf = function* (output: string): Generator<LineageYield, string> {
    const known = setIds.get(output);
    if (known !== undefined) return known;
    const chain: string[] = [output];
    let at = resolve(output).nearest;
    while (at !== null && !setIds.has(at)) { chain.push(at); at = resolve(at).nearest; }
    let baseId: string | null = at === null ? null : setIds.get(at)!;
    for (let n = chain.length - 1; n >= 0; n--) {
      const size = (baseId === null ? 0 : sizes.get(baseId)!) + 1;
      baseId = store(baseId, size - 1, [keyOf(chain[n]!)]);
      sizes.set(baseId, size); outputOfSet.set(baseId, chain[n]!); setIds.set(chain[n]!, baseId);
      if (stats) stats.peakRetained = Math.max(stats.peakRetained, setIds.size + sizes.size + byId.size);
      if (++built % 256 === 0) yield "tick";
      if (built % LINEAGE_BATCH === 0) yield "checkpoint";
    }
    return setIds.get(output)!;
  };
  // Membership of a key in a set this call named, without reading the set: for a chain set, "is that output the set's output or
  // above it" is a test on the thread's output tree (entry and exit numbers of one walk, taken on first use).
  let tin: Map<string, number> | undefined, tout: Map<string, number> | undefined;
  const numbering = () => {
    if (tin && tout) return { tin, tout };
    const entry = new Map<string, number>(), exit = new Map<string, number>();
    const children = new Map<string | null, string[]>();
    for (const output of outputList) {
      const above = resolve(output);
      if (!above.ok) continue;
      const list = children.get(above.nearest);
      if (list) list.push(output); else children.set(above.nearest, [output]);
    }
    let clock = 0;
    const walk: Array<[string, number]> = [];
    for (const top of children.get(null) ?? []) {
      walk.push([top, 0]);
      while (walk.length) {
        const frame = walk[walk.length - 1]!, [node, next] = frame;
        if (next === 0) entry.set(node, ++clock);
        const kids = children.get(node) ?? [];
        if (next < kids.length) { frame[1] = next + 1; walk.push([kids[next]!, 0]); } else { exit.set(node, ++clock); walk.pop(); }
      }
    }
    return { tin: tin = entry, tout: tout = exit };
  };
  const within = (output: string, ofOutput: string) => {
    const { tin: entry, tout: exit } = numbering();
    const a = entry.get(output), b = entry.get(ofOutput);
    return a !== undefined && b !== undefined && a <= b && exit.get(ofOutput)! <= exit.get(output)!;
  };
  const custom = new Map<string, (message: string) => boolean>();
  const context = options.context;
  if (context) {
    context.contains = (set, key) => {
      if (!key.startsWith(`${thread}${ROOT_KEY_SEP}`)) return outputOfSet.has(set) || custom.has(set) ? false : undefined;
      const message = key.slice(thread.length + 1), top = outputOfSet.get(set);
      if (top !== undefined) return within(message, top);
      return custom.get(set)?.(message);
    };
    context.nodeInside = (node, set) => {
      const top = outputOfSet.get(set), inner = outputOfSet.get(node);
      return top !== undefined && inner !== undefined && within(inner, top);
    };
    context.size = set => sizes.get(set);
    context.tree = {
      slot: key => {
        if (!key.startsWith(`${thread}${ROOT_KEY_SEP}`)) return undefined;
        const message = key.slice(thread.length + 1), { tin: entry, tout: exit } = numbering(), a = entry.get(message);
        return a === undefined ? undefined : { tin: a, tout: exit.get(message)! };
      },
      topSlot: set => {
        const top = outputOfSet.get(set);
        if (top === undefined) return undefined;
        const { tin: entry, tout: exit } = numbering(), a = entry.get(top);
        return a === undefined ? undefined : { tin: a, tout: exit.get(top)! };
      },
      isOutputKey: key => key.startsWith(`${thread}${ROOT_KEY_SEP}`) && outputs.has(key.slice(thread.length + 1)),
      isAll: set => all !== undefined && set === all,
    };
  }
  const keys = outputList.map(keyOf);
  let all: string | undefined;
  for (const row of rows) {
    if (row.role !== "bot" || row.kind !== "text") continue;
    const id = String(row.id), chain = resolve(id);
    if (chain.ok) { if (chain.nearest !== null) result.set(id, yield* setOf(chain.nearest)); continue; }
    if (!outputs.has(id)) {
      if (all === undefined) { all = storeRootSet(db, keys); sizes.set(all, outputList.length); custom.set(all, message => outputs.has(message)); }
      result.set(id, all); continue;
    }
    if (outputList.length === 1) continue;
    if (outputList.length > LEGACY_OUTPUT_SETS_MAX) { result.set(id, ""); continue; }
    const without = storeRootSet(db, keys.filter(key => key !== keyOf(id)));
    sizes.set(without, outputList.length - 1); custom.set(without, message => message !== id && outputs.has(message));
    result.set(id, without);
  }
  return result;
}
/** Outputs between two checkpoints of a long thread's repair. */
const LINEAGE_BATCH = 500;
/** Rows of a thread's messages read between two points where the repair may pause. */
const LINEAGE_LOAD_ROWS = 4096;
/** Links of an older set's ancestry between two progress notes (reading it into the cache, or walking it). */
const LINEAGE_PULSE = 256;
/** A key's place in the thread's output tree (entry and exit numbers of one walk). */
export interface TreeSlot { tin: number; tout: number }
/** What one set's own row, and the ancestry above it, say about the thread's output tree. Read once per thread, however many
 * replies' older sets chain through it. */
interface LineageNode {
  size: number; parent: string | null; own: string[];
  /** Whether the tree members of this set and everything below it lie on one root-to-leaf path, and the deepest of them. */
  chain: boolean; top: TreeSlot | undefined;
  /** Every member of the ancestry is an output of the thread (whatever its place in the tree). */
  onlyOutputs: boolean;
  /** This node, or the nearest node below it, that holds a member outside the tree (null: none). */
  nearestStray: string | null; strays: string[];
}
const isAbove = (a: TreeSlot, b: TreeSlot) => a.tin <= b.tin && b.tout <= a.tout;
/** What a repair may ask about the sets one legacyReplyRoots call named (filled by that call). */
export interface LineageContext {
  /** Whether `key` is a member of `set`: undefined when this call did not build the set. */
  contains?: (set: string, key: string) => boolean | undefined;
  /** Whether every member of `node` (a set this call built) is a member of `set`. */
  nodeInside?: (node: string, set: string) => boolean;
  /** The size of a set this call named. */
  size?: (set: string) => number | undefined;
  /** The thread's output tree: a key's place (undefined when it is not in the tree), a chain set's top output's place, and the
   * two shapes of custom set this call names. */
  tree?: {
    slot: (key: string) => TreeSlot | undefined;
    topSlot: (set: string) => TreeSlot | undefined;
    isOutputKey: (key: string) => boolean;
    isAll: (set: string) => boolean;
  };
  /** Older sets already read for this thread (filled by missingFrom); null: proven unreadable. */
  nodes?: Map<string, LineageNode | null>;
  /** Test hook: links of ancestry and members looked at by missingFrom. */
  stats?: { links: number; members: number };
}
/** The id of the set that is `parent` plus `added` (sorted, none already in it): derived from the two, so it is the same
 * wherever and whenever it is built. Sets stored before this scheme keep their ids; an id is an opaque key to every reader. */
export function chainedRootSetId(parent: string | null, added: readonly string[]): string {
  return `rs2:${createHash("sha256").update(`${parent ?? ""}\n`).update(added.join("\n")).digest("hex")}`;
}
/** A writer of chained sets: (parent id, parent size, added members) -> the stored set's id. A set already held is reused;
 * members, parent link and set row go in one savepoint, so a set row is only ever there for a complete set. */
export function chainStore(db: DatabaseSync): (parent: string | null, parentSize: number, added: readonly string[]) => string {
  const held = db.prepare("SELECT 1 FROM memory_root_sets WHERE set_id=?");
  const member = db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES(?,?,?)");
  const link = db.prepare("INSERT OR REPLACE INTO memory_root_set_parents(set_id,parent_id) VALUES(?,?)");
  const row = db.prepare("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES(?,?)");
  return (parent, parentSize, added) => {
    const id = chainedRootSetId(parent, added);
    if (held.get(id)) return id;
    db.exec("SAVEPOINT memory_root_chain");
    try {
      for (const key of added) { const at = key.indexOf(ROOT_KEY_SEP); member.run(id, key.slice(0, at), key.slice(at + 1)); }
      if (parent !== null) link.run(id, parent);
      row.run(id, parentSize + added.length);
      db.exec("RELEASE memory_root_chain");
    } catch (error) { db.exec("ROLLBACK TO memory_root_chain; RELEASE memory_root_chain"); throw error; }
    return id;
  };
}
/** The threads that hold receipt outputs, in order: one index probe per thread (a skip-scan of the output index), never a pass over the
 * table (SELECT DISTINCT read every pair: 17 s at start on the scale rig, where a thread lists 100,000 of them). */
function outputThreads(db: DatabaseSync): string[] {
  const next = db.prepare("SELECT thread_id FROM memory_disclosure_outputs WHERE thread_id>? ORDER BY thread_id LIMIT 1");
  const threads: string[] = [];
  for (let at = ""; ;) {
    const row = next.get(at);
    if (!row) return threads;
    at = String(row.thread_id);
    threads.push(at);
  }
}
export function backfillOutputRoots(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get()) return;
  const insert = db.prepare("INSERT OR IGNORE INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  const threads = outputThreads(db);
  for (const thread of threads) for (const [id, setId] of legacyReplyRoots(db, thread)) insert.run(thread, id, setId);
}
const LINEAGE_REPAIR_MARKER = "memory-lineage-backfill-v3";
/** Earlier builds of this branch backfilled legacy replies by the order of the thread's rows, which a replaced row or a clock can
 * shuffle (a reply could end up with no dependency on an output it rests on). Once per file, every legacy reply's set is made the union of
 * what it holds and what its parent chain proves (never smaller than before; a reply that cannot be proven becomes withheld). Resumable: the
 * marker is written last, and the union is idempotent. */
const repairedThreads = new WeakMap<object, Set<string>>();
/** One progress row per finished thread, in the messages.db table the transcript backfills keep their cursors in. A thread's row is
 * written in the same transaction as its repair, so an interrupted repair resumes after the last finished thread instead of from the
 * start, and a restarted server trusts the threads already repaired. Removed once the file's marker is written. */
const REPAIR_THREAD_PREFIX = "lineage_repair:";
function ensureRepairProgressTable(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID");
}
function threadRepairRecorded(db: DatabaseSync, thread: string): boolean {
  try { return Boolean(db.prepare("SELECT 1 FROM transcript_index_state WHERE name=? AND done=1").get(`${REPAIR_THREAD_PREFIX}${thread}`)); } catch { return false; }
}
/** The completion of a file with NO memory scope, kept beside the per-thread rows: nothing can hold the marker there (it rides on a
 * scope), so without this a later start would list the file's receipts again and announce repair work that is done. Once a scope exists the
 * marker is the record again, so this row is read only while there is none. */
const REPAIR_FILE_DONE = "lineage_repair_file";
function fileRepairRecorded(db: DatabaseSync): boolean {
  try {
    if (db.prepare("SELECT 1 FROM memory_scopes LIMIT 1").get()) return false;
    return Boolean(db.prepare("SELECT 1 FROM transcript_index_state WHERE name=? AND done=1").get(REPAIR_FILE_DONE));
  } catch { return false; }
}
/** Whether this connection's repair has finished `thread` (or the file's repair marker is present). Until it has, a thread with receipt
 * outputs is not trusted for replay (database.ts withholds it when the repair failed). */
export function ancestryThreadRepaired(db: DatabaseSync, thread: string): boolean {
  if (repairedThreads.get(db)?.has(thread)) return true;
  try { if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(LINEAGE_REPAIR_MARKER)) return true; } catch { return false; }
  return fileRepairRecorded(db) || threadRepairRecorded(db, thread);
}
/** True while this file still has threads to repair: a cheap check (a marker lookup and one index probe) so a start can say so before it begins. */
export function lineageRepairPending(db: DatabaseSync): boolean {
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get()) return false;
    if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(LINEAGE_REPAIR_MARKER)) return false;
    if (fileRepairRecorded(db)) return false;
    return Boolean(db.prepare("SELECT 1 FROM memory_disclosure_outputs LIMIT 1").get());
  } catch { return false; }
}
interface LineageReaders { sizeOf: StatementSync; parentOf: StatementSync; ownOf: StatementSync }
const lineageReaders = (db: DatabaseSync): LineageReaders => ({
  sizeOf: db.prepare("SELECT size FROM memory_root_sets WHERE set_id=?"), parentOf: db.prepare("SELECT parent_id FROM memory_root_set_parents WHERE set_id=?"),
  ownOf: db.prepare("SELECT root_thread_id,root_message_id FROM memory_root_set_members WHERE set_id=?"),
});
/** Reads one older set and the ancestry under it into `cache`, each set's row and own members at most once per thread (a
 * chain shared by many replies is expanded once). null: the set, or something under it, cannot be proven. Iterative. */
function* lineageNode(read: LineageReaders, start: string, context: LineageContext, cache: Map<string, LineageNode | null>): Generator<LineageYield, LineageNode | null> {
  const { sizeOf, parentOf, ownOf } = read;
  const path: Array<{ id: string; size: number; parent: string | null }> = [], onPath = new Set<string>();
  let at: string | null = start, base: LineageNode | null = null, bad = false;
  while (at !== null) {
    if (path.length % LINEAGE_PULSE === LINEAGE_PULSE - 1) yield "pulse";
    const known = cache.get(at);
    if (known !== undefined) { if (known === null) bad = true; else base = known; break; }
    if (onPath.has(at)) { bad = true; break; }
    const row = sizeOf.get(at);
    if (!row) { bad = true; break; }
    const link = parentOf.get(at) as { parent_id: unknown } | undefined;
    onPath.add(at);
    path.push({ id: at, size: Number(row.size), parent: link ? String(link.parent_id) : null });
    at = link ? String(link.parent_id) : null;
  }
  if (bad) { for (const step of path) cache.set(step.id, null); return null; }
  const tree = context.tree;
  let below: LineageNode | null = base;
  for (let n = path.length - 1; n >= 0; n--) {
    if ((path.length - n) % LINEAGE_PULSE === 0) yield "pulse";
    const step = path[n]!, parentSize = below ? below.size : 0;
    if (step.parent !== null && !below) { cache.set(step.id, null); for (let m = n - 1; m >= 0; m--) cache.set(path[m]!.id, null); return null; }
    const own = ownOf.all(step.id).map(member => `${String(member.root_thread_id)}${ROOT_KEY_SEP}${String(member.root_message_id)}`);
    if ((step.parent !== null && !(parentSize < step.size)) || own.length !== step.size - parentSize) {
      for (let m = n; m >= 0; m--) cache.set(path[m]!.id, null);
      return null;
    }
    const strays: string[] = [], inTree: TreeSlot[] = [];
    let onlyOutputs = below ? below.onlyOutputs : true;
    for (const key of own) {
      const slot = tree?.slot(key);
      if (slot) inTree.push(slot); else strays.push(key);
      if (!tree?.isOutputKey(key)) onlyOutputs = false;
    }
    inTree.sort((x, y) => x.tin - y.tin);
    let chain = below ? below.chain : true, top = below?.top;
    for (let i = 1; i < inTree.length && chain; i++) if (!isAbove(inTree[i - 1]!, inTree[i]!)) chain = false;
    if (chain && inTree.length) {
      const deep = inTree[inTree.length - 1]!;
      // every member below lies on the root path of `top`, so the union stays on one path exactly when the new deepest member is
      // above `top` (the set below is deeper: its top stays) or below it (the new deepest becomes the top); how the new members
      // interleave with the old ones does not matter
      if (!top) top = deep;
      else if (isAbove(deep, top)) { /* the set below is deeper: its top stays */ }
      else if (isAbove(top, deep)) top = deep;
      else chain = false;
    }
    const node: LineageNode = { size: step.size, parent: step.parent, own, chain, top, onlyOutputs, strays, nearestStray: strays.length ? step.id : below?.nearestStray ?? null };
    cache.set(step.id, node);
    below = node;
  }
  return cache.get(start) ?? null;
}
/** The union of the set `have` and the set `wanted`, as `wanted` plus what `have` holds that it lacks. `have`'s chain is read once
 * per thread (shared ancestry is never read or judged twice), and the walk ends at the first link whose whole ancestry is already
 * inside `wanted` (one comparison on the thread's output tree), so a thread of N replies costs O(N) reads however its older sets
 * are chained. It yields a pulse every few hundred links of a long walk. null: `have` cannot be proven. undefined: `wanted` is not
 * a set the call can answer for. */
function* missingFrom(read: LineageReaders, have: string, wanted: string, context: LineageContext): Generator<LineageYield, Set<string> | null | undefined> {
  const cache = context.nodes ??= new Map();
  const topSlot = context.tree?.topSlot(wanted), wantsAll = context.tree?.isAll(wanted) === true;
  const missing = new Set<string>();
  for (let node: string | null = have, steps = 0; node !== null;) {
    if (++steps % LINEAGE_PULSE === 0) yield "pulse";
    if (context.stats) context.stats.links++;
    if (context.nodeInside?.(node, wanted)) return missing;
    const info: LineageNode | null = yield* lineageNode(read, node, context, cache);
    if (!info) return null;
    if (wantsAll && info.onlyOutputs) return missing;
    if (topSlot && info.chain && (!info.top || isAbove(info.top, topSlot))) {
      // every tree member of what remains is inside `wanted`: only members outside the tree can be missing
      for (let stray: string | null = info.nearestStray, walked = 0; stray !== null;) {
        if (++walked % LINEAGE_PULSE === 0) yield "pulse";
        const held = cache.get(stray)!;
        if (context.stats) { context.stats.links++; context.stats.members += held.strays.length; }
        for (const key of held.strays) {
          const inside = context.contains?.(wanted, key);
          if (inside === undefined) return undefined;
          if (!inside) missing.add(key);
        }
        stray = held.parent === null ? null : cache.get(held.parent)?.nearestStray ?? null;
      }
      return missing;
    }
    if (context.stats) context.stats.members += info.own.length;
    for (const key of info.own) {
      const inside = context.contains?.(wanted, key);
      if (inside === undefined) return undefined;
      if (!inside) missing.add(key);
    }
    node = info.parent;
  }
  return missing;
}
/** The longest a long thread's repair works before committing what it has (checked at every batch of LINEAGE_BATCH items): a repair
 * that is killed loses at most this much work, and the commits stay a small share of the run however large the file grows. */
const LINEAGE_CHECKPOINT_MS = 2_000;
export function repairOutputRootBackfill(db: DatabaseSync, options: { onProgress?: (progress: { done: number; total: number }) => void; checkpointMs?: number; stats?: { links: number; members: number } } = {}): { threads: number; widened: number } {
  const steps = repairOutputRootBackfillSteps(db, { onProgress: options.onProgress, sliceMs: options.checkpointMs ?? LINEAGE_CHECKPOINT_MS, stats: options.stats, waitBusy: false });
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
const lockedForRepair = (error: unknown) => { const e = error as { errcode?: unknown; message?: unknown } | null; return typeof e?.errcode === "number" ? (e.errcode & 0xff) === 5 : /database is locked|SQLITE_BUSY/i.test(String(e?.message ?? "")); };
/** The repair as a walk that hands control back at every commit: `"commit"` means the work so far is committed and nothing is open, so the
 * caller may wait as long as it likes before calling next(); `"busy"` means the next transaction could not start because another connection
 * holds the lock (only with `waitBusy`), and the caller should wait and call next() to try again. `sliceMs` is how long it works between
 * commits (50 ms in the background, so the event loop and the writer lock are never held for long). Every commit leaves a state a killed
 * process resumes from. */
export function* repairOutputRootBackfillSteps(db: DatabaseSync, options: { onProgress?: (progress: { done: number; total: number }) => void; sliceMs?: number; stats?: { links: number; members: number }; waitBusy?: boolean } = {}): Generator<"commit" | "busy", { threads: number; widened: number }> {
  const done = { threads: 0, widened: 0 };
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='messages'").get()) return done;
  if (db.prepare("SELECT 1 FROM memory_scope_bindings WHERE id=?").get(LINEAGE_REPAIR_MARKER)) return done;
  ensureRepairProgressTable(db);
  // a finished file (recorded without a scope to hold the marker) is not enumerated again
  if (fileRepairRecorded(db)) return done;
  // one index seek per thread (a skip-scan): SELECT DISTINCT over every output of a heavy history took 85 s
  const threads: string[] = [];
  for (let after = ""; ;) {
    const next = db.prepare("SELECT thread_id FROM memory_disclosure_outputs WHERE thread_id>? ORDER BY thread_id LIMIT 1").get(after);
    if (!next) break;
    after = String(next.thread_id);
    threads.push(after);
    if (threads.length % 512 === 0 && options.waitBusy) yield "commit";
  }
  const merged = new Map<string, string>();
  const storeChain = chainStore(db);
  const held = db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id=? AND message_id=?");
  const addRoot = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  const setRoot = db.prepare("UPDATE memory_output_roots SET set_id=? WHERE thread_id=? AND message_id=?");
  let finished = repairedThreads.get(db);
  if (!finished) repairedThreads.set(db, finished = new Set());
  let handled = 0;
  // threads finished by an earlier, interrupted run count as done from the first report
  for (const thread of threads) if (threadRepairRecorded(db, thread)) { finished.add(thread); handled++; }
  // `fraction` (0..1) is how far into the current thread the work is: a thread that is one long conversation still moves the note
  const report = (fraction = 0) => { try { options.onProgress?.({ done: handled + Math.min(0.999, Math.max(0, fraction)), total: threads.length }); } catch { /* a status write never stops the repair */ } };
  if (threads.length) report();
  const sliceMs = options.sliceMs ?? LINEAGE_CHECKPOINT_MS;
  for (const thread of threads) {
    if (threadRepairRecorded(db, thread)) continue;
    // starting the transaction can meet another connection's lock; in the background that is waited out, not raised
    const begin = function* (): Generator<"commit" | "busy", void> {
      for (;;) {
        try { db.exec("BEGIN IMMEDIATE"); return; }
        catch (error) { if (!options.waitBusy || !lockedForRepair(error)) throw error; yield "busy"; }
      }
    };
    yield* begin();
    // Every bounded batch of a long thread (a batch of items, once enough time has passed) is committed: the sets and the replies' rows written so far are idempotent (a set's id is
    // derived from its parent and its member, a reply row only ever widens to the same target), so a repair killed mid-thread resumes
    // by finding them in place. The thread's own finished-row is written only with the last batch.
    let committedAt = Date.now();
    const cycle = function* (): Generator<"commit" | "busy", void> {
      if (Date.now() - committedAt < sliceMs) return;
      db.exec("COMMIT");
      yield "commit";
      yield* begin();
      committedAt = Date.now();
    };
    try {
      const context: LineageContext = options.stats ? { stats: options.stats } : {};
      const outputsInThread = Number(db.prepare("SELECT count(DISTINCT message_id) AS n FROM memory_disclosure_outputs WHERE thread_id=?").get(thread)?.n ?? 1) || 1;
      let built = 0, index = 0, wantedSize = 1, building = true;
      const roots = legacyReplyRootsSteps(db, thread, { context });
      let wanted: Map<string, string>;
      for (;;) {
        const step = roots.next();
        if (step.done) { wanted = step.value; break; }
        if (step.value === "tick") report(0.5 * Math.min(1, (built += 256) / outputsInThread));
        yield* cycle();
      }
      building = false; wantedSize = wanted.size;
      const readers = lineageReaders(db);
      for (const [id, target] of wanted) {
        const row = held.get(thread, id);
        if (!row) { addRoot.run(thread, id, target); done.widened++; }
        else {
          const have = String(row.set_id);
          if (have !== target && have !== "") {
            let next = target;
            if (target !== "") {
              const cached = merged.get(`${have}\u0000${target}`);
              if (cached !== undefined) next = cached;
              else {
                const size = context.size?.(target);
                let missing: Set<string> | null | undefined;
                if (size === undefined) missing = undefined;
                else {
                  const walk = missingFrom(readers, have, target, context);
                  for (;;) {
                    const step = walk.next();
                    if (step.done) { missing = step.value; break; }
                    report(0.5 + 0.5 * index / wantedSize);
                    yield* cycle();
                  }
                }
                if (missing === undefined) {
                  // not a set this call built: the two are read and joined (bounded by the legacy forms that reach here)
                  const a = rootSetMembers(db, have), b = rootSetMembers(db, target);
                  // a set that cannot be read is unprovable: the reply is withheld
                  next = a && b ? storeRootSet(db, new Set([...a, ...b])) : "";
                } else if (missing === null) next = "";
                else next = missing.size ? storeChain(target, size!, [...missing].sort()) : target;
                merged.set(`${have}\u0000${target}`, next);
              }
            }
            if (next !== have) { setRoot.run(next, thread, id); done.widened++; }
          }
        }
        if (++index % 256 === 0) report(0.5 + 0.5 * index / wantedSize);
        if (index % LINEAGE_BATCH === 0) yield* cycle();
      }
      void building;
      db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, 0, 0)").run(`${REPAIR_THREAD_PREFIX}${thread}`);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } } throw error; }
    done.threads++; handled++;
    finished.add(thread);
    report();
    // a thread is a natural place to hand the loop back
    if (options.waitBusy) yield "commit";
  }
  // Finished: the marker when a scope can hold it, else the file's own record (a scope-less file has nowhere to put the marker).
  const scope = db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()?.id;
  if (scope) db.prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES(?,?,'system','lineage-backfill',0,'granted',?)").run(LINEAGE_REPAIR_MARKER, scope, JSON.stringify({ done: true }));
  else db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, 0, 0)").run(REPAIR_FILE_DONE);
  db.prepare("DELETE FROM transcript_index_state WHERE name LIKE ?").run(`${REPAIR_THREAD_PREFIX}%`);
  return done;
}
export const MEMORY_SCHEMA_VERSION = 9;
const SHAPE_MARKER = "memory-shape-check";
/** The frozen v2 text (0.1.54 to 0.1.60), for validation and the v3 -> v2 inverse. */
export const MEMORY_SCHEMA_V2 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=2)") + LEARNING_SCHEMA;
export const MEMORY_SCHEMA_V3 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=3)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA;
/** The frozen v4 text (0.1.62 development), for validation and the v5 -> v4 inverse. */
export const MEMORY_SCHEMA_V4 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=4)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA_V4;
/** The frozen v5 text (0.1.62 to the 1.0 merge), for validation and the v6 -> v5 inverse. */
export const MEMORY_SCHEMA_V5 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=5)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA;
/** The frozen v6 text (1.0.0 and 1.0.1), for validation and the v7 -> v6 inverse. */
export const MEMORY_SCHEMA_V6 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=6)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA + LINEAGE_SCHEMA_V6;
/** The frozen v7 text (1.0.2 development before lane D), for validation and the v8 -> v7 inverse. */
export const MEMORY_SCHEMA_V7 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=7)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA + LINEAGE_SCHEMA;
/** The frozen v8 text (1.0.2 development before the cold-lineage indexes), for validation and the v9 -> v8 inverse. */
export const MEMORY_SCHEMA_V8 = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=8)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA + LINEAGE_SCHEMA + REVOCATION_INDEX_SCHEMA;
export const MEMORY_SCHEMA = MEMORY_SCHEMA_V1.replace("CHECK(schema_version=1)", "CHECK(schema_version=9)") + LEARNING_SCHEMA + OUTPUT_INDEX_SCHEMA + LEDGER_SCHEMA + BOT_LEARNING_SCHEMA + LINEAGE_SCHEMA + REVOCATION_INDEX_SCHEMA + COLD_LINEAGE_INDEXES;
/** The v9 text for a file that already holds rows: without the cold-lineage indexes, which are built in the background after start instead of
 * under the upgrade (each reads a whole table: tens of seconds on a large history). */
export const MEMORY_SCHEMA_WITHOUT_COLD_INDEXES = MEMORY_SCHEMA.replace(COLD_LINEAGE_INDEXES, "\n");
const SCHEMA_TEXT: Record<number, string> = { 1: MEMORY_SCHEMA_V1, 2: MEMORY_SCHEMA_V2, 3: MEMORY_SCHEMA_V3, 4: MEMORY_SCHEMA_V4, 5: MEMORY_SCHEMA_V5, 6: MEMORY_SCHEMA_V6, 7: MEMORY_SCHEMA_V7, 8: MEMORY_SCHEMA_V8, 9: MEMORY_SCHEMA };

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
/** A shapes check that has to read at least this many rows of one table is worth a start-up note; a smaller one is over in milliseconds. */
const FULL_READ_NOTE_ROWS = 5_000;
/** Rowids per slice of a validation read between two progress notes. */
const VALIDATE_ROWS = 50_000;
/** Rowids per slice of one table's reference check. */
export const REFERENCE_SLICE = 20_000;
const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Whether any row of `table` names a parent row that is not there, checked in slices of REFERENCE_SLICE rows with `between`
 * called after each, so the start-up note keeps moving through a table of any size (PRAGMA foreign_key_check is one statement per
 * table and cannot report). SQLite's own rule: a key with a NULL column is not checked; the parent key is the named columns, or
 * the parent's primary key; the child's value is compared as the parent column's affinity would store it (and nothing else's).
 * Slices are cut by key, not by number: the table's rows are walked in rowid order (or primary key order for a WITHOUT ROWID table)
 * and each slice ends at the key REFERENCE_SLICE rows on, found by a seek, so sparse keys cost nothing and no statement reads the
 * whole table to find its ends. A table that cannot be sliced (every name for the rowid is a column, or a parent the query cannot
 * name) falls back to the whole-table pragma, which gives the same answer in one step; `hold` wraps that one indivisible statement
 * (the caller keeps the start-up note moving while it runs). */
export function referencesBroken(db: DatabaseSync, table: string, between: () => void, hold: <T>(run: () => T) => T = run => run()): boolean {
  return referencesBrokenFrom(db, table, null, { between, hold }).broken;
}
/** The same check as a walk that can stop after any slice and carry on later: `cursor` is the key the next slice starts at (null: the
 * start of the table), and the result's `next` is the key to resume from (`finished` when the table is done). `stop` is asked after
 * each slice; `slice` sets the rows per slice (REFERENCE_SLICE by default). A table that cannot be sliced is checked whole in one step. */
export function referencesBrokenFrom(db: DatabaseSync, table: string, cursor: unknown[] | null, options: { between?: () => void; hold?: <T>(run: () => T) => T; stop?: () => boolean; slice?: number } = {}): { broken: boolean; finished: boolean; next: unknown[] | null } {
  const between = options.between ?? (() => {}), hold = options.hold ?? (<T>(run: () => T) => run()), sliceRows = Math.max(1, Math.trunc(options.slice ?? REFERENCE_SLICE));
  const whole = (): { broken: boolean; finished: boolean; next: null } => ({ broken: hold(() => db.prepare(`PRAGMA foreign_key_check(${JSON.stringify(table)})`).all().length > 0), finished: true, next: null });
  let checks: Array<(lo: unknown[], hi: unknown[] | null) => boolean>, order: string[], first: StatementSync, next: StatementSync, rowKey: (row: Record<string, unknown>) => unknown[];
  try {
    const keys = new Map<number, { parent: string; from: string[]; to: Array<string | null> }>();
    for (const row of db.prepare('SELECT id,seq,"table" AS parent,"from" AS child,"to" AS key FROM pragma_foreign_key_list(?) ORDER BY id,seq').all(table)) {
      const id = Number(row.id), key = keys.get(id) ?? { parent: String(row.parent), from: [], to: [] };
      key.from.push(String(row.child)); key.to.push(row.key === null ? null : String(row.key));
      keys.set(id, key);
    }
    if (!keys.size) return whole();
    const columns = db.prepare("SELECT name,pk FROM pragma_table_xinfo(?)").all(table) as Array<{ name: string; pk: number }>;
    const without = /WITHOUT\s+ROWID/i.test(String(db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql ?? ""));
    if (without) order = columns.filter(column => Number(column.pk) > 0).sort((x, y) => Number(x.pk) - Number(y.pk)).map(column => quoteName(column.name));
    else {
      // a column may be named rowid: take the first of the three names that is not one of the table's columns
      const taken = new Set(columns.map(column => column.name.toLowerCase()));
      const alias = ["rowid", "_rowid_", "oid"].find(name => !taken.has(name));
      order = alias ? [alias] : [];
    }
    if (!order.length) return whole();
    const list = order.map(column => `c.${column}`).join(","), tuple = (n: number) => `(${Array.from({ length: n }, () => "?").join(",")})`, width = order.length;
    const sorted = `ORDER BY ${list}`;
    const named = order.map((column, at) => `c.${column} AS k${at}`).join(",");
    first = db.prepare(`SELECT ${named} FROM ${quoteName(table)} c ${sorted} LIMIT 1`);
    next = db.prepare(`SELECT ${named} FROM ${quoteName(table)} c WHERE (${list})>=${tuple(width)} ${sorted} LIMIT 1 OFFSET ${sliceRows}`);
    first.setReadBigInts(true); next.setReadBigInts(true);
    rowKey = row => order.map((_, at) => row[`k${at}`]);
    checks = [...keys.values()].map(key => {
      const parentKey = key.to.every(column => column !== null) ? key.to as string[]
        : db.prepare("SELECT name FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk").all(key.parent).map(row => String(row.name));
      if (parentKey.length !== key.from.length) throw new Error("unsliceable");
      // `+c.x` carries no affinity, so the parent column's affinity alone is applied to the child's value (the pragma's rule)
      const missing = `${key.from.map(column => `c.${quoteName(column)} IS NOT NULL`).join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM ${quoteName(key.parent)} p WHERE ${parentKey.map((column, at) => `p.${quoteName(column)}=+c.${quoteName(key.from[at]!)}`).join(" AND ")}) LIMIT 1`;
      const open = db.prepare(`SELECT 1 FROM ${quoteName(table)} c WHERE (${list})>=${tuple(width)} AND ${missing}`);
      const closed = db.prepare(`SELECT 1 FROM ${quoteName(table)} c WHERE (${list})>=${tuple(width)} AND (${list})<${tuple(width)} AND ${missing}`);
      return (lo: unknown[], hi: unknown[] | null) => Boolean(hi ? closed.get(...[...lo, ...hi] as never[]) : open.get(...lo as never[]));
    });
  } catch { return whole(); }
  const start = cursor ?? (() => { const row = first.get(); return row ? rowKey(row) : null; })();
  if (!start) return { broken: false, finished: true, next: null };
  for (let lo: unknown[] = start, hi: unknown[] | null; ; lo = hi) {
    const stop = next.get(...lo as never[]);
    hi = stop ? rowKey(stop) : null;
    for (const check of checks) if (check(lo, hi)) return { broken: true, finished: false, next: lo };
    between();
    if (!hi) return { broken: false, finished: true, next: null };
    if (options.stop?.()) return { broken: false, finished: false, next: hi };
  }
}
// The second direction of the output-index proof, as two linear counts. The first check proves every
// JSON entry has its row (thread included); the index's key is (bundle_id, message_id), so equal counts
// of rows and distinct JSON entries leave no room for a row the JSON does not name. Checking each row
// against its receipt's JSON instead walks the whole output list once per row, which is quadratic in a
// long list (a heavy 1.0.1 history held lists thousands long and took over ten minutes per slice).
/** True when the output index differs, either way, from the receipts' JSON for the receipts in `slice` (the first query: a JSON entry with no
 * row, thread included; the counts: no row the JSON does not name). */
export function outputIndexDiffers(db: DatabaseSync, slice: BundleRange): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_disclosures d, json_each(d.output_message_ids) j WHERE j.type='text'
        AND NOT EXISTS (SELECT 1 FROM memory_disclosure_outputs o WHERE o.bundle_id=d.bundle_id AND o.thread_id=d.thread_id AND o.message_id=j.value) AND ${bundleInRange("d.bundle_id", slice)} LIMIT 1`).get(slice.lo, slice.hi))
    || outputRowsInSlice(db, slice) !== outputEntriesInSlice(db, slice);
}
/** Writes the output index of the receipts in `slice` again from their JSON (the index is derived: the JSON is the authority). The caller owns the transaction. */
export function rebuildOutputIndexSlice(db: DatabaseSync, slice: BundleRange): number {
  db.prepare(`DELETE FROM memory_disclosure_outputs WHERE ${bundleInRange("bundle_id", slice)}`).run(slice.lo, slice.hi);
  return Number(db.prepare(`INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id)
    SELECT d.bundle_id,d.thread_id,j.value FROM memory_disclosures d, json_each(d.output_message_ids) j WHERE j.type='text' AND ${bundleInRange("d.bundle_id", slice)}`).run(slice.lo, slice.hi).changes);
}
function outputRowsInSlice(db: DatabaseSync, slice: BundleRange): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM memory_disclosure_outputs o WHERE ${bundleInRange("o.bundle_id", slice)}`).get(slice.lo, slice.hi)?.n ?? 0);
}
function outputEntriesInSlice(db: DatabaseSync, slice: BundleRange): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM (SELECT DISTINCT d.bundle_id, j.value FROM memory_disclosures d, json_each(d.output_message_ids) j
    WHERE j.type='text' AND ${bundleInRange("d.bundle_id", slice)})`).get(slice.lo, slice.hi)?.n ?? 0);
}
/** The JSON columns whose shape is proven, and the revision of that list (a marker taken against another revision is not trusted). */
const SHAPES: Array<[string,string,string]> = [
  ["memory_scopes","audience","array"], ["memory_scope_bindings","intent","object"],
  ["memory_source_versions","payload","object"], ["memory_disclosures","record_versions","array"],
  ["memory_disclosures","source_versions","array"], ["memory_disclosures","output_message_ids","array"],
];
/** The row-reading checks the structure check leaves to the background pass, in the order the pass runs them: the shape of each JSON column,
 * the assertion column, and every record's details row. Each is a test over a range of rowids, so a check of any table is read in slices. */
export interface RowCheck { table: string; code: string; label: string; bad(db: DatabaseSync, lo: number, hi: number): boolean }
export function rowChecks(version: number): RowCheck[] {
  const checks: RowCheck[] = SHAPES.map(([table, column, kind]) => ({ table, code: "INVALID_MEMORY_JSON_SHAPE", label: `${table}.${column}`,
    bad: (db, lo, hi) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND rowid<=? AND json_type(${column})!=? LIMIT 1`).get(lo, hi, kind)) }));
  checks.push({ table: "memory_records", code: "INVALID_MEMORY_ASSERTION", label: "memory_records.assertion",
    bad: (db, lo, hi) => Boolean(db.prepare("SELECT 1 FROM memory_records WHERE rowid>? AND rowid<=? AND assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import') LIMIT 1").get(lo, hi)) });
  if (version >= 2) checks.push({ table: "memory_records", code: "INVALID_MEMORY_RECORD_DETAILS", label: "memory_records.details",
    bad: (db, lo, hi) => Boolean(db.prepare("SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON r.id=d.record_id AND r.version=d.record_version WHERE d.record_id IS NULL AND r.rowid>? AND r.rowid<=? LIMIT 1").get(lo, hi)) });
  return checks;
}
const SHAPES_REVISION = createHash("sha256").update(JSON.stringify(SHAPES)).digest("hex").slice(0, 12);
/** The shape marker, taken at the schema version `from`, rewritten at the current version. The upgrade steps from v6 on change no row
 * of any shaped column or checked table (they add tables and indexes, one metadata row, and drop one index), so a proof taken against
 * the rows before the step holds after it, and the next open reads only the rows added since. A marker that is absent, of another
 * schema version or of another shapes revision is left alone: the next open reads in full once, as before. */
export function carryShapeMarkerForward(db: DatabaseSync, from: number): boolean {
  try {
    const saved = JSON.parse(String(db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(SHAPE_MARKER)?.intent ?? "null"));
    if (!saved || saved.schema !== from || saved.shapes !== SHAPES_REVISION || !saved.marks || typeof saved.marks !== "object") return false;
    db.prepare("UPDATE memory_scope_bindings SET intent=? WHERE id=?").run(JSON.stringify({ schema: MEMORY_SCHEMA_VERSION, shapes: SHAPES_REVISION, marks: saved.marks }), SHAPE_MARKER);
    return true;
  } catch { return false; }
}
/** The v6 index over the members of root sets by (thread, message): v7 does not create it and the owner's space hand-back drops it. */
export const LEGACY_MEMBER_INDEX = "memory_root_set_members_root";
/** Indexes a v8 file may lack (see validateMemorySchema). */
export const OPTIONAL_V8_INDEXES = ["memory_disclosures_state", SCOPE_OWNER_INDEX] as const;
const DISCLOSURE_STATE_INDEX = "CREATE INDEX IF NOT EXISTS memory_disclosures_state ON memory_disclosures(state);\n";
export function validateMemorySchema(db: DatabaseSync, options: { references?: boolean | (() => boolean); structuralOnly?: boolean; incrementalShapes?: boolean; tailRows?: number; onFullRead?: () => void; onProgress?: () => void; hold?: <T>(run: () => T) => T } = {}): Set<string> {
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const memoryRows = rows.filter(row => row.name.startsWith("memory_") || row.tbl_name.startsWith("memory_"));
  if (!memoryRows.length) return new Set(); // private.7 legacy archive
  // Recognize only an exact known meta table before reading its version field.
  const metaSchema = memoryRows.find(row => row.name === "memory_meta");
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(value => metaSchema?.sql === expectedSchema(value).get("memory_meta")?.sql);
  if (!version) {
    // A newer Murage wrote this file: say so, and name the way out, instead of
    // the bare unsupported-schema code an older build prints.
    const newer = /^CREATE TABLE memory_meta\b[^;]*CHECK\(schema_version=(\d+)\)/.exec(metaSchema?.sql ?? "");
    if (newer && Number(newer[1]) > MEMORY_SCHEMA_VERSION) throw memorySchemaNewerError(Number(newer[1]));
    throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const schema = expectedSchema(version);
  // A file an earlier build of this lane left mid-backfill has no lookup index yet (it was created with the
  // last slice); the backfill makes it. A ready index must have it.
  const building = version >= 8 && !memoryRows.some(row => row.name === REVOCATION_REF_INDEX) && !revocationIndexReady(db);
  // From v7 on a file taken over from v6 may still carry the v6 member index, exactly as v6 defined it: it is dropped by the owner's space hand-back.
  const legacy = version >= 7 ? expectedSchema(6).get(LEGACY_MEMBER_INDEX) : undefined;
  const hasLegacy = Boolean(legacy) && memoryRows.some(row => row.name === LEGACY_MEMBER_INDEX);
  // The index on the receipts' state is optional from v8: building it reads every receipt row through its overflow pages (the JSON columns come first),
  // which measured tens of seconds on a real history, so an upgrade does not build it. Nothing depends on it (it can only make a sweep of all
  // receipts faster). A file that has it must have it exactly as defined.
  const absentOptional = version >= 8 ? OPTIONAL_V8_INDEXES.filter(name => !memoryRows.some(row => row.name === name)).length : 0;
  // a v9 file whose cold-lineage indexes are still being built in the background has not got them yet: either may be missing
  const coldBuilding = version >= 9 ? COLD_LINEAGE_INDEX_STATEMENTS.filter(statement => !memoryRows.some(row => row.name === statement.name)).length : 0;
  if (memoryRows.length !== schema.size - (building ? 1 : 0) + (hasLegacy ? 1 : 0) - absentOptional - coldBuilding) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  for (const row of memoryRows) {
    const wanted = schema.get(row.name) ?? (hasLegacy && row.name === LEGACY_MEMBER_INDEX ? legacy : undefined);
    if (!wanted || row.type !== wanted.type || row.tbl_name !== wanted.tbl_name || row.sql !== wanted.sql) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  }
  const meta = db.prepare("SELECT * FROM memory_meta").all();
  if (meta.length !== 1 || meta[0].schema_version !== version || !/^[a-f0-9-]{36}$/.test(String(meta[0].installation_id))) throw new Error("INVALID_MEMORY_META");
  // structuralOnly: the schema text, the meta row and the learning settings are the whole check. Every proof that reads rows (the
  // reference sweep, both index proofs, the JSON shapes, the assertion and details checks, the ledger and lesson checks) is left to the
  // background integrity pass (integrity-pass.ts), which holds the features that depend on a proof until that proof has passed.
  const structural = options.structuralOnly === true;
  const sweep = options.references ?? true;
  const full = !structural && (typeof sweep === "function" ? sweep() : sweep);
  // Said once, before the first read that covers a whole table (the reference sweep, or a shapes check with no usable mark), so the
  // start-up note is up before the long part, not after it.
  let announced = false;
  const fullRead = () => { if (announced) return; announced = true; try { options.onFullRead?.(); } catch { /* a status write never stops validation */ } };
  // Said again between the steps of every long read, so the note keeps moving for as long as the work does (the shell treats a note
  // that stops changing as a stalled start). Each step below is a bounded slice of a table, or one table; a single table is the smallest
  // unit SQLite's reference check offers.
  const touch = () => { try { options.onProgress?.(); } catch { /* a status write never stops validation */ } };
  if (full) fullRead();
  if (full) {
    for (const table of db.prepare("SELECT m.name AS name FROM sqlite_schema m WHERE m.type='table' AND m.name NOT LIKE 'sqlite_%' AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name)) ORDER BY m.name").all()) {
      if (referencesBroken(db, String(table.name), touch, options.hold)) throw new Error("INVALID_MEMORY_REFERENCE");
      touch();
    }
  }
  // The output index is derived: a file from outside this installation (an
  // archive, a merge) whose index lost a row would hide a receipt from the
  // per-message replay check, so the full sweep proves it matches the JSON.
  if (full && version >= 3) {
    // one slice of receipts (by bundle id) at a time
    for (let lo: string | null = null; ;) {
      const hi: string | null = nextBundleBound(db, lo, VALIDATE_SLICE), slice: BundleRange = { lo, hi };
      if (outputIndexDiffers(db, slice)) throw new Error("INVALID_MEMORY_OUTPUT_INDEX");
      touch();
      if (hi === null) break;
      lo = hi;
    }
  }
  // The revocation index is derived the same way: a file whose index lost a row would let a
  // revocation miss a receipt that cites what was forgotten, so the full sweep proves it equal,
  // one slice of receipts at a time. An index still being built is not read by anything
  // (revocationIndexReady), so only a ready one is held to the JSON.
  if (full && version >= 8 && revocationIndexReady(db)) {
    for (let lo: string | null = null; ;) {
      const hi = nextBundleBound(db, lo, VALIDATE_SLICE);
      if (revocationRefsDiffer(db, { lo, hi })) throw new Error("INVALID_MEMORY_REVOCATION_INDEX");
      touch();
      if (hi === null) break;
      lo = hi;
    }
  }
  if (structural) {
    if (version >= 2) {
      const settings = db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get();
      if (!settings || !(version>=4?memoryLearningSchema:memoryLearningV1Schema).safeParse(JSON.parse(String(settings.settings))).success) throw new Error("INVALID_MEMORY_LEARNING_CONFIG");
    }
    return new Set(memoryRows.map(row => row.name));
  }
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
  // A read of rows past `from` (every row when null) up to `newest`, in slices of VALIDATE_ROWS rowids with a progress note between them.
  // It is announced when the range is substantial: a file with no usable mark, or one whose tail since the last launch is large
  // (a heavy user's file can add that much between two launches), would otherwise read for a long time with no note up.
  const announceIfLarge = (from: number | null, newest: number) => { if (newest - (from ?? 0) > FULL_READ_NOTE_ROWS) fullRead(); };
  // Every read is bounded on both sides: rowids in (lo, hi], in slices of VALIDATE_ROWS (a range that fits one slice is one slice). Nothing reads past `newest`,
  // so a row written after the range was fixed (or past a capped tail) is never read, and never fails a slice it is not in.
  const anyInChunks = (table: string, from: number | null, newest: number, bad: (lowExclusive: number, highInclusive: number, fromStart: boolean) => boolean): boolean => {
    // fromStart: the slice begins at the table's first row (a read with no usable mark): it is bounded above only, the lower bound would be the table's start
    let lo = from ?? Number(db.prepare(`SELECT min(rowid) AS n FROM ${table}`).get()?.n ?? 1) - 1;
    const startedAt = lo, fresh = from === null;
    // at least one bounded read, even for an empty range (one seek that finds nothing: the check always looked)
    do {
      const hi = Math.max(lo, Math.min(newest, lo + VALIDATE_ROWS));
      if (bad(lo, hi, fresh && lo === startedAt)) return true;
      lo = hi;
      if (lo < newest) touch();
    } while (lo < newest);
    return false;
  };
  const shapes = SHAPES, shapesRevision = SHAPES_REVISION;
  const track = Boolean(options.incrementalShapes);
  // The idle sweep reads at most `tailRows` rowids past each mark per call (the marks are its cursor) and never reads a table with no usable mark: a start does that.
  const tailEnd = (table: string, from: number | null): number => {
    const newest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0);
    if (options.tailRows === undefined) return newest;
    if (from === null) throw new Error("MEMORY_SHAPE_MARK_MISSING");
    return Math.min(newest, from + options.tailRows);
  };
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
    const key = `${table}.${column}`, mark = marks?.[key];
    const from = typeof mark === "number" && Number.isSafeInteger(mark) && Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0) >= mark ? mark : null;
    const newest = tailEnd(table, from);
    announceIfLarge(from, newest);
    if (anyInChunks(table, from, newest,
      (lo, hi, start) => Boolean(start ? db.prepare(`SELECT 1 FROM ${table} WHERE rowid<=? AND json_type(${column})!=? LIMIT 1`).get(hi, kind) : db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND rowid<=? AND json_type(${column})!=? LIMIT 1`).get(lo, hi, kind)))) throw new Error("INVALID_MEMORY_JSON_SHAPE");
    next[key] = newest;
  }
  // Column value checks keep their marks in the same marker but are NOT part of the shapes list above: the
  // shapes revision is unchanged, so markers written before this check stay valid for the JSON shapes. A marker
  // without an entry for a check reads that column in full once and records it.
  const key = "memory_records.assertion", table = "memory_records";
  const mark = marks?.[key], rawNewest = Number(db.prepare(`SELECT max(rowid) AS n FROM ${table}`).get()?.n ?? 0);
  const from = typeof mark === "number" && Number.isSafeInteger(mark) && rawNewest >= mark ? mark : null;
  const newest = tailEnd(table, from);
  announceIfLarge(from, newest);
  const BAD_ASSERTION = "assertion NOT IN ('owner-statement','tool-observation','assistant-inference','unverified-import')";
  if (anyInChunks(table, from, newest,
    (lo, hi, start) => Boolean(start ? db.prepare(`SELECT 1 FROM ${table} WHERE rowid<=? AND ${BAD_ASSERTION} LIMIT 1`).get(hi) : db.prepare(`SELECT 1 FROM ${table} WHERE rowid>? AND rowid<=? AND ${BAD_ASSERTION} LIMIT 1`).get(lo, hi)))) throw new Error("INVALID_MEMORY_ASSERTION");
  next[key] = newest;
  if (version >= 2) {
    const settings = db.prepare("SELECT settings FROM memory_learning_config WHERE id=1").get();
    if (!settings || !(version>=4?memoryLearningSchema:memoryLearningV1Schema).safeParse(JSON.parse(String(settings.settings))).success) throw new Error("INVALID_MEMORY_LEARNING_CONFIG");
    // The record-details anti-join keeps its newest-rowid mark in the same marker, like the assertion check
    // above: a marker without the key, or a table whose newest rowid fell below the mark, reads in full once.
    const detailsKey = "memory_records.details", detailsMark = marks?.[detailsKey];
    const detailsFrom = typeof detailsMark === "number" && Number.isSafeInteger(detailsMark) && rawNewest >= detailsMark ? detailsMark : null;
    const detailsNewest = tailEnd(table, detailsFrom);
    announceIfLarge(detailsFrom, detailsNewest);
    const noDetails = "SELECT 1 FROM memory_records r LEFT JOIN memory_record_details d ON r.id=d.record_id AND r.version=d.record_version WHERE d.record_id IS NULL";
    if (anyInChunks("memory_records", detailsFrom, detailsNewest,
      (lo, hi, start) => Boolean(start ? db.prepare(`${noDetails} AND r.rowid<=? LIMIT 1`).get(hi) : db.prepare(`${noDetails} AND r.rowid>? AND r.rowid<=? LIMIT 1`).get(lo, hi)))) throw new Error("INVALID_MEMORY_RECORD_DETAILS");
    next[detailsKey] = detailsNewest;
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
  /** Called when the upgrade enters its blocking stretch (one transaction whose statements, such as a DROP INDEX over a multi-GB
   * table or the commit, cannot be cut into slices): returns a heartbeat that keeps the start-up note moving while the server thread
   * is blocked. `end()` is always called. Never throws into the upgrade. */
  onBlocking?: (first: BlockingStep, from?: number) => BlockingHeartbeat;
  /** Called as each step starts, for the start-up screen. Never throws into the upgrade. */
  onPhase?: (event: MemoryMigrationPhase) => void;
  /** Called before validation reads a substantial range (a changed schema or shape list, the upgrade's reference sweep, or a large
   * tail of rows added since the last launch), and again between the slices of that read, so the start-up note is up before the long
   * part and keeps moving through it. Never throws into the upgrade. */
  onValidating?: () => void;
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

/** The first memory schema version whose upgrade steps leave every row a proof reads as it was. */
export const DEFERRED_PROOFS_FROM = 6;
export function migrateMemorySchema(db: DatabaseSync, initialMode: "off" | "active" = "off", options: MigrateMemoryOptions = {}) {
  upgradeDevelopmentV5(db);
  // Validation is cut into slices that report; the one statement it cannot cut (a table's whole-table reference check) runs under a
  // heartbeat of its own, started just before it and ended just after, so the note keeps moving while the server thread is blocked.
  const heldByHeartbeat = <T>(run: () => T): T => {
    let beat: BlockingHeartbeat | undefined;
    try { beat = options.onBlocking?.("validating"); } catch { /* a status write never stops validation */ }
    try { return run(); } finally { try { beat?.end(); } catch { /* as above */ } }
  };
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get();
  // Structure, meta and row shapes on every open; the whole-file reference sweep only when this open is actually going to rewrite the
  // schema AND the step changes rows: from memory v6 on no step changes a row that a proof reads, so the sweep and the index proofs are
  // done by the background integrity pass (integrity-pass.ts) after the server listens, and the file is not read in full here.
  if (exists) validateMemorySchema(db, { incrementalShapes: true, onFullRead: options.onValidating, onProgress: options.onValidating, hold: heldByHeartbeat, references: () => { const version = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version); return version !== MEMORY_SCHEMA_VERSION && version < DEFERRED_PROOFS_FROM; } });
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
  if (exists) startupMark("migrate.begin");
  let blocking: BlockingHeartbeat | undefined;
  try { if (exists) blocking = options.onBlocking?.("tables", from); } catch { /* a status write never stops an upgrade */ }
  const stepTo = (step: BlockingStep) => { try { blocking?.step(step); } catch { /* as above */ } };
  try {
    if (exists) {
      // v4 -> v5 widens the ledger's kind CHECK, which SQLite only allows by rebuilding the table.
      if (from === 4) db.exec(`${LEDGER_INDEXES.map(name => `DROP INDEX ${name};`).join("")} ALTER TABLE memory_learning_events RENAME TO memory_learning_events_v4;`);
      db.exec("ALTER TABLE memory_meta RENAME TO memory_meta_previous;");
      startupMark("migrate.rename");
      // v9: the cold-lineage indexes and the two optional indexes (receipts state, scope owner) each read a whole table, so an upgrade does not build them: the
      // server builds them in the background after it is listening, and the queries that use them fall back until they are there. A new file takes them all.
      db.exec(MEMORY_SCHEMA_WITHOUT_COLD_INDEXES.replace(DISCLOSURE_STATE_INDEX, "").replace(`${SCOPE_OWNER_INDEX_SQL};\n`, ""));
      startupMark("migrate.schema");
      if (from === 4) db.exec("INSERT INTO memory_learning_events SELECT * FROM memory_learning_events_v4; DROP TABLE memory_learning_events_v4;");
      db.exec(`INSERT INTO memory_meta SELECT id,${MEMORY_SCHEMA_VERSION},installation_id,policy_revision,deletion_epoch,data_revision,mode FROM memory_meta_previous;
        DROP TABLE memory_meta_previous;`);
      if (from === 1) db.exec(`INSERT INTO memory_record_details(record_id,record_version,partition,attention,claim_status,observed_at)
        SELECT id,version,CASE kind WHEN 'source' THEN 'episodic' WHEN 'checkpoint' THEN 'working' WHEN 'procedure' THEN 'procedural' WHEN 'identity' THEN 'identity' ELSE 'semantic' END,
          CASE WHEN state IN ('archived','superseded','deleted') THEN 'historical' ELSE 'useful' END,
          CASE WHEN state='candidate' THEN 'provisional' ELSE 'current' END,NULL FROM memory_records;`);
      // A v6 file keeps its output index and lineage: v7 adds two empty
      // tables, and its full root sets are converted right after this
      // transaction, before the server takes traffic, one small transaction
      // per set (root-set-compaction.ts finishLineageStorageAtStartup).
      // v8: the revocation index starts empty and not ready; the triggers keep every receipt
      // written from here on, and the start-up backfill (revocation-index.ts) fills the rest in
      // resumable slices before the flag is set. Until then revocation reads the JSON.
      if (from < 8) {
        stepTo("indexes");
        db.prepare("INSERT INTO memory_revocation_index_build(id,ready,cursor,done,total,started_at) VALUES(1,0,NULL,0,(SELECT count(*) FROM memory_disclosures),?)").run(Date.now());
        startupMark("migrate.revocationRow");
      }
      if (from < 6) {
        stepTo("backfill");
        db.exec(OUTPUT_INDEX_BACKFILL);
        backfillOutputRoots(db);
      }
      if (from === 6) {
        stepTo("indexes");
        // The v6 member index (memory_root_set_members_root) is NOT dropped here. Freeing it is one statement over a multi-gigabyte index that
        // measured 153 s on a real 48 GB history, and it blocked the server. A v7/v8 file may carry it (validateMemorySchema accepts exactly that
        // definition); nothing reads it, and the owner's space hand-back (reclaimLineageSpace) drops it just before the VACUUM that returns its pages.
      }
      if (from === 6 && db.prepare("SELECT 1 FROM memory_root_sets LIMIT 1").get()) {
        // The total is counted as the conversion fills its worklist (root-set-compaction.ts), never by a count over the sets.
        db.prepare("INSERT OR IGNORE INTO memory_root_set_compaction(id,total,done,cursor,started_at) VALUES(1,0,0,'',?)").run(Date.now());
      }
    } else {
      db.exec(MEMORY_SCHEMA);
      db.prepare("INSERT INTO memory_meta(id,schema_version,installation_id,mode) VALUES(1,?,?,?)").run(MEMORY_SCHEMA_VERSION,randomUUID(),initialMode);
      // No receipts yet: the triggers keep the index complete from the first one.
      db.prepare("INSERT INTO memory_revocation_index_build(id,ready,cursor,done,total,started_at,finished_at) VALUES(1,1,NULL,0,0,?1,?1)").run(Date.now());
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
    stepTo("validating");
    // From v6 on the step wrote no row a proof reads: the structure of the result is checked here, the marks of the shape proof are
    // carried to the new version (the next open reads only rows added since), and the row proofs move to the background pass, which is
    // recorded as unfinished in the same transaction. Older files (and every restore, merge and downgrade, which call
    // validateMemorySchema themselves) still prove everything before the commit.
    if (exists && from >= DEFERRED_PROOFS_FROM) {
      carryShapeMarkerForward(db, from);
      beginIntegrityPass(db);
      startupMark("migrate.passRecorded");
      validateMemorySchema(db, { structuralOnly: true });
      startupMark("migrate.structural");
    } else validateMemorySchema(db);
    stepTo("committing");
    startupMark("migrate.commit.begin");
    db.exec("COMMIT");
    if (exists) startupMark("migrate.commit.end");
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
  } finally {
    // no beat lands after this: the next note (the repair's, or the removal when the upgrade is done) is never overwritten
    try { blocking?.end(); } catch { /* as above */ }
  }
}

/** Exact inverse of the migrations above, one version at a time, for
 * reinstalling an older build: to 2 (0.1.54 to 0.1.60) drops the derived
 * output index and its triggers; to 1 (0.1.53 and older) also drops the two
 * learning tables and their triggers. Each step restores the frozen
 * memory_meta text of its version. Chats and memory rows written after the
 * upgrade survive; what is dropped is derived or learning-only, and the next
 * newer start re-runs the same migration. Caller owns no transaction. */
/** The tables of messages.db that only 1.0.2 writes, all derived from other rows or holding the place of derived work (so a downgrade loses nothing). */
export const UPGRADE_DERIVED_TABLES = ["upgrade_integrity_pass", "browser_check_pending", "open_card", "turn_first", "card_branch", "branch_walk", "transcript_index_state", ...UPGRADE_APP_TABLES] as const;
export function downgradeMemorySchema(db: DatabaseSync, to: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 1): { status: "downgraded" | "already-v1" | "already-v2" | "already-v3" | "already-v4" | "already-v5" | "already-v6" | "already-v7" | "already-v8"; from: number; to: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 } {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_meta'").get()) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  validateMemorySchema(db);
  const from = Number(db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version);
  if (from <= to) return { status: `already-v${to}` as "already-v1", from, to };
  if (from > MEMORY_SCHEMA_VERSION) throw new Error("MEMORY_SCHEMA_UNSUPPORTED");
  db.exec("BEGIN IMMEDIATE");
  try {
    // The derived tables and the markers of unfinished or finished background work (the integrity pass, the open-card index, the first rows of turns, the
    // branch walks, the pending browser checks and the places of the fills) exist only from 1.0.2 on. An older build's archive inspector accepts no object it
    // does not write itself, and an older writer would not keep them: they go, with their completion state, and the next newer start builds them again.
    dropWriteRevisionTriggers(db); // this connection's counter triggers write to a table that is about to go
    for (const table of UPGRADE_DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table};`);
    for (let version = from; version > to; version--) {
      // The revocation index is derived from the receipts' JSON; the next newer start backfills it again.
      if (version === 9) db.exec(`DROP INDEX IF EXISTS ${OUTPUT_COVER_INDEX}; DROP INDEX IF EXISTS ${SOURCE_KIND_INDEX};`);
      if (version === 8) db.exec(REVOCATION_INDEX_DROP);
      // v6 reads every set in full: each chained set gets the members it
      // inherits written out again (the v6 size), then the v7 tables go.
      if (version === 7) {
        // Bounded memory: one set is expanded, written and dropped at a time. Writing a set's
        // inherited members gives it full own rows, which a chain proof reads as unprovable
        // (own rows must equal size minus parent's), so a set must be processed BEFORE every set
        // it is the parent of is left unprocessed: deepest first. Writing a set never changes
        // what an ancestor proves (an ancestor's chain and own rows are untouched), and a
        // descendant is already finished by then, so each set sees exactly the state the
        // all-at-once code saw.
        const parentOf = new Map<string, string>();
        for (const row of db.prepare("SELECT set_id,parent_id FROM memory_root_set_parents").all()) parentOf.set(String(row.set_id), String(row.parent_id));
        const depthOf = new Map<string, number>();
        const depth = (start: string): number => {
          const path: string[] = [], seen = new Set<string>();
          let at: string | undefined = start, base = 0;
          while (at !== undefined) {
            const known = depthOf.get(at);
            if (known !== undefined) { base = known; break; }
            if (seen.has(at)) break; // a cycle is unprovable whatever its order
            seen.add(at); path.push(at);
            at = parentOf.get(at);
          }
          for (let index = path.length - 1; index >= 0; index--) depthOf.set(path[index]!, ++base);
          return depthOf.get(start)!;
        };
        const chained = [...parentOf.keys()].map(id => ({ id, depth: depth(id) })).sort((x, y) => y.depth - x.depth || (x.id < y.id ? -1 : 1));
        const write = db.prepare("INSERT OR IGNORE INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT ?,value->>0,value->>1 FROM json_each(?)");
        for (const { id } of chained) {
          const members = rootSetMembers(db, id);
          if (members) {
            let chunk: string[][] = [];
            for (const key of members) {
              const at = key.indexOf(ROOT_KEY_SEP);
              chunk.push([key.slice(0, at), key.slice(at + 1)]);
              if (chunk.length >= 2000) { write.run(id, JSON.stringify(chunk)); chunk = []; }
            }
            if (chunk.length) write.run(id, JSON.stringify(chunk));
          } else {
            // an unprovable set becomes the unprovable marker: v6 withholds what rests on it
            db.prepare("UPDATE memory_output_roots SET set_id='' WHERE set_id=?").run(id);
            db.prepare("UPDATE memory_session_roots SET set_id='' WHERE set_id=?").run(id);
          }
        }
        db.exec(`DROP INDEX memory_session_roots_set; ${LINEAGE_TABLES_V7.map(table => `DROP TABLE ${table};`).join(" ")}`);
      }
      // Output lineage is derived from replies already kept; the next newer start backfills it again.
      if (version === 6) for (const table of LINEAGE_TABLES_V6) db.exec(`DROP TABLE ${table};`);
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

/** Moves the row-shape marks forward over the rows written since the last open (the idle sweep calls it), so the tail the next start has to read stays
 * short whatever one session wrote. Exactly the incremental check a start runs, minus the structure it already proved; a row it refuses is left for
 * the start and the background pass to report. True when the marks are current. */
export function advanceMemoryShapeMarks(db: DatabaseSync, tailRows: number = IDLE_SHAPE_TAIL_ROWS): boolean {
  // references off and a capped tail: only rows written since the marks are read, never the whole-table reference and index proofs
  try { validateMemorySchema(db, { incrementalShapes: true, references: false, tailRows }); return true; } catch { return false; }
}
/** Rowids past each mark the idle sweep validates per call. */
export const IDLE_SHAPE_TAIL_ROWS = 4_000;
