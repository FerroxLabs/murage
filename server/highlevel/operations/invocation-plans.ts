// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// HL-PLAN-1: declarations only. C1 scope-policy owns the pure evaluator; no hooks/I/O here.
import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalBindingJson } from "../binding-json.ts";
import inventory from "./invocation-plan-inventory.json" with { type: "json" };
import { contactRecoveryRequirementSchema, bindingIdentitySchema, digestSchema, IMPORT_EXCEPTION_DIGEST, locatorReferenceSchema, operationIdSchema } from "../recovery-contract.ts";
import { highlevelIdSchema } from "./schemas/common.ts";
export const readerConditionSchema = z.enum(["always", "approved-contact-locator", "nonempty-custom-fields", "dispatch-attributed-id",
  "bulk-approved-ids", "body-id", "no-body-id", "explicit-contact-id", "explicit-pipeline-id", "one-user-id", "multiple-user-ids",
  "no-conversation-id", "explicit-workflow-id", "explicit-campaign-id", "reschedule-window", "explicit-blog-author", "explicit-blog-category", "explicit-blog-slug", "nonempty-document-recipients"]);
export const selectorSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("argument"), field: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("connection"), field: z.literal("locationId") }),
  z.strictObject({ kind: z.literal("dependency"), slot: z.string().min(1).max(128), field: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("sealed-locator"), selector: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("dispatch-evidence"), field: z.literal("recordId") }),
]);
export const readerDescriptorSchema = z.strictObject({ slot: z.string().min(1).max(128), operation: operationIdSchema,
  pathTemplate: z.string().startsWith("/"), version: z.string().min(1), scope: z.string().min(1),
  phase: z.enum(["ownership", "prepare", "recheck", "recovery"]), when: readerConditionSchema,
  maxReads: z.number().int().min(1).max(5), selectors: z.array(selectorSourceSchema).max(10),
  evidenceClass: z.enum(["locator-observation", "post-write-direct", "target-scoped-effect"]),
  reuse: z.enum(["preparation-only", "never"]),
});
export const invocationDescriptorSchema = z.strictObject({ operation: operationIdSchema, owner: z.enum(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F9", "F10"]),
  endpointScope: z.string().min(1), risk: z.enum(["R", "C", "D"]), readers: z.array(readerDescriptorSchema),
  recoveryKind: z.enum(["none", "contact-direct", "dispatch-attributed-contact", "bulk-contact-direct", "target-scoped", "no-reader-import"]),
  activation: z.literal("requires-owner-adoption"),
  creationEvidence: z.enum(["none", "approved-target", "exact-dispatch-response", "qualified-f10-locator"]),
});
export type InvocationDescriptor = z.infer<typeof invocationDescriptorSchema>;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
/** Static, reviewed exact row inventory, NOT synthesized from manifests at runtime. A row is not an implementation. */
export const INVOCATION_DESCRIPTORS: readonly InvocationDescriptor[] = deepFreeze(z.array(invocationDescriptorSchema).parse(inventory));
export const plannedReadSchema = readerDescriptorSchema.extend({ logicalKey: digestSchema, selectorDigest: digestSchema,
  maxReads: z.number().int().min(1).max(5) });
/** Pure output exists BEFORE ownership/prepare/approval. The later binding adds request/authority/approval digests. */
export const invocationArgumentPlanSchema = z.strictObject({ version: z.literal(2), operation: operationIdSchema,
  argumentDigest: digestSchema, descriptorDigest: digestSchema, branch: z.string().min(1).max(128),
  locationId: highlevelIdSchema, connectionId: highlevelIdSchema, connectionEpoch: z.number().int().positive(),
  credentialVersion: z.number().int().positive(), readers: z.array(plannedReadSchema).max(32),
  requiredScopes: z.array(z.string().min(1)).min(1), mandatoryPreparationReads: z.number().int().min(0).max(5),
  maxLogicalReads: z.literal(5), maxPhysicalReadAttempts: z.literal(10),
}).superRefine((plan, ctx) => {
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === plan.operation);
  if (!descriptor || !readersNarrowDescriptor(plan.readers, descriptor)) ctx.addIssue({ code: "custom", message: "Unplanned HighLevel reader" });
  const scopes = [...new Set([descriptor?.endpointScope, ...plan.readers.map(read => read.scope)])].sort();
  if (JSON.stringify([...plan.requiredScopes].sort()) !== JSON.stringify(scopes)) ctx.addIssue({ code: "custom", message: "Incomplete HighLevel scope union" });
});
export type InvocationArgumentPlan = z.infer<typeof invocationArgumentPlanSchema>;
function readersNarrowDescriptor(readers: z.infer<typeof plannedReadSchema>[], descriptor: InvocationDescriptor): boolean {
  return new Set(readers.map(read => read.logicalKey)).size === readers.length && new Set(readers.map(read => read.slot)).size === readers.length
    && readers.every(read => descriptor.readers.some(allowed =>
    read.slot === allowed.slot && read.operation === allowed.operation && read.phase === allowed.phase && read.when === allowed.when
    && read.pathTemplate === allowed.pathTemplate && read.version === allowed.version && read.scope === allowed.scope
    && read.evidenceClass === allowed.evidenceClass && read.reuse === allowed.reuse && read.maxReads <= allowed.maxReads
    && JSON.stringify(read.selectors) === JSON.stringify(allowed.selectors)));
}
const commonPlan = bindingIdentitySchema.extend({ version: z.literal(2), argumentDigest: digestSchema, descriptorDigest: digestSchema,
  branch: z.string().min(1).max(128), planDigest: digestSchema,
  parents: z.partialRecord(z.enum(["contactId", "opportunityId", "pipelineId", "calendarId", "eventId", "appointmentId", "conversationId", "messageId", "emailMessageId", "blogId", "templateId", "documentId", "funnelId", "accountId"]), highlevelIdSchema),
  readers: z.array(plannedReadSchema).max(32), mandatoryPreparationReads: z.number().int().min(0).max(5),
  maxLogicalReads: z.literal(5), maxPhysicalReadAttempts: z.literal(10), mutationSends: z.literal(1),
  approvedTargetIds: z.array(highlevelIdSchema).max(500).refine(ids => new Set(ids).size === ids.length),
  approvedEffectDigest: digestSchema, expectedEffectDigests: z.record(highlevelIdSchema, digestSchema), selectorDigest: digestSchema,
  creationEvidence: z.enum(["none", "approved-target", "exact-dispatch-response", "qualified-f10-locator"]),
  locator: locatorReferenceSchema.nullable(),
});
const invocationPlanShapeSchema = z.discriminatedUnion("recoveryKind", [
  commonPlan.extend({ recoveryKind: z.literal("contact-direct"), contactEvidence: contactRecoveryRequirementSchema }),
  commonPlan.extend({ recoveryKind: z.literal("dispatch-attributed-contact"), contactEvidence: contactRecoveryRequirementSchema, dispatchEvidenceRequired: z.literal(true) }),
  commonPlan.extend({ recoveryKind: z.literal("bulk-contact-direct"), contactEvidence: contactRecoveryRequirementSchema, proofAccumulation: z.literal(false) }),
  commonPlan.extend({ recoveryKind: z.literal("target-scoped"), evidenceClass: z.literal("target-scoped-effect") }),
  commonPlan.extend({ recoveryKind: z.literal("none"), evidenceClass: z.literal("locator-observation") }),
  commonPlan.extend({ recoveryKind: z.literal("no-reader-import"), operation: z.literal("courses.import"), readers: z.tuple([]),
    approvedTargetIds: z.tuple([]), mandatoryPreparationReads: z.literal(0), exceptionDigest: z.literal(IMPORT_EXCEPTION_DIGEST), outcome: z.literal("outcome_unknown"), resend: z.literal(false) }),
]).superRefine((plan, ctx) => {
  const descriptor = INVOCATION_DESCRIPTORS.find(row => row.operation === plan.operation);
  if (!descriptor || descriptor.recoveryKind !== plan.recoveryKind || descriptor.creationEvidence !== plan.creationEvidence || !readersNarrowDescriptor(plan.readers, descriptor)) {
    ctx.addIssue({ code: "custom", message: "Unplanned HighLevel recovery binding" });
  }
  if (["contact-direct", "bulk-contact-direct"].includes(plan.recoveryKind)
    && (!plan.approvedTargetIds.length || plan.approvedTargetIds.some(id => !Object.hasOwn(plan.expectedEffectDigests, id))
      || Object.keys(plan.expectedEffectDigests).some(id => !new Set<string>(plan.approvedTargetIds).has(id)))) {
    ctx.addIssue({ code: "custom", message: "Missing approved target effect digest" });
  }
});
function digestPlan(plan: Record<string, unknown>): string {
  const { planDigest: _self, ...content } = plan;
  return createHash("sha256").update(canonicalBindingJson(content)).digest("hex");
}
/** Digest covers the entire strict plan except its own digest. No replay-supplied field can silently retarget it. */
export const invocationPlanSchema = invocationPlanShapeSchema.refine(plan => plan.planDigest === digestPlan(plan), "HighLevel plan digest mismatch");
export type InvocationPlan = z.infer<typeof invocationPlanSchema>;
/** Host uses this after request/authority/approval binding; the pure pre-read planner returns InvocationArgumentPlan. */
export function bindInvocationPlan(input: unknown): InvocationPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("HighLevel recovery plan refused");
  const plan = invocationPlanShapeSchema.parse({ ...input, planDigest: "0".repeat(64) });
  return deepFreeze(invocationPlanSchema.parse({ ...plan, planDigest: digestPlan(plan) }));
}
/** C2's private journal adapter resolves this BEFORE any empty-target branch or replay preparation.
 * Match all immutable digests and recoveryEffectBindingDigest; do not take a plan from RPC arguments. */
export interface RecoveryPlanBindingLookup {
  loadBound(approvalId: string, requestDigest: string, authorityDigest: string, effectDigest: string): Promise<InvocationPlan | null>;
}
export type PassiveConnectionMetadata = Readonly<{ connectionId: string; locationId: string; connectionEpoch: number; credentialVersion: number; scopes: readonly string[] }>;
export type PreparationRefusal = Readonly<{ code: "missing_scope" | "unsupported_descriptor" | "unsupported_locator" | "read_budget_exceeded" | "invalid_plan";
  operation: string; permissionIds: readonly string[]; connectionId: string }>;
/** Args have already passed the identity args schema and are a frozen deep copy. No leases/provider hooks allowed.
 * Expand all response-dependent scope branches before I/O. Instantiation only narrows the frozen plan.
 * A nonempty customFields array uses ONE definitions read for ID AND name inputs; [] uses none. */
export interface InvocationPlanner {
  planInvocation(operationId: string, validatedArgs: Readonly<Record<string, unknown>>, passive: PassiveConnectionMetadata):
    { readonly ok: true; readonly plan: InvocationArgumentPlan; readonly requiredScopes: readonly string[] } | { readonly ok: false; readonly refusal: PreparationRefusal };
}
