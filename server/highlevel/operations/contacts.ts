// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FrozenRequest } from "../held-request.ts";
import { bindReturnedIdentities, returnedIdentitySchemaFor } from "../returned-identities.ts";
import { retainContactTags } from "../contact-confirmation.ts";
import { z } from "zod";
import { HighLevelError } from "../errors.ts";
import { HIGHLEVEL_ENDPOINTS, type HighLevelMethod } from "../provider-contract.ts";

import type { OperationSpec, OperationRunContext, PreflightRequester, RequestDraft, SpecBase } from "./registry.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { schemas } from "./schemas/contacts.ts";
import type { OperationId } from "../../../shared/highlevel.ts";

type Args = Record<string, unknown>;
const record = (v: unknown): Args => v && typeof v === "object" && !Array.isArray(v) ? v as Args : {};
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/u)
  .refine((v) => !v.includes("..") && !/%(?:2e|2f|5c|25)/iu.test(v) && v !== ".", "Invalid record id");
const writeNames = ["firstName", "lastName", "name", "email", "phone", "companyName", "tags", "source", "address1", "city", "state", "postalCode", "country", "website", "timezone", "assignedTo", "dateOfBirth", "dnd", "customFields"];
const taskFieldNames = ["title", "dueDate", "body", "assignedTo", "completed"];

const scalarKeys = new Set(["id", "locationId", "contactId", "name", "contactName", "firstName", "lastName", "email", "phone", "companyName", "source", "assignedTo", "dateAdded", "dateUpdated", "website", "timezone", "dnd", "address1", "city", "state", "postalCode", "country", "dateOfBirth", "body", "title", "dueDate", "completed", "userId", "pinned", "color", "calendarId", "startTime", "endTime", "appointmentStatus", "status", "total", "count", "page", "succeeded", "succeded", "errorCount", "success", "value", "field_value", "fieldValue"]);
const objectKeys = new Set(["contact", "contacts", "note", "notes", "task", "tasks", "events", "appointments", "customFields"]);
const stringArrays = new Set(["tags", "followers", "followersAdded", "followersRemoved"]);
function project(v: unknown, depth = 0, budget = { left: 65_536 }): unknown {
  if (budget.left < 64) return undefined;
  budget.left -= 4;
  if (depth > 8) return undefined;
  if (typeof v === "string") {
    const out = v.slice(0, Math.min(4000, Math.max(0, Math.floor((budget.left - 2) / 6))));
    budget.left -= Buffer.byteLength(JSON.stringify(out));
    return out;
  }
  if (typeof v === "boolean" || v === null || (typeof v === "number" && Number.isFinite(v))) { budget.left -= 32; return v; }
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => project(x, depth + 1, budget)).filter((x) => x !== undefined);
  const out: Args = {};
  for (const [key, child] of Object.entries(record(v))) {
    if (budget.left < 128) break;
    budget.left -= Buffer.byteLength(JSON.stringify(key)) + 2;
    if (scalarKeys.has(key) && (child === null || ["string", "number", "boolean"].includes(typeof child))) out[key] = project(child, depth + 1, budget);
    else if (["value", "field_value", "fieldValue"].includes(key) && Array.isArray(child)) out[key] = project(child, depth + 1, budget);
    else if (objectKeys.has(key)) out[key] = project(child, depth + 1, budget);
    else if (stringArrays.has(key) && Array.isArray(child)) out[key] = project(child.filter((x) => typeof x === "string"), depth + 1, budget);
  }
  return out;
}
function ownershipError(): never { throw new HighLevelError("Contact ownership could not be confirmed for this location.", { status: 403 }); }
async function ownedContact(crm: PreflightRequester, contactId: string, locationId: string): Promise<void> {
  const raw = record(await crm.read("contacts.get", { path: `/contacts/${encodeURIComponent(contactId)}` }));
  const row = record(raw.contact);
  if (row.id !== contactId || row.locationId !== locationId) ownershipError();
}
async function ownership(crm: PreflightRequester, a: Args, locationId: string): Promise<void> {
  if (!id.safeParse(locationId).success || (a.locationId !== undefined && a.locationId !== locationId)) ownershipError();
  const parents = typeof a.contactId === "string" ? [a.contactId] : Array.isArray(a.contacts) ? a.contacts as string[] : [];
  for (const parent of parents) await ownedContact(crm, parent, locationId);
  for (const [key, collection, singular] of [["noteId", "notes", "note"], ["taskId", "tasks", "task"]] as const) {
    if (typeof a[key] !== "string") continue;
    const raw = record(await crm.read(`contacts.${collection}.get` as OperationId, { path: `/contacts/${encodeURIComponent(String(a.contactId))}/${collection}/${encodeURIComponent(String(a[key]))}` }));
    const nested = record(raw[singular]);
    if (nested.id !== a[key] || nested.contactId !== a.contactId) ownershipError();
  }
}
async function resolveCustomFields(crm: PreflightRequester, a: Args, locationId: string): Promise<Args> {
  const { contactId: _contact, locationId: _location, customFields, ...plain } = a;
  if (customFields === undefined) return plain;
  // Same name/id/key resolution as HighLevelCrm.#customFieldsByName. Never pick a
  // first match: a duplicate name is refused, and only ids are in the error.
  if (!id.safeParse(locationId).success) ownershipError();
  const raw = record(await crm.read("location.customFields.list", { path: `/locations/${encodeURIComponent(locationId)}/customFields` }));
  const definitions = Array.isArray(raw.customFields) ? raw.customFields.map(record) : [];
  const mapped = (customFields as Args[]).map((field) => {
    const wanted = typeof field.name === "string" ? field.name.trim().toLowerCase() : undefined;
    const matches = definitions.filter((f) => field.id !== undefined ? f.id === field.id
      : [f.name, f.fieldKey, f.key].some((key) => typeof key === "string" && [wanted, `contact.${wanted}`].includes(key.toLowerCase())));
    if (matches.length !== 1 || !id.safeParse(matches[0]?.id).success) {
      const ids = matches.map((f) => f.id).filter((x) => id.safeParse(x).success).slice(0, 50);
      throw new HighLevelError(`Custom field is missing or ambiguous. Use a field id${ids.length ? `: ${ids.join(", ")}` : "."}`, { status: 400 });
    }
    return { id: matches[0]!.id, value: field.value };
  });
  return { ...plain, customFields: mapped };
}

