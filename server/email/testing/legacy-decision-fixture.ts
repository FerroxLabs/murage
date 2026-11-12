// SPDX-License-Identifier: AGPL-3.0-or-later
// Legacy email policy tests use real claims and the shared approval queue at Ask.
import { afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../../store.ts';
import * as decision from '../../decision/index.ts';
import { installSynchronousQueueDeliveries } from '../../decision/api.ts';
import { serviceQueue, type ServiceAuthority } from '../../narrow-denials.ts';
let release = async () => {};
afterEach(async () => { await release(); release = async () => {}; });
export async function legacyEmailDecisionFixture(options: { kind?: 'email' | 'publish'; store?: Store; botId?: string; threadId?: string; generation?: string; level?: 'ask' | 'unlimited' } = {}): Promise<ServiceAuthority> {
  await release();
  const { botId = 'b1', threadId = 't1', generation = randomUUID(), store = new Store(), kind = 'email', level = 'ask' } = options;
  const queue = serviceQueue(kind);
  const host = decision.installDecisionHost({ store, view: () => ({ title: 'Email fixture', subtitle: 'Email policy' }) });
  decision.installProvenanceReader({
    turnGenerationFor: thread => thread === threadId ? generation : undefined,
    provenance: () => ({ generation, botId, threadId, principal: 'owner', roomOwnerOnly: true, at: 1, initiator: { k: 'owner-typed' } }),
    live: thread => thread === threadId ? { botId, turnId: 'fixture-turn', providerInstanceId: 'fixture', principal: 'owner', owner: true, level } : undefined,
  });
  decision.installDenySources({ revision: () => [], resolve: () => [] });
  const proof = { botId, threadId, generation };
  const claim = decision.installClaimVerifier(value => value === proof ? proof : undefined)(proof)!;
  const sources = decision.installQueueSources([{ kind, pendingApprovals: () => queue.pendingApprovals(), base: queue.base,
    respond: (item, answer, options) => queue.respond(item, answer, options), cancel: (item, reason) => queue.cancel(item, reason),
    renew: (item, identity) => queue.renew(item, identity), reopen: item => ({ kind: 'service' as const, service: kind, claim, call: item.call }),
  }]);
  const synchronous = installSynchronousQueueDeliveries([queue]);
  release = async () => {
    await decision.cancelRequests({ kind: 'thread', threadId }, 'cancelled');
    for (const item of queue.pendingApprovals()) await queue.cancel(item, 'cancelled');
    synchronous(); sources(); host();
  };
  return { claim, proof, identity: { threadId, generation } };
}
