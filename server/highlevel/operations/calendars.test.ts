// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FamilyLevel } from '../../../shared/highlevel.ts';
import { fixtureFamilyLevels } from '../testing/family-grants.ts';
import { describe, expect, it } from 'vitest';
import { calendarsOperations } from './calendars.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, freezeOperationSpec, type MutationSpec, type OperationSpec, type PreflightRequester } from './registry.ts';
import { HeldRequest } from '../held-request.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
import { levelCovers } from '../../../shared/highlevel.ts';

const locationId = 'loc_1', calendarId = 'cal_1', eventId = 'event_1';
const startTime = '2026-11-12T10:00:00Z', endTime = '2026-11-12T10:30:00Z';
const ctx = { locationId };
const appointment = { id: eventId, locationId, calendarId, contactId: 'contact_1', startTime, endTime };
const calendar = { id: calendarId, locationId, slotDuration: 30, slotDurationUnit: 'mins' };
const examples: Record<string, Record<string, unknown>> = {
 list: { locationId }, get: { calendarId }, freeSlots: { calendarId, startDate: Date.parse(startTime), endDate: Date.parse(endTime) },
 'groups.list': { locationId }, 'resources.list': { locationId, resourceType: 'rooms', limit: 20, skip: 0 },
 create: { locationId, name: 'PRIVATE_SENTINEL' }, update: { calendarId, name: 'PRIVATE_SENTINEL' }, delete: { calendarId },
 'events.list': { locationId, calendarId, startTime, endTime }, 'appointment.get': { eventId },
 'appointment.book': { locationId, calendarId, contactId: 'contact_1', startTime, endTime, title: 'PRIVATE_SENTINEL' },
 'appointment.reschedule': { eventId, startTime, endTime }, 'appointment.cancel': { eventId, appointmentStatus: 'cancelled' },
 'event.delete': { eventId }, 'blockSlot.create': { locationId, calendarId, startTime, endTime },
 'blockSlot.update': { locationId, calendarId, eventId: 'block_1', startTime, endTime, originalStartTime: startTime, originalEndTime: endTime },
 'appointmentNotes.list': { appointmentId: eventId, limit: 20, offset: 0 },
 'appointmentNotes.create': { appointmentId: eventId, body: 'PRIVATE_SENTINEL' },
 'appointmentNotes.update': { appointmentId: eventId, noteId: 'note_1', body: 'PRIVATE_SENTINEL' },
 'appointmentNotes.delete': { appointmentId: eventId, noteId: 'note_1' },
};
function spec(verb: string): OperationSpec {
 const result = calendarsOperations.find(s => s.id === `calendars.${verb}`);
 expect(result, `registered calendars.${verb}`).toBeDefined(); return result!;
}
function fake(overrides: Record<string, unknown> = {}) {
 const calls: string[] = [];
 const pre: PreflightRequester = { async read(op) {
  calls.push(op); if (op in overrides) return overrides[op];
  if (op === 'calendars.get') return { calendar };
  if (op === 'calendars.list') return { calendars: [calendar] };
  if (op === 'calendars.appointment.get') return { event: appointment };
  if (op === 'calendars.blockSlots.list') return { events: [{ id: 'block_1', locationId, calendarId, startTime, endTime, type: 'block' }], hasMore: false };
  if (op === 'calendars.freeSlots') return { '2026-11-12': { slots: [startTime] } };
  if (op === 'contacts.get') return { contact: { id: 'contact_1', locationId } };
  if (op === 'calendars.appointmentNotes.list') return { notes: [{ id: 'note_1' }], hasMore: false };
  if (op === 'calendars.groups.list') return { groups: [{ id: 'group_1', locationId }] };
  if (op === 'users.list') return { users: [{ id: 'user_1', roles: { locationIds: [locationId] } }] };
  throw new Error(`Unexpected read ${op}`);
 } };
 return { pre, calls };
}
async function prepared(verb: string, input = examples[verb]!, overrides: Record<string, unknown> = {}) {
 const s = spec(verb), { pre, calls } = fake(overrides), args = s.args.parse(input);
 const draft = s.risk === 'R' ? await s.prepareRead(args, ctx) : await s.prepare(pre, args, ctx);
 const held = HeldRequest.freeze(s, draft, ctx);
 if (s.risk !== 'R') prepareReturnedIdentitySchema(held, locationId);
 return { s, held, draft, calls };
}

