// Scale/read fixtures model cards already admitted at Ask. Production's guard
// still checks their identity, action hash and durable approval record.
import { randomUUID } from 'node:crypto';
import { Store } from '../store.ts';
import type { Message } from '../store.ts';
import { database } from '../database.ts';
import { readMessage } from '../message-db.ts';
import { hash } from '../decision/bounds.ts';
import { insertRecord, isPermission, isTerminal, lookupRecord, updateRecord } from '../decision/records.ts';
import { actionProjection } from '../../shared/permission-card.ts';

export function authorizeFixtureCard(threadId: string, input: any, stableId = input.id ?? randomUUID()): any {
  if (!isPermission(input) || input.card.approvalId || isTerminal(input)) return { ...input, id: stableId };
  const id = randomUUID();
  const card = { ...input.card, approvalId: id, requestRef: input.card.requestId ?? id };
  card.actionHash = hash(actionProjection(card));
  insertRecord(database(), { id, source_kind: 'engine', service: null, thread_id: threadId,
    request_key: id, request_id: card.requestRef, bot_id: 'fixture', generation: 'fixture',
    actor_kind: 'owner', actor_via: 'owner-typed', level: 'ask', why: 'base', evidence: '{}',
    registration_hash: hash({ fixture: true }), deny_rev: '[]', input_hash: hash({}), action_hash: card.actionHash,
    presented_action: null, chat_message_id: stableId, queue_kind: null, queue_ref: null,
    state: 'open', answer: null, answer_id: null, delivery: 'none', created_at: Date.now(), settled_at: null });
  return { ...input, id: stableId, card };
}
export function settleFixtureApproval(threadId: string, messageId: string): void {
  const row = lookupRecord(database(), threadId, messageId);
  if (row?.state === 'open') updateRecord(database(), row.id, { state: 'answered', answer: 'fixture', settled_at: Date.now() });
}
export class ApprovalFixtureStore extends Store {
  override appendMessage(...args: Parameters<Store['appendMessage']>): Message {
    const [threadId, input, stableId, within, reply, lineage] = args;
    if (!isPermission(input) || isTerminal(input) || input.card?.approvalId) return super.appendMessage(...args);
    const admitted = authorizeFixtureCard(threadId, input, stableId);
    return super.appendMessage(threadId, admitted, admitted.id, within, reply, lineage);
  }
  override patchMessage(...args: Parameters<Store['patchMessage']>): Message | null {
    const [threadId, messageId, requested, within] = args;
    if (!requested.card) return super.patchMessage(...args);
    const before = readMessage(threadId, messageId);
    if (!before?.card?.approvalId) return super.patchMessage(...args);
    const patch = { ...requested, card: { ...before.card, ...requested.card } };
    if (isTerminal({ kind: before.kind, card: patch.card })) settleFixtureApproval(threadId, messageId);
    return super.patchMessage(threadId, messageId, patch, within);
  }
}

/** Real queue admission at Ask for paired small/large read fixtures. */
export async function askQueueFixture(store: Store, queue: import('../narrow-denials.ts').ProducerApprovalQueue, owners: Array<{threadId:string;botId:string}>) {
  const decision = await import('../decision/index.ts');
  const { installSynchronousQueueDeliveries } = await import('../decision/api.ts');
  const generationFor = (threadId:string) => 'read-fixture:'+threadId;
  const byThread = new Map(owners.map(owner => [owner.threadId, owner]));
  const host = decision.installDecisionHost({store,view:()=>({title:'Routine fixture',subtitle:'Ask'})});
  decision.installProvenanceReader({
    turnGenerationFor: thread => byThread.has(thread) ? generationFor(thread) : undefined,
    provenance: generation => { const owner=owners.find(value=>generationFor(value.threadId)===generation);return owner ? {generation,...owner,principal:'owner',roomOwnerOnly:true,at:1,initiator:{k:'owner-typed'}} : undefined; },
    live: thread => { const owner=byThread.get(thread);return owner ? {...owner,turnId:'fixture',providerInstanceId:'fixture',principal:'owner',owner:true,level:'ask'} : undefined; },
  });
  decision.installDenySources({revision:()=>[],resolve:()=>[]});
  const proofs = new Map(owners.map(owner=>[owner.threadId,{...owner,generation:generationFor(owner.threadId)}]));
  const claim = decision.installClaimVerifier(value => [...proofs.values()].find(proof=>proof===value));
  const source = decision.installQueueSources([{kind:queue.kind,pendingApprovals:()=>queue.pendingApprovals(),base:queue.base,
    respond:(item,answer,options)=>queue.respond(item,answer,options),cancel:(item,reason)=>queue.cancel(item,reason),renew:(item,identity)=>queue.renew(item,identity),
    reopen:item=>{const proof=proofs.get((item.proof as {threadId:string}).threadId)!;return {kind:'service' as const,service:queue.kind,claim:claim(proof)!,call:item.call};},
  }]);
  const synchronous = installSynchronousQueueDeliveries([queue]);
  return { authorityFor:(threadId:string)=>{const proof=proofs.get(threadId)!;return {proof,claim:claim(proof)!,identity:{threadId,generation:generationFor(threadId)}};},
    close:()=>{synchronous();source();host();} };
}
