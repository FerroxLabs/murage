// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-COMMIT per-site drivers (commit-site-harness.ts): the email restore files, the side stores with their own file (channel ledger, connected-app
// journal, sentinel, web budget, stats worker), cloud sessions, push, phones, the card executor, restore prep and room requests.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_STATS_SCHEMA_VERSION, DB_STATS_TABLES } from "../../../../shared/health-protocol.mjs";
import { DATA_DIR } from "../../../config.ts";
import { LedgerStore } from "../../../channels/delivery-ledger-store.ts";
import { CloudSessions } from "../../../cloud-sessions.ts";
import { SqliteOperationJournal } from "../../../connected-app-journal.ts";
import { EmailStore, initializeEmailTables } from "../../../email/email-store.ts";
import { sqliteRestoreEffects, workerPublish } from "../../../email/restore-job-effects.ts";
import { RESTORE_JOB_MARKS_DDL } from "../../../email/restore-job-marks-ddl.ts";
import type { RestoreJob } from "../../../email/restore-job.ts";
import { consumeRestoreMarker } from "../../../email/restore-marker.ts";
import { adoptLegacyParks } from "../../../email/restore.ts";
import { buildInWorker } from "../../../health/stats-publisher.ts";
import { initializeHighLevelThreadMarks } from "../../../highlevel/thread-marks.ts";
import { mergeDestinationHighLevelMarks } from "../../../highlevel/thread-marks-restore.ts";
import { initializeMessageTables } from "../../../message-tables.ts";
import { PushStore, downgradePushRetentionIndexesTo102, initializeMobilePush } from "../../../mobile-push-store.ts";
import { PhoneRegistry, initializePhones } from "../../../phones/registry.ts";
import { createProjectCardExecutor } from "../../../project-card-executor.ts";
import { createProjectCard, enqueueCardRun } from "../../../project-cards.ts";
import { cardGenerationCurrent } from "../../../project-turn-engine.ts";
import { prepareRestoredDatabase } from "../../../restore-prep-core.ts";
import { backfillRoomRequestOwed, reclassifyOwedV1 } from "../../../room-request-owed.ts";
import { insertRoomRequest } from "../../../room-requests.ts";
import { SentinelStore } from "../../../sentinel/store.ts";
import { readSetupThreadFacts } from "../../../setup-thread-facts.ts";
import { WebDocumentBudget } from "../../../web-document-budget.ts";
import { createWorkAdmission } from "../../../work-admission.ts";
import type { SiteDriver } from "../commit-site-harness.ts";

/** A side folder under the test data dir, and a file in it opened, filled by `fill`, closed. */
const folder = (name: string) => { const dir = join(DATA_DIR, name); mkdirSync(dir, { recursive: true }); return dir; };
const withFile = <T>(file: string, fill: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(file); try { return fill(db); } finally { db.close(); } };
const one = (file: string, sql: string) => withFile(file, db => db.prepare(sql).get());
const JOB = { version: 1, id: "job-1", archiveId: "archive-1", source: "owner", phase: "armed", at: 1 } as unknown as RestoreJob;
const LINEAGE = { rootThreadId: "room-thread", origin: "desktop", audienceFingerprint: "owner", notOwnerAudience: false, unattended: false } as const;
let sessions: CloudSessions;

