import { expect, it } from 'vitest';
import { buildFolderTrustSnapshot } from './folder-trust-index.ts';
import type { FolderTrustRecord } from './folder-trust.ts';

const reject = (folder: string, n = 0): [string, FolderTrustRecord] => [folder, { folder, decision: 'reject', source: 'card', decidedAt: n }];

it('declineCoverage is complete when every decline fits the seed projection', () => {
  const index = buildFolderTrustSnapshot(new Map([reject('/fixture/a'), reject('/fixture/b')]));
  expect(index.declineCoverage()).toBe('complete');
  expect(index.seed.rejects.map(r => r.key)).toEqual(['/fixture/a', '/fixture/b']);
});

it('declineCoverage is incomplete on overflow and the seed carries nothing partial, while every answer stays reachable', () => {
  const records = new Map(Array.from({ length: 10_000 }, (_, n) => reject(`/fixture/workspace-${n}`, n)));
  const index = buildFolderTrustSnapshot(records);
  expect(index.declineCoverage()).toBe('incomplete');
  expect(index.seed.rejects).toEqual([]);
  expect(index.seed.trustKeys).toEqual([]);
  for (const n of [0, 1024, 9999]) expect(index.lookup(`/fixture/workspace-${n}`).decision).toBe('reject');
  expect(index.lookup('/fixture/unrelated')).toMatchObject({ decision: 'none', reject: null });
  expect(index.rejectCount).toBe(10_000);
});

it('declineCoverage is unknown for an unreadable store', () => {
  expect(buildFolderTrustSnapshot(new Map(), false).declineCoverage()).toBe('unknown');
});

it('lookup is exact-key; prefixLookup finds declines below a root, bounded', () => {
  const records = new Map<string, FolderTrustRecord>([
    reject('/fixture/root/one'), reject('/fixture/root/two'), reject('/fixture/other'),
    ['/fixture/trusted', { folder: '/fixture/trusted', decision: 'trust', source: 'card', decidedAt: 1, consent: 2 }],
    ['/fixture/picked', { folder: '/fixture/picked', decision: 'trust', source: 'picker', decidedAt: 2 }],
  ]);
  const index = buildFolderTrustSnapshot(records);
  expect(index.lookup('/fixture/trusted')).toMatchObject({ decision: 'trust', consent: 2, picked: false });
  expect(index.lookup('/fixture/picked')).toMatchObject({ decision: 'trust', consent: null, picked: true });
  expect(index.lookup('/fixture/root')).toMatchObject({ decision: 'none' });
  expect(index.prefixLookup('/fixture/root')).toEqual({ declines: ['/fixture/root/one', '/fixture/root/two'], truncated: false });
  const many = buildFolderTrustSnapshot(new Map(Array.from({ length: 200 }, (_, n) => reject(`/fixture/deep/d-${n}`))));
  const found = many.prefixLookup('/fixture/deep');
  expect(found.declines.length).toBe(64);
  expect(found.truncated).toBe(true);
});

it('revision follows the decision set and not the insertion order', () => {
  const a = buildFolderTrustSnapshot(new Map([reject('/fixture/a'), reject('/fixture/b')]));
  const b = buildFolderTrustSnapshot(new Map([reject('/fixture/b'), reject('/fixture/a')]));
  const c = buildFolderTrustSnapshot(new Map([reject('/fixture/a')]));
  expect(a.revision).toBe(b.revision);
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(c.revision).not.toBe(a.revision);
});
