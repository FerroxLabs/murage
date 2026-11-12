import { expect, it } from 'vitest';
import { ownToolGate } from './outside-own.ts';
import { turnOutsideRead } from './email/external-marks.ts';
import { RowSink, writeBotRow } from './bot-egress.ts';
import { released } from './testing/released.ts';
import { status } from './murage-status.ts';
import type { Message } from './store.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
useOutsideStoreFixture();
const sink = (fail = false) => new RowSink({ appendMessage: (_thread, row) => { if (fail) throw new Error('disk failed'); return { ...row, id: 'delivered', at: 1 } as Message; } });
for (const tool of ['ask_bot', 'delegate_bot']) it(`${tool}: a call and held receipt contain no peer output`, () => {
  expect(ownToolGate({ threadId: 'caller', botId: 'chief', tool, lane: true })).toBeNull();
  expect(turnOutsideRead('caller')).toBeNull();
  writeBotRow(sink(), 'caller', {}, status('withheld'));
  expect(turnOutsideRead('caller')).toBeNull();
});
for (const kind of ['active delegation result', 'staged ask later reply', 'forwarded message']) it(`${kind}: delivered peer words mark the caller`, () => {
  writeBotRow(sink(), 'caller', { from: { botId: 'peer', name: 'Peer', color: '#000' } }, released('Peer answer'));
  expect(turnOutsideRead('caller')).toBe('another bot');
});
it('preparing a reply or failing to persist it is not delivery', () => {
  const answer = released('Not delivered');
  expect(() => writeBotRow(sink(true), 'caller', { from: { botId: 'peer', name: 'Peer', color: '#000' } }, answer)).toThrow('disk failed');
  expect(turnOutsideRead('caller')).toBeNull();
});
