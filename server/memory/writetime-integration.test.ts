// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time integration (Murage 1.0.2): the cross-slice pieces that only connect once S1 to S5 are merged, and the storage items of
// STORAGE-AUDIT folded into the integration: receipt flips and the receipt range seam, the v10 flow-edge and watermark triggers, root sets
// frozen across a 1.0.1 (v6) upgrade, and the root-set reclaim (drop, VACUUM, idle gate, kill and resume, downgrade after it).
import { copyFileSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { denyLookup } from "./deny-read.ts";
import { linkMemoryDisclosureOutput } from "./disclosures.ts";
import { lineageBackfillSlice } from "./lineage-backfill.ts";
import { closeTurnLineage, openTurnLineage } from "./lineage-write.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { REVOKE_FOLD } from "./revoke-fold.ts";
import { lineageStorageStatus } from "./root-set-compaction.ts";
import { fileAndLiveBytes, lastReclaimStats, reclaimShortOfDisk, reclaimWorkerSourceForTest, RECLAIM_MAX_BATCH_PAGES, RECLAIM_MAX_BATCH_ROWS, nextReclaimStep, reclaimRootSetsWhenIdle, reclaimVacuumWaiting, registeredRetiredObjects, registerRetiredObjects, ROOT_SET_RECLAIM_TABLES, runReclaimStep, setReadTimeJudgeRetired, type ReclaimGate } from "./root-set-reclaim.ts";
import { downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "./schema.ts";
import { migrateMemorySchema as migrateAs101, storeRootSet } from "./testing/schema-1.0.1.ts";
import { runBackgroundUpgradeWorkToEnd } from "./upgrade-background.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string) => msg(id, { role: "user" });
const CONTENT = { audience: null } as const;
const verdict = (thread: string, id: string, author: "owner" | "generated" = "generated") => denyLookup(database(), { threadId: thread, lines: [{ messageId: id, author }] }, CONTENT).get(id)!;

function reset(): void { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }

describe("receipts: every path that revokes one reaches the lines it produced (flip trigger, receipt range)", () => {
  beforeEach(reset);

  /** A thread: owner line, then a reply made with receipt `rc`, then two more generated lines and an owner line between them. */
  function receiptThread(): void {
    appendMessage("t", owner("o1"));
    appendMessage("t", msg("r1", { parentId: "o1" }));
    database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc','t','d','s','[]','[]','[]',0,0,0,'delivered',1)").run();
    linkMemoryDisclosureOutput("rc", "r1");
    appendMessage("t", { ...owner("o2"), parentId: "r1" });
    appendMessage("t", msg("r2", { parentId: "o2" }));
  }

  it("a receipt turned 'revoked' by plain SQL holds its lines for an audience reader at once, withholds them once the marker ran, and resets its session; the content judge (owner's direct chat, rooms) still shows them, as in 1.0.1", () => {
    receiptThread();
    const AUD = { audience: { owner: false, scopeIds: [] as string[] } };
    const as = (reader: typeof AUD | typeof CONTENT, id: string) => denyLookup(database(), { threadId: "t", lines: [{ messageId: id, author: "generated" }] }, reader).get(id)!;
    expect(database().prepare("SELECT s.native_session FROM memory_receipt_lines r JOIN memory_session_no s ON s.no=r.session_no WHERE r.bundle_id='rc'").get()).toEqual({ native_session: "s" });
    expect(as(AUD, "r1").state).toBe("shown");
    // a path that knows nothing of write-time (settings, restore, a roster or branch revoke, the bookkeeping job) flips the receipt
    database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='rc'").run();
    expect(database().prepare("SELECT count(*) AS n FROM memory_receipt_flips").get()).toEqual({ n: 1 });
    expect(as(AUD, "r1")).toEqual({ state: "checking", reason: "pending" });
    expect(as(AUD, "r2")).toEqual({ state: "checking", reason: "pending" });
    expect(as(CONTENT, "r1").state).toBe("shown"); // the RC judged a receipt's state for audience readers only
    expect(verdict("t", "o1", "owner").state).toBe("shown"); // owner lines never wait
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(database().prepare("SELECT count(*) AS n FROM memory_receipt_flips").get()).toEqual({ n: 0 });
    expect(database().prepare("SELECT count(*) AS n FROM memory_revoke_audience").get()).toEqual({ n: 1 });
    expect(as(AUD, "r1").state).toBe("withheld");
    expect(as(AUD, "r2").state).toBe("withheld"); // positional: a later reply could rest on it
    expect(as(CONTENT, "r1").state).toBe("shown");
    expect(as(CONTENT, "r2").state).toBe("shown");
    expect(verdict("t", "o2", "owner").state).toBe("shown");
    expect(database().prepare("SELECT driver_instance,native_session FROM memory_deny_session WHERE thread_id='t'").all()).toEqual([{ driver_instance: "d", native_session: "s" }]);
  });

  it("a receipt whose cited content is gone (receipt-content) withholds its lines from every reader, the content judge included", () => {
    receiptThread();
    commitRevoke(database(), { kind: "receipt", bundleId: "rc", cause: "receipt-content" });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(database().prepare("SELECT count(*) AS n FROM memory_revoke_audience").get()).toEqual({ n: 0 });
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r2").state).toBe("withheld");
  });

  it("audience-only ranges coalesce apart from the others: a content reader never inherits them through the sticky row", () => {
    receiptThread();
    // every one of the 70 revokes walks on its own id, so the thread holds more than DENY_RANGE_COALESCE range rows: the inline walks
    // beyond the minute's write budget (revoke-budget.ts) are left to the drain, and the 1.0.3 revoke fold, which would take those over
    // as one bulk with one range row, is off here (its own tests cover it: revoke-fold.test.ts)
    REVOKE_FOLD.enabled = false;
    try {
      for (let k = 0; k < 70; k++) commitRevoke(database(), { kind: "receipt", bundleId: "rc", cause: "receipt-revoked" }); // past DENY_RANGE_COALESCE
      drainRevokeMarker(database());
    } finally { REVOKE_FOLD.enabled = true; }
    const ids = database().prepare("SELECT DISTINCT revoke_id AS r FROM memory_deny_range WHERE thread_id='t'").all().map(row => Number(row.r));
    expect(ids).toContain(-2);
    expect(ids).not.toContain(-1);
    expect(verdict("t", "r2").state).toBe("shown");
  });

  it("the receipt revoke's window starts exactly at its first output, whatever the RC table lists (never at the thread's start past 64 outputs)", () => {
    receiptThread();
    const first = Number(database().prepare("SELECT first_lsn FROM memory_receipt_lines WHERE bundle_id='rc'").get()!.first_lsn);
    const r1 = Number(database().prepare("SELECT l.lsn FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no WHERE t.thread_id='t' AND l.message_id='r1'").get()!.lsn);
    expect(first).toBe(r1);
    // 70 outputs listed in the RC's table: the write-time model never reads it
    for (let k = 0; k < 70; k++) database().prepare("INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES('rc','t',?)").run(`ghost${k}`);
    const R = commitRevoke(database(), { kind: "receipt", bundleId: "rc", cause: "receipt-revoked" });
    expect(database().prepare("SELECT root_lsn FROM memory_revoke_jobs WHERE revoke_id=?").get(R)).toEqual({ root_lsn: first });
    expect(verdict("t", "o1", "owner").state).toBe("shown");
  });
});

describe("a branch change revokes the branch it leaves, never the new branch's own turn", () => {
  beforeEach(reset);
  const inTurn = (thread: string, turnId: string, write: () => void) => {
    const turn = openTurnLineage(database(), { threadId: thread, turnId });
    try { write(); } finally { closeTurnLineage(turn); }
  };

  it("edit and resend: the rerun's reply stays shown, the abandoned reply is withheld", () => {
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    appendMessage("t", owner("o1b")); // the edited question: a new branch from the thread's root
    inTurn("t", "turn-2", () => appendMessage("t", msg("r2", { parentId: "o1b" })));
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r2").state).toBe("shown");
    expect(verdict("t", "o1b", "owner").state).toBe("shown");
  });

  it("edit and resend through the server's order (the rerun's turn is admitted before the fork appends the edited line): its reply stays shown", () => {
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    inTurn("t", "turn-2", () => { appendMessage("t", owner("o1b")); appendMessage("t", msg("r2", { parentId: "o1b" })); });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r2").state).toBe("shown");
  });

  it("regenerate: the regenerated reply stays shown, the one it replaces is withheld", () => {
    appendMessage("t", owner("o1"));
    inTurn("t", "turn-1", () => appendMessage("t", msg("r1", { parentId: "o1" })));
    inTurn("t", "turn-2", () => appendMessage("t", msg("r1b", { parentId: "o1" })));
    expect(drainRevokeMarker(database()).pending).toBe(false);
    expect(verdict("t", "r1").state).toBe("withheld");
    expect(verdict("t", "r1b").state).toBe("shown");
  });
});

describe("v10 triggers: every memory writer leaves its flow edge, every policy or epoch bump moves the watermark", () => {
  beforeEach(reset);

  it("evidence, derivations and a scope move write scope -> scope edges; a capture writes thread -> scope", () => {
    const db = database();
    for (const scope of ["A", "B", "C"]) db.prepare("INSERT INTO memory_scopes(id,kind,owner_key,audience,revision) VALUES(?,'conversation',?,'[]',0)").run(scope, scope);
    db.prepare("INSERT INTO memory_sources VALUES('s1','A','thr','m1',NULL,1,'h','text','bot','settled',NULL,'active')").run();
    db.prepare("INSERT INTO memory_source_versions(source_id,revision,content_hash,payload,created_at) VALUES('s1',1,'h','{}',1)").run();
    db.prepare("INSERT INTO memory_records VALUES('r1',1,'B','fact','x','assistant-inference','active',0,1,NULL,NULL,1)").run();
    db.prepare("INSERT INTO memory_evidence(record_id,record_version,source_id,source_revision,start_byte,end_byte) VALUES('r1',1,'s1',1,0,1)").run();
    db.prepare("INSERT INTO memory_records VALUES('r2',1,'C','fact','y','assistant-inference','active',0,1,NULL,NULL,1)").run();
    db.prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES('r1',1,'r2',1)").run();
    const edges = db.prepare("SELECT from_thread,to_thread FROM memory_thread_flow ORDER BY 1,2").all();
    expect(edges).toEqual([{ from_thread: "scope:A", to_thread: "scope:B" }, { from_thread: "scope:B", to_thread: "scope:C" }, { from_thread: "thr", to_thread: "scope:A" }]);
  });

  it("a policy bump made outside any revoke moves policy_bump_lsn past every receipt folded before it, and the deny generation", () => {
    const db = database();
    const before = Object.fromEntries(db.prepare("SELECT key,value FROM memory_lineage_lsn_meta").all().map(row => [row.key, Number(row.value)]));
    const next = Number(db.prepare("SELECT next FROM memory_lsn").get()!.next);
    db.exec("UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1");
    const after = Object.fromEntries(db.prepare("SELECT key,value FROM memory_lineage_lsn_meta").all().map(row => [row.key, Number(row.value)]));
    expect(after.policy_bump_lsn).toBe(next + 1);
    expect(after.epoch_bump_lsn).toBe(before.epoch_bump_lsn);
    expect(after.deny_generation).toBe(before.deny_generation! + 1);
  });
});

// ---- standalone files: the v6 upgrade and the reclaim
const dirs: string[] = [], dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch { /* closed */ } } for (const dir of dirs.splice(0)) removeTempDirSync(dir); setReadTimeJudgeRetired(false); });
function file(name = "messages.db"): { db: DatabaseSync; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "murage-writetime-int-")); dirs.push(dir);
  const path = join(dir, name);
  const db = new DatabaseSync(path); dbs.push(db);
  return { db, path };
}
const rootSetRows = (db: DatabaseSync) => Object.fromEntries(ROOT_SET_RECLAIM_TABLES.filter(table => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table))
  .map(table => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]));

