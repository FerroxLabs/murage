// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 72 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): a narrowing
// denial is for something the ENGINE can rewrite on its own. The same (tool,
// text) denied NARROW_DENIALS_BEFORE_CARD times in one turn raises the card
// instead, so a model that cannot narrow surfaces to the owner. Every driver
// counts through this one table.

import { trackProducerQueue } from './decision/producer-bindings.ts';
import { NARROW_DENIALS_BEFORE_CARD } from "../shared/scan-limits.ts";

export class NarrowDenials {
  private readonly counts = new Map<string, number>();

  /** Record one narrowing denial of (tool, text) on `turn`; true when this
   * one must go to the owner as a card instead of being delivered. */
  raiseCard(turn: string, tool: string, text: string): boolean {
    const key = JSON.stringify([turn, tool, text]);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next >= NARROW_DENIALS_BEFORE_CARD;
  }

  /** Forget a finished turn. */
  endTurn(turn: string): void {
    const prefix = JSON.stringify([turn]).slice(0, -1);
    for (const key of this.counts.keys()) if (key.startsWith(prefix + ",")) this.counts.delete(key);
  }
}

// Service producers share the queue protocol, never decision authority. Only
// decision/index.ts can register a call, allocate a ref or authorize execution.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic.ts';
import { DATA_DIR } from './config.ts';
import {
  openRequest, decide, executeService, readTurnPolicy, executeServiceSync, presentApprovalSync, answerApprovalSync, attachQueue, presentApproval, readApproval, answerApproval, settle,
  type ExecutionClaim, type ServiceId, type ServiceCall, type ServiceApprovalAction,
  type ApprovalRef, type ApprovalView, type ApprovalAnswer, type RequestHandle,
  type Outcome, type PendingQueueApproval, type QueueRenewal, type QueueCancellationReason,
  type BaseVerdictFn, type ServiceExecution, type TurnIdentity,
} from './decision/index.ts';
import type { RequestAnswerOptions, RequestDelivery } from './contracts.ts';
import type { AutoVerdict } from './auto-approve.ts';

export interface ServiceAuthority { readonly claim: ExecutionClaim; readonly proof: unknown; readonly identity?: TurnIdentity }
export type ServiceAuthorityReader = (threadId: string, botId: string) => ServiceAuthority | undefined;
export interface ProducerRequest {
  authority: ServiceAuthority | undefined; ref?: string; epoch?: string;
  tool: string; input: unknown; action: ServiceApprovalAction; view: ApprovalView; base: AutoVerdict;
}
export interface OpenProducerRequest {
  readonly handle: RequestHandle; readonly outcome: Outcome;
  readonly item: Omit<PendingQueueApproval, 'approvalId'>; readonly base: AutoVerdict; readonly baseBranch: boolean;
}
type QueueEntry = { renewedFrom?: PendingQueueApproval; progress?:Record<string,unknown>; item: PendingQueueApproval; base: AutoVerdict; state: 'waiting' | 'pending' | 'accepted' | 'failed' | 'cancelled'; answerId?: string; answer?: ApprovalAnswer };
type Accept = (item: PendingQueueApproval, answer: ApprovalAnswer) => void | Promise<void>;
const MAX_QUEUE_BYTES = 1024 * 1024;
function copy<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_QUEUE_BYTES) throw new Error('approval-queue-capacity');
  return JSON.parse(serialized) as T;
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export const producerBase = (ask: boolean): AutoVerdict => ({approve: ask ? null : 'existing permission', source: ask ? 'no-grant' : 'always-allow'});
/** Durable metadata is a source reference, never a saved claim or an actor.
 * S4 binds these methods on the actual producer instance into QueueRecoverySource
 * and supplies reopen via its verifier. A missing live/recovery delivery rejects.
 */
