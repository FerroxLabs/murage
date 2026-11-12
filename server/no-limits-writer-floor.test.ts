// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { beginOutsideTurn, markTurnOutside, restartOutsideForTests, wireOutsideStore, ownWritten, turnOutsideRead } from './email/external-marks.ts';
import { fileOutsideStore } from './outside-store.ts';
import { ownToolGate, ownWritePlan, ownWriteCommit, OUTSIDE_WRITE_REFUSAL, OWN_WRITERS, type OwnCall } from './outside-own.ts';
import { PHONE_TOOL_NAMES } from '../shared/phone-jobs-contract.ts';
import { installPermissionInheritance, type PermissionSetting } from './permission-inheritance.ts';
import { noLimitsAppliesTo, type NoLimitsOrigin } from './no-limits-origin.ts';
import { serviceOwnerNoLimits } from './narrow-denials.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

let dir: string;
let restore: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'writer-floor-'));
  expect(wireOutsideStore(fileOutsideStore(join(dir, 'outside.jsonl')))).toBe(true);
  restore = installPermissionInheritance(() => true);
  beginOutsideTurn('owner-thread', 'instance', 'generation', false);
  beginOutsideTurn('guest-thread', 'instance', 'guest-generation', false);
  markTurnOutside('owner-thread', 'web page');
  markTurnOutside('guest-thread', 'web page');
});
afterEach(() => { restore(); restartOutsideForTests(); removeTempDirSync(dir); });

const inherited = { autoApprove: false, fullAccess: false, noLimits: false, permissionExplicit: false };
const explicit = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
function call(bot: PermissionSetting & { fullAccessChannelMessages?: boolean }, origin: NoLimitsOrigin | undefined, tool = 'propose_routine'): OwnCall {
  // lane=true reproduces the legacy floor even when the turn policy is missing.
  // The current bot and origin, never that cached lane, determine No limits.
  const authority = { claim: {}, proof: {}, identity: { threadId: 'owner-thread', generation: 'missing-generation' } } as NonNullable<OwnCall['authority']>;
  return { threadId: 'owner-thread', botId: 'bot', tool, lane: true, bot, origin, authority };
}

it('S2 owner No limits runs when the legacy lane and missing turn policy disagree', () => {
  const input = call(explicit, 'owner');
  expect(serviceOwnerNoLimits(input.authority)).toBe(false);
  expect(noLimitsAppliesTo('owner', explicit)).toBe(true);
  expect(ownToolGate(input)).toBeNull();
});

it('S2 owner write runs and records its key; a guest on the same inherited bot never inherits', () => {
  const owner = call(inherited, 'owner');
  expect(ownToolGate(owner)).toBeNull();
  expect(ownWritePlan(owner)).toEqual(['bot:bot']);
  expect(ownWritten('bot:bot')).toBe(false);
  expect(ownWriteCommit(ownWritePlan(owner), 200)).toBe(true);
  expect(ownWritten('bot:bot')).toBe(true);
  const guest = { ...call(inherited, 'guest'), threadId: 'guest-thread' };
  expect(noLimitsAppliesTo('guest', inherited)).toBe(false);
  expect(ownToolGate(guest)).toEqual({ refuse: OUTSIDE_WRITE_REFUSAL });
});

it('V6-1 marked No limits owner runs every own writer and phone tool without a stored policy', () => {
  for (const tool of [...OWN_WRITERS, ...PHONE_TOOL_NAMES, 'phone']) {
    expect(ownToolGate(call(explicit, 'owner', tool)), tool).toBeNull();
  }
});

it('V6-2 marked No limits owner records successful target keys without changing the outside mark', () => {
  const input = { ...call(explicit, 'owner', 'update_bot'), targetBotId: 'target', changed: ['name'] };
  expect(ownToolGate(input)).toBeNull();
  expect(ownWritePlan(input)).toEqual(['bot:target', 'roster:target']);
  ownWriteCommit(ownWritePlan(input), 403);
  expect(ownWritten('bot:target')).toBe(false);
  ownWriteCommit(ownWritePlan(input), 200);
  expect(ownWritten('bot:target')).toBe(true);
  expect(ownWritten('roster:target')).toBe(true);
  expect(turnOutsideRead('owner-thread')).toBe('web page');
});

for (const origin of ['owner', 'owner-channel', 'routine', 'owner-routine', 'webhook', 'unattended', 'other', 'guest', 'other-human', 'unproven', undefined] as const) {
  for (const [choice, bot] of [['inherited', inherited], ['explicit', explicit]] as const) {
    it(`S3 writer origin ${String(origin)} ${choice} follows the shared predicate`, () => {
      const input = call(bot, origin);
      expect(ownToolGate(input)).toEqual(noLimitsAppliesTo(origin, bot) ? null : { refuse: OUTSIDE_WRITE_REFUSAL });
    });
  }
}

for (const [level, bot] of [
  ['Ask', { autoApprove: false, fullAccess: false, noLimits: false, permissionExplicit: true }],
  ['Auto', { autoApprove: true, fullAccess: false, noLimits: false, permissionExplicit: true }],
  ['Full access', { autoApprove: true, fullAccess: true, noLimits: false, permissionExplicit: true }],
] as const) {
  it(`S2 frozen ${level} writer floor and off-lane keys`, () => {
    const input = call(bot, 'owner');
    expect(ownToolGate(input)).toEqual({ refuse: OUTSIDE_WRITE_REFUSAL });
    expect(ownToolGate({ ...input, lane: false })).toBeNull();
    expect(ownWritePlan({ ...input, lane: false })).toEqual(['bot:bot']);
    expect(ownWritePlan(input)).toEqual([]);
    expect(ownToolGate({ ...input, tool: 'ask_user' })).toBeNull();
  });
}

it('S3 channel messages off and draft-only never get the writer bypass', () => {
  expect(ownToolGate(call({ ...explicit, fullAccessChannelMessages: false }, 'owner-channel'))).toEqual({ refuse: OUTSIDE_WRITE_REFUSAL });
  expect(ownToolGate(call({ ...explicit, draftOnly: true }, 'owner'))).toEqual({ refuse: OUTSIDE_WRITE_REFUSAL });
});
