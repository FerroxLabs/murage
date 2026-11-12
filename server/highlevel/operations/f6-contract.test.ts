import type { FamilyLevel } from '../../../shared/highlevel.ts';
import { fixtureFamilyLevels } from '../testing/family-grants.ts';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it.each(['location', 'users'])('F6 %s uses frozen preparation, never direct mutation dispatch', family => {
  const source = readFileSync(new URL(`./${family}.ts`, import.meta.url), 'utf8');
  expect(source).not.toMatch(/async run\(/);
  expect(source).toContain('prepareRead');
  expect(source).toContain('preflight: row.preflight');
});

it.each(['customFields', 'customValues', 'tags'])('F6 %s create declares a usable durable recovery plan', async resource => {
  const { operationSpec } = await import('./registry.ts');
  const { HeldRequest } = await import('../held-request.ts');
  const { prepareWriteRecovery, captureRecoveryPreState, compareWriteRecovery } = await import('../write-recovery.ts');
  const op = operationSpec(`location.${resource}.create`)!;
  if (op.risk === 'R') throw new Error('expected mutation');
  const args = { name: 'Reviewed', ...(resource === 'customFields' ? { dataType: 'TEXT' } : resource === 'customValues' ? { value: 'Private value' } : {}) };
  const ctx = { locationId: 'loc1' }, pre = { read: async () => ({ [resource]: [] }) };
  const held = HeldRequest.freeze(op, await op.prepare(pre, args, ctx), ctx);
  expect(() => prepareWriteRecovery(held, 'loc1')).not.toThrow();
  const plan = prepareWriteRecovery(held, 'loc1');
  await captureRecoveryPreState(plan, pre);
  expect(plan.readTargets).toEqual([{ operation: `location.${resource}.list`, path: `/locations/loc1/${resource}` }]);
  expect(compareWriteRecovery(plan, { [resource]: [{ id: 'new1', ...args }] }, op)).toHaveProperty('held');
  for (const flags of [{ nextPage: 'more' }, { meta: { total: 1 } }])
    expect(compareWriteRecovery(plan, { [resource]: [], ...flags }, op)).toEqual({ outcome: { status: 'conflict', reason: 'unconfirmed' } });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { operationSpec } from './registry.ts';
import { HighLevelHost } from '../host.ts';
import { HighLevelActions } from '../actions.ts';
import { FileActionJournal } from '../journal-file.ts';
import { FileRpcApprovalJournal } from '../rpc-approval-replay.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../../testing/fake-highlevel.ts';
import { removeTempDir } from '../../testing/cleanup.ts';
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'f6-replay-')); dirs.push(dir); return dir; };
const writes = ['customFields', 'customValues', 'tags'].flatMap(resource => ['create', 'update', 'delete'].map(verb => `location.${resource}.${verb}`)).concat(['users.update', 'users.delete']);
function callFixture(operation: string, dir: string, level: FamilyLevel = 'full', input?: Record<string, unknown>) {
  const h = highLevelHarness({ deadlineMs: 2000 }), spec = operationSpec(operation)!;
  const access = h.bot.highlevelAccess as any; access.grantsVersion = 2; access.grants[0].families = fixtureFamilyLevels({ location: level, users: level });
  // Explicit family authority does not inherit the legacy operation projection.
  delete access.grants[0].operations?.location; delete access.grants[0].operations?.users;
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
  const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
  const [, familyResource, verbPart] = operation.split('.'), user = operation.startsWith('users.'), verb = user ? familyResource! : verbPart!;
  const resource = user ? 'users' : familyResource!, singular = user ? undefined : resource === 'customFields' ? 'customField' : resource === 'customValues' ? 'customValue' : 'tag';
  const idKey = user ? 'userId' : resource === 'customFields' ? 'fieldId' : resource === 'customValues' ? 'valueId' : 'tagId';
  const args = { ...(verb === 'create' ? {} : { [idKey]: 'record1' }), ...(verb === 'delete' ? {} : user ? { firstName: 'F6_PRIVATE_USER_VALUE' } : { name: 'F6_PRIVATE_NAME_VALUE', ...(resource === 'customFields' && verb === 'create' ? { dataType: 'TEXT' } : resource === 'customValues' ? { value: 'F6_PRIVATE_CUSTOM_VALUE' } : {}) }) };
  const path = user ? '/users/record1' : `/locations/${FAKE_LOCATION_ID}/${resource}${verb === 'create' ? '' : '/record1'}`;
  const effect = { id: 'record1', ...Object.fromEntries(Object.entries(args).filter(([key]) => key !== idKey)), ...(user ? { roles: { type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] } } : { locationId: FAKE_LOCATION_ID }) };
  const response = singular ? { [singular]: effect } : effect;
  if (user) h.api.always('GET', /^\/users\/$/, { status: 200, body: { users: [effect] } });
  const host = new HighLevelHost({ ...h, actions, approvalJournal, bot: () => h.bot, operationSpec,
    operationScopes: () => [...new Set([spec.endpoint.scope, ...spec.preflight.map(id => operationSpec(id)!.endpoint.scope)])],
    onReview: (_claim, review) => { h.reviews.push(review); actions.approve(review.actionId, review.reviewDigest); } });
  const message = { jsonrpc: '2.0', id: 'f6-rpc', method: 'tools/call', params: { name: user ? 'HIGHLEVEL_USERS' : 'HIGHLEVEL_LOCATION', arguments: { operation, args: input ?? args } } };
  return { ...h, actions, approvalJournal, spec, path, effect, response, resource, verb, call: () => host.handle(h.claim, message) };
}
it.each(writes)('F6 journal dispatch and terminal replay: %s', async operation => {
  const f = callFixture(operation, directory());
  f.api.always('GET', new RegExp(`^${f.path}$`), { status: 200, body: f.verb === 'create' ? { [f.resource]: [] } : f.response });
  f.api.always(f.spec.endpoint.method, new RegExp(`^${f.path}$`), { status: 200, body: f.verb === 'delete' ? { succeeded: true } : f.response });
  try {
    const first = await f.call();
    expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1);
    expect(await f.call()).toEqual(first);
    expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1);
    const journal = readFileSync(join(dirs.at(-1)!, 'actions.jsonl'), 'utf8');
    expect(journal).not.toContain('F6_PRIVATE_');
  } finally { f.stop(); }
});
it.each(writes)('F6 crash after send recovers by read without another write: %s', async operation => {
  const dir = directory(), f = callFixture(operation, dir);
  f.api.always('GET', new RegExp(`^${f.path}$`), { status: 200, body: f.verb === 'create' ? { [f.resource]: [] } : f.response });
  f.api.always(f.spec.endpoint.method, new RegExp(`^${f.path}$`), { status: 200, body: f.verb === 'delete' ? { succeeded: true } : f.response });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('fixture process loss after send'); });
  await f.call(); expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1); f.stop();
  const restarted = callFixture(operation, dir); restarted.actions.recover();
  restarted.api.always('GET', new RegExp(`^${f.path}$`), f.verb === 'delete' ? { status: 404, body: {} } : { status: 200, body: f.verb === 'create' ? { [f.resource]: [f.effect] } : f.response });
  try {
    const first = await restarted.call();
    expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(restarted.api.calls('GET')).toHaveLength(1);
    expect(restarted.api.calls(f.spec.endpoint.method)).toHaveLength(0);
    expect(await restarted.call()).toEqual(first);
    expect(restarted.api.calls('GET')).toHaveLength(1);
    expect(restarted.reviews).toHaveLength(0);
  } finally { restarted.stop(); }
});
it.each([['location.tags.create', 'read'], ['location.tags.delete', 'change'], ['users.update', 'change']] as const)('F6 host refuses %s on %s', async (operation, level) => {
  const f = callFixture(operation!, directory(), level);
  try { expect((await f.call()).result).toMatchObject({ isError: true }); expect(f.api.requests).toHaveLength(0); expect(f.reviews).toHaveLength(0); }
  finally { f.stop(); }
});