export class ProducerApprovalQueue {
  readonly kind: ServiceId;
  private readonly file: string;
  private entries = new Map<string, QueueEntry>();
  private accepts = new Map<string, Accept>();
  private toolAccepts=new Map<string,Accept>();
  private toolAcceptsNow=new Map<string,(item:PendingQueueApproval,answer:ApprovalAnswer)=>void>();
  private acceptsNow = new Map<string, (item:PendingQueueApproval,answer:ApprovalAnswer)=>void>();
  private flights = new Map<string, Promise<RequestDelivery>>();
  private respondingNow = new Set<string>();
  private readonly recoveredAccept?: Accept;
  private readonly recoveredAcceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer)=>void;
  constructor(kind: ServiceId, file = join(DATA_DIR, 'decision-queues', `${kind}.json`), recoveredAccept?: Accept, recoveredAcceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer)=>void) {
    this.kind = kind; this.file = file; this.recoveredAccept = recoveredAccept??((_item,answer)=>{if(answer.behavior==='allow')throw new Error('approval-queue-delivery-unavailable');}); this.recoveredAcceptNow = recoveredAcceptNow??((_item,answer)=>{if(answer.behavior==='allow')throw new Error('approval-queue-delivery-unavailable');});
    try {
      const text = readFileSync(file, 'utf8');
      if (Buffer.byteLength(text) > MAX_QUEUE_BYTES) throw new Error('approval-queue-capacity');
      const parsed = JSON.parse(text);
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 1280) throw new Error('approval-queue-format');
      for (const entry of parsed.entries as QueueEntry[]) {
        const item = entry?.item;
        if (!item || item.kind !== kind || !item.approvalId || !item.ref || !item.epoch || !item.call?.approval || item.call.approval.queueRef !== item.ref || item.call.approval.epoch !== item.epoch || !['waiting','pending','accepted','failed','cancelled'].includes(entry.state)) throw new Error('approval-queue-format');
        if (this.entries.has(item.ref)) throw new Error('approval-queue-conflict');
        this.entries.set(item.ref, entry);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    trackProducerQueue(this);
  }
  private commit(next: Map<string, QueueEntry>): void {
    const terminalEntry=(entry:QueueEntry)=>entry.state==='cancelled'||entry.state==='accepted'&&(entry.item.call.tool!=='request_browser_connection'||entry.progress?.resumed===true);
    const waiting = [...next.values()].filter(entry=>!terminalEntry(entry));
    if (waiting.length > 256) throw new Error('approval-queue-capacity');
    const terminal = [...next.values()].filter(terminalEntry).slice(-1024);
    const entries = [...terminal, ...waiting];
    const serialized = JSON.stringify({version:1, entries});
    if (Buffer.byteLength(serialized) > MAX_QUEUE_BYTES) throw new Error('approval-queue-capacity');
    mkdirSync(dirname(this.file), {recursive:true,mode:0o700});
    writeFileAtomic(this.file, serialized, {mode:0o600,syncDir:true});
    this.entries = new Map(entries.map(entry=>[entry.item.ref,entry]));
  }
  private replace(entry: QueueEntry): void { const next = new Map(this.entries); next.set(entry.item.ref,entry); this.commit(next); }
  private exact(item: PendingQueueApproval): QueueEntry {
    const entry = this.entries.get(item.ref);
    if (!entry || !same(entry.item,item)) throw new Error('approval-queue-conflict');
    return entry;
  }
  open(input: ProducerRequest): OpenProducerRequest {
    if (!input.authority) throw new Error('A verified service execution claim is required.');
    const ref = input.ref ?? randomUUID(), epoch = input.epoch ?? randomUUID();
    const call = frozen(copy({tool:input.tool,input:input.input,approval:{queueRef:ref,epoch,action:input.action}}));
    const handle = openRequest({kind:'service',service:this.kind,claim:input.authority.claim,call});
    const base = frozen(copy(input.base));
    let baseBranch=false;
    const outcome = decide(handle,()=>{baseBranch=true;return base;});
    return {handle,outcome,base,baseBranch,item:frozen(copy({kind:this.kind,ref,epoch,call,view:input.view,proof:input.authority.proof}))};
  }
  execute<T>(request: OpenProducerRequest, operation: (call: ServiceCall)=>Promise<T>): Promise<ServiceExecution<T>> {
    if (request.outcome.kind !== 'run') return Promise.resolve(request.outcome);
    return executeService(request.handle, operation);
  }
  stage(request:OpenProducerRequest,ref:ApprovalRef):PendingQueueApproval {
    const item=frozen(copy({...request.item,approvalId:ref.approvalId}));
    const prior=this.entries.get(item.ref);
    if(prior&&!same(prior.item,item)){
      if(!['accepted','cancelled'].includes(prior.state)||prior.item.epoch===item.epoch||prior.item.approvalId===item.approvalId)throw new Error('approval-queue-conflict');
      this.replace({item,base:request.base,state:'waiting'});
    }
    if(!prior)this.replace({item,base:request.base,state:'waiting'});
    return item;
  }
  async present(request: OpenProducerRequest, ref: ApprovalRef, accept?: Accept, acceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer)=>void): Promise<PendingQueueApproval> {
    const item=this.stage(request,ref); // queue FIRST, fsynced
    if (accept) this.accepts.set(item.ref,accept);
    if (acceptNow) this.acceptsNow.set(item.ref,acceptNow);
    attachQueue(ref,{kind:this.kind,ref:item.ref,call:item.call});
    await presentApproval(ref,item.view); // S1 commits record + row together
    return item;
  }
  executeNow<T>(request:OpenProducerRequest,operation:(call:ServiceCall)=>T):ServiceExecution<T> {
    if(request.outcome.kind!=='run')return request.outcome;
    return executeServiceSync(request.handle,operation);
  }
  presentNow(request:OpenProducerRequest,ref:ApprovalRef,accept?:(item:PendingQueueApproval,answer:ApprovalAnswer)=>void):PendingQueueApproval {
    const item=this.stage(request,ref);
    if(accept){this.accepts.set(item.ref,accept);this.acceptsNow.set(item.ref,accept);}
    attachQueue(ref,{kind:this.kind,ref:item.ref,call:item.call});presentApprovalSync(ref,item.view);
    return item;
  }
  respondNow(item:PendingQueueApproval,answer:ApprovalAnswer,options:Readonly<RequestAnswerOptions>):RequestDelivery {
    const entry=this.exact(item);
    if(!options.answerId||entry.state==='cancelled'||this.respondingNow.has(item.ref)||this.flights.has(item.ref)||entry.answerId&&(entry.answerId!==options.answerId||!same(entry.answer,answer)))return {state:'failed'};
    if(entry.state==='accepted')return {state:'already'};
    const accept=this.acceptsNow.get(item.ref)??this.toolAcceptsNow.get(item.call.tool)??this.toolAcceptsNow.get(String(item.call.approval.action.tool))??this.recoveredAcceptNow;
    if(!accept)return {state:'failed'};
    this.replace({...entry,state:'pending',answerId:options.answerId,answer:copy(answer)});
    this.respondingNow.add(item.ref);
    try{const returned:unknown=accept(item,answer);if(returned && typeof (returned as PromiseLike<unknown>).then==='function')throw new Error('approval-queue-delivery-unavailable');this.replace({...this.exact(item),state:'accepted'});this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);return {state:'accepted'};}
    catch{this.replace({...this.exact(item),state:'failed'});return {state:'failed'};}
    finally{this.respondingNow.delete(item.ref);}
  }
  answerNow(approvalId:string,answer:ApprovalAnswer):RequestDelivery {
    const record=readApproval(approvalId);
    if(!record||record.queue?.kind!==this.kind||!this.entries.has(record.queue.ref))return {state:'failed'};
    const entry=this.entries.get(record.queue.ref)!;
    if(entry.item.approvalId!==approvalId||entry.item.epoch!==record.queue.epoch)return {state:'failed'};
    return answerApprovalSync(record.ref,answer);
  }
  bindAcceptance(tool: string, accept: Accept): () => void {
    this.toolAccepts.set(tool, accept);
    return () => { if (this.toolAccepts.get(tool) === accept) this.toolAccepts.delete(tool); };
  }
  registerDelivery(tool:string,accept:Accept,acceptNow?:(item:PendingQueueApproval,answer:ApprovalAnswer)=>void):void {
    this.toolAccepts.set(tool,accept);if(acceptNow)this.toolAcceptsNow.set(tool,acceptNow);
  }
  progressFor(ref:string):Readonly<Record<string,unknown>> {return frozen(copy(this.entries.get(ref)?.progress??{}));}
  updateProgress(ref:string,patch:Record<string,unknown>):void {
    const entry=this.entries.get(ref);if(!entry)throw new Error('approval-queue-conflict');
    this.replace({...entry,progress:copy({...entry.progress,...patch})});
  }
  async idle(ref:string):Promise<void> { await this.flights.get(ref); }
  /** Settled browser setup remains a durable continuation after its card
   * leaves the open-card index. Consumed continuations can be compacted. */
  continuations(tool:string):readonly PendingQueueApproval[] {
    return frozen(copy([...this.entries.values()].filter(entry=>entry.item.call.tool===tool&&entry.state!=='cancelled'&&entry.progress?.resumed!==true).map(entry=>entry.item)));
  }
  pendingApprovals(): readonly PendingQueueApproval[] {
    return frozen(copy([...this.entries.values()].filter(entry=>!['accepted','cancelled'].includes(entry.state)).map(entry=>entry.item)));
  }
  readonly base: BaseVerdictFn = registration => {
    if (registration.source.kind !== 'service' || registration.source.service !== this.kind) throw new Error('approval-queue-conflict');
    const entry = this.entries.get(registration.source.call.approval?.queueRef ?? '');
    if (!entry || !same(entry.item.call,registration.source.call)) throw new Error('approval-queue-conflict');
    return frozen(copy(entry.base));
  };
  respond(item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>): Promise<RequestDelivery> {
    const entry = this.exact(item);
    if (!options.answerId || this.respondingNow.has(item.ref) || entry.state==='cancelled' || entry.answerId && (entry.answerId!==options.answerId || !same(entry.answer,answer))) return Promise.resolve({state:'failed'});
    if (entry.state==='accepted') return Promise.resolve({state:'already'});
    const flying = this.flights.get(item.ref); if (flying) return flying;
    const accept = this.accepts.get(item.ref) ?? this.toolAccepts.get(item.call.tool) ?? this.toolAccepts.get(String(item.call.approval.action.tool)) ?? this.recoveredAccept;
    if (!accept) return Promise.resolve({state:'failed'});
    this.replace({...entry,state:'pending',answerId:options.answerId,answer:copy(answer)});
    // Invoke in the same tick after durable pending, but keep the join promise
    // installed before any asynchronous delivery/acknowledgement can complete.
    let complete!: (delivery: RequestDelivery)=>void;
    const done = new Promise<RequestDelivery>(resolve=>{complete=resolve;}); this.flights.set(item.ref,done);
    void (async()=>{
      try { await accept(item,answer); this.replace({...this.exact(item),state:'accepted'}); this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref); complete({state:'accepted'}); }
      catch { this.replace({...this.exact(item),state:'failed'}); complete({state:'failed'}); }
      finally { this.flights.delete(item.ref); }
    })().catch(()=>{this.flights.delete(item.ref);complete({state:'failed'});});
    return done;
  }
  async cancel(item: PendingQueueApproval, _reason: QueueCancellationReason): Promise<void> {
    const entry = this.exact(item); if (entry.state==='cancelled') return;
    if (entry.state==='accepted' || this.respondingNow.has(item.ref) || this.flights.has(item.ref) || entry.state==='pending') throw new Error('approval-queue-conflict');
    const accept = this.accepts.get(item.ref) ?? this.toolAccepts.get(item.call.tool) ?? this.toolAccepts.get(String(item.call.approval.action.tool)) ?? this.recoveredAccept;
    if (!accept) throw new Error('approval-queue-delivery-unavailable');
    await accept(item,{behavior:'deny'});
    this.replace({...this.exact(item),state:'cancelled'}); this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);
  }
  async renew(item: PendingQueueApproval, identity: QueueRenewal): Promise<PendingQueueApproval> {
    const entry = this.entries.get(item.ref);
    if (entry?.item.approvalId===identity.approvalId && entry.item.epoch===identity.epoch) {
      if(!same(entry.renewedFrom,item))throw new Error('approval-queue-conflict');
      return frozen(copy(entry.item));
    }
    this.exact(item);
    if (entry!.state==='accepted' || entry!.state==='pending' || this.flights.has(item.ref) || !identity.approvalId || !identity.epoch || identity.approvalId===item.approvalId || identity.epoch===item.epoch) throw new Error('approval-queue-conflict');
    this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);
    const replacement = frozen(copy({...item,...identity,call:{...item.call,approval:{...item.call.approval,epoch:identity.epoch}}}));
    this.replace({item:replacement,renewedFrom:copy(item),base:entry!.base,state:'waiting'});
    return replacement;
  }
  /** Only an authenticated owner route calls this. Never reconstruct a ref. */
  async answer(approvalId: string, answer: ApprovalAnswer): Promise<void> {
    const record = readApproval(approvalId);
    if (!record || record.state!=='open' || record.queue?.kind!==this.kind) throw new Error('approval-queue-conflict');
    const entry = this.entries.get(record.queue.ref);
    if (!entry || entry.item.approvalId!==approvalId || entry.item.epoch!==record.queue.epoch) throw new Error('approval-queue-conflict');
    await answerApproval(record.ref,answer);
  }
  async stop(approvalId: string): Promise<void> {
    const record = readApproval(approvalId); if (record?.state==='open') await settle(record.ref,'cancelled');
  }
}

