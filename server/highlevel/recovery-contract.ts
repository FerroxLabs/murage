// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { createHash } from "node:crypto";
import { highlevelIdSchema } from "./operations/schemas/common.ts";
import { redirectLocatorSchema } from "./operations/schemas/funnels.ts";
import inventory from "./operations/invocation-plan-inventory.json" with { type: "json" };
import type { OperationId } from "../../shared/highlevel.ts";

/** HL-RECOVERY-2. Shared by every adapter in ONE host invocation; never reset by a requester. */
export const READ_BUDGET_PROFILE = Object.freeze({ logicalReads: 5, attemptsPerRead: 2, physicalReadAttempts: 10,
  mutationSends: 1, sharedBy: "invocation", proofAccumulation: false } as const);
export const DEFAULT_RECOVERY_PROFILE = Object.freeze({ filteredPages: 2, pageSize: 50, directReads: 1 } as const);
/** Contract arithmetic only. Runtime budget ownership/admission remains C2's opaque adapter. */
export function bulkPreparationAndRecoveryBounds(uniqueTargetCount: number): Readonly<{
  preparationReads: number; immediateDirectReads: number; replayDirectReads: number;
  allTargetsRequired: number; canSettleImmediate: boolean; canSettleReplay: boolean;
}> {
  if (!Number.isSafeInteger(uniqueTargetCount) || uniqueTargetCount < 1 || uniqueTargetCount > 500) throw new Error("Invalid HighLevel bulk target count");
  const preparationReads = Math.ceil(uniqueTargetCount / 100);
  const immediateDirectReads = Math.min(uniqueTargetCount, 5 - preparationReads);
  return Object.freeze({ preparationReads, immediateDirectReads, replayDirectReads: Math.min(uniqueTargetCount, 5),
    allTargetsRequired: uniqueTargetCount, canSettleImmediate: uniqueTargetCount <= immediateDirectReads, canSettleReplay: uniqueTargetCount <= 5 });
}
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const recoveryEffectBindingSchema = z.strictObject({ version: z.literal(2), planDigest: digestSchema, approvedEffectDigest: digestSchema });
/** Existing RPC effectDigest binds the v2 plan without adding caller-controlled keys to the frozen RPC envelope. */
export function recoveryEffectBindingDigest(input: z.infer<typeof recoveryEffectBindingSchema>): string {
  const value = recoveryEffectBindingSchema.parse(input);
  return createHash("sha256").update(JSON.stringify({ approvedEffectDigest: value.approvedEffectDigest, planDigest: value.planDigest, version: 2 })).digest("hex");
}
export const operationIdSchema = z.custom<OperationId>(value => typeof value === "string" && inventory.some(row => row.operation === value));
/** MAIN 12:04Z: exactly ONE exception. No generic missing-reader bypass. */
export const NO_RECONCILIATION_READ_EXCEPTIONS = Object.freeze(["courses.import"] as const);
export const IMPORT_EXCEPTION_DIGEST = createHash("sha256").update("HL-F10-12:04|courses.import|no-reader-import|outcome_unknown|no-resend").digest("hex");
/** C2's RPC validator accepts [] iff this frozen binding AND the immutable v2 plan digest agree.
 * This schema does not bypass or replace the existing permanent RPC/approval claims. */
export const importRecoveryBindingSchema = z.strictObject({ version: z.literal(2), operation: z.literal("courses.import"),
  recoveryKind: z.literal("no-reader-import"), exceptionDigest: z.literal(IMPORT_EXCEPTION_DIGEST),
  approvalId: highlevelIdSchema, requestDigest: digestSchema, authorityDigest: digestSchema, planDigest: digestSchema,
  readTargets: z.tuple([]), outcome: z.literal("outcome_unknown"), resend: z.literal(false) });
