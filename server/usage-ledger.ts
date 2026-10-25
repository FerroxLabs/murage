// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { onRollback, scopedTx } from "./tx-scope.ts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RoomRequest } from "./room-requests.ts";

export interface ProjectUsageTerminal {
  threadId: string; botId: string; engine: string; model?: string | null;
  turnGeneration: string; providerTurnId?: string | null; at: number; ok: boolean;
  usage?: { input: number; output: number; cachedInput?: number };
  charge?: number | null; cost?: number | null;
  unknown?: boolean; lastActivityAt?: number;
}
function atomic<T>(db: DatabaseSync, run: () => T): T {
  return scopedTx(() => {
    db.exec("SAVEPOINT usage_settlement");
    try { const result = run(); db.exec("RELEASE usage_settlement"); return result; }
    catch (error) { db.exec("ROLLBACK TO usage_settlement; RELEASE usage_settlement"); throw error; }
  });
}
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const money = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Attribution comes exclusively from the admission row, including fenced runs.
 * Caller passes only the terminal event's usage, never a live indicator. */
export function settleProjectUsage(db: DatabaseSync, request: RoomRequest, terminal: ProjectUsageTerminal): boolean {
  if (request.dispatchedAt === null) return false;
  const unknown = terminal.unknown === true;
  const dispatch = `:dispatch:${request.dispatchedAt}`;
  const legacyKey = (unknown ? `unknown:${request.id}` : terminal.providerTurnId
    ? `turn:${JSON.stringify([terminal.threadId, terminal.providerTurnId])}` : `req:${request.id}:${terminal.turnGeneration}`);
  const key = legacyKey + dispatch;
  return atomic(db, () => {
    if (unknown && db.prepare("SELECT 1 FROM usage_ledger WHERE request_id=? AND rolled_up=0 AND settle_key NOT LIKE 'unknown:%' AND settle_key NOT LIKE 'charge:%' AND (substr(settle_key,-length(?))=? OR (settle_key NOT LIKE '%:dispatch:%' AND at>=?))").get(request.id, dispatch, dispatch, request.dispatchedAt)) return false;
    // Legacy keys lack a dispatch id. Their terminal timestamp must belong to
    // this dispatch; an earlier failed launch cannot suppress its later retry.
    const legacy = db.prepare("SELECT 1 FROM usage_ledger WHERE settle_key=? AND request_id=? AND rolled_up=0 AND at>=?").get(legacyKey, request.id, request.dispatchedAt);
    if (!unknown && Number(db.prepare("DELETE FROM usage_ledger WHERE settle_key=? OR (settle_key=? AND at>=?)")
      .run(`unknown:${request.id}${dispatch}`, `unknown:${request.id}`, request.dispatchedAt).changes) > 0) dropBudgetTotals(db);
    if (legacy) return false;
    const end = unknown ? Math.min(terminal.at, terminal.lastActivityAt ?? terminal.at) : terminal.at;
    const pendingWait = request.waitingSince === null ? 0 : Math.max(0, end - request.waitingSince);
    // An unfinished run (restart) is estimated up to its last activity; no run
    // has a duration cap to clip it to (SPEC-P 5.4, 2026-09-29).
    const workMs = Math.max(0, end - request.dispatchedAt! - request.ownerWaitMs - pendingWait);
    const usage = !unknown && terminal.usage && count(terminal.usage.input) && count(terminal.usage.output) ? terminal.usage : undefined;
    const charge = !unknown && money(terminal.charge) ? terminal.charge : null;
    const estimate = !unknown && terminal.engine === "claude" && money(terminal.cost) ? terminal.cost : null;
    const result = db.prepare(`INSERT INTO usage_ledger
      (settle_key,turn_id,group_id,goal_id,work_item_id,request_id,root_id,attempt,bot_id,thread_id,engine,model,input,output,cached_input,tokens_reported,charge,charge_kind,work_ms,ok,audience,rolled_up,at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(settle_key) DO NOTHING`).run(
      key, terminal.providerTurnId ?? null, request.groupId, request.projectGoalId, request.workItemId, request.id, request.rootId, request.attempt,
      terminal.botId, terminal.threadId, terminal.engine, terminal.model ?? null, usage?.input ?? null, usage?.output ?? null,
      usage && count(usage.cachedInput) ? usage.cachedInput : null, usage ? 1 : 0,
      charge ?? estimate, charge !== null ? "charge" : estimate !== null ? "estimate" : "none", Math.floor(workMs), !unknown && terminal.ok ? 1 : 0,
      request.executionAudience == null ? null : JSON.stringify(request.executionAudience), terminal.at,
    );
    return Number(result.changes) > 0;
  });
}