/** A queued owner Start of one card, the way the board leaves it for the executor's pump. */
function queueCard(db: DatabaseSync): void {
  db.exec("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES('g','ongoing','lead',1)");
  const made = createProjectCard(db, { groupId: "g", title: "Card one", assigneeBotId: "worker", actor: { kind: "owner" }, memberIds: ["lead", "worker"], now: 10_000 });
  if (!made.ok) throw new Error(made.reason);
  const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: 10_000 });
  if (!queued.ok) throw new Error(queued.reason);
}
function pumpCards(db: DatabaseSync): void {
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
    speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
    askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false, claimWriterRoot: () => () => {}, now: () => 10_000 } as never);
  admission.setBudgetGate({ check: () => ({ ok: true }) } as never);
  const executor = createProjectCardExecutor({ db: () => db, admission, now: () => 10_000, open: () => true,
    context: () => ({ groupId: "g", isProject: true, closed: false, runState: "running", mode: "ongoing", leadBotId: "lead", boardOn: true, parallelCards: 1 }) as never,
    usable: () => true, desk: request => `desk-${request.toBotId}`, writerRoot: () => undefined, start: () => {},
    hooks: { cardGenerationCurrent, returnThread: () => "room" } as never, changed: () => {} });
  try { executor.pump(); } finally { executor.stop(); }
}

