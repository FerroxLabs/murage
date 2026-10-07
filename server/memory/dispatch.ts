import type { MemoryBundle } from "../../shared/memory.ts";
import { database } from "../database.ts";
import { assertMemoryAccess, type MemoryAccess } from "./policy.ts";
import type { MemorySearchBridge } from "./search.ts";
import { contentRevoked, databaseStamp, outputRootsBad, preLineageSessionRevoked, sessionLineageBad, sessionOutputRoots } from "./replay-lineage.ts";
import { assertMemoryBundle, buildMemoryBundle, memoryHandleRecord } from "./bundle.ts";
import { assertMemoryDisclosureCurrent, bindMemoryDisclosureSession, continuationMemoryRevoked, deliverMemoryDisclosure, linkMemoryDisclosureOutput, noteMemoryLookup, prepareMemoryDisclosure } from "./disclosures.ts";

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
  const latest=database().prepare("SELECT record_versions,source_versions,policy_revision,deletion_epoch FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? AND state='delivered' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId,instanceId,session);
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
 * skipped only while the database is unmoved since `checkedStamp`, the stamp
 * taken right after the last full check passed. */
export function resumedSessionInvalid(threadId:string,instanceId:string,session:string,access:MemoryAccess,checkedStamp:string|undefined,why?:{reason?:string}):boolean {
  if(checkedStamp!==undefined&&databaseStamp()===checkedStamp)return false;
  return continuationMemoryRevoked(threadId,instanceId,session,access,why);
}
/** A retained native session checked in EVERY memory mode, with no reader
 * access (memory off mints none): true when it was shown memory and that
 * no longer holds, so it must reset and replay what is allowed now. A session
 * holding receipts is judged on them: any receipt revoked or made under
 * another policy revision or deletion epoch (switching memory off moves the
 * revision), any record or source it cites changed or forgotten, or a reply
 * it cites withheld. Every session, receipts or not, is also judged on the
 * replies built on memory that its context carried (its session roots, v6). */
export function retainedSessionInvalid(threadId:string,instanceId:string,session:string,why?:{reason?:string}):boolean {
  try {
    // a session set at the ceiling resets rather than withholding its replies (v6)
    const held=sessionOutputRoots(threadId,instanceId,session);
    if(held.over){if(why)why.reason="root-ceiling";return true;}
    if(outputRootsBad(held)){if(why)why.reason="session-roots";return true;}
    const rows=database().prepare("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? LIMIT 4097").all(threadId,instanceId,session);
    if(!rows.length)return false;
    if(rows.length>4096){if(why)why.reason="too-many-receipts";return true;}
    if(preLineageSessionRevoked(rows,threadId,instanceId,session)){if(why)why.reason="pre-lineage";return true;}
    if(memorySessionRevoked(threadId,instanceId,session)){if(why)why.reason="receipt-revoked";return true;}
    for(const row of rows)if(contentRevoked(row,threadId)){if(why)why.reason="memory-changed";return true;}
    if(sessionLineageBad(threadId,instanceId,session,null)){if(why)why.reason="lineage";return true;}
    return false;
  } catch { if(why)why.reason="check-failed"; return true; }
}

/** The after-recall recheck is the same one function every later pre-submit check uses. */
export const resumedSessionInvalidAfterRecall=resumedSessionInvalid;

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
    prepareMemoryDisclosure(bundle,access,instanceId);
  }
  /** The native session this dispatch continues, when it resumes one
   * (index.ts). Its whole receipt set is re-checked right before dispatch and
   * again at acceptance, so a revoke that lands in between ends the session
   * instead of letting the new frame be accepted into it. */
  private resumedSession?: string;
  /** databaseStamp() right after the last full session check passed: an unmoved database skips the next one. */
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
    if(resumedSessionInvalid(this.access.threadId,this.instanceId,this.resumedSession,this.access,this.sessionCheckedStamp))throw new Error("MEMORY_CONTEXT_REVOKED");
    this.sessionCheckedStamp=databaseStamp();
  }
  assertCurrent() { if(this.failure)throw this.failure; assertMemoryBundle(this.bundle,this.access); this.assertSessionCurrent(); }
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
      return session===undefined||!resumedSessionInvalid(this.access.threadId,this.instanceId,session,this.access,undefined);
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
    assertMemoryDisclosureCurrent(this.bundle.bundleId,this.access);
    this.assertSessionCurrent();
    if(!this.delivered){
      deliverMemoryDisclosure(this.bundle.bundleId,this.access);this.delivered=true;
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
  }
  /** Sources the turn was shown outside the frame (the replies its working
   * context quotes, working-context.ts): a reply built from them rests on them. */
  noteSources(sources:ReadonlyArray<{sourceId:string;revision:number}>) {
    if(!sources.length)return true;
    return noteMemoryLookup(this.bundle.bundleId,this.lookupBundleId??=`${this.bundle.bundleId}:lookup`,[],sources);
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
  reset: () => Promise<void>, options: Parameters<typeof buildMemoryBundle>[3] = {},
) {
  assertMemoryAccess(access);
  await reset();
  assertMemoryAccess(access);
  return buildMemoryBundle(query, access, bridge, options);
}

/** The owner-facing reason a turn was refused over its pinned memory, in plain
 * words (0.1.61 final check D3: the raw code reached the room twice per bot).
 * `subject` names whose pins they are ("its", "Moss's"). Undefined for any
 * other failure, which keeps its own message. */
export function pinnedMemoryFailure(error: unknown, subject: string): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("MEMORY_PIN_OVERFLOW")) return `${subject} pinned memories are too long for this model. Unpin some in Memory, or choose a model that takes more context.`;
  if (message.startsWith("MEMORY_PIN_UNAVAILABLE")) return `${subject} pinned memory rests on something that was deleted or changed. Unpin it or fix it in Memory.`;
  return undefined;
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
