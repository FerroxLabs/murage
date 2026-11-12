// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixtureFamilyLevels } from './testing/family-grants.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HighLevelHost, type HighLevelHostDeps } from './host.ts';
import { HighLevelActions } from './actions.ts';
import { createPreflightRequester } from './client.ts';
import { operationSpec } from './operations/registry.ts';
import { FileActionJournal } from './journal-file.ts';
import { FileRpcApprovalJournal } from './rpc-approval-replay.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { forgetAllTurnMarks } from '../email/external-marks.ts';
import { removeTempDir } from '../testing/cleanup.ts';

const dirs: string[] = [], stops: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks(); forgetAllTurnMarks();
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});
function fixture() {
  const h = highLevelHarness(); stops.push(h.stop);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
    grants: [{ ...h.grant(), families: fixtureFamilyLevels({ contacts: 'full' }) }] } as typeof h.bot.highlevelAccess;
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-review-')); dirs.push(dir);
  const journal = new FileActionJournal(join(dir, 'actions.jsonl'));
  const actions = new HighLevelActions({ journal });
  const approvals = new FileRpcApprovalJournal(join(dir, 'approvals'));
  const calls = new FileRpcApprovalJournal(join(dir, 'calls'));
  const deps: HighLevelHostDeps = { ...h, actions, approvalJournal: approvals, callJournal: calls, bot: () => h.bot,
    operationScopes: () => ['contacts.readonly', 'contacts.write'],
    approvalBasis: (_claim, spec) => spec.risk === 'D' ? 'owner_no_limits_attended' : 'owner_no_limits' };
  const host = new HighLevelHost(deps);
  const rpc = (operation: string, args: object, target = host) => target.handle(h.claim,
    { jsonrpc: '2.0', id: 'boundary-rpc', method: 'tools/call',
      params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation, args } } });
  return { ...h, dir, journal, actions, approvals, calls, deps, rpc };
}

for (const operation of ['create', 'upsert']) for (const args of [
  { firstName: 'Reviewed', email: 'reviewed@fixture.test' }, { firstName: 'Reviewed' },
]) it(`${operation}: populated location does not gate dispatch on a complete contact census (${Object.keys(args)})`, async () => {
  const h = fixture();
  h.api.always('POST', /^\/contacts\/search$/, req => {
    const body = req.body as { page: number; filters?: unknown; query?: string };
    if (body.filters || body.query) return { status: 200, body: { contacts: [], total: 0 } };
    return { status: 200, body: { contacts: Array.from({ length: 50 }, (_, i) => ({
      id: `old_${body.page}_${i}`, locationId: FAKE_LOCATION_ID,
    })), total: 10000 } };
  });
  const path = operation === 'create' ? '/contacts/' : '/contacts/upsert';
  h.api.always('POST', new RegExp(`^${path}$`), { status: 200, body: {
    new: true, contact: { id: 'new_contact', locationId: FAKE_LOCATION_ID, ...args },
  } });
  const result = await h.rpc(`contacts.${operation}`, args);
  expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(h.api.calls('POST', new RegExp(`^${path}$`))).toHaveLength(1);
  const lookups = h.api.calls('POST', /^\/contacts\/search$/);
  expect(lookups.length).toBeLessThanOrEqual(1);
  expect(lookups.every(req => {
    const body = req.body as { filters?: unknown; query?: string };
    return !!(body.filters || body.query);
  })).toBe(true);
  expect(h.api.unexpected).toEqual([]);
});

