import { writeFileSync as countedWriteFileSync } from "./counted-fs.ts";
import { serviceQueue, waitForProducerApproval, answerProducerRequestSync, producerBase } from "./narrow-denials.ts";
import { readApproval, readApprovalExecution } from "./decision/index.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { createPrivateWindowsDirectory, readPrivateWindowsJson, writePrivateWindowsJson } from "../electron/browser-extension-windows.mjs";
import type { ApprovalBus } from "./peer-approval.ts";
import type { BotRecord } from "./store.ts";
// A person decides in their own time (fifteen minutes on a card, then it stays open for 24 hours); the tool call's own deadline is separate.
const MAX_WAIT_MS = 15 * 60_000, MAX_SUMMARY = 12000;
export const BROWSER_EXTENSION_APPROVAL_TOOL = "browser_extension_action";
/** T22 (spec 2.8): a card the person has not answered stays answerable this long, even across a restart. */
export const CARD_LIFETIME_MS = 24 * 3600_000;
const MAX_RECORDS = 256, FILE_VERSION = 1, MAX_FILE_BYTES = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
/** What an approval is bound to. All six must match for the approval to be used; any difference means a fresh card. */
export type ApprovalBinding = {
  generation: number;
  /** The document the step runs in: tab, navigation epoch and origin. */
  documentEpoch: string;
  /** The control the step acts on (digest of its name, role and bound node). */
  targetDigest: string;
  /** Where the step sends: the form action or destination, and the operation (digest). */
  submissionDigest: string;
  /** What the step types or submits (digest). */
  payloadDigest: string;
  /** The whole trusted action, as the executor digests it. */
  actionDigest: string;
};
export type ApprovalKind = "site" | "action";
/** allow and deny are the person's answer inside the wait. waiting: the wait ran out, the card stays live. cancelled: no card is answerable. */
export type ApprovalState = "allow" | "deny" | "waiting" | "cancelled";
export type ContinuationInfo = { requestId: string; botId: string; threadId: string; bindingId: string; kind: ApprovalKind; decision: "allow" | "deny" };
type RecordStatus = "waiting" | "allowed" | "denied";
type DurableRecord = { requestId: string; threadId: string; messageId: string; botId: string; bindingId: string; kind: ApprovalKind; binding: ApprovalBinding; createdAt: number; expiresAt: number; status: RecordStatus; continued?: boolean };
export type ApprovalsOptions = {
  /** Where the continuation records live (inside browser-extension/, never backed up). Without it nothing is durable. */
  file?: string;
  now?: () => number;
  /** Is this binding still the one the card was raised for (same generation, not stopped)? Asked before an answer runs anything. */
  valid?: (record: { bindingId: string; botId: string; threadId: string; generation: number }) => boolean;
  /** Start the continuation turn. Return false when it could not start now (the bot is busy); it is retried by drain. */
  onContinue?: (info: ContinuationInfo) => boolean | void | Promise<boolean | void>;
  /** The provider turn running in this conversation now (internal-capabilities.ts providerTurnOf), read from the server's own turn state, never
   * from a request. The card's summary carries the model's words (typed text, a chosen address), so the card names this turn and is withheld
   * with the turn's inputs when they are revoked. */
  turnOf?: (threadId: string) => string | undefined;
};
const sameBinding = (a: ApprovalBinding, b: ApprovalBinding) => !!a && !!b && a.generation === b.generation && a.documentEpoch === b.documentEpoch && a.targetDigest === b.targetDigest
  && a.submissionDigest === b.submissionDigest && a.payloadDigest === b.payloadDigest && a.actionDigest === b.actionDigest;
