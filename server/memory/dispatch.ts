import { initializeFreshSessionProof, proveRetainedSession, proveRetainedSessionAtSubmission, type SessionProofContext } from './session-proof.ts';
import type { FreshReplaySessionConfirmation } from './fresh-replay-session.ts';
import { noteSessionFrame, sessionHadFrame } from './session-proof-schema.ts';
import { continuationSessionVerdict } from "./continuation-settle.ts";
import { FENCE_REBUILDS, MESSAGE_ONLY_NOTE, nextFenceTier } from "./fence-recovery.ts";
import { MemoryPinProjectionPending, MemoryPinSetTooLarge } from './recall-recovery.ts';
import type { MemoryBundle } from "../../shared/memory.ts";
import { RESEND_OFFER_LINE } from "../../shared/resend-offer.ts";
import { database } from "../database.ts";
import { onRollback } from "../tx-scope.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { MemorySearchBridge } from "./search.ts";
import { contentRevoked, isLineageLimit, JudgeMemo, LineageAllowance, outputRootsBad, preLineageSessionRevoked, sessionLineageBad, sessionOutputRoots } from "./replay-lineage.ts";
import { assertMemoryBundle, buildMemoryBundle, memoryHandleRecord } from "./bundle.ts";
import { assertMemoryDisclosureCurrent, bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, linkMemoryDisclosureOutput, noteMemoryLookup, prepareMemoryDisclosure, receiptJoinsTurn } from "./disclosures.ts";
import { heldStep } from "../observe.ts";
import { doorEpochVerdict, lineageLive, sessionLookup } from "./deny-read.ts";
import { fenceRefusalDiagnosis, type FenceRefusalDiagnosis } from "./send-fence.ts";
import { setSendFenceDeps } from "./send-fence-deps.ts";
import type { LineageReader, LineageVerdict } from "./lineage-types.ts";
import { withSecondLook } from "./lineage-allowance.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { drainBranchChanges } from "./branch-change.ts";
import { classifyDirectSettle } from "./settle-target.ts";

/** Whether a bundle differs from the session's latest delivered frame. This is
 * a comparison, not an invalidation test: the thread's own checkpoint rolls on
 * every capture, so a differing frame is the ordinary case and the dispatch
 * path (server/index.ts) no longer resets a session over it. What ends a
 * session is continuationMemoryRevoked (disclosures.ts); a differing frame is
 * delivered on the prompt (harness/memory-adapter.ts).
 * Full text is intentionally absent from durable disclosure receipts.
 */
export function memoryContinuationChanged(bundle:MemoryBundle,threadId:string,instanceId:string,session:string):boolean {
  // Only the session's latest delivered frame decides. A long resumed session
  // holds a receipt per turn; reading them all failed every turn past 2048
  // (MEMORY_CONTINUATION_LIMIT, 0.1.61.1 memreplay).
  // The latest frame alone does not decide, though: a revoke can land while
  // the bundle search awaits, and it may hit only an older frame or a
  // :lookup companion of this session. Any revoked receipt of the session, at
  // any age, ends it (one indexed probe, no row cap).
  if(memorySessionRevoked(threadId,instanceId,session))return true;
  const latest=database().prepare("SELECT record_versions,source_versions,policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND state='delivered' AND bundle_id NOT LIKE '%:lookup' ORDER BY rowid DESC LIMIT 1").get(threadId,instanceId,session);
  return !latest || latest.policy_revision!==bundle.policyRevision || latest.deletion_epoch!==bundle.deletionEpoch
    || latest.record_versions!==JSON.stringify(bundle.recordVersions) || latest.source_versions!==JSON.stringify(bundle.sourceVersions);
}

/** True when any receipt of the native session (a frame or its :lookup
 * companion) is revoked, or was made under another policy revision or
 * deletion epoch than the current ones. Such a session is never resumed. */
export function memorySessionRevoked(threadId:string,instanceId:string,session:string):boolean {
  return Boolean(database().prepare(`SELECT 1 FROM memory_disclosures d, memory_meta m WHERE m.id=1 AND d.thread_id=? AND d.driver_instance=? AND d.native_session=?
    AND (d.state='revoked' OR d.policy_revision!=m.policy_revision OR d.deletion_epoch!=m.deletion_epoch) LIMIT 1`).get(threadId,instanceId,session));
}

