// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryFixture, pipelineArgs } from './testing/c2-recovery-fixture.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { boundedRecoveryLookup, RECOVERY_PAGE_CAP, RECOVERY_PAGE_LIMIT, RECOVERY_WINDOW_MS } from './write-recovery.ts';

const dirs: string[] = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'hlc2-bounded-')); dirs.push(dir); return dir; };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });
const args = { firstName: 'Reviewed', email: 'reviewed@example.test' };

const unpaginatedCases = [
  { operation: 'opportunities.pipelines.create', args: pipelineArgs, collection: 'pipelines', path: '/opportunities/pipelines',
    record: { id: 'new_1', ...pipelineArgs, stages: [{ id: 'stage_1', ...pipelineArgs.stages[0] }] } },
  { operation: 'contacts.notes.create', args: { contactId: 'contact_1', body: 'Reviewed note' }, collection: 'notes', path: '/contacts/contact_1/notes',
    record: { id: 'new_1', contactId: 'contact_1', body: 'Reviewed note' } },
  { operation: 'contacts.tasks.create', args: { contactId: 'contact_1', title: 'Reviewed task', dueDate: '2026-12-01T00:00:00Z', completed: false },
    collection: 'tasks', path: '/contacts/contact_1/tasks',
    record: { id: 'new_1', contactId: 'contact_1', title: 'Reviewed task', dueDate: '2026-12-01T00:00:00Z', completed: false } },
];
for (const scenario of unpaginatedCases) {
  it.each([0, 1, 51, 101, 100_000])('unpaginated replay refuses an unsupported whole-collection read: ' + scenario.collection + ' with %i records', async count => {
    const dir = directory(), f = recoveryFixture(dir, scenario.operation, scenario.args);
    const path = new RegExp(`^${scenario.path}$`);
    const reply = scenario.collection === 'pipelines' ? scenario.record : { [scenario.collection.slice(0, -1)]: scenario.record };
    f.api.always('POST', path, { status: 200, body: reply });
    vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
    try {
      await f.call();
      expect(f.reviews).toHaveLength(1);
      expect(f.api.calls('POST', path)).toHaveLength(1);
      expect(f.api.calls('GET', path)).toHaveLength(0);
    } finally { f.stop(); }
    const restarted = recoveryFixture(dir, scenario.operation, scenario.args); restarted.actions.recover();
    // The fake can return an unpaginated populated collection containing one
    // exact recent witness. Even downloading it exceeds the adapter's contract.
    const wholeCollection = vi.fn(() => ({ status: 200, body: { [scenario.collection]: Array.from({ length: count }, (_, i) =>
      i === 0 ? { ...scenario.record, createdAt: Date.now() + 1 } : { id: `old_${i}`, createdAt: 1 }) } }));
    restarted.api.always('GET', path, wholeCollection);
    const begin = vi.spyOn(restarted.actions, 'beginDispatch');
    try {
      const first = await restarted.call();
      expect(first.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
      expect(await restarted.call()).toEqual(first);
      expect(wholeCollection).not.toHaveBeenCalled();
      expect(restarted.api.requests).toHaveLength(0);
      expect(begin).not.toHaveBeenCalled();
      expect(restarted.reviews).toHaveLength(0);
    } finally { restarted.stop(); }
  });
}

it.each([0, 51, 101, 100_000])('creates a contact with %i existing records without a collection snapshot', async count => {
  const f = recoveryFixture(directory(), 'contacts.create', args);
  f.api.always('POST', /^\/contacts\/search$/, { status: 200, body: {
    contacts: Array.from({ length: Math.min(count, 50) }, (_, i) => ({ id: `old_${i}`, firstName: 'Other' })),
    total: count, ...(count > 50 ? { nextPage: 2 } : {}),
  } });
  f.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_1', ...args } } });
  try {
    expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(f.reviews).toHaveLength(1);
    expect(f.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1);
    expect(f.api.calls('POST', /^\/contacts\/search$/)).toHaveLength(0);
  } finally { f.stop(); }
});

it('an unpaginated primary-ID replay stays unknown without reading the collection', async () => {
  const dir = directory(), f = recoveryFixture(dir, 'opportunities.pipelines.delete');
  f.api.always('DELETE', /^\/opportunities\/pipelines\/pipe_A$/, { status: 200, body: { success: true } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls('DELETE')).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, 'opportunities.pipelines.delete'); restarted.actions.recover();
  restarted.api.always('GET', /^\/opportunities\/pipelines$/, { status: 200, body: { pipelines: [{ id: 'other_1' }, { id: 'pipe_A' }], total: 100_000, nextPage: 2 } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(restarted.api.requests).toHaveLength(0);
  } finally { restarted.stop(); }
});

it('a crash in a populated location recovers only recent exact candidates, never resends', async () => {
  const dir = directory(), f = recoveryFixture(dir, 'contacts.create', args);
  f.api.always('POST', /^\/contacts\/search$/, { status: 200, body: { contacts: [], total: 100_000, nextPage: 2 } });
  f.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_1', ...args } } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1); f.stop();
  const journalDir = join(dir, 'approvals', 'recovery');
  const durable = readdirSync(journalDir).map(file => readFileSync(join(journalDir, file), 'utf8')).join('\n');
  expect(durable).not.toContain(args.email); expect(durable).not.toContain(args.firstName);
  const restarted = recoveryFixture(dir, 'contacts.create', args); restarted.actions.recover();
  restarted.api.always('POST', /^\/contacts\/search$/, request => {
    expect(request.body).toMatchObject({ filters: [{ field: 'email', operator: 'eq', value: args.email }], pageLimit: 50 });
    return { status: 200, body: { contacts: [{ id: 'new_1', ...args, dateAdded: new Date().toISOString() }], total: 1 } };
  });
  try {
    const result = await restarted.call();
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(await restarted.call()).toEqual(result);
    expect(restarted.api.calls('POST', /^\/contacts\/$/)).toHaveLength(0);
    expect(restarted.api.calls('POST', /^\/contacts\/search$/)).toHaveLength(1);
  } finally { restarted.stop(); }
});

const after = Date.parse('2026-01-01T00:00:00Z');
const candidate = { id: 'new_1', ...args, createdAt: after + 1000, reference: 'approved_ref' };
const exact = (record: Record<string, unknown>) => record.email === undefined || record.firstName === undefined ? undefined
  : record.email === args.email && record.firstName === args.firstName;
const lookup = (read: (page: number, limit: number) => Promise<unknown>) => boundedRecoveryLookup({
  collection: 'contacts', scope: { kind: 'window', after, before: after + RECOVERY_WINDOW_MS },
  exactIdentity: exact, createdAt: record => record.createdAt, read,
});

it('generic helper accepts a unique primary-ID witness from a qualified partial lookup', async () => {
  expect(await boundedRecoveryLookup({ collection: 'contacts', scope: { kind: 'reference', field: 'id', value: candidate.id },
    uniquePrimaryId: true, exactIdentity: exact, read: async () => ({ contacts: [{ id: 'other_1' }, candidate], total: 100_000, nextPage: 2 }),
  })).toMatchObject({ status: 'matched', record: candidate });
});

it('generic helper recovers by an exact provider reference without a creation timestamp', async () => {
  const read = vi.fn(async () => ({ contacts: [{ ...candidate, createdAt: undefined }], total: 1 }));
  const result = await boundedRecoveryLookup({ collection: 'contacts', scope: { kind: 'reference', field: 'reference', value: 'approved_ref' }, exactIdentity: exact, read });
  expect(result.status).toBe('matched');
  expect(read).toHaveBeenCalledWith(1, 50, { kind: 'reference', field: 'reference', value: 'approved_ref' });
});

it('generic helper rejects a different provider reference', async () => {
  expect(await boundedRecoveryLookup({ collection: 'contacts', scope: { kind: 'reference', field: 'reference', value: 'different_ref' }, exactIdentity: exact,
    read: async () => ({ contacts: [candidate], total: 1 }) })).toEqual({ status: 'outcome_unknown' });
});

it('bounded recent exact lookup consumes only scoped candidates', async () => {
  // The operation adapter/provider narrows the location before the generic helper sees candidates.
  const read = vi.fn(async () => ({ contacts: [candidate], total: 1 }));
  expect((await lookup(read)).status).toBe('matched');
  expect(read).toHaveBeenCalledTimes(1);
});

it('fixed page cap refuses a matching first page if the scoped result remains incomplete', async () => {
  const read = vi.fn(async (page: number) => ({ contacts: Array.from({ length: RECOVERY_PAGE_LIMIT }, (_, i) => ({
    ...candidate, id: `page_${page}_${i}`, email: i === 0 && page === 1 ? args.email : 'other@example.test',
  })), total: 100_000, nextPage: page + 1 }));
  expect(await lookup(read)).toEqual({ status: 'outcome_unknown' });
  expect(read).toHaveBeenCalledTimes(RECOVERY_PAGE_CAP);
});

it('bounded pagination can find a unique exact candidate on the last permitted page', async () => {
  const read = vi.fn(async (page: number) => ({ contacts: Array.from({ length: page === 3 ? 1 : 50 }, (_, i) => ({
    ...candidate, id: `page_${page}_${i}`, email: page === 3 ? args.email : 'other@example.test',
  })), total: 101, ...(page < 3 ? { nextPage: page + 1 } : {}) }));
  expect((await lookup(read)).status).toBe('matched'); expect(read).toHaveBeenCalledTimes(3);
});

it.each([
  ['missing timestamp', { contacts: [{ ...candidate, createdAt: undefined }], total: 1 }, 'outcome_unknown'],
  ['old identity', { contacts: [{ ...candidate, createdAt: after - 1 }], total: 1 }, 'outcome_unknown'],
  ['at journal time', { contacts: [{ ...candidate, createdAt: after }], total: 1 }, 'outcome_unknown'],
  ['outside narrow window', { contacts: [{ ...candidate, createdAt: after + RECOVERY_WINDOW_MS + 1 }], total: 1 }, 'outcome_unknown'],
  ['wrong exact identity', { contacts: [{ ...candidate, email: 'other@example.test' }], total: 1 }, 'absent'],
  ['missing identity', { contacts: [{ id: 'new_1' }], total: 1 }, 'outcome_unknown'],
  ['ambiguous identity', { contacts: [candidate, { ...candidate, id: 'new_2' }], total: 2 }, 'outcome_unknown'],
  ['duplicate ID', { contacts: [candidate, candidate], total: 2 }, 'outcome_unknown'],
  ['conflicting totals', { contacts: [candidate], total: 1, meta: { total: 2 } }, 'outcome_unknown'],
  ['continuation without total', { contacts: [candidate], nextCursor: 'untrusted' }, 'outcome_unknown'],
  ['empty incomplete page', { contacts: [], total: 2, nextPage: 2 }, 'outcome_unknown'],
  ['malformed meta', { contacts: [candidate], total: 1, meta: 'bad' }, 'outcome_unknown'],
  ['oversized page', { contacts: Array.from({ length: 51 }, (_, i) => ({ ...candidate, id: `new_${i}` })), total: 51 }, 'outcome_unknown'],
] as const)('generic helper handles %s conservatively', async (_name, raw, status) => {
  expect((await lookup(async () => raw)).status).toBe(status);
});

it('transport errors remain unknown', async () => {
  expect(await lookup(async () => { throw new Error('offline'); })).toEqual({ status: 'outcome_unknown' });
});

it.each(['missing timestamp', 'ambiguous', 'truncated', 'foreign location', 'wrong replay identity'])('host crash recovery stays unknown with zero resends: %s', async scenario => {
  const dir = directory(), f = recoveryFixture(dir, 'contacts.create', args);
  f.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_1', ...args } } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before settlement'); });
  await f.call(); expect(f.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1); f.stop();
  const restarted = recoveryFixture(dir, 'contacts.create', scenario === 'wrong replay identity' ? { ...args, email: 'different@example.test' } : args);
  restarted.actions.recover();
  const record = { id: 'new_1', ...args, ...(scenario === 'missing timestamp' ? {} : { dateAdded: new Date().toISOString() }) };
  restarted.api.always('POST', /^\/contacts\/search$/, { status: 200, body: {
    contacts: scenario === 'ambiguous' ? [record, { ...record, id: 'new_2' }] : [record],
    total: scenario === 'ambiguous' ? 2 : scenario === 'truncated' ? 100_000 : 1,
    ...(scenario === 'truncated' ? { nextPage: 2 } : {}), ...(scenario === 'foreign location' ? { locationId: 'foreign' } : {}),
  } });
  try {
    expect((await restarted.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(restarted.api.calls('POST', /^\/contacts\/$/)).toHaveLength(0);
    expect(restarted.api.calls('POST', /^\/contacts\/search$/).length).toBeLessThanOrEqual(RECOVERY_PAGE_CAP);
  } finally { restarted.stop(); }
});
