// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-COMMIT per-site drivers (commit-site-harness.ts), group g1: schema.ts, memory-revocation.ts, revocation-index.ts, open-turns.ts,
// owner-tail-index.ts, record-keys.ts, continuation-settle.ts, root-set-reclaim.ts, optional-index.ts.
import type { DatabaseSync } from "node:sqlite";
import { TURN_INDEX, TURN_INDEX_PREVIOUS_DDLS, TURN_INDEX_REGISTRATION } from "../../../message-tables.ts";
import { continuationSessionVerdict } from "../../continuation-settle.ts";
import { LineageAllowance } from "../../lineage-allowance.ts";
import { closeWaitedPending, drainRevokeMarker, drainRevokeMarkerBounded, memoryRevocationStats, resetWaitedPendingAllowance, stopMemoryRevocation, wakeMemoryRevocation } from "../../memory-revocation.ts";
import { bumpOpenTurnsBoot, openTurnsStep } from "../../open-turns.ts";
import { buildOptionalIndexOffThread } from "../../optional-index.ts";
import { createOwnerTail, dropLegacyOwnerTailIndex, fillOwnerTailSlice } from "../../owner-tail-index.ts";
import { fillRecordKeysSlice } from "../../record-keys.ts";
import { buildRevocationIndexStep } from "../../revocation-index.ts";
import { resetRevokeWriteBudget } from "../../revoke-budget.ts";
import { lastReclaimStats, reclaimRootSetsWhenIdle, setReadTimeJudgeRetired, type ReclaimGate } from "../../root-set-reclaim.ts";
import {
  BACKFILL_THREADS_SCHEMA, BACKFILL_THREADS_TABLE, downgradeMemorySchema, dropOwnerTail, ensureRecordKeys, ensureRevokeLateObjects, IDENTITY_STAMP_SCHEMA, IDENTITY_STAMP_TABLE, LEGACY_OWNER_TAIL_INDEX_SQL,
  migrateMemorySchema, RECORD_KEYS_SCHEMA, repairOutputRootBackfill, REVOCATION_REF_INDEX, upgradeDevelopmentV10Carry, upgradeDevelopmentV5, upgradeDevelopmentV9,
} from "../../schema.ts";
import { interruptOpenTurn, recordMemorySettlement } from "../../settlement.ts";
import { CONTENT, WritetimeFixture } from "../writetime-fixture.ts";
import type { SiteDriver } from "../commit-site-harness.ts";

