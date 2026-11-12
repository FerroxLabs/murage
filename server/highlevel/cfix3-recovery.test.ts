// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryFixture, pipelineArgs } from './testing/c2-recovery-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); vi.restoreAllMocks(); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'hlc2-f024-')); dirs.push(dir); return dir; };
it.each(['contacts.tags.add', 'contacts.tags.remove'])('F024 preserves %s tags-only confirmation', async operation => {
  const f = recoveryFixture(directory(), operation);
  f.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', tags: operation.endsWith('add') ? [] : ['a'] } } });
  f.api.always(f.spec.endpoint.method, /^\/contacts\/contact_1\/tags$/, { status: 200, body: { tags: operation.endsWith('add') ? ['a'] : [] } });
  try { expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } }); }
  finally { f.stop(); }
});
it.each([true, false])('F024 host pipeline crash after POST accepted=%s: unsupported lookup, no resend', async accepted => {
  const dir = directory();
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/highlevel/testing/c2-recovery-crash-worker.ts', dir, 'opportunities.pipelines.create', String(accepted)], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  expect(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), stderr).toBe(24);
  expect(JSON.parse(readFileSync(join(dir, 'provider.json'), 'utf8')).posts).toBe(1);
  const f = recoveryFixture(dir); f.actions.recover();
  f.api.always('GET', /^\/opportunities\/pipelines$/, request => {
    expect(request.query.get('locationId')).toBe('loc_fixture_01');
    return { status: 200, body: { pipelines: accepted ? [{ id: 'created_1', createdAt: Date.now(), ...pipelineArgs, stages: [{ id: 'new_stage_1', ...pipelineArgs.stages[0] }] }] : [] } };
  });
  const begin = vi.spyOn(f.actions, 'beginDispatch');
  try {
    const first = await f.call();
    expect(first.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(f.api.calls('GET')).toHaveLength(0);
    expect(await f.call()).toEqual(first);
    expect(f.api.calls('GET')).toHaveLength(0); expect(f.api.calls('POST')).toHaveLength(0);
    expect(begin).not.toHaveBeenCalled(); expect(f.reviews).toHaveLength(0);
  } finally { f.stop(); }
});
it('F024 approved zero-attempt write retains read-only recovery eligibility', async () => {
  // Exercise the crash window by retaining the real proposed action before dispatch.
  const f = recoveryFixture(directory());
  vi.spyOn(f.actions, 'awaitDecision').mockImplementation(async () => {
    f.actions.recover();
    return 'denied';
  });
  f.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [] } });
  try { await f.call(); expect(f.actions.get(f.reviews[0]!.actionId)).toMatchObject({ phase: 'outcome_unknown', dispatchAttempts: 0 }); } finally { f.stop(); }
});

it('F024 location-scoped upsert recovers the approved body ID with one GET', async () => {
  const dir = directory();
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/highlevel/testing/c2-recovery-crash-worker.ts', dir, 'opportunities.upsert', 'true'], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  expect(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), stderr).toBe(24);
  const f = recoveryFixture(dir, 'opportunities.upsert'); f.actions.recover();
  f.api.always('GET', /^\/opportunities\/opp_A$/, { status: 200, body: { opportunity: { id: 'opp_A', pipelineId: 'pipe_A', name: 'Reviewed', status: 'open', followers: [], locationId: 'loc_fixture_01' } } });
  try {
    const first = await f.call();
    expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(f.api.calls('GET')).toHaveLength(1); expect(f.api.calls('POST')).toHaveLength(0);
    expect(await f.call()).toEqual(first); expect(f.api.calls('GET')).toHaveLength(1);
  } finally { f.stop(); }
});