/** After the recall await and before the prompt goes out: the resumed
 * session's whole disclosure set (every record and source shown to it on any
 * turn, not only this turn's receipts) checked again against what is valid
 * now. Another thread can retire or revoke a source this session was shown
 * while this turn awaited recall; that thread revokes only its own receipts,
 * so memorySessionRevoked (state and counters) cannot see it. True when the
 * session must reset and rebuild its authorized replay. The full check is
 * skipped only while the authority epoch is unmoved since `checkedStamp`, the stamp
 * taken right after the last full check passed. */
export function resumedSessionInvalid(allowance:LineageAllowance,threadId:string,instanceId:string,session:string,access:MemoryAccess,checkedStamp:string|undefined,why?:{reason?:string}):boolean { return heldStep("memory.session-check", () => resumedSessionInvalidUnheld(allowance, threadId, instanceId, session, access, checkedStamp, why)); }
function resumedSessionInvalidUnheld(allowance:LineageAllowance,threadId:string,instanceId:string,session:string,access:MemoryAccess,checkedStamp:string|undefined,why?:{reason?:string}):boolean {
  void checkedStamp;
  return continuationMemoryRevoked(allowance,threadId,instanceId,session,access,why);
}
/** A retained native session checked in EVERY memory mode, with no reader
 * access (memory off mints none): true when it was shown memory and that
 * no longer holds, so it must reset and replay what is allowed now. A session
 * holding receipts is judged on them: any receipt revoked or made under
 * another policy revision or deletion epoch (switching memory off moves the
 * revision), any record or source it cites changed or forgotten, or a reply
 * it cites withheld. Every session, receipts or not, is also judged on the
 * replies built on memory that its context carried (its session roots, v6). */
function retainedSessionInvalidWork(allowance:LineageAllowance,threadId:string,instanceId:string,session:string,why?:{reason?:string},reader:LineageReader=AUDIENCE_SESSION_READER):boolean {
  // the write-time session predicate first (S4): O(1) seeks; anything but "shown" resets the session
  {const verdict=writetimeSessionVerdict(threadId,instanceId,session,reader,allowance);if(verdict.state!=="shown"){if(why)why.reason=verdict.state==="checking"?`checking:${verdict.reason}`:`writetime-${verdict.reason}`;return true;}}
  try {
    // a session set at the ceiling resets rather than withholding its replies (v6)
    const held=sessionOutputRoots(allowance,threadId,instanceId,session);
    if(held.over){if(why)why.reason=held.unproven?"lineage-warming":"root-ceiling";return true;}
    {const seen:{reason?:string}={};if(outputRootsBad(allowance,held,seen)){if(why)why.reason=seen.reason==="checking"?"checking:root":allowance.hit?"lineage-warming":"session-roots";return true;}}
    // what a receipt check reads: never its output list, which grows with every reply of the session
    // read within the turn's allowance: no more rows than it can pay for, and a session with more than that is unproven (warming), not read
    const cap=allowance.rowRoom(threadId,4097);
    const rows=database().prepare("SELECT bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,state,created_at FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT ?").all(threadId,instanceId,session,cap<4097?cap+1:4097);
    if(cap<4097&&rows.length>cap)allowance.readTooBig(threadId);
    allowance.spendRows(threadId,rows.length);
    if(!rows.length)return false;
    if(rows.length>4096){if(why)why.reason="too-many-receipts";return true;}
    if(preLineageSessionRevoked(rows,threadId,instanceId,session)){if(why)why.reason="pre-lineage";return true;}
    if(memorySessionRevoked(threadId,instanceId,session)){if(why)why.reason="receipt-revoked";return true;}
    const memo=new JudgeMemo<boolean>();
    for(const row of rows)if(contentRevoked(allowance,row,threadId,memo)){if(why)why.reason="memory-changed";return true;}
    if(sessionLineageBad(allowance,threadId,instanceId,session,null)){if(why)why.reason=allowance.hit?"lineage-warming":"lineage";return true;}
    return false;
  } catch (error) { if(why)why.reason=isLineageLimit(error)||allowance.hit?"lineage-warming":"check-failed"; return true; }
}

