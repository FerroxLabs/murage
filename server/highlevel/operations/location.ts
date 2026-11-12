// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { HighLevelError } from "../client.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";
import { levelCovers, type FamilyLevel, type Risk, type OperationId } from "../../../shared/highlevel.ts";
import type { OperationSpec, SpecBase, OperationRunContext, PreflightRequester, RequestDraft } from "./registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import type { FrozenRequest } from "../held-request.ts";
import { bindReturnedIdentities, returnedIdentitySchemaFor } from "../returned-identities.ts";
import { completeReconciliationCollection } from "../reconciliation-read.ts";
export type { FamilyLevel, Risk, OperationId, OperationSpec };

export const f6Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/).refine(value => {
  try {
    const decoded = decodeURIComponent(value);
    return !decoded.includes("..") && decoded !== "." && /^[A-Za-z0-9_.~-]+$/.test(decoded);
  } catch { return false; }
}, "Invalid record id");
export const f6Text = (max: number) => z.string().max(max).refine(value => !/(?:[a-z][a-z0-9+.-]*:\/\/|^\s*\/\/|\bwww\.)/i.test(value), "URLs are not accepted");
export const f6Record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function f6Pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const raw = f6Record(value);
  return Object.fromEntries(keys.flatMap<[string, unknown]>(key => {
    const v = raw[key];
    if (typeof v === "string") return [[key, v.slice(0, 4000)]];
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return [[key, v]];
    if (Array.isArray(v)) return [[key, v.slice(0, 50).filter(x => typeof x === "string").map(x => x.slice(0, 4000))]];
    return [];
  }));
}
/** Apply the manifest's 64 KiB ceiling to already allow-listed engine output.
 * No raw provider key is traversed here. The budget counts JSON escaping and
 * UTF-8 bytes, including punctuation, so non-ASCII text cannot evade it. */
export function f6BoundProjection(value: unknown): unknown {
  let remaining = 60_000;
  const visit = (v: unknown, depth: number): unknown => {
    if (remaining < 16 || depth > 8) return undefined;
    if (typeof v === "string") {
      let s = v.slice(0, 4000);
      while (Buffer.byteLength(JSON.stringify(s), "utf8") > remaining && s.length) s = s.slice(0, Math.floor(s.length / 2));
      remaining -= Buffer.byteLength(JSON.stringify(s), "utf8");
      return s;
    }
    if (typeof v === "boolean" || typeof v === "number" || v === null) {
      remaining -= Buffer.byteLength(JSON.stringify(v), "utf8"); return v;
    }
    remaining -= 2;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v.slice(0, 50)) { remaining -= 1; const child = visit(item, depth + 1); if (child === undefined) break; out.push(child); }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(f6Record(v))) {
      const cost = Buffer.byteLength(JSON.stringify(key), "utf8") + 2;
      if (remaining < cost + 16) break;
      remaining -= cost;
      const child = visit(item, depth + 1);
      if (child !== undefined) out[key] = child;
    }
    return out;
  };
  return visit(value, 0) ?? {};
}

