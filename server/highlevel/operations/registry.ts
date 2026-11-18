import { z } from "zod";
import type { Family, OperationId, Risk } from "../../../shared/highlevel.ts";
import { HIGHLEVEL_ENDPOINTS, highlevelEndpointPattern, type HighLevelEndpoint } from "../provider-contract.ts";
import { contactsOperations } from "./contacts.ts";
import { opportunitiesOperations } from "./opportunities.ts";
import { conversationsOperations } from "./conversations.ts";
import { calendarsOperations } from "./calendars.ts";
import { automationsOperations } from "./automations.ts";
import { locationOperations } from "./location.ts";
import { usersOperations } from "./users.ts";
import { formsOperations } from "./forms.ts";
import { paymentsOperations } from "./payments.ts";
import { socialOperations } from "./social.ts";
import { funnelsOperations } from "./funnels.ts";
import { blogsOperations } from "./blogs.ts";
import { coursesOperations } from "./courses.ts";
import { mediaOperations } from "./media.ts";
import { documentsOperations } from "./documents.ts";
import { saasOperations } from "./saas.ts";
import { snapshotsOperations } from "./snapshots.ts";

import type { HighLevelMethod } from "../provider-contract.ts";
import type { PreparedUpload } from "../uploads.ts";
import type { FrozenRequest } from "../held-request.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { INTEGRATED_FAMILIES } from "./integrated-families.ts";
export { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
export { highlevelIdSchema, strictOperationArgs } from "./schemas/common.ts";
export type Gate = "R" | "GC" | "GC+" | "GD" | "GDp";
// odes4-hl D: only ready rows promise a qualified endpoint; absent rows may
// retain unknown endpoint fields without inventing a callable route.
export type ManifestRow = {
  readonly id: OperationId; readonly family: Family;
  readonly risk: Risk; readonly gate: Gate; readonly send: boolean; readonly precondition: "provider" | "none";
  readonly docUrl: string; readonly pathResourceSegment: number | null; readonly preflight: readonly OperationId[];
  readonly argsSchema: z.ZodTypeAny; readonly bodySchema: z.ZodTypeAny | null; readonly projection: readonly string[];
} & (
  | { readonly disposition: "ready"; readonly method: HighLevelMethod; readonly path: string; readonly version: string; readonly scope: string }
  | { readonly disposition: "provider_absent"; readonly method: HighLevelMethod | null; readonly path: string | null; readonly version: string | null; readonly scope: string | null }
);
export interface OperationRunContext { readonly locationId: string; readonly companyId?: string; readonly prepared?: PreparedUpload; readonly approvalContext?: RequestApprovalContext }
export interface ReadDraft { path: string; query?: Record<string, string>; body?: unknown }
export interface PreflightRequester { read(op: OperationId, draft: ReadDraft): Promise<unknown> }
export type DraftBody = { kind: "json"; value: unknown } | { kind: "multipart"; fields: Record<string, string>; file: { field: string; upload: PreparedUpload } };
/** Server-derived review values and ownership proofs; never sent to the provider. */
export interface RequestApprovalContext { stateDigest?: string; values: Record<string, unknown>; identities: Record<string, readonly string[]> }
export interface RequestDraft { approvalContext?: RequestApprovalContext; path: string; query?: Record<string, string>; body?: DraftBody; resource: string }
export interface SpecBase<A = Record<string, unknown>> {
  readonly id: OperationId; readonly family: Family; readonly title: string;
  readonly row: ManifestRow; readonly endpoint: HighLevelEndpoint; readonly args: z.ZodType<A>;
  readonly nested: boolean; readonly preflight: readonly OperationId[];
  ownership?(pre: PreflightRequester, a: A, ctx: OperationRunContext): Promise<void>;
  recordRefs(a: A): string[]; fields(a: A): string[]; targets(a: A): number;
  /** @deprecated For mutation dispatch use project(value, frozen) with the approval-verified beginDispatch().held.frozen. Plain reads may still use this overload. */
  project(value: unknown): unknown;
  /** F0.1: mutation response validation/projection uses the exact retained request,
   * after recordId validation and before applied settlement. See ../F0.1.md. */
  project(value: unknown, frozen: FrozenRequest): unknown;
}
export interface ReadSpec<A = Record<string, unknown>> extends SpecBase<A> {
  readonly risk: "R"; readonly maxReads: number;
  prepareRead(a: A, ctx: OperationRunContext): Promise<RequestDraft>;
  nextPage?(value: unknown, prev: RequestDraft): RequestDraft | null;
}
export type RecheckResult = { ok: true } | { ok: false; reason: "published" | "sent" | "not_draft" | "gone" | "changed" };
export interface MutationSpec<A = Record<string, unknown>> extends SpecBase<A> {
  readonly risk: "C" | "D"; readonly gate: Exclude<Gate, "R">; readonly send: boolean; readonly precondition: "provider" | "none";
  prepare(pre: PreflightRequester, a: A, ctx: OperationRunContext): Promise<RequestDraft>;
  /** @deprecated Use recordId(value, frozen) with the approval-verified beginDispatch().held.frozen before projection or settlement. */
  recordId?(value: unknown): string | undefined;
  /** Validate returned identity against the approved path/resource, including child
   * and reported parent identities. Throw on mismatch/ambiguous confirmation; never
   * derive expected targets from response values or shared last-prepared state.
   * Implementations supporting both overloads must refuse missing mutation context.
   * Undefined means a validated operation has no receipt ID, not validation success
   * by itself. See ../F0.1.md for expected-target and outcome_unknown rules. */
  recordId?(value: unknown, frozen: FrozenRequest): string | undefined;
  recheck?(pre: PreflightRequester, frozen: FrozenRequest, ctx: OperationRunContext): Promise<RecheckResult>;
}
export type OperationSpec<A = Record<string, unknown>> = ReadSpec<A> | MutationSpec<A>;

const families: Readonly<Record<Family, readonly OperationSpec[]>> = {
  contacts: contactsOperations,
  opportunities: opportunitiesOperations,
  conversations: conversationsOperations,
  calendars: calendarsOperations,
  automations: automationsOperations,
  location: locationOperations,
  users: usersOperations,
  forms: formsOperations,
  payments: paymentsOperations,
  social: socialOperations,
  funnels: funnelsOperations,
  blogs: blogsOperations,
  courses: coursesOperations,
  media: mediaOperations,
  documents: documentsOperations,
  saas: saasOperations,
  snapshots: snapshotsOperations,
};

/** Stable row/schema identity; no wrapping or replacement at registry lookup. */
export function freezeOperationSpec<A>(spec: OperationSpec<A>): OperationSpec<A> {
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === spec.id);
  const fail = (why: string): never => { throw new Error(`HighLevel frozen provider contract: ${why}`); };
  if (!row || row.disposition !== "ready") return fail("provider_absent or unknown operation");
  if (spec.row !== row) return fail("row identity");
  if (spec.args !== row.argsSchema) return fail("schema identity");
  if (spec.preflight !== row.preflight) return fail("preflight identity");
  if (spec.family !== row.family || spec.risk !== row.risk) return fail("family/risk");
  const endpoint = HIGHLEVEL_ENDPOINTS[spec.id];
  if (!endpoint || !spec.endpoint || spec.endpoint.method !== row.method || spec.endpoint.scope !== row.scope
    || spec.endpoint.version !== row.version || spec.endpoint.path.source !== highlevelEndpointPattern(row.path).source
    || spec.endpoint.path.flags !== endpoint.path.flags || spec.endpoint.retry !== (row.risk === "R" ? "read" : "write")) return fail("endpoint");
  if ("run" in spec) return fail("run member forbidden");
  if (spec.nested && typeof spec.ownership !== "function") return fail("nested requires ownership");
  for (const op of spec.preflight) if (HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === op)?.risk !== "R") return fail("preflight must be R");
  if (spec.risk === "R") {
    if (typeof spec.prepareRead !== "function") return fail("prepareRead required");
    if (!Number.isInteger(spec.maxReads) || spec.maxReads < 1 || spec.maxReads > 5) return fail("maxReads");
    if (spec.nextPage && spec.maxReads === 1) return fail("nextPage requires maxReads > 1");
    if ("recheck" in spec) return fail("recheck only on GDp");
  } else {
    if (spec.gate !== row.gate || spec.send !== row.send || spec.precondition !== row.precondition) return fail("mutation gate");
    if (typeof spec.prepare !== "function") return fail("prepare required");
    if (row.gate === "GDp" ? typeof spec.recheck !== "function" : "recheck" in spec) return fail("recheck required iff GDp");
  }
  return Object.freeze(spec);
}
export function assertRegistryCompleteness(specs: readonly OperationSpec[], integrated: readonly Family[] = INTEGRATED_FAMILIES): void {
  const seen = new Set<string>();
  for (const spec of specs) {
    freezeOperationSpec(spec);
    if (seen.has(spec.id)) throw new Error(`Duplicate HighLevel spec: ${spec.id}`);
    seen.add(spec.id);
  }
  for (const row of HIGHLEVEL_OPERATION_MANIFEST) {
    if (row.disposition === "provider_absent" && (!row.docUrl || seen.has(row.id))) throw new Error(`Absent HighLevel spec: ${row.id}`);
    if (row.disposition === "ready" && integrated.includes(row.family) && !seen.has(row.id)) throw new Error(`Missing HighLevel spec: ${row.id}`);
  }
}
// Validate every PRESENT spec at load. Future families are not required before their integration wave.
assertRegistryCompleteness(Object.values(families).flat());
export function operationSpec(id: string): OperationSpec | undefined { return Object.values(families).flat().find(spec => spec.id === id); }
export function familyOperations(family: Family): readonly OperationSpec[] { return families[family] ?? []; }
/** Canonical UTF-8 bytes; undefined, non-finite numbers and non-JSON objects refuse. */
export function canonicalJson(value: unknown): Uint8Array {
  const seen = new Set<object>();
  const visit = (v: unknown, depth = 0): string => {
    if (depth > 64) throw new TypeError("Not canonical JSON");
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (!v || typeof v !== 'object' || seen.has(v)) throw new TypeError("Not canonical JSON");
    seen.add(v);
    try {
      if (Array.isArray(v)) return `[${Array.from(v, item => visit(item, depth + 1)).join(',')}]`;
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError("Not canonical JSON");
      return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    } finally { seen.delete(v); }
  };
  return Buffer.from(visit(value));
}
