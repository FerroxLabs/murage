// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { calendarWorkflowFixture, workflowArgs, originalInterval } from './testing/calendar-management-fixture.ts';
import { until } from '../testing/fake-highlevel.ts';
import { HeldRequest } from './held-request.ts';
import { calendarManagementOperationSpec as operationSpec } from './calendar-management.ts';
import { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery, recoveryReadDraft } from './write-recovery.ts';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(stop => stop()));
function fixture(policy = true) { const h = calendarWorkflowFixture(policy); cleanup.push(h.stop); return h; }
for (const verb of Object.keys(workflowArgs)) it(`calendar management through production preflight and journals: ${verb}`, async () => {
 const h = fixture(); const result = await h.call(verb);
 if (['groups.list', 'resources.list', 'get', 'list', 'freeSlots', 'events.list', 'blockSlots.list', 'appointment.get', 'appointmentNotes.list'].includes(verb)) expect(result, JSON.stringify({ result, reads: h.api.requests.map(r => [r.method, r.path, String(r.query)]) })).toMatchObject({ structuredContent: { outsideContent: 'highlevel-crm' } });
 else expect(result, JSON.stringify({ result, reads: h.api.requests.map(r => [r.method, r.path, String(r.query)]) })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.unexpected).toHaveLength(0);
});
it('full reschedule reply binds retained parents and never sends them as editable fields', async () => {
 const h = fixture(); expect(await h.call('appointment.reschedule')).toMatchObject({ structuredContent: { outcome: 'applied' } });
 const write = h.api.calls('PUT')[0]!;
 expect(write.body).toEqual({ startTime: workflowArgs['appointment.reschedule']!.startTime, endTime: workflowArgs['appointment.reschedule']!.endTime, ignoreDateRange: false, ignoreFreeSlotValidation: false });
});
it.each(['calendarId', 'contactId', 'assignedUserId'])('withholds a full reply with conflicting retained %s', async key => {
 const h = fixture(); h.api.first('PUT', /^\/calendars\/events\/appointments\/event_1$/, { status: 200, body: { ...h.event, [key]: 'foreign' } });
 expect(await h.call('appointment.reschedule')).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } }); expect(h.writes()).toBe(1);
});
it('block ownership uses the original interval and the dedicated blocked-slot route', async () => {
 const h = fixture(); expect(await h.call('blockSlot.update')).toMatchObject({ structuredContent: { outcome: 'applied' } });
 const reads = h.api.calls('GET', /^\/calendars\/blocked-slots$/);
 expect(reads.length).toBeGreaterThan(0); expect(reads[0]!.query.get('startTime')).toBe(String(Date.parse(originalInterval.originalStartTime)));
 expect(h.api.calls('GET', /^\/calendars\/events$/)).toHaveLength(0);
 expect(h.api.calls('PUT')[0]!.body).not.toHaveProperty('originalStartTime');
});
it('deletes a proved block through the same destructive dispatcher', async () => {
 const h = fixture(); expect(await h.call('event.delete', { eventId: 'block_1', eventType: 'block', calendarId: 'cal_1', ...originalInterval })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.calls('DELETE')[0]!.path).toBe('/calendars/events/block_1');
});
it('finds note membership beyond the former 60-note ceiling with a bounded page selector', async () => {
 const h = fixture(); h.api.first('GET', /^\/calendars\/appointments\/event_1\/notes$/, r => ({ status: 200, body: { notes: r.query.get('offset') === '120' ? [h.note] : [], hasMore: false } }));
 expect(await h.call('appointmentNotes.update', { ...workflowArgs['appointmentNotes.update'], noteOffset: 120 })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.calls('PUT')[0]!.body).not.toHaveProperty('noteOffset');
});
it('missing note on the selected page never sends', async () => {
 const h = fixture(); h.api.first('GET', /^\/calendars\/appointments\/event_1\/notes$/, { status: 200, body: { notes: [], hasMore: false } });
 expect(await h.call('appointmentNotes.update', { ...workflowArgs['appointmentNotes.update'], noteOffset: 120 })).toMatchObject({ isError: true }); expect(h.writes()).toBe(0);
});
it('booking waits for review with its maximum ownership references inside the five-read budget', async () => {
 const h = fixture(false), pending = h.call('appointment.book'); await until(() => h.reviews.length === 1);
 expect(h.writes()).toBe(0); const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
 expect(await pending).toMatchObject({ structuredContent: { outcome: 'applied' } }); expect(h.writes()).toBe(1);
});
// Recovery tests exercise real specs with declared-read enforcement. Provider data
// cannot invent new targets or turn partial/negative responses into success.
for (const verb of ['create', 'appointment.book', 'blockSlot.create', 'appointment.reschedule', 'appointment.cancel', 'blockSlot.update', 'appointmentNotes.create', 'appointmentNotes.update', 'appointmentNotes.delete']) {
 it(`recovery compares the calendar effect and retained identities: ${verb}`, async () => {
  const h = fixture(), spec = operationSpec(`calendars.${verb}`)!; expect(spec).toBeDefined(); if (spec.risk === 'R') throw new Error('mutation expected');
  const pre = { read: async (op: Parameters<typeof operationSpec>[0], draft: { path: string; query?: Record<string, string> }) => {
   expect(spec.preflight).toContain(op);
   const url = new URL(draft.path, 'https://fixture.invalid'); Object.entries(draft.query ?? {}).forEach(([k, v]) => url.searchParams.set(k, v));
   return (await h.api.fetch(url, { method: 'GET' })).json();
  } };
  const draft = await spec.prepare(pre, spec.args.parse(workflowArgs[verb]), { locationId: h.calendar.locationId });
  const held = HeldRequest.freeze(spec, draft, { locationId: h.calendar.locationId });
  const plan = prepareWriteRecovery(held, h.calendar.locationId);
  await captureRecoveryPreState(plan, pre);
  if (plan.lookupUnavailable) {
   expect(plan.readTargets).toEqual([]);
   expect(compareWriteRecovery(plan, { calendars: [] }, spec)).toHaveProperty('outcome');
   return;
  }
  const target = plan.readTargets[0]!, read = recoveryReadDraft(plan, target);
  if (verb === 'appointment.book' || verb.startsWith('blockSlot.')) expect(read.query).toMatchObject({ calendarId: 'cal_1', locationId: h.calendar.locationId });
  const body = draft.body?.kind === 'json' ? draft.body.value as Record<string, unknown> : {};
  const created = ['create', 'appointment.book', 'blockSlot.create', 'appointmentNotes.create'].includes(verb);
  const item = { ...(verb === 'create' ? h.calendar : verb.startsWith('appointmentNotes.') ? h.note : verb.startsWith('blockSlot.') ? h.block : h.event), ...body, ...(created ? { id: 'new_fixture_id' } : {}) };
  const response = plan.collection ? { [plan.collection]: verb.endsWith('.delete') ? [] : [item] } : { event: item };
  expect(compareWriteRecovery(structuredClone(plan), response, spec)).toHaveProperty('held');
  expect(compareWriteRecovery(plan, { ...response, nested: { locationId: 'foreign' } }, spec)).toHaveProperty('outcome');
  expect(compareWriteRecovery(plan, { ...response, success: false }, spec)).toHaveProperty('outcome');
  if (plan.collection) expect(compareWriteRecovery(plan, { ...response, hasMore: true }, spec)).toHaveProperty('outcome');
 });
}
it('changed parent after review stales the held calendar request before a send', async () => {
 const h = fixture(false), pending = h.call('appointment.reschedule'); await until(() => h.reviews.length === 1);
 h.api.first('GET', /^\/calendars\/events\/appointments\/event_1$/, { status: 200, body: { event: { ...h.event, contactId: 'foreign' } } });
 const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
 expect(await pending).toMatchObject({ isError: true }); expect(h.writes()).toBe(0);
});

