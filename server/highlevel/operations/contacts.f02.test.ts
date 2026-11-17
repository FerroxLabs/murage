// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { operationSpec } from './registry.ts';
import { prepareContactConfirmation } from '../contact-confirmation.ts';
import { HeldRequest } from '../held-request.ts';
import * as identities from '../returned-identities.ts';
import { HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS } from './returned-identity-schemas.ts';
import { contactFake } from '../fake/contacts.ts';
import { providerOperation } from '../provider-manifest.ts';

const context = { locationId: 'loc1' };
const samples = [
  ['create', { firstName: 'Reviewed' }, { contact: { id: 'new_c' } }],
  ['update', { contactId: 'c1', firstName: 'Reviewed', assignedTo: 'u1', customFields: [{ id: 'cf1', value: 'yes' }] }, { contact: { id: 'c1', assignedTo: 'u1', customFields: [{ id: 'cf1', value: 'yes' }] } }],
  ['upsert', { firstName: 'Reviewed' }, { new: true, contact: { id: 'new_c' } }],
  ['delete', { contactId: 'c1' }, { succeeded: true }],
  ['tags.add', { contactId: 'c1', tags: ['a'] }, { tags: ['a'] }],
  ['tags.remove', { contactId: 'c1', tags: ['a'] }, { tags: [] }],
  ['tags.bulk', { contacts: ['c1', 'c2'], type: 'add', tags: ['a'] }, { succeeded: true, errorCount: 0, contacts: ['c1', 'c2'] }],
  ['notes.create', { contactId: 'c1', body: 'Reviewed', userId: 'u1' }, { note: { id: 'new_n', contactId: 'c1', userId: 'u1' } }],
  ['notes.update', { contactId: 'c1', noteId: 'n1', body: 'Reviewed' }, { note: { id: 'n1', contact: { contactId: 'c1' } } }],
  ['notes.delete', { contactId: 'c1', noteId: 'n1' }, { succeeded: true }],
  ['tasks.create', { contactId: 'c1', title: 'Reviewed', dueDate: '2026-11-20T10:00:00Z' }, { task: { id: 'new_t', contactId: 'c1' } }],
  ['tasks.update', { contactId: 'c1', taskId: 't1', title: 'Reviewed', assignedTo: 'u1' }, { task: { id: 't1', assignedTo: 'u1', contactId: 'c1' } }],
  ['tasks.complete', { contactId: 'c1', taskId: 't1', completed: true }, { task: { id: 't1', completed: true } }],
  ['tasks.delete', { contactId: 'c1', taskId: 't1' }, { succeeded: true }],
  ['followers.add', { contactId: 'c1', followers: ['u1'] }, { followers: ['u1'], followersAdded: ['u1'] }],
  ['followers.remove', { contactId: 'c1', followers: ['u1'] }, { followers: ['u1'], followersRemoved: ['u1'] }],
] as const;
async function prepared(index: number) {
  const [verb, args, response] = samples[index]!;
  const spec = operationSpec(`contacts.${verb}`)!;
  if (spec.risk === 'R') throw new Error('Expected write');
  const fake = contactFake();
  const draft = await spec.prepare({ read: (id, d) => fake.request(id, providerOperation(id)!.method!, d.path, d.body, d.query) }, structuredClone(args), context);
  const held = HeldRequest.freeze(spec, draft, context);
  prepareContactConfirmation(held, draft, context.locationId);
  identities.prepareReturnedIdentitySchema(held, context.locationId);
  return { spec, held, response: structuredClone(response) };
}
afterEach(() => vi.restoreAllMocks());
for (const [index, [verb]] of samples.entries()) {
  it(`${verb}: approved identities/new slots/pass-through and no-ID confirmation`, async () => {
    const { spec, held, response } = await prepared(index);
    const raw = { ...response, locationId: 'loc1' };
    expect(() => spec.recordId!(raw, held.frozen)).not.toThrow();
    expect(() => spec.project(raw, held.frozen)).not.toThrow();
    for (const hook of [spec.recordId!, spec.project]) {
      expect(() => hook(raw)).toThrow();
      expect(() => hook(raw, { ...held.frozen })).toThrow();
    }
  });
  it(`${verb}: both hooks require the shared identity gate`, async () => {
    const { spec, held, response } = await prepared(index);
    const gate = vi.spyOn(identities, 'bindReturnedIdentities').mockReturnValue({ status: 'conflict', reason: 'identity_mismatch', keys: [] });
    for (const hook of [spec.recordId!, spec.project]) expect(() => hook(response, held.frozen)).toThrow();
    expect(gate).toHaveBeenCalledTimes(2);
  });
  const keys = [...new Set([...Object.keys(HIGHLEVEL_RETURNED_IDENTITY_SCHEMAS[`contacts.${verb}`].identities), 'id', 'contactId', 'contact_id', 'assignedTo', 'userId', 'locationId', 'foreignId'])];
  for (const key of keys) for (const depth of [1, 2, 3]) for (const array of [false, true]) {
    it(`${verb}: ${key} conflict at depth=${depth} array=${array}`, async () => {
      const { spec, held, response } = await prepared(index);
      let nested: unknown = { [key]: 'UNAPPROVED_PRIVATE_ID' };
      for (let i = 1; i < depth; i++) nested = { sibling: nested };
      const raw = { ...response, discarded: array ? [nested] : nested };
      for (const hook of [spec.recordId!, spec.project]) expect(() => hook(raw, held.frozen)).toThrow(expect.objectContaining({ outcome: 'outcome_unknown' }));
    });
  }
}
it('review nested contact.contactId is refused in the retained note response', async () => {
  const { spec, held } = await prepared(8);
  for (const hook of [spec.recordId!, spec.project]) expect(() => hook({ note: { id: 'n1', contact: { contactId: 'c2' } } }, held.frozen)).toThrow();
});
it.each([{ set: [] }, { set: ['u2'] }, { set: ['u1', 'u2'] }, { set: ['u1', 'u1'] }])('follower effect must equal the approved set: %j', async ({ set: followersAdded }) => {
  const { spec, held } = await prepared(14);
  for (const hook of [spec.recordId!, spec.project]) expect(() => hook({ followers: ['u1'], followersAdded }, held.frozen)).toThrow();
});
it('review empty followers plus wrong added follower is refused', async () => {
  const { spec, held } = await prepared(14);
  expect(() => spec.project({ followers: [], followersAdded: ['u2'] }, held.frozen)).toThrow();
});
it.each([{ success: false }, { succeeded: false }, { error: 'PRIVATE_ERROR' }, { errorCount: 1 }])('nested negative confirmation withholds payload: %j', async negative => {
  const { spec, held, response } = await prepared(8);
  for (const hook of [spec.recordId!, spec.project]) expect(() => hook({ ...response, ignored: [{ nested: negative }] }, held.frozen)).toThrow(expect.objectContaining({ outcome: 'not_applied' }));
});
it('upsert cannot approve an existing provider identity without new:true', async () => {
  const { spec, held } = await prepared(2);
  expect(() => spec.project({ new: false, contact: { id: 'existing_c' } }, held.frozen)).toThrow();
});

it.each([4, 5])('tag-only response confirms the approved post-state: %s', async index => {
  const { spec, held, response } = await prepared(index);
  expect(spec.project(response, held.frozen)).toEqual(response);
});
