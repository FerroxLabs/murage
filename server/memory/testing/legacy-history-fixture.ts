// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test tree only. A history in the form 1.0.1 and the RC left it (messages, receipts, captured replies, root sets, copies, sessions), on a v10
// file marked as upgraded (memory_lineage_cert at u1, not ready), for the backfill tests and the write-time differential. Seeded and
// deterministic: the same options give the same rows.
import type { DatabaseSync } from "node:sqlite";
import { chainStore } from "../schema.ts";
import { ensureScope, reconcileMemoryRoster } from "../policy.ts";
import { setMemoryMode } from "../repository.ts";

export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface LegacyLine { id: string; role: "user" | "bot"; captured: boolean; receipt: string | null; copyOf?: { threadId: string; messageIds: string[] }; branch?: boolean }
export interface LegacyHistory {
  threads: string[];
  lines: Map<string, LegacyLine[]>;
  docs: string[];
  receipts: string[];
  sessions: Array<{ threadId: string; driverInstance: string; nativeSession: string }>;
  scopeOf: Map<string, string>;
}
export interface LegacyOptions {
  seed: number;
  /** Conversations (one bot each). */
  threads: number;
  /** Lines per conversation (half owner, half bot). */
  lines: number;
  /** One extra conversation this long (the long-thread case). */
  longThread?: number;
  /** Share of bot lines with a receipt, captured, copied, given a root set (defaults 0.5, 0.5, 0.05, 0.6). */
  receipts?: number; captured?: number; copies?: number; rootSets?: number;
  /** With this set, every line names its parent (json.parentId), and this share of the bot lines are BRANCH replies (a regenerated or edited turn):
   * the reply names an older owner line as its parent and the main path goes on without it, so a later line does not descend from it. Without
   * it no line names a parent (a flat 1.0.1 file: the thread is one chain in write order). */
  branches?: number;
}

export const messageSource = (thread: string, message: string) => `message:${thread}:${message}`;

