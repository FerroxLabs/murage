import {skillSettlementWork} from './skill-settlement-work.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Rule 72 (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md): a narrowing
// denial is for something the ENGINE can rewrite on its own. The same (tool,
// text) denied NARROW_DENIALS_BEFORE_CARD times in one turn raises the card
// instead, so a model that cannot narrow surfaces to the owner. Every driver
// counts through this one table.

import { producerTurnId, trackProducerQueue } from './decision/producer-bindings.ts';
import { turnOfProvider } from './memory/lineage-write.ts';
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
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic, syncParentDirectoryStatus } from './atomic.ts';
import { parseSwitchMetadata, SWITCH_LIMITS } from './skill-switch-bounds.ts';
import { automaticSettlement, SkillSwitchRefused, UNCONFIRMED_SKILL_SWITCH, type Settlement, type SkillDeliveryContext, type EffectAuthorization } from './skill-switch-settlement.ts';
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
type QueueEntry = { version?: 2; authorization?: EffectAuthorization; result?: string; code?: string; attemptId?: string; renewedFrom?: PendingQueueApproval; progress?:Record<string,unknown>; item: PendingQueueApproval; base: AutoVerdict; state: 'waiting' | 'pending' | 'accepted' | 'failed' | 'cancelled' | 'pending-before-effect' | 'effect-started' | 'unconfirmed' | 'not-run' | 'cancelled-before-effect'; answerId?: string; answer?: ApprovalAnswer };
type Accept = (item: PendingQueueApproval, answer: ApprovalAnswer, delivery?: SkillDeliveryContext) => void | Promise<void>;
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
/** These cards deliver into a process-local waiting call or review. Persistent proposals on the same queue keep their own owner. */
export function requiresLiveApprovalRecipient(item: PendingQueueApproval): boolean {
  return item.kind === 'image' && item.call.tool === 'generate_image'
    || item.kind === 'publish' && (item.call.tool === 'publish_site' || item.call.tool === 'take_down_site')
    || item.kind === 'bot-access' && item.ref.startsWith('highlevel-');
}

/** Durable metadata is a source reference, never a saved claim or an actor.
 * S4 binds these methods on the actual producer instance into QueueRecoverySource
 * and supplies reopen via its verifier. A missing live/recovery delivery rejects.
 */