for (const count of [5, 6, 100, 101, 500, 501]) it(`bulk tags: host accepts exactly the advertised boundary (${count}) with bounded reads`, async () => {
  const h = fixture();
  const contacts = Array.from({ length: count }, (_, i) => `contact_${i}`);
  h.api.always('GET', /^\/contacts\/contact_\d+$/, req => ({ status: 200, body: {
    contact: { id: req.path.split('/')[2], locationId: FAKE_LOCATION_ID, tags: ['keep'] },
  } }));
  h.api.always('POST', /^\/contacts\/bulk\/tags\/update\/add$/, { status: 200,
    body: { succeeded: true, errorCount: 0, contacts } });
  const result = await h.rpc('contacts.tags.bulk', { contacts, type: 'add', tags: ['a'] });
  if (count <= 500) {
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(h.api.calls('GET')).toHaveLength(count);
    expect(h.api.calls('POST')).toHaveLength(1);
  } else {
    expect(result.result).toMatchObject({ isError: true });
    expect(h.api.requests).toHaveLength(0);
  }
  expect(h.api.unexpected).toEqual([]);
});

it('bulk tags: a foreign final target prevents review and dispatch', async () => {
  const h = fixture();
  h.api.always('GET', /^\/contacts\/contact_\d+$/, req => ({ status: 200, body: {
    contact: { id: req.path.split('/')[2], locationId: req.path.endsWith('_499') ? 'foreign' : FAKE_LOCATION_ID, tags: [] },
  } }));
  const result = await h.rpc('contacts.tags.bulk', {
    contacts: Array.from({ length: 500 }, (_, i) => `contact_${i}`), type: 'add', tags: ['a'],
  });
  expect(result.result).toMatchObject({ isError: true });
  expect(h.api.calls('GET')).toHaveLength(500);
  expect(h.api.calls('POST')).toHaveLength(0);
  expect(h.journal.all()).toHaveLength(0);
});

for (const operation of ['create', 'upsert']) for (const selector of ['email', 'phone', 'long-name', 'crowded']) {
  it(`${operation}: bounded recovery preparation tolerates ${selector} and never resends after a crash`, async () => {
    const h = fixture();
    const args = selector === 'email' ? { firstName: 'Reviewed', email: 'reviewed@fixture.test' }
      : selector === 'phone' ? { firstName: 'Reviewed', phone: '+15550000001' }
      : { firstName: selector === 'long-name' ? 'N'.repeat(200) : 'Reviewed' };
    let sent = false, crashed = false;
    h.api.always('POST', /^\/contacts\/search$/, req => {
      const body = req.body as { filters?: Array<{ field: string; operator: string; value: unknown }>; query?: string };
      if (selector === 'email' || selector === 'phone') expect(body.filters).toEqual([
        { field: selector, operator: 'eq', value: args[selector as keyof typeof args] },
      ]);
      else expect(body.query).toBe('Reviewed');
      const contacts = selector === 'crowded' ? Array.from({ length: 50 }, (_, i) => ({ id: `old_${i}`, locationId: FAKE_LOCATION_ID }))
        : sent ? [{ id: 'new_contact', locationId: FAKE_LOCATION_ID, ...args }] : [];
      return { status: 200, body: { contacts, total: selector === 'crowded' ? 10000 : contacts.length } };
    });
    const path = operation === 'create' ? '/contacts/' : '/contacts/upsert';
    h.api.always('POST', new RegExp(`^${path}$`), () => {
      sent = true;
      return { status: 200, body: { new: true, contact: { id: 'new_contact', locationId: FAKE_LOCATION_ID, ...args } } };
    });
    const put = h.journal.put.bind(h.journal);
    vi.spyOn(h.journal, 'put').mockImplementation(row => { if (crashed) throw new Error('process lost'); put(row); });
    const settle = h.approvals.settle.bind(h.approvals);
    vi.spyOn(h.approvals, 'settle').mockImplementation((...a) => {
      if (a[0].startsWith('contact-recovery:')) return settle(...a);
      crashed = true; throw new Error('process lost before settlement');
    });
    await h.rpc(`contacts.${operation}`, args);
    expect(sent).toBe(true); expect(crashed).toBe(true);
    const [original] = new FileActionJournal(join(h.dir, 'actions.jsonl')).all();
    const metadata = h.approvals.get(`contact-recovery:${original.approvalId}`);
    expect(JSON.stringify(metadata)).not.toContain('Reviewed');
    expect(JSON.stringify(metadata)).not.toContain('fixture.test');
    const before = h.api.requests.length;
    const actions = new HighLevelActions({ journal: new FileActionJournal(join(h.dir, 'actions.jsonl')) }); actions.recover();
    const host = new HighLevelHost({ ...h.deps, actions, approvalJournal: new FileRpcApprovalJournal(join(h.dir, 'approvals')),
      callJournal: new FileRpcApprovalJournal(join(h.dir, 'calls')) });
    const result = await h.rpc(`contacts.${operation}`, args, host);
    expect(result.result).toMatchObject({ structuredContent: {
      outcome: selector === 'email' || selector === 'phone' ? 'applied' : 'outcome_unknown',
    } });
    expect(h.api.requests.length - before).toBe(selector === 'email' || selector === 'phone' ? 1 : 0);
    expect(await h.rpc(`contacts.${operation}`, args, host)).toEqual(result);
    expect(h.api.calls('POST', new RegExp(`^${path}$`))).toHaveLength(1);
    expect(h.api.calls('POST', /^\/contacts\/search$/).length).toBeLessThanOrEqual(2);
  });
}