export function settleProjectToolCharge(db: DatabaseSync, request: RoomRequest, input: { operationId: string; threadId: string; botId: string; engine: string; model?: string | null; at: number; charge: number }): boolean {
  if (!money(input.charge)) return false;
  return Number(db.prepare(`INSERT INTO usage_ledger
    (settle_key,group_id,goal_id,work_item_id,request_id,root_id,attempt,bot_id,thread_id,engine,model,tokens_reported,charge,charge_kind,work_ms,ok,audience,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,'charge',0,1,?,?) ON CONFLICT(settle_key) DO NOTHING`).run(
    `charge:${input.operationId}`, request.groupId, request.projectGoalId, request.workItemId, request.id, request.rootId, request.attempt,
    input.botId, input.threadId, input.engine, input.model ?? null, input.charge,
    request.executionAudience == null ? null : JSON.stringify(request.executionAudience), input.at,
  ).changes) > 0;
}
export interface UsageTotals { workMs: number; input: number; output: number; tokensReported: boolean; charge: number | null }
// Tokens count as reported when ANY settled turn reported them: the budget check sums input and output over every row, so the panel
// shows the same sum instead of "not reported" because one interrupted turn had no figures.
export function projectUsage(db: DatabaseSync, scope: { groupId: string; goalId?: string; since?: number }): { totals: UsageTotals; byBot: Array<UsageTotals & { botId: string }>; notReported: string[]; interrupted: boolean } {
  const clauses = ["group_id=?"]; const values: (string | number)[] = [scope.groupId];
  if (scope.goalId) { clauses.push("goal_id=?"); values.push(scope.goalId); }
  if (scope.since !== undefined) { clauses.push("at>=?"); values.push(scope.since); }
  const rows = db.prepare(`SELECT bot_id AS botId, SUM(work_ms) AS workMs, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output,
    MAX(tokens_reported) AS tokensReported, SUM(CASE WHEN charge_kind='charge' THEN charge END) AS charge
    FROM usage_ledger WHERE ${clauses.join(" AND ")} GROUP BY bot_id ORDER BY bot_id`).all(...values) as unknown as Array<Omit<UsageTotals, "tokensReported"> & { botId: string; tokensReported: number }>;
  const byBot = rows.map(row => ({ ...row, tokensReported: row.tokensReported === 1 }));
  const totals = byBot.reduce<UsageTotals>((sum, row) => ({ workMs: sum.workMs + row.workMs, input: sum.input + row.input, output: sum.output + row.output,
    tokensReported: sum.tokensReported && row.tokensReported, charge: row.charge === null ? sum.charge : (sum.charge ?? 0) + row.charge,
  }), { workMs: 0, input: 0, output: 0, tokensReported: true, charge: null });
  if (!byBot.length) totals.tokensReported = false;
  const interrupted=Boolean(db.prepare(`SELECT 1 FROM usage_ledger WHERE ${clauses.join(" AND ")} AND (settle_key LIKE 'unknown:%' OR settle_key LIKE 'rollup:%:interrupted') LIMIT 1`).get(...values));
  return { totals, byBot, notReported: byBot.filter(row => !row.tokensReported).map(row => row.botId), interrupted };
}

/** Running totals for the budget check (Astra idle-scan r6). The 30 s budget tick used to sum every settled row of the period or goal
 * (68 ms at 100,000 rows, growing with history). Each budget scope now keeps its totals and a watermark: the highest ledger rowid they
 * cover. Settling only ever appends rows, so a read looks at MAX(rowid) (one step) and adds just the rows past the watermark; an idle
 * tick adds nothing. The one place rows are removed (an unknown-usage row replaced by the real one, the rollup) drops the cache so it
 * is rebuilt once, and the hourly reconcile rebuilds every scope from the rows and repairs any drift. */
