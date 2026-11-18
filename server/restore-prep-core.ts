import { cancelOpenRecords } from "./decision/records.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The restore preparation core, shared by the desktop restore (prepareInstallationRestore, profile "archive", a private staging copy)
// and a Cloud reset or undo (consumeRestoreMarker at boot, profile "same-home", the home's own data folder). CLOUD-RESET-PREP design
// r1 section 2A: this code was moved out of installation-restore-preparation.ts without changing what a desktop restore does or the
// order it does it in (the R1 golden in installation-restore-preparation.test.ts pins that).
//
// What profile "same-home" skips, and nothing else (decision D2): the reserved bot id refusal, the managed-desk cwd drop and the
// browser transport drop (all three are about a stranger's archive landing on another computer), the integrity proof (nothing
// proved the rows). The config.json rewrite, the review marker and the search-index settle are not in this file at all: they stay in
// the desktop caller, so a same-home run cannot reach them.
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BotTurnState, type CheckpointBot } from "./bot-turn-state.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { InstallationTranscriptGraph } from "./installation-transcript-graph.ts";
import { assertInstallationRecords } from "./installation-record-validation.ts";
import { isReservedBotId } from "../shared/bot-identity.ts";
import { foldRoutineStateForDowngrade, mapRoutineRuns, routinesCommit } from "./routine-runs-journal.ts";
import { fenceRestoredContinuations, fenceRestoredSql } from "./restore-fence.ts";
import { prepareRestoredOwnerState } from "./restore-owner-state.ts";
import { repairRestoredSharing, validateSharingPaused, validateSharingStructure } from "./sharing-restore.ts";
import { resetThreadSummaries, remintChatsGen } from "./thread-summary.ts";
import { endAllLivePairedRequests } from "./handoff-pair.ts";
import { reconcileTeamJournalFiles } from "./team-lifecycle.ts";
import type { BotRecord, GroupRecord, Message } from "./store.ts";
import { rowToMessage, storedJson } from "./transcript-seq.ts";
import { migrateMemorySchema } from "./memory/schema.ts";
import { markIntegrityPassProven } from "./memory/integrity-state.ts";
import { prepareProjectTablesForRestore } from "./project-tables.ts";
import { pauseRestoredMemory } from "./memory/restore.ts";
import { discardInboxProjection } from "./inbox.ts";
import { bumpWriteEpoch } from "./app-write-revision.ts";
import { neutralizeRestoredSends } from "./send-store.ts";
import { prepareRestoredEmail } from "./email/restore.ts";
import { queuedDelegationsByThread } from "./pending-delegations-schema.ts";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type RecordValue = Record<string, unknown>;
export const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
export function restoreFail(code: string): never { throw new InstallationSnapshotError(code); }
export const isRestoreId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,160}$/.test(value);
export const MAX_JSON_BYTES = 64 * 1024 ** 2;
const terminal = new Set(["completed", "failed", "cancelled", "missed", "blocked", "limit"]);

/** "archive": a private staging copy of an archive from anywhere (desktop restore). "same-home": the running home's own folder (Cloud). */
/** Where the handoffs that were queued in messages.db are kept as evidence, beside the quarantined delegations.json. */
export const RESTORE_HANDOFF_TABLE_EVIDENCE = "delegations-table.json";
export type RestoreProfile = "archive" | "same-home";
/** F5 (MurageMain ruling): a same-home reset or undo keeps each bot's browser and useMyChrome (the same machine with the same browser);
 * computer use and autoStartVps still turn off. A desktop restore ("archive") always turns both off: it lands on a different machine. */
export const SAME_HOME_KEEPS_BROWSER = true;
export type RestoreNote = { component: string; action: string };

