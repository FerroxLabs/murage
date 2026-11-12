// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Read-only eligibility for direct owner settlement. No caller is attached here.
import type { DatabaseSync } from "node:sqlite";
import { ownLineVerdicts, readOwnPending, SettleReadBudget, SettleReadLimit } from "./deny-read.ts";
import type { BuiltPrompt, LineageReader, LineageRef } from "./lineage-types.ts";
import { MEMORY_REF_KINDS } from "./lineage-types.ts";
import { SETTLE_SEEDING_FOLD, SETTLE_ACTIVE_FLOW } from "./schema.ts";
import { SEEDING_FOLD_SQL, ACTIVE_FLOW_SQL } from "./settle-queries.ts";
export { SEEDING_FOLD_SQL, ACTIVE_FLOW_SQL } from "./settle-queries.ts";
export { SETTLE_CLASSIFY_MS } from "./deny-read.ts";

export type SettleScope = { threadId: string };
export type OutsideWhy = "audience-reader" | "multi-prefix" | "no-head" | "multi-thread" | "withheld" | `checking-${string}`
  | "beyond-head" | "nested-ref" | "fold-seeding" | "fold" | "job-missing" | "job-state" | "job-kind";
export type IncompleteWhy = "refs" | "ids" | "pending-rows" | "targets" | "work" | "job" | "time" | "error" | "no-classifier";
export type SettleClass =
  | { kind: "own"; threadId: string; headLsn: number; targets: number[] }
  | { kind: "flows"; threadId: string; headLsn: number; targets: number[]; flowIds: number[] }
  | { kind: "clear" }
  | { kind: "outside"; why: OutsideWhy }
  | { kind: "incomplete"; why: IncompleteWhy };
export type SettleClassifier = (db: DatabaseSync, built: Pick<BuiltPrompt, "parts">, reader: LineageReader, scope: SettleScope) => SettleClass;
const outside = (why: OutsideWhy): SettleClass => ({ kind: "outside", why });
const incomplete = (why: IncompleteWhy): SettleClass => ({ kind: "incomplete", why });
export const settleIndexSql = { fold: SETTLE_SEEDING_FOLD.sql, flow: SETTLE_ACTIVE_FLOW.sql };
/** null means unknown (including a missing index), for backlog observers; settlement refuses unknown. */
export function seedingFoldExists(db: DatabaseSync): boolean | null {
  try { return !!db.prepare(SEEDING_FOLD_SQL).get(); } catch { return null; }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function boundedJson(text: string, work: SettleReadBudget): Record<string, unknown> | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const todo = [parsed];
  while (todo.length) {
    work.charge(); const value = todo.pop();
    if (value !== null && typeof value === "object") {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (todo.length >= work.remaining) throw new SettleReadLimit("work");
        todo.push((value as Record<string, unknown>)[key]);
      }
    }
  }
  return object(parsed) ? parsed : null;
}
function validRoot(root: Record<string, unknown>, kind: string): boolean {
  if (root.kind !== kind || typeof root.cause !== "string") return false;
  const str = (v: unknown) => typeof v === "string";
  switch (kind) {
    // compactRoot persists the count; message IDs live in the frontier, not this row.
    case "line": return str(root.threadId) && typeof root.lines === "number" && Number.isSafeInteger(root.lines) && root.lines >= 0
      && ["forget", "hide", "edit", "delete", "branch-switch", "regenerate"].includes(root.cause);
    case "memory": return object(root.ref) && str(root.ref.id) && (MEMORY_REF_KINDS as readonly unknown[]).includes(root.ref.kind)
      && (root.ref.version === undefined || Number.isSafeInteger(root.ref.version))
      && ["archive", "correct", "forget", "revise", "retire", "delete", "unprovable"].includes(root.cause);
    case "scope": return str(root.scopeId) && root.cause === "scope-deny";
    case "receipt": return str(root.bundleId) && ["receipt-revoked", "receipt-content"].includes(root.cause);
    case "session": return object(root.session) && str(root.session.threadId) && str(root.session.driverInstance) && str(root.session.nativeSession) && root.cause === "session-revoked";
    case "policy": return root.cause === "policy-bump";
    case "epoch": return root.cause === "epoch-bump";
    default: return false;
  }
}
/** C12 for the exact job to be served, also usable by a later coordinator's transaction recheck.
 * null is eligible; every other result refuses the job. The caller separately checks seeding folds. */
