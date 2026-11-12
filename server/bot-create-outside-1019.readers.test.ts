import { mkdirSync } from 'node:fs';
import { beforeEach, expect, it } from 'vitest';
import { Store, mentionedBots, roomResponders } from './store.ts';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { removeTempDirSync } from './testing/cleanup.ts';
import { BotOutsideWrites } from './bot-outside-writes.ts';
import { chiefPromptRosterIds } from './chief-of-staff.ts';
import { ownToolGate, ownWritePlan } from './outside-own.ts';
import { beginOutsideTurn, forgetOutsideState, markTurnOutside, turnOutsideRead } from './email/external-marks.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database(); forgetOutsideState(); });
useOutsideStoreFixture();
it('staged profiles cannot enter chief prompts or mention responders', () => {
  const store = new Store(() => ({ instanceId: 'fake', model: 'fake' }));
  const chief = store.createBot({ name: 'Chief' }); store.setChiefOfStaff(chief.id, undefined, 'workspace');
  const writes = new BotOutsideWrites(store, () => null);
  const b = store.createBot({ name: 'Susan', section: chief.section }, { staged: writes.staging('G', 'T', chief.id, 'outside', { autoApprove: false, fullAccess: false, noLimits: false, lead: false }) });
  expect(chiefPromptRosterIds(chief.id, store.bots)).not.toContain(b.id);
  expect(mentionedBots('@Susan', store.bots)).toEqual([]);
  expect(roomResponders('@Susan', [b], { kind: 'everyone' })).toEqual([]);
});
it('the new authority gate keeps the live outside mark and existing own-write history', () => {
  beginOutsideTurn('T', 'fake', 'P', false); markTurnOutside('T', 'web page');
  for (const tool of ['create_bot', 'update_bot', 'move_bot', 'restore_bot', 'set_team_lead', 'save_prompt_block', 'phone']) {
    const call = { threadId: 'T', botId: 'chief', tool, lane: true, targetBotId: 'Susan', changed: ['instructions'] };
    expect(ownToolGate(call), tool).toBeNull();
    expect(turnOutsideRead('T')).toBe('web page');
    if (tool === 'update_bot') expect(ownWritePlan({ ...call, lane: false })).toEqual(['bot:Susan', 'roster:Susan']);
  }
});