export const f6LevelCovers = (level: FamilyLevel | undefined, risk: Risk): boolean => levelCovers(level ?? "off", risk);
export function f6Location(a: Record<string, unknown>, locationId: string): void {
  if (!f6Id.safeParse(locationId).success || (a.locationId !== undefined && a.locationId !== locationId))
    throw new HighLevelError("This record is not in the connected HighLevel location.", { status: 403 });
}
export function f6Confirmed(id: OperationId, raw: unknown, frozen?: FrozenRequest): void {
  if (!frozen || frozen.operation !== id) throw new HighLevelError("The approved request is required.", { outcome: "outcome_unknown" });
  const result = bindReturnedIdentities(raw, frozen, returnedIdentitySchemaFor(frozen));
  if (result.status !== "applied") throw new HighLevelError("HighLevel did not confirm the approved change.", { outcome: result.status === "not_applied" ? "not_applied" : "outcome_unknown" });
}
const resourceInfo = {
  customFields: { idKey: "fieldId", singular: "customField", keys: ["id", "locationId", "name", "fieldKey", "dataType", "model", "placeholder", "position", "picklistOptions"], label: "custom field" },
  customValues: { idKey: "valueId", singular: "customValue", keys: ["id", "locationId", "name", "fieldKey", "value"], label: "custom value" },
  tags: { idKey: "tagId", singular: "tag", keys: ["id", "locationId", "name"], label: "tag" },
} as const;
type Resource = keyof typeof resourceInfo;
async function scopedDefinitions(crm: PreflightRequester, locationId: string, resource: Resource): Promise<Record<string, unknown>[]> {
  f6Id.parse(locationId);
  const response = f6Record(await crm.read(`location.${resource}.list`, { path: `/locations/${encodeURIComponent(locationId)}/${resource}`, ...(resource === "customFields" ? { query: { model: "all" } } : {}) }));
  const rows = response[resource];
  if (!Array.isArray(rows) || rows.length > 10000 || !completeReconciliationCollection(response, rows.length, false))
    throw new HighLevelError("Could not verify HighLevel record ownership.", { status: 403 });
  return rows.map(f6Record);
}
/** Port of HighLevelCrm.#customFieldsByName: exact ids win; ambiguous names/keys
 * are refused with candidate ids only. F1 can resolve before constructing its
 * reviewed write. Definition mutations themselves require the resolved id. */
export async function resolveCustomFieldId(crm: PreflightRequester, locationId: string, fieldName: string): Promise<string> {
  f6Text(200).min(1).parse(fieldName);
  const rows = await scopedDefinitions(crm, locationId, "customFields");
  const wanted = fieldName.trim().toLowerCase();
  const exact = rows.filter(row => row.id === fieldName);
  const matches = exact.length ? exact : rows.filter(row => {
    const key = typeof row.fieldKey === "string" ? row.fieldKey.toLowerCase() : "";
    return (typeof row.name === "string" && row.name.trim().toLowerCase() === wanted) || key === wanted || key === `contact.${wanted}` || key === `opportunity.${wanted}`;
  });
  if (matches.some(row => !f6Id.safeParse(row.id).success || (row.locationId !== undefined && row.locationId !== locationId))) throw new HighLevelError("Could not verify HighLevel field ownership.", { status: 403 });
  if (matches.length !== 1) throw new HighLevelError(matches.length ? `More than one custom field matches. Use an id: ${matches.slice(0, 50).map(row => row.id).join(", ")}.` : "No custom field matches. List the custom fields and use an id.", { status: 400 });
  return String(matches[0]!.id);
}