it('bulk tags: all 500 targets survive durable approval replay with bounded reads and no resend', async () => {
  const h = fixture();
  const contacts = Array.from({ length: 500 }, (_, i) => `contact_${i}`);
  let sent = false, crashed = false;
  h.api.always('GET', /^\/contacts\/contact_\d+$/, req => ({ status: 200, body: {
    contact: { id: req.path.split('/')[2], locationId: FAKE_LOCATION_ID, tags: sent ? ['keep', 'a'] : ['keep'] },
  } }));
  h.api.always('POST', /^\/contacts\/bulk\/tags\/update\/add$/, () => {
    sent = true; return { status: 200, body: { succeeded: true, errorCount: 0, contacts } };
  });
  const put = h.journal.put.bind(h.journal);
  vi.spyOn(h.journal, 'put').mockImplementation(row => { if (crashed) throw new Error('process lost'); put(row); });
  const settle = h.approvals.settle.bind(h.approvals);
  vi.spyOn(h.approvals, 'settle').mockImplementation((...a) => {
    if (a[0].startsWith('contact-recovery:')) return settle(...a);
    crashed = true; throw new Error('process lost before settlement');
  });
  const args = { contacts, type: 'add', tags: ['a'] };
  await h.rpc('contacts.tags.bulk', args);
  expect(crashed).toBe(true);
  expect(h.api.calls('GET')).toHaveLength(500);
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(h.dir, 'actions.jsonl')) }); actions.recover();
  const host = new HighLevelHost({ ...h.deps, actions, approvalJournal: new FileRpcApprovalJournal(join(h.dir, 'approvals')),
    callJournal: new FileRpcApprovalJournal(join(h.dir, 'calls')) });
  const result = await h.rpc('contacts.tags.bulk', args, host);
  expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(h.api.calls('GET')).toHaveLength(1000);
  expect(await h.rpc('contacts.tags.bulk', args, host)).toEqual(result);
  expect(h.api.calls('GET')).toHaveLength(1000);
  expect(h.api.calls('POST')).toHaveLength(1);
}, 30_000);


it('bulk preflight is restricted to the validated targets; other operations keep five reads', async () => {
  const h = fixture();
  const connection = await h.leases.connection('hl_conn_1');
  const ctx = { connection: connection!, signal: new AbortController().signal, assertActive: vi.fn() };
  h.api.always('GET', /^\/contacts\/contact_\d+$/, req => ({ status: 200, body: {
    contact: { id: req.path.split('/')[2], locationId: FAKE_LOCATION_ID, tags: [] },
  } }));
  const pre = createPreflightRequester(h.client, ctx, operationSpec('contacts.tags.bulk')!, undefined,
    { contacts: ['contact_0'], type: 'add', tags: ['a'] });
  const read = () => pre.read('contacts.get', { path: '/contacts/contact_0' });
  const first = await read() as { contact: { tags: string[] } };
  first.contact.tags.push('mutated');
  expect(await read()).toMatchObject({ contact: { tags: [] } });
  await expect(pre.read('contacts.get', { path: '/contacts/contact_1' })).rejects.toThrow();
  await expect(pre.read('contacts.get', { path: '/contacts/contact_0', query: {} })).rejects.toThrow();
  expect(h.api.requests).toHaveLength(1);
  const ordinary = createPreflightRequester(h.client, ctx, operationSpec('contacts.tags.add')!);
  for (let i = 0; i < 5; i++) await ordinary.read('contacts.get', { path: '/contacts/contact_0' });
  await expect(ordinary.read('contacts.get', { path: '/contacts/contact_0' })).rejects.toThrow();
  expect(h.api.requests).toHaveLength(6);
});