import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDir } from '../testing/cleanup.ts';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
for (const verb of ['create', 'update', 'delete', 'appointment.book', 'appointment.reschedule', 'appointment.cancel', 'event.delete', 'blockSlot.create', 'blockSlot.update', 'appointmentNotes.create', 'appointmentNotes.update', 'appointmentNotes.delete']) {
 for (const mode of ['accepted', ...(['appointment.reschedule', 'appointment.book', 'appointmentNotes.update'].includes(verb) ? ['foreign', 'negative'] : []), ...(verb === 'appointment.book' ? ['partial'] : [])]) {
  it(`${verb}: fresh-process recovery (${mode}) makes zero resends`, () => {
   const dir = mkdtempSync(join(tmpdir(), 'calendar-crash-')); dirs.push(dir);
   const run = (phase: string) => spawnSync(process.execPath, ['--experimental-strip-types', 'server/highlevel/testing/calendar-management-crash-worker.ts', dir, verb, phase, mode], { encoding: 'utf8', timeout: 20000 });
   const send = run('send'); expect(send.status, send.stderr).toBe(73);
   expect(JSON.parse(readFileSync(join(dir, 'send.json'), 'utf8'))).toEqual({ writes: 1, phase: 'dispatching' });
   const replay = run('replay'); expect(replay.status, replay.stderr).toBe(0);
   const report = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
   expect(report.result.result).toMatchObject({ structuredContent: { outcome: mode === 'accepted' && verb !== 'create' ? 'applied' : 'outcome_unknown' } });
   expect(report).toMatchObject({ writes: 0, reads: verb === 'create' ? 0 : 1, terminalReads: 0, identical: true, unexpected: 0 });
  }, 45000);
 }
}
it('a paginated note collection allows a normal create but cannot prove a create after a crash', async () => {
 const h = fixture();
 h.api.first('GET', /^\/calendars\/appointments\/event_1\/notes$/, { status: 200, body: { notes: [h.note], hasMore: true } });
 expect(await h.call('appointmentNotes.create')).toMatchObject({ structuredContent: { outcome: 'applied' } });
 const s = operationSpec('calendars.appointmentNotes.create')!; if (s.risk === 'R') throw new Error('mutation expected');
 const pre = { read: async (op: string) => op === 'calendars.appointment.get' ? { event: h.event } : op === 'users.list' ? { users: [{ id: 'user_1', roles: { locationIds: [h.calendar.locationId] } }] } : { notes: [h.note], hasMore: true } };
 const draft = await s.prepare(pre, s.args.parse(workflowArgs['appointmentNotes.create']), { locationId: h.calendar.locationId });
 const held = HeldRequest.freeze(s, draft, { locationId: h.calendar.locationId }), plan = prepareWriteRecovery(held, h.calendar.locationId);
 await captureRecoveryPreState(plan, pre); expect(plan.incompletePreState).toBe(true);
 expect(compareWriteRecovery(plan, { notes: [{ ...h.note, id: 'new_note', body: 'Fixture note', userId: 'user_1' }] }, s)).toHaveProperty('outcome');
});
it('absence on a selected later note page cannot confirm deletion', async () => {
 const h = fixture(), s = operationSpec('calendars.appointmentNotes.delete')!; if (s.risk === 'R') throw new Error('mutation expected');
 const pre = { read: async (op: string) => op === 'calendars.appointment.get' ? { event: h.event } : { notes: [h.note], hasMore: false } };
 const draft = await s.prepare(pre, s.args.parse({ ...workflowArgs['appointmentNotes.delete'], noteOffset: 120 }), { locationId: h.calendar.locationId });
 const held = HeldRequest.freeze(s, draft, { locationId: h.calendar.locationId }), plan = prepareWriteRecovery(held, h.calendar.locationId);
 expect(compareWriteRecovery(plan, { notes: [], hasMore: false }, s)).toHaveProperty('outcome');
});
it('block deletion qualifies its original host through the location-scoped user prerequisite', async () => {
 const h = fixture();
 expect(await h.call('event.delete', { eventId: 'block_1', eventType: 'block', calendarId: 'cal_1', userId: 'user_1', ...originalInterval })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.calls('GET', /^\/calendars\/blocked-slots$/)[0]!.query.get('userId')).toBe('user_1');
});
it('block updates can find the original host without sending it as a new field', async () => {
 const h = fixture();
 expect(await h.call('blockSlot.update', { ...workflowArgs['blockSlot.update'], originalUserId: 'user_1' })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.calls('GET', /^\/calendars\/blocked-slots$/)[0]!.query.get('userId')).toBe('user_1');
 expect(h.api.calls('PUT')[0]!.body).not.toHaveProperty('originalUserId');
});
