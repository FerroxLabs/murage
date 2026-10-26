import type { MemoryBundle } from "../../shared/memory.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { MemorySearchBridge } from "./search.ts";
import { authorityStamp } from "./authority-epoch.ts";
import { contentRevoked, isLineageLimit, JudgeMemo, LineageAllowance, outputRootsBad, preLineageSessionRevoked, sessionLineageBad, sessionOutputRoots } from "./replay-lineage.ts";
import { assertMemoryBundle, buildMemoryBundle, memoryHandleRecord } from "./bundle.ts";
import { assertMemoryDisclosureCurrent, bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, linkMemoryDisclosureOutput, noteMemoryLookup, prepareMemoryDisclosure, receiptJoinsTurn } from "./disclosures.ts";
import { heldStep } from "../observe.ts";
import { doorEpochVerdict, lineageLive, sessionLookup } from "./deny-read.ts";
import { setSendFenceDeps } from "./send-fence.ts";
import type { LineageReader, LineageVerdict } from "./lineage-types.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { drainBranchChanges } from "./branch-change.ts";

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
  if(checkedStamp!==undefined&&authorityStamp()===checkedStamp)return false;
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
  {const verdict=writetimeSessionVerdict(threadId,instanceId,session,reader);if(verdict.state!=="shown"){if(why)why.reason=verdict.state==="checking"?"checking":`writetime-${verdict.reason}`;return true;}}
  try {
    // a session set at the ceiling resets rather than withholding its replies (v6)
    const held=sessionOutputRoots(allowance,threadId,instanceId,session);
    if(held.over){if(why)why.reason=held.unproven?"lineage-warming":"root-ceiling";return true;}
    {const seen:{reason?:string}={};if(outputRootsBad(allowance,held,seen)){if(why)why.reason=seen.reason==="checking"?"checking":allowance.hit?"lineage-warming":"session-roots";return true;}}
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
export function writetimeSessionVerdict(threadId:string,instanceId:string,session:string,reader:LineageReader=AUDIENCE_SESSION_READER):LineageVerdict {
  const db=database();
  // S6 rule 29: the door epoch first, outside the lineageLive bypass
  const key=sessionKeyOf(threadId,instanceId,session);
  const door=doorEpochVerdict(db,key);
  if(door.state!=="shown")return door;
  if(!lineageLive(db))return {state:"shown"};
  return sessionLookup(db,key,reader);
}

// the send fence lives in send-fence.ts (drivers reach it without this module's imports); this module hands it the server database
export { assertSendFence } from "./send-fence.ts";
setSendFenceDeps({ db: database });

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
    try { receiptJoinsTurn(access.threadId,access.botId,bundle.bundleId); } catch { /* the line keeps its own receipt link (linkMemoryDisclosureOutput) */ }
  }
  /** The native session this dispatch continues, when it resumes one
   * (index.ts). Its whole receipt set is re-checked right before dispatch and
   * again at acceptance, so a revoke that lands in between ends the session
   * instead of letting the new frame be accepted into it. */
  private resumedSession?: string;
  /** authorityStamp() right after the last full session check passed: an unmoved authority epoch skips the next one. */
  private sessionCheckedStamp?: string;
  resumes(session:string,checkedStamp?:string) { this.resumedSession=session; this.sessionCheckedStamp=checkedStamp; }
  /** Every pre-submit check (before dispatch, after the image await, at the
   * submission boundary, at acceptance) runs the same FULL validation as the
   * after-recall recheck: every record and source disclosed to the session on
   * any turn, not only receipt state and counters. Another thread can retire a
   * source this session was shown while this turn awaits. The failure is
   * MEMORY_CONTEXT_REVOKED, which re-dispatches the turn once while no prompt
   * was submitted; the re-dispatch finds the session invalid and resets. */
  private assertSessionCurrent() {
    if(this.resumedSession===undefined)return;
    const why:{reason?:string}={};
    if(resumedSessionInvalid(LineageAllowance.tool(),this.access.threadId,this.instanceId,this.resumedSession,this.access,this.sessionCheckedStamp,why))throw sessionCheckRefusal(why);
    this.sessionCheckedStamp=authorityStamp();
  }
  assertCurrent() { if(this.failure)throw this.failure; revokedIfUnknown(()=>assertMemoryBundle(this.bundle,this.access)); this.assertSessionCurrent(); }
  private boundSession?: string;
  sessionStarted(sessionId:string) { bindMemoryDisclosureSession(this.bundle.bundleId,sessionId); this.boundSession=sessionId; }
  /** Before a live steer joins this running session: the same full validation
   * every pre-submit check runs, over every source disclosed to the session.
   * False when it no longer holds (or cannot be checked): the message is then
   * not steered but routed as its own turn, which resets the session. */
  steerable(): boolean {
    try {
      if(this.failure)return false;
      assertMemoryBundle(this.bundle,this.access);
      const session=this.boundSession??this.resumedSession;
      return session===undefined||!resumedSessionInvalid(LineageAllowance.tool(),this.access.threadId,this.instanceId,session,this.access,undefined);
    } catch { return false; }
  }
  /** Acceptance, run by every adapter write (SendTurnInput.beforeSubmit) and
   * by the server's own acceptance: the receipt and the whole session are
   * validated on EVERY call; only the delivery bookkeeping below happens
   * once. An adapter can hand its turn id back before it writes (ACP, Codex),
   * so a first acceptance never vouches for a later write. */
  accepted() {
    if(this.failure)throw this.failure;
    // A terminal event already settled the turn: no write can follow it, and
    // its capability may be gone; acceptance only confirms the bookkeeping.
    if(this.finished&&this.delivered)return;
    // A record of the frame that reads "checking" here (a revoke still being walked: MEMORY_REPLAY_LIMIT) is not known to be allowed now: the
    // write is refused as a revoked context is, so the turn takes the same rebuild path (the last rebuild carries no memory) instead of
    // ending as "could not start" (designs/SEND-FENCE-RECEIPT-RACE.md, R2). Nothing is written either way.
    // Both validations (this one and deliverMemoryDisclosure's own) map the same way (Astra design review M1); the cause keeps the limit for
    // the refusal's diagnosis.
    revokedIfUnknown(()=>assertMemoryDisclosureCurrent(this.bundle.bundleId,this.access));
    this.assertSessionCurrent();
    if(!this.delivered){
      revokedIfUnknown(()=>deliverMemoryDisclosure(this.bundle.bundleId,this.access));this.delivered=true;
      for(const listener of this.deliveredListeners){try{listener(this.bundle);}catch{/* a bookkeeping failure never fails the turn */}}
    }
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
    if(!noteMemoryLookup(this.bundle.bundleId,this.lookupBundleId??=`${this.bundle.bundleId}:lookup`,records))
      throw Object.assign(new Error("MEMORY_LOOKUP_LIMIT: this turn has looked up as much as it can; answer with what you have"),{status:409});
    // write-time: what the turn looked up joins it (a note it writes next rests on it)
    try { receiptJoinsTurn(this.access.threadId,this.access.botId,this.lookupBundleId); } catch { /* outputs still link the lookup receipt */ }
  }
  /** Sources the turn was shown outside the frame (the replies its working
   * context quotes, working-context.ts): a reply built from them rests on them. */
  noteSources(sources:ReadonlyArray<{sourceId:string;revision:number}>) {
    if(!sources.length)return true;
    const noted=noteMemoryLookup(this.bundle.bundleId,this.lookupBundleId??=`${this.bundle.bundleId}:lookup`,[],sources);
    if(noted)try { receiptJoinsTurn(this.access.threadId,this.access.botId,this.lookupBundleId); } catch { /* outputs still link the lookup receipt */ }
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
 * await, keeping the original authority snapshot so revocation still fails. */
export async function buildMemoryBundleAfterReset(
  query: string, access: MemoryAccess, bridge: MemorySearchBridge,
  reset: () => Promise<void>, options: Parameters<typeof buildMemoryBundle>[3],
) {
  assertMemoryAccess(access);
  await reset();
  // a branch move still being flipped (memory/branch-change.ts) is finished before anything is recalled, so no source of
  // an abandoned branch is read as live
  await drainBranchChanges(database());
  assertMemoryAccess(access);
  return buildMemoryBundle(query, access, bridge, options);
}

/** The owner-facing reason a turn was refused over its pinned memory, in plain
 * words (0.1.61 final check D3: the raw code reached the room twice per bot).
 * `subject` names whose pins they are ("its", "Moss's"). Undefined for any
 * other failure, which keeps its own message. */
export function pinnedMemoryFailure(error: unknown, subject: string): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("MEMORY_PIN_UNAVAILABLE")) return `${subject} pinned memory rests on something that was deleted or changed. Unpin it or fix it in Memory.`;
  return undefined;
}