/** The reader a retained session is judged for when the caller does not say: every mark counts, audience-only ones included. */
export const AUDIENCE_SESSION_READER:LineageReader={audience:{owner:false,scopeIds:[]}};
/** The owner's own direct chat: judged by content (deny-read.ts sessionLookup), so an audience-only revoke never resets it. */
export const CONTENT_SESSION_READER:LineageReader={audience:null};
/** The write-time session predicate (DESIGN-WRITETIME 1, "Sessions"): deny_session, rs-forgotten, the session's receipts (memorySessionRevoked
 * in O(1)), and the pending window over its last lsn. Not shown means the session resets. A retained session is judged in every memory mode,
 * with no reader access: the caller names the thread's reader (CONTENT_SESSION_READER for the owner's own direct chat, which an audience-only
 * revoke never resets; every mark counts otherwise). Until write-time lineage is written on this file the read-time checks below decide alone. */
export function writetimeSessionVerdict(threadId:string,instanceId:string,session:string,reader:LineageReader=AUDIENCE_SESSION_READER,allowance?:LineageAllowance):LineageVerdict {
  const db=database();
  // S6 rule 29: the door epoch first, outside the lineageLive bypass
  const key=sessionKeyOf(threadId,instanceId,session);
  const door=doorEpochVerdict(db,key);
  if(door.state!=="shown")return door;
  if(!lineageLive(db))return {state:"shown"};
  return allowance ? continuationSessionVerdict(db,key,reader,allowance) : sessionLookup(db,key,reader);
}

// the send fence lives in send-fence.ts (drivers reach it without this module's imports); this module hands it the server database
export { assertSendFence } from "./send-fence.ts";
setSendFenceDeps({ db: database, classify: classifyDirectSettle });

/** The after-recall recheck is the same one function every later pre-submit check uses. */
export const resumedSessionInvalidAfterRecall=resumedSessionInvalid;

/** A frame check that could not finish (MEMORY_REPLAY_LIMIT: a record "checking", or the check's allowance spent) is not known to be
 * allowed now: refused as a revoked context is, tagged `unproven` with the limit error as its cause, so every dispatch caller takes the
 * rebuild path (the last rebuild carries no memory) and the limit error never fails a turn or a routine run (designs/SEND-FENCE-RECEIPT-RACE.md
 * R2; 1.0.7 routine-replay-limit: the receipt's prepare and assertCurrent re-proofs map the same way as acceptance). */
function revokedIfUnknown(run: () => void): void {
  try { run(); }
  catch(error) { if(isLineageLimit(error))throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{cause:error,unproven:"memory-frame-checking"}); throw error; }
}
/** One server-owned dispatch. Terminal events finalize while the turn capability is
 * still live; a later sendTurn resolution must not reuse that completed capability.
 */
