import { defaultHighLevelFamilies } from "../../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HighLevelHost } from '../host.ts';
import { HighLevelActions } from '../actions.ts';
import { FileActionJournal } from '../journal-file.ts';
import { FileRpcApprovalJournal } from '../rpc-approval-replay.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../../testing/fake-highlevel.ts';
import { contactRecoveryCases } from './contact-recovery-cases.ts';
const [dir, index, mode, phase] = process.argv.slice(2);
const sample = contactRecoveryCases[Number(index)];
if (!dir || !sample || !['accepted', 'absent'].includes(mode) || !['send', 'replay'].includes(phase)) throw new Error('Invalid isolated fixture input');
const [verb, args, method, path] = sample;
const accepted = phase === 'replay' ? JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')).accepted === true : mode === 'accepted';
const h = highLevelHarness();
h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
  grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] } as typeof h.bot.highlevelAccess;
const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
if (phase === 'replay') actions.recover();
const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
let sent = phase === 'replay' && JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')).sent === true;
const exact = (p: string) => new RegExp(`^${p}$`);
const serve = (m: string, p: string, reply: () => { status: number; body: unknown }) => {
  const next = () => {
    h.api.first(m, exact(p), next);
    const result = reply();
    return result;
  };
  h.api.first(m, exact(p), next);
};
const changed = () => sent && accepted;
const tags = () => verb === 'tags.remove' ? (changed() ? ['keep'] : ['a', 'keep']) : (changed() ? ['a', 'keep'] : ['keep']);
const followers = () => verb === 'followers.remove' ? (changed() ? [] : ['u1']) : (changed() ? ['u1'] : []);
const contact = (id = 'contact_1') => ({ id, locationId: FAKE_LOCATION_ID,
  ...(verb === 'update' ? { firstName: changed() ? 'Reviewed' : 'Before' } : {}),
  ...(verb.startsWith('tags.') ? { tags: tags() } : {}),
  ...(verb.startsWith('followers.') ? { followers: followers() } : {}) });
for (const id of ['contact_1', 'contact_2']) serve('GET', `/contacts/${id}`, () =>
  verb === 'delete' && changed() ? { status: 404, body: {} } : { status: 200, body: { contact: contact(id) } });
const note = () => ({ id: 'note_1', contactId: 'contact_1', body: changed() ? 'Reviewed' : 'Before', ...(verb === 'notes.create' ? { userId: 'u1' } : {}) });
const task = () => ({ id: 'task_1', contactId: 'contact_1', title: changed() ? 'Reviewed' : 'Before', dueDate: '2026-11-20T10:00:00Z', completed: verb === 'tasks.complete' ? changed() : false });
for (const [plural, singular, record] of [['notes', 'note', note], ['tasks', 'task', task]] as const) {
  serve('GET', `/contacts/contact_1/${plural}`, () => ({ status: 200, body: { [plural]: changed() ? [record()] : [], total: changed() ? 1 : 0 } }));
  serve('GET', `/contacts/contact_1/${plural}/${singular}_1`, () => verb === `${plural}.delete` && changed()
    ? { status: 404, body: {} } : { status: 200, body: { [singular]: record() } });
}
serve('POST', '/contacts/search', () => ({ status: 200, body: {
  contacts: changed() ? [{ id: 'new_contact', locationId: FAKE_LOCATION_ID, firstName: 'Reviewed' }] : [], total: changed() ? 1 : 0,
} }));
serve(method, path, () => {
  sent = true;
  writeFileSync(join(dir, 'provider.json'), JSON.stringify({ sent, accepted }));
  const body = verb === 'create' || verb === 'upsert' ? { new: true, contact: { id: 'new_contact', firstName: 'Reviewed' } }
    : verb === 'update' ? { contact: { id: 'contact_1', firstName: 'Reviewed' } }
    : verb.endsWith('delete') ? { succeeded: true }
    : verb === 'tags.bulk' ? { succeeded: true, errorCount: 0, contacts: ['contact_1', 'contact_2'] }
    : verb.startsWith('tags.') ? { tags: verb === 'tags.remove' ? ['keep'] : ['a', 'keep'] }
    : verb.startsWith('followers.') ? { followers: ['u1'] }
    : verb.startsWith('notes.') ? { note: note() } : { task: task() };
  return { status: 200, body };
});

const settle = approvalJournal.settle.bind(approvalJournal);
if (phase === 'send') approvalJournal.settle = (...a) => {
  if (a[0].startsWith('contact-recovery:')) return settle(...a);
  writeFileSync(join(dir, 'send.json'), JSON.stringify({ writes: h.api.calls(method, exact(path)).length, phase: actions.get(new FileActionJournal(join(dir, 'actions.jsonl')).all()[0].actionId)?.phase }));
  process.exit(73); // A real process loss after the provider send, before terminal publication.
};
const host = new HighLevelHost({ ...h, actions, approvalJournal, bot: () => h.bot,
  operationScopes: () => ['contacts.readonly', 'contacts.write'],
  approvalBasis: (_claim, spec) => spec.risk === 'D' ? 'owner_no_limits_attended' : 'owner_no_limits' });
const rpc = () => host.handle(h.claim, { jsonrpc: '2.0', id: 'process-crash', method: 'tools/call',
  params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation: `contacts.${verb}`, args } } });
const result = await rpc();
if (phase === 'send') throw new Error('Did not reach crash boundary');
const reads = h.api.requests.length;
const terminal = await rpc();
writeFileSync(join(dir, 'replay.json'), JSON.stringify({ result, identical: JSON.stringify(result) === JSON.stringify(terminal),
  writes: h.api.calls(method, exact(path)).length, reads, terminalReads: h.api.requests.length - reads, unexpected: h.api.unexpected.length }));
h.stop();
