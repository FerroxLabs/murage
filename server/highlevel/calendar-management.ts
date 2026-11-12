// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { Family, OperationId } from '../../shared/highlevel.ts';
import { HighLevelHost, type HighLevelHostDeps } from './host.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from './operations/manifest.ts';
import { operationSpec, familyOperations, type ManifestRow, type OperationSpec } from './operations/registry.ts';
import { calendarOperationFor } from './operations/calendars.ts';
import { schemas } from './operations/schemas/calendars.ts';
import { highlevelIdSchema as id } from './operations/schemas/common.ts';
import { HIGHLEVEL_ENDPOINTS, highlevelEndpointPattern } from './provider-contract.ts';
import { HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS } from './operations/returned-identity-schemas.ts';
import { reconciliationReadsFor } from './operations/reconciliation.ts';
import { registerOperationExtension } from './operation-extension.ts';
import { bindCalendarContext, calendarContextFor } from './calendar-context.ts';
import { canonicalBindingJson } from './binding-json.ts';
import { calendarUserPrerequisite } from './calendar-prerequisite.ts';

/** Separate selector: the frozen schema and all old callers remain unchanged.
 * New callers must provide the observed interval when proving an existing block.
 * These fields never become editable provider fields or approved wire bytes. */
export const blockSelector = z.strictObject({
 originalStartTime: z.string().max(10000).optional(),
 originalEndTime: z.string().max(10000).optional(),
 originalUserId: id.optional(),
});
const blockedId = 'calendars.blockSlots.list' as const;
const blockedPath = '/calendars/blocked-slots';
const blockedEndpoint = Object.freeze({ method: 'GET' as const, path: highlevelEndpointPattern(blockedPath), version: '2021-07-28', scope: 'calendars/events.readonly', retry: 'read' as const });
const prerequisites: Readonly<Partial<Record<OperationId, readonly OperationId[]>>> = {
 "calendars.list": [
  "calendars.groups.list"
 ],
 "calendars.get": [
  "calendars.get"
 ],
 "calendars.freeSlots": [
  "calendars.get",
  "users.list"
 ],
 "calendars.groups.list": [],
 "calendars.resources.list": [],
 "calendars.create": [
  "calendars.list",
  "calendars.groups.list",
  "users.list"
 ],
 "calendars.update": [
  "calendars.get",
  "calendars.groups.list",
  "users.list"
 ],
 "calendars.delete": [
  "calendars.get"
 ],
 "calendars.events.list": [
  "calendars.get",
  "calendars.groups.list",
  "users.list"
 ],
 "calendars.blockSlots.list": [
  "calendars.get",
  "calendars.groups.list",
  "users.list"
 ],
 "calendars.appointment.get": [
  "calendars.appointment.get"
 ],
 "calendars.appointment.book": [
  "calendars.freeSlots",
  "contacts.get",
  "calendars.events.list",
  "calendars.get",
  "users.list"
 ],
 "calendars.appointment.reschedule": [
  "calendars.appointment.get",
  "calendars.freeSlots",
  "calendars.get"
 ],
 "calendars.appointment.cancel": [
  "calendars.appointment.get"
 ],
 "calendars.event.delete": [
  "calendars.appointment.get",
  "calendars.get",
  "calendars.blockSlots.list",
  "users.list"
 ],
 "calendars.blockSlot.create": [
  "calendars.get",
  "users.list",
  "calendars.blockSlots.list"
 ],
 "calendars.blockSlot.update": [
  "calendars.get",
  "users.list",
  "calendars.blockSlots.list"
 ],
 "calendars.appointmentNotes.list": [
  "calendars.appointment.get"
 ],
 "calendars.appointmentNotes.create": [
  "calendars.appointment.get",
  "calendars.appointmentNotes.list",
  "users.list"
 ],
 "calendars.appointmentNotes.update": [
  "calendars.appointment.get",
  "calendars.appointmentNotes.list",
  "users.list"
 ],
 "calendars.appointmentNotes.delete": [
  "calendars.appointment.get",
  "calendars.appointmentNotes.list"
 ]
};
const baseRows = HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === 'calendars' && row.disposition === 'ready');
const extraArgs = (row: ManifestRow): z.ZodTypeAny => {
 const schema = row.argsSchema as z.ZodObject;
 if (row.id === 'calendars.blockSlot.update') return schema.safeExtend(blockSelector.shape);
 if (row.id === 'calendars.event.delete') return schema.safeExtend({ ...blockSelector.shape, eventType: z.enum(['appointment', 'block']).optional(), calendarId: id.optional(), userId: id.optional() });
 if (row.id.startsWith('calendars.appointmentNotes.') && row.risk !== 'R') return schema.safeExtend({ noteOffset: z.number().int().min(0).max(10000).optional() });
 return row.argsSchema;
};
// New immutable rows, never replacements in the frozen manifest. Preflight reads
// are additive here; only this new contract chooses the dedicated block route.
export const CALENDAR_MANAGEMENT_MANIFEST: readonly ManifestRow[] = Object.freeze([
 ...baseRows.map(row => Object.freeze({ ...row, argsSchema: extraArgs(row), preflight: Object.freeze([...new Set([...row.preflight, ...(prerequisites[row.id] ?? [])])]) })),
 Object.freeze({ id: blockedId, family: 'calendars' as const, risk: 'R' as const, gate: 'R' as const, send: false, precondition: 'none' as const,
  disposition: 'ready' as const, method: 'GET' as const, path: blockedPath, version: blockedEndpoint.version, scope: blockedEndpoint.scope,
  docUrl: 'https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/calendars/get-blocked-slots/', pathResourceSegment: null,
  preflight: Object.freeze([...(prerequisites[blockedId] ?? [])]), argsSchema: schemas['calendars.events.list'].argsSchema, bodySchema: null, projection: Object.freeze(['events']) }),
]);
const readRow = (op: OperationId) => CALENDAR_MANAGEMENT_MANIFEST.find(row => row.id === op) ?? HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === op);
const specs = new Map<string, OperationSpec>();
for (const row of CALENDAR_MANAGEMENT_MANIFEST) {
 if (row.disposition !== 'ready') continue;
 const endpoint = row.id === blockedId ? blockedEndpoint : HIGHLEVEL_ENDPOINTS[row.id]!;
 const original = HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[row.id];
 const identities = original && { ...original, identities: Object.freeze({ ...original.identities,
  ...Object.fromEntries(['calendarId', 'contactId', 'assignedUserId', 'appointmentId', 'userId', 'groupId'].flatMap(key => [[key, key], [key.replace(/Id$/u, '_id'), key]])) }) };
 const reconciliation = row.risk === 'R' ? [] : row.id.startsWith('calendars.blockSlot.') ? [blockedId]
  : [...reconciliationReadsFor(row.id), ...(row.id === 'calendars.event.delete' ? [blockedId] : [])];
 registerOperationExtension({ row, endpoint, reconciliation: Object.freeze(reconciliation), readRow, ...(identities ? { identities: Object.freeze(identities) } : {}),
  bindDraft: bindCalendarContext,
  reviewRefs: frozen => Object.values(calendarContextFor(frozen)?.parents ?? {}),
  revalidate: (held, fresh) => held.requestDigest === fresh.requestDigest && Buffer.from(canonicalBindingJson(calendarContextFor(held) ?? null)).equals(Buffer.from(canonicalBindingJson(calendarContextFor(fresh) ?? null))),
  ...(row.id === 'calendars.event.delete' ? { absenceConfirmation: Object.freeze({ succeeded: true as const }) } : {}),
 });
 const spec = calendarOperationFor(row);
 specs.set(row.id, Object.freeze({ ...spec, endpoint }));
}
/** Opt in via this resolver; users.list remains a private preflight prerequisite. */
export function calendarManagementOperationSpec(op: string): OperationSpec | undefined {
 return specs.get(op) ?? (op === 'users.list' ? operationSpec(op) ?? calendarUserPrerequisite() : operationSpec(op));
}
/** Listing and execution must use the same opt-in schema objects. */
export function calendarManagementFamilyOperations(family: Family): readonly OperationSpec[] {
 return family === 'calendars' ? [...specs.values()] : familyOperations(family);
}
/** New entry point; constructing HighLevelHost directly keeps legacy behavior. */
export function createCalendarManagementHost(deps: HighLevelHostDeps): HighLevelHost {
 return new HighLevelHost({ ...deps, operationSpec: calendarManagementOperationSpec, familyOperations: calendarManagementFamilyOperations });
}