export class MemoryDispatchReceipt {
  readonly bundle: MemoryBundle;
  readonly access: MemoryAccess;
  readonly instanceId: string;
  turnId?: string;
  /** Listeners run once each, in registration order, after the disclosure became
   * delivered and never for a turn that failed before that (owner coverage
   * counts, PIP). Each runs on its own: one that throws neither fails the turn
   * nor stops the next. */
  private deliveredListeners: Array<(bundle: MemoryBundle) => void> = [];
  addOnDelivered(listener: (bundle: MemoryBundle) => void) { this.deliveredListeners.push(listener); }
  private delivered = false;
  private observedOutput = false;
  private failure: unknown;
  constructor(bundle: MemoryBundle, access: MemoryAccess, instanceId: string) {
    this.bundle=bundle; this.access=access; this.instanceId=instanceId;
    // 1.0.7 routine-replay-limit: preparing re-proves the frame (assertMemoryBundle, a tool read's 100 ms): a record not proven within it
    // is "not known now", refused as a revoked context so the turn takes the rebuild path, never a raw MEMORY_REPLAY_LIMIT that fails it
    revokedIfUnknown(()=>prepareMemoryDisclosure(bundle,access,instanceId));
    // write-time: the frame joins the running turn (its replies, notes and session carry it)
    receiptJoinsTurn(access.threadId,access.botId,bundle.bundleId);
  }
  /** The native session this dispatch continues, when it resumes one
   * (index.ts). Its whole receipt set is re-checked right before dispatch and
   * again at acceptance, so a revoke that lands in between ends the session
   * instead of letting the new frame be accepted into it. */
  private resumedSession?: string;
  /** The durable proof replaces the former per-dispatch authority stamp. */
  resumes(session:string,_checkedStamp?:string) { this.resumedSession=session; this.bindFirstRetainedFrame(session); }
  /** Room writes use the same bounded live-access proof as preparation. */
  private retainedContext?: SessionProofContext;
  retains(session:string,ctx:SessionProofContext) { this.resumedSession=session; this.retainedContext=ctx; this.bindFirstRetainedFrame(session); }
  /** MAIN RULING 1115-RECALL-GROK-Q1Q2: a known empty retained key must
   * lose its empty-session bit before its first frame can reach an adapter.
   * The real reader checkpoint is proved here with ordinary retained S1. */
  private bindFirstRetainedFrame(session:string) {
    const key=sessionKeyOf(this.access.threadId,this.instanceId,session);
    if(sessionHadFrame(database(),key)!==false)return;
    const bind=()=>{noteSessionFrame(database(),key,true);bindMemoryDisclosureSession(this.bundle.bundleId,session);};
    initializeFreshSessionProof(key,this.access,bind,{fresh:false});
    this.boundSession=session;
  }
  /** Every pre-submit check (before dispatch, after the image await, at the
   * submission boundary, at acceptance) runs the same FULL validation as the
   * after-recall recheck: every record and source disclosed to the session on
   * any turn, not only receipt state and counters. Another thread can retire a
   * source this session was shown while this turn awaits. The failure is
   * MEMORY_CONTEXT_REVOKED, which re-dispatches the turn once while no prompt
   * was submitted; the re-dispatch finds the session invalid and resets. */
  private replayConfirmation?:FreshReplaySessionConfirmation;
  submissionReplayConfirmation(confirmation:FreshReplaySessionConfirmation){this.replayConfirmation=confirmation;}
  private assertSessionCurrent(submission=false) {
    if(this.resumedSession===undefined)return;
    const key=sessionKeyOf(this.access.threadId,this.instanceId,this.resumedSession),ctx={access:this.access,disclosed:this.retainedContext?.disclosed??true};
    const proof=submission&&this.replayConfirmation&&!this.retainedContext?proveRetainedSessionAtSubmission(LineageAllowance.tool(),key,ctx,this.replayConfirmation):proveRetainedSession(LineageAllowance.tool(),key,ctx);
    if(proof.kind==='fresh'){console.warn(`memory continuation refused thread=${this.access.threadId} engine=${this.instanceId} reason=${proof.reason}`);throw sessionCheckRefusal({reason:proof.cause==='checking'?'lineage-warming':proof.reason});}
  }
  assertCurrent(submission=false) { if(this.failure)throw this.failure; revokedIfUnknown(()=>assertMemoryBundle(this.bundle,this.access)); this.assertSessionCurrent(submission); }
  private boundSession?: string;
  /** Native-start producer owner: recall-fix-a (index.ts); first-reader consumer owner: recall-fix-a. */
  sessionStarted(sessionId:string,fresh=false,birthConfirmation?:FreshReplaySessionConfirmation) {
    const key=sessionKeyOf(this.access.threadId,this.instanceId,sessionId);
    const bind=()=>{noteSessionFrame(database(),key,true);bindMemoryDisclosureSession(this.bundle.bundleId,sessionId);};
    initializeFreshSessionProof(key,this.access,bind,{fresh,confirmation:this.replayConfirmation??birthConfirmation});
    this.boundSession=sessionId;
  }
  /** Before a live steer joins this running session: the same full validation
   * every pre-submit check runs, over every source disclosed to the session.
   * False when it no longer holds (or cannot be checked): the message is then
   * not steered but routed as its own turn, which resets the session. */
  steerable(): boolean {
    try {
      if(this.failure)return false;
      assertMemoryBundle(this.bundle,this.access);
      const session=this.boundSession??this.resumedSession;
      return session===undefined||proveRetainedSession(LineageAllowance.tool(),sessionKeyOf(this.access.threadId,this.instanceId,session),{access:this.access,disclosed:true}).kind==='resume';
    } catch { return false; }
  }
  /** Acceptance, run by every adapter write (SendTurnInput.beforeSubmit) and
   * by the server's own acceptance: the receipt and the whole session are
   * validated on EVERY call; only the delivery bookkeeping below happens
   * once. An adapter can hand its turn id back before it writes (ACP, Codex),
   * so a first acceptance never vouches for a later write. */
  /** Preparation has no delivery side effects (MAIN RULING recall-k). */
  private validateAcceptance(submission:boolean):boolean {
    if(this.failure)throw this.failure;
    if(this.finished&&this.delivered)return false;
    revokedIfUnknown(()=>assertMemoryDisclosureCurrent(this.bundle.bundleId,this.access));
    this.assertSessionCurrent(submission);
    return true;
  }
  private recordDelivery() {
    if(!this.delivered){
      revokedIfUnknown(()=>deliverMemoryDisclosure(this.bundle.bundleId,this.access));this.delivered=true;
      for(const listener of this.deliveredListeners){try{listener(this.bundle);}catch{/* a bookkeeping failure never fails the turn */}}
    }
  }
  accepted(submission=true) {
    if(this.validateAcceptance(submission)&&submission)this.recordDelivery();
  }
  /** Event subscribers cannot throw out of the shared bus or skip capability
   * cleanup. A terminal event only completes the bookkeeping: it is not a write. */
  completed(ok:boolean) { if((ok||this.observedOutput)&&!this.delivered)try { this.accepted(); } catch(error) { this.failure=error; } this.finished=true; }
  private finished=false;
  output(messageId:string) {
    this.observedOutput=true; linkMemoryDisclosureOutput(this.bundle.bundleId,messageId);
    if(this.lookupBundleId)linkMemoryDisclosureOutput(this.lookupBundleId,messageId);
  }
  /** Records the turn read through memory_search or memory_get (0.1.61 T2
   * R3-4): a reply built from a lookup rests on it as much as on the frame.
   * They go on a companion receipt of the same session (never on the frame's
   * own, whose exact record list decides whether a session continues), dated
   * just before it, whose outputs are this turn's outputs. */
  private lookupBundleId?: string;
  noteLookup(records:ReadonlyArray<{id:string;version:number;evidence:ReadonlyArray<{sourceId:string;revision:number}>}>,access:MemoryAccess) {
    if(!records.length||access.botId!==this.access.botId||access.threadId!==this.access.threadId||access.generation!==this.access.generation)return;
    const priorLookup = this.lookupBundleId;
    onRollback(() => { this.lookupBundleId = priorLookup; });
    if(!noteMemoryLookup(this.bundle.bundleId,this.lookupBundleId??=`${this.bundle.bundleId}:lookup`,records))
      throw Object.assign(new Error("MEMORY_LOOKUP_LIMIT: this turn has looked up as much as it can; answer with what you have"),{status:409});
    // write-time: what the turn looked up joins it (a note it writes next rests on it)
    receiptJoinsTurn(this.access.threadId,this.access.botId,this.lookupBundleId);
  }
  /** Sources the turn was shown outside the frame (the replies its working
   * context quotes, working-context.ts): a reply built from them rests on them. */
  noteSources(sources:ReadonlyArray<{sourceId:string;revision:number}>) {
    if(!sources.length)return true;
    const priorLookup = this.lookupBundleId;
    onRollback(() => { this.lookupBundleId = priorLookup; });
    const noted=noteMemoryLookup(this.bundle.bundleId,this.lookupBundleId??=`${this.bundle.bundleId}:lookup`,[],sources);
    if(noted)receiptJoinsTurn(this.access.threadId,this.access.botId,this.lookupBundleId);
    return noted;
  }
  /** Resolve a turn-local handle (m1, m2, …) from the remembered-context frame
   * this receipt delivered. Only the capability that dispatched the turn may
   * resolve its handles: the same bot, thread and generation (MEMJSON2). */
  resolveHandle(handle:string,access:MemoryAccess):{id:string;version:number}|undefined {
    if(access.botId!==this.access.botId||access.threadId!==this.access.threadId||access.generation!==this.access.generation)return undefined;
    return memoryHandleRecord(this.bundle,handle);
  }
}

