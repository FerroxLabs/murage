// SPDX-License-Identifier: AGPL-3.0-or-later
// Native write producer owner: recall-fix-a. Recall admission consumer owner: recall-fix-a.
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';

it('ten accepted Claude owner turns keep their native session while capture jobs remain asynchronous', async () => {
  const world = await proofWorld('claude');
  try {
    const bot = await world.bot(), sessions: string[] = [];
    for (let turn = 0; turn < 10; turn++) {
      await world.acceptedTurn(bot, `Owner turn ${turn + 1}: the fixture garden gate is green.`);
      sessions.push(world.session(bot.threadId));
    }
    expect(sessions.every(Boolean)).toBe(true);
    expect(new Set(sessions).size).toBe(1);
    expect(world.log()).not.toContain('memory continuation refused');
  } finally { await world.fixture.close(); }
}, 180_000);
