// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { HeldRequest } from './held-request.ts';
import { operationSpec, type MutationSpec } from './operations/registry.ts';
import { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery, readWriteRecovery } from './write-recovery.ts';
import { prepareContactRecovery, contactRecoveryPlan, saveContactRecovery, reconcileContactEffect } from './contact-recovery.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { prepareReturnedIdentitySchema } from './returned-identities.ts';
const locationId = FAKE_LOCATION_ID;
const pipeline = { name: 'Reviewed', stages: [{ name: 'New', position: 0, showInFunnel: true }] };
async function pipelinePlan() {
  const spec = operationSpec('opportunities.pipelines.create') as MutationSpec;
  const pre = { read: vi.fn(async () => ({ pipelines: [] })) };
  const args = spec.args.parse(pipeline);
  const held = HeldRequest.freeze(spec, await spec.prepare(pre, args, { locationId }), { locationId });
  const plan = prepareWriteRecovery(held, locationId);
  await captureRecoveryPreState(plan, pre);
  // RULE-A: docs/verification/highlevel-hlc2-bounded-recovery.md.
  // Unsupported pipeline collections supply no bounded recovery evidence.
  expect(pre.read).not.toHaveBeenCalled();
  expect(await readWriteRecovery(plan, pre, pipeline)).toEqual({});
  expect(pre.read).not.toHaveBeenCalled();
  return { spec, plan };
}
const record = { id: 'created_1', ...pipeline, stages: [{ id: 'stage_1', ...pipeline.stages[0] }] };
it.each([
  ['review recoveryEnvelope collision', { pipelines: [{ ...record, recoveryEnvelope: { succeeded: false } }] }],
  ['nonmatching negative member', { pipelines: [record, { ...record, id: 'other', name: 'Other', succeeded: false }] }],
  ['nonmatching foreign member', { pipelines: [record, { ...record, id: 'other', name: 'Other', hidden: [{ locationId: 'foreign' }] }] }],
  ['only nonmatching foreign member', { pipelines: [{ ...record, id: 'other', name: 'Other', hidden: [{ locationId: 'foreign' }] }] }],
  ['negative status', { pipelines: [{ ...record, status: 'failed' }] }],
  ['missing confirmation', { pipelines: [{ ...pipeline }] }],
] as const)('MAIN P1 recovery: %s', async (_label, raw) => {
  const { spec, plan } = await pipelinePlan();
  expect(compareWriteRecovery(plan, raw, spec)).toMatchObject({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
});
it('RULE-A raw positive pipeline collection cannot prove a bounded effect', async () => {
  const { spec, plan } = await pipelinePlan();
  expect(compareWriteRecovery(plan, { pipelines: [record] }, spec)).toMatchObject({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
});
async function contactPlan(operation = 'contacts.create', followers: string[] = []) {
  const h = highLevelHarness();
  const spec = operationSpec(operation) as MutationSpec;
  const input = operation === 'contacts.create' ? { firstName: 'Ada' } : { contactId: 'contact_1', followers: ['u_new'] };
  const pre = { read: async () => operation === 'contacts.create' ? { contacts: [], total: 0 } : { contact: { id: 'contact_1', locationId, followers } } };
  const held = HeldRequest.freeze(spec, await spec.prepare(pre, spec.args.parse(input), { locationId }), { locationId });
  prepareReturnedIdentitySchema(held, locationId);
  await prepareContactRecovery(spec, held, pre, locationId);
  const row = { actionId: 'action_1', approvalId: 'approval_1', requestDigest: held.frozen.requestDigest, resource: held.frozen.resource, locationId, fields: operation === 'contacts.create' ? ['firstName'] : ['followers'] } as any;
  saveContactRecovery(h.approvalJournal, row.approvalId, held, 'authority');
  const binding = { ...contactRecoveryPlan(spec, held), rpcId: 'rpc', rpcDigest: 'digest', authorityDigest: 'authority', ...row, operation };
  return { h, spec, held, row, binding };
}
it.each([
  { contacts: [], total: 0, hasMore: true, nextCursor: 'more' },
  { contacts: [], total: 0, hasMore: true },
  { contacts: [], total: 0, nextCursor: 'more' },
  { contacts: [], total: 1 },
  { contacts: [] },
  { contacts: [], meta: { total: 0, hasMore: true } },
])('MAIN P1 incomplete contact search stays unconfirmed: %j', async raw => {
  const f = await contactPlan();
  try {
    const outcome = await reconcileContactEffect(f.spec, f.row, f.binding, f.h.approvalJournal, { read: async () => raw }).catch(() => ({ status: 'conflict', reason: 'unconfirmed' }));
    expect(outcome).toMatchObject({ status: 'conflict', reason: 'unconfirmed' });
  } finally { f.h.stop(); }
});
it('MAIN P2 u_old/u_new recovery never expands the approved follower identity set', async () => {
  const f = await contactPlan('contacts.followers.add', ['u_old']);
  try {
    const outcome = await reconcileContactEffect(f.spec, f.row, f.binding, f.h.approvalJournal, { read: async () => ({ contact: { id: 'contact_1', locationId, followers: ['u_old', 'u_new'] } }) });
    expect(outcome).toMatchObject({ status: 'conflict' });
  } finally { f.h.stop(); }
});

it.each(['name', 'position'])('RULE-A raw pipeline absence cannot prove bounded negative confirmation: %s', async field => {
  const { spec, plan } = await pipelinePlan();
  const changed = structuredClone(record);
  if (field === 'name') changed.name = 'Other'; else changed.stages[0].position = 1;
  expect(compareWriteRecovery(plan, { pipelines: [changed] }, spec)).toMatchObject({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
});
