import { initializeOwnWriteHolds, sanitizeOwnWriteHoldsForRestore } from "./own-write-holds.ts";
import { assertLedgerStoreReadable } from "./channels/delivery-ledger-store.ts";
import * as messageTableDefinitions from "./message-tables.ts";
import { SCHEMA_1_0_1 } from "./schema-1.0.1.ts";
import { cancelOpenRecords, assertBackupEmailActions, refreshBackupEmailPresentations } from './decision/records.ts';
import { initializeChatsPreviewStorage } from "./thread-summary.ts";
import { ensureForgetTable } from "./harness/event-log.ts";
import { ensureScrubPassTable } from "./memory/scrub-state.ts";
import { initializeFluxSpaces } from "./flux-memory-spaces.ts";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { initializeHighLevelThreadMarks } from "./highlevel/thread-marks.ts";
import { createHash } from "node:crypto";
import { writeSync } from "./counted-fs.ts";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "./sqlite-open.ts";
import { publishNoReplace } from "./publish-file.ts";
import { claimCopyScratch, settleFtsCopy, sweepStaleCopyScratch, RETIRED_SEARCH_TABLES } from "./settle-copy.ts";
import { noteWrittenBytes, noteWrittenFile } from "./io-written.ts";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { INDEX_OVERRUN_LEGACY_SCHEMA, ensureIndexOverrun, isDiskFullError, validateMemorySchema, ensureGH18Operations } from "./memory/schema.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { discardInboxProjection, initializeInbox, isInboxProjectionObject } from "./inbox.ts";
import { LEGACY_OWED_TABLE_DDL, LEGACY_SHARED_OWED_INDEX, LEGACY_SHARED_OWED_INDEX_DDL } from "./room-request-owed.ts";
import { ensureBrowserCheckIndex, initializeMessageTables, TURN_INDEX, TURN_INDEX_DDL, TURN_INDEX_PREVIOUS_DDLS } from "./message-tables.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeDelegationPacks } from "./delegation-pack/schema.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { initializeOwnerSends } from "./send-store.ts";
import { initializeSendAttempts } from "./send-attempt-state.ts";
import { initializeBotCalls } from "./bot-calls-schema.ts";
import { initializeAppTriggers } from "./app-trigger-store.ts";
import { initializeTurnSourceHolds } from "./turn-source-holds.ts";
import { initializeEmailTables } from "./email/email-store.ts";
import { initializeMailboxCustody } from "./mailbox/custody.ts";
import { RESTORE_JOB_MARKS_DDL, RESTORE_BOOT_WAIT_DDL } from "./email/restore-job-marks-ddl.ts";
import { initializeFolderTrustActivity } from "./folder-trust-activity.ts";
import { initializeVenuePosts } from "./venue-post-held.ts";
import { initializeRoomShares } from "./room-shares-schema.ts";
import { initializeReplySchema } from "./tts/reply-schema.ts";

import { ensureIntegrityPassTable } from "./memory/integrity-state.ts";
import { LEGACY_UPGRADE_TABLES, ensureUpgradeAppTables } from "./memory/upgrade-app-tables.ts";
import { InstallationSnapshotError } from "./installation-snapshot-error.ts";
import { isNoSpaceError } from "./disk-space.ts";
import { safeBackupProgress, type BackupProgressReport } from "../shared/backup-progress.mjs";
import { flushCoalesced } from "./atomic.ts";
import { initializeAskRevocations } from "./phones/ask-revocations.ts";
import { initializePhoneReceipts } from "./phones/receipts.ts";
import { initializePhones } from "./phones/registry.ts";
import { ADDED_TABLE_LIFECYCLE } from "./added-table-lifecycle.ts";
import { APP_SCHEMA_102_ADDITIONS, PENDING_DELEGATIONS_PRE_PACK_DDL, downgradeOwnerSendAskProof, downgradePhoneObjectsTo108 } from "./installation-app-schema-downgrade.ts";
import { rowToMessage } from "./transcript-seq.ts";
import { ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL } from "./routine-message-links.ts";
export { InstallationSnapshotError } from "./installation-snapshot-error.ts";

function regularFile(path: string, missing = false) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new InstallationSnapshotError("UNSAFE_DATABASE_FILE");
    return stat;
  } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError("DATABASE_UNREADABLE");
  }
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get() as { count: number };
  if (!Number.isSafeInteger(row.count) || row.count < 0) throw new InstallationSnapshotError("UNSUPPORTED_DATABASE_SIZE");
  return row.count;
}

/** Every non-memory table the harness creates in messages.db. server/database.ts
 * owns messages/thread_state (server/message-tables.ts), server/inbox.ts the
 * inbox state, server/artifacts.ts the saved-file tables (0.1.52 K0 froze that
 * schema), and image-operations-schema.ts the startup recovery receipts.
 * `optional` names the nullable columns a later in-place migration
 * appends, in order: an older archive may lack a suffix of them.
 * A Map, not a plain object: archive names such as "constructor" or
 * "__proto__" must never match a property every object inherits. */
