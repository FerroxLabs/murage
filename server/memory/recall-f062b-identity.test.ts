// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-f062b; consumer owner: recall-f062b (current identity frames).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ownerMemoryTicket } from './authority.ts';
import { buildMemoryBundle } from './bundle.ts';
import { writeBotIdentity } from './identity.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { memoryAccess, reconcileMemoryRoster } from './policy.ts';
import { prepareRecallContext, stopRecallViewMaintenance } from './recall-view.ts';
import { OWNER_PIN } from './schema.ts';

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  database().exec(OWNER_PIN.sql);
});
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

it('an owner edit reaches the next identity frame before projection maintenance, without another bot\'s private rows', async () => {
  const roster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }, { id: 'other', threadId: 'private' }], groups: [] };
  reconcileMemoryRoster(roster);
  const ticket = ownerMemoryTicket();
  const write = (botId: string, text: string, expectedVersion = 0) => writeBotIdentity(ticket, {
    action: 'identity-write', botId, kind: 'commitment', key: 'weekly', expectedVersion,
    text, basis: 'owner-fact', audience: 'owner-private',
  }, roster);
  const first = write('reader', 'Send the fixture summary on Monday.');
  write('other', 'Keep the private fixture schedule on Friday.');
  await prepareRecallContext('reader', 'direct', roster);
  stopRecallViewMaintenance();
  const registry = new InternalCapabilities(), generation = registry.begin('reader', 'direct');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation, kind: 'memory', depth: 0, skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const frame = () => buildMemoryBundle('', access, { search: async () => ({ hits: [], vectorRows: 0 }) }, { allowance: LineageAllowance.tool(), continuity: true });
  expect((await frame()).text).toContain('Send the fixture summary on Monday.');
  write('reader', 'Send the fixture summary on Tuesday.', 1);
  expect(database().prepare('SELECT 1 FROM memory_recall_view_records WHERE view_id=? AND generation=? AND record_id=? AND version=2').get(access.view.viewId, access.view.generation, first.id)).toBeUndefined();
  const current = await frame();
  expect(current.text).toContain('Send the fixture summary on Tuesday.');
  expect(current.text).not.toContain('Send the fixture summary on Monday.');
  expect(current.text).not.toContain('Keep the private fixture schedule on Friday.');
});