function locationOperation(row: (typeof HIGHLEVEL_OPERATION_MANIFEST)[number]): OperationSpec {
  const id = row.id;
  const [, resource, verb] = id.split('.');
  const info = resourceInfo[resource as Resource];
  const nested = row.pathResourceSegment !== null;
  const args = row.argsSchema as z.ZodType<Record<string, unknown>>;
  const title = id === 'location.get' ? 'Read the location' : resource === 'tasks' ? 'Find tasks' : resource === 'templates' ? 'List message templates'
    : verb === 'list' ? `List ${info.label}s` : `${({ get: 'Read', create: 'Create', update: 'Update', delete: 'Delete' } as Record<string, string>)[verb!]} a ${info.label}`;
  const draft = (input: Record<string, unknown>, ctx: OperationRunContext): RequestDraft => {
    const a = args.parse(input) as Record<string, unknown>; f6Location(a, ctx.locationId);
    const path = row.path!.replace(/:([A-Za-z]+)/g, (_, key: string) => encodeURIComponent(String(key === 'locationId' ? ctx.locationId : a[key])));
    const fields = Object.fromEntries(Object.entries(a).filter(([key]) => key !== info?.idKey));
    return { path, resource: nested ? `location:record:${a[info.idKey]}` : `location:${ctx.locationId}`,
      ...(row.bodySchema ? { body: { kind: 'json', value: fields } as const } : {}),
      ...(row.method === 'GET' && Object.keys(fields).length ? { query: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, String(value)])) } : {}) };
  };
  const ownership = async (pre: PreflightRequester, input: Record<string, unknown>, ctx: OperationRunContext) => {
    const a = args.parse(input) as Record<string, unknown>; f6Location(a, ctx.locationId);
    // Location reads carry their trusted parent in the qualified route. Writes
    // verify the exact child through the frozen, parent-scoped preflight GET.
    if (nested && row.risk !== 'R') {
      const value = f6Record(await pre.read(`location.${resource}.get` as OperationId, { path: draft(a, ctx).path }));
      const child = f6Record(value[info.singular]);
      if (child.id !== a[info.idKey] || (child.locationId !== undefined && child.locationId !== ctx.locationId))
        throw new HighLevelError('This record is not in the connected HighLevel location.', { status: 403 });
    }
  };
  const projection = (value: unknown): unknown => {
    const raw = f6Record(value);
    if (id === 'location.get') return { location: f6Pick(raw.location, ['id', 'name', 'timezone', 'email', 'phone', 'website', 'address', 'city', 'state', 'country', 'postalCode']) };
    if (verb === 'delete') return { succeeded: raw.succeeded === true || raw.succeded === true || raw.success === true };
    if (info) return verb === 'list' ? { [resource!]: (Array.isArray(raw[resource!]) ? raw[resource!] as unknown[] : []).slice(0, 50).map(row => f6Pick(row, info.keys)) } : { [info.singular]: f6Pick(raw[info.singular], info.keys) };
    return { [resource!]: (Array.isArray(raw[resource!]) ? raw[resource!] as unknown[] : []).slice(0, 50).map(item => resource === 'tasks'
      ? f6Pick(item, ['id', 'locationId', 'contactId', 'assignedTo', 'title', 'body', 'dueDate', 'completed'])
      : { ...f6Pick(item, ['id', 'locationId', 'name', 'type', 'dateAdded']), template: f6Pick(f6Record(item).template, ['body', 'subject']) }) };
  };
  const base: SpecBase = { id, family: 'location', title, row, args, endpoint: HIGHLEVEL_ENDPOINTS[id]!, nested, preflight: row.preflight, ownership,
    fields: a => row.risk === 'R' || row.risk === 'D' ? [] : Object.keys(args.parse(a)).filter(key => key !== info.idKey).sort(),
    recordRefs: a => nested ? [String(args.parse(a)[info.idKey])] : [], targets: () => 1,
    project: value => f6BoundProjection(projection(value)) };
  if (row.risk === 'R') return { ...base, risk: 'R', maxReads: 1, async prepareRead(input, ctx) { return draft(input, ctx); } };
  const recordId = (value: unknown, frozen?: FrozenRequest) => {
    f6Confirmed(id, value, frozen);
    if (verb === 'delete') return undefined;
    const result = f6Record(f6Record(value)[info.singular]).id;
    if (!f6Id.safeParse(result).success) throw new HighLevelError('HighLevel did not return the changed record.', { outcome: 'outcome_unknown' });
    return String(result);
  };
  return { ...base, risk: row.risk as 'C' | 'D', gate: row.gate as 'GC' | 'GD', send: row.send, precondition: row.precondition,
    async prepare(pre, input, ctx) { await ownership(pre, input, ctx); return draft(input, ctx); }, recordId,
    project(value, frozen?: FrozenRequest) { recordId(value, frozen); return f6BoundProjection(projection(value)); } };
}
export const locationOperations: readonly OperationSpec[] = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === 'location' && row.disposition === 'ready').map(locationOperation);
export default locationOperations;
