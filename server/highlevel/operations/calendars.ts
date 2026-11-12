// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { retainCalendarDraft, type CalendarContext } from "../calendar-context.ts";
import type { z } from "zod";
import type { OperationId } from "../../../shared/highlevel.ts";
import type { FrozenRequest } from "../held-request.ts";
import { HighLevelError } from "../response-contract.ts";
import { HIGHLEVEL_ENDPOINTS } from "../provider-contract.ts";
import { bindReturnedIdentities, returnedIdentitySchemaFor } from "../returned-identities.ts";
import { HIGHLEVEL_OPERATION_MANIFEST } from "./manifest.ts";
import { highlevelIdSchema as ID } from "./schemas/common.ts";
import type { ManifestRow, OperationSpec, OperationRunContext, PreflightRequester, RequestDraft, SpecBase } from "./registry.ts";

type Args = Record<string, unknown>;
type ReadyRow = Extract<ManifestRow, { disposition: "ready" }>;
const rows = HIGHLEVEL_OPERATION_MANIFEST.filter((row): row is ReadyRow => row.family === "calendars" && row.disposition === "ready");
const titles: Record<string, string> = {
 list: "List calendars", get: "Read a calendar", freeSlots: "Find available appointments", "groups.list": "List calendar groups",
 "resources.list": "List calendar resources", create: "Create a calendar", update: "Update a calendar", delete: "Delete a calendar",
 "events.list": "List calendar events", "blockSlots.list": "List blocked calendar time", "appointment.get": "Read an appointment", "appointment.book": "Book an appointment",
 "appointment.reschedule": "Reschedule an appointment", "appointment.cancel": "Cancel an appointment", "event.delete": "Delete a calendar event",
 "blockSlot.create": "Block calendar time", "blockSlot.update": "Update blocked time", "appointmentNotes.list": "List appointment notes",
 "appointmentNotes.create": "Add an appointment note", "appointmentNotes.update": "Update an appointment note", "appointmentNotes.delete": "Delete an appointment note",
};
const record = (v: unknown): Args => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Args : {};
const unwrap = (v: unknown, key: string): Args => record(record(v)[key] ?? v);
const id = (v: unknown) => encodeURIComponent(ID.parse(v));
const req = (crm: PreflightRequester, op: OperationId, path: string, query?: Record<string, string>) => crm.read(op, { path, ...(query ? { query } : {}) });
function owned(value: Args, expectedId: unknown, locationId: unknown): void {
  if (!ID.safeParse(value.id).success || value.id !== expectedId || value.locationId !== locationId) throw new Error("HighLevel ownership could not be verified");
}
async function calendar(crm: PreflightRequester, calendarId: unknown, locationId: unknown): Promise<Args> {
  const value = unwrap(await req(crm, "calendars.get", `/calendars/${id(calendarId)}`), "calendar");
  owned(value, calendarId, locationId); return value;
}
async function appointment(crm: PreflightRequester, eventId: unknown, locationId: unknown): Promise<Args> {
  const value = unwrap(await req(crm, "calendars.appointment.get", `/calendars/events/appointments/${id(eventId)}`), "event");
  owned(value, eventId, locationId);
  // The event is the parent of notes and carries its own location proof.
  // Calendar availability is checked separately when changing the times.
  return value;
}
// Block proof comes only from the qualified blocked-slot collection and the
// original interval, which can differ from the new times being requested.
async function block(crm: PreflightRequester, a: Args, locationId: string): Promise<Args> {
  const raw = record(await req(crm, "calendars.blockSlots.list", "/calendars/blocked-slots", {
    locationId, ...(a.originalUserId || a.userId || a.assignedUserId ? { userId: String(a.originalUserId ?? a.userId ?? a.assignedUserId) } : { calendarId: String(a.calendarId) }), startTime: String(Date.parse(String(a.originalStartTime))), endTime: String(Date.parse(String(a.originalEndTime))),
  }));
  const matches = Array.isArray(raw.events) ? raw.events.map(record).filter(e => e.id === a.eventId) : [];
  if (matches.length !== 1) throw new Error("HighLevel block ownership could not be verified");
  const value = matches[0]!;
  owned(value, a.eventId, locationId);
  if (value.calendarId !== a.calendarId || (value.type !== undefined && value.type !== "block") || value.contactId !== undefined || Date.parse(String(value.startTime)) !== Date.parse(String(a.originalStartTime)) || Date.parse(String(value.endTime)) !== Date.parse(String(a.originalEndTime))) throw new Error("HighLevel block ownership could not be verified");
  return value;
}
async function ownership(crm: PreflightRequester, a: Args, locationId: string, verb: string): Promise<Record<string, string>> {
  const parents: Record<string, string> = {};
  if (a.locationId !== locationId) throw new Error("HighLevel ownership could not be verified");
  if (a.calendarId) await calendar(crm, a.calendarId, locationId);
  if (a.contactId) owned(unwrap(await req(crm, "contacts.get", `/contacts/${id(a.contactId)}`), "contact"), a.contactId, locationId);
  if (a.eventId || a.appointmentId) {
    const event = verb === "blockSlot.update" || a.eventType === "block"
      ? await block(crm, a, locationId)
      : await appointment(crm, a.eventId ?? a.appointmentId, locationId);
    if (a.calendarId && event.calendarId !== a.calendarId) throw new Error("HighLevel ownership could not be verified");
    for (const key of ["calendarId", "contactId", "assignedUserId"]) if (event[key] !== undefined) parents[key] = ID.parse(event[key]);
  }
  if (a.noteId) {
    const page = record(await req(crm, "calendars.appointmentNotes.list", `/calendars/appointments/${id(a.appointmentId)}/notes`, { limit: "100", offset: String(a.noteOffset ?? 0) }));
    const matches = Array.isArray(page.notes) ? page.notes.map(record).filter(n => n.id === a.noteId) : [];
    if (matches.length !== 1 || (matches[0]!.appointmentId !== undefined && matches[0]!.appointmentId !== a.appointmentId)
      || (matches[0]!.contactId !== undefined && matches[0]!.contactId !== parents.contactId)) throw new Error("HighLevel note ownership could not be verified");
  }
  if (a.groupId) {
    const raw = record(await req(crm, "calendars.groups.list", "/calendars/groups", { locationId }));
    if (!Array.isArray(raw.groups) || !raw.groups.some(g => record(g).id === a.groupId && (record(g).locationId === undefined || record(g).locationId === locationId))) throw new Error("HighLevel group ownership could not be verified");
  }
  const users = [a.originalUserId, a.userId, a.assignedUserId, ...(Array.isArray(a.userIds) ? a.userIds : []), ...(Array.isArray(a.teamMembers) ? a.teamMembers.map(t => record(t).userId) : [])].filter(v => v !== undefined);
  if (users.length) {
    // Adapted from F6's location-scoped user ownership check. Provider membership
    // is roles.locationIds; never fetch a foreign global user to discover it.
    const page = record(await req(crm, "users.list", "/users/", { locationId }));
    if (!Array.isArray(page.users) || page.users.length > 10000 || page.nextPage || page.nextPageUrl || (typeof page.total === "number" && page.total > page.users.length)) throw new Error("HighLevel user ownership could not be verified");
    for (const userId of new Set(users)) {
      const matches = page.users.map(record).filter(user => user.id === userId);
      const user = matches.length === 1 ? matches[0]! : {};
      const locations = record(user.roles).locationIds ?? user.locationIds;
      if (!Array.isArray(locations) || !locations.includes(locationId) || (user.locationId !== undefined && user.locationId !== locationId)) throw new Error("HighLevel user ownership could not be verified");
    }
  }
  return parents;
}
function query(a: Args, keys: string[], times = false): Record<string, string> {
  return Object.fromEntries(keys.filter(k => a[k] !== undefined).map(k => [k, String(times && (k === "startTime" || k === "endTime") ? Date.parse(String(a[k])) : a[k])]));
}
async function checkSlot(crm: PreflightRequester, a: Args): Promise<void> {
  const cal = await calendar(crm, a.calendarId, a.locationId);
  const minutes = Number(cal.slotDuration) * (cal.slotDurationUnit === "hours" ? 60 : cal.slotDurationUnit === "mins" ? 1 : NaN);
  if (!Number.isFinite(minutes) || minutes <= 0 || Date.parse(String(a.endTime)) - Date.parse(String(a.startTime)) !== minutes * 60000) throw new Error("Appointment duration must match the calendar slot");
  const slots = record(await req(crm, "calendars.freeSlots", `/calendars/${id(a.calendarId)}/free-slots`, {
    startDate: String(Date.parse(String(a.startTime))), endDate: String(Date.parse(String(a.endTime))),
    ...(a.assignedUserId ? { userId: String(a.assignedUserId) } : {}),
  }));
  const available = Object.entries(slots).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/u.test(day)).some(([, value]) => {
    const times = record(value).slots;
    return Array.isArray(times) && times.some(t => typeof t === "string" && Date.parse(t) === Date.parse(String(a.startTime)));
  });
  if (!available) throw new Error("The requested appointment slot is not available");
}