/** Session shutdown can overlap checkpoint publication. Build only after that
 * await, keeping the original authority snapshot so revocation still fails.
 * Undefined reset preserves a session already judged valid by the room. */
export async function buildMemoryBundleAfterReset(
  query: string, access: MemoryAccess, bridge: MemorySearchBridge,
  reset: (() => Promise<void>) | undefined, options: Parameters<typeof buildMemoryBundle>[3],
  preparedBuild?: typeof buildMemoryBundle,
) {
  assertMemoryAccess(access);
  await reset?.();
  // a branch move still being flipped (memory/branch-change.ts) is finished before anything is recalled, so no source of
  // an abandoned branch is read as live
  await drainBranchChanges(database());
  assertMemoryAccess(access);
  // Producer: recall-scope owns the guarded read; consumer: nl-backup-b owns
  // host readiness. Reset and branch draining still happen exactly once.
  if (preparedBuild) return preparedBuild(query, access, bridge, options);
  return buildMemoryBundle(query, access, bridge, options);
}

/** The owner-facing reason a turn was refused over its pinned memory, in plain
 * words (0.1.61 final check D3: the raw code reached the room twice per bot).
 * `subject` names whose pins they are ("its", "Moss's"). Undefined for any
 * other failure, which keeps its own message. */
export function pinnedMemoryFailure(error: unknown, subject: string): string | undefined {
  if (error instanceof MemoryPinSetTooLarge) return `${(subject === "its" ? "This bot" : subject.replace(/\'s$/, ""))} has more pinned memories than Murage can check before a reply, so this message was not sent. Unpin some in Memory.`;
  if (error instanceof MemoryPinProjectionPending) return `${subject} pinned memory is still being prepared, so this message was not sent. Send it again in a moment. If this keeps happening, open Memory.`;
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("MEMORY_PIN_UNAVAILABLE")) return `${subject} pinned memory rests on something that was deleted or changed. Unpin it or fix it in Memory.`;
  return undefined;
}