const APP_TABLES = new Map<string, { required: boolean; optional: string[] }>(Object.entries({
  own_write_holds: { required: false, optional: [] },
  // seq: the per-thread sequence (transcript-seq.ts), new in 1.0.3; an archive from before it lacks the column and its index
  gh18_operations: { required: false, optional: [] },
  // the bot create commit marker (bot-create-rollback.ts), new in 1.0.19: made at the first bot create and kept, empty, after it
  bot_create_commits: { required: false, optional: [] },
  messages: { required: true, optional: ["seq", "turn_id"] },
  mailbox_sealed_threads: { required: false, optional: [] },
  mailbox_sealed_rows: { required: false, optional: [] },
  // L8/I0: optional for pre-1.0.19 archives; definitions come from the serving initializers.
  send_attempts: { required: false, optional: [] },
  send_attempt_bindings: { required: false, optional: [] },
  send_actions: { required: false, optional: [] },
  send_replay_exclusions: { required: false, optional: [] },
  send_replay_epochs: { required: false, optional: [] },
  send_replay_session_nodes: { required: false, optional: [] },
  send_replay_sessions: { required: false, optional: [] },
  turn_cleanup_owed: { required: false, optional: [] },
  send_retirement_keys: { required: false, optional: [] },
  retired_send_ids: { required: false, optional: [] },
  turn_index_dirty: { required: false, optional: [] },
  turn_index_state: { required: false, optional: [] },

  thread_state: { required: true, optional: [] },
  open_card: { required: false, optional: [] },
  turn_first: { required: false, optional: [] },
  transcript_index_state: { required: false, optional: [] },
  // SQLite creates this exact bookkeeping table for search_intents AUTOINCREMENT.
  sqlite_sequence: { required: false, optional: [] },
  // pending "Checking the browser" notes, kept by the message writers and filled in the background (message-tables.ts), new in 1.0.2
  browser_check_pending: { required: false, optional: [] },
  // the Flux Memory number hold of a thread (server/flux-capture-hold.ts, message-tables.ts), new in 1.0.4
  flux_capture_hold: { required: false, optional: [] },
  // the memory index's durable stop and its reset (memory/schema.ts ensureIndexOverrun), new in 1.0.18: an archive from before it lacks it
  index_overrun: { required: false, optional: [] },
  // where the background integrity pass has got to (memory/integrity-state.ts), new in 1.0.2; outside the memory schema
  upgrade_integrity_pass: { required: false, optional: ["lessons_floor", "feedback_floor", "events_floor"] },
  // where the 1.0.4 number scrub of earlier memory has got to (memory/scrub-state.ts), new in 1.0.4; outside the memory schema
  upgrade_scrub_pass: { required: false, optional: [] },
  // the conversion's worklist, the counter the upgrade screen's figures are keyed to, and the direct turns in flight (memory/upgrade-app-tables.ts), new in 1.0.2
  upgrade_root_set_worklist: { required: false, optional: [] },
  app_write_revision: { required: false, optional: [] },
  direct_turn_inflight: { required: false, optional: [] },
  // tables an earlier 1.0.2 preview wrote (the kept proofs of large root sets): known, never read, dropped when the restored file is opened
  ...Object.fromEntries([...LEGACY_UPGRADE_TABLES].map(([table, { optional }]) => [table, { required: false, optional }])),
  // the rows of a thread that name an image, by path (message-db.ts), new in 1.0.2
  message_image: { required: false, optional: [] },
  attachment_name: { required: false, optional: [] },
  // cards without a request id, by (family, key) (message-db.ts), and the rows whose parent is not the row before them (transcript-backfill.ts)
  keyed_card: { required: false, optional: [] },
  // the branch index and the line index (branch-index.ts): small integer-keyed tables the writers keep and a thread's fill builds
  thread_key: { required: false, optional: [] },
  seg: { required: false, optional: [] },
  msg_branch: { required: false, optional: [] },
  fill_pending: { required: false, optional: [] },
  line: { required: false, optional: [] },
  // a branch move whose memory sources are still being flipped, in slices (memory/branch-change.ts)
  branch_change: { required: false, optional: [] },
  // The substring-search index (message-search-index.ts): a contentless FTS5
  // virtual table plus the four shadow tables SQLite keeps for it. Not
  // required: an archive from before the index lacks them and the app builds
  // the index on first open. Each is accepted only with exactly the definition
  // the harness writes, like every other object here.
  messages_fts: { required: false, optional: [] },
  messages_fts_data: { required: false, optional: [] },
  messages_fts_idx: { required: false, optional: [] },
  messages_fts_docsize: { required: false, optional: [] },
  messages_fts_config: { required: false, optional: [] },
  inbox_item_state: { required: false, optional: ["cleared_at"] },
  // the Inbox projection (server/inbox.ts), derived from messages by triggers;
  // an archive's copy is discarded at restore and rebuilt from its messages
  inbox_raw: { required: false, optional: [] },
  inbox_keys: { required: false, optional: [] },
  inbox_items: { required: false, optional: [] },
  inbox_counts: { required: false, optional: [] },
  inbox_projection_state: { required: false, optional: [] },
  setup_marks: { required: false, optional: [] },
  inbox_fill_deferred: { required: false, optional: [] },
  artifacts: { required: false, optional: ["producer", "publication_id"] },
  // turn_id (the producing provider turn, server/artifacts.ts) is appended by ALTER in 1.0.3: a 1.0.2 archive holds the table without it
  output_publications: { required: false, optional: ["turn_id"] },
  image_operations: { required: false, optional: [] },
  // saved prompt blocks, reference packs, render prompts and model checks
  // (image-operations-schema.ts initializeImageLibrary), new in 0.1.61
  image_prompt_blocks: { required: false, optional: [] },
  image_render_prompts: { required: false, optional: [] },
  image_reference_packs: { required: false, optional: [] },
  image_model_probes: { required: false, optional: [] },
  // conversation snooze (server/thread-snooze.ts), new in 0.1.60;
  // until_activity ("until new activity") added in 0.1.61
  thread_snooze: { required: false, optional: ["until_activity"] },
  // the projects overhaul (server/project-tables.ts), new in 0.1.61; all
  // required: false so an archive from before the release still restores
  team_identities: { required: false, optional: [] },
  project_settings: { required: false, optional: [] },
  project_routine_authority: { required: false, optional: [] },
  room_requests: { required: false, optional: ["handoff", "shared_work", "parked_refusal"] },
  // every owner send, committed before it is acknowledged (server/send-store.ts), new in 1.0.2;
  // notice and turn_id were appended during 1.0.2; the phone columns in 1.0.9; via_proof (ask admission evidence) in 1.0.19.
  owner_sends: { required: false, optional: ["notice", "restore_held", "restore_gen", "stopped", "stop_gen", "action_id", "turn_id", "via", "queue_only", "via_device", "attachments", "via_proof", "isolated", "late_refused"] },
  // the owner's deletion record and the restore generation (server/owner-deletions.ts, server/send-store.ts), new in 1.0.2
  owner_deleted_threads: { required: false, optional: [] },
  send_restore_generation: { required: false, optional: [] },
  // the restore fence's holds on unfinished work (server/restore-fence.ts), new in 1.0.2
  restore_holds: { required: false, optional: [] },
  project_work_items: { required: false, optional: [] },
  project_board_columns: { required: false, optional: [] },
  project_briefs: { required: false, optional: [] },
  project_goals: { required: false, optional: [] },
  project_budgets: { required: false, optional: [] },
  usage_ledger: { required: false, optional: [] },
  project_summaries: { required: false, optional: [] },
  project_activity: { required: false, optional: [] },
  project_member_state: { required: false, optional: [] },
  // phone push state (server/mobile-push-store.ts, Plan 3a H2): bindings,
  // outbox rows, risk ratings, first decisions, and the relay removals still
  // owed (H8). An archive from before these landed simply lacks the tables;
  // nothing here is required.
  // Appended by ALTER: key_secret (M2), then per-phone preview consent.
  push_bindings: { required: false, optional: ["key_secret", "preview_content", "token_expires_at", "rings_for_calls"] },
  push_events: { required: false, optional: ["phone_used"] },
  // revision appended by ALTER in H9 fix round 1
  push_risk: { required: false, optional: ["revision"] },
  push_decisions: { required: false, optional: ["outcome"] },
  push_relay_removals: { required: false, optional: [] },
  // routine provenance of shared requests (shared-provenance-schema.ts); an older archive lacks it
  shared_request_provenance: { required: false, optional: [] },
  // 1.0.19 appends the authenticated owner proof; earlier queues have no proof.
  pending_delegations: { required: false, optional: ["owner_rooted"] },
  // Tables added in 1.0.2 (shared_request_events, project_card_delivery_owed, ...) are not listed here: they are registered from
  // APP_SCHEMA_102_ADDITIONS.tables, the list the downgrade drops, by referenceSchema() below (owner_sends carries a column appended
  // later, so it is named above too).
  // forgotten messages whose lines are still to leave the event log (harness/event-log.ts), new in 1.0.2
  event_log_forgets: { required: false, optional: [] },
  // bot calls (server/bot-calls-schema.ts), new in 1.0.9; an older archive lacks them. The owed trigger on messages is created with them.
  bot_call_rules: { required: false, optional: [] },
  bot_calls: { required: false, optional: [] },
  // principal appended by ALTER (the authenticated device a call channel ticket is bound to)
  bot_call_sessions: { required: false, optional: ["principal"] },
  bot_call_owed: { required: false, optional: [] },
  bot_call_watch_threads: { required: false, optional: [] },
  bot_call_settings: { required: false, optional: [] },
  // connected-app triggers (server/app-trigger-store.ts), new in 1.0.11; an older archive lacks them.
  app_trigger_bindings: { required: false, optional: [] },
  app_trigger_policies: { required: false, optional: [] },
  app_event_inbox: { required: false, optional: [] },
  app_event_tombstones: { required: false, optional: [] },
  app_event_batches: { required: false, optional: [] },
  app_event_run_events: { required: false, optional: [] },
  app_event_runs: { required: false, optional: [] },
  // the restore job's marks (email/restore-job-effects.ts, Cloud 1.0.19 J2): created lazily by the first owner restore, so no initializer makes it.
  // Accepted with its exact definition (created below from RESTORE_JOB_MARKS_DDL) so a home that finished a restore still backs up; the staged
  // copy drops it (sanitizeStagedRestoreMarks), because a marker of THIS installation's restore means nothing in another installation.
  restore_job_marks: { required: false, optional: [] },
  restore_boot_wait: { required: false, optional: [] },
  // Fuigo folder-trust activity (folder-trust-activity.ts, 1.0.21): the latest observation per thread, with its engine identity and
  // destination, and the once-only notice claim. Accepted on the live source so a booted profile still backs up; the staged copy drops
  // it (sanitizeStagedFolderTrustActivity) and restore preparation drops it again: folder execution authority needs fresh trust and is
  // never restored (data-dir-inventory.ts TRUST). The identity columns were appended by ALTER.
  thread_folder_trust_activity: { required: false, optional: ["instance_id", "generation", "destination"] },
  // Flux Memory spaces (server/flux-memory-spaces.ts), new in 1.0.6: the space salt, the keys Flux Memory is off for, the bot
  // space and thread tag each capture went to, the capture receipts, the forgets owed for deleted conversations and bots, the
  // tombstones of what is never captured again, the bot spaces at Flux's limit, and where a capture was accepted
  flux_space_meta: { required: false, optional: [] },
  flux_key_off: { required: false, optional: [] },
  flux_mem_used: { required: false, optional: [] },
  flux_mem_receipt: { required: false, optional: [] },
  flux_mem_owed: { required: false, optional: [] },
  flux_mem_tombstone: { required: false, optional: [] },
  flux_mem_limit: { required: false, optional: [] },
  flux_mem_proven: { required: false, optional: [] },
}));

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };
interface ReferenceObject { type: string; table: string; sql: Set<string | null>; columns: string[][] }

/** SQLite keeps each CREATE statement's own text. Releases wrote the same
 * definitions with different spacing (server/store.ts before 0.1.47, the
 * memory restore target), so spacing is not part of a definition; every token,
 * its case and its order are. */
function normalizedSql(sql: unknown): string | null {
  return sql === null || sql === undefined ? null : String(sql).replace(/\s+/g, " ").replace(/ ?([(),]) ?/g, "$1").trim();
}

const RESTORE_PENDING_SQL = normalizedSql("CREATE TABLE restore_pending (reset_id TEXT PRIMARY KEY, operation TEXT NOT NULL, at INTEGER NOT NULL)");