interface BudgetTotals { since: number | undefined; workMs: number; input: number; output: number; watermark: number }
const budgetTotals = new WeakMap<DatabaseSync, Map<string, BudgetTotals>>();
/** Drops the kept totals now and again if the transaction around this call rolls back (the rows it removed come back). */
function dropBudgetTotals(db: DatabaseSync): void { budgetTotals.delete(db); onRollback(() => budgetTotals.delete(db)); }
const ledgerHead = (db: DatabaseSync): number => Number((db.prepare("SELECT COALESCE(MAX(rowid),0) AS head FROM usage_ledger").get() as { head: number }).head);
function budgetScope(scope: { groupId: string; goalId?: string; since?: number }, past: boolean): { where: string; values: (string | number)[] } {
  // "+" keeps the rowid range as the access path for the catch-up, so it never walks the group's whole history
  const lead = past ? "+" : "";
  const clauses = [`${lead}group_id=?`]; const values: (string | number)[] = [scope.groupId];
  if (scope.goalId) { clauses.push(`${lead}goal_id=?`); values.push(scope.goalId); }
  if (scope.since !== undefined) { clauses.push(`${lead}at>=?`); values.push(scope.since); }
  return { where: clauses.join(" AND "), values };
}
function sumScope(db: DatabaseSync, scope: { groupId: string; goalId?: string; since?: number }, after: number | null): { workMs: number; input: number; output: number } {
  const { where, values } = budgetScope(scope, after !== null);
  const row = db.prepare(`SELECT COALESCE(SUM(work_ms),0) AS workMs, COALESCE(SUM(input),0) AS input, COALESCE(SUM(output),0) AS output
    FROM usage_ledger WHERE ${after !== null ? "rowid>? AND " : ""}${where}`).get(...(after !== null ? [after, ...values] : values)) as { workMs: number; input: number; output: number };
  return { workMs: Number(row.workMs), input: Number(row.input), output: Number(row.output) };
}
/** The settled work and tokens of one budget scope, equal to projectUsage(...).totals for the same scope, read in constant time. */
export function budgetUsageTotals(db: DatabaseSync, scope: { groupId: string; goalId?: string; since?: number }): { workMs: number; input: number; output: number } {
  // Inside a transaction the rows may be uncommitted and roll back: answer from the rows, keep nothing.
  if (db.isTransaction) return sumScope(db, scope, null);
  let map = budgetTotals.get(db);
  if (!map) { map = new Map(); budgetTotals.set(db, map); }
  const key = `${scope.groupId}\u0000${scope.goalId ?? ""}`;
  const head = ledgerHead(db);
  let entry = map.get(key);
  if (!entry || entry.since !== scope.since || head < entry.watermark) {
    entry = { since: scope.since, ...sumScope(db, scope, null), watermark: head };
    map.set(key, entry);
  } else if (head > entry.watermark) {
    const more = sumScope(db, scope, entry.watermark);
    entry.workMs += more.workMs; entry.input += more.input; entry.output += more.output; entry.watermark = head;
  }
  return { workMs: entry.workMs, input: entry.input, output: entry.output };
}
/** The hourly check: every kept scope is summed again from the rows; a total that drifted is replaced. Returns how many had drifted. */
export function reconcileBudgetTotals(db: DatabaseSync): number {
  const map = budgetTotals.get(db);
  if (!map || db.isTransaction) return 0;
  let drifted = 0;
  for (const [key, entry] of [...map]) {
    const [groupId, goalId] = key.split("\u0000");
    const head = ledgerHead(db);
    const fresh = sumScope(db, { groupId: groupId!, ...(goalId ? { goalId } : {}), ...(entry.since !== undefined ? { since: entry.since } : {}) }, null);
    if (fresh.workMs !== entry.workMs || fresh.input !== entry.input || fresh.output !== entry.output) drifted++;
    map.set(key, { since: entry.since, ...fresh, watermark: head });
  }
  return drifted;
}

