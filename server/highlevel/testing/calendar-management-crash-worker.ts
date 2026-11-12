// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HighLevelActions } from '../actions.ts';
import { FileActionJournal } from '../journal-file.ts';
import { FileRpcApprovalJournal } from '../rpc-approval-replay.ts';
import { calendarWorkflowFixture, workflowArgs } from './calendar-management-fixture.ts';
import { calendarManagementOperationSpec as operationSpec } from '../calendar-management.ts';
const [dir, verb, phase, mode = 'accepted'] = process.argv.slice(2);
if (!dir || !verb || !workflowArgs[verb] || !['send', 'replay'].includes(phase) || !['accepted', 'foreign', 'negative', 'partial'].includes(mode)) throw new Error('Invalid fixture input');
const actionJournal = new FileActionJournal(join(dir, 'actions.jsonl'));
const actions = new HighLevelActions({ journal: actionJournal }); if (phase === 'replay') actions.recover();
const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
const callJournal = new FileRpcApprovalJournal(join(dir, 'calls'));
const h = calendarWorkflowFixture(true, { actions, approvalJournal, callJournal });
const spec = operationSpec(`calendars.${verb}`)!;
const args: Record<string, unknown> = verb === 'create' ? { locationId: h.calendar.locationId, name: 'Fixture calendar' } : workflowArgs[verb]!;
const path = spec.row.path!.replace(/:([A-Za-z]+)/g, (_, key: string) => String(args[key]));
const created = ['create', 'appointment.book', 'blockSlot.create', 'appointmentNotes.create'].includes(verb);
const deleting = verb.endsWith('.delete') || verb === 'delete';
const initial = verb.startsWith('appointmentNotes.') ? h.note : verb.startsWith('blockSlot.') ? h.block : ['create', 'update', 'delete'].includes(verb) ? h.calendar : h.event;
const makeItem = (body: object) => ({ ...initial, ...body, ...(created ? { id: 'new_fixture_id' } : {}) });
if (phase === 'send') {
 h.api.first(spec.endpoint.method, new RegExp(`^${path}$`), r => {
  const item = makeItem(r.body as object ?? {}); writeFileSync(join(dir, 'provider.json'), JSON.stringify(item));
  const result = deleting ? { [verb === 'event.delete' ? 'succeeded' : 'success']: true } : verb.startsWith('appointmentNotes.') ? { note: item } : ['create', 'update'].includes(verb) ? { calendar: item } : item;
  return { status: 200, body: result };
 });
 approvalJournal.settle = () => {
  writeFileSync(join(dir, 'send.json'), JSON.stringify({ writes: h.writes(), phase: actionJournal.all()[0]?.phase }));
  process.exit(73); // Real process loss after send and before terminal settlement.
 };
} else {
 const item = JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8'));
 if (mode === 'foreign') item.hidden = [{ contactId: 'foreign' }];
 if (mode === 'negative') item.hidden = [{ success: false }];
 const list = (route: RegExp, collection: string, members: unknown[]) => h.api.first('GET', route, { status: 200, body: { [collection]: members, ...(mode === 'partial' ? { hasMore: true } : {}) } });
 if (verb === 'create') list(/^\/calendars\/$/, 'calendars', [h.calendar, item]);
 else if (verb === 'appointment.book') list(/^\/calendars\/events$/, 'events', [item]);
 else if (verb.startsWith('blockSlot.')) list(/^\/calendars\/blocked-slots$/, 'events', [item]);
 else if (verb.startsWith('appointmentNotes.')) list(/^\/calendars\/appointments\/event_1\/notes$/, 'notes', deleting ? [] : [item]);
 else if (deleting) h.api.first('GET', new RegExp(`^${verb === 'delete' ? '/calendars/cal_1' : '/calendars/events/appointments/event_1'}$`), { status: 404, body: {} });
 else h.api.first('GET', new RegExp(`^${path}$`), { status: 200, body: verb === 'update' ? { calendar: item } : { event: item } });
}
const rpc = () => h.host.handle(h.claim, { jsonrpc: '2.0', id: 'calendar-crash', method: 'tools/call', params: { name: 'HIGHLEVEL_CALENDARS', arguments: { operation: spec.id, args } } });
const result = await rpc(); if (phase === 'send') throw new Error(`Did not reach crash: ${JSON.stringify(result)}`);
const reads = h.api.requests.length, terminal = await rpc();
writeFileSync(join(dir, 'replay.json'), JSON.stringify({ result, identical: JSON.stringify(result) === JSON.stringify(terminal), writes: h.writes(), reads, terminalReads: h.api.requests.length - reads, unexpected: h.api.unexpected.length }));
h.stop();
