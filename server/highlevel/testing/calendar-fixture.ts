// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixtureFamilyLevels } from './family-grants.ts';
// In-memory provider only. Used by unit regressions and the isolated server driver.
import { highLevelHarness } from '../../testing/fake-highlevel.ts';
import { HighLevelHost, type HighLevelHostDeps } from '../host.ts';
import { operationSpec } from '../operations/registry.ts';
import type { ActionReview } from '../actions.ts';
export const calendarLocation = 'loc_fixture_01';
export const interval = { startTime: '2026-11-12T10:00:00Z', endTime: '2026-11-12T10:30:00Z' };
export const originalInterval = { originalStartTime: '2026-11-12T09:00:00Z', originalEndTime: '2026-11-12T09:30:00Z' };
export const workflowArgs: Record<string, Record<string, unknown>> = {
 'groups.list': { locationId: calendarLocation }, 'resources.list': { locationId: calendarLocation, resourceType: 'rooms', limit: 20, skip: 0 },
 get: { calendarId: 'cal_1' }, list: { locationId: calendarLocation, groupId: 'group_1' },
 freeSlots: { calendarId: 'cal_1', startDate: Date.parse(interval.startTime), endDate: Date.parse(interval.endTime), userId: 'user_1' },
 create: { locationId: calendarLocation, name: 'Fixture calendar', groupId: 'group_1', teamMembers: [{ userId: 'user_1' }] },
 update: { calendarId: 'cal_1', name: 'Fixture calendar' }, delete: { calendarId: 'cal_1' },
 'events.list': { locationId: calendarLocation, calendarId: 'cal_1', ...interval },
 'blockSlots.list': { locationId: calendarLocation, calendarId: 'cal_1', ...interval },
 'appointment.get': { eventId: 'event_1' },
 'appointment.book': { locationId: calendarLocation, calendarId: 'cal_1', contactId: 'contact_1', assignedUserId: 'user_1', ...interval },
 'appointment.reschedule': { eventId: 'event_1', ...interval },
 'appointment.cancel': { eventId: 'event_1', appointmentStatus: 'cancelled' },
 'event.delete': { eventId: 'event_1' },
 'blockSlot.create': { locationId: calendarLocation, calendarId: 'cal_1', ...interval },
 'blockSlot.update': { locationId: calendarLocation, calendarId: 'cal_1', eventId: 'block_1', ...interval, ...originalInterval },
 'appointmentNotes.list': { appointmentId: 'event_1', limit: 100, offset: 0 },
 'appointmentNotes.create': { appointmentId: 'event_1', body: 'Fixture note', userId: 'user_1' },
 'appointmentNotes.update': { appointmentId: 'event_1', noteId: 'note_1', body: 'Fixture note', userId: 'user_1' },
 'appointmentNotes.delete': { appointmentId: 'event_1', noteId: 'note_1' },
};
export function calendarWorkflowFixture(policy = true, overrides: Partial<HighLevelHostDeps> = {}) {
 const h = highLevelHarness({ deadlineMs: 1000 });
 h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [], grants: [{ ...h.grant(), families: fixtureFamilyLevels({ calendars: 'full' }) }] };
 const calendar = { id: 'cal_1', locationId: calendarLocation, name: 'Before', slotDuration: 30, slotDurationUnit: 'mins' };
 const event = { id: 'event_1', locationId: calendarLocation, calendarId: 'cal_1', contactId: 'contact_1', assignedUserId: 'user_1', ...interval };
 const block = { id: 'block_1', locationId: calendarLocation, calendarId: 'cal_1', startTime: originalInterval.originalStartTime, endTime: originalInterval.originalEndTime };
 const note = { id: 'note_1', body: 'Before', contactId: 'contact_1', appointmentId: 'event_1' };
 h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', locationId: calendarLocation } } });
 const standing = (path: RegExp, body: unknown) => h.api.always('GET', path, { status: 200, body });
 standing(/^\/calendars\/cal_1$/, { calendar });
 standing(/^\/calendars\/$/, { calendars: [calendar] });
 standing(/^\/calendars\/groups$/, { groups: [{ id: 'group_1', locationId: calendarLocation }] });
 standing(/^\/calendars\/resources\/rooms$/, [{ locationId: calendarLocation, name: 'Fixture room', calendarIds: ['cal_1'] }]);
 standing(/^\/users\/$/, { users: [{ id: 'user_1', roles: { locationIds: [calendarLocation] } }] });
 standing(/^\/calendars\/cal_1\/free-slots$/, { '2026-11-12': { slots: [interval.startTime] } });
 standing(/^\/calendars\/events\/appointments\/event_1$/, { event });
 standing(/^\/calendars\/events$/, { events: [event] });
 standing(/^\/calendars\/blocked-slots$/, { events: [block] });
 standing(/^\/calendars\/appointments\/event_1\/notes$/, { notes: [note], hasMore: false });
 const write = (method: string, path: RegExp, initial: Record<string, unknown>, envelope?: string) => h.api.always(method, path, r => {
  const value = { ...initial, ...(r.body as object) };
  return { status: 200, body: envelope ? { [envelope]: value } : value };
 });
 write('POST', /^\/calendars\/$/, { ...calendar, id: 'cal_new' }, 'calendar');
 write('PUT', /^\/calendars\/cal_1$/, calendar, 'calendar');
 write('POST', /^\/calendars\/events\/appointments$/, { ...event, id: 'event_new' });
 write('PUT', /^\/calendars\/events\/appointments\/event_1$/, event);
 write('POST', /^\/calendars\/events\/block-slots$/, { ...block, id: 'block_new' });
 write('PUT', /^\/calendars\/events\/block-slots\/block_1$/, block);
 write('POST', /^\/calendars\/appointments\/event_1\/notes$/, { ...note, id: 'note_new' }, 'note');
 write('PUT', /^\/calendars\/appointments\/event_1\/notes\/note_1$/, note, 'note');
 h.api.always('DELETE', /^\/calendars\/events\/(event_1|block_1)$/, { status: 200, body: { succeeded: true } });
 h.api.always('DELETE', /^\/calendars\/(cal_1|appointments\/event_1\/notes\/note_1)$/, { status: 200, body: { success: true } });
 const reviews: ActionReview[] = [];
 const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec,
  operationScopes: () => ['calendars.readonly', 'calendars.write', 'calendars/events.readonly', 'calendars/events.write', 'calendars/groups.readonly', 'calendars/resources.readonly', 'contacts.readonly', 'users.readonly'],
  approvalBasis: (_claim, _spec, risk) => policy ? risk === 'D' ? 'owner_no_limits_attended' : 'owner_no_limits' : 'owner_exact_review',
  onReview: (_claim, review) => reviews.push(review), ...overrides });
 const call = (verb: string, args = workflowArgs[verb]!) => host.call(h.claim, 'HIGHLEVEL_CALENDARS', { operation: `calendars.${verb}`, args });
 return { ...h, host, call, reviews, calendar, event, block, note, writes: () => h.api.requests.filter(r => ['POST', 'PUT', 'DELETE'].includes(r.method)).length };
}
