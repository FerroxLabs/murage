// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { bindServiceTurn, serviceNoLimits, serviceThreadNoLimits, type ServiceTurnFacts } from './service-no-limits.ts';
import { ownerNoLimitsSource } from './execution-audience.ts';
import { Store } from './store.ts';

it.each(['owner', 'owner-channel', 'webhook', 'unattended', 'routine', 'owner-routine'] as const)(
  'service No limits %s requires the live owner audience', origin => {
    const generation = `owner-gate-${origin}`, thread = `owner-thread-${origin}`;
    const facts: ServiceTurnFacts = { origin, ownerAudience: false, noLimits: true };
    let active = true;
    bindServiceTurn(generation, thread, 'fixture-bot', () => active, () => facts);
    try {
      expect.soft(serviceNoLimits(generation, thread, 'fixture-bot')).toBe(false);
      expect.soft(serviceThreadNoLimits(thread, 'fixture-bot')).toBe(false);
      facts.ownerAudience = true;
      expect(serviceNoLimits(generation, thread, 'fixture-bot')).toBe(true);
      facts.ownerAudience = false;
      expect(serviceNoLimits(generation, thread, 'fixture-bot')).toBe(false);
    } finally { active = false; }
  });

it('peer reach cannot fall back to a stored No limits flag after a live non-owner refusal', () => {
  const store = new Store();
  const bot = store.createBot({ name: 'Owner gate' }, { seedMessages: false });
  store.patchBot(bot.id, { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true });
  let active = true;
  const facts: ServiceTurnFacts = { origin: 'webhook', ownerAudience: false, noLimits: true };
  bindServiceTurn('reach-owner-gate', bot.threadId, bot.id, () => active, () => facts);
  try {
    expect.soft(serviceThreadNoLimits(bot.threadId, bot.id)).toBe(false);
    expect.soft(ownerNoLimitsSource(store, bot.id, bot.threadId)).toBe(false);
    facts.ownerAudience = true;
    expect(ownerNoLimitsSource(store, bot.id, bot.threadId)).toBe(true);
    facts.ownerAudience = false;
    expect(ownerNoLimitsSource(store, bot.id, bot.threadId)).toBe(false);
  } finally { active = false; }
});
