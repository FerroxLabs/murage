// SPDX-License-Identifier: AGPL-3.0-or-later
// In-process fixture producer owner: G2. Native adapter consumer owner: G1.
import { expect, it } from 'vitest';
import type { RuntimeEvent, SendTurnInput, SourceContext } from '../contracts.ts';
import { makeAskDriver } from './fake-ask-driver.ts';
import { makeLateTerminalDriver } from './fake-late-terminal-driver.ts';

it.each([['ask', makeAskDriver], ['late', makeLateTerminalDriver]] as const)('%s fixture keeps each turn attached to its original source context', async (_name, make) => {
  const instance = await make().create({ instanceId: 'fixture', displayName: 'Fixture', enabled: true, config: {}, environment: {} });
  const sources = new Map(['first', 'second'].map(thread => [thread, { attachment: {} } as SourceContext]));
  const observed: Array<{ event: RuntimeEvent; source?: SourceContext }> = [];
  const remove = instance.adapter.onEvent((event, source) => observed.push({ event, source }));
  try {
    await Promise.all([...sources].map(([threadId, sourceContext]) => instance.adapter.sendTurn({ threadId, sourceContext, text: 'Fixture request' } as SendTurnInput)));
    await expect.poll(() => observed.filter(({ event }) => event.type === 'turn.completed').length).toBe(2);
    expect(observed.length).toBeGreaterThan(2);
    for (const { event, source } of observed) expect(source).toBe(sources.get(event.threadId));
  } finally { remove(); await instance.adapter.stopAll(); await instance.dispose(); }
});