export class ProducerApprovalQueue {
  readonly kind: ServiceId;
  private readonly file: string;
  private entries = new Map<string, QueueEntry>();
  private confirmedAccepts=new Set<string>();
  private switchDeliveries=0;
  private switchTail=Promise.resolve();
  private switchCount=0;
  private waitingCount=0;
  private serializedBytes=0;
  private byApproval = new Map<string, string>();
  private byProof = new Map<string,number>();
  private pendingKeys: string[] = [];
  private accepts = new Map<string, Accept>();
  private toolAccepts=new Map<string,Accept>();
  private toolAcceptsNow=new Map<string,(item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void>();
  private acceptsNow = new Map<string, (item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void>();
  private flights = new Map<string, Promise<RequestDelivery>>();
  private respondingNow = new Set<string>();
  private readonly recoveredAccept?: Accept;
  private readonly recoveredAcceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void;
  constructor(kind: ServiceId, file = join(DATA_DIR, 'decision-queues', `${kind}.json`), recoveredAccept?: Accept, recoveredAcceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void) {
    this.kind = kind; this.file = file; this.recoveredAccept = recoveredAccept??((_item,answer)=>{if(answer.behavior==='allow')throw new Error('approval-queue-delivery-unavailable');}); this.recoveredAcceptNow = recoveredAcceptNow??((_item,answer)=>{if(answer.behavior==='allow')throw new Error('approval-queue-delivery-unavailable');});
    try {
      const parsed = parseSwitchMetadata(file) as { version: number; entries: QueueEntry[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 1280) throw new Error('approval-queue-format');
      for (const entry of parsed.entries as QueueEntry[]) {
        const item = entry?.item;
        if (!item || item.kind !== kind || !item.approvalId || !item.ref || !item.epoch || !item.call?.approval || item.call.approval.queueRef !== item.ref || item.call.approval.epoch !== item.epoch || !['waiting','pending','accepted','failed','cancelled','pending-before-effect','effect-started','unconfirmed','not-run','cancelled-before-effect'].includes(entry.state)) throw new Error('approval-queue-format');
        if (this.entries.has(item.ref)) throw new Error('approval-queue-conflict');
        this.entries.set(item.ref, entry);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if([...this.entries.values()].some(entry=>entry.item.call.tool==='switch_skill')){try{if(syncParentDirectoryStatus(this.file)==='synced')for(const entry of this.entries.values())if(entry.item.call.tool==='switch_skill'&&entry.state==='accepted')this.confirmedAccepts.add(entry.item.ref);}catch{/* Existing fences still exclude execution. */}}
    this.reindex();
    if(this.switchCount>1024||this.waitingCount>256)throw new Error('approval-queue-capacity');
    trackProducerQueue(this);
  }
  private reindex(): void {
    this.byApproval = new Map();this.byProof=new Map(); this.pendingKeys = [];this.switchCount=0;this.waitingCount=0;
    this.serializedBytes=Buffer.byteLength(JSON.stringify({version:1,entries:[...this.entries.values()]}));
    for (const entry of this.entries.values()) {
      this.byApproval.set(entry.item.approvalId, entry.item.ref);
      if(!['accepted','cancelled','cancelled-before-effect','not-run','unconfirmed'].includes(entry.state)){const key=JSON.stringify(entry.item.proof)??'';this.byProof.set(key,(this.byProof.get(key)??0)+1);}
      if(entry.item.call.tool==='switch_skill')this.switchCount++;
      if(!['accepted','cancelled','cancelled-before-effect'].includes(entry.state))this.waitingCount++;
      if (entry.item.call.tool==='switch_skill'||!['accepted','cancelled','cancelled-before-effect','not-run','unconfirmed'].includes(entry.state)) this.pendingKeys.push(entry.item.ref);
    }
    this.pendingKeys.sort();
  }
  switchDeliverySlotAvailable():boolean {return this.switchDeliveries===0&&skillSettlementWork.available();}
  hasPendingProof(proof:unknown):boolean {return (this.byProof.get(JSON.stringify(proof)??'')??0)>0;}
  switchCapacity():boolean {return this.switchCount<1024&&this.waitingCount<256&&this.serializedBytes+SWITCH_LIMITS.snapshot<=MAX_QUEUE_BYTES;}
  approval(approvalId: string): PendingQueueApproval | undefined {
    const ref=this.byApproval.get(approvalId), entry=ref && this.entries.get(ref);
    return entry ? frozen(copy(entry.item)) : undefined;
  }
  pendingPage(after = '', limit = 16): {items:readonly PendingQueueApproval[];next?:string} {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('approval-page-limit');
    let lo=0,hi=this.pendingKeys.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(this.pendingKeys[mid]!<=after)lo=mid+1;else hi=mid;}
    const keys=this.pendingKeys.slice(lo,lo+limit+1);
    return {items:keys.slice(0,limit).map(key=>frozen(copy(this.entries.get(key)!.item))),...(keys.length>limit?{next:keys[limit-1]}:{})};
  }
  private commit(next: Map<string, QueueEntry>): void {
    const terminalEntry=(entry:QueueEntry)=>(entry.state==='cancelled'||entry.state==='cancelled-before-effect')||entry.state==='accepted'&&(entry.item.call.tool!=='request_browser_connection'||entry.progress?.resumed===true);
    const waiting = [...next.values()].filter(entry=>!terminalEntry(entry));
    if (waiting.length > 256) throw new Error('approval-queue-capacity');
    const protectedEntries = [...next.values()].filter(entry => entry.item.call.tool === 'switch_skill');
    if (protectedEntries.length > 1024) throw new Error('approval-queue-capacity');
    const room = 1024 - protectedEntries.length;
    const terminal = room ? [...next.values()].filter(entry => terminalEntry(entry) && entry.item.call.tool !== 'switch_skill').slice(-room) : [];
    const entries = [...terminal, ...waiting, ...protectedEntries.filter(terminalEntry)];
    const serialized = JSON.stringify({version:1, entries:entries.map(entry=>({
      version:entry.version,item:entry.item,base:entry.base,state:entry.state,answerId:entry.answerId,answer:entry.answer,
      attemptId:entry.attemptId,result:entry.result,code:entry.code,renewedFrom:entry.renewedFrom,progress:entry.progress,
      ...(entry.authorization?{authorization:{kind:entry.authorization.kind,cause:entry.authorization.cause,principal:entry.authorization.principal}}:{}),
    }))});
    if (Buffer.byteLength(serialized) > MAX_QUEUE_BYTES) throw new Error('approval-queue-capacity');
    const created=mkdirSync(dirname(this.file), {recursive:true,mode:0o700});
    if(created&&entries.some(entry=>entry.item.call.tool==='switch_skill')){
      let directory=dirname(this.file);
      for(;;){if(syncParentDirectoryStatus(directory)!=='synced')throw new Error('skill-switch-storage-unavailable');if(directory===created)break;const parent=dirname(directory);if(parent===directory)throw new Error('skill-switch-storage-unavailable');directory=parent;}
    }
    if (entries.some(entry => entry.item.call.tool === 'switch_skill')) {
      if (syncParentDirectoryStatus(this.file) !== 'synced') throw new Error('skill-switch-storage-unavailable');
      writeFileAtomic(this.file, serialized, {mode:0o600});
      if (syncParentDirectoryStatus(this.file) !== 'synced') throw new Error('skill-switch-storage-unavailable');
      for(const entry of entries)if(entry.item.call.tool==='switch_skill'&&entry.state==='accepted')this.confirmedAccepts.add(entry.item.ref);
    } else writeFileAtomic(this.file, serialized, {mode:0o600,syncDir:true});
    this.entries = new Map(entries.map(entry=>[entry.item.ref,entry]));
    this.reindex();
  }
  private replace(entry: QueueEntry): void { const next = new Map(this.entries); next.set(entry.item.ref,entry); this.commit(next); }
  private exact(item: PendingQueueApproval): QueueEntry {
    const entry = this.entries.get(item.ref);
    if (!entry || !same(entry.item,item)) throw new Error('approval-queue-conflict');
    return entry;
  }
  open(input: ProducerRequest): OpenProducerRequest {
    if (!input.authority) throw new Error('A verified service execution claim is required.');
    // Persist the producing turn with the queued view; recovery must not borrow a later turn.
    const turnId=input.view.turnId??producerTurnId(input.authority.identity);
    // Recovery after a restart has no provider-turn map: keep the source's own parents with the queued view.
    const source=turnId&&input.authority.identity?.threadId?turnOfProvider(input.authority.identity.threadId,turnId):undefined;
    const parents=input.view.parents??source?.parents;
    // The source's own thread is positional (never a ref): keep where the producing turn began, so a card presented after a restart
    // is still inside a revoke committed after that turn began.
    const began=input.view.began??source?.turnLsn;
    const ref = input.ref ?? randomUUID(), epoch = input.epoch ?? randomUUID();
    const call = frozen(copy({tool:input.tool,input:input.input,approval:{queueRef:ref,epoch,action:input.action}}));
    const handle = openRequest({kind:'service',service:this.kind,claim:input.authority.claim,call});
    const base = frozen(copy(input.base));
    let baseBranch=false;
    const outcome = decide(handle,()=>{baseBranch=true;return base;});
    return {handle,outcome,base,baseBranch,item:frozen(copy({kind:this.kind,ref,epoch,call,view:{...input.view,...(turnId?{turnId}:{}),...(parents?.length?{parents}:{}),...(began!==undefined?{began}:{})},proof:input.authority.proof}))};
  }
  execute<T>(request: OpenProducerRequest, operation: (call: ServiceCall, delivery?: SkillDeliveryContext)=>Promise<T>): Promise<ServiceExecution<T>> {
    if (request.outcome.kind !== 'run') return Promise.resolve(request.outcome);
    if (request.item.call.tool !== 'switch_skill') return executeService(request.handle, operation);
    return executeService(request.handle, call => skillSettlementWork.item(async()=>{
      const item = frozen(copy({...request.item, approvalId:request.item.ref}));
      if (!this.entries.has(item.ref)) this.replace({version:2,item,base:request.base,state:'waiting'});
      let value!: T;
      this.accepts.set(item.ref, async (_item, _answer, delivery) => { value = await operation(call, delivery); });
      const result = await this.respond(item, {behavior:'allow'}, {answerId:item.ref}, automaticSettlement('no-limits'));
      if (result.state !== 'accepted' && result.state !== 'already') throw new SkillSwitchRefused('storage', result.message ?? 'The skill change was not run.');
      return value;
    }));
  }
  stage(request:OpenProducerRequest,ref:ApprovalRef):PendingQueueApproval {
    const item=frozen(copy({...request.item,approvalId:ref.approvalId}));
    const prior=this.entries.get(item.ref);
    if(prior&&!same(prior.item,item)){
      if (item.call.tool === 'switch_skill') throw new Error('approval-queue-conflict');
      if(!['accepted','cancelled'].includes(prior.state)||prior.item.epoch===item.epoch||prior.item.approvalId===item.approvalId)throw new Error('approval-queue-conflict');
      this.replace({item,base:request.base,state:'waiting'});
    }
    if(!prior)this.replace({...(item.call.tool === 'switch_skill' ? {version:2 as const} : {}),item,base:request.base,state:'waiting'});
    return item;
  }
  async present(request: OpenProducerRequest, ref: ApprovalRef, accept?: Accept, acceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void): Promise<PendingQueueApproval> {
    const item=this.stage(request,ref); // queue FIRST, fsynced
    if (accept) this.accepts.set(item.ref,accept);
    if (acceptNow) this.acceptsNow.set(item.ref,acceptNow);
    attachQueue(ref,{kind:this.kind,ref:item.ref,call:item.call});
    await presentApproval(ref,item.view); // S1 commits record + row together
    return item;
  }
  executeNow<T>(request:OpenProducerRequest,operation:(call:ServiceCall,delivery?:SkillDeliveryContext)=>T):ServiceExecution<T> {
    if(request.outcome.kind!=='run')return request.outcome;
    if (request.item.call.tool !== 'switch_skill') return executeServiceSync(request.handle,operation);
    return executeServiceSync(request.handle,call=>{
      const result=skillSettlementWork.now(()=>{
      const item=frozen(copy({...request.item,approvalId:request.item.ref}));
      if(!this.entries.has(item.ref))this.replace({version:2,item,base:request.base,state:'waiting'});
      let value!:T;
      this.acceptsNow.set(item.ref,(_item,_answer,delivery)=>{value=operation(call,delivery);});
      const result=this.respondNow(item,{behavior:'allow'},{answerId:item.ref},automaticSettlement('no-limits'));
      if(result.state!=='accepted'&&result.state!=='already')throw new SkillSwitchRefused('storage',result.message??'The skill change was not run.');
      return {value};
      });
      if(!result)throw new SkillSwitchRefused('limit-exceeded','Skill changes are busy. Nothing was changed.');
      return result.value;
    });
  }
  presentNow(request:OpenProducerRequest,ref:ApprovalRef,accept?:(item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void):PendingQueueApproval {
    const item=this.stage(request,ref);
    if(accept){this.accepts.set(item.ref,accept);this.acceptsNow.set(item.ref,accept);}
    attachQueue(ref,{kind:this.kind,ref:item.ref,call:item.call});presentApprovalSync(ref,item.view);
    return item;
  }
  respondNow(item:PendingQueueApproval,answer:ApprovalAnswer,options:Readonly<RequestAnswerOptions>,settlement: Settlement = automaticSettlement()):RequestDelivery {
    if (item.call.tool === 'switch_skill') {
      if(!this.flights.has(item.ref)&&!this.respondingNow.has(item.ref)){const receipt=this.receipt(item);if(receipt)return receipt;}
      return skillSettlementWork.now(()=>this.respondSwitchNow(item,answer,options,settlement))??{state:'failed',code:'capacity',message:'Skill changes are busy. Nothing was changed.'};
    }
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
  bindAcceptance(tool: string, accept: Accept, acceptNow?: (item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void): () => void {
    this.toolAccepts.set(tool, accept);if(acceptNow)this.toolAcceptsNow.set(tool,acceptNow);
    return () => { if (this.toolAccepts.get(tool) === accept) this.toolAccepts.delete(tool);if(acceptNow&&this.toolAcceptsNow.get(tool)===acceptNow)this.toolAcceptsNow.delete(tool); };
  }
  registerDelivery(tool:string,accept:Accept,acceptNow?:(item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void):void {
    this.toolAccepts.set(tool,accept);if(acceptNow)this.toolAcceptsNow.set(tool,acceptNow);
  }
  /** A durable producer has parked its live caller. Future answers must go to
   * the currently registered recovery delivery, including after a restart,
   * rather than a closure belonging to the old suspended call. The registered
   * decision, frozen call and pending queue item remain unchanged. */
  parkWaiter(item:PendingQueueApproval):void {
    const entry=this.exact(item);
    if(entry.state!=='waiting'||this.flights.has(item.ref)||this.respondingNow.has(item.ref))throw new Error('approval-queue-conflict');
    this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);
  }
  /** Reattach a recovered producer to its exact queue item, replacing a lost
   * process's waiter. This grants nothing; answerApproval still checks release. */
  resumeDelivery(ref:string,accept:(item:PendingQueueApproval,answer:ApprovalAnswer,delivery?:SkillDeliveryContext)=>void):void {
    const entry=this.entries.get(ref);
    if(!entry||entry.state==='accepted'||entry.state==='cancelled')return;
    this.accepts.set(ref,accept);this.acceptsNow.set(ref,accept);
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
  pendingApproval(ref: string): PendingQueueApproval | undefined {
    const entry = this.entries.get(ref);
    return entry && !['accepted','cancelled','cancelled-before-effect','not-run','unconfirmed'].includes(entry.state) ? frozen(copy(entry.item)) : undefined;
  }
  pendingApprovals(): readonly PendingQueueApproval[] {
    return frozen(copy([...this.entries.values()].filter(entry=>!['accepted','cancelled','cancelled-before-effect','not-run','unconfirmed'].includes(entry.state)).map(entry=>entry.item)));
  }
  readonly base: BaseVerdictFn = registration => {
    if (registration.source.kind !== 'service' || registration.source.service !== this.kind) throw new Error('approval-queue-conflict');
    const entry = this.entries.get(registration.source.call.approval?.queueRef ?? '');
    if (!entry || !same(entry.item.call,registration.source.call)) throw new Error('approval-queue-conflict');
    return frozen(copy(entry.base));
  };
  /** Direct exact-id lookup precedes skill I/O and policy. Terminal attempts never regain execution rights. */
  receipt(item: PendingQueueApproval): RequestDelivery | undefined {
    if(item.call.tool!=='switch_skill')return;
    let entry:QueueEntry;
    try {entry=this.exact(item);}catch{return {state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH};}
    if (entry.state === 'cancelled-before-effect' && entry.answer?.behavior==='deny') return {state:'already'};
    if (entry.state === 'accepted') return entry.version===2&&!this.confirmedAccepts.has(item.ref)?{state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH}:{state:'already', authorization:entry.authorization?.kind,message:entry.result};
    if (entry.state === 'effect-started' || entry.state === 'unconfirmed' || entry.version !== 2 && ['pending','failed'].includes(entry.state)) {
      if(entry.state!=='unconfirmed'){
        const quarantine={...entry,state:'unconfirmed' as const,result:UNCONFIRMED_SKILL_SWITCH};
        this.entries.set(item.ref,quarantine);
        void skillSettlementWork.item(()=>this.replace(quarantine)).catch(()=>{/* The durable start/legacy fence still prevents execution on restart. */});
      }
      return {state:'unconfirmed', message:UNCONFIRMED_SKILL_SWITCH};
    }
    if (entry.state === 'not-run' || entry.state === 'cancelled' || entry.state === 'cancelled-before-effect') return {state:'not-run',code:entry.code, message:entry.result ?? 'The skill change was not run.'};
    return;
  }
  refuseBeforeEffect(item:PendingQueueApproval,code:string,message:string):RequestDelivery {
    const terminal=this.receipt(item);if(terminal)return terminal;
    const entry=this.exact(item);
    if(item.call.tool!=='switch_skill'||!['waiting','pending-before-effect'].includes(entry.state))return {state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH};
    this.replace({...entry,state:'not-run',attemptId:entry.attemptId??randomUUID(),answerId:entry.answerId??randomUUID(),result:message,code});
    return {state:'not-run',code,message};
  }
  private switchContext(item: PendingQueueApproval, settlement: Settlement): SkillDeliveryContext {
    return {item,settlement,beginEffect:authorization => {
      const entry = this.exact(item);
      if (entry.version !== 2 || entry.state !== 'pending-before-effect') throw new Error('approval-effect-conflict');
      this.replace({...entry,state:'effect-started',authorization:copy(authorization)});
    }};
  }
  private switchFailed(item: PendingQueueApproval, error: unknown): RequestDelivery {
    // Reload: rename/fsync may have landed even when the writer reported failure.
    try {
      const disk = parseSwitchMetadata(this.file) as {entries:QueueEntry[]};
      const saved = disk.entries.find(e => same(e.item,item));
      if (saved) this.entries.set(item.ref,saved);
    } catch { /* The in-memory write-ahead fence remains authoritative for this live attempt. */ }
    let entry:QueueEntry;
    try {entry=this.exact(item);}catch{return {state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH};}
    if (entry.state === 'cancelled-before-effect' && entry.answer?.behavior==='deny') return {state:'already'};
    if (entry.state === 'accepted') {
      // An atomic rename may have landed before its directory barrier reported failure.
      // Obtain a positive barrier before projecting that accepted data; never overwrite it with failed.
      try {if(this.confirmedAccepts.has(item.ref)||syncParentDirectoryStatus(this.file)==='synced'){this.confirmedAccepts.add(item.ref);return {state:'already',authorization:entry.authorization?.kind};}}catch{}
      return {state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH};
    }
    const uncertain = entry.state === 'effect-started' || entry.state === 'unconfirmed';
    const result = uncertain ? UNCONFIRMED_SKILL_SWITCH : error instanceof Error ? error.message : 'The skill change was not run.';
    const code=uncertain?undefined:error instanceof SkillSwitchRefused?error.code:(error as {code?:unknown})?.code==='limit-exceeded'?'limit-exceeded':'storage';
    const next = {...entry,state:uncertain ? 'unconfirmed' as const : 'not-run' as const,result,code};
    // Quarantine in memory BEFORE the best-effort write. A failed final write can never redeliver.
    this.entries.set(item.ref,next);
    try { this.replace(next); } catch { /* Restart sees the durable effect-started fence. */ }
    return {state:uncertain ? 'unconfirmed' : 'not-run',message:result,code};
  }
  private startSwitch(item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>): void {
    const entry = this.exact(item);
    if (!options.answerId || entry.version !== 2 || !['waiting','pending-before-effect'].includes(entry.state)) throw new Error('approval-queue-conflict');
    if (entry.answer && !same(entry.answer,answer)) throw new Error('approval-answer-conflict');
    this.replace({...entry,state:'pending-before-effect',attemptId:entry.attemptId ?? randomUUID(),answerId:entry.answerId ?? options.answerId,answer:copy(answer)});
  }
  private finishSwitch(item:PendingQueueApproval, answer:ApprovalAnswer): RequestDelivery {
    const entry=this.exact(item);
    if (answer.behavior === 'allow' && entry.state !== 'effect-started') throw new Error('skill-switch-effect-not-started');
    const input=item.call.input as {action:string;name:string};
    this.replace({...entry,state:answer.behavior==='allow'?'accepted':'cancelled-before-effect',result:answer.behavior==='allow'?JSON.stringify({name:input.name,action:input.action,outcome:'completed'}):'Denied. Nothing was changed.'});
    this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);
    return {state:'accepted',authorization:entry.authorization?.kind};
  }
  private respondSwitchNow(item:PendingQueueApproval, answer:ApprovalAnswer, options:Readonly<RequestAnswerOptions>, settlement:Settlement):RequestDelivery {
    if(this.flights.has(item.ref)||this.respondingNow.has(item.ref))return {state:'failed'};
    const receipt=this.receipt(item);if(receipt)return receipt;
    if(this.switchDeliveries)return this.refuseBeforeEffect(item,'capacity','Skill changes are busy. Nothing was changed.');
    const accept=this.acceptsNow.get(item.ref)??this.toolAcceptsNow.get(item.call.tool)??this.recoveredAcceptNow;
    if(!accept)return {state:'not-run',message:'The skill delivery is unavailable.'};
    this.respondingNow.add(item.ref);
    let release!:()=>void;this.switchTail=new Promise<void>(resolve=>{release=resolve;});this.switchDeliveries++;
    try {
      this.startSwitch(item,answer,options);
      const result:unknown=accept(item,answer,this.switchContext(item,settlement));
      if(result&&typeof (result as PromiseLike<unknown>).then==='function')throw new Error('synchronous-service-required');
      return this.finishSwitch(item,answer);
    } catch(error) {return this.switchFailed(item,error);}
    finally {this.respondingNow.delete(item.ref);this.switchDeliveries--;release();}
  }
  private respondSwitch(item:PendingQueueApproval, answer:ApprovalAnswer, options:Readonly<RequestAnswerOptions>, settlement:Settlement):Promise<RequestDelivery> {
    const flying=this.flights.get(item.ref);if(flying)return flying;
    const receipt=this.receipt(item);if(receipt)return Promise.resolve(receipt);
    if(this.respondingNow.has(item.ref)||settlement.kind==='owner'&&(this.switchDeliveries>0||!skillSettlementWork.available()))return Promise.resolve({state:'failed',code:'in-flight'});
    const accept=this.accepts.get(item.ref)??this.toolAccepts.get(item.call.tool)??this.recoveredAccept;
    if(!accept)return Promise.resolve({state:'not-run',message:'The skill delivery is unavailable.'});
    let complete!:(result:RequestDelivery)=>void;
    const done=new Promise<RequestDelivery>(resolve=>{complete=resolve;});this.flights.set(item.ref,done);
    const idle=this.switchDeliveries===0,previous=this.switchTail;
    let release!:()=>void;this.switchTail=new Promise<void>(resolve=>{release=resolve;});this.switchDeliveries++;
    const run=async():Promise<RequestDelivery>=>{
      try {this.startSwitch(item,answer,options);await accept(item,answer,this.switchContext(item,settlement));return this.finishSwitch(item,answer);}
      catch(error){try{return this.switchFailed(item,error);}catch{return {state:'unconfirmed',message:UNCONFIRMED_SKILL_SWITCH};}}
      finally{this.switchDeliveries--;release();}
    };
    const dispatch=()=>skillSettlementWork.item(run).then(result=>{this.flights.delete(item.ref);complete(result);});
    if(idle)void dispatch();else void previous.then(dispatch);
    return done;
  }
  respond(item: PendingQueueApproval, answer: ApprovalAnswer, options: Readonly<RequestAnswerOptions>, settlement: Settlement = automaticSettlement()): Promise<RequestDelivery> {
    if (item.call.tool === 'switch_skill') return this.respondSwitch(item, answer, options, settlement);
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
    if (item.call.tool==='switch_skill' && this.receipt(item)) return;
    if (entry.state==='accepted' || this.respondingNow.has(item.ref) || this.flights.has(item.ref) || entry.state==='pending') throw new Error('approval-queue-conflict');
    if (_reason === 'expired' && requiresLiveApprovalRecipient(item) && !this.accepts.has(item.ref)) {
      this.replace({...entry,state:'cancelled'});
      return;
    }
    const accept = this.accepts.get(item.ref) ?? this.toolAccepts.get(item.call.tool) ?? this.toolAccepts.get(String(item.call.approval.action.tool)) ?? this.recoveredAccept;
    if (!accept) throw new Error('approval-queue-delivery-unavailable');
    await accept(item,{behavior:'deny'});
    this.replace({...this.exact(item),state:item.call.tool==='switch_skill'?'cancelled-before-effect':'cancelled'}); this.accepts.delete(item.ref);this.acceptsNow.delete(item.ref);
  }
  async renew(item: PendingQueueApproval, identity: QueueRenewal): Promise<PendingQueueApproval> {
    const entry = this.entries.get(item.ref);
    if (entry?.item.approvalId===identity.approvalId && entry.item.epoch===identity.epoch) {
      if(!same(entry.renewedFrom,item))throw new Error('approval-queue-conflict');
      return frozen(copy(entry.item));
    }
    this.exact(item);
    if (item.call.tool === 'switch_skill' || entry!.state==='accepted' || entry!.state==='pending' || this.flights.has(item.ref) || !identity.approvalId || !identity.epoch || identity.approvalId===item.approvalId || identity.epoch===item.epoch) throw new Error('approval-queue-conflict');
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
  /** Browser ownership must park atomically with its card, before a sibling
   * can enter. Both registration and presentation support the synchronous seam. */
  synchronous?: boolean;
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
  const execution = hooks.synchronous ? queue.executeNow(request,()=>true) : await queue.execute(request,async()=>true);
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
  if(hooks.synchronous)queue.presentNow(request,execution.ref,accept);
  else await queue.present(request,execution.ref,accept,accept);
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