/** What the core reads and writes. `state` is the data folder the paths are relative to; `files` is the stored component list. */
export interface RestoreIo {
  state: string;
  files: Set<string>;
  /** Parsed JSON of a stored path, undefined when it is not stored. Refuses a component over MAX_JSON_BYTES or invalid JSON. */
  read(path: string): unknown;
  write(path: string, value: unknown): void;
  /** Moves a stored path into the quarantine folder (never overwriting). Called only for a path in `files`. */
  quarantine(path: string): void;
}
export interface RestorePrepOptions {
  /** One token for this restore: every held row, JSON or SQL, carries it. */
  generation: string;
  profile: RestoreProfile;
  /** Names the recovery-quarantine/<id> folder the handoff evidence goes to. */
  quarantineId: string;
  /** Review notes are appended here. */
  modifications: RestoreNote[];
  /** Paths moved to quarantine are appended here. */
  quarantined: string[];
  /** Runs between the record validation and the roster steps: the desktop restore rewrites config.json there (kept in its original order). */
  afterValidate?: () => void;
}
export interface RestoreDbOptions {
  generation: string;
  profile: RestoreProfile;
  quarantineId: string;
  modifications: RestoreNote[];
  state: string;
  files: Set<string>;
  sharingBots: Record<string, unknown>[];
  sharingGroups: Record<string, unknown>[];
  botIds: Set<string>;
  /** Persists the repaired sharing rosters (atomically). Runs inside the transaction after the last database step and before beforeCommit,
   * so a crash after COMMIT can never leave the database prepared with the old roster files on disk (Astra A-H3). */
  persistRosters: () => void;
  /** Runs inside the transaction after persistRosters, before COMMIT (the Cloud consumer drops its marker here). */
  beforeCommit?: (db: DatabaseSync) => void;
}

/** Atomic JSON write: a temp file in the same folder, flushed, then renamed over the target, so a crash leaves the old file or the new one, never a torn one. */
export function writeRestoreJsonAtomic(absolute: string, value: unknown): void {
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  const temp = `${absolute}.restore-tmp`;
  try { writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600, flush: true }); renameSync(temp, absolute); }
  catch (error) { try { rmSync(temp, { force: true }); } catch { /* nothing to clean */ } throw error; }
}

/** The size-checked JSON reader both callers use. */
export function readRestoreJson(state: string, files: Set<string>, path: string): unknown {
  if (!files.has(path)) return undefined;
  const absolute = join(state, ...path.split("/"));
  if (lstatSync(absolute).size > MAX_JSON_BYTES) restoreFail("RESTORE_COMPONENT_TOO_LARGE");
  try { return JSON.parse(readFileSync(absolute, "utf8")); }
  catch { restoreFail("INVALID_RESTORE_COMPONENT"); }
}

/** Whether a path is the app-made working folder `workspaces/<bot>/threads/<thread>` of some data directory. */
function isManagedDesk(path: string, botId: string, threadId: string): boolean {
  const normal = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const tail = `workspaces/${botId}/threads/${threadId}`;
  return normal === tail || normal.endsWith(`/${tail}`);
}

/** One stored message after a restore: waiting cards expire, goal runs block, queued is off. */
export function expireRestoredMessage(value: unknown): RecordValue {
  if (!isRecord(value) || !isRestoreId(value.id) || !["bot", "user"].includes(String(value.role)) || typeof value.kind !== "string" || typeof value.at !== "number") restoreFail("INVALID_RESTORE_MESSAGE");
  const message = { ...value };
  if (isRecord(message.card) && !message.card.answered && (message.card.requestId || message.card.routineRequest || message.card.skillRequest)) {
    message.card = { ...message.card, answered: "Expired after restore", dismissed: true };
  }
  // A Murage for Chrome setup card would continue the owner's old request
  // on the next settled turn; it expires like any other waiting card.
  if (isRecord(message.card) && isRecord(message.card.browserSetup) && message.card.browserSetup.resumed !== true) {
    // Keep restored action fields frozen; retire their presentation using terminal fields.
    message.card = { ...message.card, answered: message.card.answered || "Expired after restore", dismissed: true,
      orphaned: true, detail: "This was waiting when the backup was made. Ask again." };
  }
  for (const key of ["connector", "mcpSignIn", "secret"]) if (isRecord(message[key])) message[key] = { ...message[key], dismissed: true, resumed: false };
  if (isRecord(message.goalRun) && message.goalRun.status === "working") message.goalRun = { ...message.goalRun, status: "blocked", detail: "Restored work requires outcome review before a fresh run" };
  if (message.queued === true) message.queued = false;
  return message;
}

/** Steps 2 and 4-10 of the design table: record validation, bots and groups, routines, calendar, webhooks, quarantined queues, skills,
 * legacy transcripts, sharing repair. Every step tolerates an absent file. */
