import { ensureForgetTable } from "./harness/event-log.ts";
import { ensureScrubPassTable } from "./memory/scrub-state.ts";
import { initializeTeamIdentityTables } from "./team-identities.ts";
import { initializeThreadSnooze } from "./thread-snooze.ts";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { publishNoReplace } from "./publish-file.ts";
import { acquireDataDirLeaseForProcess, dataDirLeasePaths } from "../electron/data-dir-lease.mjs";
import { validateMemorySchema } from "./memory/schema.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { initializeArtifacts } from "./artifacts.ts";
import { discardInboxProjection, initializeInbox, isInboxProjectionObject } from "./inbox.ts";
import { LEGACY_OWED_TABLE_DDL, LEGACY_SHARED_OWED_INDEX, LEGACY_SHARED_OWED_INDEX_DDL } from "./room-request-owed.ts";
import { ensureBrowserCheckIndex, initializeMessageTables } from "./message-tables.ts";
import { initializeImageLibrary, initializeImageOperations } from "./image-operations-schema.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { initializeMobilePush } from "./mobile-push-store.ts";
import { initializeSharedRequestProvenance } from "./shared-provenance-schema.ts";
import { initializePendingDelegations } from "./pending-delegations-schema.ts";
import { initializeProjectCardDelivery } from "./project-card-delivery-schema.ts";
import { initializeOwnerSends } from "./send-store.ts";
import { initializeBotCalls } from "./bot-calls-schema.ts";
import { initializeTurnSourceHolds } from "./turn-source-holds.ts";
import { initializeEmailTables } from "./email/email-store.ts";

import { ensureIntegrityPassTable } from "./memory/integrity-state.ts";
import { LEGACY_UPGRADE_TABLES, ensureUpgradeAppTables } from "./memory/upgrade-app-tables.ts";
import { InstallationSnapshotError } from "./installation-snapshot-error.ts";
import { flushCoalesced } from "./atomic.ts";
import { initializeAskRevocations } from "./phones/ask-revocations.ts";
import { initializePhoneReceipts } from "./phones/receipts.ts";
import { initializePhones } from "./phones/registry.ts";
import { ADDED_TABLE_LIFECYCLE } from "./added-table-lifecycle.ts";
import { APP_SCHEMA_102_ADDITIONS } from "./installation-app-schema-downgrade.ts";
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
  // seq: the per-thread sequence (transcript-seq.ts), new in 1.0.3; an archive from before it lacks the column and its index
  messages: { required: true, optional: ["seq"] },
  thread_state: { required: true, optional: [] },
  open_card: { required: false, optional: [] },
  turn_first: { required: false, optional: [] },
  transcript_index_state: { required: false, optional: [] },
  // pending "Checking the browser" notes, kept by the message writers and filled in the background (message-tables.ts), new in 1.0.2
  browser_check_pending: { required: false, optional: [] },
  // the Flux Memory number hold of a thread (server/flux-capture-hold.ts, message-tables.ts), new in 1.0.4
  flux_capture_hold: { required: false, optional: [] },
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
  room_requests: { required: false, optional: ["handoff", "shared_work"] },
  // every owner send, committed before it is acknowledged (server/send-store.ts), new in 1.0.2;
  // notice (the code of what the person was told) was appended by ALTER during 1.0.2, and so was turn_id (the turn a steer went into); via, queue_only, via_device and attachments (a phone's share or ask line) were appended in 1.0.9
  owner_sends: { required: false, optional: ["notice", "restore_held", "restore_gen", "stopped", "stop_gen", "action_id", "turn_id", "via", "queue_only", "via_device", "attachments"] },
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

