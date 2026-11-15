import { readReconciliation } from './reconciliation-read.ts';
import { createHash } from "node:crypto";
import { canonicalBindingJson } from "./binding-json.ts";
import type { ActionIntent } from "./actions.ts";
import type { ApprovalOutcome } from "./approval-idempotency.ts";
import type { RpcApprovalBinding } from "./rpc-approval-replay.ts";
import { HeldRequest } from "./held-request.ts";
import { bindReturnedIdentities, prepareReturnedIdentitySchema } from "./returned-identities.ts";
import type { OperationSpec, PreflightRequester, RequestDraft } from "./operations/registry.ts";
import { reconciliationReadsFor } from "./operations/reconciliation.ts";
import { approvedBody, collectionComplete, loadOpportunityPlan, planEffectDigest, saveOpportunityPlan, selectEffect, type OpportunityRecoveryPlan } from "./opportunity-recovery-plan.ts";
import { checkRecoveryCollection } from "./opportunity-recovery-collection.ts";
import { highlevelCrmResult } from "./tools.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalBindingJson(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const unconfirmed = (): ApprovalOutcome => ({ status: "conflict", reason: "unconfirmed" });

/** Only retained approved bytes select a recovery target, including body IDs
 * on location-scoped writes. Every write must have a declared effect read. */
export function opportunityReplayBinding(rpcId: string, rpcDigest: string, intent: ActionIntent, held: HeldRequest, directory?: string): RpcApprovalBinding {
  if (!intent.approvalId || held.frozen.requestDigest !== intent.requestDigest) throw new Error("Approval binding unavailable");
  const body = approvedBody(held);
  const readTargets: RpcApprovalBinding["readTargets"][number][] = [];
  const opportunity = /^\/opportunities\/([^/]+)(?:\/(?:status|followers))?$/u.exec(held.frozen.path);
  if (intent.operation === "opportunities.upsert" && typeof body.id === "string")
    readTargets.push({ operation: "opportunities.get", path: `/opportunities/${encodeURIComponent(body.id)}` });
  else if (intent.resource.startsWith("opportunities:opportunity:") && opportunity)
    readTargets.push({ operation: "opportunities.get", path: `/opportunities/${opportunity[1]}` });
  else if (intent.operation.startsWith("opportunities.pipelines."))
    readTargets.push({ operation: "opportunities.pipelines.list", path: "/opportunities/pipelines" });
  else if (intent.operation === "opportunities.create" || intent.operation === "opportunities.upsert")
    readTargets.push({ operation: "opportunities.search", path: "/opportunities/search" });
  const declared = reconciliationReadsFor(intent.operation);
  if (!readTargets.length || readTargets.some(target => !declared.includes(target.operation))) throw new Error("Recovery target unavailable");
  const plan = directory ? saveOpportunityPlan(directory, intent.approvalId, held) : undefined;
  return { rpcId, rpcDigest, approvalId: intent.approvalId, requestDigest: intent.requestDigest,
    actionId: intent.actionId, authorityDigest: intent.reviewDigest, operation: intent.operation, readTargets,
    effectDigest: plan ? planEffectDigest(intent, readTargets, plan) : hash([intent.operation, intent.resource, body]) };
}

/** Rebuild a verification-only candidate from the GET, never from replay input.
 * Both the original wire/request digest AND the approved effect digest must
 * match before the shared whole-response gate can validate it. No candidate is
 * sent. Incomplete reads, collection creates and ambiguous deltas stay unknown. */