const uncertainPages = [
  ['conflicting totals', { total: 0, meta: { total: 1 } }],
  ['invalid secondary total', { total: 0, meta: { total: '0' } }],
  ['top-level next page', { total: 0, nextPage: 2 }],
  ['top-level next URL', { total: 0, nextPageUrl: '/contacts/search?page=2' }],
  ['top-level next', { total: 0, next: 'cursor' }],
  ['nested next page', { total: 0, meta: { total: 0, nextPage: 2 } }],
  ['nested next URL', { total: 0, meta: { total: 0, nextPageUrl: '/contacts/search?page=2' } }],
  ['nested next', { total: 0, meta: { total: 0, next: 'cursor' } }],
] as const;
for (const operation of ['create', 'upsert']) for (const stage of ['preparation', 'reconciliation']) {
  for (const [label, pagination] of uncertainPages) {
    it(`${operation}: ${label} during ${stage} leaves crash recovery unknown with zero resends`, async () => {
      const h = fixture(), args = { firstName: 'Reviewed', email: 'reviewed@fixture.test' };
      let crashed = false;
      h.api.always('POST', /^\/contacts\/search$/, () => ({ status: 200, body: {
        contacts: [], ...(crashed === (stage === 'reconciliation') ? pagination : { total: 0 }),
      } }));
      const path = operation === 'create' ? '/contacts/' : '/contacts/upsert';
      h.api.always('POST', new RegExp(`^${path}$`), { status: 200, body: {
        new: true, contact: { id: 'new_contact', locationId: FAKE_LOCATION_ID, ...args },
      } });
      const put = h.journal.put.bind(h.journal);
      vi.spyOn(h.journal, 'put').mockImplementation(row => { if (crashed) throw new Error('process lost'); put(row); });
      const settle = h.approvals.settle.bind(h.approvals);
      vi.spyOn(h.approvals, 'settle').mockImplementation((...a) => {
        if (a[0].startsWith('contact-recovery:')) return settle(...a);
        crashed = true; throw new Error('process lost before settlement');
      });
      await h.rpc(`contacts.${operation}`, args);
      expect(crashed).toBe(true);
      expect(h.api.calls('POST', new RegExp(`^${path}$`))).toHaveLength(1);
      const journal = new FileActionJournal(join(h.dir, 'actions.jsonl'));
      const actions = new HighLevelActions({ journal }); actions.recover();
      const approvals = new FileRpcApprovalJournal(join(h.dir, 'approvals'));
      const host = new HighLevelHost({ ...h.deps, actions, approvalJournal: approvals,
        callJournal: new FileRpcApprovalJournal(join(h.dir, 'calls')) });
      const before = h.api.requests.length;
      const result = await h.rpc(`contacts.${operation}`, args, host);
      expect(result.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
      expect(journal.all()[0].phase).toBe('outcome_unknown');
      expect(approvals.get(journal.all()[0].approvalId!)).toMatchObject({ state: 'conflict', reason: 'unconfirmed' });
      expect(h.api.requests.length - before).toBe(stage === 'preparation' ? 0 : 1);
      expect(await h.rpc(`contacts.${operation}`, args, host)).toEqual(result);
      expect(h.api.calls('POST', new RegExp(`^${path}$`))).toHaveLength(1);
      expect(h.api.unexpected).toEqual([]);
    });
  }
}