function columnShape(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_xinfo("${table}")`).all()
    .map(column => `${column.name}:${String(column.type).toUpperCase()}:${column.notnull}:${column.dflt_value}:${column.pk}:${column.hidden}`);
}

let reference: Map<string, ReferenceObject> | undefined;
/** APP_TABLES plus every table of APP_SCHEMA_102_ADDITIONS the initializers create: one list for what the downgrade drops and what a snapshot accepts. */
let registeredTables: Map<string, { required: boolean; optional: string[] }> = APP_TABLES;
/** The exact table bot-create-rollback.ts makes; a snapshot of a data dir where a bot was created holds it (red-audit B2). */
const BOT_CREATE_COMMITS_DDL = "CREATE TABLE IF NOT EXISTS bot_create_commits(id TEXT PRIMARY KEY NOT NULL)";
function appTables() { referenceSchema(); return registeredTables; }
/** The definitions the harness's own initializers create, read back from a
 * fresh in-memory database rather than copied by hand, so an index or table
 * the app changes is compared against what the app now writes. */
function referenceSchema(): Map<string, ReferenceObject> {
  if (reference) return reference;
  const db = new DatabaseSync(":memory:");
  try {
    initializeChatsPreviewStorage(db);
    initializeHighLevelThreadMarks(db);
    initializeMessageTables(db); db.exec(TURN_INDEX_DDL); initializeTurnSourceHolds(db); ensureBrowserCheckIndex(db); ensureIntegrityPassTable(db); ensureScrubPassTable(db); ensureUpgradeAppTables(db); initializeInbox(db); initializeArtifacts(db);
    for (const { schema } of LEGACY_UPGRADE_TABLES.values()) db.exec(schema);
    // The serving initializer no longer owns legacy FTS. Keep archive references independently
    // of it, including the quoted spelling SQLite produces on ALTER TABLE RENAME.
    const legacySearchDdl = "MESSAGE_SEARCH_DDL" in messageTableDefinitions
      ? String(messageTableDefinitions.MESSAGE_SEARCH_DDL)
      : SCHEMA_1_0_1.find(object => object.name === "messages_fts")!.ddl!;
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get()) db.exec(legacySearchDdl);
    for (const name of RETIRED_SEARCH_TABLES) {
      db.exec(`ALTER TABLE messages_fts RENAME TO "${name}"`);
      db.exec(legacySearchDdl);
    }
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='search_intents'").get()) {
      db.exec("CREATE TABLE search_intents(seq INTEGER PRIMARY KEY AUTOINCREMENT, nonce INTEGER NOT NULL, rowid INTEGER, thread_key TEXT, CHECK ((rowid IS NULL) <> (thread_key IS NULL)), CHECK (thread_key IS NULL OR length(CAST(thread_key AS BLOB)) <= 72))");
    }

    initializeImageOperations(db); initializeImageLibrary(db); initializeThreadSnooze(db); initializeProjectTables(db); ensureForgetTable(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); initializeFluxSpaces(db); initializeProjectCardDelivery(db); initializePhones(db); initializeAskRevocations(db); initializePhoneReceipts(db); initializeOwnerSends(db); initializeSendAttempts(db); initializePendingDelegations(db); initializeDelegationPacks(db); initializeBotCalls(db); initializeReplySchema(db); initializeAppTriggers(db); initializeEmailTables(db); initializeOwnWriteHolds(db); initializeVenuePosts(db); initializeRoomShares(db);
    ensureGH18Operations(db);
    db.exec(RESTORE_JOB_MARKS_DDL);
    db.exec(RESTORE_BOOT_WAIT_DDL);
    initializeFolderTrustActivity(db);
    initializeMailboxCustody(db);
    ensureIndexOverrun(db);
    db.exec(BOT_CREATE_COMMITS_DDL);
    const objects = new Map<string, ReferenceObject>();
    const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
    const tables = new Map(APP_TABLES);
    for (const name of APP_SCHEMA_102_ADDITIONS.tables) if (!tables.has(name) && rows.some(row => row.type === "table" && row.name === name)) tables.set(name, { required: false, optional: [] });
    for (const row of rows) {
      if (!tables.has(row.tbl_name)) throw new Error(`initializer created an object outside APP_TABLES: ${row.name}`);
      objects.set(row.name, { type: row.type, table: row.tbl_name, sql: new Set([normalizedSql(row.sql)]), columns: row.type === "table" ? [columnShape(db, row.name)] : [] });
    }
    // Archives from before lossless stop IDs still carry the INTEGER column.
    // Accept only that exact predecessor; first app open migrates it to TEXT.
    const overrunObject = objects.get("index_overrun");
    if (overrunObject) {
      const legacy = new DatabaseSync(":memory:");
      try {
        legacy.exec(INDEX_OVERRUN_LEGACY_SCHEMA);
        overrunObject.sql.add(normalizedSql((legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='index_overrun'").get() as SchemaRow).sql));
        overrunObject.columns.push(columnShape(legacy, "index_overrun"));
      } finally { legacy.close(); }
    }
    for (const sql of TURN_INDEX_PREVIOUS_DDLS) objects.get(TURN_INDEX)?.sql.add(normalizedSql(sql));
    // Archives from before the append guard carry the unguarded trigger. Accept
    // only that exact predecessor; first app open replaces it atomically.
    objects.get("routine_link_before_insert")?.sql.add(normalizedSql(ROUTINE_LINK_BEFORE_INSERT_PREVIOUS_DDL));
    // The Inbox projection's triggers read inbox_item_state.cleared_at, so they
    // would refuse the column drops below; they are recorded already, and an
    // archive old enough to lack the column predates the projection too.
    discardInboxProjection(db);
    // A downgrade removes via_proof while the newer send metadata remains.
    // Reopening appends that proof column after the metadata. Accept precisely
    // the schema our initializer produces, retaining SQL and column checks.
    const migratedSends = new DatabaseSync(":memory:");
    try {
      migratedSends.exec(String(rows.find(row => row.name === "owner_sends")!.sql));
      migratedSends.exec("ALTER TABLE owner_sends DROP COLUMN via_proof");
      initializeOwnerSends(migratedSends);
      const object = objects.get("owner_sends")!;
      object.sql.add(normalizedSql(migratedSends.prepare("SELECT sql FROM sqlite_schema WHERE name='owner_sends'").get()!.sql));
      object.columns.push(columnShape(migratedSends, "owner_sends"));
    } finally { migratedSends.close(); }
    // a child table an earlier 1.0.2 build wrote without its cascade is still the same table
    for (const [name, entry] of Object.entries(ADDED_TABLE_LIFECYCLE)) {
      if (entry.kind === "child") for (const legacy of entry.legacyDdl) objects.get(name)?.sql.add(normalizedSql(legacy));
    }
    for (const [table, { optional }] of tables) {
      const object = objects.get(table);
      if (!object || object.type !== "table") throw new Error(`initializer did not create ${table}`);
      // An older archive predates the migration that appended these columns.
      // Dropping them from the fresh table restores exactly the text SQLite
      // kept before ALTER TABLE ADD COLUMN extended it.
      for (const column of [...optional].reverse()) {
        // a trigger or an index that names the column (already recorded above) would make the drop fail: it goes first, this database is only a reference
        for (const dependent of db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('trigger','index') AND sql IS NOT NULL").all() as Array<{ type: string; name: string; sql: string }>) {
          if (new RegExp(`\\b${column}\\b`).test(dependent.sql)) db.exec(`DROP ${dependent.type === "index" ? "INDEX" : "TRIGGER"} "${dependent.name}"`);
        }
        db.exec(`ALTER TABLE "${table}" DROP COLUMN "${column}"`);
        object.sql.add(normalizedSql((db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table) as SchemaRow).sql));
        object.columns.push(columnShape(db, table));

      }
    }
    // A downgrade removes phone columns or ask proof. Reopening appends them
    // in migration order, which differs from the fresh-install column order.
    // Admit only the exact definitions produced by those serving migrations.
    const ownerSends = objects.get("owner_sends")!;
    for (const rewind of [downgradeOwnerSendAskProof, downgradePhoneObjectsTo108]) for (const settled of [false, true]) {
      const legacy = new DatabaseSync(":memory:");
      try {
        initializeOwnerSends(legacy);
        // Empty queues can drop newer metadata; settled rows retain it.
        if (settled) legacy.exec("INSERT INTO owner_sends(kind,owner_id,thread_id,queue_id,fingerprint,status,created_at,updated_at) VALUES('bot','fixture','thread','queue','digest','delivered',1,1)");
        rewind(legacy);
        // A backup may run after the real downgrade, before the next app open.
        // Keep its exact schema as well as the subsequently migrated schema.
        ownerSends.sql.add(normalizedSql((legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='owner_sends'").get() as SchemaRow).sql));
        ownerSends.columns.push(columnShape(legacy, "owner_sends"));
        initializeOwnerSends(legacy);
        ownerSends.sql.add(normalizedSql((legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='owner_sends'").get() as SchemaRow).sql));
        ownerSends.columns.push(columnShape(legacy, "owner_sends"));
      } finally { legacy.close(); }
    }
    // An archive written by an earlier build still carries the partial index the owed set replaced: accepted with exactly that text
    // (the app drops it on first open), never under another definition.
    if (objects.has("room_requests")) {
      db.exec(LEGACY_SHARED_OWED_INDEX_DDL);
      objects.set(LEGACY_SHARED_OWED_INDEX, { type: "index", table: "room_requests", sql: new Set([normalizedSql((db.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(LEGACY_SHARED_OWED_INDEX) as SchemaRow).sql)]), columns: [] });
    }
    // The two-column owed table of the first build of this release is accepted with exactly its text and columns (restore
    // preparation rebuilds it); the table is derived data, so nothing is lost.
    const owedObject = objects.get("room_request_owed");
    if (owedObject) {
      const legacy = new DatabaseSync(":memory:");
      try {
        legacy.exec(LEGACY_OWED_TABLE_DDL);
        owedObject.sql.add(normalizedSql((legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='room_request_owed'").get() as SchemaRow).sql));
        owedObject.columns.push(columnShape(legacy, "room_request_owed"));
      } finally { legacy.close(); }
    }
    // The pending-hand-off table before owner_rooted (fee454fb0) is accepted with exactly its text and columns: an archive from 1.0.2 carries
    // it, and the app adds the column on first open (pending-delegations-schema.ts).
    const pendingObject = objects.get("pending_delegations");
    if (pendingObject) {
      const legacy = new DatabaseSync(":memory:");
      try {
        legacy.exec(PENDING_DELEGATIONS_PRE_PACK_DDL);
        pendingObject.sql.add(normalizedSql((legacy.prepare("SELECT sql FROM sqlite_schema WHERE name='pending_delegations'").get() as SchemaRow).sql));
        pendingObject.columns.push(columnShape(legacy, "pending_delegations"));
      } finally { legacy.close(); }
    }
    reference = objects;
    registeredTables = tables;
    return objects;
  } finally { db.close(); }
}

/** The name of every non-memory object a snapshot accepts, read from the same reference the inspection uses. For the structural guard
 *  (backup-restore-speech-tables.test.ts): a fresh database opened by the real path holds no object outside this set and the memory schema. */
export function registeredSnapshotObjects(): ReadonlySet<string> { return new Set(referenceSchema().keys()); }

export function inspectInstallationDatabase(db: DatabaseSync) {
  const fail = (code: string): never => { throw new InstallationSnapshotError(code); };
  // A private archive is still untrusted input. Reject executable schema and
  // unknown tables instead of allowing triggers to run during preparation.
  let memoryObjects = new Set<string>();
  try { memoryObjects = validateMemorySchema(db); }
  catch { fail("DATABASE_SCHEMA_UNSUPPORTED"); }
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
  const expected = referenceSchema();
  for (const item of schema) {
    if (memoryObjects.has(String(item.name))) continue;
    // The projection is derived data that restore discards before anything
    // runs and the app rebuilds from the messages; its text is the app's to
    // change, so an archive's copy is never held to a byte-exact definition.
    if (isInboxProjectionObject(item)) continue;
    // RESTORE-PARK r3.1 section 5 step 5: a Cloud export can still carry its one-row restore_pending marker (consumed at the next
    // Cloud boot). It is accepted only in the exact form murage-commands writes, then dropped by the restore preparation.
    if (item.tbl_name === "restore_pending" && (item.type === "table" ? normalizedSql(item.sql) === RESTORE_PENDING_SQL : item.type === "index" && item.sql === null)) continue;
    // A known NAME is not enough: an index kept under an allowed name but
    // made partial, unique, expression-based or re-targeted, or a table with a
    // CHECK, conflict clause or generated column, would survive activation
    // (the app's CREATE ... IF NOT EXISTS keeps an existing definition).
    // Every object must be one the harness creates, with its definition.
    const known = expected.get(String(item.name));
    if (!known || known.type !== item.type || known.table !== item.tbl_name || !known.sql.has(normalizedSql(item.sql))) fail("DATABASE_SCHEMA_UNSUPPORTED");
  }
  for (const [table, { required }] of appTables()) {
    if (isInboxProjectionObject({ type: "table", name: table, tbl_name: table })) continue;
    if (!schema.some(item => item.type === "table" && item.name === table)) {
      if (required) fail("DATABASE_SCHEMA_UNSUPPORTED");
      continue;
    }
    // The text matched; the columns SQLite built from it must match too.
    const actual = JSON.stringify(columnShape(db, table));
    if (!expected.get(table)!.columns.some(shape => JSON.stringify(shape) === actual)) fail("DATABASE_SCHEMA_UNSUPPORTED");
    // M3 owns sealed-content omission and ledger restore. Keep populated custody on hold until then.
    if ((table === "mailbox_sealed_threads" || table === "mailbox_sealed_rows") &&
      db.prepare(`SELECT 1 FROM main."${table}" LIMIT 1`).get()) fail("DATABASE_SCHEMA_UNSUPPORTED");
  }
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('messages','thread_state')").all();
  if (tables.length !== 2) throw new InstallationSnapshotError("DATABASE_SCHEMA_UNSUPPORTED");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE NOT json_valid(json)")) throw new InstallationSnapshotError("INVALID_MESSAGE_JSON");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE json_type(json) != 'object' OR json_extract(json,'$.id') IS NOT id")) throw new InstallationSnapshotError("INVALID_MESSAGE_IDENTITY");
  if (count(db, "SELECT COUNT(*) AS count FROM messages WHERE json_extract(json,'$.at') IS NOT at OR json_extract(json,'$.role') IS NOT role OR json_extract(json,'$.kind') IS NOT kind OR json_extract(json,'$.text') IS NOT text")) fail("INVALID_MESSAGE_IDENTITY");
  if (count(db, "SELECT COUNT(*) AS count FROM thread_state AS t WHERE active_leaf_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages AS m WHERE m.thread_id=t.thread_id AND m.id=t.active_leaf_id)")) {
    throw new InstallationSnapshotError("INVALID_ACTIVE_BRANCH");
  }
  let thread: string | undefined;
  let graph = new InstallationTranscriptGraph(fail);
  for (const row of db.prepare("SELECT thread_id,json FROM messages ORDER BY thread_id,rowid").iterate()) {
    if (typeof row.thread_id !== "string" || !/^[\w-]{1,160}$/.test(row.thread_id) || typeof row.json !== "string" || Buffer.byteLength(row.json) > 64 * 1024 ** 2) fail("INVALID_RESTORE_MESSAGE");
    if (thread !== row.thread_id) {
      graph.validate();
      graph = new InstallationTranscriptGraph(fail);
      thread = row.thread_id as string;
    }
    graph.add(rowToMessage({ json: row.json as string }));
  }
  graph.validate();
  return {
    messages: count(db, "SELECT COUNT(*) AS count FROM messages"),
    threads: count(db, "SELECT COUNT(*) AS count FROM thread_state"),
  };
}

/** The refusals of inspectInstallationDatabase that are about one conversation row, not about the file or its schema. */
const ROW_REFUSALS: ReadonlySet<string> = new Set(["INVALID_MESSAGE_JSON", "INVALID_MESSAGE_IDENTITY", "INVALID_ACTIVE_BRANCH", "INVALID_MESSAGE_PARENT", "CYCLIC_MESSAGE_BRANCH", "INVALID_RESTORE_MESSAGE"]);
/** One conversation row a backup left out, named for the backup's own list of what it left out. */
export interface SetAsideRow { thread: string; id: string; reason: string }

/** A backup of this installation's own database never stops at one row (1.0.22: a single row the reader could not parse refused every
 * backup of that installation, and nothing the person could do cleared it). Runs on the STAGED private copy only, never the live file:
 * each row inspectInstallationDatabase would refuse leaves the copy and is returned by name, and a conversation whose current message
 * left with it points at its newest remaining message. The rules are the inspection's own, row by row, so what is set aside is exactly
 * what would have refused the backup. The rows leave by a plain DELETE with the app's own triggers in place, so everything the app
 * keeps about a message (routine links, copies, memory's change log) leaves with it exactly as when the app deletes one. The caller
 * removes the Inbox projection first (discardInboxProjection, as a restore does): its triggers are not held to this build's text.
 * A row with no parent of its own follows the row before it, the unreadable ones included, so a removal never decides which rows are
 * on a loop: a row that a removal would chain into a loop it was not on keeps its own parent (the removed row's name, so it begins
 * its branch as it did) and stays. Only rows that are refused on their own, or sit on a loop of the file as it is, leave.
 * The inspection itself is unchanged and still runs on the result, and a restore runs it again. */
export function setAsideUnreadableRows(db: DatabaseSync): SetAsideRow[] {
  const label = (value: unknown) => String(value ?? "").slice(0, 160);
  type Row = { rowid: number; thread_id: unknown; id: unknown; json: unknown };
  class RowRefused extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
  const refuse = (code: string): never => { throw new RowRefused(code); };
  /** One reading of every row by the inspection's rules: the rows it would refuse, by rowid, each loop by its rows, and for every row
   * with no parent of its own the row it follows. */
  const scan = () => {
    const bad = new Map<number, SetAsideRow>(), loops: number[][] = [], follows = new Map<number, { rowid: number; id: string }>();
    // every row of a conversation, read or not: the row before it, and each name's row
    const prior = new Map<number, { rowid: number; id: string } | null>(), named = new Map<string, number>();
    const mark = (row: { rowid: unknown; thread_id: unknown; id: unknown }, reason: string) => { const rowid = Number(row.rowid); if (!bad.has(rowid)) bad.set(rowid, { thread: label(row.thread_id), id: label(row.id), reason }); };
    for (const row of db.prepare("SELECT rowid,thread_id,id FROM messages WHERE NOT json_valid(json)").all()) mark(row as Row, "INVALID_MESSAGE_JSON");
    for (const row of db.prepare("SELECT rowid,thread_id,id FROM messages WHERE CASE WHEN json_valid(json) THEN json_type(json) != 'object' OR json_extract(json,'$.id') IS NOT id OR json_extract(json,'$.at') IS NOT at OR json_extract(json,'$.role') IS NOT role OR json_extract(json,'$.kind') IS NOT kind OR json_extract(json,'$.text') IS NOT text ELSE 0 END").all()) mark(row as Row, "INVALID_MESSAGE_IDENTITY");
    let thread: unknown, graph = new InstallationTranscriptGraph(refuse), previous: string | null = null;
    // a parent loop is found when the conversation ends, so each row is kept until then by its name only, never its payload
  let parents = new Map<string, { parent: string | null; row: Pick<Row, "rowid" | "thread_id" | "id"> }>();
    // the rows of one conversation that sit on a parent loop: the same walk InstallationTranscriptGraph.validate makes, keeping the names
    const closeThread = () => {
      const colors = new Map<string, number>();
      for (const start of parents.keys()) {
        if (colors.get(start) === 2) continue;
        const path: string[] = [];
        let current: string | null = start;
        while (current !== null && parents.has(current) && colors.get(current) !== 2) {
          if (colors.get(current) === 1) { const loop = path.slice(path.indexOf(current)).map(id => parents.get(id)!.row); for (const row of loop) mark(row, "CYCLIC_MESSAGE_BRANCH"); loops.push(loop.map(row => Number(row.rowid))); break; }
          colors.set(current, 1); path.push(current);
          current = parents.get(current)!.parent;
        }
        for (const visited of path) colors.set(visited, 2);
      }
    };
    // the row before, read or not: a row with no parent of its own follows it in the file as it is, so skipping one never re-chains
    let before: { rowid: number; id: string } | null = null;
    for (const row of db.prepare("SELECT rowid,thread_id,id,json FROM messages ORDER BY thread_id,rowid").iterate() as Iterable<Row>) {
      if (typeof row.thread_id !== "string" || !/^[\w-]{1,160}$/.test(row.thread_id)) { mark(row, "INVALID_RESTORE_MESSAGE"); continue; }
      if (thread !== row.thread_id) { closeThread(); graph = new InstallationTranscriptGraph(refuse); parents = new Map(); previous = null; before = null; thread = row.thread_id; }
      const self = { rowid: Number(row.rowid), id: String(row.id ?? "") };
      prior.set(self.rowid, before); named.set(`${row.thread_id}\0${self.id}`, self.rowid);
      try {
        if (bad.has(self.rowid)) continue;
        if (typeof row.json !== "string" || Buffer.byteLength(row.json) > 64 * 1024 ** 2) { mark(row, "INVALID_RESTORE_MESSAGE"); continue; }
        const message = rowToMessage({ json: row.json }) as unknown as Record<string, unknown>;
        graph.add(message);
        const parent = message.parentId === undefined ? previous : message.parentId as string | null;
        if (message.parentId === undefined && before) follows.set(self.rowid, before);
        parents.set(message.id as string, { parent, row: { rowid: row.rowid, thread_id: row.thread_id, id: row.id } });
      } catch (error) {
        // the size limit of a whole conversation is not one row's fault: it stays a refusal
        if (error instanceof RowRefused && !ROW_REFUSALS.has(error.code)) throw new InstallationSnapshotError(error.code);
        mark(row, error instanceof RowRefused ? error.code : "INVALID_RESTORE_MESSAGE");
      } finally {
        // an unreadable row is followed by its name in the file (the graph keeps it as a parent outside the conversation: a root)
        previous = self.id; before = self;
      }
    }
    closeThread();
    return { bad, loops, follows, prior, named };
  };
  const dangling = "active_leaf_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages AS m WHERE m.thread_id=thread_state.thread_id AND m.id=thread_state.active_leaf_id)";
  const pointers = () => db.prepare(`SELECT thread_id,active_leaf_id AS id FROM thread_state WHERE ${dangling}`).all() as Array<{ thread_id: unknown; id: unknown }>;
  const aside: SetAsideRow[] = [], before = pointers();
  db.exec("BEGIN IMMEDIATE");
  try {
    const remove = db.prepare("DELETE FROM messages WHERE rowid=?");
    // the parent it had: the removed row's name, or a plain root when that name is not a message name or another row holds it
    const pin = db.prepare("UPDATE messages SET json=json_set(json,'$.parentId',CASE WHEN ?1 IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages AS m WHERE m.thread_id=messages.thread_id AND m.id=?1) THEN ?1 END) WHERE rowid=?2");
    // A row with no parent of its own follows the row before it, so a removal re-chains its neighbours: the row that followed a
    // removed one is named with it (by its first removed neighbour, the parent it had in the file), and the rows are read again until
    // a reading finds nothing to refuse. A loop that holds such a row was made by the removal, not found in the file: that row keeps
    // its own parent and nothing on the loop leaves. Bounded: every round removes or pins at least one row.
    const rechained = new Map<number, string>();
    const splice = db.prepare("UPDATE messages SET json=json_set(json,'$.parentId',?) WHERE rowid=?");
    // A removed row's own parent, decided once and before anything is done with it. The stored value is decoded first, text or BLOB
    // (UTF-8), as SQLite's own JSON functions read it for the app's branch index (branch-index.ts fillSlice), and then read by both
    // of the app's readers: JSON.parse (transcript-seq.ts rowToMessage: of a repeated key the last counts) and SQLite's JSON
    // functions (the first counts). Only what both read alike is known: a parent it names, no parent (a root), or no parent of its
    // own (text neither reads as JSON included, as the branch index reads it: it followed the row before it). Anything else (bytes
    // that are not UTF-8, readers that disagree, a parent that is not a message name) is not known, and nothing is attached on it.
    const stored = db.prepare("SELECT json FROM messages WHERE rowid=?");
    const sqlite = db.prepare("SELECT json_valid(?1) AS valid, CASE WHEN json_valid(?1) THEN json_type(?1,'$.parentId') END AS type, CASE WHEN json_valid(?1) AND json_type(?1,'$.parentId')='text' THEN json_extract(?1,'$.parentId') END AS parent");
    type OwnParent = { known: false } | { known: true; explicit: false } | { known: true; explicit: true; parent: string | null };
    const UNKNOWN: OwnParent = { known: false }, FOLLOWS: OwnParent = { known: true, explicit: false };
    const ownParents = new Map<number, OwnParent>();
    const readOwnParent = (rowid: number): OwnParent => {
      const value = (stored.get(rowid) as { json?: unknown } | undefined)?.json;
      let text: string;
      if (typeof value === "string") text = value;
      else if (value instanceof Uint8Array) { try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value); } catch { return UNKNOWN; } }
      else return UNKNOWN;
      let parsed: unknown, readable = true;
      try { parsed = JSON.parse(text); } catch { readable = false; }
      let index: { valid?: unknown; type?: unknown; parent?: unknown } | undefined;
      try { index = sqlite.get(text) as typeof index; } catch { return UNKNOWN; }
      if (readable !== (Number(index?.valid) === 1)) return UNKNOWN;
      if (!readable) return FOLLOWS;
      const names = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "parentId");
      if (!names) return index?.type === null ? FOLLOWS : UNKNOWN;
      const parent = (parsed as { parentId: unknown }).parentId;
      if (parent === null) return index?.type === "null" ? { known: true, explicit: true, parent: null } : UNKNOWN;
      if (typeof parent !== "string" || !/^[\w-]{1,160}$/.test(parent) || index?.type !== "text" || index.parent !== parent) return UNKNOWN;
      return { known: true, explicit: true, parent };
    };
    const parentOf = (rowid: number): OwnParent => { let own = ownParents.get(rowid); if (!own) ownParents.set(rowid, own = readOwnParent(rowid)); return own; };
    const threadOf = db.prepare("SELECT thread_id FROM messages WHERE rowid=?");
    const size = db.prepare("SELECT length(CAST(json AS BLOB)) AS bytes FROM messages WHERE rowid=?");
    const tooLarge = (rowid: number) => Number((size.get(rowid) as { bytes?: unknown } | undefined)?.bytes ?? 0) > 64 * 1024 ** 2;
    for (let round = 0; ; round++) {
      const { bad, loops, follows, prior, named } = scan();
      ownParents.clear();
      if (!bad.size) break;
      if (round >= 64) throw new InstallationSnapshotError([...bad.values()][0]!.reason);
      let pinned = 0;
      for (const loop of loops) {
        const own = loop.filter(rowid => rechained.has(rowid));
        if (!own.length) continue;
        for (const rowid of own) {
          pin.run(rechained.get(rowid) || null, rowid); rechained.delete(rowid); pinned++;
          // the parent it keeps makes its text longer: a row the pin takes past the size a restore reads is never left out for it
          if (tooLarge(rowid)) throw new InstallationSnapshotError("INVALID_RESTORE_MESSAGE");
        }
        for (const rowid of loop) bad.delete(rowid);
      }
      if (pinned) continue;
      // The row that followed a removed one takes the removed row's own parent (through every removed row), as the file had it:
      // a removed row that names its parent hands that parent on, and one with no parent of its own followed the row before it.
      // Where a removed row's own parent is not known the walk stops: the follower keeps the parent it had, the removed row's
      // name (it begins its branch there, a root), and is never attached to another row on a guess.
      const thread = (rowid: number) => (threadOf.get(rowid) as { thread_id?: unknown } | undefined)?.thread_id;
      const ancestor = (start: number, fallback: string | null): string | null => {
        const seen = new Set<number>();
        for (let rowid: number | undefined = start; rowid !== undefined && !seen.has(rowid);) {
          seen.add(rowid);
          const own = parentOf(rowid);
          if (!own.known) return fallback;
          let next: number | undefined;
          if (own.explicit) {
            if (own.parent === null) return null;
            next = named.get(`${thread(rowid)}\0${own.parent}`);
            if (next === undefined || !bad.has(next)) return own.parent;
          } else {
            const before = prior.get(rowid);
            if (!before) return null;
            if (!bad.has(before.rowid)) return before.id;
            next = before.rowid;
          }
          rowid = next;
        }
        // the removed rows' own parents loop: it begins its branch at the removed row's name (a root)
        return fallback;
      };
      const remaining = (rowid: number): string | null => { let before = prior.get(rowid); while (before && bad.has(before.rowid)) before = prior.get(before.rowid); return before?.id ?? null; };
      for (const [rowid, row] of follows) {
        if (bad.has(rowid) || !bad.has(row.rowid)) continue;
        if (!rechained.has(rowid)) rechained.set(rowid, /^[\w-]{1,160}$/.test(row.id) ? row.id : "");
        const parent = ancestor(row.rowid, /^[\w-]{1,160}$/.test(row.id) ? row.id : null);
        if (parent === remaining(rowid)) continue;
        splice.run(parent, rowid);
        if (tooLarge(rowid)) throw new InstallationSnapshotError("INVALID_RESTORE_MESSAGE");
      }
      for (const rowid of bad.keys()) remove.run(rowid);
      aside.push(...bad.values());
    }
    const moved = [...new Map([...before, ...pointers()].map(row => [String(row.thread_id), row])).values()];
    if (moved.length) db.exec(`UPDATE thread_state SET active_leaf_id=(SELECT id FROM messages AS m WHERE m.thread_id=thread_state.thread_id ORDER BY m.rowid DESC LIMIT 1) WHERE ${dangling}`);
    db.exec("COMMIT");
    const removed = new Set(aside.map(row => `${row.thread}\0${row.id}`));
    return [...aside, ...moved.filter(row => !removed.has(`${label(row.thread_id)}\0${label(row.id)}`)).map(row => ({ thread: label(row.thread_id), id: label(row.id), reason: "INVALID_ACTIVE_BRANCH" }))];
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the first error is the one to report */ }
    throw error;
  }
}

/** The memory proofs whose failing rows can be named one by one (the proof's own query finds them), so a backup can leave exactly
 * those rows out. Every other failed proof (a derived index that differs, a shape, a missing detail) still refuses the backup. */
const MEMORY_ROW_PROOFS: ReadonlySet<string> = new Set(["INVALID_MEMORY_LESSON_EVENT", "INVALID_MEMORY_LEARNING_EVENT", "INVALID_MEMORY_REFERENCE"]);
/** The tables holding a row whose reference names no row (PRAGMA foreign_key_check), one entry per such row. */
function brokenReferences(db: DatabaseSync): Array<{ table: string; rowid: number | null }> {
  return (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table?: unknown; rowid?: unknown }>).map(row => ({ table: String(row.table), rowid: row.rowid === null || row.rowid === undefined ? null : Number(row.rowid) }));
}

/** Why this installation's memory fails its own proof while its schema is exactly this build's, or null. The app opens such a file and
 * runs: its integrity pass sets memory aside (memory/integrity-pass.ts HOLD_MESSAGES: "Your chats work as usual and nothing was
 * deleted") and tells the person to make a copy of their data. The backup's reader ran the same proofs and reported any failure as
 * DATABASE_SCHEMA_UNSUPPORTED ("from a different version of Murage. Open this version of Murage normally once"), which no amount of
 * opening could clear (1.0.22 owner report). Only a proof whose failing rows can be named counts (MEMORY_ROW_PROOFS): a schema this
 * build does not write, any other failure, and a broken reference in a table that is not memory's all return null and still refuse. */
export function memoryProofFailure(db: DatabaseSync): string | null {
  let names: Set<string>;
  try { names = validateMemorySchema(db, { structuralOnly: true }); } catch { return null; }
  if (!names.size) return null;
  let code: string;
  try { validateMemorySchema(db); return null; }
  catch (error) { code = String((error as Error)?.message ?? ""); }
  if (!MEMORY_ROW_PROOFS.has(code)) return null;
  // the reference sweep reads every table with a reference, memory's or not: only a fault inside memory is memory's to set aside
  if (code === "INVALID_MEMORY_REFERENCE" && brokenReferences(db).some(row => !names.has(row.table) && !row.table.startsWith("memory_"))) return null;
  return code;
}

/** A backup of this installation's own database never stops at one memory row either. On the STAGED private copy only, never the live
 * file: the rows a nameable proof refuses (an active lesson with no ledger event, a ledger event that names no scope or record, a row
 * whose reference names nothing) leave the copy and are returned by name; every other memory row stays. Each round runs memory's own
 * full proof and removes exactly the rows the failed proof's own query finds, with the app's triggers in place, until the proof
 * passes. A proof with no nameable rows, a fault outside memory's tables, or a round that removes nothing refuses the backup as
 * before: nothing is ever left out wholesale. The unchanged inspection runs on the result, and a restore runs it again. */
export function setAsideUnprovenMemoryRows(db: DatabaseSync): string[] {
  const refused = () => new InstallationSnapshotError("DATABASE_SCHEMA_UNSUPPORTED");
  let names: Set<string>;
  try { names = validateMemorySchema(db, { structuralOnly: true }); } catch { throw refused(); }
  const label = (value: unknown) => String(value ?? "").replace(/[^\w.:-]/g, "?").slice(0, 80);
  const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const aside: string[] = [];
  // a removed row's own children are found by the next round's reference sweep, not refused by enforcement in the middle of this one
  const enforced = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)?.foreign_keys ?? 0);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let round = 0; ; round++) {
      let code: string;
      try { validateMemorySchema(db); break; }
      catch (error) { code = String((error as Error)?.message ?? ""); }
      if (round >= 64 || !MEMORY_ROW_PROOFS.has(code)) throw refused();
      let removed = 0;
      if (code === "INVALID_MEMORY_LESSON_EVENT") {
        for (const row of db.prepare("SELECT l.rowid AS rowid, l.id AS id FROM memory_lessons l WHERE l.state='active' AND (l.learning_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM memory_learning_events e WHERE e.id=l.learning_event_id))").all()) {
          removed += Number(db.prepare("DELETE FROM memory_lessons WHERE rowid=?").run(row.rowid as number).changes);
          aside.push(`lesson ${label(row.id)}`);
        }
      } else if (code === "INVALID_MEMORY_LEARNING_EVENT") {
        for (const row of db.prepare(`SELECT e.rowid AS rowid, e.id AS id FROM memory_learning_events e WHERE NOT EXISTS(SELECT 1 FROM memory_scopes s WHERE s.id=e.scope_id)
          OR (e.record_id IS NOT NULL AND e.record_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM memory_records r WHERE r.id=e.record_id AND r.version=e.record_version))`).all()) {
          removed += Number(db.prepare("DELETE FROM memory_learning_events WHERE rowid=?").run(row.rowid as number).changes);
          aside.push(`learning event ${label(row.id)}`);
        }
      } else {
        const broken = brokenReferences(db);
        if (broken.some(row => row.rowid === null || (!names.has(row.table) && !row.table.startsWith("memory_")))) throw refused();
        for (const row of new Map(broken.map(row => [`${row.table}\0${row.rowid}`, row])).values()) {
          removed += Number(db.prepare(`DELETE FROM ${quoted(row.table)} WHERE rowid=?`).run(row.rowid!).changes);
          aside.push(`${label(row.table)} row ${row.rowid}`);
        }
      }
      if (!removed) throw refused();
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the first error is the one to report */ }
    throw error instanceof InstallationSnapshotError ? error : refused();
  } finally { if (enforced) db.exec("PRAGMA foreign_keys=ON"); }
  return aside;
}

function digestFile(path: string): string {
  const fd = openSync(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { closeSync(fd); }
}

/** Database component of an offline installation snapshot, not an installation
 * backup by itself. Takes the same external lease as the running harness,
 * copies WAL-visible committed data through SQLite backup, validates it, then
 * publishes without replacing any existing destination. No runtime Store,
 * migration, provider or scheduler is constructed. Other app-state components
 * must eventually share this offline epoch in the complete backup builder. */
async function snapshotSqliteWhileOwned<T extends object>(dataDir: string, destination: string, component: "messages.db" | "memory-index.db" | "connected-app-ledger.db" | "phone-calls.db" | "delivery-ledger.db", inspect: (db: DatabaseSync) => T, onProgress?: BackupProgressReport, relative: string = component) {
  const report = safeBackupProgress(onProgress);
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  if (!destination || /[\r\n\0]/.test(destination) || [".", "..", ""].includes(basename(destination))) throw new InstallationSnapshotError("INVALID_DESTINATION");
  // Canonicalize the parent, not the file: an existing destination must be
  // refused rather than followed as a symlink or treated as a directory.
  const target = join(dataDirLeasePaths(dirname(destination)).canonicalDataDir, basename(destination));
  if (target === root || target.startsWith(root + sep)) throw new InstallationSnapshotError("DESTINATION_INSIDE_INSTALLATION");
  if (resolve(target) === dirname(target)) throw new InstallationSnapshotError("INVALID_DESTINATION");
  try {
    lstatSync(target);
    throw new InstallationSnapshotError("DESTINATION_EXISTS");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let scratch: string | undefined;
  let source: DatabaseSync | undefined;
  const originals:Array<{path:string;suffix:string;identity:Stats;fd:number;sha256?:string}>=[];
  const equalIdentity=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&b.nlink===1;
  const digestDescriptor=(fd:number)=>{const hash=createHash("sha256"),buffer=Buffer.alloc(64*1024);let offset=0;for(;;){const size=readSync(fd,buffer,0,buffer.length,offset);if(!size)return hash.digest("hex");hash.update(buffer.subarray(0,size));offset+=size;}};
  try {
    const file = join(root, relative);
    const identity = regularFile(file, true);
    if (!identity) return { status: "absent" as const };
    // Read-only SQLite can update the original SHM read marks. Capture DB+WAL
    // through held regular-file descriptors under the offline lease, then let
    // SQLite reconstruct SHM only in private staging. Never open original SQLite.
    for(const suffix of ["","-wal","-shm"]){
      const before=suffix?regularFile(file+suffix,true):identity;if(!before)continue;
      const fd=openSync(file+suffix,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
      originals.push({path:file+suffix,suffix,identity:before,fd});
      if(!equalIdentity(before,fstatSync(fd)))throw new InstallationSnapshotError("SOURCE_CHANGED");
    }
    const assertOriginals=()=>{
      for(const suffix of ["","-wal","-shm"]){
        const held=originals.find(entry=>entry.suffix===suffix),current=regularFile(file+suffix,true);
        if(!held){if(current)throw new InstallationSnapshotError("SOURCE_CHANGED");continue;}
        if(!current||!equalIdentity(held.identity,current)||!equalIdentity(held.identity,fstatSync(held.fd))||(held.sha256!==undefined&&digestDescriptor(held.fd)!==held.sha256))throw new InstallationSnapshotError("SOURCE_CHANGED");
      }
    };
    // a killed earlier run can leave raw, unsettled copies in this parent (SMOOTH-FTS-MERGE R6 section 3, stale scratch)
    sweepStaleCopyScratch(dirname(target));
    scratch = mkdtempSync(join(dirname(target), ".murage-database-snapshot-"));
    claimCopyScratch(scratch);
    const inputDirectory=join(scratch,"source");mkdirSync(inputDirectory,{mode:0o700});
    const originalBytes=originals.reduce((total,held)=>total+held.identity.size,0);let readBytes=0;
    report("database-read",0,originalBytes);
    for(const held of originals){
      const output=held.suffix==="-shm"?undefined:openSync(join(inputDirectory,component+held.suffix),"wx",0o600);
      try{
        const hash=createHash("sha256"),buffer=Buffer.alloc(64*1024);let offset=0;
        for(;;){
          const size=readSync(held.fd,buffer,0,buffer.length,offset);if(!size)break;
          hash.update(buffer.subarray(0,size));
          if(output!==undefined){let written=0;while(written<size){const bytes=writeSync(output,buffer,written,size-written);noteWrittenBytes("database-copy",bytes);written+=bytes;}}// charge each successful write even if the next throws; -shm is read and hashed only
          offset+=size;readBytes+=size;report("database-read",readBytes,originalBytes);
        }
        held.sha256=hash.digest("hex");
        if(offset!==held.identity.size)throw new InstallationSnapshotError("SOURCE_CHANGED");
        if(output!==undefined)fsyncSync(output);
      }finally{if(output!==undefined)closeSync(output);}
    }
    report("source-recheck");
    assertOriginals();
    const staged = join(scratch, component);
    const fd = openSync(staged, "wx", 0o600);closeSync(fd);
    source = new DatabaseSync(join(inputDirectory,component), { readOnly: true, timeout: 1000 });
    report("database-check");
    // A refusal about one conversation row does not stop this installation's own backup: the row is set aside in the staged copy
    // below, and the unchanged inspection decides on that copy. Every other refusal (the file, its schema, its integrity) stops here.
    let rowRefusal: string | undefined, memoryAside: string | undefined;
    try { inspect(source); }
    catch (error) {
      if (component !== "messages.db" || !(error instanceof InstallationSnapshotError)) throw error;
      // A memory row that fails its own proof inside a schema this build writes: the app runs on (memory set aside), and the backup
      // leaves that row out of the staged copy below.
      const unproven = error.code === "DATABASE_SCHEMA_UNSUPPORTED" ? memoryProofFailure(source) : null;
      if (unproven) memoryAside = unproven;
      else if (ROW_REFUSALS.has(error.code)) rowRefusal = error.code;
      else throw error;
    }
    report("database-copy",0,identity.size);
    await backup(source, staged, { rate: 128, progress: ({ totalPages, remainingPages }) => { if (totalPages > 0) report("database-copy", Math.round(identity.size * (1 - remainingPages / totalPages)), identity.size); } });
    noteWrittenFile("database-copy", staged); // its logical size: the only count of it on win32 (io-written.ts)
    source.close();
    source = undefined;
    report("database-clean");
    // Every staged messages.db settles itself (SMOOTH-FTS-MERGE R6 section 3): the search index's deleted postings, the email
    // rows of a backup and every freed page leave the staged file before inspect, digest and publish. One VACUUM, always.
    let setAside: SetAsideRow[] = [], memoryRows: string[] = [];
    // The Inbox projection's triggers are the one kind whose text the inspection never compares (derived data, which a restore
    // discards before anything runs): they leave every staged copy before its first delete (search intents, set-aside rows, index
    // orphans, email rows), exactly as a restore removes them, so a delete fires only triggers whose text the inspection holds to
    // this build's own, and no row the backup's list does not name can leave with it.
    if (component === "messages.db") settleFtsCopy(staged, { check: false, beforeAny: discardInboxProjection, beforeIndex: db => {
      // the first inspection stopped at the memory proof, before it read a conversation row: the rows are read here in that case too
      if (rowRefusal || memoryAside) {
        try {
          if (memoryAside) memoryRows = setAsideUnprovenMemoryRows(db);
          setAside = setAsideUnreadableRows(db);
        } catch (error) { throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError(rowRefusal ?? "DATABASE_SCHEMA_UNSUPPORTED", { cause: error }); }
      }
    }, beforeVacuum: db => {
      sanitizeStagedEmailRows(db); sanitizeOwnWriteHoldsForRestore(db); sanitizeStagedRestoreMarks(db); sanitizeStagedFolderTrustActivity(db); } });
    report("database-verify");
    const copied = new DatabaseSync(staged, { readOnly: true, timeout: 1000 });
    let counts;
    try { counts = inspect(copied); }
    finally { copied.close(); }
    report("source-recheck");
    assertOriginals();
    report("database-digest");
    const sha256 = digestFile(staged);
    const bytes = statSync(staged).size;
    const flush = openSync(staged, "r+"); // Windows FlushFileBuffers requires a writable handle.
    try { fsyncSync(flush); } finally { closeSync(flush); }
    publishNoReplace(staged, target);
    return { status: "copied" as const, ...counts, bytes, sha256, ...(setAside.length ? { setAside } : {}), ...(memoryRows.length ? { memoryAside: memoryRows } : {}) };
  } catch (error) {
    if (error instanceof InstallationSnapshotError) throw error;
    // SQLite says a full disk its own way (errcode 13), and the copy of the file itself says ENOSPC.
    if (isDiskFullError(error) || isNoSpaceError(error)) throw new InstallationSnapshotError("BACKUP_DISK_FULL", { cause: error });
    throw new InstallationSnapshotError((error as NodeJS.ErrnoException).code === "EEXIST" ? "DESTINATION_EXISTS" : "DATABASE_SNAPSHOT_FAILED");
  } finally {
    try { source?.close(); }
    finally {
      for(const held of originals)closeSync(held.fd);
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}

/** Bot email (BOT-EMAIL-MURAGE-109 section 7): mail bodies, frozen send payloads and inbound events never leave in a backup. After the
 * copy and before `inspect`, every row of email_payloads and email_events is deleted from the STAGED file (normal and fidelity archives
 * share this path) on the settle's own connection (settle-copy.ts: secure_delete on, then its one VACUUM), so no freed page keeps the
 * bytes. The tables stay (registered app tables, schema validation unchanged); bindings and send receipts are carried so a restored
 * install can reconcile. Email send cards in the transcript keep their header lines (To, Cc, Subject, contacts) but lose the mail text:
 * the subtitle is cut at its first blank line (the body follows it) and the draft text is emptied, the same view a restored card shows
 * once its payload is gone (Astra r2 Medium). A database without the tables (email never on) is not touched. */
export function sanitizeStagedEmailRows(db: DatabaseSync): { payloads: number; events: number; cards: number } {
  const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  assertBackupEmailActions(db);
  const hasCards = has("messages") && Boolean(db.prepare(`SELECT 1 FROM messages WHERE instr(json,'"emailSend"')>0 AND CASE WHEN json_valid(json) THEN json_type(json,'$.card.emailSend') END IS NOT NULL LIMIT 1`).get());
  if (!has("email_payloads") && !has("email_events") && !hasCards) return { payloads: 0, events: 0, cards: 0 };
  const payloads = has("email_payloads") ? Number(db.prepare("DELETE FROM email_payloads").run().changes) : 0;
  const events = has("email_events") ? Number(db.prepare("DELETE FROM email_events").run().changes) : 0;
  // a row with damaged JSON is left as it is (json_valid first): sanitizing never fails a backup over one bad row
  cancelOpenRecords(db, "Cancelled (backup)");
  const subtitle = "json_extract(json,'$.card.subtitle')";
  const cards = has("messages") ? Number(db.prepare(
    `UPDATE messages SET json=json_remove(CASE WHEN json_extract(json,'$.card.approvalId') IS NULL AND json_type(json,'$.card.emailSend.draft.text') IS NOT NULL THEN json_set(json, '$.card.subtitle', CASE WHEN instr(${subtitle}, char(10)||char(10))>0 THEN substr(${subtitle}, 1, instr(${subtitle}, char(10)||char(10))-1) ELSE '' END, '$.card.emailSend.draft.text', '') ELSE json_set(json, '$.card.subtitle', CASE WHEN instr(${subtitle}, char(10)||char(10))>0 THEN substr(${subtitle}, 1, instr(${subtitle}, char(10)||char(10))-1) ELSE '' END) END,'$.card.detail') ` +
    `WHERE instr(json, '"emailSend"')>0 AND (CASE WHEN json_valid(json) THEN json_type(json,'$.card.emailSend') END) IS NOT NULL`,
  ).run().changes) : 0;
  refreshBackupEmailPresentations(db);
  return { payloads, events, cards };
}

/** The restore job's marks (swapped, prepared, blind) say where THIS installation's own restore stands; boot recovery reads them to finish or clear it.
 * Carried into a backup they would travel into another installation's restore, where a stale "swapped" or "prepared" could steer recovery of a
 * job that never ran there. They are dropped from the STAGED file only (the live source keeps them), on the settle's own connection so the VACUUM
 * after it leaves no old page content. A database without the table (no owner restore yet) is not touched. */
export function sanitizeStagedRestoreMarks(db: DatabaseSync): void {
  // Durable replay is a receipt for this live native incarnation. A provider's
  // context can advance after a snapshot, so a restored copy must rebuild it.
  // Exclusions and epochs remain intact; only these positive stamps are reset.
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='send_replay_sessions'").get())
    db.exec("DELETE FROM send_replay_sessions");
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='send_replay_session_nodes'").get())
    db.exec("DELETE FROM send_replay_session_nodes");
  db.exec("DROP TABLE IF EXISTS restore_boot_wait");
  db.exec("DROP TABLE IF EXISTS restore_job_marks");
}

/** Folder-trust activity (MAIN ruling 1.0.21 fuigo-trust Q36/Q44) is left out of every backup format: the latest observation, its
 * instance, generation and destination, and the once-only notice claim stay on this installation only. Dropped from the STAGED file on
 * the settle's own connection, before its VACUUM, so no freed page keeps the rows; the live source keeps them. A restored install has
 * no row, so the notice may show once more (it errs toward disclosure). Restore preparation drops the table too (restore-prep-core.ts). */
export function sanitizeStagedFolderTrustActivity(db: DatabaseSync): void {
  db.exec("DROP TABLE IF EXISTS thread_folder_trust_activity");
}

function snapshotDatabaseWhileOwned(dataDir: string, destination: string, onProgress?: BackupProgressReport) {
  return snapshotSqliteWhileOwned(dataDir, destination, "messages.db", inspectInstallationDatabase, onProgress);
}
// Preserve the projection in encrypted fidelity only. It is never activated or
// migrated during restore; durable memory authority is already in messages.db.
function snapshotMemoryIndexWhileOwned(dataDir: string, destination: string) {
  return snapshotSqliteWhileOwned(dataDir, destination, "memory-index.db", db => {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
    return {};
  });
}

// The connected-app operation ledger (connected-app-journal.ts) keeps records
// of actions whose outcome is not known, so equivalent requests stay blocked
// until the bot checks the app. Those records matter on a restored computer
// too: the remote action happened whatever machine asks next.
function snapshotConnectedLedgerWhileOwned(dataDir: string, destination: string) {
  return snapshotSqliteWhileOwned(dataDir, destination, "connected-app-ledger.db", db => {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
    return {};
  });
}

// Bot phone calls (BOT-CALLS-1020): the owner's call history and caller settings travel with a backup, so a restore never loses them.
function snapshotPhoneCallsWhileOwned(dataDir: string, destination: string) {
  return snapshotSqliteWhileOwned(dataDir, destination, "phone-calls.db", db => {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
    return {};
  });
}

/** A channel delivery store (`channels/<adapter>/.../delivery-ledger.db`) copied through the same staged procedure, then every row parsed with the element schemas.
 * The caller owns the data-directory lease (the downgrade holds it; the backup walk holds it through withOfflineInstallation). The source is never opened. */
export function snapshotChannelLedgerWhileOwned(dataDir: string, relative: string, destination: string) {
  if (!/^channels(\/[^/\\\0]+)+\/delivery-ledger\.db$/.test(relative) || relative.split("/").includes("..")) throw new InstallationSnapshotError("INVALID_DESTINATION");
  return snapshotSqliteWhileOwned(dataDir, destination, "delivery-ledger.db", db => {
    const rows = db.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== "ok") throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED");
    try { assertLedgerStoreReadable(db); } catch { throw new InstallationSnapshotError("DATABASE_INTEGRITY_FAILED"); }
    return {};
  }, undefined, relative);
}

export interface OfflineInstallation {
  readonly dataDir: string;
  snapshotPhoneCalls(destination: string): Promise<Awaited<ReturnType<typeof snapshotPhoneCallsWhileOwned>>>;
  snapshotConnectedLedger(destination: string): Promise<Awaited<ReturnType<typeof snapshotConnectedLedgerWhileOwned>>>;
  snapshotDatabase(destination: string, onProgress?: BackupProgressReport): Promise<Awaited<ReturnType<typeof snapshotDatabaseWhileOwned>>>;
  snapshotMemoryIndex(destination: string): Promise<Awaited<ReturnType<typeof snapshotMemoryIndexWhileOwned>>>;
  snapshotChannelLedger(relative: string, destination: string): Promise<Awaited<ReturnType<typeof snapshotChannelLedgerWhileOwned>>>;
}

/** Keep one ownership epoch around every component of an installation copy.
 * Escaped callbacks are rejected after release. A caller that forgets to await
 * a database copy still cannot release the lease while SQLite is writing. */
export async function withOfflineInstallation<T>(dataDir: string, operation: (installation: OfflineInstallation) => Promise<T>): Promise<T> {
  // Deferred (coalesced) store writes reach disk before any copy is taken.
  flushCoalesced();
  const root = dataDirLeasePaths(dataDir).canonicalDataDir;
  const lease = acquireDataDirLeaseForProcess(root);
  let active = true;
  const pending = new Set<Promise<unknown>>();
  try {
    return await operation(Object.freeze({
      dataDir: root,
      snapshotDatabase(destination: string, onProgress?: BackupProgressReport) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotDatabaseWhileOwned(root, destination, onProgress);
        pending.add(result);
        // Attach a rejection handler without manufacturing an unhandled
        // finally() branch if an operation abandons its copy promise.
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      snapshotConnectedLedger(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotConnectedLedgerWhileOwned(root, destination);
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      snapshotPhoneCalls(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotPhoneCallsWhileOwned(root, destination);
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      snapshotMemoryIndex(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotMemoryIndexWhileOwned(root, destination);
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
      snapshotChannelLedger(relative: string, destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotChannelLedgerWhileOwned(root, relative, destination);
        pending.add(result);
        void result.then(() => pending.delete(result), () => pending.delete(result));
        return result;
      },
    }));
  } finally {
    active = false;
    try { await Promise.allSettled([...pending]); }
    finally { lease.release(); }
  }
}

export async function snapshotInstallationDatabase(dataDir: string, destination: string) {
  return withOfflineInstallation(dataDir, installation => installation.snapshotDatabase(destination));
}
