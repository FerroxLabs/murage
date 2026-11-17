// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrozenRequest } from "../held-request.ts";
import { z } from "zod";
import { HighLevelError, PAGE_MAX } from "../response-contract.ts";
import { HIGHLEVEL_ENDPOINTS, endpointFor } from "../provider-contract.ts";
import { bindReturnedIdentities, returnedIdentitySchemaFor } from "../returned-identities.ts";
import type { ManifestRow, OperationSpec, OperationRunContext, PreflightRequester, RequestDraft, SpecBase } from "./registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { argsSchema as schemas } from "./schemas/opportunities.ts";

type Args = Record<string, unknown>;
type Verb = keyof typeof schemas extends `opportunities.${infer V}` ? V : never;
const object = (v: unknown): Args => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Args : {};
const list = (v: unknown): Args[] => Array.isArray(v) ? v.map(object) : [];
const fail = (message: string): never => { throw new HighLevelError(message, { status: 400 }); };
const ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/u)
  .refine(v => v !== "." && !v.includes("..") && !/%(?![0-9a-f]{2})|%(?:2e|2f|5c|25)/iu.test(v), "Record ID contains characters that are not allowed");
const seg = (v: unknown) => encodeURIComponent(ID.parse(v));
const pathFor = (verb: Verb, a: Args): string => {
  if (verb === "pipelines.list") return "/opportunities/pipelines";
  if (verb === "search") return "/opportunities/search";
  if (verb === "pipelines.create") return "/opportunities/pipelines";
  if (verb.startsWith("pipelines.")) return `/opportunities/pipelines/${seg(a.pipelineId)}`;
  if (verb === "create") return "/opportunities/";
  if (verb === "upsert") return "/opportunities/upsert";
  const suffix = verb === "status" ? "/status" : verb.startsWith("followers.") ? "/followers" : "";
  return `/opportunities/${seg(a.opportunityId)}${suffix}`;
};
// Only the frozen ready rows may create family specs.
const readyRows = HIGHLEVEL_OPERATION_MANIFEST.filter((row): row is Extract<ManifestRow, { disposition: "ready" }> =>
  row.family === "opportunities" && row.disposition === "ready");
