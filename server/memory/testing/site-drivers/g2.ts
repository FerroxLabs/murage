// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W-COMMIT per-site drivers (commit-site-harness.ts): group g2 (age-index ... upgrade-counts).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_BOT_LEARNING } from "../../../bot-learning.ts";
import { DATA_DIR } from "../../../config.ts";
import { downgradeMemoryIndexFile, ensureAgeTables } from "../../age-index.ts";
import { runBranchChangeSlice } from "../../branch-change.ts";
import { dropEmptyCheckpointSchema, ensureCheckpointSchema } from "../../checkpoint-schema.ts";
import { IndexWalWriter, openIndexWal, runOpenRuleForDowngrade, WalStop } from "../../index-wal.ts";
import { runIntegrityPassToEnd } from "../../integrity-pass.ts";
import { beginIntegrityPass } from "../../integrity-state.ts";
import { createKeepAllRepairGate, ownerAudienceSessions, startKeepAllRepair } from "../../keepall-unwedge.ts";
import { recordDefaultLearningConnection } from "../../learning-ledger.ts";
import { addLesson } from "../../lessons.ts";
import { LineageAllowance } from "../../lineage-allowance.ts";
import { lineageBackfillSlice, lineageDowngradeSlice } from "../../lineage-backfill.ts";
import { markOutcome } from "../../outcomes.ts";
import { parkStuckJobsStep, resetParkSweep } from "../../park.ts";
import { reconcileOutstandingChanges, recordAppliedChange, setProcedureLandingHost, type ProcedureLandingHost } from "../../procedure-landing.ts";
import { durableIdentityStamp, identityRecomputeStats, recomputeIdentityOffThread, storeIdentityAllow } from "../../provenance-stamp.ts";
import { ensureRecallViewSchema, RECALL_PENDING_OBJECTS } from "../../recall-view-schema.ts";
import { releaseTransaction } from "../../release-transaction.ts";
import { captureSendReplayProof } from "../../replay-lineage.ts";
import { mergeDestinationMemoryDeletions } from "../../restore.ts";
import { migrateMemorySchema } from "../../schema.ts";
import { insertScope } from "../../scope-insert.ts";
import { SCRUB_PASS_TABLE, stepScrubPass } from "../../scrub-pass.ts";
import { startSelfHeal1021 } from "../../selfheal-1021.ts";
import { receipts, setupProofFixture } from "../../session-proof-fixture.ts";
import { proveRetainedSession } from "../../session-proof.ts";
import { createCountsBlock, readCountsBlock, startExactCounts } from "../../upgrade-counts.ts";
import type { SiteDriver } from "../commit-site-harness.ts";
import { closeSealed, grantCharge, openTestIndex, testExitThrows } from "../open-index.ts";

type Db = DatabaseSync;
// the product's index file name, in a subfolder of the wiped DATA_DIR
const indexPath = () => { const dir = join(DATA_DIR, "w-site-index"); mkdirSync(dir, { recursive: true }); return join(dir, "memory-index.db"); };
// a real index as the helper leaves it: MemoryIndex.create, then seal + TRUNCATE + the permitted close
const sealedIndex = async () => { const path = indexPath(); await closeSealed(await openTestIndex(path)); return path; };
const metaOf = (path: string, key: string) => { const raw = new DatabaseSync(path, { readOnly: true }); try { return (raw.prepare("SELECT value FROM index_meta WHERE key=?").get(key)?.value ?? null) as string | null; } finally { raw.close(); } };
const tableIn = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name));
const until = async <T>(read: () => T | null, ms = 10_000): Promise<T | null> => { for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 20))) { const v = read(); if (v !== null) return v; } return null; };
const COUNTS_CACHE = () => join(DATA_DIR, "w-site-counts.json"); // not the product's cache name, so no launch count touches it
const counted = async (cacheFile: string) => { const block = createCountsBlock(), worker = startExactCounts(join(DATA_DIR, "messages.db"), cacheFile, block); try { return await until(() => readCountsBlock(block)); } finally { worker.stop(); } };
// a 1.0.20 candidate file: the four pending objects gone (schema.ts), everything else exact
const dropPending = (db: Db) => { for (const name of RECALL_PENDING_OBJECTS) { const row = db.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(name); if (row) db.exec(`DROP ${String(row.type).toUpperCase()} IF EXISTS ${name}`); } };
const legacyFile = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const file = new DatabaseSync(join(dir, "messages.db"));
  file.exec("CREATE TABLE messages(thread_id TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL,role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,json TEXT NOT NULL,PRIMARY KEY(thread_id,id)); CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);");
  migrateMemorySchema(file, "active");
  return file;
};
const change = { kind: "skill", artifactId: "skill-site", label: "Site skill", ownerId: "bot-site", threadId: "t-site", scopeId: "w-site-scope", bundleId: "b-site",
  baseRevision: "r1", beforeRevision: "r1", afterRevision: "r2", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64), receiptId: "rc-site", via: "suggestion" } as const;
