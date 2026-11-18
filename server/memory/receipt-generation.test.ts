// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { buildMemoryBundle } from './bundle.ts';
import { MemoryDispatchReceipt } from './dispatch.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { checkedOpenTurns, closeTurnLineage, memberTurnId, openTurnLineage, refuseRetainedTurn, type OpenTurn } from './lineage-write.ts';
import { reconcileMemoryRoster } from './policy.ts';
import { fixtureMemoryAccess as memoryAccess } from '../testing/recall-access-fixture.ts';
import { reserveRelease } from './release-budget.ts';
import { prepareRetainedFence } from './send-fence.ts';

const turns: OpenTurn[] = [];
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { for (const turn of turns.splice(0)) closeTurnLineage(turn); closeDatabase(); });
async function fixture() {
  const roster = { bots: [{ id: 'bot', threadId: 'thread' }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(), generation = registry.begin('bot', 'thread');
  const token = registry.mint({ botId: 'bot', threadId: 'thread', generation, depth: 10, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const bundle = await buildMemoryBundle('query', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });
  const open = () => {
    const turn = openTurnLineage(database(), { threadId: 'thread', turnId: memberTurnId('bot') }) as OpenTurn;
    turns.push(turn);
    prepareRetainedFence(turn, { audience: { owner: true, scopeIds: access.scopeIds } }, () => {}, database());
    return turn;
  };
  return { access, bundle, open };
}

it('a rebuilt memory frame joins only its exact generation while the predecessor stays sealed and charged', async () => {
  const f = await fixture(), old = f.open();
  reserveRelease([old.budget!], { attempts: 1, bytes: 7 });
  const spent = old.budget!.counts;
  refuseRetainedTurn(old, { state: 'checking', reason: 'not-built' });
  const fresh = f.open();
  expect(() => new MemoryDispatchReceipt(f.bundle, f.access, 'driver', fresh)).not.toThrow();
  expect(fresh.parents).toContainEqual(expect.objectContaining({ kind: 'receipt', bundleId: f.bundle.bundleId }));
  expect(old.parents).toEqual([]);
  expect(old.budget!.counts).toEqual(spent);
  expect(old.sealed).toBe(true);
  expect(() => checkedOpenTurns(old)).toThrow('MEMORY_CONTEXT_REVOKED');
  expect(checkedOpenTurns(fresh)).toEqual([fresh]);
});

it('an exact stale memory frame refuses without attaching to a live replacement', async () => {
  const f = await fixture(), old = f.open();
  refuseRetainedTurn(old, { state: 'checking', reason: 'not-built' });
  const fresh = f.open();
  expect(() => new MemoryDispatchReceipt(f.bundle, f.access, 'driver', old)).toThrow('MEMORY_CONTEXT_REVOKED');
  expect(fresh.parents).toEqual([]);
  expect(checkedOpenTurns(fresh)).toEqual([fresh]);
});

it('an unbound memory frame retains the conservative all-members refusal', async () => {
  const f = await fixture(), old = f.open();
  refuseRetainedTurn(old, { state: 'checking', reason: 'not-built' });
  const fresh = f.open();
  expect(() => new MemoryDispatchReceipt(f.bundle, f.access, 'driver')).toThrow('MEMORY_CONTEXT_REVOKED');
  expect(fresh.parents).toEqual([]);
});