/** How a refused turn ended, for the person (noteTurnRefused in index.ts): its last rebuild ran with no remembered context, or nothing could
 * start it at all. */
export type TurnRefusedKind = "without-memory" | "not-started";
/** The owner-facing line for a turn refused at its send (1.0.2 Keep all P0: a refusal is never silent). Plain words naming the engine, never
 * the code: what happened and, when the reply did not run, what to do. */
export function turnRefusedLine(engine: string, kind: TurnRefusedKind): string {
  return kind === "without-memory" ? `Memory changed while ${engine} was starting, so this reply ran without remembered context.`
    : `${engine} could not start this reply. Send it again.`;
}
/** How many times a turn refused over revoked memory context and proven unwritten (refused before its write, or at a late write by an engine
 * that hands its id back first: ACP, Codex, Grok, OpenCode, Gemini, openai-chat) is rebuilt and sent again, each time against the deny
 * generation of its own build. The last of these rebuilds is the last resort (fresh session, no memory); past it the turn settles with a
 * card (1.0.3 engine-switch: the second refusal used to return early with no card at all). */
export const MEMORY_REDISPATCH_ATTEMPTS = 3;
/** The next rebuild of a turn refused over memory and proven unwritten: its attempt number and whether it is the last resort (index.ts
 * memoryLastResort / roomLastResort: fresh session, no memory frame, no working context, its replay lines judged one by one at the fence).
 * Undefined once the last resort was refused too: the turn ends with a card. ONE rule for every site that rebuilds: the direct turn's setup
 * refusal and late refusal, and the room member's two (1.0.4 SETUP-LAST-RESORT: the direct setup path rebuilt three times with memory and
 * then showed the card, never reaching the last resort). `done` is the rebuilds already made (0 for the first dispatch). */