describe('F4 frozen operations', () => {
 it('registers all 20 legacy calendar operations without a direct send hook', () => {
  expect(calendarsOperations).toHaveLength(20);
  for (const s of calendarsOperations) { expect('run' in s).toBe(false); expect(freezeOperationSpec(s)).toBe(s); }
 });
 for (const [verb, input] of Object.entries(examples)) {
  it(`${verb}: frozen manifest, schema, risk and preflight identities`, () => {
   const s = spec(verb), row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === s.id)!;
   expect(s.row).toBe(row); expect(s.args).toBe(row.argsSchema); expect(s.preflight).toBe(row.preflight);
   expect(s.risk).toBe(row.risk); expect(s.endpoint.retry).toBe(s.risk === 'R' ? 'read' : 'write');
   expect(levelCovers('read', s.risk)).toBe(s.risk === 'R'); expect(levelCovers('change', s.risk)).toBe(s.risk !== 'D');
  });
  it(`${verb}: refuses extra keys and URL values`, () => {
   const s = spec(verb); expect(s.args.safeParse({ ...input, extra: true }).success).toBe(false);
   const key = Object.keys(input).find(k => typeof input[k] === 'string')!;
   expect(s.args.safeParse({ ...input, [key]: 'https://foreign.invalid' }).success).toBe(false);
  });
  it(verb === 'blockSlot.update' ? 'blockSlot.update: legacy schema refuses opt-in interval selectors' : `${verb}: prepares one immutable provider request and safe receipt metadata`, async () => {
   // MAIN additive-only ruling: original interval selectors are opt-in.
   if (verb === 'blockSlot.update') {
    expect(spec(verb).args.safeParse(input)).toMatchObject({ success: false });
    await expect(prepared(verb)).rejects.toThrow(/originalStartTime/);
    return;
   }
   const { s, draft, held } = await prepared(verb);
   expect(s.endpoint.path.test(draft.path)).toBe(true);
   expect(JSON.stringify({ refs: s.recordRefs(input), fields: s.fields(input) })).not.toContain('PRIVATE_SENTINEL');
   const copy = held.sendCopy(); if (copy.body?.length) copy.body.fill(0);
   expect(() => HeldRequest.freeze(s, { ...draft, path: '/contacts/foreign' }, ctx)).toThrow();
   if (held.sendCopy().body?.length) expect(held.sendCopy().body).not.toEqual(copy.body);
  });
 }
 it('cal.bookChecksFreeSlot', async () => {
  await expect(prepared('appointment.book', examples['appointment.book'], { 'calendars.freeSlots': {} })).rejects.toThrow(/slot/i);
  const { draft, calls } = await prepared('appointment.book');
  expect(calls).toContain('calendars.freeSlots');
  expect(draft.body).toMatchObject({ kind: 'json', value: { ignoreFreeSlotValidation: false, ignoreDateRange: false } });
 });
 it('cal.rescheduleKeepsIds', async () => {
  const { draft } = await prepared('appointment.reschedule');
  expect(draft.path).toBe('/calendars/events/appointments/event_1');
  expect(draft.body).toEqual({ kind: 'json', value: { startTime, endTime, ignoreDateRange: false, ignoreFreeSlotValidation: false } });
  await expect(prepared('appointment.reschedule', { ...examples['appointment.reschedule'], calendarId: 'foreign' })).rejects.toThrow();
 });
 it('cal.cancelIsC', async () => {
  const { s, draft } = await prepared('appointment.cancel'); expect(s.risk).toBe('C');
  expect(draft.body).toEqual({ kind: 'json', value: { appointmentStatus: 'cancelled' } });
 });
 it('cal.eventDeleteIsD', () => { expect(spec('event.delete').risk).toBe('D'); });
 it.each(['update', 'delete', 'appointment.book', 'blockSlot.create'])('%s refuses a foreign calendar', async verb => {
  await expect(prepared(verb, examples[verb], { 'calendars.get': { calendar: { ...calendar, locationId: 'foreign' } } })).rejects.toThrow();
 });
 it.each(['appointment.reschedule', 'appointment.cancel', 'event.delete', 'appointmentNotes.create', 'appointmentNotes.update', 'appointmentNotes.delete'])('%s refuses a foreign parent', async verb => {
  await expect(prepared(verb, examples[verb], { 'calendars.appointment.get': { event: { ...appointment, locationId: 'foreign' } } })).rejects.toThrow();
 });
 it('refuses a note not found on the approved appointment', async () => {
  await expect(prepared('appointmentNotes.update', examples['appointmentNotes.update'], { 'calendars.appointmentNotes.list': { notes: [], hasMore: false } })).rejects.toThrow();
 });
 it('requires a positive duration and rejects availability bypass flags', async () => {
  for (const patch of [{ endTime: startTime }, { ignoreDateRange: true }, { ignoreFreeSlotValidation: true }])
   await expect(prepared('appointment.book', { ...examples['appointment.book'], ...patch })).rejects.toThrow();
 });
 for (const hook of ['recordId', 'project'] as const) {
  it(`${hook} checks the retained request and every returned identity`, async () => {
   const { s, held } = await prepared('update'); const mutation = s as MutationSpec;
   expect(() => mutation[hook]!({ calendar: { id: calendarId } }, held.frozen)).not.toThrow();
   for (const raw of [{ calendar: { id: 'foreign' } }, { calendar: { id: calendarId }, nested: { locationId: 'foreign' } }, { calendar: { id: calendarId }, success: false }, {}])
    expect(() => mutation[hook]!(raw, held.frozen)).toThrow();
   expect(() => mutation[hook]!({ calendar: { id: calendarId } })).toThrow();
  });
 }
 it.each(['delete', 'event.delete', 'appointmentNotes.delete'])('%s requires explicit success', async verb => {
  const { s, held } = await prepared(verb); const m = s as MutationSpec;
  for (const raw of [{}, { success: false }, { succeeded: false }]) expect(() => m.project(raw, held.frozen)).toThrow();
 });
 it('bounds engine projection by UTF-8 bytes and drops unlisted provider fields', () => {
  const value = spec('list').project({ calendars: Array.from({ length: 200 }, () => ({ id: calendarId, name: '😀'.repeat(10000), unexpected: 'SECRET' })), unexpected: 'SECRET' });
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(65536); expect(JSON.stringify(value)).not.toContain('SECRET');
 });
});