// Projection adapted from HighLevelCrm.listCalendars/listEvents at c12aaad93:
// allowlisted fields, bounded lists, no provider error or arbitrary nested data.
const projectedKeys = new Set(["id", "locationId", "calendarId", "contactId", "name", "title", "description", "isActive", "calendarType", "slotDuration", "slotDurationUnit", "appointmentStatus", "startTime", "endTime", "assignedUserId", "address", "notes", "body", "userId", "dateAdded", "dateUpdated", "hasMore", "resourceType", "quantity", "capacity", "outOfService", "calendarIds", "success", "succeeded", "teamMembers"]);
const wrappers = new Set(["calendar", "calendars", "event", "events", "note", "notes", "groups", "resources", "slots"]);
function project(value: unknown): unknown {
  let budget = 12000;
  function walk(v: unknown, depth: number): unknown {
    if (budget <= 0 || depth > 4) return undefined;
    if (typeof v === "string") { const s = v.slice(0, Math.min(4000, budget)); budget -= s.length; return s; }
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) { budget -= 16; return v; }
    if (Array.isArray(v)) return v.slice(0, 100).map(x => walk(x, depth + 1)).filter(x => x !== undefined);
    return Object.fromEntries(Object.entries(record(v)).filter(([k]) => projectedKeys.has(k) || wrappers.has(k) || /^\d{4}-\d{2}-\d{2}$/u.test(k)).slice(0, 100).map(([k, x]) => [k, walk(x, depth + 1)]).filter(([, x]) => x !== undefined));
  }
  const result = walk(value, 0);
  // UTF-8 and JSON key/structural overhead count too (emoji is four bytes).
  return new TextEncoder().encode(JSON.stringify(result)).length <= 65536 ? result : { truncated: true };

}

