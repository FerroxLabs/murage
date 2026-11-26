// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-COMMIT per-site drivers (commit-site-harness.ts): installation-app-schema-downgrade.ts, bot-calls-schema.ts, pending-delegations-schema.ts,
// app-trigger-store.ts, database.ts, write-tx.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AppTriggerStore, downgradeAppTriggers, type CustodyEntry } from "../../../app-trigger-store.ts";
import { downgradeBotCallsTo108, insertCallRule, migrateSessionPrincipals } from "../../../bot-calls-schema.ts";
import { DATA_DIR } from "../../../config.ts";
import "../../../delegations.ts"; // registers the real legacy-queue parser (importLegacyDelegations returns early without one)
import { observeVerifiedHuman } from "../../../human-principals.ts";
import { downgradeApplicationSchemaTo101, downgradeCardTablesTo117, downgradePhoneObjectsTo108, downgradeSpeechTablesTo117, markInFlightSpeechInterrupted } from "../../../installation-app-schema-downgrade.ts";
import { importLegacyDelegations, initializePendingDelegations, LEGACY_DELEGATIONS_FILE, migrateOwnerHandoffPage, OLD_OWNER_HANDOFF_GROUP } from "../../../pending-delegations-schema.ts";
import { initializeSharedReady } from "../../../shared-ready.ts";
import type { SiteDriver } from "../commit-site-harness.ts";

const DROP_ONLY = "DROP/ALTER only: no row of a table present at setup is written, so no trigger marks a wake";
const request = (db: DatabaseSync, id: string, fields: { group?: string; state?: string; refusal?: string | null; to?: string | null; audience?: string | null }) =>
  db.prepare(`INSERT INTO room_requests(id,root_id,group_id,verb,from_kind,to_bot_id,origin,root_thread_id,audience_fingerprint,not_owner_audience,unattended,execution_audience,admission_key,state,refusal,created_at)
    VALUES(?,?,?,'message','owner',?,'desktop','thread-a','fp',0,0,?,?,?,?,1)`).run(id, id, fields.group ?? "group-a", fields.to ?? null, fields.audience ?? null, `key-${id}`, fields.state ?? "queued", fields.refusal ?? null);
const speech = (db: DatabaseSync, state: string) => {
  db.exec("INSERT INTO speech_accounts(binding_id,credential_version,account_scope_id,plan_version,hold_until) VALUES('binding-a','v1','scope-a','p1',0)");
  db.prepare(`INSERT INTO speech_attempts(attempt_id,session_id,command_sequence,thread_id,message_id,mode,revision,boot_id,reserved_at,account_scope_id,plan_version,state)
    VALUES('attempt-a','session-a',1,'thread-a','message-a','manual',1,'boot-a',1,'scope-a','p1',?)`).run(state);
};