export type ImportRecoveryBinding = z.infer<typeof importRecoveryBindingSchema>;
export const bindingIdentitySchema = z.strictObject({
  approvalId: highlevelIdSchema, requestDigest: digestSchema, authorityDigest: digestSchema,
  operation: operationIdSchema, locationId: highlevelIdSchema,
  connectionId: highlevelIdSchema, connectionEpoch: z.number().int().positive(), credentialVersion: z.number().int().positive(),
});
/** Persist a requirement, NEVER a reusable witness. Search, cached and pre-send bytes cannot satisfy it. */
export const contactRecoveryRequirementSchema = z.strictObject({
  evidenceClass: z.literal("post-write-direct"), reader: z.literal("contacts.get"), exactId: z.literal(true),
  wholeResponseIdentity: z.literal(true), fullEffectDigest: z.literal(true), initiatedAfterDispatch: z.literal(true),
  invocationLocal: z.literal(true), allTargets: z.literal(true), onInsufficientEvidence: z.literal("outcome_unknown"), resend: z.literal(false),
});
export const CONTACT_RECOVERY_REQUIREMENT = Object.freeze(contactRecoveryRequirementSchema.parse({
  evidenceClass: "post-write-direct", reader: "contacts.get", exactId: true, wholeResponseIdentity: true,
  fullEffectDigest: true, initiatedAfterDispatch: true, invocationLocal: true, allTargets: true,
  onInsufficientEvidence: "outcome_unknown", resend: false,
}));
export type ContactRecoveryRequirement = z.infer<typeof contactRecoveryRequirementSchema>;
export type RecoveryEvidenceClass = "locator-observation" | "post-write-direct" | "target-scoped-effect" | "dispatch-response" | "no-reader-import";
/** Unselected same-location candidates do not acquire primary/created identity roles.
 * Original raw sibling/envelope identity and negative checks precede selection/projection. */
export const COLLECTION_IDENTITY_POLICY = Object.freeze({ unselected: "same-location-observation", selected: "strict-mutation-identity",
  rawResponseCheck: "before-projection", unknownIdentityKeys: "refuse", firstPageCompleteness: "not-required", absenceProvesEffect: false } as const);

/** Transport/host capabilities are runtime objects held in private WeakMaps, never JSON or engine args.
 * C2 supplies the sole mint/admission implementation. A response cannot confer authority. */
declare const planCapability: unique symbol;
declare const budgetCapability: unique symbol;
declare const dispatchBoundary: unique symbol;
declare const directWitness: unique symbol;
export interface InvocationPlanCapability { readonly [planCapability]: true }
export interface ReadBudget { readonly [budgetCapability]: true }
export interface DispatchAttemptBoundary { readonly [dispatchBoundary]: true }
export interface PostWriteDirectWitness { readonly [directWitness]: true }
export interface DirectWitnessBinding {
  readonly invocationId: string; readonly operation: string; readonly planDigest: string; readonly requestDigest: string;
  readonly authorityDigest: string; readonly targetId: string; readonly locationId: string; readonly connectionEpoch: number;
  readonly credentialVersion: number; readonly expectedEffectDigest: string; readonly observedEffectDigest: string;
  readonly dispatchAttempt: DispatchAttemptBoundary;
}
/** Must start the exact GET after the completed uncertain dispatch, validate original raw bytes and all
 * ID/location/parent/negative flags, and compare the FULL approved digest before returning a witness.
 * No witness crosses invocation boundaries. A disagreeing/404 response means unknown, never absence. */
export interface ContactDirectWitnessAdmission {
  admit(binding: DirectWitnessBinding, capability: InvocationPlanCapability, budget: ReadBudget): Promise<PostWriteDirectWitness | null>;
}

/** HL-LOCATOR-1. These bounds/lifecycle events do not expire permanent replay claims. */
export const LOCATOR_PROFILE = Object.freeze({ maxLifetimeMs: 86_400_000, maxPayloadBytes: 4096, maxActivePayloads: 256,
  cleanupPageSize: 32, cleanupPagesPerTransaction: 1, ttlAnchor: "initial-preparation", extendOnRead: false,
  tombstoneExpiry: false, startupIndependentOfReplay: true, commitment: "keyed-hmac-sha256" } as const);
