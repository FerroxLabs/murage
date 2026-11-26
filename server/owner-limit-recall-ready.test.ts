// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: nl-backup-b owns direct continuation setup; recall-scope owns prepared view admission.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { freshDataDir } from './memory/testing/recall-fixture.ts';
import { database, closeDatabase } from './database.ts';
import { recallViewProjection, subscribeRecallViewPublication } from './memory/recall-view.ts';
import { RecallReadiness } from './memory/recall-readiness.ts';
import { RecallPreparationPending, MemoryPinProjectionPending } from './memory/recall-recovery.ts';

// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Producer owner: recall-r7-a; consumer owner: MAIN (guarded admission witnesses).
beforeEach(() => { freshDataDir('active'); database().exec('DROP INDEX memory_records_pinned'); });
afterEach(() => closeDatabase());
function admission(read: () => unknown) {
  const { admittedRecallAccess } = wiring(['admittedRecallAccess', 'admittedRecallRead'], { AbortController, subscribeRecallViewPublication, recallWaits: new Map(), turnMemoryAccess: read });
  const readiness = new RecallReadiness();
  return (...args: unknown[]) => admittedRecallAccess(readiness, ...args);
}
import { wiring } from './decision-wiring/fixture.ts';

it('cold direct setup yields until the actual access reader admits the current view', async () => {
  const access = { view: 'current' }; let ready = false;
  const read = vi.fn((..._args: unknown[]) => { if (!ready) throw new RecallPreparationPending(); return access; });
  const yieldSetup = vi.fn(async () => { ready = true; });
  const awaitTurnMemoryAccess = admission(() => { try { return read('bot', 'thread', 'generation'); } catch (error) { setTimeout(yieldSetup, 0); throw error; } });
  expect(await awaitTurnMemoryAccess('bot', 'thread', 'generation')).toBe(access);
  expect(read.mock.calls).toEqual([['bot', 'thread', 'generation'], ['bot', 'thread', 'generation']]);
  expect(yieldSetup).toHaveBeenCalledOnce();
});

it('revocation during preparation refuses the waiting turn without a provider submission', async () => {
  let active = true;
  const read = vi.fn(() => { if (active) throw new RecallPreparationPending(); throw new Error('MEMORY_UNAUTHORIZED'); });
  const submit = vi.fn();
  const awaitTurnMemoryAccess = admission(() => { try { return read(); } catch (error) { setTimeout(() => { active = false; }, 0); throw error; } });
  await expect(awaitTurnMemoryAccess('bot', 'thread', 'generation').then(submit)).rejects.toThrow('MEMORY_UNAUTHORIZED');
  expect(submit).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2);
});

