// SPDX-License-Identifier: AGPL-3.0-or-later
// Limit application producer/renderer owner: G2. Display projection owner: G2 at this declared receipt boundary.
import { expect, it } from 'vitest';
import { sanitizeBotDisplayMessage } from './transcript-page.ts';

it.each([true, false])('projects only the bound application option and flags (matching=%s)', matching => {
  const row = { id: 'message', role: 'bot', kind: 'options',
    card: { tool: 'murage_limit_offer', title: 'Choose', subtitle: '', requestId: 'limit-fixture', approvalId: 'approval', options: ['Backup', 'Wait'], limitOffer: { choices: [{ label: 'Backup' }] }, answered: 'Answered' },
    limitApplication: { approvalId: matching ? 'approval' : 'other', principal: 'private-principal', rowId: 'private-move',
      answer: { kind: 'engine', choice: { label: 'Backup' }, nextTime: true, routines: false } } };
  const projected = sanitizeBotDisplayMessage(row, { authorship: 'bot' });
  expect(projected.card).toMatchObject({ requestHandle: 'p.message' });
  expect((projected.card as any).requestId).toBeUndefined();
  if (matching) expect(projected.limitApplication).toEqual({ optionIndex: 0, nextTime: true, routines: false });
  else expect(projected.limitApplication).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain('private-principal');
  expect(JSON.stringify(projected)).not.toContain('private-move');
});
