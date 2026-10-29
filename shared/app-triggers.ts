// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connected-app triggers (design GAP-APP-TRIGGERS-109 rev 1.5, slice AT-S1): the shapes Murage exchanges with Flux
// connected-app events v1 and the host-side rows built on them. Source of truth: the Flux contract
// (contracts/app-events/v1/README.md, contractRevision 1, decisions D-01..D-27); where this file and Flux differ, Flux wins
// and this file is corrected. The frozen phase-5 adapter contract (design section 13.4, the same text in
// GAP-HIGHLEVEL-109 section 10.2) is what these types encode:
//   - one producer: POST /v1/app-events/deliveries/claim; the delivery record is exactly the Flux claim item, plus the
//     home's own binding fields, taken from the local binding row and never from the payload (item 3);
//   - the run context is host-owned and its child ceilings are the literal zero (item 4), never an EventActionBudget;
//   - every run carries the bot's billingRef (item 6); errors are the D-11 envelope (item 9).
// Limits are never restated here: they come from GET /capabilities (the FINAL limits.json values). Murage-side pacing
// below can only be tighter. This module is shared by the APP-TRIGGERS and HIGHLEVEL lanes; it imports no server state.
import { z } from "zod";
import { bodyDigest, canonicalize, JcsError } from "./app-trigger-canonical.mjs";

/** The contract revision this build speaks. A server reporting another holds admission (design section 13.1). */
export const APP_EVENTS_CONTRACT_REVISION = 1;

/** Exactly the three v1 event types (D-12, AT-05). The calendar reserve is never offered. The picker shows only what
 * GET /catalog lists, which starts empty; this is the closed set a listed type must come from. */
export const APP_EVENT_TYPES = ["gmail.message.new", "github.issue.opened", "slack.channel.message"] as const;
export type AppEventType = (typeof APP_EVENT_TYPES)[number];
export const appEventTypeSchema = z.enum(APP_EVENT_TYPES);

/** Bounded opaque ASCII ids (design section 4.2): printable, no spaces, at most 128 characters. */
export const appIdSchema = z.string().regex(/^[\x21-\x7e]{1,128}$/);
/** Flux ids are UUIDs (hex 8-4-4-4-12, either letter case). */
export const fluxUuidSchema = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);
/** A body_digest: unpadded base64url SHA-256, 43 characters. */
export const digestSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** RFC 3339 UTC time, as Flux writes it. */
export const fluxTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/).refine(value => Number.isFinite(Date.parse(value)));
const safeInt = z.number().int().refine(Number.isSafeInteger);
const nonNegInt = safeInt.refine(value => value >= 0);

// ── the routine schedule (section 4.1): not a calendar ───────────────────────

/** A routine started by connected-app events. Exactly two keys; next time is always null; the kind never changes. */
export const appEventScheduleSchema = z.object({ type: z.literal("app_event"), triggerId: appIdSchema }).strict();
export type AppEventSchedule = z.infer<typeof appEventScheduleSchema>;

// ── projection and delivery (Flux claim item, adapter contract item 3) ───────

/** Plain JSON data inside a projection (integers only; the contract has no floats). */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), safeInt, z.string().max(4096), z.array(jsonValue).max(64), z.record(z.string().max(256), jsonValue)]));

/** Reference-first projection, shaped as the DRAFT catalogue examples show it: identifiers and bounded metadata, never
 * message bodies. The Flux limits (projectionMax*) are enforced against the values GET /capabilities returns. */
export const appProjectionSchema = z.object({
  fields: z.record(z.string().min(1).max(256), jsonValue),
  resourceRefs: z.array(z.object({ kind: z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/).max(128), id: z.string().min(1).max(512) }).strict()).max(20),
}).strict();
export type AppProjection = z.infer<typeof appProjectionSchema>;

/** The Flux claim item, exactly (README POST /deliveries/claim). `digest` is body_digest(projection) and is checked. */
export const appClaimItemSchema = z.object({
  deliveryId: fluxUuidSchema,
  subscriptionId: fluxUuidSchema,
  eventType: appEventTypeSchema,
  sourceKey: z.string().min(1).max(512),
  occurredAt: fluxTimeSchema,
  deadlineAt: fluxTimeSchema,
  catchUp: z.boolean(),
  digest: digestSchema,
  projection: appProjectionSchema,
}).strict().superRefine((item, ctx) => {
  let digest: string;
  try { digest = bodyDigest(item.projection); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof JcsError ? error.code : "projection is not canonical" }); return; }
  if (digest !== item.digest) ctx.addIssue({ code: "custom", message: "digest does not match the projection" });
});
export type AppClaimItem = z.infer<typeof appClaimItemSchema>;