it('F6 integrated server starts in an isolated fixture and passes explicit-URL Doctor', async () => {
  const { launchVerificationServer, runControlMurage } = await import('../../../scripts/control-murage.ts');
  const { mkdirSync, writeFileSync, copyFileSync } = await import('node:fs');
  const session = await launchVerificationServer(process.env);
  try {
    const commands = ['doctor', '--url', session.info.url];
    const doctor = await runControlMurage(commands, { env: { ...process.env, MURAGE_DATA_DIR: session.info.dataDir } }) as { ok: boolean };
    if (process.env.F6_EVIDENCE_DIR) {
      mkdirSync(process.env.F6_EVIDENCE_DIR, { recursive: true });
      writeFileSync(join(process.env.F6_EVIDENCE_DIR, 'verification.json'), JSON.stringify({ fixture: session.info, commands, doctor }, null, 2));
      copyFileSync(session.info.logPath, join(process.env.F6_EVIDENCE_DIR, 'server.log'));
    }
    expect(doctor.ok).toBe(true);
  } finally { await session.close(); }
}, 60_000);

// These assertions use the real host, guarded preflights, held requests and client.
it('R1 host users.get lists the trusted location before the exact global GET', async () => {
  const f = callFixture('users.get', directory(), 'read', { userId: 'record1' });
  f.api.always('GET', /^\/users\/record1$/, { status: 200, body: f.effect });
  try {
    const result = await f.call();
    expect(result.result).toMatchObject({ structuredContent: { outsideContent: 'highlevel-crm', crm: expect.stringContaining('"id":"record1"') } });
    expect(f.api.requests.map(r => r.path)).toEqual(['/users/', '/users/record1']);
    expect(f.api.requests[0]!.query.get('locationId')).toBe(FAKE_LOCATION_ID);
    expect(f.api.unexpected).toHaveLength(0);
  } finally { f.stop(); }
});
it.each(['users.update', 'users.delete'])('R2 host %s refuses absent membership before global GET or write', async operation => {
  const f = callFixture(operation, directory());
  f.api.first('GET', /^\/users\/$/, { status: 200, body: { users: [] } });
  f.api.always('GET', /^\/users\/record1$/, { status: 200, body: f.effect });
  f.api.always(f.spec.endpoint.method, /^\/users\/record1$/, { status: 200, body: f.response });
  try {
    await f.call();
    expect(f.api.calls('GET', /^\/users\/record1$/)).toHaveLength(0);
    expect(f.api.requests.map(r => r.path)).toEqual(['/users/']);
    expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(0);
    expect(f.reviews).toHaveLength(0);
  } finally { f.stop(); }
});
const membershipCases = ['nextCursor', 'nested continuation', 'nested total', 'duplicate', 'foreign', 'conflicting locations', 'conflicting type'] as const;
it.each(membershipCases)('R3 host refuses %s in membership before global user access', async kind => {
  const f = callFixture('users.update', directory());
  const user: Record<string, unknown> = { ...f.effect };
  if (kind === 'foreign') user.roles = { type: 'account', locationIds: ['other'] };
  if (kind === 'conflicting locations') user.locationIds = ['other'];
  if (kind === 'conflicting type') user.type = 'agency';
  const inventory = { users: kind === 'duplicate' ? [user, user] : [user],
    ...(kind === 'nextCursor' ? { nextCursor: 'more' } : kind === 'nested continuation' ? { meta: { nextPageToken: 'more' } } : kind === 'nested total' ? { meta: { total: 2 } } : {}) };
  f.api.first('GET', /^\/users\/$/, { status: 200, body: inventory });
  f.api.always('GET', /^\/users\/record1$/, { status: 200, body: f.effect });
  f.api.always('PUT', /^\/users\/record1$/, { status: 200, body: f.effect });
  try {
    await f.call();
    expect(f.api.requests.map(r => r.path)).toEqual(['/users/']);
    expect(f.reviews).toHaveLength(0);
  } finally { f.stop(); }
});
it.each(['locationIds', 'type', 'locationId'])('R3 host refuses conflicting %s on the subsequent global user', async key => {
  const f = callFixture('users.update', directory());
  const conflict = { ...f.effect, [key]: key === 'locationIds' ? ['other'] : key === 'type' ? 'agency' : 'other' };
  f.api.always('GET', /^\/users\/record1$/, { status: 200, body: { user: conflict } });
  try {
    await f.call();
    expect(f.api.requests.map(r => r.path)).toEqual(['/users/', '/users/record1']);
    expect(f.api.calls('PUT')).toHaveLength(0);
    expect(f.reviews).toHaveLength(0);
  } finally { f.stop(); }
});
it('R4 host preserves two contact identifiers as the task-search POST array', async () => {
  const args = { contactId: ['contact1', 'contact2'], completed: false };
  const f = callFixture('location.tasks.search', directory(), 'read', args);
  f.api.always('POST', /^\/locations\/[^/]+\/tasks\/search$/, { status: 200, body: { tasks: [{ id: 'task1', locationId: FAKE_LOCATION_ID }] } });
  try {
    expect((await f.call()).result).toMatchObject({ structuredContent: { outsideContent: 'highlevel-crm', crm: expect.stringContaining('"id":"task1"') } });
    expect(f.api.requests).toHaveLength(1);
    expect(f.api.requests[0]).toMatchObject({ method: 'POST', path: `/locations/${FAKE_LOCATION_ID}/tasks/search`, body: args });
    expect(f.api.unexpected).toHaveLength(0);
    expect(f.reviews).toHaveLength(0);
  } finally { f.stop(); }
});
it.each(['contact1', ['contact1', 2], ['contact1', '../other'], ['contact1', '%252f'], ['contact1', 'https://example.invalid'], Array(101).fill('contact1')].map(contactId => ({ contactId })))('R4 host refuses invalid task identifiers %j before provider access', async ({ contactId }) => {
  const f = callFixture('location.tasks.search', directory(), 'read', { contactId });
  try { expect((await f.call()).result).toMatchObject({ isError: true }); expect(f.api.requests).toHaveLength(0); }
  finally { f.stop(); }
});
