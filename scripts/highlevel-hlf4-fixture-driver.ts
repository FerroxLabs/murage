// Isolated server instrumentation. Provider calls stay in the in-memory fixture.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { calendarWorkflowFixture, workflowArgs } from '../server/highlevel/testing/calendar-fixture.ts';
import { HighLevelActions } from '../server/highlevel/actions.ts';
import { FileActionJournal } from '../server/highlevel/journal-file.ts';
import { FileRpcApprovalJournal } from '../server/highlevel/rpc-approval-replay.ts';
import { operationSpec } from '../server/highlevel/operations/registry.ts';

export async function runFixtureEvidence(dataDir: string) {
 const results: unknown[] = [];
 for (const [verb, args] of Object.entries(workflowArgs)) {
  const dir = join(dataDir, 'calendar-workflows', verb); mkdirSync(dir, { recursive: true });
  const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
  const callJournal = new FileRpcApprovalJournal(join(dir, 'calls'));
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
  const h = calendarWorkflowFixture(true, { approvalJournal, callJournal, actions });
  const request = (id: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'HIGHLEVEL_CALENDARS', arguments: { operation: `calendars.${verb}`, args } } });
  try {
   const first = await h.host.handle(h.claim, request('fixture-operation'));
   const spec = operationSpec(`calendars.${verb}`)!;
   assert.equal((first.result as { isError?: boolean })?.isError, undefined, JSON.stringify(first));
   if (spec.risk !== 'R') {
    assert.equal((first.result as { structuredContent: { outcome: string } }).structuredContent.outcome, 'applied');
    assert.equal(h.writes(), 1);
    assert.deepEqual(await h.host.handle(h.claim, request('fixture-operation')), first);
    assert.equal(h.writes(), 1);
   }
   assert.equal(h.api.unexpected.length, 0);
   results.push({ operation: spec.id, result: first, writes: h.writes(), journaledReplay: spec.risk !== 'R' });
   if (verb === 'appointment.reschedule') {
    h.api.first('PUT', /^\/calendars\/events\/appointments\/event_1$/, { status: 200, body: { ...h.event, contactId: 'foreign' } });
    const conflict = await h.host.handle(h.claim, request('fixture-conflict'));
    assert.equal((conflict.result as { structuredContent: { outcome: string } }).structuredContent.outcome, 'outcome_unknown');
    assert.deepEqual(await h.host.handle(h.claim, request('fixture-conflict')), conflict);
    assert.equal(h.writes(), 2);
    results.push({ case: 'wrong parent withheld and durable RPC replay sends nothing', result: conflict, writes: 1 });
   }
  } finally { h.stop(); }
 }
 return results;
}