function columnShape(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_xinfo("${table}")`).all()
    .map(column => `${column.name}:${String(column.type).toUpperCase()}:${column.notnull}:${column.dflt_value}:${column.pk}:${column.hidden}`);
}

let reference: Map<string, ReferenceObject> | undefined;
/** APP_TABLES plus every table of APP_SCHEMA_102_ADDITIONS the initializers create: one list for what the downgrade drops and what a snapshot accepts. */
let registeredTables: Map<string, { required: boolean; optional: string[] }> = APP_TABLES;
function appTables() { referenceSchema(); return registeredTables; }
/** The definitions the harness's own initializers create, read back from a
 * fresh in-memory database rather than copied by hand, so an index or table
 * the app changes is compared against what the app now writes. */
function referenceSchema(): Map<string, ReferenceObject> {
  if (reference) return reference;
  const db = new DatabaseSync(":memory:");
  try {
    initializeMessageTables(db); initializeTurnSourceHolds(db); ensureBrowserCheckIndex(db); ensureIntegrityPassTable(db); ensureScrubPassTable(db); ensureUpgradeAppTables(db); initializeInbox(db); initializeArtifacts(db);
    for (const { schema } of LEGACY_UPGRADE_TABLES.values()) db.exec(schema);
    initializeImageOperations(db); initializeImageLibrary(db); initializeThreadSnooze(db); initializeProjectTables(db); ensureForgetTable(db); initializeTeamIdentityTables(db); initializeMobilePush(db); initializeSharedRequestProvenance(db); initializeProjectCardDelivery(db); initializePhones(db); initializeAskRevocations(db); initializePhoneReceipts(db); initializeOwnerSends(db); initializePendingDelegations(db); initializeBotCalls(db); initializeEmailTables(db);
    const objects = new Map<string, ReferenceObject>();
    const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema").all() as SchemaRow[];
    const tables = new Map(APP_TABLES);
    for (const name of APP_SCHEMA_102_ADDITIONS.tables) if (!tables.has(name) && rows.some(row => row.type === "table" && row.name === name)) tables.set(name, { required: false, optional: [] });
    for (const row of rows) {
      if (!tables.has(row.tbl_name)) throw new Error(`initializer created an object outside APP_TABLES: ${row.name}`);
      objects.set(row.name, { type: row.type, table: row.tbl_name, sql: new Set([normalizedSql(row.sql)]), columns: row.type === "table" ? [columnShape(db, row.name)] : [] });
    }
    // The Inbox projection's triggers read inbox_item_state.cleared_at, so they
    // would refuse the column drops below; they are recorded already, and an
    // archive old enough to lack the column predates the projection too.
    discardInboxProjection(db);
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
    reference = objects;
    registeredTables = tables;
    return objects;
  } finally { db.close(); }
}

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
    graph.add(JSON.parse(row.json as string));
  }
  graph.validate();
  return {
    messages: count(db, "SELECT COUNT(*) AS count FROM messages"),
    threads: count(db, "SELECT COUNT(*) AS count FROM thread_state"),
  };
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
async function snapshotSqliteWhileOwned<T extends object>(dataDir: string, destination: string, component: "messages.db" | "memory-index.db" | "connected-app-ledger.db", inspect: (db: DatabaseSync) => T) {
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
    const file = join(root, component);
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
    scratch = mkdtempSync(join(dirname(target), ".murage-database-snapshot-"));
    const inputDirectory=join(scratch,"source");mkdirSync(inputDirectory,{mode:0o700});
    for(const held of originals){
      const output=held.suffix==="-shm"?undefined:openSync(join(inputDirectory,component+held.suffix),"wx",0o600);
      try{
        const hash=createHash("sha256"),buffer=Buffer.alloc(64*1024);let offset=0;
        for(;;){
          const size=readSync(held.fd,buffer,0,buffer.length,offset);if(!size)break;
          hash.update(buffer.subarray(0,size));
          if(output!==undefined){let written=0;while(written<size)written+=writeSync(output,buffer,written,size-written);}
          offset+=size;
        }
        held.sha256=hash.digest("hex");
        if(offset!==held.identity.size)throw new InstallationSnapshotError("SOURCE_CHANGED");
        if(output!==undefined)fsyncSync(output);
      }finally{if(output!==undefined)closeSync(output);}
    }
    assertOriginals();
    const staged = join(scratch, component);
    const fd = openSync(staged, "wx", 0o600);closeSync(fd);
    source = new DatabaseSync(join(inputDirectory,component), { readOnly: true, timeout: 1000 });
    inspect(source);
    await backup(source, staged, { rate: 128 });
    source.close();
    source = undefined;
    if (component === "messages.db") sanitizeStagedEmail(staged);
    const copied = new DatabaseSync(staged, { readOnly: true, timeout: 1000 });
    let counts;
    try { counts = inspect(copied); }
    finally { copied.close(); }
    assertOriginals();
    const sha256 = digestFile(staged);
    const bytes = statSync(staged).size;
    const flush = openSync(staged, "r+"); // Windows FlushFileBuffers requires a writable handle.
    try { fsyncSync(flush); } finally { closeSync(flush); }
    publishNoReplace(staged, target);
    return { status: "copied" as const, ...counts, bytes, sha256 };
  } catch (error) {
    throw error instanceof InstallationSnapshotError ? error : new InstallationSnapshotError(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "DESTINATION_EXISTS" : "DATABASE_SNAPSHOT_FAILED",
    );
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
 * share this path) with secure_delete on and a VACUUM, so no freed page keeps the bytes. The tables stay (registered app tables, schema
 * validation unchanged); bindings and send receipts are carried so a restored install can reconcile. Email send cards in the transcript
 * keep their header lines (To, Cc, Subject, contacts) but lose the mail text: the subtitle is cut at its first blank line (the body
 * follows it) and the draft text is emptied, the same view a restored card shows once its payload is gone (Astra r2 Medium). A database
 * without the tables (email never on) is not touched. */
export function sanitizeStagedEmail(path: string): { payloads: number; events: number; cards: number } {
  const db = new DatabaseSync(path);
  try {
    const has = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    if (!has("email_payloads") && !has("email_events")) return { payloads: 0, events: 0, cards: 0 };
    db.exec("PRAGMA secure_delete=ON");
    const payloads = has("email_payloads") ? Number(db.prepare("DELETE FROM email_payloads").run().changes) : 0;
    const events = has("email_events") ? Number(db.prepare("DELETE FROM email_events").run().changes) : 0;
    // a row with damaged JSON is left as it is (json_valid first): sanitizing never fails a backup over one bad row
    const subtitle = "json_extract(json,'$.card.subtitle')";
    const cards = has("messages") ? Number(db.prepare(
      `UPDATE messages SET json=json_set(json, '$.card.subtitle', CASE WHEN instr(${subtitle}, char(10)||char(10))>0 THEN substr(${subtitle}, 1, instr(${subtitle}, char(10)||char(10))-1) ELSE '' END, '$.card.emailSend.draft.text', '') ` +
      `WHERE instr(json, '"emailSend"')>0 AND (CASE WHEN json_valid(json) THEN json_extract(json,'$.card.kind') END)='email-send'`,
    ).run().changes) : 0;
    db.exec("VACUUM");
    return { payloads, events, cards };
  } finally { db.close(); }
}

function snapshotDatabaseWhileOwned(dataDir: string, destination: string) {
  return snapshotSqliteWhileOwned(dataDir, destination, "messages.db", inspectInstallationDatabase);
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

export interface OfflineInstallation {
  readonly dataDir: string;
  snapshotConnectedLedger(destination: string): Promise<Awaited<ReturnType<typeof snapshotConnectedLedgerWhileOwned>>>;
  snapshotDatabase(destination: string): Promise<Awaited<ReturnType<typeof snapshotDatabaseWhileOwned>>>;
  snapshotMemoryIndex(destination: string): Promise<Awaited<ReturnType<typeof snapshotMemoryIndexWhileOwned>>>;
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
      snapshotDatabase(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotDatabaseWhileOwned(root, destination);
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
      snapshotMemoryIndex(destination: string) {
        if (!active) return Promise.reject(new InstallationSnapshotError("SNAPSHOT_EPOCH_CLOSED"));
        const result = snapshotMemoryIndexWhileOwned(root, destination);
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
