// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, it } from 'vitest';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { fixtureMemoryAccess } from '../testing/recall-access-fixture.ts';
import { assertMemoryAccess, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { freshDataDir, THREAD } from './testing/recall-fixture.ts';

beforeEach(() => freshDataDir('active'));

it('an active memory capability without recall preparation fails closed', () => {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'bot', threadId: THREAD }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin('bot', THREAD);
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, depth: 0, kind: 'memory', skillAuthoring: false });
  const claim = registry.resolve(`Bearer ${token}`)!;

  expect(() => memoryAccess(registry, claim, () => roster)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  const prepared = fixtureMemoryAccess(registry, claim, () => roster);
  expect(() => assertMemoryAccess(prepared)).not.toThrow();
});

it('legacy fixture admission revisions its roster and prepares a real serving view', () => {
  const roster: MemoryRoster = { bots: [{ id: 'bot', threadId: THREAD }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin('bot', THREAD);
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, depth: 0, kind: 'memory', skillAuthoring: false });
  const claim = registry.resolve(`Bearer ${token}`)!;
  expect(() => memoryAccess(registry, claim, () => roster)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  const prepared = fixtureMemoryAccess(registry, claim, () => roster);
  expect(roster.memoryRosterRevision).toBe(1);
  expect(memoryAccess(registry, claim, () => roster).view).toEqual(prepared.view);
});

it('a fixture roster factory keeps live structural revision checks after admission', () => {
  let threads = [{ id: 'bot', threadId: THREAD, section: 'Original team' }];
  const roster = () => ({ bots: threads, groups: [] });
  reconcileMemoryRoster(roster());
  const registry = new InternalCapabilities(), generation = registry.begin('bot', THREAD);
  const token = registry.mint({ botId: 'bot', threadId: THREAD, generation, depth: 0, kind: 'memory', skillAuthoring: false });
  const access = fixtureMemoryAccess(registry, registry.resolve(`Bearer ${token}`)!, roster);
  expect(() => assertMemoryAccess(access)).not.toThrow();
  threads = [{ id: 'bot', threadId: THREAD, section: 'Changed team' }];
  reconcileMemoryRoster(roster());
  expect(() => assertMemoryAccess(access)).toThrow('MEMORY_CONTEXT_REVOKED');
});