export function nextMemoryRebuild(done: number): { attempt: number; lastResort: boolean } | undefined {
  if (!(done >= 0) || done >= MEMORY_REDISPATCH_ATTEMPTS) return undefined;
  const attempt = Math.floor(done) + 1;
  return { attempt, lastResort: attempt >= MEMORY_REDISPATCH_ATTEMPTS };
}
/** The refusal a submission-boundary recheck of a resumed session throws (MemoryDispatchReceipt above, index.ts alsoCheck). Always
 * MEMORY_CONTEXT_REVOKED, so it is handled as every refusal is and nothing unproven is ever written into the session (fail closed). When the
 * check ran out of its allowance (its 100 ms or its nodes: "lineage-warming") rather than finding anything revoked, it says so (`unproven`),
 * so a timeout is never logged as a revoke (1.0.4 SETUP-LAST-RESORT). */
export function sessionCheckRefusal(why: { reason?: string }): Error {
  const error = new Error("MEMORY_CONTEXT_REVOKED");
  return why.reason === "lineage-warming" ? Object.assign(error, { unproven: why.reason }) : error;
}
/** For a re-prepare log line: empty for a revoke, the reason for a session check that ran out of its allowance. Never an id or text. */
export function refusalCauseNote(error: unknown): string {
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
 * P1). Said once per thread for each pinned version, so a room of members
 * each leaving it out hears it once. Undefined when nothing new was left out. */
export const WITHHELD_PIN_LINE = "Bots were not given a pinned note: it uses a reply they no longer see. Unpin it in Memory, then pin a newer one if you still want it.";
const withheldPinsNoted = new Map<string, Set<string>>();
export function withheldPinLine(threadId: string, bundle: MemoryBundle & {withheldPins?: ReadonlyArray<{id: string; version: number}>}): string | undefined {
  if (!bundle.withheldPins?.length) return undefined;
  let noted = withheldPinsNoted.get(threadId);
  if (!noted) {
    if (withheldPinsNoted.size >= 512) withheldPinsNoted.delete(withheldPinsNoted.keys().next().value!);
    noted = new Set(); withheldPinsNoted.set(threadId, noted);
  }
  const fresh = bundle.withheldPins.map(pin => `${pin.id}@${pin.version}`).filter(key => !noted.has(key));
  for (const key of fresh) noted.add(key);
  return fresh.length ? WITHHELD_PIN_LINE : undefined;
}

/** Murage's line when a turn ran without some owner pins because together they are longer than this model has room for (bundle.ts
 * droppedPins, 1.0.4). Said once per thread: every later turn of a small model would leave the same pins out. */
export const DROPPED_PIN_LINE = "Murage left some pinned memories out of this reply: together they are longer than this model has room for. To bring them back, unpin or shorten a few in Memory, or choose a model that takes more context.";
const droppedPinsNoted = new Set<string>();
export function droppedPinLine(threadId: string, bundle: MemoryBundle & {droppedPins?: ReadonlyArray<{id: string; version: number}>}): string | undefined {
  if (!bundle.droppedPins?.length || droppedPinsNoted.has(threadId)) return undefined;
  if (droppedPinsNoted.size >= 512) droppedPinsNoted.delete(droppedPinsNoted.values().next().value!);
  droppedPinsNoted.add(threadId);
  return DROPPED_PIN_LINE;
}

// ---- the entry points of the lineage reads, each timed (see LineageAllowance.timed) ----
/** retainedSessionInvalid, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time). */
export function retainedSessionInvalid(...args: Parameters<typeof retainedSessionInvalidWork>): ReturnType<typeof retainedSessionInvalidWork> { return args[0].timed(() => retainedSessionInvalidWork(...args)); }
