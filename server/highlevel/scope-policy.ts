// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// HL-PLAN-1: no ownership/prepare hooks, credentials, provider reads or mutable authority.
import { createHash } from "node:crypto";
import type { Family } from "../../shared/highlevel.ts";
import { HIGHLEVEL_PERMISSION_NAMES } from "./provider-contract.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./operations/manifest.ts";
import { INVOCATION_DESCRIPTORS, invocationArgumentPlanSchema, type InvocationDescriptor, type InvocationPlanner, type PassiveConnectionMetadata, type PreparationRefusal } from "./operations/invocation-plans.ts";

type Args = Readonly<Record<string, unknown>>;
type Reader = InvocationDescriptor["readers"][number];
export type ScopePolicyResult = ReturnType<InvocationPlanner["planInvocation"]>;
const descriptors = new Map<string, InvocationDescriptor>(INVOCATION_DESCRIPTORS.map(row => [row.operation, row]));
const rows = new Map<string, (typeof HIGHLEVEL_OPERATION_MANIFEST)[number]>(HIGHLEVEL_OPERATION_MANIFEST.map(row => [row.id, row]));
class PlanRefusal extends Error {
  readonly code: PreparationRefusal["code"];
  constructor(code: PreparationRefusal["code"]) { super(code); this.code = code; }
}
function canonical(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 64) throw new PlanRefusal("invalid_plan");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) throw new PlanRefusal("invalid_plan");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, item => canonical(item, seen, depth + 1)).join(",")}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new PlanRefusal("invalid_plan");
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen, depth + 1)}`).join(",")}}`;
  } finally { seen.delete(value); }
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const present = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
function userIds(args: Args): Set<unknown> {
  return new Set([...(Array.isArray(args.followers) ? args.followers : []), ...(present(args.assignedTo) ? [args.assignedTo] : [])]);
}
/** The closed condition vocabulary is frozen by S0. Response-dependent readers
 * remain reachable here; an authenticated response may only narrow them later. */
function selected(when: Reader["when"], args: Args): boolean {
  switch (when) {
    case "always": case "dispatch-attributed-id": return true;
    case "nonempty-document-recipients": return Array.isArray(args.ccRecipients) && args.ccRecipients.length > 0;
    case "nonempty-custom-fields": return Array.isArray(args.customFields) && args.customFields.length > 0;
    case "approved-contact-locator": {
      if (present(args.email) || present(args.phone)) return true;
      const name = present(args.name) ? String(args.name).trim() : [args.firstName, args.lastName].filter(present).join(" ").trim();
      if (!name || name.length > 75) throw new PlanRefusal("unsupported_locator");
      return true;
    }
    case "bulk-approved-ids": return Array.isArray(args.contacts) && args.contacts.length > 0;
    case "body-id": return present(args.id);
    case "no-body-id": return !present(args.id);
    case "explicit-contact-id": return present(args.contactId);
    case "explicit-pipeline-id": return present(args.pipelineId);
    case "one-user-id": return userIds(args).size === 1;
    case "multiple-user-ids": return userIds(args).size > 1;
    case "no-conversation-id": return !present(args.conversationId);
    case "explicit-workflow-id": return present(args.workflowId);
    case "explicit-campaign-id": return present(args.campaignId);
    case "reschedule-window": return present(args.startTime) || present(args.endTime) || present(args.calendarId);
    case "explicit-blog-author": return present(args.authorId);
    case "explicit-blog-category": return present(args.categoryId);
    case "explicit-blog-slug": return present(args.slug) || present(args.urlSlug);
  }
}
function readCount(reader: Reader, args: Args): number {
  if (reader.when === "nonempty-document-recipients") return new Set((args.ccRecipients as { id: string }[]).map(row => row.id)).size;
  if (reader.when !== "bulk-approved-ids") return reader.maxReads;
  const count = (args.contacts as unknown[]).length;
  return reader.phase === "recovery" ? Math.min(count, reader.maxReads) : Math.ceil(count / 100);
}
function selectorsForDigest(reader: Reader, args: Args, passive: PassiveConnectionMetadata): unknown {
  return reader.selectors.map(source => {
    switch (source.kind) {
      case "connection": return [source, passive.locationId];
      case "argument": return [source, source.field.split(".").reduce<unknown>((value, key) => {
        const field = (row: unknown) => row && typeof row === "object" ? (row as Record<string, unknown>)[key] ?? null : null;
        return Array.isArray(value) ? value.map(field) : field(value);
      }, args) ?? (reader.when === "bulk-approved-ids" ? args.contacts : null)];
      // A symbolic slot can be instantiated only by the named checked dependency.
      case "dependency": case "dispatch-evidence": return [source, digest(args)];
      case "sealed-locator": return [source, source.selector === "approved-contact-identity"
        ? [args.email ?? null, args.phone ?? null, args.name ?? null, args.firstName ?? null, args.lastName ?? null]
        : [args.domain ?? null, args.path ?? null, args.redirectId ?? null]];
    }
  });
}
export function planInvocation(operationId: string, validatedArgs: Args, passive: PassiveConnectionMetadata): ScopePolicyResult {
  const refuse = (code: PreparationRefusal["code"], permissionIds: readonly string[] = []): ScopePolicyResult => freeze({ ok: false as const, refusal: {
    code, operation: operationId, permissionIds: [...permissionIds], connectionId: passive.connectionId,
  } });
  const descriptor = descriptors.get(operationId), row = rows.get(operationId);
  if (!descriptor || !row || row.disposition !== "ready" || descriptor.endpointScope !== row.scope || descriptor.risk !== row.risk) return refuse("unsupported_descriptor");
  try {
    const parsed = row.argsSchema.safeParse(validatedArgs);
    if (!parsed.success) return refuse("invalid_plan");
    const args = parsed.data as Args;
    if (args.locationId !== undefined && args.locationId !== passive.locationId) return refuse("invalid_plan");
    if (operationId === "contacts.tags.bulk" && Array.isArray(args.contacts) && new Set(args.contacts).size !== args.contacts.length) return refuse("invalid_plan");
    if (operationId === "contacts.tags.bulk" && Array.isArray(args.contacts) && args.contacts.some(id => typeof id === "string" && id.length > 75)) return refuse("unsupported_locator");
    const argumentDigest = digest(args), descriptorDigest = digest(descriptor);
    const readers = descriptor.readers.filter(reader => selected(reader.when, args)).map(reader => {
      const maxReads = readCount(reader, args);
      if (maxReads < 1 || maxReads > reader.maxReads) throw new PlanRefusal("read_budget_exceeded");
      const selectorDigest = digest(selectorsForDigest(reader, args, passive));
      return { ...structuredClone(reader), maxReads, selectorDigest, logicalKey: digest({ operationId, slot: reader.slot, selectorDigest,
        connectionId: passive.connectionId, connectionEpoch: passive.connectionEpoch, credentialVersion: passive.credentialVersion }) };
    });
    const requiredScopes = [...new Set([descriptor.endpointScope, ...readers.map(reader => reader.scope)])].sort();
    const missing = requiredScopes.filter(scope => !passive.scopes.includes(scope));
    if (missing.length > 0) return refuse("missing_scope", missing);
    const mandatoryPreparationReads = readers.filter(reader => reader.phase !== "recovery").reduce((sum, reader) => sum + reader.maxReads, 0);
    if (mandatoryPreparationReads > 5) return refuse("read_budget_exceeded");
    const plan = invocationArgumentPlanSchema.safeParse({ version: 2, operation: operationId, argumentDigest, descriptorDigest,
      branch: `selected:${digest(readers.map(reader => [reader.slot, reader.when, reader.maxReads]))}`,
      locationId: passive.locationId, connectionId: passive.connectionId, connectionEpoch: passive.connectionEpoch, credentialVersion: passive.credentialVersion,
      readers, requiredScopes, mandatoryPreparationReads, maxLogicalReads: 5, maxPhysicalReadAttempts: 10 });
    if (!plan.success) return refuse("invalid_plan");
    return freeze({ ok: true as const, plan: plan.data, requiredScopes: [...requiredScopes] });
  } catch (error) { return refuse(error instanceof PlanRefusal ? error.code : "invalid_plan"); }
}
export const highLevelInvocationPlanner: InvocationPlanner = Object.freeze({ planInvocation });