export const DRIVERS: Record<string, SiteDriver> = {
  "channels/delivery-ledger-store.ts LedgerStore.tx#1": {
    conn: "own", why: "the channel receipt ledger is its own file, delivery-ledger.db, on a handle the store opens",
    run: async () => {
      const store = new LedgerStore(join(folder("channel-ledger"), "binding.json"));
      try { store.commit({ version: 1, bindingKey: "binding", recipient: "owner", tombstones: [], records: [] } as never); return store.row()?.binding_key === "binding"; }
      finally { await store.release(); }
    },
  },
  "cloud-sessions.ts CloudSessions.tx#1": {
    conn: "main",
    // built at setup: the constructor's own autocommit writes (environment id) are not this site's transaction
    setup: db => { sessions = new CloudSessions(db); },
    commit: () => sessions.revokeAccount(),
  },
  "connected-app-journal.ts SqliteOperationJournal.apply#1": {
    conn: "own", why: "the connected-app operation ledger is its own small file beside messages.db",
    run: () => {
      const journal = new SqliteOperationJournal(join(folder("connected-apps"), "operations.db"));
      try {
        journal.apply({ put: [{ handle: "op-1", scope: "bot-1|account", key: "key-1", label: undefined, startedAt: 1, state: "pending", requirements: [], requirementsComplete: true }], remove: [] });
        return journal.load().some(record => record.handle === "op-1");
      } finally { journal.close(); }
    },
  },
  "email/email-store.ts EmailStore.constructor#1": {
    conn: "main",
    setup: db => initializeEmailTables(db),
    commit: db => { const store = new EmailStore(db); store.tx(() => store.putPolicyIntent("bot-1", "ask", 1)); },
  },
  "email/restore-job-effects.ts stage#1": {
    conn: "own", why: "the staged copy of the archive's messages.db is opened by the restore job on its own handle",
    run: () => {
      const dir = folder("restore-stage"), archives = join(dir, "archives");
      mkdirSync(join(archives, JOB.archiveId), { recursive: true });
      withFile(join(archives, JOB.archiveId, "messages.db"), db => db.exec("CREATE TABLE archived(x)"));
      const effects = sqliteRestoreEffects({ liveDb: join(dir, "messages.db"), archivesDir: archives });
      effects.stage(JOB);
      return effects.staged?.(JOB) === true && (one(join(dir, `messages.db.restore-${JOB.id}`), "SELECT job_id FROM restore_job_marks WHERE kind='swapped'") as { job_id?: string } | undefined)?.job_id === JOB.id;
    },
  },
  "email/restore-job-effects.ts prepare#1": {
    conn: "own", why: "the restore job prepares the installed database on a handle of its own (openLive), with the store closed",
    run: () => {
      const live = join(folder("restore-prepare"), "messages.db");
      withFile(live, db => db.exec("CREATE TABLE kept(x)"));
      const effects = sqliteRestoreEffects({ liveDb: live, archivesDir: folder("restore-prepare-archives") });
      effects.prepare(JOB);
      return effects.marks().prepared === JOB.id;
    },
  },
  "email/restore-job-effects.ts publishBootWaitRow#3": {
    conn: "own", why: "publishBootWaitRow runs in a worker thread (workerPublish) on its own handle to messages.db",
    run: async () => {
      const live = join(folder("restore-boot-wait"), "messages.db");
      withFile(live, db => { db.exec(RESTORE_JOB_MARKS_DDL); db.prepare("INSERT INTO restore_job_marks (kind, job_id) VALUES ('prepared', ?)").run(JOB.id); });
      const published = workerPublish({ dbPath: live, jobId: JOB.id, cause: "space", elapsedMs: 5, outcome: "freed", at: 1, bootId: "boot-1", upMs: 10 });
      const result = await published.result;
      await published.exited;
      return result === "saved" && (one(live, "SELECT job_id FROM restore_boot_wait WHERE id=1") as { job_id?: string } | undefined)?.job_id === JOB.id;
    },
  },
  "email/restore-marker.ts consumeRestoreMarker#2": {
    conn: "own", why: "the marker is consumed at boot on its own handle, before database() opens messages.db",
    run: () => {
      const dir = folder("restore-marker");
      withFile(join(dir, "messages.db"), db => db.exec("CREATE TABLE restore_pending(at INTEGER)"));
      return consumeRestoreMarker(dir) && one(join(dir, "messages.db"), "SELECT 1 FROM sqlite_master WHERE name='restore_pending'") === undefined;
    },
  },
  "email/restore.ts adoptLegacyParks#1": {
    conn: "main",
    setup: db => {
      initializeEmailTables(db);
      db.exec("INSERT INTO email_bindings (bot_id, inbox_id, email_key_ref, state, policy, revision, updated_at) VALUES ('bot-1','inbox-1','key-1','removal_parked','ask',1,1)");
    },
    commit: db => adoptLegacyParks(db),
  },
  "health/stats-publisher.ts BUILD_WORKER_SOURCE>(module)#1": {
    conn: "own", why: "the sealed stats generation is a new file built by an eval'd worker thread",
    run: async () => {
      const file = join(folder("health"), "db-stats-site.sqlite");
      const built = await buildInWorker({ file, snapshot: { version: DB_STATS_SCHEMA_VERSION, installation_id: "installation-1", generation: 1, at: 1, coverage: "partial" as never }, rows: [], tables: DB_STATS_TABLES });
      return built.ok && (one(file, "SELECT generation FROM snapshot") as { generation?: number } | undefined)?.generation === 1;
    },
  },
  "highlevel/thread-marks-restore.ts mergeDestinationHighLevelMarks#1": {
    conn: "own", why: "an offline restore helper: it opens the candidate installation's messages.db itself",
    run: () => {
      const destination = folder("highlevel-destination"), candidate = folder("highlevel-candidate");
      // the candidate is a restored installation, so its messages.db exists (a missing one cannot be initialized inside the merge's BEGIN IMMEDIATE)
      withFile(join(candidate, "messages.db"), db => initializeMessageTables(db));
      withFile(join(destination, "messages.db"), db => { initializeHighLevelThreadMarks(db); db.exec("INSERT INTO highlevel_thread_marks(thread_id, marked_at) VALUES ('thread-1', 1)"); });
      return mergeDestinationHighLevelMarks(destination, candidate) === 1 && one(join(candidate, "messages.db"), "SELECT 1 AS x FROM highlevel_thread_marks WHERE thread_id='thread-1'") !== undefined;
    },
  },
  "mobile-push-store.ts downgradePushRetentionIndexesTo102#1": {
    conn: "main", setup: db => initializeMobilePush(db), commit: db => downgradePushRetentionIndexesTo102(db),
    noMark: "DDL only: the step back drops three indexes and writes no table",
  },
  "mobile-push-store.ts PushStore.transaction#1": {
    conn: "main",
    commit: db => new PushStore(db).putBinding({ bindingId: "binding-1", deviceId: "device-1", publisherToken: "publisher-1", createdAt: 1, previewContent: false, tokenExpiresAt: null }),
  },
  "phones/registry.ts PhoneRegistry.revoke#1": {
    conn: "main", setup: db => initializePhones(db), commit: db => new PhoneRegistry(db, () => 1).revoke("device-1", "removed"),
  },
  "project-card-executor.ts pump#1": { conn: "main", setup: queueCard, commit: pumpCards },
  "restore-prep-core.ts prepareRestoredDatabase#1": {
    conn: "own", why: "restore preparation runs on the candidate installation's own messages.db (installation-restore-preparation.ts), never the live handle",
    run: () => {
      const state = folder("restore-candidate"), file = join(state, "messages.db");
      withFile(file, db => {
        initializeMessageTables(db);
        prepareRestoredDatabase(db, { generation: "generation-1", profile: "archive", quarantineId: "quarantine-1", modifications: [], state, files: new Set(["messages.db"]),
          sharingBots: [], sharingGroups: [], botIds: new Set(), persistRosters: () => {} });
      });
      return one(file, "SELECT 1 AS x FROM transcript_index_state WHERE name='search_owner'") !== undefined;
    },
  },
  "room-request-owed.ts backfillRoomRequestOwed#1": {
    conn: "main",
    setup: db => db.exec("DELETE FROM room_request_backfills WHERE name='room_request_owed_v1'"),
    commit: db => backfillRoomRequestOwed(db),
  },
  "room-request-owed.ts reclassifyOwedV1#1": {
    conn: "main",
    // an owed row an earlier build recorded with the broad rule, unstamped (the classify trigger keeps a stamped insert; the stamp is then cleared): one slice, one commit
    setup: db => db.exec(`DELETE FROM room_request_backfills WHERE name='room_request_owed_classify_v1';
      INSERT INTO room_request_owed(kind, request_id, shared) VALUES ('shared_delivery','request-1',1); UPDATE room_request_owed SET shared=NULL WHERE request_id='request-1'`),
    commit: db => reclassifyOwedV1(db),
  },
  "room-requests.ts withTx#1": {
    conn: "main",
    commit: db => insertRoomRequest(db, { groupId: "g", verb: "owner_send", fromKind: "owner", admissionKey: "owner_send:g:site", lineage: LINEAGE, now: 1 } as never),
  },
  "sentinel/store.ts SentinelStore.open#1": {
    conn: "own", why: "the Sentinel scanner's state.sqlite in its output folder",
    run: () => {
      const opened = SentinelStore.open(folder("sentinel-open"), { installationId: "installation-1" });
      try { return opened.status === "ok" && opened.store.meta<string>("installation_id") === "installation-1"; } finally { opened.store?.close(); }
    },
  },
  "sentinel/store.ts SentinelStore.commit#1": {
    conn: "own", why: "the Sentinel scanner's state.sqlite in its output folder",
    run: () => {
      const opened = SentinelStore.open(folder("sentinel-commit"), { installationId: "installation-1" });
      if (opened.status !== "ok") return false;
      try { return opened.store.commit({ meta: { note: "site" } }) === 1 && opened.store.meta<string>("note") === "site"; } finally { opened.store.close(); }
    },
  },
  "setup-thread-facts.ts readSetupThreadFacts#1": {
    conn: "main", commit: db => readSetupThreadFacts(db, "thread-1"),
    noMark: "a read snapshot: BEGIN (deferred) around reads, ended by COMMIT; it writes nothing",
  },
  "web-document-budget.ts WebDocumentBudget.reserve#1": {
    conn: "own", why: "the web document budget is a per-OS-user ledger file shared across processes",
    run: () => {
      const file = join(folder("web-budget"), "reservations.sqlite"), budget = new WebDocumentBudget(file);
      try { budget.reserve("document-1", "bot-1", 10); } finally { budget.close(); }
      return one(file, "SELECT 1 AS x FROM reservations WHERE id='document-1'") !== undefined;
    },
  },
};
