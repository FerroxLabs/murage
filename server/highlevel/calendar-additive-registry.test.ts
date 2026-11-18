// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { calendarManagementFamilyOperations, calendarManagementOperationSpec } from './calendar-management.ts';
import { calendarWorkflowFixture, workflowArgs } from './testing/calendar-management-fixture.ts';
import { HeldRequest } from './held-request.ts';

// Positive obligations superseded in the default suites remain on the opt-in rows.
it('all 21 opt-in calendar operations are immutable and have no direct send hook', () => {
 const specs = calendarManagementFamilyOperations('calendars');
 expect(specs).toHaveLength(21);
 for (const spec of specs) { expect('run' in spec).toBe(false); expect(Object.isFrozen(spec)).toBe(true); }
});
it('opt-in block update prepares an immutable provider request with safe receipt metadata', async () => {
 const h = calendarWorkflowFixture();
 try {
  const spec = calendarManagementOperationSpec('calendars.blockSlot.update')!;
  if (spec.risk === 'R') throw new Error('mutation expected');
  const input = workflowArgs['blockSlot.update']!;
  const draft = await spec.prepare({ read: async (_op, read) => {
   const url = new URL(read.path, 'https://fixture.invalid');
   Object.entries(read.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));
   return (await h.api.fetch(url, { method: 'GET' })).json();
  } }, spec.args.parse(input), { locationId: h.calendar.locationId });
  const held = HeldRequest.freeze(spec, draft, { locationId: h.calendar.locationId });
  expect(spec.endpoint.path.test(draft.path)).toBe(true);
  expect(JSON.stringify({ refs: spec.recordRefs(input), fields: spec.fields(input) })).not.toContain('PRIVATE_SENTINEL');
  const copy = held.sendCopy(); if (copy.body?.length) copy.body.fill(0);
  expect(() => HeldRequest.freeze(spec, { ...draft, path: '/contacts/foreign' }, { locationId: h.calendar.locationId })).toThrow();
  expect(held.sendCopy().body?.length).toBeGreaterThan(0);
  expect(held.sendCopy().body).not.toEqual(copy.body);
 } finally { h.stop(); }
});