function operation(verb: string, risk: "R" | "C" | "D", title: string, method: HighLevelMethod, path: string,
  fieldKeys: readonly string[] = [], resultKey?: "contact" | "note" | "task"): OperationSpec {
  const operationId = `contacts.${verb}` as keyof typeof schemas;
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === operationId);
  if (!row || row.disposition !== "ready" || row.risk !== risk || row.method !== method) {
    throw new Error("Contact operation differs from the frozen provider contract");
  }
  const args: z.ZodType<Args> = schemas[operationId].argsSchema;
  const topLevelFields = new Set(row.projection);
  const projection = (v: unknown) => project(Object.fromEntries(Object.entries(record(v)).filter(([key]) => topLevelFields.has(key))));
  const nested = !["search", "create", "upsert"].includes(verb);
  const preflight = row.preflight;
  const gate = risk === "D" ? "GD" : "GC";
  const base: SpecBase = {
    row, nested, preflight,
    id: operationId, family: "contacts", title, endpoint: HIGHLEVEL_ENDPOINTS[operationId]!, args,
    fields: (a) => fieldKeys.filter((key) => a[key] !== undefined).sort(),
    recordRefs: (a) => [a.contactId, a.noteId, a.taskId, ...(Array.isArray(a.contacts) ? a.contacts : [])].filter((v): v is string => typeof v === "string" && id.safeParse(v).success),
    targets: (a) => Array.isArray(a.contacts) ? new Set(a.contacts).size : 1,
    async ownership(pre, input, ctx) {
      if (!ctx || !id.safeParse(ctx.locationId).success) ownershipError();
      const a = args.parse(input);
      await ownership(pre, a, ctx.locationId);
      if (a.customFields !== undefined) {
        const mapped = (await resolveCustomFields(pre, a, ctx.locationId)).customFields as Args[];
        // Retain the array identity of a host's shallow copy before review.
        (input.customFields as Args[]).splice(0, (input.customFields as Args[]).length, ...mapped);
      }
    },
    project: projection,
  };
  const draft = (input: Args, ctx: OperationRunContext): RequestDraft => {
    if (!ctx || !id.safeParse(ctx.locationId).success) ownershipError();
    const a = args.parse(input);
    const route = path.replace(/:([A-Za-z]+)/gu, (_match, key: string) => encodeURIComponent(String(a[key])));
    let body: Args | undefined;
    if (verb === "search") {
      const filters = ["email", "phone", "tag"].filter((key) => a[key] !== undefined).map((key) => ({ field: key === "tag" ? "tags" : key, operator: "eq", value: a[key] }));
      body = { locationId: ctx.locationId, page: a.page ?? 1, pageLimit: a.limit ?? 20, ...(a.query ? { query: a.query } : {}), ...(filters.length ? { filters } : {}) };
    } else if (["create", "update", "upsert"].includes(verb)) {
      const { contactId: _contact, customFields, ...plain } = a;
      body = plain;
      if (customFields !== undefined) {
        if ((customFields as Args[]).some(field => field.name !== undefined)) ownershipError();
        body.customFields = (customFields as Args[]).map(field => ({ id: field.id, field_value: field.value }));
      }
      if (verb !== "update") body.locationId = ctx.locationId;
    } else if (method !== "GET" && !verb.endsWith("delete") && verb !== "delete") {
      const { contactId: _c, noteId: _n, taskId: _t, type: _type, ...fields } = a;
      body = fields;
      if (verb === "tags.bulk") body.locationId = ctx.locationId;
    }
    // Nested paths bind their owning contact (manifest segment 2).
    // Child ids remain bound by the concrete path; bulk ids by the frozen body.
    const resource = typeof a.contactId === "string" ? `contacts:contact:${a.contactId}` : `location:${ctx.locationId}`;
    return { path: route, resource, ...(body ? { body: { kind: "json", value: body } as const } : {}) };
  };
  if (risk === "R") return { ...base, risk, maxReads: 1, async prepareRead(input, ctx) { return draft(input, ctx); } };
  const unconfirmed = (): never => { throw new HighLevelError("HighLevel did not confirm the approved record change.", { status: 200, outcome: "outcome_unknown" }); };
  const recordId = (raw: unknown, frozen?: FrozenRequest): string | undefined => {
    if (!frozen || frozen.operation !== operationId) return unconfirmed();
    let bound;
    try { bound = returnedIdentitySchemaFor(frozen); } catch { return unconfirmed(); }
    const binding = bindReturnedIdentities(raw, frozen, bound);
    if (binding.status === "not_applied") throw new HighLevelError("HighLevel did not apply the approved change.", { status: 200, outcome: "not_applied" });
    if (binding.status !== "applied") return unconfirmed();
    const envelope = record(raw);
    // Identity roles, aliases and confirmations belong exclusively to the shared
    // gate. Retain this family's payload shape requirements before projection.
    if (resultKey) {
      const candidate = record(envelope[resultKey]).id;
      if (!id.safeParse(candidate).success) return unconfirmed();
      return candidate as string;
    }
    const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
    const confirmed = verb.startsWith("followers.") ? strings(envelope.followers) && envelope.followers.every(value => id.safeParse(value).success)
      : verb === "tags.add" || verb === "tags.remove" ? strings(envelope.tags)
      : (envelope.succeeded === true || envelope.succeded === true) && (verb !== "tags.bulk" || envelope.errorCount === 0);
    if (!confirmed) return unconfirmed();
    return undefined; // No provider ID was returned; approved IDs remain recordRefs.
  };
  return {
    ...base, risk, gate, send: false, precondition: "none", recordId,
    async prepare(pre, input, ctx) {
      const a = args.parse(input);
      let tags: unknown;
      const checked = { read: async (...params: Parameters<typeof pre.read>) => {
        const value = await pre.read(...params);
        if (params[0] === 'contacts.get') tags = record(record(value).contact).tags;
        return value;
      } };
      await base.ownership!(checked, a, ctx);
      const prepared = draft(a, ctx);
      if (verb === 'tags.add' || verb === 'tags.remove') retainContactTags(prepared, tags);
      return prepared;
    },
    project(value, frozen?: FrozenRequest) { recordId(value, frozen); return projection(value); },
  };
}

