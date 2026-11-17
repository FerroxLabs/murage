// SPDX-License-Identifier: AGPL-3.0-or-later
// Test host for real producer registration, presentation and owner delivery.
import { afterEach } from 'vitest';
import type { Store } from '../store.ts';
import {
  installClaimVerifier, installDecisionHost, installDenySources,
  installProvenanceReader, installQueueSources, installSynchronousQueueDeliveries,
  type Registration, type TurnProvenance, type QueueRecoverySource,
} from '../decision/index.ts';
import { serviceQueue, type ServiceAuthority } from '../narrow-denials.ts';

let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

export function serviceDecisionFixture(store: Store, actor: { botId: string; threadId: string; generation: string },
  level: () => Registration['level'] = () => 'ask',
  initiator: () => TurnProvenance['initiator'] = () => ({ k: 'owner-typed' }),
): ServiceAuthority {
  dispose?.();
  dispose = undefined;
  const host = installDecisionHost({ store, view: () => ({ title: 'Fixture', subtitle: 'Fixture' }) });
  installProvenanceReader({
    turnGenerationFor: threadId => threadId === actor.threadId ? actor.generation : undefined,
    provenance: generation => generation === actor.generation ? {
      ...actor, principal: 'owner', roomOwnerOnly: true, at: Date.now(), initiator: initiator(),
    } : undefined,
    live: threadId => threadId === actor.threadId ? {
      botId: actor.botId, turnId: actor.generation, providerInstanceId: 'fixture',
      principal: 'owner', owner: true, level: level(), fullAccessChannelMessages: true,
    } : undefined,
  });
  installDenySources({ revision: () => ['fixture'], resolve: () => [] });
  const proof = Object.freeze({ ...actor });
  const claim = installClaimVerifier(candidate => candidate === proof ? actor : undefined)(proof)!;
  const queues = ['image', 'host-computer', 'browser'] as const;
  const ports = queues.map(kind => serviceQueue(kind));
  const removeQueues = installQueueSources(ports.map((port): QueueRecoverySource => ({
    kind: port.kind, pendingApprovals: () => port.pendingApprovals(), base: port.base,
    reopen: item => item.proof === proof ? { kind: 'service', service: port.kind, claim, call: item.call } : undefined,
    respond: (item, answer, options) => port.respond(item, answer, options),
    cancel: (item, reason) => port.cancel(item, reason), renew: (item, identity) => port.renew(item, identity),
  })));
  const removeSync = installSynchronousQueueDeliveries(ports);
  dispose = () => { removeSync(); removeQueues(); host(); };
  return { claim, proof, identity: { threadId: actor.threadId, generation: actor.generation } };
}
