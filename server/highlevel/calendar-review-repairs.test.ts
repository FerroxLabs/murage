// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { calendarWorkflowFixture, workflowArgs, calendarLocation } from './testing/calendar-fixture.ts';
import { operationSpec } from './operations/registry.ts';
import { HeldRequest } from './held-request.ts';
import { captureRecoveryPreState, compareWriteRecovery, prepareWriteRecovery } from './write-recovery.ts';
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach(stop => stop()));
function fixture() { const h = calendarWorkflowFixture(); stops.push(h.stop); return h; }
for (const verb of ['create', 'update']) it(verb === 'create' ? 'legacy create refuses extra ownership reads before sending eventType' : `${verb} sends the exact requested calendar eventType configuration`, async () => {
 const h = fixture(), args = { ...workflowArgs[verb], eventType: 'RoundRobin_OptimizeForAvailability' };
 // MAIN additive-only ruling: create's extra ownership reads are opt-in.
 if (verb === 'create') {
  expect(await h.call(verb, args)).toMatchObject({ isError: true, structuredContent: { error: 'The ownership check, workspace file or prepared request could not be verified. Nothing was sent.' } });
  expect(h.api.requests).toHaveLength(0); return;
 }
 expect(await h.call(verb, args)).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(operationSpec(`calendars.${verb}`)!.fields(args)).toContain('eventType');
 const { calendarId: _id, ...body } = args as Record<string, unknown>;
 expect(h.api.calls(verb === 'create' ? 'POST' : 'PUT')[0]!.body).toEqual(body);
});
async function recovery(verb: string) {
 const h = fixture(), spec = operationSpec(`calendars.${verb}`)!;
 if (spec.risk === 'R') throw new Error('mutation expected');
 const pre = { read: async (_op: string, draft: { path: string; query?: Record<string, string> }) => {
  const url = new URL(draft.path, 'https://fixture.invalid');
  Object.entries(draft.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));
  return (await h.api.fetch(url, { method: 'GET' })).json();
 } };
 const draft = await spec.prepare(pre, spec.args.parse(workflowArgs[verb]), { locationId: calendarLocation });
 const plan = prepareWriteRecovery(HeldRequest.freeze(spec, draft, { locationId: calendarLocation }), calendarLocation);
 await captureRecoveryPreState(plan, pre);
 const body = draft.body?.kind === 'json' ? draft.body.value as Record<string, unknown> : {};
 const item = { ...(verb.startsWith('blockSlot.') ? h.block : h.event), ...body, ...(verb === 'appointment.book' ? { id: 'new_event' } : {}) };
 return { h, spec, plan, item };
}
for (const verb of ['appointment.reschedule', 'blockSlot.update', 'appointment.book']) {
 for (const collision of [{ contactId: 'foreign' }, { assignedUserId: 'foreign' }, { success: false }]) {
  it(verb === 'blockSlot.update' ? `legacy blockSlot.update rejects selectors before observing readEnvelope ${JSON.stringify(collision)}` : `${verb} preserves a colliding original readEnvelope ${JSON.stringify(collision)}`, async () => {
   if (verb === 'blockSlot.update') {
    const h = fixture();
    expect(await h.call(verb)).toMatchObject({ isError: true, structuredContent: { error: "The HighLevel arguments do not match this operation's schema." } });
    expect(h.api.requests).toHaveLength(0); return;
   }
   const { spec, plan, item } = await recovery(verb);
   const record = { ...item, readEnvelope: collision };
   const response = plan.collection ? { events: [record] } : { event: record };
   const original = structuredClone(response);
   expect(compareWriteRecovery(plan, response, spec)).toHaveProperty('outcome');
   expect(response).toEqual(original);
  });
 }
}
it('collection validation preserves a nonselected member readEnvelope collision', async () => {
 const { spec, plan, item } = await recovery('appointment.book');
 expect(compareWriteRecovery(plan, { events: [item, { ...item, id: 'other_event', startTime: '2026-11-12T10:01:00Z', readEnvelope: { contactId: 'foreign' } }] }, spec)).toHaveProperty('outcome');
});
it.each(['user_1', 'user_2'])('legacy block reassignment refuses original host selectors before reply: %s', async returned => {
 const h = fixture();
 Object.assign(h.block, { assignedUserId: 'user_1' });
 h.api.first('GET', /^\/calendars\/blocked-slots$/, { status: 200, body: { events: [{ ...h.block, assignedUserId: 'user_1' }] } });
 for (let i = 0; i < 3; i++) h.api.first('GET', /^\/users\/$/, { status: 200, body: { users: ['user_1', 'user_2'].map(id => ({ id, roles: { locationIds: [calendarLocation] } })) } });
 h.api.first('PUT', /^\/calendars\/events\/block-slots\/block_1$/, r => ({ status: 200, body: { ...h.block, ...(r.body as object), assignedUserId: returned } }));
 const result = await h.call('blockSlot.update', { ...workflowArgs['blockSlot.update'], originalUserId: 'user_1', assignedUserId: 'user_2' });
 // The default schema has no original host/interval selectors.
 expect(result).toMatchObject({ isError: true, structuredContent: { error: "The HighLevel arguments do not match this operation's schema." } });
 expect(h.api.requests).toHaveLength(0);
});
it.each(['appointment.reschedule', 'blockSlot.update', 'appointment.book'])('legacy %s cannot create an opt-in recovered witness', async verb => {
 if (verb === 'blockSlot.update') {
  const h = fixture();
  expect(await h.call(verb)).toMatchObject({ isError: true });
  expect(h.api.requests).toHaveLength(0); return;
 }
 const { spec, plan, item } = await recovery(verb);
 const readEnvelope = { locationId: calendarLocation };
 const recoveryEnvelope = { locationId: calendarLocation, marker: 'provider value' };
 const record = { ...item, readEnvelope, recoveryEnvelope };
 const response = plan.collection ? { events: [record] } : { event: record };
 const witness = compareWriteRecovery(plan, response, spec);
 // Only opted-in rows bind the retained calendar context/identity schema.
 expect(witness).toMatchObject({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
 expect(response).toEqual(plan.collection ? { events: [record] } : { event: record });
});
it('calendar creation never reads the unbounded calendar collection for recovery', async () => {
 const { h, spec, plan } = await recovery('create');
 expect(h.api.calls('GET', /^\/calendars\/$/)).toHaveLength(0);
 expect(plan.readTargets).toEqual([]);
 expect(compareWriteRecovery(plan, { calendars: [] }, spec)).toHaveProperty('outcome');
});
it('legacy maximum-length note cannot reach review through an undeclared user prerequisite', async () => {
 const h = calendarWorkflowFixture(false); stops.push(h.stop);
 const body = 'x'.repeat(10000);
 expect(await h.call('appointmentNotes.create', { ...workflowArgs['appointmentNotes.create'], body })).toMatchObject({ isError: true, structuredContent: { error: 'The ownership check, workspace file or prepared request could not be verified. Nothing was sent.' } });
 expect(h.reviews).toHaveLength(0); expect(h.writes()).toBe(0);
 expect(h.api.requests.map(r => [r.method, r.path])).toEqual([['GET', '/calendars/events/appointments/event_1']]);
});