describe("root sets are never written again: a 1.0.1 (v6) upgrade converts into none", () => {
  it("the upgrade, its background jobs and the write-time backfill leave the v6 sets exactly as they were, and add no root-set row", () => {
    const { db } = file();
    migrateAs101(db, "active");
    db.exec("INSERT INTO memory_scopes VALUES('scope','conversation','thread','[]',0)");
    // two v6 full sets, the second a superset of the first (the v7 conversion would cut it into a chain)
    const first = storeRootSet(db, ["t\u0000a", "t\u0000b"]), second = storeRootSet(db, ["t\u0000a", "t\u0000b", "t\u0000c"]);
    db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES('t','r1',?),('t','r2',?)").run(first, second);
    const before = rootSetRows(db);
    migrateMemorySchema(db);
    runBackgroundUpgradeWorkToEnd(db, {});
    for (let slices = 0; lineageBackfillSlice(db, { budgetMs: 500 }).more; slices++) if (slices > 10_000) throw new Error("no end");
    const after = rootSetRows(db);
    expect(after.memory_root_set_members).toBe(before.memory_root_set_members);
    expect(after.memory_root_sets).toBe(before.memory_root_sets);
    expect(after.memory_output_roots).toBe(before.memory_output_roots);
    expect(after.memory_root_set_parents).toBe(0);
    expect(after.memory_root_set_compaction).toBe(0);
  });
});

