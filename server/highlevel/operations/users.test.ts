import './registry.ts';
import { describe, expect, it } from 'vitest';
import { usersOperations, usersDefaultLevel } from './users.ts';
import { f6LevelCovers } from './location.ts';
import { usersRoutes } from '../fake/users.ts';
import { f6Execute, f6FakeRequester, f6Preflight } from '../fake/location.ts';
import { HeldRequest } from '../held-request.ts';
import { freezeOperationSpec } from './registry.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
const ctx = { locationId: 'loc1' }, sentinel = 'F6_USER_PRIVATE_SENTINEL';
const sample = (id: string) => id === 'users.list' ? { locationId: 'loc1' } : id === 'users.update' ? { userId: 'user1', firstName: sentinel, role: 'user', permissions: { contactsEnabled: true } } : { userId: 'user1' };
it('users.everyWriteIsD', () => expect(usersOperations.filter(op => !['users.list', 'users.get'].includes(op.id)).map(op => op.risk)).toEqual(['D', 'D', 'D']));
it('users.offByDefault', () => expect(usersDefaultLevel).toBe('off'));
for (const op of usersOperations) describe(op.id, () => {
  it('retains frozen schemas and exposes preparation without run', () => {
    expect(freezeOperationSpec(op)).toBe(op); expect(op).not.toHaveProperty('run');
    expect(op.endpoint.retry).toBe(op.risk === 'R' ? 'read' : 'write');
  });
  it('requires full control for user mutations and keeps unknown keys out', () => {
    expect(f6LevelCovers('read', op.risk)).toBe(op.risk === 'R');
    expect(f6LevelCovers('change', op.risk)).toBe(op.risk === 'R');
    expect(f6LevelCovers(usersDefaultLevel, op.risk)).toBe(false);
    for (const key of ['url', 'path', 'token', 'password', 'extra']) expect(op.args.safeParse({ ...sample(op.id), [key]: sentinel }).success).toBe(false);
  });
  if (op.id === 'users.create') {
    it('prepares only the non-secret template with trusted company and location', async () => {
      if (op.risk === 'R') throw new Error('expected mutation');
      let reads = 0;
      const input = { companyId: 'co1', email: 'new@fixture.test', firstName: 'Fixture', lastName: 'User', type: 'account', role: 'user', locationIds: ['loc1'] };
      const pre = { read: async () => { reads++; return {}; } };
      const prepared = await op.prepare(pre, input, { ...ctx, companyId: 'co1' });
      expect(prepared.body).toEqual({ kind: 'json', value: input });
      await expect(op.prepare(pre, input, { ...ctx, companyId: 'other' })).rejects.toThrow(/location/);
      await expect(op.prepare(pre, input, ctx)).rejects.toThrow(/location/);
      expect(reads).toBe(0);
    });
    return;
  }
  it('prepares a scoped fixture call and emits ids and field names only', async () => {
    const crm = f6FakeRequester(usersRoutes), a = sample(op.id);
    expect(JSON.stringify([op.fields(a), op.recordRefs(a)])).not.toContain(sentinel);
    expect((await f6Execute(op, crm, a)).value).toBeDefined();
    expect(crm.calls.filter(call => call.operation === op.id)).toHaveLength(1);
  });
  it('rejects provider text in receipt metadata', async () => {
    const crm = f6FakeRequester(usersRoutes), request = crm.request;
    crm.request = async (...args) => { if (args[0] === op.id) throw new Error(sentinel); return request(...args); };
    await expect(f6Execute(op, crm, sample(op.id))).rejects.toThrow(sentinel);
    expect(JSON.stringify({ fields: op.fields(sample(op.id)), ids: op.recordRefs(sample(op.id)), status: 422 })).not.toContain(sentinel);
  });
  if (op.risk !== 'R') it('binds the complete response to the approved user', async () => {
    const held = HeldRequest.freeze(op, await op.prepare(f6Preflight(f6FakeRequester(usersRoutes), op), sample(op.id), ctx), ctx);
    prepareReturnedIdentitySchema(held, ctx.locationId);
    for (const raw of [{ user: { id: 'foreign' } }, { user: { id: 'user1' }, nested: [{ locationId: 'foreign' }] }, { user: { id: 'user1' }, success: false }])
      expect(() => op.project(raw, held.frozen)).toThrow();
  });
});
it.each(['users.update', 'users.delete'])('%s refuses agency, foreign and multi-location users', async id => {
  const op = usersOperations.find(op => op.id === id)!; if (op.risk === 'R') throw new Error('expected mutation');
  for (const roles of [{ type: 'agency', locationIds: ['loc1'] }, { type: 'account', locationIds: ['loc1', 'other'] }, { type: 'account', locationIds: ['other'] }, {}])
    await expect(op.prepare({ read: async operation => operation === 'users.list' ? { users: [{ id: 'user1', roles }] } : { id: 'user1', roles } }, sample(id), ctx)).rejects.toThrow(/ownership|beyond/);
});
it('user update cannot grant access to another location or agency', async () => {
  const op = usersOperations.find(op => op.id === 'users.update')!; if (op.risk === 'R') throw new Error('expected mutation');
  for (const change of [{ type: 'agency' }, { locationIds: ['loc1', 'other'] }])
    await expect(op.prepare(f6Preflight(f6FakeRequester(usersRoutes), op), { ...sample(op.id), ...change }, ctx)).rejects.toThrow(/location/);
});
it('user projection is credential-free and stays below 64 KiB', () => {
  const op = usersOperations.find(op => op.id === 'users.list')!;
  const output = JSON.stringify(op.project({ users: Array(100).fill({ id: 'user1', name: '😀'.repeat(4000), email: '😀'.repeat(4000), password: sentinel }) }));
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65536); expect(output).not.toContain(sentinel);
});