/** The home's own binding fields, from its authenticated binding row, never from the payload. */
export const appBindingFieldsSchema = z.object({
  ownerAccountId: appIdSchema,
  homeId: fluxUuidSchema,
  homeEpoch: safeInt.refine(value => value >= 1),
  triggerId: appIdSchema,
  bindingRevision: nonNegInt,
  policyDigest: digestSchema,
  billingRef: fluxUuidSchema,
}).strict();
export type AppBindingFields = z.infer<typeof appBindingFieldsSchema>;

/** The delivery record (section 4.2 "Delivery"): the claim item and the binding fields, nothing else. */
export type AppDeliveryRecord = AppClaimItem & AppBindingFields;
export function deliveryRecord(item: AppClaimItem, binding: AppBindingFields): AppDeliveryRecord {
  return { ...appClaimItemSchema.parse(item), ...appBindingFieldsSchema.parse(binding) };
}

// ── host-owned run context (adapter contract item 4) ─────────────────────────

/** Always these five values. The zeros are literals: there is no type that can hold another ceiling. */
export interface AppRunContext {
  readonly source: "app";
  readonly unattended: true;
  readonly automated: true;
  readonly childCreates: 0;
  readonly childHandoffs: 0;
}
export const APP_RUN_CONTEXT: AppRunContext = Object.freeze({ source: "app", unattended: true, automated: true, childCreates: 0, childHandoffs: 0 });
export const appRunContextSchema = z.object({
  source: z.literal("app"), unattended: z.literal(true), automated: z.literal(true), childCreates: z.literal(0), childHandoffs: z.literal(0),
}).strict();

// ── binding and policy rows (section 4.2) ────────────────────────────────────

export const APP_TRIGGER_SYNC_STATES = ["definition_pending", "registering", "active", "paused", "needs_connection", "needs_review", "deleting", "deleted"] as const;
export type AppTriggerSyncState = (typeof APP_TRIGGER_SYNC_STATES)[number];

export const appTriggerBindingSchema = z.object({
  triggerId: appIdSchema,
  routineId: appIdSchema,
  botId: appIdSchema,
  ownerAccountId: appIdSchema,
  homeId: fluxUuidSchema,
  homeEpoch: safeInt.refine(value => value >= 1),
  bindingRevision: nonNegInt,
  routineRevision: nonNegInt,
  subscriptionId: fluxUuidSchema,
  providerTriggerInstanceId: appIdSchema,
  connectedAccountId: appIdSchema,
  eventType: appEventTypeSchema,
  instructionDigest: digestSchema,
  policyId: appIdSchema,
  policyRevision: nonNegInt,
  policyDigest: digestSchema,
  billingRef: fluxUuidSchema,
  botKeyId: appIdSchema,
  billingReceiptDigest: digestSchema,
  filter: z.lazy(() => appFilterSchema),
  syncState: z.enum(APP_TRIGGER_SYNC_STATES),
  activatedAt: nonNegInt,
  childCreates: z.literal(0),
  childHandoffs: z.literal(0),
}).strict();
export type AppTriggerBinding = z.infer<typeof appTriggerBindingSchema>;

export const appTriggerPolicySchema = z.object({
  policyId: appIdSchema,
  revision: nonNegInt,
  triggerId: appIdSchema,
  bindingDigest: digestSchema,
  approvedAt: nonNegInt,
  revokedAt: nonNegInt.nullable(),
  childCreates: z.literal(0),
  childHandoffs: z.literal(0),
}).strict();
export type AppTriggerPolicy = z.infer<typeof appTriggerPolicySchema>;

// ── filter (section 4.2): no model, no expression, no regex ──────────────────

