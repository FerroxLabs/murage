// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";
import { lineageThreadReady } from "./deny-read.ts";
import { ownerAudienceSessions, sessionSlot, type CursorClear, type RepairBot } from "./keepall-unwedge.ts";
import { sessionKeyOf } from "./session-incarnation.ts";

import { GH18_BLOCKED_REASONS } from "../../shared/gh18-fresh-start-contract.ts";
type GH18BlockedReason = typeof GH18_BLOCKED_REASONS[number];
export interface FreshStartPlan {
  botId: string;
  /** One entry per P1 deny row, including repeated keys for different revokes.
   * Thus length is the preview's exact staleBlocks count, not a session count. */
  sessionRows: Array<{ threadId: string; driverInstance: string; nativeSession: string }>;
  cursorClears: CursorClear[];
  retainedBlocks: number;
  retainedCapped: boolean;
  blocked: null | GH18BlockedReason;
}
const MAX_CANDIDATES = 5_000;
const RETAINED_LIMIT = MAX_CANDIDATES + 1;
const PLAN_MS = 100;
const AUDIENCE_ONLY = "revoke_id IN (SELECT revoke_id FROM memory_revoke_audience)";
const KEY_COLUMNS = "thread_id,driver_instance,native_session";
// JSON table parameters keep scans bounded without SQLite's variable-count limit,
// temp tables, writes in preview, or an installation-wide list of audience revokes.
const JSON_KEYS = "SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?)";
function keyTuples(rows: FreshStartPlan["sessionRows"]): string {
  return JSON.stringify(rows.map(row => [row.threadId, row.driverInstance, row.nativeSession]));
}
function retained(db: DatabaseSync, threads: string[], rows: FreshStartPlan["sessionRows"]): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM (
    SELECT 1 FROM memory_deny_session WHERE thread_id IN (SELECT value FROM json_each(?))
      AND NOT ((${KEY_COLUMNS}) IN (${JSON_KEYS}) AND ${AUDIENCE_ONLY})
    UNION ALL SELECT 1 FROM memory_deny_line WHERE thread_id IN (SELECT value FROM json_each(?))
    UNION ALL SELECT 1 FROM memory_deny_range WHERE thread_id IN (SELECT value FROM json_each(?))
    LIMIT ${RETAINED_LIMIT}
  )`).get(JSON.stringify(threads), keyTuples(rows), JSON.stringify(threads), JSON.stringify(threads))!.n);
}

/** C4: read-only classification of an authenticated selected bot. S2 must hold
 * its turn-admission gate, recheck the preview snapshot, and plan again inside
 * the audit's writer transaction. A plan is not an authorization or a lock.
 * No limits and inferred revoke causes are deliberately absent from this policy.
 *
 * Review amendment: content visibility and reachable non-owner protections are
 * unchanged. Arbitrary audience lookup of a removed OWNER-session key can change;
 * sessionAudienceChanged prevents a non-owner turn from resuming that key.
 */
export function planFreshStart(db: DatabaseSync, bot: RepairBot, deps: {
  ownerDirectThread(id: string): boolean;
  liveThreads: ReadonlySet<string>;
  pendingDeletion(threadId: string): boolean;
}): FreshStartPlan {
  const plan: FreshStartPlan = { botId: bot.id, sessionRows: [], cursorClears: [], retainedBlocks: 0, retainedCapped: false, blocked: null };
  const started = performance.now();
  const expired = () => performance.now() - started > PLAN_MS;
  const block = (reason: GH18BlockedReason) => {
    plan.blocked = reason;
    plan.sessionRows = [];
    plan.cursorClears = [];
    return plan;
  };
  try {
    // P1 is specified against the v13 memory schema, not an unknown future one.
    if (db.prepare("SELECT schema_version FROM memory_meta WHERE id=1").get()?.schema_version !== 13) return block("unsupported-schema");
    const tasks = bot.tasks ?? [];
    if (tasks.length > MAX_CANDIDATES) return block("limit-exceeded");
    const threads = [...new Set(tasks.map(task => task.threadId))];
    // If blocked, these are all retained. On success recalculate after excluding P1.
    plan.retainedBlocks = retained(db, threads, []);
    plan.retainedCapped = plan.retainedBlocks > MAX_CANDIDATES;
    for (const thread of threads) {
      if (expired()) return block("limit-exceeded");
      if (deps.pendingDeletion(thread)) return block("deletion-pending");
    }
    if (tasks.some(task => task.busy || deps.liveThreads.has(task.threadId))) return block("bot-busy");
    if (Number(db.prepare("SELECT ready FROM memory_lineage_cert WHERE id=1").get()?.ready) !== 1
      || threads.some(thread => !lineageThreadReady(db, thread))) return block("lineage-unready");

    // First bound all cursor candidates; room/member cursors are also reset by
    // the owner action, but can never supply a removable deny-session key.
    const clears = new Map<string, CursorClear>();
    for (const task of tasks) {
      for (const [instanceId, cursor] of Object.entries(task.resumeCursors ?? {})) {
        if (cursor === undefined || cursor === null) continue;
        if (expired()) return block("limit-exceeded");
        const key = JSON.stringify([task.threadId, instanceId]);
        const incarnation = task.resumeIncarnations?.[instanceId];
        const prior = clears.get(key);
        // Conflicting store snapshots cannot identify an exact cursor to clear.
        if (prior && (prior.cursor !== cursor || prior.incarnation !== incarnation)) return block("policy-unavailable");
        clears.set(key, { botId: bot.id, threadId: task.threadId, instanceId, cursor, incarnation });
        if (clears.size > MAX_CANDIDATES) return block("limit-exceeded");
      }
    }
    const ownerSessions = ownerAudienceSessions([bot], deps.ownerDirectThread);
    const keys: FreshStartPlan["sessionRows"] = [];
    for (const clear of clears.values()) {
      const key = sessionKeyOf(clear.threadId, clear.instanceId, String(clear.cursor), clear.incarnation);
      if (ownerSessions.get(clear.threadId)?.has(sessionSlot(key.driverInstance, key.nativeSession))) keys.push(key);
    }
    const rows = db.prepare(`SELECT ${KEY_COLUMNS} FROM memory_deny_session
      WHERE (${KEY_COLUMNS}) IN (${JSON_KEYS}) AND ${AUDIENCE_ONLY} LIMIT ${MAX_CANDIDATES + 1}`).all(keyTuples(keys));
    if (rows.length > MAX_CANDIDATES || expired()) return block("limit-exceeded");
    // sessionKeyOf already encoded the incarnation; never append it a second time.
    const sessionRows = rows.map(row => sessionKeyOf(String(row.thread_id), String(row.driver_instance), String(row.native_session)));
    const remaining = retained(db, threads, sessionRows);
    if (expired()) return block("limit-exceeded");
    plan.sessionRows = sessionRows;
    plan.cursorClears = [...clears.values()];
    plan.retainedBlocks = remaining;
    plan.retainedCapped = remaining > MAX_CANDIDATES;
    return plan;
  } catch (error) {
    return block(error instanceof Error && /no such (?:table|column)/.test(error.message) ? "unsupported-schema" : "policy-unavailable");
  }
}

/** Delete only P1 marks, in the caller's writer transaction beside its audit.
 * The store/cursor mutation and durable flush are S2's responsibility after
 * commit. No other tables, lineage facts or door epochs are changed here. */
export function applyFreshStartRows(tx: DatabaseSync, plan: FreshStartPlan): number {
  if (plan.blocked !== null) return 0;
  if (!tx.isTransaction) throw new Error("GH18_WRITER_TRANSACTION_REQUIRED");
  if (plan.sessionRows.length > MAX_CANDIDATES || plan.cursorClears.length > MAX_CANDIDATES) throw new Error("GH18_LIMIT_EXCEEDED");
  const keys = [...new Map(plan.sessionRows.map(row => [JSON.stringify([row.threadId, row.driverInstance, row.nativeSession]), row])).values()];
  // Preflight the entire delete before its first write. Even a stale plan must
  // never partially clear an over-bound set; S2 normally rejects it earlier.
  const count = Number(tx.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM memory_deny_session
    WHERE (${KEY_COLUMNS}) IN (${JSON_KEYS}) AND ${AUDIENCE_ONLY} LIMIT ${MAX_CANDIDATES + 1})`).get(keyTuples(keys))!.n);
  if (count > MAX_CANDIDATES) throw new Error("GH18_LIMIT_EXCEEDED");
  const remove = tx.prepare(`DELETE FROM memory_deny_session WHERE thread_id=? AND driver_instance=? AND native_session=? AND ${AUDIENCE_ONLY}`);
  let deleted = 0;
  for (const row of keys) deleted += Number(remove.run(row.threadId, row.driverInstance, row.nativeSession).changes);
  return deleted;
}

/** Frozen signatures for S1's named exports; S2 can type its policy stub against this interface. */
export interface FreshStartPolicy {
  planFreshStart(db: DatabaseSync, bot: RepairBot, deps: {
    ownerDirectThread(id: string): boolean;
    liveThreads: ReadonlySet<string>;
    pendingDeletion(threadId: string): boolean;
  }): FreshStartPlan;
  /** P1 deletes only, in the caller's writer transaction; returns actual rows deleted. */
  applyFreshStartRows(tx: DatabaseSync, plan: FreshStartPlan): number;
}