export const LOCATOR_LIFECYCLE_EVENTS = Object.freeze(["terminal", "review-cancel", "review-stale", "grant-revoke", "connection-replace", "disconnect", "conversation-delete", "expiry", "missing-key", "tamper"] as const);
export const LOCATOR_PUBLICATION_ORDER = Object.freeze(["reserve-metadata", "commit-allocation-and-indexes", "publish-authenticated-ciphertext", "activate-bound-plan", "dispatch"] as const);
export const LOCATOR_DELETION_ORDER = Object.freeze(["publish-revocation", "retain-job-and-indexes", "unlink-payload", "fsync-directory", "remove-job-and-indexes"] as const);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const locatorReferenceSchema = z.strictObject({ reference: highlevelIdSchema, commitment: digestSchema, createdAt: timestamp, expiresAt: timestamp })
  .refine(value => value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= LOCATOR_PROFILE.maxLifetimeMs);
export const locatorMetadataSchema = bindingIdentitySchema.extend({ planDigest: digestSchema, conversationId: highlevelIdSchema,
  reference: highlevelIdSchema, keyId: highlevelIdSchema, commitment: digestSchema, createdAt: timestamp, expiresAt: timestamp,
}).refine(value => value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= LOCATOR_PROFILE.maxLifetimeMs);
export type LocatorMetadata = z.infer<typeof locatorMetadataSchema>;
/** Time arithmetic only, before key/credential access. Authentication, live grant/epoch/conversation checks
 * are mandatory independent gates in the owning store and cannot be inferred from this boolean. */
export function locatorLifetimeAllowsAccess(metadata: unknown, now: number): boolean {
  const checked = locatorMetadataSchema.safeParse(metadata);
  if (!checked.success || !Number.isSafeInteger(now)) return false;
  const value = checked.data;
  return now >= value.createdAt && now < value.expiresAt;
}
const emailSelector = z.email().max(75);
const phoneSelector = z.string().min(1).max(50).regex(/^\+[1-9][0-9]{1,49}$/u);
/** The rule digest pins qualified provider identity precedence/normalization. No ad hoc replay selector.
 * Email eq and name query retain the provider's 75-character bound; never truncate to fit. */
export const locatorPayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("contact-email"), email: emailSelector, identityRuleDigest: digestSchema }),
  z.strictObject({ kind: z.literal("contact-phone"), phone: phoneSelector, identityRuleDigest: digestSchema }),
  z.strictObject({ kind: z.literal("contact-email-phone"), email: emailSelector, phone: phoneSelector, identityRuleDigest: digestSchema }),
  z.strictObject({ kind: z.literal("contact-name"), query: z.string().min(1).max(75).refine(value => value.trim().length > 0), identityRuleDigest: digestSchema }),
  z.strictObject({ kind: z.literal("redirect-domain-path"), old: redirectLocatorSchema, next: redirectLocatorSchema.optional() }),
]).refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= LOCATOR_PROFILE.maxPayloadBytes);
export type LocatorPayload = z.infer<typeof locatorPayloadSchema>;
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/u).refine(value => Buffer.from(value, "base64url").toString("base64url") === value);
const boundedCiphertext = base64url.min(22).max(5500).refine(value => {
  const bytes = Buffer.from(value, "base64url").length;
  return bytes >= 16 && bytes <= LOCATOR_PROFILE.maxPayloadBytes + 16;
});
/** Metadata is authenticated AAD; ciphertext includes the GCM tag. Shape parsing does not authenticate it.
 * Independent random epoch wrapping keys live in C1's encrypted bank, never a plaintext sibling file. */
export const sealedLocatorSchema = z.strictObject({ metadata: locatorMetadataSchema, algorithm: z.literal("aes-256-gcm"),
  nonce: base64url.length(16), ciphertext: boundedCiphertext });
export type SealedLocator = z.infer<typeof sealedLocatorSchema>;
export const locatorCleanupJobSchema = z.strictObject({ reference: highlevelIdSchema, locationId: highlevelIdSchema,
  connectionEpoch: z.number().int().positive(), conversationId: highlevelIdSchema, dueAt: timestamp,
  phase: z.enum(["allocated", "published", "revoked", "unlinked", "durable"]), revoked: z.boolean() });
/** Permanent anti-resend claim: no TTL, selector, ciphertext, arbitrary result or reversible locator copy. */
export const permanentReplayTombstoneSchema = z.strictObject({ approvalId: highlevelIdSchema, requestDigest: digestSchema,
  authorityDigest: digestSchema, operation: operationIdSchema, planDigest: digestSchema,
  dispatchAttempts: z.union([z.literal(0), z.literal(1)]), outcome: z.enum(["outcome_unknown", "applied", "not_applied", "stale", "canceled"]) });