it.each(['contacts.tags.add', 'contacts.tags.remove'])('F024 %s recovery compares the saved whole tag set', async operation => {
  const dir = directory(), before = operation.endsWith('add') ? [] : ['a'];
  const after = operation.endsWith('add') ? ['a'] : [];
  const f = recoveryFixture(dir, operation);
  f.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', tags: before } } });
  f.api.always(f.spec.endpoint.method, /^\/contacts\/contact_1\/tags$/, { status: 200, body: { tags: after } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, operation); restarted.actions.recover();
  restarted.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', tags: after } } });
  try {
    const first = await restarted.call();
    expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(await restarted.call()).toEqual(first);
    expect(restarted.api.requests.map(r => [r.method, r.path])).toEqual([['GET', '/contacts/contact_1']]);
  } finally { restarted.stop(); }
});

const pipelineResult = { id: 'new_1', ...pipelineArgs, stages: [{ id: 'stage_1', ...pipelineArgs.stages[0] }] };
it.each([
  ['wrong name', { pipelines: [{ id: 'new_1', name: 'Other', stages: pipelineArgs.stages }] }, 'outcome_unknown'],
  ['wrong position', { pipelines: [{ id: 'new_1', name: pipelineArgs.name, stages: [{ ...pipelineArgs.stages[0], position: 1 }] }] }, 'outcome_unknown'],
  ['missing stages', { pipelines: [{ id: 'new_1', name: pipelineArgs.name }] }, 'outcome_unknown'],
  ['ambiguous', { pipelines: [pipelineResult, { ...pipelineResult, id: 'new_2' }] }, 'outcome_unknown'],
  ['pagination', { pipelines: [], nextCursor: 'more' }, 'outcome_unknown'],
  ['hidden foreign identity', { pipelines: [{ ...pipelineResult, nested: [{ locationId: 'foreign' }] }] }, 'outcome_unknown'],
  ['envelope foreign identity', { locationId: 'foreign', pipelines: [{ ...pipelineResult, locationId: 'loc_fixture_01' }] }, 'outcome_unknown'],
  ['empty foreign envelope', { locationId: 'foreign', pipelines: [] }, 'outcome_unknown'],
  ['review recoveryEnvelope collision', { pipelines: [{ ...pipelineResult, recoveryEnvelope: { succeeded: false } }] }, 'outcome_unknown'],
  ['review nonmatching foreign member', { pipelines: [pipelineResult, { ...pipelineResult, id: 'other_pipeline', name: 'Other', hidden: [{ locationId: 'foreign' }] }] }, 'outcome_unknown'],
  ['negative confirmation', { pipelines: [pipelineResult], detail: [{ succeeded: false }] }, 'outcome_unknown'],
] as const)('F024 collection recovery refuses unsupported evidence: %s', async (_name, response, outcome) => {
  const dir = directory(), f = recoveryFixture(dir);
  f.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [] } });
  f.api.always('POST', /^\/opportunities\/pipelines$/, { status: 200, body: pipelineResult });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir); restarted.actions.recover();
  restarted.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { ...response, pipelines: response.pipelines.map(record => ({ ...record, createdAt: Date.now() })) } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome } });
    expect(restarted.api.calls('GET')).toHaveLength(0); expect(restarted.api.calls('POST')).toHaveLength(0);
  } finally { restarted.stop(); }
});

it.each([true, false])('F024 pipeline deletion recovery refuses an unbounded lookup, absent=%s', async absent => {
  const dir = directory(), f = recoveryFixture(dir, 'opportunities.pipelines.delete');
  f.api.always('DELETE', /^\/opportunities\/pipelines\/pipe_A$/, { status: 200, body: { success: true } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, 'opportunities.pipelines.delete'); restarted.actions.recover();
  restarted.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: absent ? [] : [{ id: 'pipe_A' }] } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(restarted.api.requests).toHaveLength(0);
  } finally { restarted.stop(); }
});
it('F024 nested update recovers the approved parent and child with one GET', async () => {
  const dir = directory(), f = recoveryFixture(dir, 'contacts.notes.update');
  f.api.always('PUT', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body: { note: { id: 'note_1', body: 'Reviewed note' } } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, 'contacts.notes.update'); restarted.actions.recover();
  restarted.api.always('GET', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body: { note: { id: 'note_1', contactId: 'contact_1', body: 'Reviewed note' } } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(restarted.api.requests.map(r => [r.method, r.path])).toEqual([['GET', '/contacts/contact_1/notes/note_1']]);
  } finally { restarted.stop(); }
});

it('F024 a crash before the approval claim recovers the durable plan without sending', async () => {
  const dir = directory();
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/highlevel/testing/c2-recovery-crash-worker.ts', dir, 'opportunities.pipelines.create', 'before-claim'], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  expect(await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), stderr).toBe(24);
  const f = recoveryFixture(dir); f.actions.recover();
  f.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [] } });
  const begin = vi.spyOn(f.actions, 'beginDispatch');
  try {
    expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(f.api.requests).toHaveLength(0);
    expect(begin).not.toHaveBeenCalled();
  } finally { f.stop(); }
});
it('F024 an identical pre-existing pipeline cannot prove this create', async () => {
  const dir = directory(), f = recoveryFixture(dir);
  f.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [pipelineResult] } });
  f.api.always('POST', /^\/opportunities\/pipelines$/, { status: 200, body: pipelineResult });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls('POST')).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir); restarted.actions.recover();
  restarted.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [pipelineResult] } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(restarted.api.requests).toHaveLength(0);
  } finally { restarted.stop(); }
});
it('F024 a record deletion confirms only an authorized 404', async () => {
  const dir = directory(), f = recoveryFixture(dir, 'contacts.delete');
  f.api.always('DELETE', /^\/contacts\/contact_1$/, { status: 200, body: { success: true } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls('DELETE')).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, 'contacts.delete'); restarted.actions.recover();
  restarted.api.always('GET', /^\/contacts\/contact_1$/, { status: 404, body: { message: 'missing' } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(restarted.api.requests.map(r => r.method)).toEqual(['GET']);
  } finally { restarted.stop(); }
});