export interface ProducerWait {
  signal?: AbortSignal;
  handoff?:()=>boolean;
  settled?:(answer:ApprovalAnswer)=>void;
  handedOff?:(answer:ApprovalAnswer)=>void;
  presented?: (item: PendingQueueApproval, messageId: string) => void;
}
/** Adapter for services whose existing executor is suspended at an approval
 * boundary. Transport acceptance releases exactly this waiter. Durable recovery
 * must supply the producer's delivery callback, otherwise it fails explicitly.
 */
export async function waitForProducerApproval(queue: ProducerApprovalQueue, input: ProducerRequest, hooks: ProducerWait = {}): Promise<'allow' | 'deny' | 'cancelled'> {
  if (hooks.signal?.aborted) return 'cancelled';
  const request = queue.open(input);
  const execution = await queue.execute(request,async()=>true);
  if (execution.kind==='executed') return 'allow';
  if (execution.kind==='refuse') throw new Error(execution.message);
  let finish!: (value: 'allow'|'deny'|'cancelled')=>void;
  const answer = new Promise<'allow'|'deny'|'cancelled'>(resolve=>{finish=resolve;});
  let detached=false;
  const aborted = () => { if(hooks.handoff?.()){detached=true;finish('cancelled');return;}void queue.stop(execution.ref.approvalId).then(()=>finish('cancelled'),()=>finish('cancelled')); };
  const accept=(_item:PendingQueueApproval,response:ApprovalAnswer)=>{
    const state=readApproval(_item.approvalId)?.state;
    if(state==='cancelled'||state==='expired'||state==='superseded'){finish('cancelled');return;}
    if(detached){if(!hooks.handedOff)throw new Error('approval-queue-delivery-unavailable');hooks.handedOff(response);return;}
    hooks.settled?.(response);finish(response.behavior==='allow'?'allow':'deny');
  };
  await queue.present(request,execution.ref,accept,accept);
  const record = readApproval(execution.ref.approvalId);
  if (!record || record.queue?.kind!==queue.kind) throw new Error('approval-queue-conflict');
  hooks.presented?.({...request.item,approvalId:execution.ref.approvalId},record.chatMessageId);
  hooks.signal?.addEventListener('abort',aborted,{once:true});
  if (hooks.signal?.aborted) aborted();
  try { return await answer; } finally { hooks.signal?.removeEventListener('abort',aborted); }
}
export async function answerProducerRequest(queue: ProducerApprovalQueue, threadId: string, requestId: string, behavior: string | undefined): Promise<boolean> {
  if (behavior!=='allow' && behavior!=='deny') return false;
  const item = queue.pendingApprovals().find(item=>item.ref===requestId);
  if (!item) return false;
  const record = readApproval(item.approvalId);
  if (!record || record.threadId!==threadId || record.requestId!==requestId) return false;
  await queue.answer(item.approvalId,{behavior}); return true;
}