declare const allocationCapability: unique symbol;
declare const locatorAccessAuthority: unique symbol;
export interface LocatorAllocation { readonly [allocationCapability]: true }
export interface LocatorAccessAuthority { readonly [locatorAccessAuthority]: true }
export type LocatorReservation = Readonly<{ reference: string; preparedAt: number; expiresAt: number; locationId: string; connectionEpoch: number; conversationId: string }>;
/** C2 owns the implementation. Indexed allocations (including incomplete ones) survive restart.
 * Per-location/epoch, conversation and due-time indexes are mandatory. Never scan approval history.
 * Capacity refusal is visible, never eviction of a previous unresolved locator. */
export interface RecoveryLocatorStorage {
  reserve(input: Omit<LocatorReservation, "reference" | "expiresAt">): Promise<LocatorReservation | null>;
  commitAllocation(reservation: LocatorReservation, metadata: LocatorMetadata): Promise<LocatorAllocation>;
  publishPayload(allocation: LocatorAllocation, payload: LocatorPayload): Promise<Readonly<{ reference: string; commitment: string; expiresAt: number }>>;
  /** Verify AAD/expiry, epoch/key, current bot grant AND conversation liveness before decrypting/credentials. */
  read(reference: string, authority: LocatorAccessAuthority): Promise<LocatorPayload | null>;
}
/** Revocation is DURABLE before acknowledging source replacement/disconnect/grant revoke/content deletion.
 * Deletion jobs/indexes remain until unlink + directory durability complete. Missing key never creates a key.
 * A retired epoch key is not recoverable from a retained master key. Doctor reports held cleanup. */
export interface RecoveryLocatorLifecycle {
  revokeApproval(approvalId: string, reason: typeof LOCATOR_LIFECYCLE_EVENTS[number]): Promise<void>;
  revokeConnection(connectionId: string, connectionEpoch: number): Promise<void>;
  revokeGrant(authorityKey: string): Promise<void>;
  revokeConversation(conversationId: string): Promise<void>;
  /** Startup immediately forbids expired/revoked reads, resumes jobs, then drains one bounded page/tick. */
  cleanupTick(now: number): Promise<Readonly<{ examined: number; deleted: number; pending: number; held: boolean }>>;
}

/** Minimal validated response to THIS exact single dispatch, durably published before settlement/release.
 * No body/selector, synthesized new:true, timestamps or before/after search inventories. */
export const dispatchEvidenceSchema = z.strictObject({ approvalId: highlevelIdSchema, requestDigest: digestSchema,
  authorityDigest: digestSchema, operation: operationIdSchema, credentialVersion: z.number().int().positive(),
  recordId: highlevelIdSchema, creationBranch: z.enum(["created", "existing"]), confirmationDigest: digestSchema,
}).refine(value => inventory.some(row => row.operation === value.operation && row.creationEvidence === "exact-dispatch-response")
  && (value.creationBranch === "created" || value.operation === "contacts.upsert" || value.operation === "opportunities.upsert"));
export type DispatchEvidence = z.infer<typeof dispatchEvidenceSchema>;
export const creationEvidenceAdmissionSchema = z.strictObject({ source: z.literal("authenticated-dispatch-response"),
  evidence: dispatchEvidenceSchema, durablyPublished: z.literal(true), beforeTerminalRelease: z.literal(true) });
declare const validatedDispatchEvidence: unique symbol;
export interface ValidatedDispatchEvidence { readonly [validatedDispatchEvidence]: true; readonly record: DispatchEvidence }
/** C2's sole validation/persistence adapter checks original raw response, held request/authority/identity
 * and provider creation branch against the dispatch boundary. Shape parsing cannot mint this capability.
 * Recovery still requires its fresh direct-ID/full-effect gate; a saved ID alone never settles applied. */
export interface DispatchEvidencePublisher {
  validateAndPublish(raw: unknown, capability: InvocationPlanCapability, dispatch: DispatchAttemptBoundary): Promise<ValidatedDispatchEvidence | null>;
  loadBound(approvalId: string, requestDigest: string, authorityDigest: string): Promise<ValidatedDispatchEvidence | null>;
}
