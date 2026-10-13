// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A synthetic 1.0.1 history (memory v6) of any size, for the upgrade tests (upgrade-fast.test.ts) and the timed upgrade run
// (testing/upgrade-fast-child.ts). Rows are written by SQL in bulk, never through the app, so a multi-gigabyte file takes minutes to make:
//   - `threads` conversations of `perThread` messages each (a proven parent chain, a user message then a bot reply, `payloadBytes` of filler in each);
//   - `receiptsPerThread` memory receipts per conversation, each naming two bot replies as its outputs (the v6 output index is kept by the triggers);
//   - `setThreads` long conversations whose replies each rest on a FULL root set of the outputs before them (v6 stored them in full:
//     the member index that the upgrade drops, and the sets the background conversion shrinks);
//   - the search index over all message text, the shape marker at schema 6 (what 1.0.1 wrote), no lineage-repair marker, no open-card index and no browser-check table.
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { initializeInbox } from "../../inbox.ts";
import { initializeMessageTables } from "../../message-tables.ts";
import { downgradeMemorySchema, migrateMemorySchema, validateMemorySchema } from "../schema.ts";

export interface SyntheticV6Options {
  threads: number; perThread: number; payloadBytes?: number;
  receiptsPerThread?: number; setThreads?: number; repliesPerSetThread?: number;
  /** Threads written per transaction. */
  batch?: number;
}
export interface SyntheticV6 { path: string; messages: number; receipts: number; memberRows: number; bytes: number }

export function buildSyntheticV6(path: string, options: SyntheticV6Options): SyntheticV6 {
  const { threads, perThread, payloadBytes = 1_000, receiptsPerThread = 1, setThreads = 0, repliesPerSetThread = 0, batch = 500 } = options;
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-262144;");
  try {
    // (1.0.1 already had the inbox indexes over messages, so the open finds them and builds nothing)
    initializeMessageTables(db); initializeInbox(db);
    migrateMemorySchema(db, "active");
    // the current schema, taken back to what 1.0.1 wrote
    downgradeMemorySchema(db, 6);
    const installation = String(db.prepare("SELECT installation_id FROM memory_meta WHERE id=1").get()!.installation_id);
    db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('scope-workspace','workspace',?,'[]',0)").run(installation);
    const insertThreads = db.prepare(`
      WITH RECURSIVE tn(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM tn WHERE n<?2), sn(k) AS (SELECT 0 UNION ALL SELECT k+1 FROM sn WHERE k<?3-1)
      INSERT INTO messages(thread_id,id,at,role,kind,text,json)
      SELECT 't'||tn.n, 'm'||tn.n||'-'||sn.k, 1000+sn.k, CASE sn.k%2 WHEN 0 THEN 'user' ELSE 'bot' END, 'text', 'hello world '||tn.n||' '||sn.k,
        json_object('id','m'||tn.n||'-'||sn.k,'at',1000+sn.k,'role',CASE sn.k%2 WHEN 0 THEN 'user' ELSE 'bot' END,'kind','text','text','hello world '||tn.n||' '||sn.k,
          'parentId',CASE sn.k WHEN 0 THEN NULL ELSE 'm'||tn.n||'-'||(sn.k-1) END,'pad',hex(randomblob(?4/2)))
      FROM tn, sn`);
    const insertState = db.prepare("WITH RECURSIVE tn(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM tn WHERE n<?2) INSERT INTO thread_state(thread_id,active_leaf_id) SELECT 't'||n,'m'||n||'-'||(?3-1) FROM tn");
    const insertReceipts = db.prepare(`
      WITH RECURSIVE tn(n) AS (SELECT ?1 UNION ALL SELECT n+1 FROM tn WHERE n<?2), rn(j) AS (SELECT 0 UNION ALL SELECT j+1 FROM rn WHERE j<?3-1)
      INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
      SELECT printf('b%07d-%03d',tn.n,rn.j),'t'||tn.n,'claude',NULL,'[]','[]',json_array('m'||tn.n||'-'||(4*rn.j+1),'m'||tn.n||'-'||(4*rn.j+3)),0,0,0,'delivered',1000 FROM tn, rn`);
    const half = Math.max(1, Math.floor(perThread / 4));
    let receipts = 0;
    for (let first = 0; first < threads; first += batch) {
      const last = Math.min(threads - 1, first + batch - 1);
      db.exec("BEGIN");
      insertThreads.run(BigInt(first), BigInt(last), BigInt(perThread), BigInt(payloadBytes));
      insertState.run(BigInt(first), BigInt(last), BigInt(perThread));
      // a receipt's outputs are bot replies at positions 4j+1 and 4j+3: keep j within the thread
      insertReceipts.run(BigInt(first), BigInt(last), BigInt(Math.min(receiptsPerThread, half)));
      receipts += (last - first + 1) * Math.min(receiptsPerThread, half);
      db.exec("COMMIT");
    }
    // v6 stored every reply's root set in full
    let memberRows = 0;
    if (setThreads > 0 && repliesPerSetThread > 0) {
      const sets = db.prepare("WITH RECURSIVE jn(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM jn WHERE j<?2) INSERT INTO memory_root_sets(set_id,size) SELECT 'rs1:t'||?1||'-'||j, j FROM jn");
      const members = db.prepare(`WITH RECURSIVE jn(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM jn WHERE j<?2), mn(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM mn WHERE i<?2)
        INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) SELECT 'rs1:t'||?1||'-'||jn.j,'t'||?1,'m'||?1||'-'||(2*mn.i-1) FROM jn, mn WHERE mn.i<=jn.j`);
      const roots = db.prepare("WITH RECURSIVE jn(j) AS (SELECT 1 UNION ALL SELECT j+1 FROM jn WHERE j<?2) INSERT INTO memory_output_roots(thread_id,message_id,set_id) SELECT 't'||?1,'m'||?1||'-'||(2*j-1),'rs1:t'||?1||'-'||j FROM jn");
      db.exec("BEGIN");
      for (let t = 0; t < setThreads; t++) {
        const n = BigInt(t), r = BigInt(repliesPerSetThread);
        sets.run(n, r); members.run(n, r); roots.run(n, r);
        memberRows += (repliesPerSetThread * (repliesPerSetThread + 1)) / 2;
        if (t % 20 === 19) { db.exec("COMMIT"); db.exec("BEGIN"); }
      }
      db.exec("COMMIT");
    }
    // 1.0.1 had none of the derived transcript tables added since (open cards, first rows of turns, branch walks, pending browser checks): the open fills them
    db.exec("DROP TABLE IF EXISTS open_card; DROP TABLE IF EXISTS turn_first; DROP TABLE IF EXISTS card_branch; DROP TABLE IF EXISTS branch_walk; DROP TABLE IF EXISTS browser_check_pending; DROP TABLE IF EXISTS transcript_index_state");
    // what 1.0.1 had: the search index over every message, and the shape marker at schema 6
    db.exec("INSERT INTO messages_fts(rowid,t) SELECT rowid,text FROM messages WHERE kind='text'");
    validateMemorySchema(db, { incrementalShapes: true });
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const messages = Number(db.prepare("SELECT count(*) AS n FROM messages").get()!.n);
    return { path, messages, receipts, memberRows, bytes: statSync(path).size };
  } finally { db.close(); }
}