export async function reconcileOpportunityEffect(binding: RpcApprovalBinding, intent: ActionIntent, spec: OperationSpec, pre: PreflightRequester, directory?: string): Promise<ApprovalOutcome> {
  const plan = directory ? loadOpportunityPlan(directory, binding, intent) : undefined;
  if (plan) return reconcilePlannedEffect(binding, intent, spec, pre, plan);
  if (spec.risk === "R" || binding.readTargets.length !== 1) return unconfirmed();
  const target = binding.readTargets[0]!;
  let raw: unknown;
  try {
    raw = await readReconciliation(pre, target.operation, { path: target.path,
      ...(target.operation === "opportunities.pipelines.list" ? { query: { locationId: intent.locationId } } : {}) });
  } catch { return unconfirmed(); }
  if (!object(raw)) return unconfirmed();
  const pipeline = intent.operation.startsWith("opportunities.pipelines.");
  const targetId = pipeline ? intent.resource.replace(/^opportunities:pipeline:/u, "") : decodeURIComponent(target.path.split("/").at(-1)!);
  // Absence alone cannot distinguish a completed delete from an inaccessible
  // record. Creates likewise cannot bind a newly issued id from a list match.
  if (intent.operation.endsWith(".delete") || intent.operation.endsWith(".create") || intent.operation === "opportunities.followers.remove") return unconfirmed();
  let record: unknown = raw.opportunity;
  let response = raw;
  if (pipeline) {
    if (!Array.isArray(raw.pipelines)) return unconfirmed();
    const matches = raw.pipelines.filter(row => object(row) && row.id === targetId);
    if (matches.length !== 1 || raw.pipelines.length !== 1) return unconfirmed();
    record = matches[0];
    // Retain every sibling for the whole-response identity/negative traversal.
    response = { ...raw, pipeline: record };
  }
  if (!object(record) || record.id !== targetId) return unconfirmed();
  const fields = intent.fields.filter(key => !["isRemoveAllFollowers", "followersActionType"].includes(key));
  const body: Record<string, unknown> = {};
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) return unconfirmed();
    body[key] = record[key];
  }
  let path = pipeline ? `/opportunities/pipelines/${encodeURIComponent(targetId)}` : target.path;
  const candidates: Record<string, unknown>[] = [];
  if (intent.operation === "opportunities.upsert") {
    Object.assign(body, { id: targetId, locationId: intent.locationId, isRemoveAllFollowers: false });
    path = "/opportunities/upsert";
    candidates.push({ ...body, followersActionType: "add" });
    // A GET returning the removal delta proves those followers are still
    // present, not removed. Only an empty removal delta is a no-op whose other
    // effects can be proven by this exact-body recovery path.
    if (Array.isArray(body.followers) && body.followers.length === 0) candidates.push({ ...body, followersActionType: "remove" });
  } else {
    if (intent.operation === "opportunities.status") path += "/status";
    if (intent.operation.includes(".followers.")) path += "/followers";
    candidates.push(body);
  }
  for (const candidate of candidates) {
    if (hash([intent.operation, intent.resource, candidate]) !== binding.effectDigest) continue;
    const draft: RequestDraft = { path, resource: intent.resource, body: { kind: "json", value: candidate } };
    let held: HeldRequest;
    try { held = HeldRequest.freeze(spec, draft, { locationId: intent.locationId }); } catch { continue; }
    if (held.frozen.requestDigest !== binding.requestDigest || held.frozen.bodySha256 !== intent.bodySha256) continue;
    const bound = prepareReturnedIdentitySchema(held, intent.locationId);
    const checked = bindReturnedIdentities(response, held.frozen, bound);
    if (checked.status !== "applied") return { status: "conflict", reason: checked.status === "not_applied" ? "negative_confirmation" : "identity_conflict" };
    const receipt = { recordId: intent.operation.includes(".followers.") ? "" : targetId, fields: [...intent.fields] };
    // A verified recovery receipt does not re-project a GET as a mutation reply.
    return { status: "applied", result: { intent, actionId: intent.actionId, authorityDigest: intent.reviewDigest, receipt,
      toolResult: highlevelCrmResult({ result: { reconciled: true } }, { actionId: intent.actionId, outcome: "applied" }) } };
  }
  return unconfirmed();
}

/** Reconstruct only a verification witness. It must reproduce the original
 * approved wire digest before the shared whole-response gate sees the read. */