// Cache only within one ownership/prepare invocation. Dispatch starts a fresh
// invocation, so no ownership or availability result survives the owner's review.
function cached(pre: PreflightRequester): PreflightRequester {
 const values = new Map<string, Promise<unknown>>();
 return { read(op, draft) {
   const key = JSON.stringify([op, draft]);
   if (!values.has(key)) values.set(key, pre.read(op, draft));
   return values.get(key)!;
 } };
}
function contextArgs(row: ReadyRow, input: Args, ctx: OperationRunContext): Args {
 const a = row.argsSchema.parse(input) as Args;
 const locationId = ID.parse(ctx.locationId);
 if (a.locationId !== undefined && a.locationId !== locationId) throw new Error("HighLevel ownership could not be verified");
 if (a.ignoreDateRange === true || a.ignoreFreeSlotValidation === true) throw new Error("Appointment availability checks cannot be skipped");
 if ((a.eventType === "block" || (row.id === "calendars.blockSlot.update" && row.preflight.includes("calendars.blockSlots.list"))) && (!a.calendarId || !a.originalStartTime || !a.originalEndTime)) throw new Error("HighLevel block ownership could not be verified");
 if (a.originalStartTime !== undefined || a.originalEndTime !== undefined) {
  const duration = Date.parse(String(a.originalEndTime)) - Date.parse(String(a.originalStartTime));
  if (!(duration > 0 && duration <= 31 * 86400000)) throw new Error("Date range must be positive and at most 31 days");
 }
 if (a.startTime !== undefined || a.endTime !== undefined) {
  const duration = Date.parse(String(a.endTime)) - Date.parse(String(a.startTime));
  if (!(duration > 0 && duration <= 31 * 86400000)) throw new Error("Date range must be positive and at most 31 days");
 }
 if (a.startDate !== undefined && !(Number.isSafeInteger(a.startDate) && Number.isSafeInteger(a.endDate) && Number(a.endDate) > Number(a.startDate) && Number(a.endDate) - Number(a.startDate) <= 31 * 86400000)) throw new Error("Invalid slot date range");
 if (a.resourceType !== undefined && !["rooms", "equipments"].includes(String(a.resourceType))) throw new Error("Invalid calendar resource type");
 for (const key of ["limit", "offset", "skip"]) if (a[key] !== undefined && (!Number.isSafeInteger(a[key]) || Number(a[key]) < (key === "limit" ? 1 : 0) || Number(a[key]) > (key === "limit" ? 100 : 10000))) throw new Error("Invalid page range");
 return { ...a, locationId };
}
function draftFor(row: ReadyRow, a: Args): RequestDraft {
 const verb = row.id.slice(10);
 const path = row.path.replace(/:([A-Za-z]+)/gu, (_, key: string) => id(a[key]));
 const segment = row.pathResourceSegment;
 const resource = segment === null ? `location:${a.locationId}` : `calendars:record:${decodeURIComponent(path.split("/")[segment]!)}`;
 const draft: RequestDraft = { path, resource };
 if (row.risk === "R") {
  const keys = verb === "freeSlots" ? ["startDate", "endDate", "timezone", "userId", "userIds"]
   : ["events.list", "blockSlots.list"].includes(verb) ? ["locationId", "calendarId", "userId", "groupId", "startTime", "endTime"]
   : verb === "appointmentNotes.list" ? ["limit", "offset"]
   : verb === "list" ? ["locationId", "groupId", "showDrafted"]
   : verb === "groups.list" ? ["locationId"] : verb === "resources.list" ? ["locationId", "limit", "skip"] : [];
  if (keys.length) draft.query = query(a, keys, ["events.list", "blockSlots.list"].includes(verb));
 } else if (row.bodySchema) {
  let body: Args = Object.fromEntries(Object.entries(a).filter(([key]) => !["noteOffset", "originalStartTime", "originalEndTime", "originalUserId"].includes(key) && !(verb === "event.delete" && key === "eventType") && !row.path.includes(`:${key}`) && (key !== "locationId" || ["create", "appointment.book", "blockSlot.create", "blockSlot.update"].includes(verb))));
  if (verb === "appointment.book") body = { ...body, ignoreDateRange: false, ignoreFreeSlotValidation: false };
  if (verb === "appointment.reschedule") {
   if (Object.keys(a).some(k => !["eventId", "locationId", "startTime", "endTime", "ignoreDateRange", "ignoreFreeSlotValidation"].includes(k))) throw new Error("Rescheduling only changes the appointment times");
   body = { startTime: a.startTime, endTime: a.endTime, ignoreDateRange: false, ignoreFreeSlotValidation: false };
  }
  if (verb === "appointment.cancel") {
   if (Object.keys(a).some(k => !["eventId", "locationId", "appointmentStatus"].includes(k))) throw new Error("Cancellation only changes the appointment status");
   body = { appointmentStatus: "cancelled" };
  }
  if (verb === "event.delete") body = {};
  draft.body = { kind: "json", value: row.bodySchema.parse(body) };
 }
 return draft;
}
async function verify(row: ReadyRow, pre: PreflightRequester, a: Args): Promise<CalendarContext> {
 const verb = row.id.slice(10), locationId = String(a.locationId);
 const parents = await ownership(pre, a, locationId, verb);
 if (verb === "appointment.book") await checkSlot(pre, a);
 if (verb === "appointment.reschedule") {
  const current = await appointment(pre, a.eventId, locationId);
  await checkSlot(pre, { ...a, calendarId: current.calendarId, assignedUserId: current.assignedUserId });
 }
 const recoveryOperation = ((verb === "event.delete" && a.eventType === "block") || (verb.startsWith("blockSlot.") && row.preflight.includes("calendars.blockSlots.list"))) ? "calendars.blockSlots.list" as const : undefined;
 const recoveryQuery: Record<string, string> | undefined = verb === "create" ? { locationId }
  : verb.startsWith("appointmentNotes.") ? { limit: "100", offset: String(a.noteOffset ?? 0) }
  : verb === "appointment.book" || verb.startsWith("blockSlot.") || recoveryOperation ? {
    locationId, calendarId: String(a.calendarId), ...(a.assignedUserId || a.userId ? { userId: String(a.assignedUserId ?? a.userId) } : {}),
    startTime: String(Date.parse(String(verb === "event.delete" ? a.originalStartTime : a.startTime))),
    endTime: String(Date.parse(String(verb === "event.delete" ? a.originalEndTime : a.endTime))),
  } : undefined;
 return { parents, ...(recoveryOperation ? { recoveryOperation } : {}), ...(recoveryQuery ? { recoveryQuery } : {}) };
}
function bindResponse(row: ReadyRow, value: unknown, frozen?: FrozenRequest): void {
 const refuse = (outcome: "outcome_unknown" | "not_applied" = "outcome_unknown"): never => { throw new HighLevelError("HighLevel did not confirm the expected record and change.", { outcome }); };
 if (!frozen || frozen.operation !== row.id) return refuse();
 let result;
 try { result = bindReturnedIdentities(value, frozen, returnedIdentitySchemaFor(frozen)); } catch { return refuse(); }
 if (result.status !== "applied") refuse(result.status === "not_applied" ? "not_applied" : "outcome_unknown");
}
function responseId(row: ReadyRow, value: unknown): string | undefined {
 const verb = row.id.slice(10), raw = record(value);
 if (["delete", "event.delete", "appointmentNotes.delete"].includes(verb)) {
  const key = verb === "event.delete" ? "succeeded" : "success";
  if (raw[key] !== true) throw new HighLevelError("HighLevel did not confirm the deletion.", { outcome: "outcome_unknown" });
  return undefined;
 }
 const item = verb.startsWith("appointmentNotes.") ? unwrap(value, "note") : ["create", "update"].includes(verb) ? unwrap(value, "calendar") : raw;
 if (!ID.safeParse(item.id).success) throw new HighLevelError("HighLevel did not confirm the expected record.", { outcome: "outcome_unknown" });
 return String(item.id);
}
const refKeys = new Set(["calendarId", "eventId", "appointmentId", "noteId", "contactId", "userId", "assignedUserId", "groupId"]);
function make(row: ReadyRow): OperationSpec {
 const verb = row.id.slice(10);
 const base: SpecBase = {
  id: row.id, family: "calendars", title: titles[verb]!, row, endpoint: HIGHLEVEL_ENDPOINTS[row.id]!, args: row.argsSchema as z.ZodType<Args>,
  nested: row.preflight.length > 0, preflight: row.preflight,
  recordRefs: input => { const a = row.argsSchema.parse(input) as Args; return [...new Set(Object.entries(a).filter(([k, v]) => refKeys.has(k) && ID.safeParse(v).success).map(([, v]) => String(v)))]; },
  fields: input => { const a = row.argsSchema.parse(input) as Args; return row.risk === "R" || row.risk === "D" ? [] : Object.keys(a).filter(k => !row.path.includes(`:${k}`) && k !== "locationId" && !["noteOffset", "originalStartTime", "originalEndTime", "originalUserId"].includes(k) && !(verb === "event.delete" && k === "eventType")).sort(); },
  targets: () => 1,
  ownership: async (pre, input, ctx) => { const a = contextArgs(row, input, ctx); draftFor(row, a); await verify(row, cached(pre), a); },
  project: (value, frozen?: FrozenRequest) => {
   if (row.risk !== "R") { bindResponse(row, value, frozen); responseId(row, value); }
   const selected = row.projection.includes("(root)") ? value : Object.fromEntries(Object.entries(record(value)).filter(([key]) => row.projection.includes(key)));
   return project(selected);
  },
 };
 if (row.risk === "R") return { ...base, risk: "R", maxReads: 1, prepareRead: async (input, ctx) => draftFor(row, contextArgs(row, input, ctx)) };
 if (row.gate === "R") throw new Error("Mutation row requires a write gate");
 return { ...base, risk: row.risk, gate: row.gate, send: row.send, precondition: row.precondition,
  prepare: async (pre, input, ctx) => { const a = contextArgs(row, input, ctx), draft = draftFor(row, a); retainCalendarDraft(draft, await verify(row, cached(pre), a)); return draft; },
  recordId: (value, frozen?: FrozenRequest) => { bindResponse(row, value, frozen); return responseId(row, value); },
 };
}
export const calendarsOperations: readonly OperationSpec[] = rows.map(make);
export default calendarsOperations;

/** New contracts may build a separate spec without replacing frozen rows. */
export function calendarOperationFor(row: ReadyRow): OperationSpec { return make(row); }