/** How a refused turn ended, for the person (noteTurnRefused in index.ts): its last rebuild ran with no remembered context, or nothing could
 * start it at all. */
export type TurnRefusedKind = "without-memory" | "without-memory-checking" | "without-memory-unknown" | "not-started" | "after-submission" | "after-submission-uncertain" | "unknown-submission" | "resend-offer";
/** One classification for setup catches and late terminal events, in direct chats and rooms alike. */
export function submissionRefusalKind(boundary: { hasConfirmedSubmission: boolean; hasReleasedSubmission: boolean; canRetry: boolean }): TurnRefusedKind {
  return boundary.hasConfirmedSubmission ? "after-submission"
    : boundary.hasReleasedSubmission ? "after-submission-uncertain"
    : boundary.canRetry ? "not-started" : "unknown-submission";
}
/** Notice evidence only: never an authorization or a retry decision. */
export type MemoryRefusalCause = "checking" | "changed" | "unknown";
const checkingReasons = new Set(["no-lineage", "thread-not-ready", "pending", "footprint-wide", "lookup-error", "not-built"]);
const changedReasons = new Set(["own-flag", "tombstone", "thread-deny", "deny-line", "deny-range", "watermark", "footprint",
  "deny-session", "session-forgotten", "deny-memory", "scope-deny", "murage-anchor", "door-epoch"]);
/** Normalize the raw send-fence error and EngineInputRevoked's wrapper together. A recognized withheld verdict wins;
 * otherwise malformed or inconsistent evidence is unknown. Only the two supported unfinished-session producers qualify. */