const titles: Record<Verb, string> = {
  "pipelines.list": "List pipelines", "pipelines.create": "Create a pipeline", "pipelines.update": "Update a pipeline", "pipelines.delete": "Delete a pipeline", search: "Find deals", get: "Read a deal", create: "Create a deal", update: "Update or move a deal",
  status: "Change a deal's status", upsert: "Create or update a deal", delete: "Delete a deal",
  "followers.add": "Add deal followers", "followers.remove": "Remove deal followers",
};
const riskFor = (verb: Verb): OperationSpec["risk"] => ["pipelines.list", "search", "get"].includes(verb) ? "R" : (verb === "delete" || verb === "pipelines.delete") ? "D" : "C";
const strings = (raw: Args, keys: readonly string[]): Args => Object.fromEntries(keys.flatMap(k => typeof raw[k] === "string" ? [[k, (raw[k] as string).slice(0, 2000)]] : []));
// Reused from HighLevelCrm.#trimOpportunity and listPipelines, with explicit bounds.
function deal(raw: unknown): Args {
  const r = object(raw);
  const out = strings(r, ["id", "name", "status", "pipelineId", "pipelineStageId", "contactId", "assignedTo", "source", "createdAt", "updatedAt", "lastStageChangeAt", "lastStatusChangeAt"]);
  if (typeof r.monetaryValue === "number" && Number.isFinite(r.monetaryValue)) out.monetaryValue = r.monetaryValue;
  if (r.contact) out.contact = strings(object(r.contact), ["id", "name", "email", "phone", "companyName"]);
  return out;
}
function projection(verb: Verb, value: unknown): unknown {
  const r = object(value);
  if (verb === "pipelines.list") return { pipelines: list(r.pipelines).slice(0, PAGE_MAX).map(p => ({ ...strings(p, ["id", "name"]),
    stages: list(p.stages).slice(0, PAGE_MAX).map(s => ({ ...strings(s, ["id", "name"]), ...(typeof s.position === "number" && Number.isFinite(s.position) ? { position: s.position } : {}) })),
  })) };
  if (verb === "search") return { opportunities: list(r.opportunities).slice(0, PAGE_MAX).map(deal),
    ...(typeof (object(r.meta).total ?? r.total) === "number" && Number.isFinite(object(r.meta).total ?? r.total) ? { total: object(r.meta).total ?? r.total } : {}) };
  if (verb === "delete" || verb === "pipelines.delete") return { success: r.succeded === true || r.succeeded === true || r.success === true };
  if (verb === "pipelines.create" || verb === "pipelines.update") {
    const p = object(r.pipeline ?? r);
    return { ...strings(p, ["id", "name", "locationId", "colorRenderMode", "position"]),
      stages: list(p.stages).slice(0, PAGE_MAX).map(s => ({ ...strings(s, ["id", "name"]), ...(typeof s.position === "number" && Number.isFinite(s.position) ? { position: s.position } : {}) })) };
  }
  if (verb === "status") return { success: r.succeded === true || r.succeeded === true || r.success === true };
  if (verb.startsWith("followers.")) return Object.fromEntries(["followers", "followersAdded", "followersRemoved"].flatMap(k =>
    Array.isArray(r[k]) ? [[k, (r[k] as unknown[]).filter(v => ID.safeParse(v).success).slice(0, 10)]] : []));
  return deal(r.opportunity ?? value);
}
/** Bound aggregate JSON as well as each field/list; provider data is engine-only. */
function project(verb: Verb, value: unknown): unknown {
  let remaining = 60 * 1024;
  const visit = (v: unknown): unknown => {
    if (remaining < 8) return undefined;
    remaining -= 4;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) { const next = visit(item); if (next === undefined) break; out.push(next); }
      return out;
    }
    if (v && typeof v === "object") {
      const out: Args = {};
      for (const [key, item] of Object.entries(v)) {
        const cost = Buffer.byteLength(JSON.stringify(key)) + 2;
        if (cost > remaining) break;
        remaining -= cost;
        const next = visit(item);
        if (next !== undefined) out[key] = next;
      }
      return out;
    }
    const json = JSON.stringify(v);
    if (json === undefined || Buffer.byteLength(json) > remaining) return undefined;
    remaining -= Buffer.byteLength(json);
    return v;
  };
  return visit(projection(verb, value)) ?? {};
}
async function own(crm: PreflightRequester, a: Args, locationId: string): Promise<void> {
  if (!ID.safeParse(locationId).success || (a.locationId !== undefined && a.locationId !== locationId)) fail("Choose the HighLevel business connected here.");
  let existing: Args | undefined;
  const opportunityId = a.opportunityId ?? a.id;
  if (opportunityId) {
    const raw = object(await crm.read("opportunities.get", { path: `/opportunities/${seg(opportunityId)}` }));
    existing = object(raw.opportunity);
    if (existing.id !== opportunityId || !ID.safeParse(existing.pipelineId).success ||
      (existing.locationId !== undefined && existing.locationId !== locationId)) fail("The deal's location ownership could not be verified.");
  }
  // Pipeline membership proves the location even when Get Opportunity omits locationId.
  if (a.pipelineId || a.pipelineStageId || existing) {
    const raw = object(await crm.read("opportunities.pipelines.list", { path: "/opportunities/pipelines", query: { locationId } }));
    const pipelines = list(raw.pipelines).filter(p => p.locationId === undefined || p.locationId === locationId);
    if (existing && !pipelines.some(p => p.id === existing!.pipelineId)) fail("The deal's pipeline is outside the granted location.");
    const selectedId = a.pipelineId ?? existing?.pipelineId;
    const pipeline = pipelines.find(p => p.id === selectedId);
    if (!pipeline) fail("The pipeline is outside the granted location.");
    if (Array.isArray(a.stages)) {
      for (const candidate of a.stages.map(object)) {
        if (candidate.id && !list(pipeline!.stages).some(s => s.id === candidate.id)) fail("The stage does not belong to the selected pipeline.");
      }
    }
    const stageId = a.pipelineStageId ?? (a.pipelineId && existing ? existing.pipelineStageId : undefined);
    if (stageId !== undefined && !list(pipeline!.stages).some(s => s.id === stageId)) fail("The stage does not belong to the selected pipeline.");
  }
  if (a.contactId) {
    const raw = object(await crm.read("contacts.get", { path: `/contacts/${seg(a.contactId)}` }));
    const contact = object(raw.contact);
    if (contact.id !== a.contactId || contact.locationId !== locationId) fail("The contact's location ownership could not be verified.");
  }
  const users = [...new Set([...(Array.isArray(a.followers) ? a.followers : []), ...(a.assignedTo ? [a.assignedTo] : [])])];
  for (const userId of users) {
    const raw = object(await crm.read("users.get", { path: `/users/${seg(userId)}` }));
    const user = object(raw.user ?? raw);
    const locations = object(user.roles).locationIds;
    if (user.id !== userId || !Array.isArray(locations) || !locations.includes(locationId)) fail("The user's location ownership could not be verified.");
  }
}
function contextArgs(schema: z.ZodType<Args>, input: Args, ctx: OperationRunContext): Args {
  const a = schema.parse(input);
  const locationId = ID.parse(ctx.locationId);
  if (a.locationId !== undefined && a.locationId !== locationId) fail("Choose the HighLevel business connected here.");
  return { ...a, locationId };
}
function draftFor(verb: Verb, a: Args): RequestDraft {
  // Upsert's optional id is retained in the body and bound by the shared
  // identity gate. Its collection endpoint still requires a location resource.
  const resourceId = a.opportunityId;
  const resource = resourceId ? `opportunities:opportunity:${resourceId}`
    : (verb === "pipelines.update" || verb === "pipelines.delete") ? `opportunities:pipeline:${a.pipelineId}` : `location:${a.locationId}`;
  const draft: RequestDraft = { path: pathFor(verb, a), resource };
  if (!endpointFor(`opportunities.${verb}`, HIGHLEVEL_ENDPOINTS[`opportunities.${verb}`]!.method, draft.path)) fail("provider_absent: this operation is not in the qualified HighLevel manifest.");
  if (verb === "pipelines.list") draft.query = { locationId: a.locationId as string };
  else if (verb === "search") {
    draft.query = { location_id: a.locationId as string, page: String(a.page ?? 1), limit: String(a.limit ?? 20) };
    for (const [from, to] of [["query", "q"], ["pipelineId", "pipeline_id"], ["pipelineStageId", "pipeline_stage_id"], ["contactId", "contact_id"], ["status", "status"]]) {
      if (a[from!] !== undefined && !(from === "status" && a.status === "all")) draft.query[to!] = String(a[from!]);
    }
  } else if (riskFor(verb) !== "R" && verb !== "delete" && verb !== "pipelines.delete") {
    draft.body = { kind: "json", value: Object.fromEntries(Object.entries(a).filter(([k, v]) => k !== "opportunityId" && !(k === "pipelineId" && verb === "pipelines.update") && v !== undefined && (k !== "locationId" || verb === "create" || verb === "upsert" || verb === "pipelines.create"))) };
  }
  return draft;
}
function make(row: Extract<ManifestRow, { disposition: "ready" }>): OperationSpec {
  const verb = row.id.slice("opportunities.".length) as Verb;
  const risk = row.risk;
  const args: z.ZodType<Args> = schemas[`opportunities.${verb}`];
  const base: SpecBase = {
    id: `opportunities.${verb}`, family: "opportunities", title: titles[verb], row, endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args,
    fields: input => {
      const a = args.parse(input);
      return risk === "R" ? [] : Object.keys(a).filter(k => k !== "locationId" && k !== "opportunityId" && k !== "id" && !(k === "pipelineId" && verb.startsWith("pipelines.")) && a[k] !== undefined).sort();
    },
    recordRefs: input => {
      const a = args.parse(input);
      return [...new Set([
        ...["id", "opportunityId", "contactId", "pipelineId", "pipelineStageId", "assignedTo"].flatMap(k => typeof a[k] === "string" ? [a[k] as string] : []),
        ...(Array.isArray(a.followers) ? a.followers as string[] : []),
        ...list(a.stages).flatMap(s => typeof s.id === "string" ? [s.id] : []),
      ])];
    },
    targets: input => {
      const a = args.parse(input);
      // Replacing stages can migrate every deal in a removed stage. Treat that
      // provider-side bulk change as D through the host's targets escalation.
      if (verb === "pipelines.update" && Array.isArray(a.stages)) return Math.max(2, a.stages.length);
      return Array.isArray(a.followers) ? Math.max(1, a.followers.length) : 1;
    },
    nested: row.preflight.length > 0, preflight: row.preflight,
    ownership: async (pre, input, ctx) => {
      const a = contextArgs(args, input, ctx);
      draftFor(verb, a);
      await own(pre, a, a.locationId as string);
    },
    project: (value, frozen?: FrozenRequest) => {
      if (risk !== "R") bindResponse(verb, value, frozen);
      validateResponse(verb, value);
      return project(verb, value);
    },
  };
  if (risk === "R") return { ...base, risk, maxReads: 1,
    prepareRead: async (input, ctx) => draftFor(verb, contextArgs(args, input, ctx)),
  };
  if (row.gate === "R") throw new Error("Mutation row requires a write gate");
  return { ...base, risk, gate: row.gate, send: row.send, precondition: row.precondition,
    prepare: async (pre, input, ctx) => {
      // Clone before the first await; ownership cannot retarget the request.
      const a = contextArgs(args, input, ctx);
      const draft = draftFor(verb, a);
      await own(pre, a, a.locationId as string);
      return draft;
    },
    recordId: (value, frozen?: FrozenRequest) => { bindResponse(verb, value, frozen); return validateResponse(verb, value); },
  };
}
// Both hooks fail closed without the exact dispatch-prepared F0.2 binding.
// The shared walk checks the entire raw response before any field is projected.
function bindResponse(verb: Verb, raw: unknown, frozen?: FrozenRequest): void {
  const refuse = (outcome: "not_applied" | "outcome_unknown" = "outcome_unknown"): never => {
    throw new HighLevelError("HighLevel did not confirm the expected record and change.", { outcome });
  };
  if (!frozen || frozen.operation !== `opportunities.${verb}`) return refuse();
  let result;
  try { result = bindReturnedIdentities(raw, frozen, returnedIdentitySchemaFor(frozen)); }
  catch { return refuse(); }
  if (result.status !== "applied") refuse(result.status === "not_applied" ? "not_applied" : "outcome_unknown");
}
function validateResponse(verb: Verb, raw: unknown): string | undefined {
  const risk = riskFor(verb), r = object(raw);
  const refuse = (): never => { throw new HighLevelError("HighLevel did not confirm the expected record and change.", { outcome: risk === "R" ? "not_applied" : "outcome_unknown" }); };
  // Negative or conflicting confirmation must not be hidden by a success alias.
  if (["success", "succeeded", "succeded"].some(key => key in r && r[key] !== true)) return refuse();
  const pipeline = verb.startsWith("pipelines.");
  const envelope = pipeline ? "pipeline" : "opportunity";
  if (envelope in r && (r[envelope] === null || typeof r[envelope] !== "object" || Array.isArray(r[envelope]))) return refuse();
  const record = envelope in r ? object(r[envelope]) : r;
  if (["delete", "status", "pipelines.delete"].includes(verb)) {
    if (r.succeded !== true && r.succeeded !== true && r.success !== true) return refuse();
    return ID.safeParse(record.id).success ? record.id as string : undefined;
  }
  if (verb.startsWith("followers.")) {
    const key = verb === "followers.add" ? "followersAdded" : "followersRemoved";
    const opposite = verb === "followers.add" ? "followersRemoved" : "followersAdded";
    const changed = r[key];
    if (!Array.isArray(changed) || changed.length < 1 || changed.length > 10 || changed.some(id => !ID.safeParse(id).success)
      || new Set(changed).size !== changed.length || opposite in r) return refuse();
    if ("followers" in r && (!Array.isArray(r.followers) || r.followers.some(id => !ID.safeParse(id).success)
      || changed.some(id => verb === "followers.add" ? !(r.followers as unknown[]).includes(id) : (r.followers as unknown[]).includes(id)))) return refuse();
    return ID.safeParse(record.id).success ? record.id as string : undefined;
  }
  if (["create", "update", "upsert", "get", "pipelines.create", "pipelines.update"].includes(verb)) {
    if (!ID.safeParse(record.id).success) return refuse();
    return record.id as string;
  }
  return undefined;
}

export const opportunitiesOperations: readonly OperationSpec[] = readyRows.map(make);
export default opportunitiesOperations;