async function reconcilePlannedEffect(binding: RpcApprovalBinding, intent: ActionIntent, spec: OperationSpec, pre: PreflightRequester, plan: OpportunityRecoveryPlan): Promise<ApprovalOutcome> {
  if (spec.risk === "R" || binding.readTargets.length !== 1) return unconfirmed();
  const target = binding.readTargets[0]!;
  if (!reconciliationReadsFor(intent.operation).includes(target.operation)) return unconfirmed();
  let raw: unknown;
  try {
    raw = await readReconciliation(pre, target.operation, { path: target.path,
      ...(target.operation === "opportunities.pipelines.list" ? { query: { locationId: intent.locationId } }
        : target.operation === "opportunities.search" ? { query: { location_id: intent.locationId, page: "1", limit: "50" } } : {}) });
  } catch { return unconfirmed(); }
  if (!object(raw)) return unconfirmed();
  const pipeline = intent.operation.startsWith("opportunities.pipelines.");
  const collection = intent.operation === "opportunities.pipelines.create" || target.operation === "opportunities.search";
  const key = pipeline ? "pipelines" : "opportunities";
  const targetId = collection ? undefined : pipeline ? intent.resource.replace(/^opportunities:pipeline:/u, "") : decodeURIComponent(target.path.split("/").at(-1)!);
  const deleting = intent.operation.endsWith(".delete");
  let path = pipeline ? collection ? "/opportunities/pipelines" : `/opportunities/pipelines/${encodeURIComponent(targetId!)}`
    : intent.operation === "opportunities.upsert" ? "/opportunities/upsert" : intent.operation === "opportunities.create" ? "/opportunities/" : target.path;
  if (intent.operation === "opportunities.status") path += "/status";
  if (intent.operation.includes(".followers.")) path += "/followers";
  const verify = (body: Record<string, unknown>): HeldRequest | undefined => {
    try {
      const held = HeldRequest.freeze(spec, { path, resource: intent.resource, ...(!deleting ? { body: { kind: "json" as const, value: body } } : {}) }, { locationId: intent.locationId });
      return held.frozen.requestDigest === binding.requestDigest && held.frozen.bodySha256 === intent.bodySha256 ? held : undefined;
    } catch { return undefined; }
  };
  let collectionNegative = false;
  const settle = (held: HeldRequest, response: Record<string, unknown>, id: string): ApprovalOutcome => {
    const checked = bindReturnedIdentities(response, held.frozen, prepareReturnedIdentitySchema(held, intent.locationId));
    if (checked.status !== "applied") return { status: "conflict", reason: checked.status === "not_applied" ? "negative_confirmation" : "identity_conflict" };
    if (collectionNegative) return { status: "conflict", reason: "negative_confirmation" };
    const receipt = { recordId: intent.operation.includes(".followers.") || deleting ? "" : id, fields: [...intent.fields] };
    return { status: "applied", result: { intent, actionId: intent.actionId, authorityDigest: intent.reviewDigest, receipt,
      toolResult: highlevelCrmResult({ result: { reconciled: true } }, { actionId: intent.actionId, outcome: "applied" }) } };
  };
  // A complete empty create result disproves creation only when there is no
  // additional response content whose identities or confirmations would be lost.
  const empty = (listKey: "pipelines" | "opportunities") => collectionComplete(raw as Record<string, unknown>, listKey)
    && (raw as Record<string, unknown[]>)[listKey].length === 0
    && Object.keys(raw as object).every(k => [listKey, "meta", "total"].includes(k))
    && (raw!.meta === undefined || (object(raw!.meta) && Object.keys(raw!.meta).every(k => k === "total")));
  if (pipeline || collection) {
    if (!Array.isArray(raw[key]) || !collectionComplete(raw, key)) return unconfirmed();
    if (collection && plan.priorIds !== null && empty(key)) return { status: "conflict", reason: "negative_confirmation" };
  }
  const records: unknown[] = pipeline || collection ? raw[key] as unknown[] : [raw.opportunity];
  if (pipeline || collection) {
    const checked = checkRecoveryCollection(records, pipeline, intent.locationId);
    if (checked === "invalid") return unconfirmed();
    collectionNegative = checked === "negative";
    if (deleting && !records.some(row => object(row) && row.id === targetId)) {
      const held = verify({});
      if (!held || Object.hasOwn(raw, "success") || Object.hasOwn(raw, pipeline ? "pipeline" : "opportunity")) return unconfirmed();
      const { [key]: _records, ...siblings } = raw;
      // The complete validated collection proves this target's absence.
      return settle(held, { ...siblings, success: true }, "");
    }
  }
  const matches: { held: HeldRequest; record: Record<string, unknown> }[] = [];
  for (const record of records) {
    if (!object(record) || typeof record.id !== "string" || (targetId !== undefined && record.id !== targetId)) continue;
    if (deleting) {
      const held = verify({});
      if (held) matches.push({ held, record });
      continue;
    }
    // Removing a follower is not proven by reading the removal delta still
    // present. Retain the conservative recovery rule for nonempty removals.
    if (intent.operation === "opportunities.followers.remove") continue;
    const candidate = { ...record, locationId: intent.locationId };
    const candidates: Record<string, unknown>[] = intent.operation === "opportunities.upsert"
      ? [{ ...candidate, isRemoveAllFollowers: false, followersActionType: "add" },
        ...(Array.isArray(record.followers) && record.followers.length === 0 ? [{ ...candidate, isRemoveAllFollowers: false, followersActionType: "remove" }] : [])]
      : [candidate];
    for (const value of candidates) {
      try {
        const held = verify(selectEffect(plan.shape, value) as Record<string, unknown>);
        if (held) { matches.push({ held, record }); break; }
      } catch { /* Missing approved fields are not proof of an effect. */ }
    }
  }
  if (matches.length !== 1) return unconfirmed();
  const { held, record } = matches[0]!;
  if (collection && (plan.priorIds === null || plan.priorIds.includes(record.id as string))) return unconfirmed();
  let response = raw;
  if (pipeline || collection) {
    // Every collection member was checked above; only the unique approved
    // effect enters the mutation envelope. Retain all noncollection siblings.
    const envelope = pipeline ? "pipeline" : "opportunity";
    if (Object.hasOwn(raw, envelope) || (intent.operation === "opportunities.upsert" && Object.hasOwn(raw, "new") && raw.new !== true)) return unconfirmed();
    const { [key]: _collection, ...siblings } = raw;
    response = { ...siblings, [pipeline ? "pipeline" : "opportunity"]: record,
      ...(intent.operation === "opportunities.upsert" ? { new: true } : {}), ...(deleting ? { success: false } : {}) };
  }
  return settle(held, response, record.id as string);
}
