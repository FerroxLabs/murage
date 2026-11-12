import './registry.ts';
import { describe, expect, it } from 'vitest';
import { locationOperations, resolveCustomFieldId, f6LevelCovers } from './location.ts';
import { f6Execute, f6FakeRequester, f6Preflight } from '../fake/location.ts';
import { HeldRequest } from '../held-request.ts';
import { HIGHLEVEL_OPERATION_MANIFEST } from './manifest.ts';
import { freezeOperationSpec } from './registry.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
import type { MutationSpec, OperationSpec } from './registry.ts';
const sentinel = 'F6_PRIVATE_VALUE_SENTINEL';
const ctx = { locationId: 'loc1' };
export function locationSample(id: string): Record<string, unknown> {
  const a: Record<string, unknown> = {};
  if (/\.(get|update|delete)$/.test(id) && id !== 'location.get') a[id.includes('customFields') ? 'fieldId' : id.includes('customValues') ? 'valueId' : 'tagId'] = id.includes('customFields') ? 'field1' : id.includes('customValues') ? 'value1' : 'tag1';
  if (/\.(create|update)$/.test(id)) a.name = sentinel;
  if (id === 'location.customFields.create') a.dataType = 'TEXT';
  if (/customValues\.(create|update)$/.test(id)) a.value = sentinel;
  if (id === 'location.templates.list') a.originId = 'origin1';
  return a;
}
it('loc.customFieldByNameAmbiguousRefused', async () => {
  await expect(resolveCustomFieldId({ read: async () => ({ customFields: [{ id: 'field1', name: 'Size' }, { id: 'field2', name: 'size' }] }) }, 'loc1', 'SIZE')).rejects.toThrow(/field1.*field2/);
});
it('loc.deleteDefinitionIsD', () => {
  expect(locationOperations.filter(op => op.id.endsWith('.delete')).map(op => op.risk)).toEqual(['D', 'D', 'D']);
});
it('covers every frozen location row', () => expect(locationOperations.map(op => op.id)).toEqual(HIGHLEVEL_OPERATION_MANIFEST.filter(row => row.family === 'location').map(row => row.id)));
for (const op of locationOperations) describe(op.id, () => {
  it('keeps frozen schema, endpoint, preflight and preparation identities', async () => {
    expect(freezeOperationSpec(op)).toBe(op);
    expect(op).not.toHaveProperty('run');
    expect(op.args.safeParse(locationSample(op.id)).success).toBe(true);
    const crm = f6FakeRequester();
    const a = locationSample(op.id);
    const draft = op.risk === 'R' ? await op.prepareRead(a, ctx) : await op.prepare(f6Preflight(crm, op), a, ctx);
    const held = HeldRequest.freeze(op, draft, ctx);
    expect(held.frozen.operation).toBe(op.id);
    expect(() => HeldRequest.freeze(op, draft, { locationId: 'foreign' })).toThrow();
    expect(op.endpoint.path.test(draft.path)).toBe(true);
    expect(op.endpoint.retry).toBe(op.risk === 'R' ? 'read' : 'write');
  });
  it('rejects unknown keys, URL values and traversing IDs', () => {
    const a = locationSample(op.id);
    for (const key of ['url', 'path', 'headers', 'token', 'password', 'extra', 'locationId']) expect(op.args.safeParse({ ...a, [key]: sentinel }).success).toBe(false);
    for (const key of Object.keys(a)) if (typeof a[key] === 'string') expect(op.args.safeParse({ ...a, [key]: 'https://attacker.invalid' }).success).toBe(false);
  });
  it('enforces risk levels and ids-only metadata', () => {
    expect(f6LevelCovers('read', op.risk)).toBe(op.risk === 'R');
    expect(f6LevelCovers('change', op.risk)).toBe(op.risk !== 'D');
    expect(f6LevelCovers('full', op.risk)).toBe(true);
    expect(f6LevelCovers(undefined, op.risk)).toBe(false);
    expect(JSON.stringify([op.fields(locationSample(op.id)), op.recordRefs(locationSample(op.id))])).not.toContain(sentinel);
  });
  it('prepares then dispatches one immutable fixture request', async () => {
    const crm = f6FakeRequester();
    const result = await f6Execute(op, crm, locationSample(op.id));
    expect(result.value).toBeDefined();
    expect(crm.calls.filter(c => c.operation === op.id)).toHaveLength(1);
    if (op.risk !== 'R') expect(crm.calls.filter(c => c.method !== 'GET')).toHaveLength(1);
  });
  it('keeps provider error text out of receipt metadata', async () => {
    const crm = f6FakeRequester(), request = crm.request;
    crm.request = async (...args) => { if (args[0] === op.id) throw new Error(sentinel); return request(...args); };
    await expect(f6Execute(op, crm, locationSample(op.id))).rejects.toThrow(sentinel);
    expect(JSON.stringify({ operation: op.id, fields: op.fields(locationSample(op.id)), records: op.recordRefs(locationSample(op.id)), status: 422 })).not.toContain(sentinel);
  });
  if (op.risk !== 'R') {
    it('rejects response identity conflicts and negative confirmations before projection', async () => {
      const a = locationSample(op.id), crm = f6FakeRequester();
      const held = HeldRequest.freeze(op, await op.prepare(f6Preflight(crm, op), a, ctx), ctx);
      prepareReturnedIdentitySchema(held, ctx.locationId);
      for (const value of [{ success: false }, { success: true, nested: [{ locationId: 'foreign' }] }, { success: true, nested: [{ id: 'foreign' }] }]) expect(() => op.project(value, held.frozen)).toThrow();
      expect(() => op.project({ success: true })).toThrow();
    });
  }
});
it.each(['customFields', 'customValues', 'tags'])('refuses foreign %s child before a mutation', async kind => {
  for (const verb of ['update', 'delete']) {
    const op = locationOperations.find(op => op.id === `location.${kind}.${verb}`) as MutationSpec;
    const singular = kind === 'customFields' ? 'customField' : kind === 'customValues' ? 'customValue' : 'tag';
    const key = kind === 'customFields' ? 'fieldId' : kind === 'customValues' ? 'valueId' : 'tagId';
    for (const child of [{ id: 'foreign' }, { id: locationSample(op.id)[key], locationId: 'foreign' }, {}])
      await expect(op.prepare({ read: async () => ({ [singular]: child }) }, locationSample(op.id), ctx)).rejects.toThrow(/location/);
  }
});
it('custom field resolution rejects missing and partial inventories', async () => {
  expect(await resolveCustomFieldId(f6Preflight(f6FakeRequester(), { preflight: ['location.customFields.list'] }), 'loc1', 'fixture')).toBe('field1');
  for (const value of [{ customFields: [], nextPage: 'next' }, { customFields: [], total: 1 }, { customFields: [], meta: { hasMore: true } }])
    await expect(resolveCustomFieldId({ read: async () => value }, 'loc1', 'Size')).rejects.toThrow(/ownership/);
});
it('tasks search binds a POST read body to the location', async () => {
  const op = locationOperations.find(op => op.id === 'location.tasks.search')!;
  if (op.risk !== 'R') throw new Error('expected read');
  const draft = await op.prepareRead({ completed: false, query: 'Follow up' }, ctx);
  expect(draft).toMatchObject({ path: '/locations/loc1/tasks/search', body: { kind: 'json', value: { completed: false, query: 'Follow up' } } });
  expect(HeldRequest.freeze(op, draft, ctx).frozen.method).toBe('POST');
});
it('bounds UTF-8 projections and strips provider credentials', () => {
  const huge = '😀'.repeat(4000), row = { id: 'record1', name: huge, value: huge, placeholder: huge, title: huge, body: huge, password: sentinel };
  for (const op of locationOperations.filter(op => op.risk === 'R')) {
    const raw = { location: row, customFields: Array(100).fill(row), customField: row, customValues: Array(100).fill(row), customValue: row, tags: Array(100).fill(row), tag: row, tasks: Array(100).fill(row), templates: Array(100).fill(row) };
    const value = JSON.stringify(op.project(raw));
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(65536); expect(value).not.toContain(sentinel);
  }
});

