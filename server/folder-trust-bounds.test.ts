// W-T11: turn preparation reads the published index, never the saved records.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FolderTrustStore } from './folder-trust.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

/** Counts container visits, serialized bytes and byte-length measurements made while `work` runs. */
function measure(work: () => void) {
  const counts = { visits: 0, bytes: 0, measured: 0 };
  const originals: Array<() => void> = [];
  const wrap = <T extends object>(target: T, name: PropertyKey, onCall: (args: unknown[], result: unknown) => void) => {
    const original = (target as Record<PropertyKey, unknown>)[name] as (...args: unknown[]) => unknown;
    (target as Record<PropertyKey, unknown>)[name] = function (this: unknown, ...args: unknown[]) { const result = original.apply(this, args); onCall(args, result); return result; };
    originals.push(() => { (target as Record<PropertyKey, unknown>)[name] = original; });
  };
  // visits are elements handed out, not iterator calls: a loop over 100,000 entries is 100,000 visits
  for (const proto of [Map.prototype, Set.prototype]) {
    for (const name of [Symbol.iterator, 'entries', 'values', 'keys'] as const) {
      const original = (proto as unknown as Record<PropertyKey, () => IterableIterator<unknown>>)[name];
      (proto as unknown as Record<PropertyKey, unknown>)[name] = function* (this: unknown) { for (const item of original.call(this)) { counts.visits++; yield item; } };
      originals.push(() => { (proto as unknown as Record<PropertyKey, unknown>)[name] = original; });
    }
    const each = proto.forEach as (this: unknown, callback: (...args: unknown[]) => void, thisArg?: unknown) => void;
    (proto as unknown as { forEach: unknown }).forEach = function (this: unknown, callback: (...args: unknown[]) => void, thisArg?: unknown) { return each.call(this, (...args: unknown[]) => { counts.visits++; callback.apply(thisArg, args); }); };
    originals.push(() => { (proto as unknown as { forEach: unknown }).forEach = each; });
  }
  wrap(JSON, 'stringify', (_args, result) => { counts.bytes += typeof result === 'string' ? result.length : 0; });
  wrap(Buffer, 'byteLength', () => { counts.measured++; });
  try { work(); } finally { for (const restore of originals.reverse()) restore(); }
  return counts;
}

const storeWith = (count: number, decision: 'reject' | 'trust') => {
  const root = mkdtempSync(join(tmpdir(), 'trust-bounds-')); roots.push(root);
  const cwd = join(root, 'workspace'); mkdirSync(cwd);
  const folders = Object.fromEntries(Array.from({ length: count }, (_, i) => [join(root, `unrelated-${i}`),
    { folder: join(root, `unrelated-${i}`), decision, source: 'card', decidedAt: i, ...(decision === 'trust' ? { consent: 2 } : {}) }]));
  const file = join(root, 'folder-trust.json');
  writeFileSync(file, JSON.stringify({ version: 1, folders }));
  return { store: new FolderTrustStore(file), cwd, root };
};
const prepare = (store: FolderTrustStore, cwd: string, root: string) => () => {
  const index = store.index();
  index.declineCoverage(); index.lookup(cwd); index.prefixLookup(root); index.rejectFor(cwd, cwd); index.hasDescendantDecline(cwd);
  void index.seed.rejects.length; void index.seed.trustKeys.length; void index.revision; void index.fingerprint;
};

describe('turn-preparation-does-not-enumerate-records', () => {
  it('equal visit, byte and measurement counts at 10, 10,000 and 100,000 saved declines', () => {
    const results = [10, 10_000, 100_000].map(count => {
      const { store, cwd, root } = storeWith(count, 'reject');
      const first = store.index();
      const counts = measure(prepare(store, cwd, root));
      expect(store.index(), 'preparation reuses the published index').toBe(first);
      return counts;
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it('control: the enumerating readers still scale with the store, so the measure can tell', () => {
    const small = storeWith(10, 'reject'), large = storeWith(10_000, 'reject');
    const visits = (s: ReturnType<typeof storeWith>) => measure(() => { s.store.turnRecords(); s.store.plainPickKeys(); }).visits;
    expect(visits(large)).toBeGreaterThan(visits(small));
  });

  it('declineCoverage is incomplete on overflow, complete when bounded, and trusts alone stay bounded', () => {
    expect(storeWith(10, 'reject').store.index().declineCoverage()).toBe('complete');
    const overflow = storeWith(1025, 'reject').store.index();
    expect(overflow.declineCoverage()).toBe('incomplete');
    expect(overflow.seed.rejects).toEqual([]);
    const trusts = storeWith(5000, 'trust').store.index();
    expect(trusts.declineCoverage()).toBe('complete');
    expect(trusts.seed.trustKeys.length).toBe(1024);
  });
});