export const DRIVERS: Record<string, SiteDriver> = {
  "app-trigger-store.ts downgradeAppTriggers#1": { conn: "main", noMark: DROP_ONLY, commit: db => downgradeAppTriggers(db) },
  "app-trigger-store.ts inTx#1": {
    conn: "nested",
    why: "the savepoint arm of inTx runs only when the caller already holds a transaction",
    outer: true,
    commit: db => new AppTriggerStore(db).commitClaim("claim-a", [{ item: { deliveryId: "delivery-a" }, binding: null, disposition: "filtered" } as unknown as CustodyEntry], 1),
  },
  "app-trigger-store.ts inTx#3": {
    conn: "main",
    // a foreign delivery (no binding) is dropped: one tombstone row
    commit: db => new AppTriggerStore(db).commitClaim("claim-a", [{ item: { deliveryId: "delivery-a" }, binding: null, disposition: "filtered" } as unknown as CustodyEntry], 1),
  },
  "bot-calls-schema.ts migrateSessionPrincipals#1": {
    conn: "main",
    setup: db => db.exec("INSERT INTO bot_call_sessions(id,call_id,bot_id,device,opened_at,last_seen_at,backstop_at,principal) VALUES('session-a','call-a','bot-a','desktop',1,1,2,NULL)"),
    commit: db => migrateSessionPrincipals(db),
  },
  "bot-calls-schema.ts inTransaction#1": {
    conn: "main",
    commit: db => insertCallRule(db, { botId: "bot-a", kind: "turn_end", params: { threadId: "thread-a", turnId: "turn-a" }, how: "ring" }, 1),
  },
  "bot-calls-schema.ts downgradeBotCallsTo108#1": { conn: "main", noMark: DROP_ONLY, commit: db => downgradeBotCallsTo108(db) },
  "database.ts transaction#1": {
    conn: "main",
    commit: () => observeVerifiedHuman({ platform: "slack", connectionId: "connection-a", authorityId: "authority-a", userId: "user-a" }),
  },
  "installation-app-schema-downgrade.ts downgradeCardTablesTo117#1": { conn: "main", noMark: DROP_ONLY, commit: db => downgradeCardTablesTo117(db) },
  "installation-app-schema-downgrade.ts markInFlightSpeechInterrupted#1": {
    conn: "main", noMark: "no attempt in flight: the transaction only reads, then commits", commit: db => markInFlightSpeechInterrupted(db, 1),
  },
  "installation-app-schema-downgrade.ts markInFlightSpeechInterrupted#2": {
    conn: "main", setup: db => speech(db, "streaming"), commit: db => markInFlightSpeechInterrupted(db, 1),
  },
  "installation-app-schema-downgrade.ts downgradeSpeechTablesTo117#1": { conn: "main", noMark: DROP_ONLY, commit: db => downgradeSpeechTablesTo117(db) },
  "installation-app-schema-downgrade.ts downgradePhoneObjectsTo108#1": {
    conn: "main", noMark: `${DROP_ONLY} (owner_sends is renamed and its rows copied into a table made inside the transaction)`, commit: db => downgradePhoneObjectsTo108(db),
  },
  "installation-app-schema-downgrade.ts downgradeApplicationSchemaTo101#1": {
    conn: "main",
    // a finished request with the 1.0.2 parking mark: the downgrade clears the mark (a row write inside its transaction)
    setup: db => request(db, "request-a", { state: "done", refusal: "retained_unresolved" }),
    commit: db => downgradeApplicationSchemaTo101(db, DATA_DIR),
  },
  "pending-delegations-schema.ts initializePendingDelegations#1": {
    conn: "main",
    noMark: "the rebuild renames the table, copies its rows into one made inside the transaction and drops the old one: no row of a setup table is written",
    // the table of an earlier development build (no submitted_at / evidence_at) is rebuilt
    setup: db => db.exec(`DROP TABLE pending_delegations;
      CREATE TABLE pending_delegations (id TEXT PRIMARY KEY NOT NULL, source_thread_id TEXT NOT NULL, to_bot_id TEXT NOT NULL, from_bot_id TEXT, phase TEXT NOT NULL, retry_at INTEGER, item TEXT NOT NULL);
      INSERT INTO pending_delegations VALUES('handoff-a','thread-a','bot-a',NULL,'fresh',NULL,'{}');`),
    commit: db => initializePendingDelegations(db),
  },
  "pending-delegations-schema.ts importLegacyDelegations#1": {
    conn: "main",
    // not imported yet, and a legacy queue file (empty): the transaction sets the import marker
    setup: db => { db.exec("DELETE FROM pending_delegations_import"); writeFileSync(join(DATA_DIR, LEGACY_DELEGATIONS_FILE), "{}"); },
    commit: db => importLegacyDelegations(db),
  },
  "pending-delegations-schema.ts migrateOwnerHandoffPage#1": {
    conn: "main",
    setup: db => request(db, "request-a", { group: OLD_OWNER_HANDOFF_GROUP }),
    commit: db => migrateOwnerHandoffPage(db),
  },
  "write-tx.ts endWrite#1": {
    conn: "nested",
    why: "every write frame's savepoint sits inside the BEGIN IMMEDIATE its outer frame opened (write-tx.structure.test.ts forbids a bare top-level SAVEPOINT)",
    setup: db => { request(db, "request-a", { to: "bot-a", audience: JSON.stringify({ team: "team-a" }) }); db.exec("DELETE FROM shared_ready_teams"); },
    commit: db => initializeSharedReady(db),
  },
  "write-tx.ts endWrite#2": {
    conn: "main",
    // a queued team request whose team is not in the ready set: the fill inserts it (initializeSharedReadyNow's beginWrite frame)
    setup: db => { request(db, "request-a", { to: "bot-a", audience: JSON.stringify({ team: "team-a" }) }); db.exec("DELETE FROM shared_ready_teams"); },
    commit: db => initializeSharedReady(db),
  },
};