const filterString = z.string().max(256);
const filterClause = z.discriminatedUnion("op", [
  z.object({ field: z.string().min(1).max(256), op: z.literal("eq"), value: z.union([filterString, safeInt, z.boolean()]) }).strict(),
  z.object({ field: z.string().min(1).max(256), op: z.literal("contains"), value: filterString }).strict(),
  z.object({ field: z.string().min(1).max(256), op: z.literal("in"), value: z.array(z.union([filterString, safeInt])).min(1).max(20) }).strict(),
]);
export const appFilterSchema = z.object({ all: z.array(filterClause).max(16) }).strict();
export type AppFilter = z.infer<typeof appFilterSchema>;

const nfc = (value: string) => value.normalize("NFC");
const sameScalar = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" ? nfc(a) === nfc(b) : typeof a === typeof b && a === b;

/** Whether a projection passes a binding's filter. Case-sensitive, NFC-normalized temporaries; a missing or wrong-type
 * field does not match. An empty filter matches everything. Signed or digested data is never changed. */
export function matchesFilter(filter: AppFilter, projection: AppProjection): boolean {
  for (const clause of filter.all) {
    if (!Object.hasOwn(projection.fields, clause.field)) return false;
    const actual = projection.fields[clause.field];
    if (clause.op === "eq") { if (!sameScalar(actual, clause.value)) return false; continue; }
    if (clause.op === "contains") {
      if (typeof actual === "string") { if (!nfc(actual).includes(nfc(clause.value))) return false; continue; }
      if (Array.isArray(actual)) { if (!actual.some(item => sameScalar(item, clause.value))) return false; continue; }
      return false;
    }
    if (!clause.value.some(option => sameScalar(actual, option))) return false;
  }
  return true;
}

// ── capabilities and limits ──────────────────────────────────────────────────

/** The limits the client needs. Every one is mandatory: a missing one holds admission (section 8.1). */
export const APP_CLIENT_LIMIT_KEYS = [
  "controlBodyMaxBytes", "projectionMaxBytes", "projectionMaxResourceRefs", "claimWaitSec", "claimMaxRows", "claimMaxBytes", "claimLeaseSec",
  "ackMaxReceipts", "runMembershipMax", "runLeaseSec", "runRenewIntervalSec", "workingRunsPerOwner", "startsPerOwner24h",
  "admittedEventsPerOwner24h", "subscriptionsPerOwner", "fanoutMaxBindings", "controlRequestsPerHomePerMinute",
] as const;
export type AppClientLimitKey = (typeof APP_CLIENT_LIMIT_KEYS)[number];
export type AppClientLimits = Readonly<Record<AppClientLimitKey, number>>;

const positiveLimit = safeInt.refine(value => value > 0);
export const appClientLimitsSchema = z.object(Object.fromEntries(APP_CLIENT_LIMIT_KEYS.map(key => [key, positiveLimit])) as Record<AppClientLimitKey, typeof positiveLimit>);

export const appCapabilitiesSchema = z.object({
  version: z.literal(1),
  contractRevision: safeInt,
  grantPurposes: z.array(z.string().max(64)).max(16),
  limits: z.record(z.string().max(64), safeInt),
  eventTypesListed: nonNegInt.refine(value => value <= APP_EVENT_TYPES.length),
}).strict();
export type AppCapabilities = z.infer<typeof appCapabilitiesSchema>;

/** The client limits from a capabilities answer, or null (hold admission) for an unknown revision or a missing limit. */
export function clientLimitsFrom(capabilities: unknown): AppClientLimits | null {
  const parsed = appCapabilitiesSchema.safeParse(capabilities);
  if (!parsed.success || parsed.data.contractRevision !== APP_EVENTS_CONTRACT_REVISION) return null;
  const limits = appClientLimitsSchema.safeParse(parsed.data.limits);
  return limits.success ? Object.freeze({ ...limits.data }) : null;
}

/** Murage-side pacing (section 8.1). Each can only be tighter than the Flux value it sits under. */
export const APP_BATCH_WINDOW_MS = 30_000;
export const APP_BATCH_MAX_EVENTS = 20;
export const APP_BATCH_MAX_BYTES = 32 * 1024;
export function batchMaxEvents(limits: AppClientLimits): number { return Math.min(APP_BATCH_MAX_EVENTS, limits.runMembershipMax); }

/** A projection is inside the published limits (bytes of its canonical form, resource references). */
export function projectionWithinLimits(projection: AppProjection, limits: AppClientLimits): boolean {
  try {
    return Buffer.byteLength(canonicalize(projection), "utf8") <= limits.projectionMaxBytes && projection.resourceRefs.length <= limits.projectionMaxResourceRefs;
  } catch { return false; }
}