/** Called only by live boot/daily pruning, never archive restore preparation. */
export function rollupSettledUsage(db: DatabaseSync, now: number): void {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='usage_ledger'").get()) return;
  atomic(db, () => {
    const rows = db.prepare(`SELECT * FROM usage_ledger u WHERE rolled_up=0 AND at<?
      AND NOT EXISTS (SELECT 1 FROM project_budgets b WHERE b.group_id=u.group_id AND u.at>=b.period_start AND (b.period<>'goal' OR (b.goal_id=u.goal_id AND EXISTS (SELECT 1 FROM project_goals g WHERE g.id=b.goal_id AND g.state NOT IN ('done','stopped','failed')))))
      ORDER BY at,settle_key`).all(now - 90 * 86400000);
    const buckets = new Map<string, typeof rows>();
    for (const row of rows) {
      const day = new Date(Number(row.at)).toISOString().slice(0, 10);
      // Charge kinds stay separate: estimates must never become real reported cost.
      // The card is a dimension so per-card usage survives the rollup. It joins the hash only when set,
      // so a card-less bucket keeps the key earlier rollups wrote and a repeated rollup stays a no-op.
      const dimensions: unknown[] = [row.goal_id, row.root_id, row.bot_id, row.engine, row.model, row.audience, row.charge_kind];
      if (row.work_item_id !== null) dimensions.push(row.work_item_id);
      const hash = createHash("sha256").update(JSON.stringify(dimensions)).digest("hex").slice(0, 16);
      const key = `rollup:${row.group_id}:${day}:${hash}${String(row.settle_key).startsWith("unknown:") ? ":interrupted" : ""}`;
      const bucket = buckets.get(key) ?? []; bucket.push(row); buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets) {
      const first = bucket[0]!;
      const sum = (field: string): number | null => bucket.every(row => row[field] === null) ? null : bucket.reduce((n, row) => n + Number(row[field] ?? 0), 0);
      const inserted = db.prepare(`INSERT INTO usage_ledger
        (settle_key,group_id,goal_id,work_item_id,root_id,bot_id,thread_id,engine,model,input,output,cached_input,tokens_reported,charge,charge_kind,work_ms,ok,audience,rolled_up,at)
        VALUES (?,?,?,?,?,?,'rollup',?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(settle_key) DO NOTHING`).run(
        key, first.group_id, first.goal_id, first.work_item_id, first.root_id, first.bot_id, first.engine, first.model,
        sum("input"), sum("output"), sum("cached_input"), Math.min(...bucket.map(row => Number(row.tokens_reported))),
        sum("charge"), first.charge_kind, sum("work_ms"), Math.min(...bucket.map(row => Number(row.ok))), first.audience, first.at,
      );
      // A late historical row must remain itemised if this bucket already exists.
      if (Number(inserted.changes)) for (const row of bucket) db.prepare("DELETE FROM usage_ledger WHERE settle_key=?").run(row.settle_key);
    }
    dropBudgetTotals(db);
  });
}

/** Request-bound turns use settleProjectUsage exclusively. Owner work has no row. */
export function settleSharedWorkOwnerTurn(db: DatabaseSync, terminal: ProjectUsageTerminal & { teamId: string; ownerMessageId: string; startedAt: number; ownerWaitMs?: number; boundRequestId?: string }): boolean {
  if (terminal.boundRequestId) return false;
  const usage = terminal.usage && count(terminal.usage.input) && count(terminal.usage.output) ? terminal.usage : undefined;
  const charge = money(terminal.charge) ? terminal.charge : null;
  const estimate = terminal.engine === "claude" && money(terminal.cost) ? terminal.cost : null;
  return Number(db.prepare(`INSERT INTO usage_ledger
    (settle_key,turn_id,bot_id,thread_id,engine,model,input,output,cached_input,tokens_reported,charge,charge_kind,work_ms,ok,audience,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(settle_key) DO NOTHING`).run(
      `shared-owner:${terminal.turnGeneration}`, terminal.providerTurnId ?? null, terminal.botId, terminal.threadId, terminal.engine, terminal.model ?? null,
      usage?.input ?? null, usage?.output ?? null, usage?.cachedInput ?? null, usage ? 1 : 0, charge ?? estimate,
      charge !== null ? "charge" : estimate !== null ? "estimate" : "none", Math.max(0,terminal.at-terminal.startedAt-(terminal.ownerWaitMs??0)), terminal.ok ? 1 : 0,
      JSON.stringify({v:1,kind:"team",human:"owner",team:terminal.teamId,rootRequestId:`message:${terminal.ownerMessageId}`}), terminal.at,
    ).changes)>0;
}
