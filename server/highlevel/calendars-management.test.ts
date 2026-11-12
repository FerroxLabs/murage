// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import { calendarWorkflowFixture, workflowArgs, originalInterval } from './testing/calendar-fixture.ts';
import { HeldRequest } from './held-request.ts';
import { operationSpec } from './operations/registry.ts';
import { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery, recoveryReadDraft } from './write-recovery.ts';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(stop => stop()));
// MAIN additive-only ruling: docs/verification/highlevel-hlf4-r3.md.
// Keep the default host/rows; positive extension workflows live in calendar-additive*.
const prepareError = 'The ownership check, workspace file or prepared request could not be verified. Nothing was sent.';
const schemaError = "The HighLevel arguments do not match this operation's schema.";
function refused(result: unknown, error = prepareError) {
 expect(result).toMatchObject({ isError: true, structuredContent: { error } });
}
function fixture(policy = true) { const h = calendarWorkflowFixture(policy); cleanup.push(h.stop); return h; }
for (const verb of Object.keys(workflowArgs)) it(`calendar management through production preflight and journals: ${verb}`, async () => {
 const h = fixture(); const result = await h.call(verb);
 if (['get', 'list', 'freeSlots', 'create', 'events.list', 'appointment.get', 'appointment.book', 'appointment.reschedule', 'blockSlot.create', 'appointmentNotes.create', 'appointmentNotes.update'].includes(verb)) {
  refused(result); expect(h.writes()).toBe(0); expect(h.reviews).toHaveLength(0);
 } else if (verb === 'blockSlots.list' || verb === 'blockSlot.update') {
  refused(result, verb === 'blockSlots.list' ? 'This HighLevel operation is not available to this location.' : schemaError);
  expect(h.api.requests).toHaveLength(0);
 } else if (verb === 'appointment.cancel') {
  expect(result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown', code: 'identity_conflict' } });
  expect(h.writes()).toBe(1);
 } else if (['groups.list', 'resources.list', 'get', 'list', 'freeSlots', 'events.list', 'blockSlots.list', 'appointment.get', 'appointmentNotes.list'].includes(verb)) expect(result, JSON.stringify({ result, reads: h.api.requests.map(r => [r.method, r.path, String(r.query)]) })).toMatchObject({ structuredContent: { outsideContent: 'highlevel-crm' } });
 else expect(result, JSON.stringify({ result, reads: h.api.requests.map(r => [r.method, r.path, String(r.query)]) })).toMatchObject({ structuredContent: { outcome: 'applied' } });
 expect(h.api.unexpected).toHaveLength(0);
});
it('legacy reschedule refuses an undeclared calendar read before sending any reply', async () => {
 const h = fixture(); refused(await h.call('appointment.reschedule'));
 expect(h.api.requests.map(r => [r.method, r.path])).toEqual([['GET', '/calendars/events/appointments/event_1']]);
 expect(h.writes()).toBe(0);
});
it.each(['calendarId', 'contactId', 'assignedUserId'])('legacy reschedule never reaches a reply with conflicting retained %s', async key => {
 const h = fixture(); h.api.first('PUT', /^\/calendars\/events\/appointments\/event_1$/, { status: 200, body: { ...h.event, [key]: 'foreign' } });
 refused(await h.call('appointment.reschedule')); expect(h.writes()).toBe(0);
 expect(h.api.calls('GET')).toHaveLength(1);
});
it('legacy block schema refuses the opt-in original interval without provider access', async () => {
 const h = fixture(); refused(await h.call('blockSlot.update'), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
it('legacy event deletion refuses opt-in block selectors before dispatch', async () => {
 const h = fixture(); refused(await h.call('event.delete', { eventId: 'block_1', eventType: 'block', calendarId: 'cal_1', ...originalInterval }), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
it('legacy note update refuses the opt-in page selector before provider access', async () => {
 const h = fixture(); refused(await h.call('appointmentNotes.update', { ...workflowArgs['appointmentNotes.update'], noteOffset: 120 }), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
it('missing note on the selected page never sends', async () => {
 const h = fixture(); h.api.first('GET', /^\/calendars\/appointments\/event_1\/notes$/, { status: 200, body: { notes: [], hasMore: false } });
 expect(await h.call('appointmentNotes.update', { ...workflowArgs['appointmentNotes.update'], noteOffset: 120 })).toMatchObject({ isError: true }); expect(h.writes()).toBe(0);
});
it('legacy booking refuses undeclared prerequisites before review or send', async () => {
 const h = fixture(false); refused(await h.call('appointment.book'));
 expect(h.api.requests).toHaveLength(0); expect(h.reviews).toHaveLength(0);
});
// Recovery tests exercise real specs with declared-read enforcement. Provider data
// cannot invent new targets or turn partial/negative responses into success.
for (const verb of ['create', 'appointment.book', 'blockSlot.create', 'appointment.reschedule', 'appointment.cancel', 'blockSlot.update', 'appointmentNotes.create', 'appointmentNotes.update', 'appointmentNotes.delete']) {
 it(verb === 'appointmentNotes.delete' ? `recovery compares the calendar effect and retained identities: ${verb}` : `legacy recovery stops at the frozen schema, preflight or identity boundary: ${verb}`, async () => {
  const h = fixture(), spec = operationSpec(`calendars.${verb}`)!; expect(spec).toBeDefined(); if (spec.risk === 'R') throw new Error('mutation expected');
  const pre = { read: async (op: Parameters<typeof operationSpec>[0], draft: { path: string; query?: Record<string, string> }) => {
   if (!spec.preflight.some(declared => declared === op)) throw new Error(`Undeclared preflight: ${op}`);
   const url = new URL(draft.path, 'https://fixture.invalid'); Object.entries(draft.query ?? {}).forEach(([k, v]) => url.searchParams.set(k, v));
   return (await h.api.fetch(url, { method: 'GET' })).json();
  } };
  if (verb === 'blockSlot.update') {
   expect(spec.args.safeParse(workflowArgs[verb])).toMatchObject({ success: false });
   expect(h.api.requests).toHaveLength(0); return;
  }
  const undeclared: Record<string, string> = { create: 'calendars.groups.list', 'appointment.book': 'calendars.get', 'blockSlot.create': 'calendars.get', 'appointment.reschedule': 'calendars.get', 'appointmentNotes.create': 'users.list', 'appointmentNotes.update': 'users.list' };
  const preparing = spec.prepare(pre, spec.args.parse(workflowArgs[verb]), { locationId: h.calendar.locationId });
  if (undeclared[verb]) {
   await expect(preparing).rejects.toThrow(`Undeclared preflight: ${undeclared[verb]}`);
   expect(h.writes()).toBe(0); return;
  }
  const draft = await preparing;
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
  // The frozen identity policy has no opt-in returned-parent extension.
  expect(compareWriteRecovery(structuredClone(plan), response, spec)).toMatchObject({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
  expect(compareWriteRecovery(plan, { ...response, nested: { locationId: 'foreign' } }, spec)).toHaveProperty('outcome');
  expect(compareWriteRecovery(plan, { ...response, success: false }, spec)).toHaveProperty('outcome');
  if (plan.collection) expect(compareWriteRecovery(plan, { ...response, hasMore: true }, spec)).toHaveProperty('outcome');
 });
}
it('legacy reschedule cannot open review without its opt-in prerequisites', async () => {
 const h = fixture(false); refused(await h.call('appointment.reschedule'));
 expect(h.reviews).toHaveLength(0); expect(h.writes()).toBe(0);
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
  it(['appointment.book', 'appointment.reschedule', 'blockSlot.create', 'blockSlot.update', 'appointmentNotes.create', 'appointmentNotes.update'].includes(verb) ? `legacy ${verb}: refuses before the crash boundary (${mode})` : `${verb}: fresh-process recovery (${mode}) makes zero resends`, () => {
   const dir = mkdtempSync(join(tmpdir(), 'calendar-crash-')); dirs.push(dir);
   const run = (phase: string) => spawnSync(process.execPath, ['--experimental-strip-types', 'server/highlevel/testing/calendar-crash-worker.ts', dir, verb, phase, mode], { encoding: 'utf8', timeout: 20000 });
   const send = run('send');
   if (['appointment.book', 'appointment.reschedule', 'blockSlot.create', 'blockSlot.update', 'appointmentNotes.create', 'appointmentNotes.update'].includes(verb)) {
    expect(send.status, send.stderr).toBe(74);
    const report = JSON.parse(readFileSync(join(dir, 'refusal.json'), 'utf8'));
    refused(report.result.result, verb === 'blockSlot.update' ? schemaError : prepareError);
    expect(report).toMatchObject({ writes: 0, actions: 0 }); return;
   }
   expect(send.status, send.stderr).toBe(73);
   expect(JSON.parse(readFileSync(join(dir, 'send.json'), 'utf8'))).toEqual({ writes: 1, phase: 'dispatching' });
   const replay = run('replay'); expect(replay.status, replay.stderr).toBe(0);
   const report = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
   expect(report.result.result).toMatchObject({ structuredContent: { outcome: mode === 'accepted' && ['update', 'delete'].includes(verb) ? 'applied' : 'outcome_unknown' } });
   expect(report).toMatchObject({ writes: 0, reads: ['create', 'appointmentNotes.delete'].includes(verb) ? 0 : 1, terminalReads: 0, identical: true, unexpected: 0 });
  }, 45000);
 }
}
it('legacy paginated note creation refuses the undeclared user prerequisite', async () => {
 const h = fixture();
 h.api.first('GET', /^\/calendars\/appointments\/event_1\/notes$/, { status: 200, body: { notes: [h.note], hasMore: true } });
 refused(await h.call('appointmentNotes.create'));
 expect(h.api.requests.map(r => [r.method, r.path])).toEqual([['GET', '/calendars/events/appointments/event_1']]);
 expect(h.writes()).toBe(0);
});
it('legacy note deletion refuses a selected later page without reading or sending', async () => {
 const h = fixture(); refused(await h.call('appointmentNotes.delete', { ...workflowArgs['appointmentNotes.delete'], noteOffset: 120 }), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
it('legacy block deletion refuses opt-in host selectors without provider access', async () => {
 const h = fixture();
 refused(await h.call('event.delete', { eventId: 'block_1', eventType: 'block', calendarId: 'cal_1', userId: 'user_1', ...originalInterval }), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
it('legacy block updates refuse the opt-in original host without provider access', async () => {
 const h = fixture(); refused(await h.call('blockSlot.update', { ...workflowArgs['blockSlot.update'], originalUserId: 'user_1' }), schemaError);
 expect(h.api.requests).toHaveLength(0);
});