// ── errors (D-11) ────────────────────────────────────────────────────────────

/** The 36 codes of the FINAL errors.json (the test holds this list equal to the fixture). */
export const APP_EVENT_ERROR_CODES = [
  "allowance_exhausted", "auth_required", "billing_revoked", "body_read_timeout", "body_too_large", "capacity_exceeded", "child_ceiling_not_zero",
  "claim_in_progress", "credential_expired", "credential_invalid", "duplicate_member", "epoch_stale", "event_expired", "grant_consumed", "grant_expired",
  "grant_invalid", "grant_operation_mismatch", "idempotency_conflict", "idempotency_key_required", "invalid_request", "lease_conflict", "lease_expired",
  "membership_conflict", "model_key_refused", "not_found", "owner_binding_missing", "provider_unavailable", "replacement_setup_required",
  "revision_conflict", "role_not_permitted", "run_expired", "service_unavailable", "signature_invalid", "subscription_inactive",
  "subscription_limit_reached", "type_not_qualified",
] as const;
export type AppEventErrorCode = (typeof APP_EVENT_ERROR_CODES)[number];

/** Exactly `{version:1,error:{code,retryable,requestId,retryAfterSec?}}`; no message member exists. */
export const appEventErrorBodySchema = z.object({
  version: z.literal(1),
  error: z.object({
    code: z.enum(APP_EVENT_ERROR_CODES),
    retryable: z.boolean(),
    requestId: z.string().regex(/^ae_[0-9a-f]{1,64}$/),
    retryAfterSec: z.number().int().min(0).max(86_400).optional(),
  }).strict(),
}).strict();
export type AppEventErrorBody = z.infer<typeof appEventErrorBodySchema>;

// ── run protocol views (README POST /runs/*) ─────────────────────────────────

export const FLUX_RUN_STATES = ["reserved", "working", "owner_wait", "finished", "lapsed"] as const;
export const fluxRunViewSchema = z.object({
  version: z.literal(1),
  runId: fluxUuidSchema,
  state: z.enum(FLUX_RUN_STATES),
  revision: nonNegInt,
  subscriptionId: fluxUuidSchema,
  deliveryIds: z.array(fluxUuidSchema).min(1).max(20),
  billingRef: fluxUuidSchema,
  leaseExpiresAt: fluxTimeSchema.nullable(),
  startedAt: fluxTimeSchema.nullable(),
  finishedAt: fluxTimeSchema.nullable(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]).nullable(),
  newlyStarted: z.boolean().optional(),
  finishReceipt: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type FluxRunView = z.infer<typeof fluxRunViewSchema>;

export const appClaimResponseSchema = z.object({
  version: z.literal(1),
  claimId: fluxUuidSchema.nullable(),
  leaseExpiresAt: fluxTimeSchema.nullable(),
  deliveries: z.array(z.unknown()).max(50),
  more: z.boolean(),
  retryAfterSec: z.number().int().min(0).max(3600).optional(),
}).strict();

export const appAckResponseSchema = z.object({
  version: z.literal(1),
  claimId: fluxUuidSchema,
  acked: nonNegInt,
  receipts: z.array(z.object({ deliveryId: fluxUuidSchema, disposition: z.enum(["accepted", "dropped"]) }).strict()).max(50),
}).strict();

// ── home-side states (section 6.2) ───────────────────────────────────────────

/** What the home decided about one delivery. `ready` waits for a batch; the rest are terminal and shown, never errors. */
export const APP_INBOX_DISPOSITIONS = ["ready", "batched", "filtered", "stale", "rejected"] as const;
export type AppInboxDisposition = (typeof APP_INBOX_DISPOSITIONS)[number];

/** A run's home-side state. `budget_wait` is "Waiting for allowance" (Flux answered capped or capacity_exceeded). */
export const APP_RUN_STATES = ["sealed", "budget_wait", "reserved", "starting", "running", "completed", "failed", "cancelled", "outcome_unknown", "refused"] as const;
export type AppRunState = (typeof APP_RUN_STATES)[number];
export const APP_RUN_TERMINAL: ReadonlySet<AppRunState> = new Set(["completed", "failed", "cancelled", "outcome_unknown", "refused"]);