it.each([{ nextCursor: 'more' }, { meta: { nextPageToken: 'more' } }, { meta: { total: 2 } }])('R5 custom field resolution refuses incomplete matching inventory %j', async flags => {
  let reads = 0;
  await expect(resolveCustomFieldId({ read: async () => { reads++; return { customFields: [{ id: 'field1', name: 'Size' }], ...flags }; } }, 'loc1', 'Size')).rejects.toThrow(/ownership/);
  expect(reads).toBe(1);
});
it('R6 fixture preflights reject undeclared operations before forwarding', async () => {
  const crm = f6FakeRequester(), spec = locationOperations.find(op => op.id === 'location.get')!;
  await expect(f6Preflight(crm, spec).read('location.tags.list', { path: '/locations/loc1/tags' })).rejects.toThrow(/not allowed/);
  expect(crm.calls).toHaveLength(0);
});
it('R6 fixture preflights reject declared mutation targets before forwarding', async () => {
  const crm = f6FakeRequester(), spec = { preflight: ['location.tags.delete'] } as Pick<OperationSpec, 'preflight'>;
  await expect(f6Preflight(crm, spec).read('location.tags.delete', { path: '/locations/loc1/tags/tag1' })).rejects.toThrow(/not allowed/);
  expect(crm.calls).toHaveLength(0);
});
it('R6 fixture preflights stop the sixth read before forwarding', async () => {
  const crm = f6FakeRequester(), spec = { preflight: ['location.tags.list'] } as Pick<OperationSpec, 'preflight'>;
  const pre = f6Preflight(crm, spec);
  for (let n = 0; n < 5; n++) await pre.read('location.tags.list', { path: '/locations/loc1/tags' });
  await expect(pre.read('location.tags.list', { path: '/locations/loc1/tags' })).rejects.toThrow(/not allowed/);
  expect(crm.calls).toHaveLength(5);
});
