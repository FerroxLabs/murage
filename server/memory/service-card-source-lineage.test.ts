// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A queued service approval card quotes what the producing turn wrote, so it rests on that turn's inputs and is withheld when they are
// revoked: through a synthetic service context (routine offer, No limits; it reads no live turn) and across a restart (the provider-turn
// map is process-local, so the queued view keeps the source's own parents and the position its turn began at). The real Store, message
// database, lineage, deny reads, index.ts wiring (decision-wiring/fixture.ts) and decision recovery from the persisted queue.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import * as decision from '../decision/index.ts';
import { bindProducerSourceTurn } from '../decision/producer-bindings.ts';
import { wiring } from '../decision-wiring/fixture.ts';
import { closeMessageDb, appendMessage } from '../message-db.ts';
import { ProducerApprovalQueue } from '../narrow-denials.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { serviceQueueFixture, type ServiceFixtureTurn } from '../testing/service-queue-fixture.ts';
import { denyLookup } from './deny-read.ts';
import { lineOf } from './revoke-marker.ts';
import { addTurnParents, bindProviderTurn, closeThreadTurns, closeTurnLineage, memberTurnId, openTurnLineage } from './lineage-write.ts';
import type { TurnLineage } from './lineage-types.ts';
import { CONTENT, WritetimeFixture } from './testing/writetime-fixture.ts';

const P = 'parent-conversation', T = 'source-thread';
let turn: TurnLineage | undefined;
const releases: Array<() => void> = [];
beforeEach(() => {
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  new WritetimeFixture(database()).cert(true);
  database().exec("UPDATE memory_scopes SET audience='[]' WHERE json_type(audience)<>'array'");
});
afterEach(() => { if (turn) closeTurnLineage(turn); turn = undefined; closeThreadTurns(T); for (const release of releases.splice(0)) release(); });

const owner = (id: string) => ({ id, role: 'user' as const, kind: 'text' as const, text: id, at: Date.now() });
/** A revoke of `messageId` in flight, committed at `committedAt` (the line's own position when not given). */
function revoke(threadId: string, messageId: string, committedAt?: number): void {
  const lsn = lineOf(database(), threadId, messageId)!.lsn;
  database().prepare("INSERT INTO memory_revoke_jobs(revoke_id,kind,root,root_lsn,started_lsn,phase,cursor,state) VALUES(50,'line',?,?,?,'mark','','active')").run(JSON.stringify({ kind: 'line', cause: 'forget' }), lsn, committedAt ?? lsn);
  database().prepare('INSERT INTO memory_deny_pending(thread_id,since_lsn,revoke_id) VALUES(?,?,50)').run(threadId, lsn);
}
/** The producing turn holds p1 of another conversation, whose revoke is in flight; its provider turn is `prov-s`. */
function sourceTurn(): void {
  appendMessage(P, owner('p1'));
  appendMessage(T, owner('u1'));
  revoke(P, 'p1');
  turn = openTurnLineage(database(), { threadId: T, turnId: memberTurnId('bot') });
  addTurnParents(turn, [{ kind: 'line', threadId: P, messageId: 'p1' }]);
  bindProviderTurn(turn, 'prov-s');
}
function fixture(policy: ServiceFixtureTurn) {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const producer = serviceQueueFixture(store, { persisted: true });
  const file = join(DATA_DIR, 'fixture-queue.json');
  const queue = new ProducerApprovalQueue('peer', file);
  producer.queue(queue);
  const authority = producer.authorityFor(T, 'bot', policy);
  const open = () => { const ref = randomUUID(); return queue.open({ ref, authority, tool: 'ask_bot', input: { targetBotId: 'target', message: 'Fixture contact' },
    action: { requestId: ref, tool: 'ask_bot', options: ['Allow', 'Deny'] }, view: { title: 'Contact', subtitle: 'Fixture contact' }, base: { approve: null, source: 'no-grant' } }); };
  return { store, producer, queue, authority, open, file };
}
const stateOf = (approvalId: string) => {
  const id = decision.readApproval(approvalId)!.chatMessageId;
  return denyLookup(database(), { threadId: T, lines: [{ messageId: id, author: 'generated' }] }, CONTENT).get(id)?.state;
};
/** The process restarted with the request queued and its card not yet presented: no open turn, no provider-turn map, no live decision
 * entry. The queue is read back from its file and decision recovery presents the card from the persisted view. */
async function restartAndRecover(f: ReturnType<typeof fixture>): Promise<decision.PendingQueueApproval> {
  if (turn) closeTurnLineage(turn); turn = undefined; closeThreadTurns(T);
  const reopened = new ProducerApprovalQueue('peer', f.file);
  f.producer.queue(reopened);
  releases.push(decision.installDecisionHost({ store: f.store, view: () => ({ title: 'Fixture action', subtitle: 'Fixture' }) }));
  expect(decision.openApprovals(), 'nothing was presented before the restart').toEqual([]);
  await decision.recover();
  const recovered = reopened.pendingApprovals();
  expect(recovered).toHaveLength(1);
  expect(decision.readApproval(recovered[0]!.approvalId)?.state, 'recovery presented the queued card').toBe('open');
  return recovered[0]!;
}