export function memoryRefusalCause(error: unknown): MemoryRefusalCause {
  try {
    if (!error || typeof error !== "object") return "unknown";
    const tags = error as { fence?: unknown; verdict?: unknown; unproven?: unknown };
    const verdicts = [tags.fence, tags.verdict].filter(value => value !== undefined);
    const valid = (value: unknown, state: string, reasons: Set<string>): boolean => {
      if (!value || typeof value !== "object") return false;
      const v = value as { state?: unknown; reason?: unknown };
      return v.state === state && typeof v.reason === "string" && reasons.has(v.reason);
    };
    if (verdicts.some(value => valid(value, "withheld", changedReasons))) return "changed";
    if (tags.unproven !== undefined && tags.unproven !== "lineage-warming" && tags.unproven !== "memory-frame-checking") return "unknown";
    if (verdicts.length) {
      if (!verdicts.every(value => valid(value, "checking", checkingReasons))) return "unknown";
      if (verdicts.length === 2 && (verdicts[0] as { reason: string }).reason !== (verdicts[1] as { reason: string }).reason) return "unknown";
      return "checking";
    }
    return tags.unproven === undefined ? "unknown" : "checking";
  } catch { return "unknown"; }
}
/** Any observed change wins; incomplete history never becomes checking-only again. */
export function mergeMemoryRefusalCause(previous: MemoryRefusalCause, next: MemoryRefusalCause): MemoryRefusalCause {
  return previous === "changed" || next === "changed" ? "changed" : previous === "unknown" || next === "unknown" ? "unknown" : "checking";
}
export function memoryRefusalKind(cause: MemoryRefusalCause = "unknown"): TurnRefusedKind {
  return cause === "changed" ? "without-memory" : cause === "checking" ? "without-memory-checking" : "without-memory-unknown";
}
/** Bounded evidence per logical direct turn, independent of the one-shot last-resort marker. Missing mid-retry means
 * eviction/incomplete history, never a fresh checking-only chain. Room members carry their own value through recursion instead. */
export class MemoryRefusalCauses {
  private readonly causes = new Map<string, MemoryRefusalCause>();
  private readonly diagnoses = new Map<string, FenceRefusalDiagnosis>();
  private readonly max: number;
  constructor(max = 512) { this.max = Math.max(1, max); }
  record(messageId: string, error: unknown, newLogicalAttempt: boolean): void {
    const previous = this.causes.get(messageId) ?? (newLogicalAttempt ? "checking" : "unknown");
    if (!this.causes.has(messageId) && this.causes.size >= this.max) this.delete(this.causes.keys().next().value!);
    this.causes.set(messageId, mergeMemoryRefusalCause(previous, memoryRefusalCause(error)));
    this.diagnoses.set(messageId, fenceRefusalDiagnosis(error));
  }
  kind(messageId: string): TurnRefusedKind { return memoryRefusalKind(this.causes.get(messageId)); }
  diagnosis(messageId: string): FenceRefusalDiagnosis | undefined { return this.diagnoses.get(messageId); }
  delete(messageId: string): void { this.causes.delete(messageId); this.diagnoses.delete(messageId); }
}
/** D7: the one plain line under a blocked rebuild; the single shared constant lives in shared/resend-offer.ts. */
export { RESEND_OFFER_LINE };
/** The owner-facing line for a turn refused at its send (1.0.2 Keep all P0: a refusal is never silent). Plain words naming the engine, never
 * the code: what happened and, when the reply did not run, what to do. */
export function turnRefusedLine(engine: string, kind: TurnRefusedKind): string {
  if (kind === "unknown-submission") return "Context changed; previous attempt may have started. Review its output before trying again.";
  if (kind === "resend-offer") return RESEND_OFFER_LINE;
  if (kind === "after-submission" || kind === "after-submission-uncertain") return `${kind === "after-submission" ? "The original message was submitted." : "The earlier submission may have started."} Murage could not send it again because the submission checks failed. It was not automatically sent again.`;
  return kind === "without-memory-checking" ? MESSAGE_ONLY_NOTE
    : kind === "without-memory-unknown" ? "This reply ran without remembered context."
    : kind === "without-memory" ? `Memory changed while ${engine} was starting, so this reply ran without remembered context.`
    : `${engine} could not start this reply. Send it again.`;
}
/** How many times a turn refused over revoked memory context and proven unwritten (refused before its write, or at a late write by an engine
 * that hands its id back first: ACP, Codex, Grok, OpenCode, Gemini, openai-chat) is rebuilt and sent again, each time against the deny
 * generation of its own build. The last of these rebuilds is the last resort (fresh session, no memory); past it the turn settles with a
 * card (1.0.3 engine-switch: the second refusal used to return early with no card at all). */
export const MEMORY_REDISPATCH_ATTEMPTS = FENCE_REBUILDS;
/** The next rebuild of a turn refused over memory and proven unwritten: its attempt number and whether it is the last resort (index.ts
 * memoryLastResort / roomLastResort: fresh session, no memory frame, no working context, its replay lines judged one by one at the fence).
 * Undefined once the last resort was refused too: the turn ends with a card. ONE rule for every site that rebuilds: the direct turn's setup
 * refusal and late refusal, and the room member's two (1.0.4 SETUP-LAST-RESORT: the direct setup path rebuilt three times with memory and
 * then showed the card, never reaching the last resort). `done` is the rebuilds already made (0 for the first dispatch). */