describe("the root-set reclaim (1.0.2): drop, then one VACUUM to incremental, only when the owner is idle", () => {
  const MEMBERS = 400_000;
  /** A certified v10 file holding a large v6-shaped member table and its index. */
  function bloated(options: { members?: number; wal?: boolean; incremental?: boolean } = {}): { db: DatabaseSync; path: string; rootBytes: number } {
    const made = file();
    const db = made.db;
    const members = options.members ?? MEMBERS;
    if (options.incremental) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
    if (options.wal) db.exec("PRAGMA journal_mode=WAL");
    migrateMemorySchema(db);
    db.exec("CREATE INDEX IF NOT EXISTS memory_root_set_members_root ON memory_root_set_members(root_thread_id,root_message_id)");
    db.exec("BEGIN");
    db.prepare(`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id)
      SELECT 'rs:'||printf('%060d',i/700),'thread-'||printf('%029d',i%97),'message-'||printf('%028d',i) FROM c`).run(members);
    db.prepare(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<?) INSERT INTO memory_root_sets(set_id,size) SELECT 'rs:'||printf('%060d',i),700 FROM c`).run(Math.floor(members / 700));
    db.exec("COMMIT");
    const pages = Number(db.prepare("PRAGMA page_count").get()!.page_count), size = Number(db.prepare("PRAGMA page_size").get()!.page_size);
    expect(Number(db.prepare("SELECT ready FROM memory_lineage_cert").get()!.ready)).toBe(1);
    return { ...made, rootBytes: pages * size };
  }
  const idle: ReclaimGate = { ownerIdleMs: () => 3_600_000, liveTurn: () => false, typingHeld: () => false, routineDueWithin: () => false, healthAnswered: () => true, integrityPending: () => false, revocationWaiting: () => false };

  it("hands the space back: each object in its own step, then a VACUUM; the file is at most 1.25 x its live bytes; the validator accepts it", () => {
    const { db, rootBytes } = bloated();
    // every step is a short batch: the longest one is the longest the owner's writes can wait on the reclaim
    const longest: Record<string, number> = {}, sums: Record<string, number> = {};
    for (let steps = 0; steps < 200_000; steps++) {
      const { step, ms } = runReclaimStep(db, { freeDiskBytes: () => null });
      if (step.kind === "done") break;
      const name = step.kind === "vacuum" ? "vacuum" : step.kind === "shrink" ? "shrink" : `${step.kind}:${step.name}`;
      longest[name] = Math.max(longest[name] ?? 0, ms); sums[name] = (sums[name] ?? 0) + ms;
    }
    expect(nextReclaimStep(db).kind).toBe("done");
    for (const table of ROOT_SET_RECLAIM_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    expect(Number(db.prepare("PRAGMA auto_vacuum").get()!.auto_vacuum)).toBe(2);
    const { file: onDisk, live } = fileAndLiveBytes(db);
    expect(onDisk).toBeLessThanOrEqual(live * 1.25);
    expect(() => validateMemorySchema(db)).not.toThrow();
    expect(Number(db.prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='root_sets_dropped'").get()!.value)).toBe(1);
    const sliced = Object.entries(longest).filter(([name]) => name !== "vacuum");
    console.log(`WRITETIME-RECLAIM fixture ${(rootBytes / 1024 ** 2).toFixed(1)} MB; longest write-lock hold per step kind ${sliced.map(([name, ms]) => `${name} ${ms.toFixed(0)} ms`).join(", ")}; all steps ${Object.values(sums).reduce((a, b) => a + b, 0).toFixed(0)} ms; vacuum (one statement, the file was not incremental) ${(longest.vacuum ?? 0).toFixed(0)} ms`);
    // a batch is sized to RECLAIM_BATCH_MS, whatever the table holds (a single DROP of the owner's 4.2 GB held writes 1.1-2.0 s)
    expect(Math.max(...sliced.map(([, ms]) => ms))).toBeLessThan(250);
  }, 3_600_000);

  it("a large table is emptied in batches: the owner's connection, writing all through the run, never waits 250 ms for the write lock (the file was made incremental)", { tags: ["perf-budget"], timeout: 3_600_000 }, async () => {
    const { db, path } = bloated({ members: 2_500_000, wal: true, incremental: true });
    const owner = new DatabaseSync(path); dbs.push(owner);
    owner.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner_beat(n INTEGER)");
    setReadTimeJudgeRetired(true);
    const waits: number[] = [];
    let running = true;
    const run = reclaimRootSetsWhenIdle(db, idle, { freeDiskBytes: () => null }).finally(() => { running = false; });
    while (running) {
      const asked = performance.now();
      owner.exec("BEGIN IMMEDIATE");
      waits.push(performance.now() - asked);
      owner.exec("INSERT INTO owner_beat(n) VALUES(1)");
      owner.exec("COMMIT");
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    expect(await run).toBe("done");
    const stats = lastReclaimStats();
    const worst = Math.max(...waits);
    console.log(`WRITETIME-RECLAIM-WAIT ${(2_500_000).toLocaleString()} member rows; ${waits.length} owner writes during the run; longest wait for the write lock ${worst.toFixed(0)} ms; ${stats.batches} reclaim batches, longest ${stats.maxBatchMs.toFixed(0)} ms; reclaim busy ${stats.totalMs.toFixed(0)} ms`);
    expect(waits.length).toBeGreaterThan(5);
    expect(worst).toBeLessThan(250);
    expect(stats.maxBatchMs).toBeLessThan(250);
    // the time bound is backed by a bound on the work of one batch: rows and pages never exceed the hard caps, whatever the clock said
    expect(stats.maxRows ?? 0).toBeGreaterThan(0);
    expect(stats.maxRows ?? 0).toBeLessThanOrEqual(RECLAIM_MAX_BATCH_ROWS);
    expect(stats.maxPages ?? 0).toBeLessThanOrEqual(RECLAIM_MAX_BATCH_PAGES);
    expect(nextReclaimStep(db).kind).toBe("done");
    for (const table of ROOT_SET_RECLAIM_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    expect(Number(db.prepare("PRAGMA freelist_count").get()!.freelist_count)).toBe(0);
    expect(Number(db.prepare("SELECT count(*) AS n FROM owner_beat").get()!.n)).toBe(waits.length);
  });

  it("the reclaim worker's connection: no checkpoint inside a batch, journal_size_limit=0 as on the other connections (P3-9)", () => {
    const source = reclaimWorkerSourceForTest();
    expect(source).toContain("PRAGMA wal_autocheckpoint=0");
    expect(source).toContain("PRAGMA journal_size_limit=0");
    expect(source).toContain("PRAGMA synchronous=NORMAL"); // no fsync of the log under the write lock
    // the log is copied back between batches, PASSIVE, never under the write lock
    expect(source).toContain("wal_checkpoint(PASSIVE)");
  });

  it("the VACUUM wants about twice the live bytes free, not live plus 64 MB (P3-10)", () => {
    const { db } = bloated({ members: 2000 });
    setReadTimeJudgeRetired(true);
    for (let steps = 0; steps < 100_000 && nextReclaimStep(db).kind !== "vacuum"; steps++) runReclaimStep(db, { freeDiskBytes: () => null });
    expect(nextReclaimStep(db).kind).toBe("vacuum");
    const { live } = fileAndLiveBytes(db);
    expect(live).toBeGreaterThan(0);
    expect(reclaimShortOfDisk(db, () => live * 2 - 1)).toBe(true);
    expect(reclaimShortOfDisk(db, () => live * 2)).toBe(false);
    expect(runReclaimStep(db, { freeDiskBytes: () => live * 2 - 1 }).skippedForDisk).toBe(true);
  });

  it("objects another lane retired register by name and are handed back by the same sliced reclaim (msearch2's owner tail index, hotpath's inbox tables)", () => {
    const { db } = bloated({ members: 2000 });
    db.exec(`CREATE TABLE hp_retired_inbox(id INTEGER PRIMARY KEY, body TEXT); CREATE TABLE hp_retired_keyed(a TEXT, b TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID; CREATE INDEX ms_owner_tail ON hp_retired_inbox(body)`);
    db.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<3000) INSERT INTO hp_retired_inbox(id,body) SELECT i,'b'||i FROM c; WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<3000) INSERT INTO hp_retired_keyed SELECT 'a'||i,'b' FROM c");
    expect(() => registerRetiredObjects("hotpath", { tables: [{ name: "x; DROP TABLE messages" }] })).toThrow("MEMORY_RECLAIM_BAD_OBJECT");
    registerRetiredObjects("msearch2", { indexes: ["ms_owner_tail"] });
    registerRetiredObjects("hotpath", { tables: [{ name: "hp_retired_inbox" }, { name: "hp_retired_keyed", key: ["a", "b"] }] });
    try {
      expect(registeredRetiredObjects().sort()).toEqual(["hotpath", "msearch2"]);
      for (let steps = 0; steps < 100_000 && runReclaimStep(db, { freeDiskBytes: () => null }).step.kind !== "done"; steps++) { /* to the end */ }
      for (const name of ["hp_retired_inbox", "hp_retired_keyed", "ms_owner_tail"]) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name), name).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_lsn'").get()).toBeTruthy();
    } finally { registerRetiredObjects("msearch2", {}); registerRetiredObjects("hotpath", {}); }
  }, 3_600_000);

  it("never runs during a live turn or typing, before health answered, or before the read-time judge is retired; resumes after a kill", { tags: ["nightly"], timeout: 3_600_000 }, async () => {
    const { db } = bloated();
    const tables = () => ROOT_SET_RECLAIM_TABLES.filter(table => db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)).length;
    const all = tables();
    // the read-time judge still reads the sets until S6 retires it
    expect(await reclaimRootSetsWhenIdle(db, idle, { freeDiskBytes: () => null })).toBe("waiting");
    setReadTimeJudgeRetired(true);
    for (const busy of [{ liveTurn: () => true }, { typingHeld: () => true }, { routineDueWithin: () => true }, { healthAnswered: () => false }, { integrityPending: () => true }, { revocationWaiting: () => true }]) {
      expect(await reclaimRootSetsWhenIdle(db, { ...idle, ...busy }, { freeDiskBytes: () => null })).toBe("waiting");
      expect(tables()).toBe(all);
      expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='memory_root_set_members_root'").get()).toBeTruthy();
    }
    // a run killed after its first batches (here: three taken by hand) carries on from what the file holds
    const before = Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()!.n);
    for (let batches = 0; batches < 3; batches++) runReclaimStep(db, { freeDiskBytes: () => null });
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()!.n)).toBeLessThan(before);
    expect(tables()).toBe(all);
    expect(await reclaimRootSetsWhenIdle(db, idle, { freeDiskBytes: () => null })).toBe("done");
    expect(tables()).toBe(0);
  });

  it("with the owner at the Mac the tables are emptied beside them and no writer is held; the one VACUUM (the button path too) waits for idle, then runs", { tags: ["nightly"], timeout: 3_600_000 }, async () => {
    const { db } = bloated();
    setReadTimeJudgeRetired(true);
    const holds: boolean[] = [];
    const hold = (on: boolean) => { holds.push(on); };
    const atTheMac: ReclaimGate = { ...idle, ownerIdleMs: () => 1_000 };
    expect(await reclaimRootSetsWhenIdle(db, atTheMac, { freeDiskBytes: () => null, hold })).toBe("waiting");
    for (const table of ROOT_SET_RECLAIM_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
    expect(nextReclaimStep(db).kind).toBe("vacuum");
    expect(holds).toEqual([]);
    expect(reclaimVacuumWaiting()).toBe(true);
    expect(lineageStorageStatus(db)).toMatchObject({ state: "waiting", reason: "vacuum-idle" });
    expect(Number(db.prepare("PRAGMA auto_vacuum").get()!.auto_vacuum)).not.toBe(2);
    // pressing the button again changes nothing about the wait: still no held writers
    expect(await reclaimRootSetsWhenIdle(db, atTheMac, { freeDiskBytes: () => null, hold })).toBe("waiting");
    expect(holds).toEqual([]);
    // away for ten minutes: the one rewrite runs with the writers held, and the file is incremental after it
    expect(await reclaimRootSetsWhenIdle(db, { ...idle, ownerIdleMs: () => 10 * 60_000 }, { freeDiskBytes: () => null, hold })).toBe("done");
    expect(holds).toEqual([true, false]);
    expect(Number(db.prepare("PRAGMA auto_vacuum").get()!.auto_vacuum)).toBe(2);
    expect(reclaimVacuumWaiting()).toBe(false);
  });

  it("a downgrade after the hand-back makes the v9 tables again, empty, and marks every generated line unprovable for the older build", () => {
    const { db, path } = bloated();
    for (let steps = 0; steps < 200_000 && runReclaimStep(db, { freeDiskBytes: () => null }).step.kind !== "done"; steps++) { /* to the end */ }
    db.exec("CREATE TABLE IF NOT EXISTS messages(thread_id TEXT, id TEXT, at INTEGER, role TEXT, kind TEXT, text TEXT, json TEXT, PRIMARY KEY(thread_id,id))");
    db.prepare("INSERT INTO memory_thread_no(thread_id,no) VALUES('old',1)").run();
    db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(1,-5,'g',-6,NULL,NULL),(1,-4,'o',NULL,NULL,NULL)").run();
    copyFileSync(path, `${path}.before`);
    expect(downgradeMemorySchema(db, 9).status).toBe("downgraded");
    expect(db.prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='old' AND message_id='g'").get()).toEqual({ set_id: "" });
    expect(db.prepare("SELECT 1 AS x FROM memory_output_roots WHERE message_id='o'").get()).toBeUndefined();
    expect(Number(db.prepare("SELECT count(*) AS n FROM memory_root_set_members").get()!.n)).toBe(0);
    expect(statSync(`${path}.before`).size).toBeGreaterThan(0);
  }, 3_600_000);
});
