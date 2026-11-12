import { defaultHighLevelFamilies } from "../../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { join } from 'node:path';
import { HighLevelActions } from '../actions.ts';
import { FileActionJournal } from '../journal-file.ts';
import { FileRpcApprovalJournal as FileApprovalJournal } from '../rpc-approval-replay.ts';
import { HighLevelHost } from '../host.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, freezeOperationSpec, type MutationSpec } from '../operations/registry.ts';
import { HIGHLEVEL_ENDPOINTS } from '../provider-contract.ts';
import { highLevelHarness } from '../../testing/fake-highlevel.ts';
import { fixtureReadSpec } from '../../testing/highlevel-r4-fixtures.ts';
export const pipelineArgs = { name: 'Reviewed', stages: [{ name: 'New', position: 0, showInFunnel: true }] };
export function recoveryFixture(dir: string, operation = 'opportunities.pipelines.create', suppliedArgs?: Record<string, unknown>) {
  const h = highLevelHarness({ deadlineMs: 2000 });
  const access: any = h.bot.highlevelAccess; access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), opportunities: 'full', contacts: 'full' }; access.grants[0].operations = {};
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
  const approvalJournal = new FileApprovalJournal(join(dir, 'approvals'));
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === operation)!;
  const tags = operation.includes('.tags.');
  const deleting = operation.endsWith('.delete');
  const note = operation === 'contacts.notes.update' || operation === 'contacts.notes.create';
  const task = operation === 'contacts.tasks.create';
  const args = suppliedArgs ?? (deleting ? (operation.startsWith('opportunities.pipelines.') ? { pipelineId: 'pipe_A' } : { contactId: 'contact_1' }) : note ? { contactId: 'contact_1', noteId: 'note_1', body: 'Reviewed note' } : tags ? { contactId: 'contact_1', tags: ['a'] } : operation === 'opportunities.upsert'
    ? { id: 'opp_A', pipelineId: 'pipe_A', name: 'Reviewed' } : pipelineArgs);
  const spec = freezeOperationSpec({ id: operation, row, family: row.family, risk: row.risk, gate: row.gate,
    send: row.send, precondition: row.precondition, args: row.argsSchema, endpoint: HIGHLEVEL_ENDPOINTS[operation]!,
    title: 'Recovery fixture', nested: false, preflight: row.preflight,
    recordRefs: () => tags ? ['contact_1'] : [], fields: () => Object.keys(args), targets: () => 1,
    project: (v: unknown) => v, recordId: (v: any) => v.id ?? v.opportunity?.id ?? v.note?.id ?? v.task?.id,
    prepare: async (_pre: unknown, a: any, ctx: any) => {
      const path = row.path!.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_, key) => a[key]);
      return { path, resource: row.pathResourceSegment === null ? `location:${ctx.locationId}` : `${row.family}:record:${path.split('/')[row.pathResourceSegment]}`,
        ...(deleting ? {} : { body: { kind: 'json' as const, value: tags ? { tags: a.tags } : note ? { body: a.body }
          : task ? { title: a.title, dueDate: a.dueDate, completed: a.completed } : { ...a, locationId: ctx.locationId } } }) };
    },
  } as MutationSpec<any>);
  const deps = { ...h, actions, approvalJournal, bot: () => h.bot,
    operationSpec: (id: string) => id === operation ? spec : fixtureReadSpec(id), operationScopes: () => [spec.endpoint.scope],
    onReview: (_claim: unknown, review: any) => { h.reviews.push(review); actions.approve(review.actionId, review.reviewDigest); } };
  const host = new HighLevelHost(deps);
  const message = { jsonrpc: '2.0', id: 'crash-rpc', method: 'tools/call', params: { name: row.family === 'contacts' ? 'HIGHLEVEL_CONTACTS' : 'HIGHLEVEL_OPPORTUNITIES', arguments: { operation, args } } };
  return { ...h, actions, approvalJournal, host, deps, spec, message, call: (target = host) => target.handle(h.claim, message) };
}