function readBinding(value: unknown): ApprovalBinding | undefined {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || !Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || typeof v.documentEpoch !== "string" || !v.documentEpoch || v.documentEpoch.length > 600) return undefined;
  if (![v.targetDigest, v.submissionDigest, v.payloadDigest, v.actionDigest].every(item => typeof item === "string" && HEX.test(item))) return undefined;
  return { generation: v.generation as number, documentEpoch: v.documentEpoch, targetDigest: v.targetDigest as string, submissionDigest: v.submissionDigest as string, payloadDigest: v.payloadDigest as string, actionDigest: v.actionDigest as string };
}
export type BrowserExtensionApprovalRequest = {
  bot: Pick<BotRecord, "id" | "name" | "color">;
  threadId: string;
  bindingId: string;
  generation: number;
  /** Digest of the trusted action, including profile, document epoch and observed target. */
  digest: string;
  /** Executor-produced, redacted human description, never model-authored instructions. */
  summary: string;
  /** Actual structured action, captured by the executor; summary stays display-only. */
  call?: {tool:string;input:unknown};
  baseAsk?: boolean;
  /** What a push notification may say. Never typed text or field values. */
  pushSummary?: string;
  signal?: AbortSignal;
  waitMs?: number;
  scope?: "site" | "action";
  /** T22: with a binding, a wait that runs out leaves the card live (durable) instead of dismissing it. */
  binding?: ApprovalBinding;
  kind?: ApprovalKind;
  /** D1: the card is for a step Murage asks about every time, in every mode (deleting, or a send to a recipient the owner never named). */
  cardKind?: "delete" | "newRecipient";
  /** The card's heading when the caller can say it better than the default (see browserActionCardTitle). */
  title?: string;
};
const hostOf = (value: unknown): string | undefined => { try { return typeof value === "string" && value ? new URL(value).host || undefined : undefined; } catch { return undefined; } };
const ACTION_PHRASE: Record<string, string> = {
  click: "click on", dblclick: "double-click on", hover: "point at something on", focus: "select a field on", fill: "type into", type: "type into",
  keyboard_type: "type on", keyboard_insert_text: "type on", press: "press a key on", keydown: "press a key on", keyup: "press a key on",
  select: "choose an option on", check: "tick a box on", uncheck: "untick a box on", scroll: "scroll", scroll_into_view: "scroll",
  back: "go back on", forward: "go forward on", reload: "reload", tab_close: "close a tab on",
};
/** The plain heading for an action card: what the bot wants to do and where. Never the tool's internal name. */
export function browserActionCardTitle(botName: string, action: { name: string; arguments?: unknown; document?: { url?: string; origin?: string } }): string {
  const verb = action.name.replace(/^agent_browser_/, "");
  const args = (action.arguments ?? {}) as Record<string, unknown>;
  const where = hostOf(action.document?.url) ?? hostOf(action.document?.origin);
  if (verb === "open" || verb === "tab_new") { const target = hostOf(args.url) ?? where; return target ? `${botName} wants to open ${target}` : `${botName} wants to open a page in your browser`; }
  const phrase = ACTION_PHRASE[verb];
  if (phrase) return where ? `${botName} wants to ${phrase} ${where}` : `${botName} wants to ${phrase} a page in your browser`;
  return where ? `${botName} wants to use your browser on ${where}` : `${botName} wants to use your browser`;
}
type Pending = {
  threadId: string; bindingId: string; generation: number; digest: string; botId: string;
  requestId: string; messageId: string; finish: (allow: boolean, user: boolean) => void;
};
/** Owner response routes alone may call resolve. This class never auto-approves. */
export class BrowserExtensionApprovals {
  private readonly bus: ApprovalBus;
  private pending = new Map<string, Pending>();
  private readonly options: ApprovalsOptions;
  private records = new Map<string, DurableRecord>();
  /** A damaged or unrecognised file: nothing in it is trusted and every card it might have covered is dismissed. */
  private unreadable = false;
  /** Action cards saved by an earlier run. Their digests were keyed by that run's secret, so no action of this run can match them. */
  private restored = new Set<string>();
  private firing = new Set<Promise<void>>();
  private continuationTimer?:ReturnType<typeof setImmediate>;
  private readyContinuations=new Set<string>();
  constructor(bus: ApprovalBus, options: ApprovalsOptions = {}) {
    this.bus=bus;this.options=options;this.load();
    const accept=(item:import('./decision/index.ts').PendingQueueApproval,answer:import('./decision/index.ts').ApprovalAnswer)=>{
      const authority=readApproval(item.approvalId);
      if(authority?.state!=='answered'){
        if(answer.behavior!=='deny')throw new Error('approval-queue-conflict');
        if(this.records.delete(item.ref)&&!this.save())throw new Error('approval-queue-delivery-unavailable');
        return;
      }
      const record=this.records.get(item.ref);
      if(!record){if(answer.behavior==='allow')throw new Error('approval-queue-delivery-unavailable');return;}
      if(!authority||authority.threadId!==record.threadId||authority.botId!==record.botId||authority.chatMessageId!==record.messageId||authority.requestId!==record.requestId||authority.action.bindingId!==record.bindingId||!sameBinding(authority.action.binding as ApprovalBinding,record.binding)||!this.receiptKindMatches(record,authority.action)||record.expiresAt<=this.now()||!(this.options.valid?.({bindingId:record.bindingId,botId:record.botId,threadId:record.threadId,generation:record.binding.generation})??true))throw new Error('approval-queue-conflict');
      record.status=answer.behavior==='allow'?'allowed':'denied';
      if(!this.save())throw new Error('approval-queue-delivery-unavailable');
      this.scheduleContinuations(record);
    };
    this.approvalQueue().registerDelivery(BROWSER_EXTENSION_APPROVAL_TOOL,accept,accept);
    for(const record of this.records.values()){
      this.restored.add(record.requestId);
      if(record.status==='waiting')this.approvalQueue().resumeDelivery(record.requestId,accept);
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** Plain request: true only when the person allowed it inside the wait. */
  request(input: BrowserExtensionApprovalRequest): Promise<boolean> { return this.ask(input).then(state => state === "allow"); }
  pendingApprovals() { return serviceQueue('browser').pendingApprovals(); }
  approvalQueue() { return serviceQueue('browser'); }
  async ask(input: BrowserExtensionApprovalRequest): Promise<ApprovalState> {
    const waitMs=input.waitMs??45000;
    if(input.signal?.aborted)return 'cancelled';
    if(![input.threadId,input.bindingId,input.bot.id].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value))||!Number.isSafeInteger(input.generation)||input.generation<1||!HEX.test(input.digest)||input.binding&&!readBinding(input.binding)||!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>MAX_WAIT_MS||!input.summary.trim()||input.summary.length>MAX_SUMMARY)return 'cancelled';
    const durable=input.binding&&this.options.file?readBinding(input.binding):undefined;
    if(durable){const same=[...this.records.values()].find(record=>record.status==='waiting'&&record.bindingId===input.bindingId&&record.kind===(input.kind??'action')&&sameBinding(record.binding,durable)&&record.expiresAt>this.now());if(same)return 'waiting';}
    if(this.pending.size>=MAX_RECORDS||durable&&this.records.size>=MAX_RECORDS)return 'cancelled';
    let summary=input.summary;
    if(durable&&(input.kind??'action')==='action'){
      const old=[...this.records.values()].filter(record=>this.restored.has(record.requestId)&&record.bindingId===input.bindingId&&record.kind==='action'&&!sameBinding(record.binding,durable));
      if(old.length){
        for(const record of old){this.restored.delete(record.requestId);this.forget(record,true);}
        const notice=`Murage restarted since an earlier request on this task, so that one was closed. Please answer this new one.\n${summary}`;
        if(notice.length<=MAX_SUMMARY)summary=notice;
      }
    }
    const requestId='browser-'+randomUUID();
    let timedOut=false,shown=false,parked=false;
    const controller=new AbortController();
    const signal=controller.signal;
    const aborted=()=>controller.abort();
    input.signal?.addEventListener('abort',aborted,{once:true});
    let item:import('./decision/index.ts').PendingQueueApproval|undefined;
    let resume:ReturnType<NonNullable<ApprovalBus['onBrowserOwnerWait']>>;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const result=waitForProducerApproval(this.approvalQueue(),{
      authority:this.bus.authorityFor?.(input.threadId,input.bot.id),ref:requestId,
      tool:input.call?.tool??BROWSER_EXTENSION_APPROVAL_TOOL,input:input.call?.input??{binding:input.binding,scope:input.scope},
      action:{requestId,tool:BROWSER_EXTENSION_APPROVAL_TOOL,options:['Allow','Deny'],approvalKind:input.kind??'action',binding:input.binding,bindingId:input.bindingId,generation:input.generation,
        held:input.scope==='site'?'Allow remembers site access for this browser task. You can revoke it in Browser settings. Sending, purchasing and other changes have separate approvals.':'Allow applies to this action once. Site access does not approve actions. Text marked "From the page" was written by the website, not by Murage or the bot.',
        ...(input.pushSummary?{pushBody:input.pushSummary.slice(0,300)}:{}),...(input.cardKind?{browserCardKind:input.cardKind}:{})},
      view:{title:input.title??`${input.bot.name} needs your approval`,subtitle:summary,turnId:this.options.turnOf?.(input.threadId)},base:producerBase(input.baseAsk!==false),
    },{signal,handoff:()=>parked,settled:response=>{
      const record=this.records.get(requestId);if(!record)return;
      record.status=response.behavior==='allow'?'allowed':'denied';
    },presented:(_item,messageId)=>{
      item=_item;
      shown=true;
      this.pending.set(requestId,{threadId:input.threadId,bindingId:input.bindingId,generation:input.generation,digest:input.digest,botId:input.bot.id,requestId,messageId,
        finish:()=>this.cancelRequest(requestId)});
      if(input.binding&&this.options.file){const at=this.now();this.records.set(requestId,{requestId,threadId:input.threadId,messageId,botId:input.bot.id,bindingId:input.bindingId,kind:input.kind??'action',binding:input.binding,createdAt:at,expiresAt:at+CARD_LIFETIME_MS,status:'waiting'});}
      try { resume=this.bus.onBrowserOwnerWait?.(input.threadId,requestId); }
      catch { controller.abort();return; }
      try { this.bus.onApproval?.(input.bot.id,input.threadId,requestId,messageId); } catch { /* Notification failure grants no authority. */ }
    }}).then(outcome=>{
      this.pending.delete(requestId);
      const record=this.records.get(requestId);
      if(parked)return 'waiting' as const;
      if(record){this.records.delete(requestId);if(this.options.file&&fs.existsSync(this.options.file))this.save();}
      return outcome==='cancelled'?'cancelled' as const:outcome;
    });
    const deadline=new Promise<ApprovalState>(resolve=>{timer=setTimeout(()=>{
      timedOut=true;
      if(shown&&durable&&item){
        if(!this.save()){this.records.delete(requestId);controller.abort();resolve('cancelled');return;}
        try {serviceQueue('browser').parkWaiter(item);parked=true;}
        catch {console.warn('browser-approval-handoff-failed');controller.abort();resolve('cancelled');return;}
        controller.abort();resolve('waiting');
      }else{controller.abort();resolve('cancelled');}
    },waitMs);timer.unref?.();});
    try{
      const outcome=await Promise.race([result,deadline]);
      // The answer deadline ends before waiting to reacquire browser ownership.
      if(!timedOut)clearTimeout(timer);
      if(outcome==='cancelled'&&item){const record=readApproval(item.approvalId);if(record)this.displayAnswer(record.threadId,record.chatMessageId,'unavailable',true);}
      await resume?.(false,input.signal);
      return outcome;
    }finally{
      input.signal?.removeEventListener('abort',aborted);
      if(!timedOut)clearTimeout(timer);
      else if(!durable)this.cancelRequest(requestId);
    }
  }
  resolve(threadId:string,requestId:string,behavior:string|undefined):boolean {
    if(behavior!=='allow'&&behavior!=='deny')return false;
    const item=this.pendingApprovals().find(item=>item.ref===requestId);
    const record=item&&readApproval(item.approvalId);
    if(!item||record?.threadId!==threadId||behavior!=='allow'&&behavior!=='deny')return false;
    const card=this.bus.store.messageById(threadId,record.chatMessageId)?.card;
    let valid=false;
    try { valid=!this.unreadable&&!!card&&!card.answered&&!card.dismissed&&(this.options.valid?.({bindingId:String(item.call.approval.action.bindingId),botId:record.botId,threadId,generation:Number(item.call.approval.action.generation)})??true); } catch { /* A failed binding check cannot authorize. */ }
    const durable=this.records.get(requestId);
    if(!valid||durable&&durable.expiresAt<=this.now()){
      if(durable)this.forget(durable,false);
      this.cancelRequest(requestId);return false;
    }
    const accepted=answerProducerRequestSync(serviceQueue('browser'),threadId,requestId,behavior);
    if(accepted){
      this.displayAnswer(threadId,record.chatMessageId,behavior,false);
      // The synchronous decision call has now committed delivery. Preserve
      // immediate continuations without executing inside its pending callback.
      if(durable)this.fire(durable);
    }
    return accepted;
  }
  /** The decision record settles first. Browser continuation readers retain
   * their canonical allow/deny labels; these terminal display fields carry no
   * action or execution authority. */
  private displayAnswer(threadId:string,messageId:string,answered:string,dismissed:boolean):void {
    const card=this.bus.store.messageById(threadId,messageId)?.card;
    if(card)this.bus.store.patchMessagePoint(threadId,messageId,{card:{...card,answered,dismissed}});
  }
  private cancelRequest(requestId:string):void {
    const item=this.pendingApprovals().find(item=>item.ref===requestId);
    const record=item&&readApproval(item.approvalId);
    if(!item||!record)return;
    // stop() fences and terminalizes the registered decision synchronously,
    // then awaits its cancellation delivery. Never close only the visible row.
    void serviceQueue('browser').stop(item.approvalId).catch(()=>{console.warn('browser-approval-cancellation-failed');});
    if(readApproval(item.approvalId)?.state!=='open')this.displayAnswer(record.threadId,record.chatMessageId,'unavailable',true);
  }
  /** Is this card live, in memory or saved? */
  knows(requestId: string): boolean { return !this.unreadable&&(this.pending.has(requestId)||this.records.get(requestId)?.status==='waiting'); }
  /** The first matching action uses the approval; it works once. Anything that differs in any binding field does not match. */
  consume(query: { bindingId: string; kind: ApprovalKind; binding: ApprovalBinding }): boolean {
    for (const record of [...this.records.values()]) {
      if (this.pending.has(record.requestId) || record.status !== "allowed" || record.bindingId !== query.bindingId || record.kind !== query.kind) continue;
      if (this.now() >= record.expiresAt) { this.forget(record, true); continue; }
      const card = this.cardOf(record);
      const receipt = typeof card?.approvalId === "string" ? readApproval(card.approvalId) : undefined;
      if (receipt?.delivery === "pending") continue;
      const receiptBinding = readBinding(receipt?.action.binding);
      let allowedReceipt = false;
      try { allowedReceipt = !!receipt && readApprovalExecution(receipt.ref).answer?.behavior === "allow"; } catch { /* A missing receipt authorizes nothing. */ }
      // Direct decision delivery leaves the canonical terminal card. The
      // browser's older resolve API may keep its legacy display projection;
      // either view still requires the same accepted durable decision.
      const terminalAllow = card && (card.answered === "Allowed" && card.dismissed === true
        || card.answered === "allow" && !card.dismissed);
      if (!terminalAllow || !allowedReceipt || !receipt || receipt.state !== "answered" || receipt.delivery !== "accepted"
        || receipt.threadId !== record.threadId || receipt.botId !== record.botId || receipt.chatMessageId !== record.messageId
        || receipt.queue?.kind !== "browser" || receipt.queue.ref !== record.requestId
        || receipt.action.bindingId !== record.bindingId || !this.receiptKindMatches(record,receipt.action)
        || !receiptBinding || !sameBinding(receiptBinding, record.binding)) { this.forget(record, false); continue; }
      if (!sameBinding(record.binding, query.binding)) continue;
      let valid = false;
      try { valid = this.options.valid?.({ bindingId: record.bindingId, botId: record.botId, threadId: record.threadId, generation: record.binding.generation }) ?? true; } catch { valid = false; }
      const forgotten=this.forget(record, false);
      return valid&&forgotten;
    }
    return false;
  }
  /** Stop, Never, Revoke and End task: every waiting card and unused approval of the binding ends. */
  /** True while a card of this binding is on screen and unanswered. */
  hasWaiting(bindingId: string): boolean {
    for (const pending of this.pending.values()) if (pending.bindingId === bindingId) return true;
    for (const record of this.records.values()) if (record.bindingId === bindingId && record.status === "waiting") return true;
    return false;
  }
  cancelBinding(bindingId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.bindingId === bindingId) pending.finish(false, false);
    for (const record of [...this.records.values()]) if (record.bindingId === bindingId) this.forget(record, true);
  }
  cancelThread(threadId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.threadId === threadId) pending.finish(false, false);
    for (const record of [...this.records.values()]) if (record.threadId === threadId) this.forget(record, true);
  }
  /** Close every card past its 24 hours. Called on a timer. */
  sweep(): number {
    let count = 0;
    for (const record of [...this.records.values()]) if (this.now() >= record.expiresAt) { this.forget(record, true); count++; }
    return count;
  }
  /** Start continuations that could not start when the answer came (the bot was busy). Each runs at most once. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.firing]);
    for (const record of [...this.records.values()]) if (record.status !== "waiting" && !record.continued && this.now() < record.expiresAt) this.fire(record);
    await Promise.allSettled([...this.firing]);
  }
  private scheduleContinuations(record:DurableRecord):void {
    this.readyContinuations.add(record.requestId);
    if(this.continuationTimer)return;
    // Queue acceptance is committed after the delivery callback returns. A
    // continuation must never try to consume a still-pending delivery.
    this.continuationTimer=setImmediate(()=>{
      this.continuationTimer=undefined;
      const ready=[...this.readyContinuations];this.readyContinuations.clear();
      for(const id of ready){const record=this.records.get(id);if(record&&record.status!=='waiting')this.fire(record);}
    });
    this.continuationTimer.unref?.();
  }
  private fire(record: DurableRecord): void {
    this.readyContinuations.delete(record.requestId);
    const hook = this.options.onContinue;
    // An answer inside the original wait resumes that call; only a parked
    // request can start a separate continuation after durable acceptance.
    if (!hook || this.pending.has(record.requestId) || record.continued || this.records.get(record.requestId)!==record) return;
    const card=this.cardOf(record),authority=card?.approvalId?readApproval(card.approvalId):undefined;
    if(!authority||authority.state!=='answered'||authority.delivery!=='accepted'||this.now()>=record.expiresAt)return;
    // Consume before dispatch: a lost response or a restart never replays the continuation.
    record.continued = true; if(!this.save()){record.continued=false;return;}
    const info: ContinuationInfo = { requestId: record.requestId, botId: record.botId, threadId: record.threadId, bindingId: record.bindingId, kind: record.kind, decision: record.status === "allowed" ? "allow" : "deny" };
    const done = (async () => {
      let started: boolean | void = true;
      try { started = await hook(info); } catch { started = true; }
      if (started === false) { record.continued = false; this.save(); }
      else if (record.status === "denied") { this.records.delete(record.requestId); this.save(); }
    })();
    this.firing.add(done); void done.finally(() => this.firing.delete(done));
  }
  /** Startup only. A card with a live saved record stays answerable; every other browser card is closed. */
  dismissStale(): number {
    const threads = new Set<string>();
    for (const owner of [...this.bus.store.bots, ...this.bus.store.groups]) { threads.add(owner.threadId); for (const task of owner.tasks ?? []) threads.add(task.threadId); }
    let count = 0;
    for (const record of [...this.records.values()]) if (this.now() >= record.expiresAt) { this.forget(record, true); count++; }
    // the cards still open, through the card index: every one this closes is an unanswered request card
    for (const threadId of threads) for (const message of this.bus.store.openDecisionCardRows(threadId)) {
      const card = message.card;
      if (card?.tool !== BROWSER_EXTENSION_APPROVAL_TOOL || !card.requestId || card.answered || card.dismissed || this.pending.has(card.requestId)) continue;
      const record = this.records.get(card.requestId);
      if (record && !this.unreadable && record.messageId === message.id && record.threadId === threadId && record.status === "waiting") continue;
      if(card.approvalId){this.cancelRequest(card.requestId);count++;}
      else if (this.bus.store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } })) count++;
    }
    return count;
  }
  private cardOf(record: DurableRecord) {
    const card = this.bus.store.messageById(record.threadId, record.messageId)?.card;
    return card && card.requestId === record.requestId && card.tool === BROWSER_EXTENSION_APPROVAL_TOOL ? card : undefined;
  }
  private receiptKindMatches(record: DurableRecord, action: Readonly<Record<string, unknown>>): boolean {
    // The first durable format had action approvals only. A missing kind is
    // compatible solely for a restored action record, never a site grant or
    // a newly created approval. Every other receipt/binding check still applies.
    return action.approvalKind === record.kind || this.restored.has(record.requestId)
      && record.kind === "action" && !Object.hasOwn(action, "approvalKind");
  }
  private dismiss(threadId: string, messageId: string) {
    try {
      const card = this.bus.store.messageById(threadId, messageId)?.card;
      if(card?.approvalId&&card.requestId){this.cancelRequest(card.requestId);return;}
      if (card && !card.answered && !card.dismissed) this.bus.store.patchMessage(threadId, messageId, { card: { ...card, answered: "unavailable", dismissed: true } });
    } catch { /* a card that cannot be closed still authorizes nothing: the record is gone */ }
  }
  private forget(record: DurableRecord, closeCard: boolean) {
    this.records.delete(record.requestId);this.restored.delete(record.requestId);
    if (closeCard) this.dismiss(record.threadId, record.messageId);
    return this.save();
  }
  private load(): void {
    const file = this.options.file; if (!file) return;
    try {
      const win = process.platform === "win32";
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (!win && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) throw new Error("unsafe_file");
      const root = (win ? readPrivateWindowsJson(file) : JSON.parse(fs.readFileSync(file, "utf8"))) as { version?: unknown; records?: unknown } | null;
      if (!root || typeof root !== "object" || Array.isArray(root) || root.version !== FILE_VERSION || !Array.isArray(root.records) || root.records.length > MAX_RECORDS) throw new Error("invalid_file");
      const loaded = new Map<string, DurableRecord>();
      for (const raw of root.records as Record<string, unknown>[]) {
        const binding = readBinding(raw?.binding);
        if (!raw || typeof raw !== "object" || !binding || ![raw.requestId, raw.threadId, raw.messageId, raw.botId, raw.bindingId].every(v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v))
          || (raw.kind !== "site" && raw.kind !== "action") || !["waiting", "allowed", "denied"].includes(raw.status as string)
          || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.expiresAt) || (raw.expiresAt as number) - (raw.createdAt as number) > CARD_LIFETIME_MS || (raw.continued !== undefined && typeof raw.continued !== 'boolean')) throw new Error("invalid_record");
        loaded.set(raw.requestId as string, { requestId: raw.requestId as string, threadId: raw.threadId as string, messageId: raw.messageId as string, botId: raw.botId as string, bindingId: raw.bindingId as string,
          kind: raw.kind as ApprovalKind, binding, createdAt: raw.createdAt as number, expiresAt: raw.expiresAt as number, status: raw.status as RecordStatus, ...(raw.continued ? { continued: true } : {}) });
      }
      this.records = loaded;
      this.restored = new Set(loaded.keys());
    } catch { this.records = new Map(); this.unreadable = true; }
  }
  /** False when the file could not be written: the caller then treats the card as not durable. */
  private save(): boolean {
    const file = this.options.file; if (!file) return true;
    try {
      const content = { version: FILE_VERSION, records: [...this.records.values()] };
      const win = process.platform === "win32";
      if (win) createPrivateWindowsDirectory(path.dirname(file)); else fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (win) { writePrivateWindowsJson(file, content); this.unreadable = false; return true; }
      const temp = `${file}.${randomUUID()}.tmp`;
      try { countedWriteFileSync(temp, JSON.stringify(content), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
      this.unreadable = false; return true;
    } catch { return false; }
  }
}