/** Writes the history in one transaction. Message `at` follows insertion order, so rowid and time agree. */
export function buildLegacyHistory(db: DatabaseSync, options: LegacyOptions): LegacyHistory {
  const random = prng(options.seed), pick = (n: number) => Math.floor(random() * n);
  const threadIds = Array.from({ length: options.threads }, (_, at) => `wt-${options.seed}-t${at}`);
  if (options.longThread) threadIds.push(`wt-${options.seed}-long`);
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: threadIds.map((threadId, at) => ({ id: `b${at}`, threadId })), groups: [] });
  const scopeOf = new Map(threadIds.map(thread => [thread, ensureScope("conversation", thread)]));
  const write = chainStore(db);
  const history: LegacyHistory = { threads: threadIds, lines: new Map(), docs: [], receipts: [], sessions: [], scopeOf };
  const insertMessage = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const insertSource = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text',?,'settled',NULL,'active')");
  const insertReceipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',?,'[]',?,?,0,0,0,'delivered',9)");
  const insertRoots = db.prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)");
  const insertTurn = db.prepare("INSERT OR IGNORE INTO turn_first(thread_id,turn_id,first_rowid) VALUES(?,?,?)");
  db.exec("BEGIN");
  try {
    for (const thread of threadIds) {
      const doc = `doc:${thread}`;
      insertSource.run(doc, scopeOf.get(thread)!, null, null, "owner");
      history.docs.push(doc);
    }
    let at = 0;
    const captured: Array<{ thread: string; id: string }> = [];
    /** Replies captured into memory (they have a source row a receipt can cite). */
    const sourced: Array<{ thread: string; id: string }> = [];
    const chain = new Map<string, { id: string; size: number }>();
    const paths = new Map<string, { tail: string | null; users: string[] }>();
    // the threads advance together, so roots and copies reach across threads in time order
    const length = (thread: string) => thread.endsWith("-long") ? options.longThread! : options.lines;
    const longest = Math.max(options.lines, options.longThread ?? 0);
    for (let step = 0; step < longest; step++) {
      for (const thread of threadIds) {
        if (step >= length(thread)) continue;
        const lines = history.lines.get(thread) ?? [];
        history.lines.set(thread, lines);
        const role: "user" | "bot" = step % 2 === 0 ? "user" : "bot";
        const id = `m${step}`;
        const line: LegacyLine = { id, role, captured: false, receipt: null };
        const json: Record<string, unknown> = {};
        // (branches) the main path: a line's parent is the main path's tail, a branch reply's an older owner line
        if (options.branches !== undefined) {
          const path = paths.get(thread) ?? { tail: null as string | null, users: [] as string[] };
          paths.set(thread, path);
          const branch = role === "bot" && path.users.length > 2 && random() < options.branches;
          if (branch) json.parentId = path.users[pick(path.users.length - 1)]!;
          else if (path.tail !== null) json.parentId = path.tail;
          if (!branch) path.tail = id;
          if (role === "user") path.users.push(id);
          line.branch = branch;
        }
        if (role === "bot") {
          json.turnId = `turn${step - 1}`;
          if (captured.length && random() < (options.copies ?? 0.05)) {
            const origin = captured[pick(captured.length)]!;
            line.copyOf = { threadId: origin.thread, messageIds: [origin.id] };
            json.copyOf = line.copyOf;
          }
        }
        const info = insertMessage.run(thread, id, at++, role, "text", `${thread} ${id}`, JSON.stringify(json));
        if (role === "user") insertTurn.run(thread, `turn${step}`, Number(info.lastInsertRowid));
        if (role === "bot") {
          if (random() < (options.captured ?? 0.5)) { insertSource.run(messageSource(thread, id), scopeOf.get(thread)!, thread, id, `bot:${thread}`); line.captured = true; sourced.push({ thread, id }); }
          if (random() < (options.receipts ?? 0.5)) {
            const cites = [{ id: `doc:${threadIds[pick(threadIds.length)]}`, revision: 1 }];
            // a receipt cites sources that exist (the RC never handed over a source it did not hold): replies captured into memory
            // (never the reply's own source: a reply cannot have been shown itself)
            for (const other of sourced.slice(-8)) if (!(other.thread === thread && other.id === id) && random() < 0.3) cites.push({ id: messageSource(other.thread, other.id), revision: 1 });
            const bundle = `rc-${thread}-${id}`;
            const session = random() < 0.5 ? `s${pick(2)}` : null;
            insertReceipt.run(bundle, thread, session, JSON.stringify(cites), JSON.stringify([id]));
            line.receipt = bundle; history.receipts.push(bundle);
          }
          if (random() < (options.rootSets ?? 0.6) && captured.length) {
            const added = captured.slice(-12).filter(() => random() < 0.3).map(root => `${root.thread}\u0000${root.id}`);
            if (added.length) {
              const parent = chain.get(thread) ?? null;
              const id2 = write(parent?.id ?? null, parent?.size ?? 0, added);
              chain.set(thread, { id: id2, size: (parent?.size ?? 0) + added.length });
              insertRoots.run(thread, id, id2);
            }
          }
          if (line.receipt) captured.push({ thread, id });
        }
        lines.push(line);
      }
    }
    // retained sessions resting on the thread's last set
    for (const thread of threadIds) {
      const set = chain.get(thread);
      if (!set) continue;
      db.prepare("INSERT INTO memory_session_roots(thread_id,driver_instance,native_session,set_id) VALUES(?,?,?,?)").run(thread, "d", "s0", set.id);
      history.sessions.push({ threadId: thread, driverInstance: "d", nativeSession: "s0" });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return history;
}

/** The certificate as the v9 -> v10 step leaves an upgraded file: u1, nothing done, not ready. */
export function markUpgraded(db: DatabaseSync): void {
  db.prepare("UPDATE memory_lineage_cert SET phase='u1',cursor='',done=0,total=0,ready=0 WHERE id=1").run();
}

/** Every row the backfill writes, in a stable order (for kill/resume equality). */
export function lineageDump(db: DatabaseSync): Record<string, unknown[]> {
  const tables: Record<string, string> = {
    line: "SELECT t.thread_id,l.lsn,l.message_id,l.turn_lsn,l.mem_lsn,l.footprint FROM memory_line_lineage l JOIN memory_thread_no t ON t.no=l.thread_no ORDER BY t.thread_id,l.lsn",
    carry: "SELECT p.thread_id AS parent_thread,c.from_lsn,c.to_lsn,c.child_kind,c.child_ref,k.thread_id AS child_thread FROM memory_lineage_carry c JOIN memory_thread_no p ON p.no=c.parent_thread_no LEFT JOIN memory_thread_no k ON k.no=c.child_thread_no ORDER BY 1,2,3,4,5",
    // scope ids are made fresh by each run (ensureScope): scope flow rows are compared by their target and lsn only
    flow: "SELECT CASE WHEN from_thread LIKE 'scope:%' THEN 'scope:*' ELSE from_thread END AS from_thread,CASE WHEN to_thread LIKE 'scope:%' THEN 'scope:*' ELSE to_thread END AS to_thread,first_lsn FROM memory_thread_flow ORDER BY 1,2,3",
    capture: "SELECT t.thread_id,c.lsn,c.source_id FROM memory_line_capture c JOIN memory_thread_no t ON t.no=c.thread_no ORDER BY 1,2,3",
    session: "SELECT * FROM memory_session_lineage ORDER BY thread_id,driver_instance,native_session",
  };
  return Object.fromEntries(Object.entries(tables).map(([name, sql]) => [name, db.prepare(sql).all().map(row => ({ ...row }))]));
}
