import { completeReconciliationCollection } from './reconciliation-read.ts';
import { readReconciliation } from './reconciliation-read.ts';
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncJournalFile, syncJournalEntry } from "./approval-journal-storage.ts";
import { canonicalBindingJson } from "./binding-json.ts";
import type { HeldRequest } from "./held-request.ts";
import type { ActionIntent } from "./actions.ts";
import type { RpcApprovalBinding } from "./rpc-approval-replay.ts";
import type { PreflightRequester } from "./operations/registry.ts";
import { highlevelIdSchema } from "./operations/schemas/common.ts";

// Values stay in the held request. Durable selectors contain only field names,
// array positions and primitive types; the pre-state contains IDs, never CRM text.
type Shape = "string" | "number" | "boolean" | "null" | Shape[] | { [key: string]: Shape };
export interface OpportunityRecoveryPlan { shape: Shape; priorIds: string[] | null }
const plans = new WeakMap<HeldRequest, OpportunityRecoveryPlan>();
export const recoveryHash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function approvedBody(held: HeldRequest): Record<string, unknown> {
  return held.frozen.bodyKind === "json" ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(held.sendCopy().body)) : {};
}
function shapeOf(value: unknown): Shape {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(shapeOf);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOf(child)]));
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value as Shape;
  throw new Error("Recovery selectors unavailable");
}
export function selectEffect(shape: Shape, value: unknown): unknown {
  if (typeof shape === "string") {
    if (shape === "null" ? value !== null : typeof value !== shape) throw new Error("Incomplete recovery read");
    return value;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length !== shape.length) throw new Error("Incomplete recovery collection");
    return shape.map((child, i) => selectEffect(child, value[i]));
  }
  if (!object(value)) throw new Error("Incomplete recovery read");
  return Object.fromEntries(Object.entries(shape).map(([key, child]) => {
    if (!Object.hasOwn(value, key)) throw new Error("Incomplete recovery field");
    return [key, selectEffect(child, value[key])];
  }));
}
export function collectionComplete(raw: Record<string, unknown>, key: "pipelines" | "opportunities"): boolean {
  if (!Array.isArray(raw[key])) return false;
  if (!completeReconciliationCollection(raw, raw[key].length, key !== "pipelines")) return false;
  const meta = object(raw.meta) ? raw.meta : {};
  // No inference of absence or uniqueness from a truncated page.
  if ([raw, meta].some(row => ["nextPage", "nextPageUrl", "nextCursor", "nextPageToken", "startAfterId", "startAfter"].some(k => row[k] !== undefined && row[k] !== null && row[k] !== "") || row.hasMore === true)) return false;
  const total = meta.total ?? raw.total;
  return total === undefined ? key === "pipelines" : Number.isSafeInteger(total) && total === raw[key].length;
}
export async function prepareOpportunityRecovery(held: HeldRequest, locationId: string, pre: PreflightRequester): Promise<void> {
  const body = approvedBody(held), operation = held.frozen.operation;
  const plan: OpportunityRecoveryPlan = { shape: shapeOf(body), priorIds: null };
  const collection = operation === "opportunities.pipelines.create" ? "pipelines"
    : operation === "opportunities.create" || (operation === "opportunities.upsert" && body.id === undefined) ? "opportunities" : undefined;
  if (collection) {
    try {
      const raw = await readReconciliation(pre, collection === "pipelines" ? "opportunities.pipelines.list" : "opportunities.search", collection === "pipelines"
        ? { path: "/opportunities/pipelines", query: { locationId } }
        : { path: "/opportunities/search", query: { location_id: locationId, page: "1", limit: "50" } });
      if (object(raw) && collectionComplete(raw, collection)) {
        const records = raw[collection] as unknown[];
        if (records.every(row => object(row) && highlevelIdSchema.safeParse(row.id).success && (row.locationId === undefined || row.locationId === locationId))) {
          const ids = records.map(row => (row as { id: string }).id);
          if (new Set(ids).size === ids.length) plan.priorIds = ids;
        }
      }
    } catch { /* An unavailable pre-state cannot establish a new creation. */ }
  }
  plans.set(held, plan);
}
const planPath = (directory: string, approvalId: string) => join(directory, `${recoveryHash(approvalId)}.opportunity.json`);
export function saveOpportunityPlan(directory: string, approvalId: string, held: HeldRequest): OpportunityRecoveryPlan {
  const plan = plans.get(held);
  if (!plan) throw new Error("Recovery preparation unavailable");
  const path = planPath(directory, approvalId), bytes = canonicalBindingJson(plan);
  const temp = join(directory, `.opportunity-${randomUUID()}.tmp`), fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, bytes); syncJournalFile(fd); } finally { closeSync(fd); }
    try { linkSync(temp, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readFileSync(path).equals(Buffer.from(bytes))) throw error;
    }
    // Reopen the published inode: EEXIST may refer to a previous publisher
    // interrupted before its final barrier. Windows flushes files, never dirs.
    syncJournalEntry(path, directory);
  } finally { unlinkSync(temp); }
  return plan;
}
export function planEffectDigest(intent: ActionIntent, targets: RpcApprovalBinding["readTargets"], plan: OpportunityRecoveryPlan): string {
  return recoveryHash(["opportunity-recovery", intent.operation, intent.resource, intent.requestDigest, targets, plan]);
}
export function loadOpportunityPlan(directory: string, binding: RpcApprovalBinding, intent: ActionIntent): OpportunityRecoveryPlan | undefined {
  let text: string;
  try { text = readFileSync(planPath(directory, binding.approvalId), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const plan = JSON.parse(text) as OpportunityRecoveryPlan;
  if (!object(plan) || Object.keys(plan).sort().join() !== "priorIds,shape" || (plan.priorIds !== null && (!Array.isArray(plan.priorIds) || !plan.priorIds.every(id => highlevelIdSchema.safeParse(id).success)))
    || planEffectDigest(intent, binding.readTargets, plan) !== binding.effectDigest) throw new Error("Recovery metadata refused");
  return plan;
}