type Db = DatabaseSync;
/** memory_meta's CHECK pins the version: an older file's version is written past it (the shape the dev upgrades look for). */
const atVersion = (db: Db, v: number) => { db.exec("PRAGMA ignore_check_constraints=1"); db.prepare("UPDATE memory_meta SET schema_version=? WHERE id=1").run(v); db.exec("PRAGMA ignore_check_constraints=0"); };
const scope = (db: Db) => db.exec("INSERT OR IGNORE INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES('s-site','room','s-site','[]',0)");
/** A line revoke whose walk has written every mark (phase tidy, no frontier row), holding one thread's pending row. */
const tidyRevoke = (db: Db, thread = "th-a") => {
  new WritetimeFixture(db).cert(true);
  db.prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(1,'line',?,100,100,'tidy','','active')")
    .run(JSON.stringify({ kind: "line", cause: "forget", threadId: thread, lines: 1 }));
  db.prepare("INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,5,1)").run(thread);
  resetRevokeWriteBudget(); resetWaitedPendingAllowance();
};
/** One runner tick through the real runner (wakeMemoryRevocation's timer), stopped before a second one: the long pauses keep it to one. */
async function oneTick(db: Db): Promise<void> {
  const before = memoryRevocationStats.slices + memoryRevocationStats.lateSlices + memoryRevocationStats.errorRetries + memoryRevocationStats.lockedRetries;
  const moved = () => memoryRevocationStats.slices + memoryRevocationStats.lateSlices + memoryRevocationStats.errorRetries + memoryRevocationStats.lockedRetries > before;
  wakeMemoryRevocation(() => db, { busy: () => false, pauseMs: 60_000, retryMs: 60_000, busyPauseMs: 60_000 });
  try { for (let i = 0; i < 1000 && !moved(); i++) await new Promise<void>(resolve => setTimeout(resolve, 5)); }
  finally { stopMemoryRevocation(); }
  if (!moved()) throw new Error("the runner ran no slice");
}
const reclaimGate: ReclaimGate = { ownerIdleMs: () => 1e12, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };
const reclaimSetup = (db: Db) => {
  db.exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
  db.exec("INSERT INTO memory_root_sets(set_id,size) VALUES('rs-site',1); INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES('rs-site','th-r','m-r')");
};
/** The idle reclaim on its worker, up to the one VACUUM (no disk room reported: it waits there). */
async function reclaimRun(db: Db) {
  setReadTimeJudgeRetired(true);
  try { return await reclaimRootSetsWhenIdle(db, reclaimGate, { idleMs: 0, freeDiskBytes: () => 0 }); } finally { setReadTimeJudgeRetired(false); }
}
const tableGone = (db: Db, name: string) => !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
/** A thread of bot replies with one receipt citing them all (the shape the output-root repair reads), the repair not yet recorded. */
const outputsThread = (db: Db, n: number) => {
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('th-o',?,?,'bot','text','t',?)");
  const ids: string[] = [];
  for (let i = 0; i < n; i++) { const id = `m${String(i).padStart(6, "0")}`; ids.push(id); insert.run(id, i, JSON.stringify({ id, at: i, role: "bot", kind: "text", text: "t", parentId: i ? ids[i - 1] : null })); }
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('B1','th-o','engine','S','[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1000)`).run(JSON.stringify(ids));
  db.exec("DELETE FROM memory_output_roots; DELETE FROM transcript_index_state; DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
};

export const DRIVERS: Record<string, SiteDriver> = {
  // ---- open-turns.ts
  "memory/open-turns.ts bumpOpenTurnsBoot#1": { conn: "main", commit: db => bumpOpenTurnsBoot(db) },
  "memory/open-turns.ts openTurnsStep#1": {
    conn: "main",
    // a turn left working by an earlier start: the boot counter moves past it, and the step settles it through the production interrupt
    setup: db => { recordMemorySettlement("th-turn", "t-1", "working"); bumpOpenTurnsBoot(db); },
    commit: db => openTurnsStep(db, interruptOpenTurn),
  },
  "memory/open-turns.ts openTurnsStep#2": {
    conn: "main",
    setup: db => { db.exec("UPDATE memory_open_turns_build SET ready=0,cursor=NULL,finished_at=NULL WHERE id=1"); bumpOpenTurnsBoot(db); },
    commit: db => openTurnsStep(db, () => {}),
  },

  // ---- memory-revocation.ts (the runner, the drains, the waiter's close)
  "memory/memory-revocation.ts tick#1": { conn: "main", realTimers: true, setup: db => tidyRevoke(db), commit: db => oneTick(db) },
  // the drain commits each slice, the last one being the pass that finds nothing left: the tidy slice and that pass
  "memory/memory-revocation.ts drainRevokeMarker#1": { conn: "main", setup: db => tidyRevoke(db), commit: db => drainRevokeMarker(db), times: 2 },
  "memory/memory-revocation.ts closeWaitedPending#1": { conn: "main", setup: db => tidyRevoke(db), commit: db => closeWaitedPending(db, ["th-a"], []) },
  "memory/memory-revocation.ts drainRevokeMarkerBounded#1": { conn: "main", setup: db => tidyRevoke(db), commit: db => drainRevokeMarkerBounded(db, { rows: 1, ms: 60_000 }) },

  // ---- revocation-index.ts
  "memory/revocation-index.ts buildRevocationIndexStep#1": {
    conn: "main",
    // an earlier lane's file: no lookup index and more refs than one budgeted emptying pass removes
    setup: db => {
      db.exec(`UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1; DROP INDEX IF EXISTS ${REVOCATION_REF_INDEX}`);
      const add = db.prepare("INSERT INTO memory_disclosure_refs(bundle_id,kind,ref_id,ref_version) VALUES(?,'record',?,1)");
      for (let i = 0; i < 300; i++) add.run(`b-${i}`, `r-${i}`);
    },
    commit: db => buildRevocationIndexStep(db, 5000, { budgetMs: 0 }),
  },
  "memory/revocation-index.ts buildRevocationIndexStep#2": {
    conn: "main",
    setup: db => db.exec(`UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1; DROP INDEX IF EXISTS ${REVOCATION_REF_INDEX}; DELETE FROM memory_disclosure_refs`),
    commit: db => buildRevocationIndexStep(db, 5000, { budgetMs: 60_000 }),
  },
  "memory/revocation-index.ts buildRevocationIndexStep#3": {
    conn: "main",
    setup: db => db.exec("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1"),
    commit: db => buildRevocationIndexStep(db),
  },

  // ---- owner-tail-index.ts
  "memory/owner-tail-index.ts dropLegacyOwnerTailIndex#1": {
    conn: "main", noMark: "DROP INDEX only", setup: db => db.exec(LEGACY_OWNER_TAIL_INDEX_SQL),
    commit: db => { if (dropLegacyOwnerTailIndex(db) !== "dropped") throw new Error("not dropped"); },
  },
  "memory/owner-tail-index.ts createOwnerTail#1": {
    conn: "main", noMark: "creates the owner-tail tables and triggers; its one row goes into the build table it just made",
    setup: db => dropOwnerTail(db), commit: db => createOwnerTail(db),
  },
  "memory/owner-tail-index.ts fillOwnerTailSlice#1": {
    conn: "main",
    setup: db => { createOwnerTail(db); db.exec("UPDATE memory_owner_tail_build SET ready=0,cursor_id=NULL,cursor_version=NULL WHERE id=1"); },
    commit: db => fillOwnerTailSlice(db, 256, { budgetMs: 60_000 }),
  },

  // ---- record-keys.ts
  "memory/record-keys.ts fillRecordKeysSlice#1": {
    conn: "main",
    setup: db => { ensureRecordKeys(db); db.exec("UPDATE memory_record_keys_build SET ready=0,cursor_rowid=0 WHERE id=1"); },
    commit: db => fillRecordKeysSlice(db, 256, { budgetMs: 60_000 }),
  },

  // ---- continuation-settle.ts
  "memory/continuation-settle.ts continuationSessionVerdict#1": {
    conn: "main",
    // a ready thread's session inside the tidy revoke's pending window: the settle runs that revoke's marker slice
    setup: db => { tidyRevoke(db, "th-c"); new WritetimeFixture(db).ready("th-c", true).sessionLineage("th-c", "engine", "S", 10, 20); },
    commit: db => continuationSessionVerdict(db, { threadId: "th-c", driverInstance: "engine", nativeSession: "S" }, CONTENT, LineageAllowance.turn(3000)),
  },
  "memory/continuation-settle.ts finishThreadReadiness#1": {
    conn: "main",
    // a thread not yet ready whose one line has its lineage row: the bounded readiness check readies it
    setup: db => { new WritetimeFixture(db).cert(true).reply("th-n", "m-1", 10).ready("th-n", false).sessionLineage("th-n", "engine", "S", 10, 10); },
    commit: db => continuationSessionVerdict(db, { threadId: "th-n", driverInstance: "engine", nativeSession: "S" }, CONTENT, LineageAllowance.turn(3000)),
    rollback: "the one write is readyImportedThread's, inside its own savepoint (lineage-write.ts atomically): a refused write is undone there and the transaction commits empty, so no refused write reaches this ROLLBACK",
  },

  // ---- root-set-reclaim.ts (the engine source runs in the reclaim worker on its own connection)
  "memory/root-set-reclaim.ts ENGINE_SOURCE>batch#1": {
    conn: "own", why: "the sliced reclaim worker's own DatabaseSync on the file", setup: reclaimSetup,
    run: async db => { await reclaimRun(db); return (lastReclaimStats().maxRows ?? 0) > 0 && !db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members' AND type='table'").get(); },
  },
  "memory/root-set-reclaim.ts ENGINE_SOURCE>once#1": {
    conn: "own", why: "the sliced reclaim worker's own DatabaseSync on the file", setup: reclaimSetup,
    run: async db => { await reclaimRun(db); return tableGone(db, "memory_root_sets") && tableGone(db, "memory_output_roots"); },
  },

  // ---- optional-index.ts
  "memory/optional-index.ts buildOptionalIndexOffThread#1": {
    conn: "main", noMark: "DROP INDEX and CREATE INDEX only",
    // an index under a prior definition: replaced in one transaction on the caller's connection (inline)
    setup: db => db.exec(`DROP INDEX IF EXISTS ${TURN_INDEX}; ${TURN_INDEX_PREVIOUS_DDLS[0]}`),
    commit: async db => { if (!await buildOptionalIndexOffThread(db, TURN_INDEX_REGISTRATION, { inline: true })) throw new Error("not built"); },
  },

  // ---- schema.ts
  "memory/schema.ts ensureRevokeLateObjects#1": { conn: "main", setup: db => db.exec("DELETE FROM memory_late_build WHERE name='origins'"), commit: db => ensureRevokeLateObjects(db) },
  "memory/schema.ts ensureRecordKeys#1": {
    conn: "main", setup: db => { ensureRecordKeys(db); db.exec(`DROP TABLE ${BACKFILL_THREADS_TABLE}; DELETE FROM ${IDENTITY_STAMP_TABLE}`); }, commit: db => ensureRecordKeys(db),
  },
  "memory/schema.ts cycle#1": {
    conn: "main",
    // a thread long enough for one progress tick inside its walk (every 256 outputs), committed at once (checkpointMs 0)
    setup: db => outputsThread(db, 300),
    commit: db => repairOutputRootBackfill(db, { checkpointMs: 0 }),
  },
  "memory/schema.ts repairOutputRootBackfillSteps#1": { conn: "main", setup: db => outputsThread(db, 3), commit: db => repairOutputRootBackfill(db) },
  "memory/schema.ts upgradeDevelopmentV5#1": {
    conn: "main", noMark: "the two old tables are renamed and copied into the new ones it creates, then dropped",
    setup: db => {
      db.exec(`DROP TABLE memory_lessons; CREATE TABLE memory_lessons (id TEXT NOT NULL, version INTEGER NOT NULL, parent_id TEXT, bot_id TEXT NOT NULL, scope TEXT NOT NULL,
        recipients TEXT, text TEXT NOT NULL, origin TEXT NOT NULL, state TEXT NOT NULL, evidence TEXT, prospect_derived INTEGER NOT NULL DEFAULT 0, learning_event_id TEXT,
        created_at INTEGER NOT NULL, decided_at INTEGER, PRIMARY KEY(id,version))`);
      atVersion(db, 5);
    },
    commit: db => { if (!upgradeDevelopmentV5(db)) throw new Error("no upgrade"); },
  },
  "memory/schema.ts upgradeDevelopmentV9#1": {
    conn: "main", noMark: "drops two indexes and creates the open-turns tables; its one row goes into the build table it just made",
    setup: db => {
      db.exec("DROP TRIGGER memory_open_turns_insert; DROP TRIGGER memory_open_turns_keep; DROP TRIGGER memory_open_turns_close; DROP TRIGGER memory_open_turns_delete; DROP TABLE memory_open_turns; DROP TABLE memory_open_turns_build");
      atVersion(db, 9);
    },
    commit: db => { if (!upgradeDevelopmentV9(db)) throw new Error("no upgrade"); },
  },
  "memory/schema.ts upgradeDevelopmentV10Carry#1": {
    conn: "main", noMark: "the old carry table is renamed, copied into the new one it creates, then dropped",
    setup: db => {
      db.exec(`DROP TABLE memory_lineage_carry; CREATE TABLE memory_lineage_carry (parent_thread_no INTEGER NOT NULL, to_lsn INTEGER NOT NULL, from_lsn INTEGER NOT NULL,
        child_kind INTEGER NOT NULL, child_ref TEXT NOT NULL, child_thread_no INTEGER, PRIMARY KEY(parent_thread_no,to_lsn,from_lsn,child_kind,child_ref)) WITHOUT ROWID;
        INSERT INTO memory_lineage_carry VALUES(1,2,1,0,'c-1',NULL)`);
      atVersion(db, 10);
    },
    commit: db => { if (!upgradeDevelopmentV10Carry(db)) throw new Error("no upgrade"); },
  },
  "memory/schema.ts migrateMemorySchema#1": { conn: "main", setup: db => { downgradeMemorySchema(db, 10); }, commit: db => migrateMemorySchema(db, "active") },
  "memory/schema.ts downgradeMemorySchema#1": {
    conn: "main", noMark: "the 13 -> 13 step drops tables and indexes only",
    commit: db => { if (downgradeMemorySchema(db, 13).status !== "downgraded") throw new Error("not downgraded"); },
  },
  "memory/schema.ts downgradeMemorySchema#3": {
    conn: "main", noMark: "the 10 -> 10 step drops the 1.0.3 derived tables only",
    // a v10 file a 1.0.3 left: the key table is there
    setup: db => { downgradeMemorySchema(db, 10); db.exec(RECORD_KEYS_SCHEMA + BACKFILL_THREADS_SCHEMA + IDENTITY_STAMP_SCHEMA); },
    commit: db => { if (downgradeMemorySchema(db, 10).status !== "downgraded") throw new Error("not downgraded"); },
  },
  "memory/schema.ts downgradeMemorySchema#5": {
    conn: "main",
    setup: db => { scope(db); db.exec("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('memory-claim-settle-sweep','s-site','system','claim-settle-sweep',0,'granted','{}')"); },
    commit: db => { if (downgradeMemorySchema(db, 12).status !== "downgraded") throw new Error("not downgraded"); },
  },
};