export function validateSettleJob(db: DatabaseSync, revokeId: number, work = new SettleReadBudget()): SettleClass | null {
  if (work.one(db, "SELECT 1 FROM memory_revoke_fold WHERE old_id=?", revokeId)
    || work.one(db, "SELECT 1 FROM memory_revoke_fold INDEXED BY memory_revoke_fold_bulk WHERE bulk_id=? LIMIT 1", revokeId)) return outside("fold");
  const job = work.one(db, "SELECT state='active' AS active,root_lsn,started_lsn FROM memory_revoke_jobs WHERE revoke_id=?", revokeId);
  if (!job) return outside("job-missing");
  if (!job.active) return outside("job-state");
  const kind = work.text(db, "kind", "memory_revoke_jobs WHERE revoke_id=?", revokeId);
  const text = work.text(db, "root", "memory_revoke_jobs WHERE revoke_id=?", revokeId);
  const cursor = work.text(db, "cursor", "memory_revoke_jobs WHERE revoke_id=?", revokeId);
  const phase = work.text(db, "phase", "memory_revoke_jobs WHERE revoke_id=?", revokeId);
  const root = text === null ? null : boundedJson(text, work);
  if (!root || cursor === null || (cursor !== "" && !boundedJson(cursor, work))) return incomplete("job");
  if (root.cause === "fold") return outside("fold");
  if (kind === "bulk" || kind === "thread" || kind === "bot") return outside("job-kind");
  if (!kind || !validRoot(root, kind) || !Number.isSafeInteger(job.root_lsn) || !Number.isSafeInteger(job.started_lsn)
    || !["flow", "mark", "hold", "tidy"].includes(phase ?? "")) return incomplete("job");
  work.check(); return null;
}
/** Returns the oldest indexed active flow job only after validating that exact job. */
export function oldestSettleFlow(db: DatabaseSync, work = new SettleReadBudget()): { revokeId: number | null; refusal: SettleClass | null } {
  const row = work.one(db, ACTIVE_FLOW_SQL);
  if (!row) return { revokeId: null, refusal: null };
  const revokeId = Number(row.revoke_id);
  return { revokeId, refusal: validateSettleJob(db, revokeId, work) };
}
export const classifyDirectSettle: SettleClassifier = (db, built, reader, scope) => {
  try {
    const work = new SettleReadBudget();
    if (reader.audience !== null) return outside("audience-reader");
    if (built.parts.length > 256) return incomplete("refs");
    const refs: LineageRef[] = [];
    let unaccounted = false, partsSeen = 0;
    for (const part of built.parts) {
      if (++partsSeen > 256) return incomplete("refs");
      work.check();
      if (part.lineageOf.length + refs.length > 256) return incomplete("refs");
      if (!part.lineageOf.length) unaccounted = true;
      for (const ref of part.lineageOf) { if (refs.length === 256) return incomplete("refs"); refs.push(ref); }
    }
    const prefixes = refs.filter((ref): ref is Extract<LineageRef, { kind: "prefix" }> => ref.kind === "prefix");
    if (prefixes.length !== 1) return outside("multi-prefix");
    const headLsn = prefixes[0]!.headLsn;
    if (!Number.isSafeInteger(headLsn) || headLsn! < 0) return outside("no-head");
    if (refs.some(ref => (ref.kind === "prefix" || ref.kind === "line") && ref.threadId !== scope.threadId)) return outside("multi-thread");
    const ids: string[] = [];
    for (const ref of refs) {
      work.check();
      if (ref.kind === "prefix" && ref.shown) {
        if (ids.length + ref.shown.length > 512) return incomplete("ids");
        for (const id of ref.shown) { if (ids.length === 512) return incomplete("ids"); ids.push(id); }
      } else if (ref.kind === "line") {
        if (ids.length === 512) return incomplete("ids"); ids.push(ref.messageId);
      }
    }
    const pending = readOwnPending(db, scope.threadId, work);
    const own = ownLineVerdicts(db, scope.threadId, ids, reader, headLsn!, work, pending);
    work.check();
    const verdicts = [own.prefix, ...own.verdicts.values()];
    if (verdicts.some(verdict => verdict.state === "withheld")) return outside("withheld");
    if (unaccounted) return outside("checking-no-lineage");
    for (const verdict of verdicts) if (verdict.state === "checking" && verdict.reason !== "pending") return outside(`checking-${verdict.reason}`);
    for (const [id, verdict] of own.verdicts) if (verdict.state === "checking" && verdict.reason === "pending") {
      const lsn = own.lsns.get(id);
      if (lsn === undefined || !Number.isSafeInteger(lsn) || lsn > headLsn!) return outside("beyond-head");
    }
    if (refs.some(ref => ref.kind === "memory" || ref.kind === "receipt")) return outside("nested-ref");
    work.check();
    if (!verdicts.some(verdict => verdict.state === "checking")) return { kind: "clear" };
    const targets = [...new Set(pending.filter(row => row.threadId === scope.threadId && row.since <= headLsn!).map(row => row.revokeId))];
    const flowIds = [...new Set(pending.filter(row => row.threadId === "*" && row.since <= headLsn!).map(row => row.revokeId))];
    if (targets.length > 32 || flowIds.length > 32) return incomplete("targets");
    if (work.one(db, SEEDING_FOLD_SQL)) return outside("fold-seeding");
    for (const id of new Set([...targets, ...flowIds])) {
      const refusal = validateSettleJob(db, id, work); if (refusal) return refusal;
    }
    if (flowIds.length) {
      const flow = oldestSettleFlow(db, work); if (flow.refusal) return flow.refusal;
      // No indexed active flow exists to discharge a wildcard row: no provable operation.
      if (flow.revokeId === null) return incomplete("job");
    }
    work.check();
    return flowIds.length ? { kind: "flows", threadId: scope.threadId, headLsn: headLsn!, targets, flowIds }
      : { kind: "own", threadId: scope.threadId, headLsn: headLsn!, targets };
  } catch (error) { return incomplete(error instanceof SettleReadLimit ? error.why : "error"); }
};