export function nextMemoryRebuild(done: number): { attempt: number; lastResort: boolean } | undefined {
  const next = nextFenceTier(done);
  return next ? { attempt: next.tier, lastResort: next.tier === 2 } : undefined;
}
/** The refusal a submission-boundary recheck of a resumed session throws (MemoryDispatchReceipt above, index.ts alsoCheck). Always
 * MEMORY_CONTEXT_REVOKED, so it is handled as every refusal is and nothing unproven is ever written into the session (fail closed). When the
 * check ran out of its allowance (its 100 ms or its nodes: "lineage-warming") rather than finding anything revoked, it says so (`unproven`),
 * so a timeout is never logged as a revoke (1.0.4 SETUP-LAST-RESORT). */
export function sessionCheckRefusal(why: { reason?: string }): Error {
  const error = new Error("MEMORY_CONTEXT_REVOKED");
  if (why.reason?.startsWith("checking:")) {
    const reason = why.reason.slice("checking:".length);
    if (reason === "root" || checkingReasons.has(reason)) {
      return Object.assign(error, { continuationReason: why.reason,
        ...(checkingReasons.has(reason) ? { fence: { state: "checking", reason } } : {}) });
    }
  }
  return why.reason === "lineage-warming" ? Object.assign(error, { unproven: why.reason }) : error;
}
/** For a re-prepare log line: empty for a revoke, the reason for a session check that ran out of its allowance. Never an id or text. */
export function refusalCauseNote(error: unknown): string {
  const reason = error instanceof Error ? (error as Error & { continuationReason?: unknown }).continuationReason : undefined;
  if (typeof reason === "string" && reason.startsWith("checking:") && (reason === "checking:root" || checkingReasons.has(reason.slice("checking:".length)))) return `; continuation=${reason}`;
  const unproven = error instanceof Error ? (error as Error & { unproven?: unknown }).unproven : undefined;
  return typeof unproven === "string" ? `; the session check ran out of its lineage allowance (${unproven}), not a revoke` : "";
}
/** The owner-facing line when a turn's memory context was revoked at every send, the last rebuild included (index.ts
 * MEMORY_REDISPATCH_ATTEMPTS): what happened and what to do, naming the engine, never the code. */
export function lateMemoryRefusalLine(engine: string): string {
  return turnRefusedLine(engine, "not-started");
}

/** Murage's line when a turn went without an owner pin because the pin rests
 * on a reply bots no longer see (bundle.ts withheldPins; 0.1.61 third check,
 * P1). Said on each affected reply. Undefined when nothing was left out. */
export const WITHHELD_PIN_LINE = "Bots were not given a pinned note because its supporting replies could not be used or fully checked. Unpin it in Memory, then pin a newer one if you still want it.";
export function withheldPinLine(_threadId: string, bundle: MemoryBundle & {withheldPins?: ReadonlyArray<{id: string; version: number}>}): string | undefined {
  return bundle.withheldPins?.length ? WITHHELD_PIN_LINE : undefined;
}

/** Review H1: capacity omissions are disclosed on each affected reply. */
export const DROPPED_PIN_LINE = "Murage left some pinned memories out of this reply: together they are longer than this model has room for. To bring them back, unpin or shorten a few in Memory, or choose a model that takes more context.";
export function droppedPinLine(_threadId: string, bundle: MemoryBundle & {droppedPins?: ReadonlyArray<{id: string; version: number}>}): string | undefined {
  return bundle.droppedPins?.length ? DROPPED_PIN_LINE : undefined;
}

// ---- the entry points of the lineage reads, each timed (see LineageAllowance.timed) ----
/** retainedSessionInvalid, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time), with one second look when the clock stopped it. */
export function retainedSessionInvalid(allowance:LineageAllowance,threadId:string,instanceId:string,session:string,why:{reason?:string}={},reader?:LineageReader):boolean { return withSecondLook(allowance,why,turn=>retainedSessionInvalidWork(turn,threadId,instanceId,session,why,reader)); }