let proof: ReturnType<typeof setupProofFixture>;

export const DRIVERS: Record<string, SiteDriver> = {
  "memory/age-index.ts ensureAgeTables#1": {
    conn: "own", why: "the memory index file (its own DatabaseSync), never messages.db",
    setup: () => sealedIndex(),
    run: () => { const raw = new DatabaseSync(indexPath()); try { const had = tableIn(raw, "lexical_age_keys"); ensureAgeTables(raw); return !had && tableIn(raw, "lexical_age_keys"); } finally { raw.close(); } },
  },
  "memory/age-index.ts downTxn#1": {
    conn: "own", why: "downgradeMemoryIndexFile's own DatabaseSync on the memory index file",
    setup: () => sealedIndex(),
    run: async () => { const path = indexPath(), before = metaOf(path, "lexical_rowids"); return before === "age" && (await downgradeMemoryIndexFile(path)) && metaOf(path, "lexical_rowids") === null; },
  },
  "memory/branch-change.ts runBranchChangeSlice#1": {
    conn: "main",
    // a pending change on a thread with no messages: nothing to re-point, so the slice finishes and deletes the row
    setup: db => { db.exec("INSERT INTO branch_change(thread_id,from_id,to_id) VALUES('t-site',NULL,'m-site')"); },
    commit: db => runBranchChangeSlice(db),
  },
  "memory/checkpoint-schema.ts ensureCheckpointSchema#1": {
    conn: "main",
    setup: db => dropEmptyCheckpointSchema(db),
    commit: db => ensureCheckpointSchema(db),
    noMark: "creates the four checkpoint tables and seeds only them (no legacy checkpoint record here)",
  },
  "memory/index-wal.ts IndexWalWriter.writeGranted#1": {
    conn: "own", why: "the index WAL core's writable connection on the memory index file",
    run: async () => { const path = indexPath(), index = await openTestIndex(path); try { return Number((JSON.parse(metaOf(path, "wal_check") ?? "null") as { seq?: number } | null)?.seq ?? 0) >= 1; } finally { await closeSealed(index); } },
  },
  "memory/index-wal.ts IndexWalWriter.stop#2": {
    conn: "own", why: "the index WAL core's writable connection on the memory index file",
    run: () => {
      testExitThrows();
      const opened = openIndexWal(indexPath(), { charge: grantCharge }), wal = opened.wal as IndexWalWriter;
      try {
        try { wal.stop("segment_limit:lexical", "merge", wal.seq); } catch (error) { if (!(error instanceof WalStop)) throw error; }
        return String(opened.writable.prepare("SELECT value FROM index_meta WHERE key='wal_over_stop'").get()?.value ?? "").includes("segment_limit:lexical");
      } finally { wal.closeForQuarantine(); }
    },
  },
  "memory/index-wal.ts runOpenRuleForDowngrade#1": {
    conn: "own", why: "the open rule's writable connection on the memory index file",
    setup: () => sealedIndex(),
    run: async () => { const path = indexPath(), before = metaOf(path, "wal_check"); const verdict = await runOpenRuleForDowngrade(path); return before !== null && verdict.state === "writable" && metaOf(path, "wal_check") === null; },
  },
  "memory/integrity-pass.ts inTransaction#1": {
    conn: "main",
    // a receipt whose output index lost its row, and an unfinished pass: the slice rewrite rebuilds it in one transaction
    setup: db => {
      db.exec(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
        VALUES('b-site','t-site','d','[]','[]','["m-site"]',0,0,0,'delivered',1); DELETE FROM memory_disclosure_outputs WHERE bundle_id='b-site';`);
      beginIntegrityPass(db);
    },
    commit: db => runIntegrityPassToEnd(db, { receiptSlice: 1 }),
  },
  "memory/keepall-unwedge.ts runKeepAllRepair#1": {
    conn: "main",
    // one audience-only deny mark on an owner chat's stored session: one Part A slice deletes it
    setup: db => { db.exec("INSERT INTO memory_revoke_audience(revoke_id) VALUES(4); INSERT INTO memory_deny_session(thread_id,driver_instance,native_session,revoke_id) VALUES('t-site','inst-site','s-1',4)"); },
    commit: db => startKeepAllRepair(db, DATA_DIR, createKeepAllRepairGate(false), {
      ownerSessions: () => ownerAudienceSessions([{ id: "bot-site", tasks: [{ threadId: "t-site", resumeCursors: { "inst-site": "s-1" } }] }], () => true),
      drain: () => false, markerPending: () => false,
      judgeAndClear: () => ({ cleared: 0, botsMoved: 0, skipped: 0, keptChecking: 0, keptLive: 0 }),
      flush: () => {}, log: () => {}, warn: () => {},
    }),
  },
  "memory/learning-ledger.ts recordDefaultLearningConnection#1": {
    conn: "main",
    commit: db => recordDefaultLearningConnection(db, null, true),
  },
  "memory/lessons.ts inTransaction#1": {
    conn: "main",
    commit: db => addLesson(db, { botId: "bot-site", origin: "typed", text: "Keep replies short.", learning: DEFAULT_BOT_LEARNING }),
  },
  "memory/lineage-backfill.ts lineageBackfillSlice#1": {
    conn: "main",
    // a fresh file's certificate is done: put it back to the start of U1
    setup: db => { db.exec("UPDATE memory_lineage_cert SET phase='u1',cursor='',done=0,total=0,ready=0 WHERE id=1"); },
    commit: db => lineageBackfillSlice(db, { budgetMs: 60_000 }),
  },
  "memory/lineage-backfill.ts lineageDowngradeSlice#1": { conn: "main", commit: db => lineageDowngradeSlice(db, { budgetMs: 60_000 }) },
  "memory/outcomes.ts inTransaction#1": {
    conn: "main",
    setup: db => { db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t-site','m-site',1,'bot','text','Done.',?)").run(JSON.stringify({ id: "m-site", role: "bot", kind: "text", text: "Done.", at: 1 })); },
    commit: db => markOutcome(db, { botId: "bot-site", threadId: "t-site", messageId: "m-site", kind: "won" }),
  },
  "memory/park.ts inTransaction#1": {
    conn: "main",
    // the sweep's done flag is per process: start the one-time sweep again
    setup: db => { resetParkSweep(); db.exec("INSERT OR IGNORE INTO memory_scopes VALUES('w-site','workspace','owner-site','[]',0); DELETE FROM memory_scope_bindings WHERE id='memory-parked-sweep'"); },
    commit: db => parkStuckJobsStep(db, () => {}),
  },
  "memory/procedure-landing.ts atomically#1": {
    conn: "main",
    // a change left "publishing" (the outbox row before the skill moved); the boot sweep settles it against a host that cannot read it: held
    setup: db => { insertScope(db, "w-site-scope", "workspace", "owner-site"); recordAppliedChange(db, change, Date.now(), { publishing: true }); },
    commit: db => { setProcedureLandingHost({ base: () => null } as unknown as ProcedureLandingHost); try { return reconcileOutstandingChanges(db); } finally { setProcedureLandingHost(null); } },
  },
  "memory/provenance-stamp.ts RECOMPUTE_WORKER_TEXT>(module)#1": {
    conn: "own", why: "the identity recompute worker thread's own DatabaseSync on messages.db",
    run: async db => { const kept = identityRecomputeStats.kept; return (await recomputeIdentityOffThread(db)) && identityRecomputeStats.kept > kept; },
  },
  "memory/provenance-stamp.ts storeIdentityAllow#2": {
    conn: "main",
    commit: db => storeIdentityAllow(db, durableIdentityStamp(db)!, new Set(["src-site"])),
  },
  "memory/recall-view-schema.ts restoreDroppedPending#1": {
    conn: "main",
    setup: dropPending,
    commit: db => ensureRecallViewSchema(db),
  },

  "memory/release-transaction.ts releaseTransaction#1": {
    conn: "main",
    // the validator writes (a scope through its own producer); a refused write fails validation before the sink, so it rolls back
    commit: db => releaseTransaction(db, { validate: () => { insertScope(db, "w-site-release", "workspace", "owner-release"); }, emit: () => "sent" }),
  },
  "memory/replay-lineage.ts captureSendReplayProof#1": {
    conn: "main",
    // a pre-F7 file: none of the three send-replay tables
    setup: db => { db.exec("DROP TABLE send_replay_exclusions; DROP TABLE send_replay_epochs; DROP TABLE send_attempts;"); },
    commit: db => captureSendReplayProof("t-site", [], new Map(), db),
    noMark: "a read-only snapshot transaction (BEGIN, reads, COMMIT): it writes no table",
  },
  "memory/replay-lineage.ts captureSendReplayProof#2": {
    conn: "main",
    commit: db => captureSendReplayProof("t-site", [], new Map(), db),
    noMark: "a read-only snapshot transaction (BEGIN, reads, COMMIT): it writes no table",
  },
  "memory/restore.ts mergeDestinationMemoryDeletions#1": {
    conn: "own", why: "the merge opens its own DatabaseSync on <candidate>/messages.db (the restore candidate) and commits there",
    run: () => {
      const destination = join(DATA_DIR, "w-site-dest"), candidate = join(DATA_DIR, "w-site-cand");
      const dest = legacyFile(destination);
      dest.prepare("INSERT INTO memory_deny(kind,id,epoch,created_at) VALUES('thread','gone-thread',3,1)").run(); dest.close();
      legacyFile(candidate).close();
      const out = mergeDestinationMemoryDeletions(destination, candidate);
      const merged = new DatabaseSync(join(candidate, "messages.db"));
      try { return out.history === "destination-ledger-preserved" && merged.prepare("SELECT 1 AS x FROM memory_deny WHERE kind='thread' AND id='gone-thread'").get(); } finally { merged.close(); }
    },
  },
  "memory/scope-insert.ts insertScope#1": { conn: "main", commit: db => insertScope(db, "w-site-scope", "workspace", "owner-scope") },
  "memory/scrub-pass.ts walkSlice#1": { conn: "main", setup: db => db.exec(`UPDATE ${SCRUB_PASS_TABLE} SET phase='versions',cursor=0,finished_at=NULL WHERE id=1`), commit: db => stepScrubPass(db) },
  "memory/scrub-pass.ts finish#1": { conn: "main", setup: db => db.exec(`UPDATE ${SCRUB_PASS_TABLE} SET phase='settle',cursor=0,changed=0,finished_at=NULL WHERE id=1`), commit: db => stepScrubPass(db) },
  "memory/scrub-pass.ts stepScrubPass#1": { conn: "main", setup: db => db.exec(`DELETE FROM ${SCRUB_PASS_TABLE}`), commit: db => stepScrubPass(db) },
  "memory/selfheal-1021.ts runSelfHeal#1": {
    conn: "main",
    // one live receipt citing a superseded import chunk whose only newer version has the same words: one slice re-points it
    setup: db => db.exec(`INSERT OR IGNORE INTO memory_scopes VALUES('w-site','workspace','owner-site','[]',0);
      INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('src-site','w-site',NULL,NULL,NULL,1,'h','import','owner','recorded',NULL,'active');
      INSERT INTO memory_source_versions VALUES('src-site',1,'h','{}',1);
      INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,valid_to,supersedes_id,created_at) VALUES
        ('rec-site',1,'w-site','evidence','same words','unverified-import','superseded',0,1,NULL,NULL,1),('rec-site',2,'w-site','evidence','same words','unverified-import','active',0,1,NULL,NULL,1);
      INSERT INTO memory_evidence VALUES('rec-site',1,'src-site',1,0,10),('rec-site',2,'src-site',1,0,10);
      INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at)
        VALUES('b-site','t-site','fixture','session-x','[{"id":"rec-site","version":1}]','[]',0,0,0,'delivered',1);`),
    commit: db => startSelfHeal1021(db, DATA_DIR, { log: () => {}, warn: () => {} }),
  },
  "memory/session-proof.ts proofWork#1": {
    conn: "main",
    // one receipt with the check reset to up_to=0, so the next proof writes the check
    setup: async () => { proof = setupProofFixture("direct"); await receipts(proof, 1); },
    commit: () => proveRetainedSession(LineageAllowance.tool(), proof.key, { access: proof.access, disclosed: true }),
  },
  "memory/upgrade-counts.ts COUNT_AT_REVISION_SOURCE>countAtRevision#1": {
    conn: "own", why: "the exact-counts worker thread's own read-only connection on messages.db",
    // a cache keyed on the current revision: the worker answers from it (a sentinel figure) through the early COMMIT
    run: async db => {
      const r = db.prepare("SELECT epoch,n FROM app_write_revision WHERE id=1").get()!;
      writeFileSync(COUNTS_CACHE(), JSON.stringify({ v: 2, key: `${r.epoch}:${r.n}`, counts: { messages: 7777, conversations: 1, memoryRecords: 0, receipts: 0, firstMessageAt: 1 } }));
      return (await counted(COUNTS_CACHE()))?.messages === 7777;
    },
  },
  "memory/upgrade-counts.ts COUNT_AT_REVISION_SOURCE>countAtRevision#2": {
    conn: "own", why: "the exact-counts worker thread's own read-only connection on messages.db",
    run: async db => { const c = await counted(COUNTS_CACHE()); return c !== null && c.messages === Number(db.prepare("SELECT count(*) AS n FROM messages").get()!.n); },
  },
};