export function prepareRestoredRecords(io: RestoreIo, opts: RestorePrepOptions): { sharingBots: Record<string, unknown>[]; sharingGroups: Record<string, unknown>[]; botIds: Set<string> } {
  const { files, read, write, state } = io;
  const { modifications, generation } = opts;
  const archive = opts.profile === "archive";
  const object = isRecord, id = isRestoreId;
  const fail: (code: string) => never = restoreFail;
  const quarantine = (path: string) => {
    if (!files.has(path)) return;
    io.quarantine(path);
    opts.quarantined.push(path);
  };
  let heldContinuations = 0;
  for (const path of ["routines.json", "calendar-calls.json", "webhooks.json", "delegation-receipts.json", "section-contexts.json"]) {
    if (files.has(path)) assertInstallationRecords(path, read(path));
  }
  opts.afterValidate?.();
  const ownership = new Map<string, string>();
  const botIds = new Set<string>();
  let messageAllowReset = false;
  let prospectLearningReset = false;
  let imageApprovalReset = false;
  for (const path of ["bots.json", "groups.json"]) {
    const storedRecords = read(path);
    if (storedRecords === undefined) continue;
    if (!Array.isArray(storedRecords)) fail("INVALID_RESTORE_ROSTER");
    let records: unknown[] = storedRecords as unknown[];
    if(path === "bots.json" && records.every(value=>object(value)&&id(value.id)&&id(value.threadId)
      && (value.tasks===undefined||Array.isArray(value.tasks)&&value.tasks.every(task=>object(task)&&id(task.threadId))))) {
      records=structuredClone(records);
      // Fold the exact durable view before clearing sessions, for both archives and same-home resets.
      // Rewritten rosters lose their checkpoint base, so retained deltas can never undo the scrub at boot.
      new BotTurnState(state).load(records as CheckpointBot[],absolute=>read(relative(state,absolute).split(sep).join("/")));
    }
    const ids = new Set<string>();
    const prepared = records.map(value => {
      if (!object(value) || !id(value.id) || !id(value.threadId) || ids.has(value.id)) fail("INVALID_RESTORE_ROSTER");
      // The Cloud home's own browser check lives under this prefix; no restored bot or group may name it. (An archive only: the home's own roster holds it.)
      if (archive && isReservedBotId(value.id)) fail("RESERVED_RESTORE_ID");
      ids.add(value.id);
      if (path === "bots.json") botIds.add(value.id);
      const owner = `${path}:${value.id}`;
      const claim = (thread: unknown) => {
        if (!id(thread) || (ownership.has(thread) && ownership.get(thread) !== owner)) fail("DUPLICATE_RESTORE_THREAD");
        ownership.set(thread, owner);
      };
      claim(value.threadId);
      const record = { ...value };
      if (value.tasks !== undefined) {
        if (!Array.isArray(value.tasks)) fail("INVALID_RESTORE_ROSTER");
        const seen = new Set<string>();
        record.tasks = value.tasks.map(task => {
          if (!object(task) || !id(task.threadId) || seen.has(task.threadId)) fail("INVALID_RESTORE_ROSTER");
          seen.add(task.threadId); claim(task.threadId);
          const copy = { ...task, autoApprove: false, alwaysAllow: [], resumeCursors: {} };
          delete (copy as RecordValue).lastInstanceId;
          delete (copy as RecordValue).resumeSeals;
          delete (copy as RecordValue).resumePolicies;
          delete (copy as RecordValue).replayPending;
          // The bot's own working folder for this conversation names the old installation's data directory: the next turn pins this one's.
          // (An archive only: on the same home the folder is this home's own.)
          const deskPath = (task as RecordValue).cwd;
          if (archive && path === "bots.json" && typeof deskPath === "string" && isManagedDesk(deskPath, String(value.id), String(task.threadId))) delete (copy as RecordValue).cwd;
          return copy;
        });
      }
      delete record.lastInstanceId;
      if (path === "bots.json") {
        Object.assign(record, { busy: false, activity: "idle", autoApprove: false, autoReview: "off", alwaysAllow: [], approvePeerComms: true, computer: "off", autoStartVps: false, ...(archive || !SAME_HOME_KEEPS_BROWSER ? { browser: false, useMyChrome: false } : {}), composio: false, speakReplies: false, resumeCursors: {}, rewound: true });
        delete record.resumePolicies; delete record.replayPending;
        // The owner's browser connection belongs to the old computer's
        // browser and extension profile; it is chosen again (plan 4.3).
        // (An archive only: on the same home the connection is this home's own.)
        if (archive) { delete record.browserTransport; delete record.browserExtensionProfileId; delete record.browserExtensionBrowser; }
        // Full permissive never comes back from a backup: the owner turns it on again, here, by typing the name.
        // The checker choice (browserActionCheck) is a preference, not authority, and is kept.
        delete record.browserApproval;
        // "Make images without asking" is spend authority the old computer
        // granted: a restored bot asks again until the owner chooses it here.
        // "Ask before each image" and the guard only ever ask more, so they stay.
        if (record.imageApproval === "allow") { delete record.imageApproval; imageApprovalReset = true; }
        // "Who this bot can message" widens reach: an owner-only field that
        // never comes back from a backup (SPEC-P 3.12, contract 4.3).
        if (record.messageAllow !== undefined) { delete record.messageAllow; messageAllowReset = true; }
        // Learning from customer and audience messages is an opt-in grant (design 11): a restore brings back no grants.
        if (object(record.learning) && (record.learning.prospectLearning === true || (Array.isArray(record.learning.prospectThreadIds) && record.learning.prospectThreadIds.length))) {
          record.learning = { ...record.learning, prospectLearning: false, prospectThreadIds: [] }; prospectLearningReset = true;
        }
      } else {
        if (!Array.isArray(value.memberIds) || value.memberIds.some(member => !id(member) || !botIds.has(member))) fail("INVALID_RESTORE_MEMBERSHIP");
        Object.assign(record, { working: false, busyBotId: null });
      }
      heldContinuations += fenceRestoredContinuations(record, generation);
      return record;
    });
    write(path, prepared);
    modifications.push({ component: path, action: "Preserved identities/tasks; cleared active sessions and automatic authority" });
    if (path === "bots.json" && !archive) modifications.push({ component: path, action: SAME_HOME_KEEPS_BROWSER ? "Kept: each bot's browser access. Turned off: computer use and starting a cloud computer automatically." : "Turned off: browser access, computer use and starting a cloud computer automatically." });
    if (path === "bots.json" && messageAllowReset) modifications.push({ component: path, action: "Who each bot can message was reset to its team." });
    if (path === "bots.json" && prospectLearningReset) modifications.push({ component: path, action: "Learning from customer and audience messages was turned off; choose it again if you want it." });
    if (path === "bots.json" && imageApprovalReset) modifications.push({ component: path, action: "Bots set to make images without asking now follow their permission level." });
  }
  if (heldContinuations > 0) modifications.push({ component: "bots.json/groups.json", action: `${heldContinuations} saved continuation${heldContinuations === 1 ? "" : "s"} kept on hold: authorize each one again to continue` });
  // Freeze journal definitions and receipt overlays before clearing restored grants.
  foldRoutineStateForDowngrade(join(state, "routines.json"));
  const routines = read("routines.json");
  if (routines !== undefined) {
    if (!object(routines) || routines.version !== 1 || !Array.isArray(routines.routines) || (routines.runs !== undefined && !Array.isArray(routines.runs))) fail("INVALID_RESTORE_ROUTINES");
    // The same policy as bots and tasks (audit A-06): a restored routine
    // follows its bot again (whose level is reset to Ask above) and keeps no
    // "Always allow for this routine" grants.
    routines.routines = routines.routines.map(value => {
      if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_ROUTINES");
      const copy: RecordValue = { ...value, enabled: false, alwaysAllow: [] };
      delete copy.permissionMode;
      return copy;
    });
    if (routines.runs !== undefined) routines.runs = routines.runs.map(value => {
      if (!object(value) || !id(value.id) || typeof value.status !== "string") fail("INVALID_RESTORE_ROUTINES");
      if (terminal.has(value.status)) return value;
      return { ...value, status: "cancelled", error: "Pending work suspended after restoration; review its outcome before starting new work", finishedAt: Date.now() };
    });
    write("routines.json", routines);
    mapRoutineRuns(state, value => terminal.has(String(value.status)) ? value
      : { ...value, status: "cancelled", error: "Pending work suspended after restoration; review its outcome before starting new work", finishedAt: Date.now() }, routinesCommit(routines));
    modifications.push({ component: "routines.json", action: "Routines paused; each follows its bot's approval level again, with no routine grants" });
  }
  const calls = read("calendar-calls.json");
  if (calls !== undefined) {
    if (!object(calls) || calls.version !== 1 || !Array.isArray(calls.calls)) fail("INVALID_RESTORE_CALENDAR");
    calls.calls = calls.calls.map(value => { if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_CALENDAR"); return { ...value, nextRunAt: null }; });
    write("calendar-calls.json", calls);
  }
  const webhooks = read("webhooks.json");
  if (webhooks !== undefined) {
    if (!object(webhooks) || webhooks.version !== 1 || !Array.isArray(webhooks.webhooks) || !Array.isArray(webhooks.deliveries)) fail("INVALID_RESTORE_WEBHOOKS");
    webhooks.webhooks = webhooks.webhooks.map(value => {
      if (!object(value) || !id(value.id)) fail("INVALID_RESTORE_WEBHOOKS");
      const copy = { ...value, enabled: false, verificationPending: true, secretHash: randomBytes(32).toString("hex") };
      delete (copy as RecordValue).secret;
      return copy;
    });
    write("webhooks.json", webhooks);
  }
  for (const path of ["delegations.json", "browser-cleanups.json"]) quarantine(path);
  for (const path of files) {
    if (/^skill-state\/[^/]+\/staged\.json$/.test(path)) quarantine(path);
    else if (/^skill-state\/[^/]+\/skills\.json$/.test(path)) {
      const manifest = read(path);
      if (!object(manifest)) fail("INVALID_RESTORE_SKILLS");
      for (const entry of Object.values(manifest)) { if (!object(entry)) fail("INVALID_RESTORE_SKILLS"); entry.enabled = false; }
      write(path, manifest);
    }
  }
  // messages-<thread>.json.imported is message-db.ts's record of a transcript already imported into messages.db: nothing reads
  // it again, so it is copied through as written (path and size checked like any component, never parsed, expired or imported).
  // Re-validating it refused whole restores: 1.0.2's lenient import accepted transcripts with duplicate ids.
  for (const path of files) if (/^messages-[\w-]+\.json\.imported$/.test(path)) {
    const stat = lstatSync(join(state, ...path.split("/")));
    if (!stat.isFile()) fail("INVALID_RESTORE_COMPONENT");
    if (stat.size > MAX_JSON_BYTES) fail("RESTORE_COMPONENT_TOO_LARGE");
  }
  for (const path of files) if (/^messages-[\w-]+\.json$/.test(path)) {
    const value = read(path);
    const graph = new InstallationTranscriptGraph(fail);
    const messages = Array.isArray(value) ? value : object(value) && Array.isArray(value.messages) ? value.messages : null;
    if (!messages) fail("INVALID_RESTORE_MESSAGE");
    for (const message of messages) graph.add(message);
    graph.validate(object(value) ? value.activeLeafId ?? null : null);
    if (Array.isArray(value)) write(path, value.map(expireRestoredMessage));
    else if (object(value) && Array.isArray(value.messages)) write(path, { ...value, messages: value.messages.map(expireRestoredMessage) });
    else fail("INVALID_RESTORE_MESSAGE");
  }
  // THRUST-BACKUP: box state and connected-app waits come back only in their fail-closed form (restore-owner-state.ts).
  prepareRestoredOwnerState({ state, files, write, quarantine: path => io.quarantine(path) }, modifications, opts.quarantined);
  const sharingBots = (read("bots.json") ?? []) as Record<string, unknown>[], sharingGroups = (read("groups.json") ?? []) as Record<string, unknown>[];
  modifications.push(...repairRestoredSharing(sharingBots, sharingGroups, Date.now()).map(action => ({ component: "bots.json/groups.json", action })));
  validateSharingStructure(sharingBots, sharingGroups);
  return { sharingBots, sharingGroups, botIds };
}

/** Steps 12-21 of the design table. The caller has already validated the database and, on desktop, written its review marker. This
 * function owns the one transaction: memory migration opens its own BEGIN IMMEDIATE, so steps 12-13 run first, outside it, exactly as
 * they always did; steps 14-21 then run in one BEGIN IMMEDIATE ... COMMIT, with `beforeCommit` inside it. A throw rolls back and rethrows. */
export function prepareRestoredDatabase(db: DatabaseSync, opts: RestoreDbOptions): void {
  const { modifications, generation, state, sharingBots, sharingGroups, botIds } = opts;
  remintChatsGen(db);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_meta'").get()) {
    migrateMemorySchema(db);
    // inspectInstallationDatabase proved every row in full before this, which only an archive restore has done
    if (opts.profile === "archive") markIntegrityPassProven(db);
  }
  bumpWriteEpoch(db); // a restored file is not the file any cached figure was counted from
  validateSharingStructure(sharingBots, sharingGroups, db);
  modifications.push(...reconcileTeamJournalFiles(state, db, sharingBots as unknown as BotRecord[], sharingGroups as unknown as GroupRecord[]).map(action => ({ component: "bots.json/groups.json", action })));
  validateSharingPaused(sharingBots, sharingGroups, db);
  db.exec("BEGIN IMMEDIATE");
  try {
    cancelOpenRecords(db, "Cancelled (restore)");
    db.exec("DROP TABLE IF EXISTS restore_boot_wait; DROP TABLE IF EXISTS restore_job_marks");
    // A-M2: a home whose database has no messages table yet (a fresh or marker-only file) has nothing to expire.
    const hasMessages = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    const update = hasMessages ? db.prepare("UPDATE messages SET json=? WHERE thread_id=? AND id=?") : undefined;
    if (hasMessages) for (const row of db.prepare("SELECT thread_id,id,json FROM messages").iterate()) {
      if (typeof row.json !== "string" || Buffer.byteLength(row.json) > MAX_JSON_BYTES) restoreFail("INVALID_RESTORE_MESSAGE");
      const before = rowToMessage({ json: row.json }); // U4 S3: the one decoder, and storedJson below the one encoder
      const after = expireRestoredMessage(before);
      if (after.id !== row.id) restoreFail("INVALID_RESTORE_MESSAGE");
      const encoded = storedJson(after as unknown as Message);
      if (encoded !== row.json) update!.run(encoded, row.thread_id, row.id);
    }
    // Retain current restore fencing: settled delegation loans do not survive a restore.
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='delegation_packs'").get()) db.exec("DELETE FROM delegation_packs");
    // Handoffs queued in the backup never run after a restore: kept as evidence beside the other quarantined files, then removed from the table.
    if (db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name='pending_delegations'").get()) {
      const evidence = queuedDelegationsByThread(db), queued = Object.values(evidence).flat();
      if (queued.length) {
        // A fixed name, never chosen by which files the archive held (Astra A-M1): the legacy file keeps delegations.json, the table never takes it.
        const destination = join(state, "recovery-quarantine", opts.quarantineId, RESTORE_HANDOFF_TABLE_EVIDENCE);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, JSON.stringify(evidence) + "\n", { mode: 0o600, flush: true });
        endAllLivePairedRequests(db, "restore-quarantine");   // a queued hand-off's request is not left live behind its removed row
        db.exec("DELETE FROM pending_delegations");
        modifications.push({ component: "messages.db", action: `${queued.length} queued handoff${queued.length === 1 ? "" : "s"} moved to recovery-quarantine; none runs after the restore` });
      }
    }
    modifications.push(...fenceRestoredSql(db, generation));
    modifications.push(...prepareProjectTablesForRestore(db, { groups: sharingGroups as Array<{ id: string; channelProject?: unknown }>, botIds, now: Date.now() }));
    const heldSends = neutralizeRestoredSends(db, generation);
    if (heldSends) modifications.push({ component: "messages.db", action: `${heldSends} message${heldSends === 1 ? "" : "s"} that were waiting to be sent were kept as "Send again" chips and will not run until you resend them` });
    // The Inbox projection is derived data from an untrusted archive: it is
    // emptied here and rebuilt from the restored messages on first open.
    discardInboxProjection(db);
    if (pauseRestoredMemory(db)) modifications.push({component:"messages.db",action:"Memory paused; worker leases and provider disclosures invalidated; indexes require rebuild"});
    // bot email (section 7): every binding waits for the owner's Reconnect; nothing polls, mounts or sends before it
    const emailBindings = prepareRestoredEmail(db);
    if (emailBindings) modifications.push({ component: "messages.db", action: `${emailBindings} bot email address${emailBindings === 1 ? "" : "es"} will reconnect when you choose Reconnect email` });
    resetThreadSummaries(db);
    // Rotate the search owner inside the candidate transaction, including our own older backups.
    db.exec("CREATE TABLE IF NOT EXISTS transcript_index_state(name TEXT PRIMARY KEY, done INTEGER NOT NULL, cursor INTEGER NOT NULL, skipped INTEGER NOT NULL) WITHOUT ROWID");
    db.prepare("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner',?,0,0)").run(randomUUID());
    opts.persistRosters();
    opts.beforeCommit?.(db);
    db.exec("COMMIT");
  } catch (error) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw error; }
}
