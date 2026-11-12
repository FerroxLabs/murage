// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { schemas } from './operations/schemas/calendars.ts';
import { operationSpec } from './operations/registry.ts';
import { calendarManagementOperationSpec, CALENDAR_MANAGEMENT_MANIFEST } from './calendar-management.ts';
import { operationExtension } from './operation-extension.ts';
import { workflowArgs, calendarWorkflowFixture, originalInterval } from './testing/calendar-management-fixture.ts';

it('preserves the old block schema and caller while adding a separate optional selector', () => {
 const { originalStartTime: _start, originalEndTime: _end, ...legacy } = workflowArgs['blockSlot.update']!;
 const old = operationSpec('calendars.blockSlot.update')!;
 expect(old.args).toBe(schemas['calendars.blockSlot.update'].argsSchema);
 expect(old.args.parse(legacy)).toEqual(legacy);
 expect(old.args.safeParse(workflowArgs['blockSlot.update']).success).toBe(false);
 expect(operationExtension(old.row)).toBeUndefined();
 const next = calendarManagementOperationSpec('calendars.blockSlot.update')!;
 expect(next.row).not.toBe(old.row);
 expect(next.args.parse(legacy)).toEqual(legacy); // no newly required inputs
 expect(next.args.parse(workflowArgs['blockSlot.update'])).toEqual(workflowArgs['blockSlot.update']);
 expect(old.preflight).not.toContain('calendars.blockSlots.list');
 expect(next.preflight).toContain('calendars.blockSlots.list');
});
it('keeps all 21 opt-in operations and exact schema/row identities', () => {
 expect(CALENDAR_MANAGEMENT_MANIFEST).toHaveLength(21);
 for (const row of CALENDAR_MANAGEMENT_MANIFEST) {
  const spec = calendarManagementOperationSpec(row.id)!;
  expect(spec.row).toBe(row); expect(spec.args).toBe(row.argsSchema); expect(spec.preflight).toBe(row.preflight);
 }
});
it.each(['extra', 'headers', 'endpoint'])('selector extension still refuses undeclared %s', key => {
 const spec = calendarManagementOperationSpec('calendars.blockSlot.update')!;
 expect(spec.args.safeParse({ ...workflowArgs['blockSlot.update'], [key]: 'unexpected' }).success).toBe(false);
 expect(spec.args.safeParse({ ...workflowArgs['blockSlot.update'], originalStartTime: 'https://foreign.invalid' }).success).toBe(false);
});
it('withholds a block selector whose original interval is invalid without writing', async () => {
 const h = calendarWorkflowFixture();
 try {
  expect(await h.call('blockSlot.update', { ...workflowArgs['blockSlot.update'], ...originalInterval, originalEndTime: originalInterval.originalStartTime })).toMatchObject({ isError: true });
  expect(h.writes()).toBe(0);
 } finally { h.stop(); }
});

it('advertises the same opt-in selectors and the blocked-slot read it executes', async () => {
 const h = calendarWorkflowFixture();
 try {
  const response = await h.host.handle(h.claim, { jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  const tools = (response.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
  const definition = tools.find(tool => tool.name === 'HIGHLEVEL_CALENDARS')!;
  const json = JSON.stringify(definition.inputSchema);
  expect(json).toContain('calendars.blockSlots.list');
  expect(json).toContain('originalStartTime');
  expect(json).toContain('originalEndTime');
  expect(h.writes()).toBe(0);
 } finally { h.stop(); }
});
