// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { HighLevelActions, MemoryActionJournal, ACTION_MAX_IDENTITIES } from './actions.ts';
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';

it('No limits policy inventory stays bounded without asking the owner to clear reviews', () => {
  const ACTION_MAX_POLICY_IDENTITIES = ACTION_MAX_IDENTITIES;
  const journal = new MemoryActionJournal();
  const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'connection', connectionEpoch: 1,
    locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
  const detail = () => fixtureActionDetail({ basis: 'owner_no_limits', recordRefs: [], fields: [] }, context);
  const actions = new HighLevelActions({ journal });
  const first = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, detail());
  const row = journal.rows.get(first.actionId)!;
  for (let i = 1; i < ACTION_MAX_POLICY_IDENTITIES; i++) journal.put({ ...row, actionId: `policy_${i}` });
  const full = new HighLevelActions({ journal });
  expect(() => full.propose(context, 'HIGHLEVEL_CONTACTS', {}, detail())).toThrow('HighLevel is at capacity. Try again after the current changes finish.');
  expect(journal.rows.size).toBe(ACTION_MAX_POLICY_IDENTITIES);
  full.deny(first.actionId);
  expect(full.propose(context, 'HIGHLEVEL_CONTACTS', {}, detail())).toBeDefined();
  expect(journal.rows.size).toBe(ACTION_MAX_POLICY_IDENTITIES);
});