describe('a queued service approval card rests on the source that produced it', () => {
  it.each(['no-limits', 'routine-offer'])('the index.ts %s service context keeps the turn that produced the proposal', async mode => {
    sourceTurn();
    const parent = 'parent-generation', principal = { personId: 'workspace-owner', revision: 1 };
    // the routine offer runs under its own generation; No limits keeps the initiating one
    const generation = mode === 'no-limits' ? parent : 'routine-offer:fixture';
    const f = fixture({ turnId: '', generation });
    const token = { generation: parent, threadId: T, botId: 'bot' };
    const { withRoutineProposalAuthority } = wiring(['withRoutineProposalAuthority', 'decisionLiveIdentity'], {
      bindProducerSourceTurn, serviceNoLimits: () => mode === 'no-limits', issueDecisionAuthority: async () => f.authority,
      internalTurnOwners: new Map([[T, { generation: parent }]]), turnEngineByThread: new Map([[T, { instanceId: 'fixture' }]]),
      internalCapabilities: { isActive: (value: unknown) => value === token, providerTurnOf: (threadId: string, held: string) => threadId === T && held === parent ? 'prov-s' : undefined },
      turnAttribution: { attempt: () => undefined },
      decisionProvenance: new Map([[parent, { ...token, principal: JSON.stringify(principal) }]]), threadHumanPrincipal: () => principal,
      randomUUID: () => 'fixture', decisionServiceContext: new AsyncLocalStorage<unknown>(), decisionHttpProofs: new WeakMap(),
      issueDecisionClaim: () => ({}), saveContinuation: async () => {}, deleteContinuation: async () => {}, routineRequests: { pendingApprovals: () => [] },
    });
    await withRoutineProposalAuthority(token, async (authority: { identity: { generation: string } }) => {
      expect(authority.identity.generation).toBe(generation);
      const request = f.open();
      if (request.outcome.kind !== 'card') throw new Error('expected Ask approval');
      expect(request.item.view.turnId).toBe('prov-s');
      f.queue.presentNow(request, request.outcome.ref, () => {});
      expect(stateOf(request.outcome.ref.approvalId), 'withheld with the source turn inputs').toBe('checking');
    });
    expect(f.open().item.view.turnId, 'the source turn is unbound when the service context ends').toBeUndefined();
  });
  it('keeps the source parents when the card is presented by recovery after a restart', async () => {
    sourceTurn();
    const f = fixture({ turnId: 'prov-s' });
    const request = f.open();
    if (request.outcome.kind !== 'card') throw new Error('expected Ask approval');
    f.queue.stage(request, request.outcome.ref); // durable in the queue; the process stops before the card is presented
    const recovered = await restartAndRecover(f);
    expect(recovered.view.parents).toEqual([{ kind: 'line', threadId: P, messageId: 'p1' }]);
    expect(stateOf(recovered.approvalId), 'withheld on the persisted parents').toBe('checking');
  });
  it('keeps where the source turn began: a same-thread source revoked while the card was queued withholds it after a restart', async () => {
    appendMessage(T, owner('u1')); // the source the turn read: a line of its own thread, so positional, never a ref
    turn = openTurnLineage(database(), { threadId: T, turnId: memberTurnId('bot') });
    bindProviderTurn(turn, 'prov-s');
    const began = turn.turnLsn;
    const f = fixture({ turnId: 'prov-s' });
    const request = f.open();
    if (request.outcome.kind !== 'card') throw new Error('expected Ask approval');
    f.queue.stage(request, request.outcome.ref);
    // the owner forgets u1 after the turn began and before the card is presented
    appendMessage(T, owner('u2'));
    const committed = lineOf(database(), T, 'u2')!.lsn;
    expect(committed, 'the revoke commits after the source turn began').toBeGreaterThan(began);
    revoke(T, 'u1', committed);
    const recovered = await restartAndRecover(f);
    expect(recovered.view.began).toBe(began);
    expect(stateOf(recovered.approvalId), 'the recovered card is of a turn begun before the revoke committed').toBe('checking');
    // a line of a turn begun after the commit is not held: the hold above is the source position, not a blanket one
    const later = openTurnLineage(database(), { threadId: T, turnId: memberTurnId('bot') });
    try {
      appendMessage(T, { id: 'r-later', role: 'bot', kind: 'text', text: 'later', at: Date.now(), from: { botId: 'bot', name: 'bot', color: '#000000' } });
      expect(denyLookup(database(), { threadId: T, lines: [{ messageId: 'r-later', author: 'generated' }] }, CONTENT).get('r-later')?.state).not.toBe('checking');
    } finally { closeTurnLineage(later); }
  });
});
