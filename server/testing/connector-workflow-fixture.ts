// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture producer/consumer owner: c4-misc-a. Native publication owner: c3-drivers.
import { setTimeout } from 'node:timers/promises';

type Page = { body: { messages?: Array<{ role?: string; kind?: string; text?: string }> } };
/** Run status and the owned fake's final transcript row are separate writes.
 * Await that actual HTTP-visible reply before asserting its text and effects.
 */
export async function waitFixtureToolReply<T extends Page>(read: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const page = await read();
    if (page.body.messages?.some(message => message.role === 'bot' && message.kind === 'text'
      && typeof message.text === 'string' && /^custom tool (said|failed):/.test(message.text))) return page;
    if (Date.now() >= deadline) throw new Error('fixture tool reply did not become visible');
    await setTimeout(25);
  }
}