const liveQueues = new Map<ServiceId, ProducerApprovalQueue>();
export function serviceQueue(kind: ServiceId): ProducerApprovalQueue {
  let queue = liveQueues.get(kind);
  if (!queue) { queue = new ProducerApprovalQueue(kind); liveQueues.set(kind,queue); }
  return queue;
}

/** An observation used to skip BASE-only guards; execution still registers the
 * exact request and rechecks deny at executeService. Missing identity never widens. */
export function serviceOwnerNoLimits(authority: ServiceAuthority | undefined): boolean {
  if(!authority?.identity)return false;
  return readTurnPolicy(authority.identity)?.permission.noLimits===true;
}

export function answerProducerRequestSync(queue:ProducerApprovalQueue,threadId:string,requestId:string,behavior:string|undefined):boolean {
  if(behavior!=='allow'&&behavior!=='deny')return false;
  const item=queue.pendingApprovals().find(item=>item.ref===requestId);if(!item)return false;
  const record=readApproval(item.approvalId);if(record?.threadId!==threadId||record.requestId!==requestId)return false;
  const delivered=queue.answerNow(item.approvalId,{behavior});return delivered.state==='accepted'||delivered.state==='already';
}

/** S4's staged-skill call site supplies the exact staged write and its existing
 * revision-checked executor. This adapter owns registration and queue delivery;
 * it never derives authority from the card or invents an owner click. */
export function requestSkillApproval<T>(input: ProducerRequest, execute: (call: ServiceCall) => T): ServiceExecution<T> {
  const queue=serviceQueue('skill');
  const ref=input.ref??randomUUID();
  const payload=input.action.skillRequest;
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('approval-queue-conflict');
  const request=queue.open({...input,ref,action:{...input.action,requestId:ref,skillRequest:{...payload,id:ref}}});
  const result=queue.executeNow(request,execute);
  if(result.kind==='executed'||result.kind==='refuse')return result;
  queue.presentNow(request,result.ref,(item,answer)=>{if(answer.behavior==='allow')execute(item.call);});
  return result;
}