export interface FamilyScopeCoverage {
  readonly family: Family;
  readonly operationIds: readonly string[];
  readonly missingRequired: readonly string[];
  readonly missingConditional: readonly string[];
  readonly unimplementedOperationIds: readonly string[];
  readonly providerAbsentOperationIds: readonly string[];
  readonly unsupportedOperationIds: readonly string[];
}
/** Conservative union over every argument variant. Operation restrictions narrow
 * the selected rows; caller supplies actual adopted implementation IDs. A family
 * projection is explanatory metadata and never grants execution authority. */
export function projectFamilyScopeCoverage(family: Family, passive: PassiveConnectionMetadata, implementedOperationIds: readonly string[], operationRestrictions?: readonly string[]): FamilyScopeCoverage {
  const selectedRows = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === family && (operationRestrictions === undefined || operationRestrictions.includes(row.id)));
  const required = new Set<string>(), conditional = new Set<string>();
  const operationIds: string[] = [], unimplementedOperationIds: string[] = [], providerAbsentOperationIds: string[] = [];
  for (const row of selectedRows) {
    if (row.disposition === "provider_absent") { providerAbsentOperationIds.push(row.id); continue; }
    const descriptor = descriptors.get(row.id);
    if (!descriptor || !implementedOperationIds.includes(row.id)) { unimplementedOperationIds.push(row.id); continue; }
    operationIds.push(row.id); required.add(descriptor.endpointScope);
    for (const reader of descriptor.readers) (reader.when === "always" ? required : conditional).add(reader.scope);
  }
  const missing = (set: Set<string>) => [...set].filter(scope => !passive.scopes.includes(scope)).sort();
  for (const scope of required) conditional.delete(scope);
  return freeze({ family, operationIds: operationIds.sort(), missingRequired: missing(required), missingConditional: missing(conditional),
    unimplementedOperationIds: unimplementedOperationIds.sort(), providerAbsentOperationIds: providerAbsentOperationIds.sort(),
    unsupportedOperationIds: (operationRestrictions ?? []).filter(id => !selectedRows.some(row => row.id === id)).sort() });
}
export function projectMissingPermissions(permissionIds: readonly string[]): readonly Readonly<{ permissionId: string; localeKey: string; label: string }>[] {
  return freeze([...new Set(permissionIds)].sort().map(permissionId => ({ permissionId, localeKey: `highlevel.permission.${permissionId}`, label: HIGHLEVEL_PERMISSION_NAMES[permissionId] ?? permissionId })));
}