// The same production host and journals used by the integration branch. Only
// provider transport and owner facts are fixtures; no credentials or sockets.
import { afterEach } from 'vitest';
import { highLevelHarness, until } from '../../testing/fake-highlevel.ts';
import { HighLevelHost, type HighLevelOutcomeRecord } from '../host.ts';
import type { ActionReview } from '../actions.ts';
import { operationSpec } from './registry.ts';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); });
function hostFixture(level: FamilyLevel = 'full', policy = false) {
 const h = highLevelHarness({ deadlineMs: 500 }); cleanups.push(() => h.stop());
 h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [], grants: [{ ...h.grant(), families: fixtureFamilyLevels({ calendars: level }) }] };
 h.api.always('GET', /^\/calendars\/cal_1$/, { status: 200, body: { calendar: { ...calendar, locationId: 'loc_fixture_01' } } });
 h.api.always('PUT', /^\/calendars\/cal_1$/, { status: 200, body: { calendar: { id: calendarId, name: 'PRIVATE_SENTINEL' } } });
 const reviews: ActionReview[] = [], outcomes: HighLevelOutcomeRecord[] = [];
 const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec,
  operationScopes: () => ['calendars.readonly', 'calendars.write', 'calendars/events.readonly', 'calendars/events.write', 'calendars/groups.readonly', 'calendars/resources.readonly', 'contacts.readonly'],
  approvalBasis: () => policy ? 'owner_no_limits' : 'owner_exact_review',
  onReview: (_claim, review) => reviews.push(review), onOutcome: (_claim, outcome) => outcomes.push(outcome),
 });
 const call = (operation = 'calendars.update', args: Record<string, unknown> = { calendarId, name: 'PRIVATE_SENTINEL' }) => host.call(h.claim, 'HIGHLEVEL_CALENDARS', { operation, args });
 return { ...h, host, call, reviews, outcomes };
}
it('journaled host waits for exact review, sends once, and records only safe receipt fields', async () => {
 const h = hostFixture(), pending = h.call(); await until(() => h.reviews.length === 1);
 expect(h.api.calls('PUT')).toHaveLength(0);
 const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
 expect(await pending).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.calls('PUT')).toHaveLength(1);
 expect(h.actions.get(review.actionId)).toMatchObject({ phase: 'applied', dispatchAttempts: 1, receipt: { recordId: calendarId } });
 expect(JSON.stringify(h.outcomes)).not.toContain('PRIVATE_SENTINEL');
});
it.each(['read', 'change'] as const)('host enforces %s grant before a destructive request', async level => {
 const h = hostFixture(level); expect(await h.call('calendars.delete', { calendarId })).toMatchObject({ isError: true });
 expect(h.api.calls('DELETE')).toHaveLength(0); expect(h.reviews).toHaveLength(0);
});
it('host refuses all mutations on a read grant before provider access', async () => {
 const h = hostFixture('read');
 for (const s of calendarsOperations.filter(s => s.risk !== 'R')) {
  const a = { ...examples[s.id.slice(10)] }; if ('locationId' in a) a.locationId = 'loc_fixture_01';
  expect(await h.call(s.id, a)).toMatchObject({ isError: true });
 }
 expect(h.api.calls('POST')).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(0); expect(h.api.calls('DELETE')).toHaveLength(0);
});
it('host withholds a wrong provider target after sending, with no resend', async () => {
 const h = hostFixture('full', true);
 h.api.first('PUT', /^\/calendars\/cal_1$/, { status: 200, body: { calendar: { id: 'foreign', name: 'PRIVATE_SENTINEL' } } });
 const result = await h.call(); expect(result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } });
 expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL'); expect(h.api.calls('PUT')).toHaveLength(1);
 expect(h.outcomes[0]?.providerRecordIds).toEqual([]);
});
it('host keeps provider error text out of receipt and status', async () => {
 const h = hostFixture('full', true);
 h.api.first('PUT', /^\/calendars\/cal_1$/, { status: 422, body: { message: 'PRIVATE_PROVIDER_ERROR' } });
 const result = await h.call(); expect(result).toMatchObject({ isError: true, structuredContent: { outcome: 'not_applied' } });
 expect(JSON.stringify(h.outcomes)).not.toContain('PRIVATE_PROVIDER_ERROR');
 expect(h.api.calls('PUT')).toHaveLength(1);
});
it('host does not send after Stop while the owner reviews', async () => {
 const h = hostFixture(), pending = h.call(); await until(() => h.reviews.length === 1);
 h.stop(); await pending; expect(h.api.calls('PUT')).toHaveLength(0);
});

it('block updates cannot use an appointment as proof of blocked time', async () => {
 await expect(prepared('blockSlot.update', examples['blockSlot.update'], {
  'calendars.blockSlots.list': { events: [{ ...appointment, id: 'block_1' }] },
 })).rejects.toThrow();
});