const contactSpecs: readonly OperationSpec[] = [
  operation("search", "R", "Search contacts", "POST", "/contacts/search"),
  operation("get", "R", "Read a contact", "GET", "/contacts/:contactId"),
  operation("create", "C", "Create a contact", "POST", "/contacts/", writeNames, "contact"),
  operation("update", "C", "Update a contact", "PUT", "/contacts/:contactId", writeNames, "contact"),
  operation("upsert", "C", "Create or update a contact", "POST", "/contacts/upsert", writeNames, "contact"),
  operation("delete", "D", "Delete a contact", "DELETE", "/contacts/:contactId"),
  operation("tags.add", "C", "Add contact tags", "POST", "/contacts/:contactId/tags", ["tags"]),
  operation("tags.remove", "C", "Remove contact tags", "DELETE", "/contacts/:contactId/tags", ["tags"]),
  operation("tags.bulk", "D", "Change tags on contacts", "POST", "/contacts/bulk/tags/update/:type", ["tags", "removeAllTags"]),
  operation("notes.list", "R", "List contact notes", "GET", "/contacts/:contactId/notes"),
  operation("notes.get", "R", "Read a contact note", "GET", "/contacts/:contactId/notes/:noteId"),
  operation("notes.create", "C", "Add a contact note", "POST", "/contacts/:contactId/notes", ["body", "userId"], "note"),
  operation("notes.update", "C", "Update a contact note", "PUT", "/contacts/:contactId/notes/:noteId", ["body", "userId"], "note"),
  operation("notes.delete", "D", "Delete a contact note", "DELETE", "/contacts/:contactId/notes/:noteId"),
  operation("tasks.list", "R", "List contact tasks", "GET", "/contacts/:contactId/tasks"),
  operation("tasks.get", "R", "Read a contact task", "GET", "/contacts/:contactId/tasks/:taskId"),
  operation("tasks.create", "C", "Add a contact task", "POST", "/contacts/:contactId/tasks", taskFieldNames, "task"),
  operation("tasks.update", "C", "Update a contact task", "PUT", "/contacts/:contactId/tasks/:taskId", taskFieldNames, "task"),
  operation("tasks.complete", "C", "Set contact task completion", "PUT", "/contacts/:contactId/tasks/:taskId/completed", ["completed"], "task"),
  operation("tasks.delete", "D", "Delete a contact task", "DELETE", "/contacts/:contactId/tasks/:taskId"),
  operation("appointments.list", "R", "List contact appointments", "GET", "/contacts/:contactId/appointments"),
  operation("followers.add", "C", "Add contact followers", "POST", "/contacts/:contactId/followers", ["followers"]),
  operation("followers.remove", "C", "Remove contact followers", "DELETE", "/contacts/:contactId/followers", ["followers"]),
];

export const contactsOperations: readonly OperationSpec[] = contactSpecs;
export default contactsOperations;