it('permanently unavailable preparation has a fixed probe ceiling and refuses dispatch', async () => {
  const refusal = new RecallPreparationPending(), read = vi.fn(() => { throw refusal; });
  const submit = vi.fn(), yieldSetup = vi.fn(async () => {});
  const awaitTurnMemoryAccess = admission(read);
  // MAIN RULING 1115-RECALL-R7 (GrokBuild): current admission owns four finite probes and a typed pin refusal.
  await expect(awaitTurnMemoryAccess('bot', 'thread', 'generation').then(submit)).rejects.toBeInstanceOf(MemoryPinProjectionPending);
  expect(read).toHaveBeenCalledTimes(4); expect(yieldSetup).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it('other admission failures propagate immediately without waiting or a provider submission', async () => {
  const refusal = new Error('MEMORY_POLICY_PENDING'), yieldSetup = vi.fn(), submit = vi.fn();
  const awaitTurnMemoryAccess = admission(() => { throw refusal; });
  await expect(awaitTurnMemoryAccess('bot', 'thread', 'generation').then(submit)).rejects.toBe(refusal);
  expect(yieldSetup).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
});

it('a lagging mandatory-pin projection is retried through the guarded bundle reader', async () => {
  const bundle = { records: ['current pin'] }; let reads = 0;
  const read = vi.fn(async () => { if (++reads < 3) throw new Error('MEMORY_RECALL_UNAVAILABLE'); return bundle; });
  const { buildMemoryBundle } = wiring(['buildMemoryBundle'], { Error, database, recallViewProjection, requestRecallViewMaintenance: vi.fn(), setTimeout, readMemoryBundle: read });
  const args = ['query', { view: { viewId: 'fixture-view', generation: 1 } }, {}, { signal: undefined }];
  expect(await buildMemoryBundle(...args)).toBe(bundle);
  expect(read).toHaveBeenCalledTimes(3); expect(read.mock.calls.every(call => call.every((value, i) => value === args[i]))).toBe(true);
});
it('bundle cancellation or policy failure during upkeep refuses before provider submission', async () => {
  let reads = 0; const submit = vi.fn();
  const { buildMemoryBundle } = wiring(['buildMemoryBundle'], { Error, database, recallViewProjection, requestRecallViewMaintenance: vi.fn(), setTimeout,
    readMemoryBundle: async () => { throw new Error(++reads === 1 ? 'MEMORY_RECALL_UNAVAILABLE' : 'MEMORY_UNAUTHORIZED'); } });
  await expect(buildMemoryBundle('query', { view: { viewId: 'fixture-view', generation: 1 } }, {}, {}).then(submit)).rejects.toThrow('MEMORY_UNAUTHORIZED');
  expect(reads).toBe(2); expect(submit).not.toHaveBeenCalled();
});
it('bundle preparation has a fixed retry ceiling and never returns an unavailable pin frame', async () => {
  const refusal = new Error('MEMORY_RECALL_UNAVAILABLE'), read = vi.fn(async () => { throw refusal; }), submit = vi.fn();
  const { buildMemoryBundle } = wiring(['buildMemoryBundle'], { Error, database, recallViewProjection, requestRecallViewMaintenance: vi.fn(), setTimeout: (fn: () => void) => setImmediate(fn), readMemoryBundle: read });
  await expect(buildMemoryBundle('query', { view: { viewId: 'fixture-view', generation: 1 } }, {}, {}).then(submit)).rejects.toBe(refusal);
  expect(read).toHaveBeenCalledTimes(64); expect(submit).not.toHaveBeenCalled();
});
it('a known bundle authority refusal propagates immediately without waiting', async () => {
  const delay = vi.fn(), refusal = new Error('MEMORY_CONTEXT_REVOKED');
  const { buildMemoryBundle } = wiring(['buildMemoryBundle'], { Error, database, recallViewProjection, requestRecallViewMaintenance: vi.fn(), setTimeout: delay, readMemoryBundle: async () => { throw refusal; } });
  await expect(buildMemoryBundle('query', { view: { viewId: 'fixture-view', generation: 1 } }, {}, {})).rejects.toBe(refusal);
  expect(delay).not.toHaveBeenCalled();
});

it('post-reset projection waiting resets and drains once while rerunning guarded reads', async () => {
  const source = readFileSync(new URL('./memory/dispatch.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function buildMemoryBundleAfterReset('), end = source.indexOf('\n}', start) + 2;
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const value = { records: ['current pin'] }; let reads = 0;
  const read = vi.fn(async () => { if (++reads < 3) throw new Error('MEMORY_RECALL_UNAVAILABLE'); return value; });
  const { buildMemoryBundle } = wiring(['buildMemoryBundle'], { Error, database, recallViewProjection, requestRecallViewMaintenance: vi.fn(), setTimeout, readMemoryBundle: read });
  const validate = vi.fn(), reset = vi.fn(async () => {}), drain = vi.fn(async () => {});
  const context = vm.createContext({ assertMemoryAccess: validate, drainBranchChanges: drain, database: () => ({}), buildMemoryBundle: read });
  const code = source.slice(start, end).replace('export ', '') + ';globalThis.afterReset=buildMemoryBundleAfterReset;';
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
  expect(await context.afterReset('query', { view: { viewId: 'fixture-view', generation: 1 } }, {}, reset, {}, buildMemoryBundle)).toBe(value);
  expect(reset).toHaveBeenCalledOnce(); expect(drain).toHaveBeenCalledOnce(); expect(validate).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(3);
});

// A rebuild prepares its recall view before reading access only after a refusal caused by a changed policy: that wait happens once per policy
// move. Every other redispatch keeps the fixed probes, so a turn's setup work never gains a wait that depends on the memory it recalls.
it('a rebuild prepares the recall view only when the refusal was a changed policy', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const sites = [...source.matchAll(/admittedRecallAccess\(recallReadiness,\s*bot\.id,\s*threadId,\s*[A-Za-z]+,\s*([^;]*)\)/g)].map(match => match[1]!.replace(/\s+/g, ''));
  expect(sites).toHaveLength(2);
  expect(sites).toContain('(opts?.memoryRedispatch??0)>0&&memoryRefusalCauses.kind(userMessage.id)==="without-memory"');
  expect(sites).toContain('memoryRedispatch>0&&memoryCause==="changed"');
});
