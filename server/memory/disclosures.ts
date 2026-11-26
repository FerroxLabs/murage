import { noteSessionFrame } from './session-proof-schema.ts';
import { proveRetainedSession } from './session-proof.ts';
import { sourceDenied } from "./deny.ts";
import { verdictStore } from "./verdict-store.ts";
import { database, onDatabaseClose, transaction } from "../database.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { accessIncludesRoom, assertMemoryAccess, inMemoryAccessPass, lineageReaderAudience, revalidateMemoryAccess, memoryAccessIsOwnerAudience, memoryAccessNotOwnerAudience, type MemoryAccess } from "./policy.ts";
import { assertMemoryBundle, hydrateDisclosedMemoryRecord } from "./bundle.ts";
import { authorityStamp } from "./authority-epoch.ts";
import { integrityUntrusted, isLineageLimit, LineageAllowance, contentRevoked, messageCopy, forgottenMessageSources, recordSessionRoots, replayExclusions, type Disclosure, type ReplayAudience, type ReplayMessage } from "./replay-lineage.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import { denyGeneration, denyLookup, carriedRevision, denyReadMeter, lineageLive, reimportCarry, reimportCarryKey, reimportedReceiptVerdict, sessionLookup, type ReimportCarry } from "./deny-read.ts";
import { totalChanges } from "./revoke-marker.ts";
import { STALE_MEM_LSN, type LineageReader, type LineageRef, type TurnLineage } from "./lineage-types.ts";
import { addTurnParents, checkedOpenTurns, currentLsn, extendLineage, runningTurnFor } from "./lineage-write.ts";
import { noteReceiptOutput, noteReceiptSession, wakeFlipMarker } from "./receipt-outputs.ts";
import { threadNo } from "./thread-no.ts";
import { sessionKeyOf } from "./session-incarnation.ts";
import { captureSendReplayProof, replayCopyRoots } from "./replay-lineage.ts";

/** Persist before dispatch; records contain references, never duplicated memory text. */
export function prepareMemoryDisclosure(bundle: MemoryBundle, access: MemoryAccess, driverInstance: string) {
  assertMemoryBundle(bundle,access);
  if (!driverInstance) throw new Error("INVALID_MEMORY_DRIVER");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,?,?,?,?,'prepared',?)")
    .run(bundle.bundleId,access.threadId,driverInstance,JSON.stringify(bundle.recordVersions),JSON.stringify(bundle.sourceVersions),bundle.policyRevision,bundle.deletionEpoch,bundle.tokenCount,Date.now());
}

/** session.started can precede sendTurn completion; binding does not claim delivery. */
export function bindMemoryDisclosureSession(bundleId: string, nativeSession: string) {
  if (!nativeSession) throw new Error("INVALID_MEMORY_SESSION");
  const frame=database().prepare('SELECT thread_id,driver_instance FROM memory_disclosures WHERE bundle_id=?').get(bundleId);
  if(frame)noteSessionFrame(database(),sessionKeyOf(String(frame.thread_id),String(frame.driver_instance),nativeSession),true);
  const result = database().prepare("UPDATE memory_disclosures SET native_session=? WHERE bundle_id=? AND (native_session IS NULL OR native_session=?)").run(nativeSession,bundleId,nativeSession);
  if (!result.changes) throw new Error("MEMORY_DISCLOSURE_SESSION_CONFLICT");
  // its companion receipt (lookups, quoted working context) joins the session too
  database().prepare("UPDATE memory_disclosures SET native_session=? WHERE bundle_id=? AND native_session IS NULL").run(nativeSession,`${bundleId}:lookup`);
  // the receipt range keeps the session too (receipt-outputs.ts: a receipt revoke resets it)
  { const row = database().prepare("SELECT thread_id,driver_instance FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
    if (row) try { noteReceiptSession(database(), [bundleId, `${bundleId}:lookup`], { threadId: String(row.thread_id), driverInstance: String(row.driver_instance), nativeSession }); } catch { /* below v10 */ } }
  // a receipt this build wrote on the session marks it as one lineage knows; a legacy session is told apart by lacking this row
  // (it was reset before any new receipt reached it), never by a clock
  const row = database().prepare("SELECT thread_id,driver_instance FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
  if (row) recordSessionRoots(String(row.thread_id), String(row.driver_instance), nativeSession, { roots: new Set(), over: false });
}

/** Record actual adapter acceptance while dispatch authority is still live.
 * A terminal event may arrive before sendTurn resolves: its observer must call
 * this BEFORE terminal capability revocation, then skip duplicate finalization
 * at promise resolution. Session binding alone is not acceptance.
 */
export function deliverMemoryDisclosure(bundleId: string, access: MemoryAccess, nativeSession?: string) {
  assertMemoryDisclosureCurrent(bundleId, access);
  if (nativeSession) bindMemoryDisclosureSession(bundleId,nativeSession);
  // The companion receipt (noteMemoryLookup) takes its frame's state when it
  // is made; one made before delivery (the quoted working context and project
  // layers a room turn notes at dispatch) is delivered with its frame.
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id IN (?,?) AND state='prepared'").run(bundleId,`${bundleId}:lookup`);
}

/** The receipt still holds under the dispatch's authority: what delivery
 * checks, and what every later adapter write checks again (dispatch.ts). */
export function assertMemoryDisclosureCurrent(bundleId: string, access: MemoryAccess) {
  return inMemoryAccessPass(() => {
    assertMemoryAccess(access);
    const row = database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=? AND thread_id=?").get(bundleId,access.threadId);
    // one receipt, read in full: its own allowance (a receipt that cannot be proven within it is refused, as a revoked one is)
    if (!row || revoked(LineageAllowance.tool(), row, access)) throw new Error("MEMORY_CONTEXT_REVOKED");
  });
}

function revoked(allowance: LineageAllowance, row: Disclosure, access: MemoryAccess, seen?: Seen): boolean {
  return revokedReason(allowance, row, access, seen) !== null;
}

export type Seen = { records: Set<string>; sources: Set<string>; added?: string[]; addedSources?: string[]; rootThreads?: Set<string>; threadDependenciesIncomplete?: boolean };

/** Why a receipt no longer holds, as ids and states only (no content), or
 * null when it still holds. Each branch is the same test revoked() made. */
export function revokedReason(allowance: LineageAllowance, row: Disclosure, access: MemoryAccess, seen?: Seen): string | null {
  if (row.state === "revoked") return "receipt-already-revoked";
  if (row.policy_revision !== access.policyRevision) return "policy-revision";
  if (row.deletion_epoch !== access.deletionEpoch) return "deletion-epoch";
  let step = "parse";
  try {
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    // 1.0.20 ctxrev-h1 r3: a tracked notebook's re-import moves its revision and supersedes every chunk, the unchanged ones included. The
    // same carry the retained fence uses (deny-read.ts reimportCarry) lets this receipt stand on an unchanged chunk's newest version and
    // the notebook's revision it cites; anything else reads as before. A Flux/HTTP turn runs this on every tool round (dispatch.ts). Read
    // only once a cited source's revision has moved (a carried chunk always moved its notebook), so an unchanged receipt does no more work.
    let carry: ReimportCarry | undefined;
    const reimported = (): ReimportCarry | string => {
      if (carry) return carry;
      const cited: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
      carry = reimportCarry(database(), Array.isArray(cited) ? cited : []);
      if (!carry.records.size && !carry.kept.size) return carry;
      const verdict = reimportedReceiptVerdict(database(), String(row.bundle_id), { audience: null });
      return verdict.state === "shown" ? carry : `reimport ${verdict.state}${"reason" in verdict ? `/${String(verdict.reason)}` : ""}`;
    };
    for (const source of sources) {
      step = `source ${source.id}@${source.revision}`;
      if (seen?.sources.has(step)) continue;
      allowance.spendNodes(String(row.thread_id), 1);
      const current = database().prepare("SELECT scope_id,state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current) return `${step} missing`;
      if (sourceDenied(database(), source.id)) return `${step} denied`;
      if (current.state!=="active") return `${step} state=${String(current.state)}`;
      if (current.revision!==source.revision) {
        const moved = reimported();
        if (typeof moved === "string") return moved;
        if (current.revision!==carriedRevision(moved,source.id,source.revision)) return `${step} now@${String(current.revision)}`;
      }
      if (database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return `${step} tombstoned`;
      assertMemoryAccess(access,String(current.scope_id));
      seen?.sources.add(step); seen?.addedSources?.push(step);
    }
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    // One session's receipts cite the same records again and again: each is looked at once per check.
    for (const record of records) {
      const key = `${record.id}@${record.version}`;
      if (seen?.records.has(key)) continue;
      // a carried chunk is read as its newest version (the active replacement with the same words): access, marks and tombstones of now
      step = `record ${key}`; allowance.spendNodes(String(row.thread_id), 1); hydrateDisclosedMemoryRecord(record.id,carry?.records.get(reimportCarryKey(record.id,record.version))??record.version,access,{allowance}); seen?.records.add(key); seen?.added?.push(key);
    }
    return null;
  } catch (error) {
    // the allowance running out says nothing about the receipt: it passes up, so the check ends unproven
    if (isLineageLimit(error)) throw error;
    return `${step} ${error instanceof Error ? error.message.slice(0, 60) : "error"}`;
  }
}

/** L1 bookkeeping is disposable. A hold never substitutes for the durable proof,
 * whose write-time verdict also covers deny generations outside authorityStamp. */
let SESSION_HOLDS_MAX=512;
export function setSessionHoldsMaxForTest(max:number|null):void{SESSION_HOLDS_MAX=max??512;}
export function resetSessionHolds():void{verdictStore.resetSessionHolds();}
const sessionHoldKey=(threadId:string,driverInstance:string,nativeSession:string,access:MemoryAccess)=>JSON.stringify([threadId,driverInstance,nativeSession,access.botId,access.humanPrincipal,memoryAccessNotOwnerAudience(access),access.policyRevision,access.deletionEpoch]);
let closeHooked=false;
export const COLD_CHECK_ROWS=1024;

/** A turn's memory lookups (memory_search, memory_get) as a companion receipt
 * of its dispatch: same thread, engine and session, the records and sources
 * the lookups returned, dated a millisecond before the frame's receipt so the
 * frame stays the session's latest (memoryContinuationChanged). Its outputs
 * are linked with the frame's (MemoryDispatchReceipt.output). */
export function noteMemoryLookup(frameBundleId: string, lookupBundleId: string, records: ReadonlyArray<{id:string;version:number;evidence:ReadonlyArray<{sourceId:string;revision:number}>}>, sources: ReadonlyArray<{sourceId:string;revision:number}> = []): boolean {
  return transaction(db => {
    const frame = db.prepare("SELECT * FROM memory_disclosures WHERE bundle_id=?").get(frameBundleId);
    if (!frame) throw new Error("MEMORY_DISCLOSURE_UNKNOWN");
    const existing = db.prepare("SELECT record_versions,source_versions FROM memory_disclosures WHERE bundle_id=?").get(lookupBundleId);
    const recordsBefore: Array<{id:string;version:number}> = existing ? JSON.parse(String(existing.record_versions)) : [];
    const sourcesBefore: Array<{id:string;revision:number}> = existing ? JSON.parse(String(existing.source_versions)) : [];
    const recordKeysBefore = recordsBefore.length, sourceKeysBefore = sourcesBefore.length;
    const recordKeys = new Set(recordsBefore.map(item => `${item.id}\u0000${item.version}`));
    const sourceKeys = new Set(sourcesBefore.map(item => `${item.id}\u0000${item.revision}`));
    const addSource = (handle: {sourceId:string;revision:number}) => { if (!sourceKeys.has(`${handle.sourceId}\u0000${handle.revision}`)) { sourceKeys.add(`${handle.sourceId}\u0000${handle.revision}`); sourcesBefore.push({id:handle.sourceId,revision:handle.revision}); } };
    for (const record of records) {
      if (!recordKeys.has(`${record.id}\u0000${record.version}`)) { recordKeys.add(`${record.id}\u0000${record.version}`); recordsBefore.push({id:record.id,version:record.version}); }
      for (const handle of record.evidence) addSource(handle);
    }
    for (const handle of sources) addSource(handle);
    // Bounded like a frame. Past the bound nothing more can be noted, so the
    // caller must not hand the turn what it looked up (Astra r1 #9).
    if (recordsBefore.length > 256 || sourcesBefore.length > 1024) return false;
    if (existing) {
      // A companion that gains a record is rewritten as a new row, so receipt order (rowid) is also the order records came
      // to be cited: an update in place would keep the old position and hide the citation from "cited since" checks.
      const grew = recordsBefore.length !== recordKeysBefore || sourcesBefore.length !== sourceKeysBefore;
      if (!grew) return true;
      const old = db.prepare("SELECT * FROM memory_disclosures WHERE bundle_id=?").get(lookupBundleId)!;
      // inserted first under a temporary id so it takes a rowid above every row (deleting the old one first could hand its rowid back)
      const temp = `${lookupBundleId}\u0000grown`;
      db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(temp,old.thread_id,old.driver_instance,old.native_session ?? null,JSON.stringify(recordsBefore),JSON.stringify(sourcesBefore),old.output_message_ids,old.policy_revision,old.deletion_epoch,old.token_count,old.state,old.created_at);
      db.prepare("DELETE FROM memory_disclosures WHERE bundle_id=?").run(lookupBundleId);
      db.prepare("UPDATE memory_disclosures SET bundle_id=? WHERE bundle_id=?").run(lookupBundleId,temp);
      return true;
    }
    const outputs = String(frame.output_message_ids);
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)")
      .run(lookupBundleId,frame.thread_id,frame.driver_instance,frame.native_session ?? null,JSON.stringify(recordsBefore),JSON.stringify(sourcesBefore),outputs,frame.policy_revision,frame.deletion_epoch,frame.state,Number(frame.created_at)-1);
    return true;
  });
}

/** (Receipt order is the write sequence, rowid, never created_at: a clock that went back, or a lookup companion dated a millisecond before its frame, must not decide which receipt is the session's newest.) */
/** A reply made with no receipt on a resumed session that holds receipts
 * (memory not active): it rests on everything the session was shown, so it
 * joins the session's receipts as an output (memory schema v6). */
export function linkRetainedSessionOutput(threadId: string, driverInstance: string, nativeSession: string, messageId: string) {
  const row = database().prepare("SELECT bundle_id FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT 1").get(threadId, driverInstance, nativeSession);
  if (row) linkMemoryDisclosureOutput(String(row.bundle_id), messageId);
}

/** Link every generated output, including tool-result/checkpoint message IDs where applicable.
 * A continuation's output inherits all earlier disclosures in that same native session: it is
 * listed on this receipt and on the session's newest, and every reader takes the session's
 * receipts made no later than a receipt listing a reply as listing it too (replay-lineage.ts
 * listing/listingAny, the only readers: they read the output index, never this column). Writing
 * it into every receipt of the session instead made each reply rewrite the session's whole
 * history (perf102 scale #1: quadratic in the session's turns).
 */
export function linkMemoryDisclosureOutput(bundleId: string, messageId: string) {
  if (!messageId) throw new Error("INVALID_MEMORY_OUTPUT");
  transaction(db => {
    const current = db.prepare("SELECT bundle_id,thread_id,driver_instance,native_session,output_message_ids FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
    if (!current) throw new Error("MEMORY_DISCLOSURE_UNKNOWN");
    // write-time (DESIGN-WRITETIME 2.1): the reply rests on the receipt, so its line folds the receipt's lsn (the watermark) and scopes (the
    // footprint), in the same transaction; a line with no lineage row yet keeps reading "checking"
    const ref = receiptLineageRef(db, bundleId);
    if (ref) extendLineage(db, { threadId: String(current.thread_id), messageId, author: "generated" }, { refs: [ref] });
    // the receipt range (receipt-outputs.ts): its outputs start at its earliest linked line
    const no = threadNo(db, String(current.thread_id));
    const line = no === null ? undefined : db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id=?").get(no, messageId);
    const newest = current.native_session
      ? db.prepare("SELECT bundle_id,output_message_ids FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY rowid DESC LIMIT 1").get(current.thread_id,current.driver_instance,current.native_session)
      : undefined;
    const rows = newest && newest.bundle_id !== current.bundle_id ? [current, newest] : [current];
    for (const row of rows) {
      const ids: string[] = JSON.parse(String(row.output_message_ids));
      if (!ids.includes(messageId)) db.prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id=?").run(JSON.stringify([...ids,messageId]),row.bundle_id);
      if (line) noteReceiptOutput(db, String(row.bundle_id), String(current.thread_id), Number(line.lsn), current.native_session === null ? undefined : sessionKeyOf(String(current.thread_id), String(current.driver_instance), String(current.native_session)));
    }
  });
}

/** The write-time reader for a memory capability (DESIGN-WRITETIME 1): its audience is the owner's when the capability proved it, and its
 * scopes are the ones the footprint rule compares (a non-owner reader must hold every scope a line's memory ancestry read from). */
export function lineageReaderOf(access: MemoryAccess): LineageReader {
  // (SL-E r3.2 R1: a linked person's turn reads its scopes together with S(P), memory/policy.ts lineageReaderScopes)
  return { audience: lineageReaderAudience(access) };
}
/** The write-time layer of a replay check (S4): the lines of `messages` denyLookup does not show this reader. A line that reads "checking" is
 * also added to `checking`. Until write-time lineage is written on this file (lineageLive) the read-time judge alone decides; from then on a
 * line is replayed only when BOTH show it. One page lookup: a fixed number of seeks per page, whatever the history. */
export function writetimeReplayWithheld(threadId: string, messages: readonly (ReplayMessage & {role?: string})[], reader: LineageReader, checking?: Set<string>): Set<string> {
  const out = new Set<string>();
  const db = database();
  if (!messages.length || !lineageLive(db)) return out;
  const verdicts = denyLookup(db, { threadId, lines: messages.map(message => ({ messageId: message.id, author: message.role === "user" ? "owner" as const : "generated" as const })) }, reader);
  for (const message of messages) {
    const verdict = verdicts.get(message.id);
    if (verdict?.state === "shown") continue;
    out.add(message.id);
    if (!verdict || verdict.state === "checking") checking?.add(message.id);
  }
  return out;
}

/** Conservatively omit complete generated messages and downstream paraphrases. Owner text
 * is never inferred dependent: only explicitly linked generated output IDs enter the set.
 * A copy of a generated message (Message.copyOf) is omitted with its original.
 */
export function filterMemoryReplay<T extends ReplayMessage>(allowance: LineageAllowance, threadId: string, messages: readonly T[], access: MemoryAccess, options: {persist?: boolean; failClosed?: boolean; checking?: Set<string>} = {}): T[] {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  const invalidBundles = new Set<string>();
  const excluded = replayExclusions(allowance, threadId, messages, readerAudience(allowance, access), { invalidBundles, failClosed: options.failClosed, ...(options.checking ? { checking: options.checking } : {}) });
  for (const id of writetimeReplayWithheld(threadId, messages, lineageReaderOf(access), options.checking)) excluded.add(id);
  assertMemoryAccess(access);
  // A direct chat persists what it found invalid, so a resumed session's
  // continuation and acceptance checks see lineage-only invalidation too. A
  // room does not (persist: false, room-transcript.ts): there one reader's
  // access must never revoke a receipt for every later reader, the author
  // included (0.1.61 transcript fix, R-A).
  // A reader whose words were not proven to be the owner's never persists:
  // what it may not see says nothing about the receipt for anyone else.
  if (options.persist !== false && !memoryAccessNotOwnerAudience(access)) for (const id of invalidBundles) database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(id); flipWake();
  return messages.filter(message=>!excluded.has(message.id));
}

export function readerAudience(allowance: LineageAllowance, access: MemoryAccess, seen?: Seen): ReplayAudience {
  // One check, one answer per distinct receipt content: the receipts of a
  // resumed session cite the same frame (0.1.61.1 memreplay).
  const verdicts = new Map<string, boolean>();
  return { policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch,
    // The key is the reader's stable authority (bot, scopes, principal, policy and deletion epochs, audience flags), never the turn's
    // generation: that renews every turn and defeated the cache (1.0.2 r2 P2). The live capability is checked by assertMemoryAccess
    // before and after every replay (filterMemoryReplay), so a stale generation cannot ride a kept verdict.
    // kept verdicts are shared only by a reader judged on its own: one carrying `seen` has its answers shaped by what the pass saw before
    ...(seen ? {} : { cacheKey: JSON.stringify([access.botId, access.policyRevision, access.deletionEpoch, access.view, access.scopeDigest, access.threadId, access.humanPrincipal, memoryAccessIsOwnerAudience(access), memoryAccessNotOwnerAudience(access)]) }),
    revoked: row => {
    const key = JSON.stringify([row.state, row.policy_revision, row.deletion_epoch, row.record_versions, row.source_versions]);
    let verdict = verdicts.get(key);
    if (verdict === undefined) { verdict = revoked(allowance, row, access, seen); verdicts.set(key, verdict); }
    return verdict;
  },
  // An owner-audience reader sees the replies of the owner's bots, so a copy's
  // original (a delegation result) is judged on what it cites, not on whether
  // this reader's access reaches the helper's private checkpoint.
  ...(memoryAccessIsOwnerAudience(access) ? { copyOriginRevoked: (row: Disclosure) => contentRevoked(allowance, row, String(row.thread_id)) } : {}) };
}

/** Lines a direct turn replays (index.ts): at least the newest this many. */
export const DIRECT_REPLAY_LINES = 40;

/** Bytes per token the memory extractor already assumes (extract.ts). */
const REPLAY_BYTES_PER_TOKEN = 3.5;
/** The most a replay ever carries, whatever the engine's window. */
export const REPLAY_BUDGET_CAP_BYTES = 192 * 1024;

/** How much history a turn on this engine may replay: two fifths of the
 * model's context window in bytes, never above REPLAY_BUDGET_CAP_BYTES.
 * Undefined when the window is unknown, which keeps the 40-line floor. */
export function replayBudgetBytes(contextWindow: number | undefined | null): number | undefined {
  if (!contextWindow || !(contextWindow > 0)) return undefined;
  return Math.min(Math.floor(contextWindow * REPLAY_BYTES_PER_TOKEN * 0.4), REPLAY_BUDGET_CAP_BYTES);
}

export interface ReplayWindowOptions { minLines?: number; maxBytes?: number; maxLines?: number }

/** The newest lines that fit: at least `minLines` (default 40), more while
 * they fit `maxBytes`, oldest dropped first and never a line from the middle.
 * With no byte budget this is the plain newest-40 window. */
export function replayWindow<T extends {text?: string}>(lines: readonly T[], options: ReplayWindowOptions = {}): T[] {
  const minLines = options.minLines ?? DIRECT_REPLAY_LINES;
  const candidates = lines.slice(-Math.min(options.maxLines ?? lines.length, options.maxBytes === undefined ? minLines : lines.length));
  let bytes = 0, count = 0;
  for (let index = candidates.length - 1; index >= 0; index--) {
    bytes += Buffer.byteLength(candidates[index]!.text ?? "");
    if (bytes > Math.min(options.maxBytes ?? REPLAY_BUDGET_CAP_BYTES, REPLAY_BUDGET_CAP_BYTES)) break;
    count++;
  }
  return lines.slice(lines.length - count);
}

/** The transcript lines a direct turn may replay, checked like
 * filterMemoryReplay but only over what the turn can carry: the newest
 * lines that fit the window (replayWindow) and the lines they quote. A
 * withheld line lets an older one move up, so the checked tail widens until
 * the window is full or the branch runs out, in a fixed number of rounds.
 * `replayed` is the transcript (tail lines only, newest last); `allowed`
 * also holds the checked lines they quote, for their quote text. A quoted
 * line never takes a newer line's place (review L1). `omitted` counts the
 * replayable lines the replay does not carry, the window's and the check's
 * alike, so the turn can say how many it left out.
 *
 * A check that cannot finish withholds its line instead of failing the turn
 * (0.1.61.1 memreplay: a long chat with Dax failed every turn with
 * MEMORY_REPLAY_LIMIT because the whole branch was checked).
 *
 * The workspace owner's own direct chat (an owner-audience turn on a thread
 * that is not a room) follows the room rule (roomReplayWithheld): the bot's
 * own reply is withheld only when content it used was forgotten, deleted or
 * changed, never because a roster, settings or policy change revoked receipts
 * across the install. Before 1.0.1 it read through filterMemoryReplay, whose
 * receipt state and revision checks withheld every reply of a session once
 * any one of its receipts was revoked (each reply is linked to every receipt
 * of its native session), so after a memory continuation reset the fresh
 * session was replayed the owner's lines and none of its own. Given
 * `withheldLine`, a withheld line stays in its place as that text, so the
 * turn never silently misses its own words; without it the line is left out.
 * Every other direct turn (words nobody proved are the owner's, a person's
 * chat) keeps filterMemoryReplay. */
export function filterDirectReplay<T extends ReplayMessage & {kind?: string; text?: string; replyToId?: string}>(allowance: LineageAllowance, threadId: string, messages: readonly T[], access: MemoryAccess, skip: ReadonlySet<string>, options: ReplayWindowOptions & { withheldLine?: (message: T, forgotten: boolean, checking?: boolean) => string } = {}): {allowed: T[]; replayed: T[]; omitted: number; withheld: Set<string>; checking: Set<string>} {
  const minLines = options.minLines ?? DIRECT_REPLAY_LINES;
  const replayable = (message: T) => message.kind === "text" && Boolean(message.text) && !skip.has(message.id);
  const lines = messages.filter(replayable);
  let allowed: T[] = [], replayed: T[] = [];
  const ownerChat = ownerDirectChat(threadId, access);
  const withheld = new Set<string>(), forgotten = new Set<string>(), checking = new Set<string>();
  // The lines among `fresh` this reader may be shown (as a withheld line, for
  // the owner's own chat when the caller gives one).
  const judge = (fresh: T[]): T[] => {
    const attempts = captureSendReplayProof(threadId, fresh.map(m => m.id), replayCopyRoots(fresh));
    fresh = fresh.filter(m => !attempts.excludedIds.has(m.id));
    if (!ownerChat) return filterMemoryReplay(allowance, threadId, fresh, access, { failClosed: true });
    const pendingIds = new Set<string>();
    const held = roomReplayWithheld(allowance, threadId, fresh, pendingIds);
    const heldIds = fresh.filter(message => held.has(message.id)).map(message => message.id), gone = forgottenMessageSources(threadId, heldIds);
    for (const id of heldIds) {
      withheld.add(id);
      if (gone.has(id)) forgotten.add(id);
      else if (pendingIds.has(id)) checking.add(id);
    }
    return options.withheldLine ? fresh : fresh.filter(message => !held.has(message.id));
  };
  // A line's verdict does not depend on the lines asked with it, so a line a
  // round judged is not asked about again when the window widens: a thread
  // whose every reply is withheld widens to the whole thread, and would
  // otherwise pay for its receipts once per round per line already judged.
  const kept = new Set<string>(), judged = new Set<string>();
  for (let round = 0, limit = Math.max(1, replayWindow(lines, options).length); round < 4; round++, limit *= 2) {
    const tail = lines.slice(-limit);
    const tailIds = new Set(tail.map(message => message.id)), ids = new Set(tailIds);
    for (const message of tail) if (message.replyToId) ids.add(message.replyToId);
    const asked = messages.filter(message => ids.has(message.id));
    const fresh = asked.filter(message => !judged.has(message.id));
    if (fresh.length) for (const message of judge(fresh)) kept.add(message.id);
    for (const message of fresh) judged.add(message.id);
    allowed = asked.filter(message => kept.has(message.id));
    replayed = allowed.filter(message => tailIds.has(message.id));
    if (replayed.length >= minLines || limit >= lines.length) break;
    // The allowance ran out: what could not be proven is withheld, and a wider window would only ask about more lines it cannot prove
    // (the warmer finishes the thread; a later turn fills the window).
    if (allowance.hit) break;
  }
  const line = options.withheldLine;
  if (line && withheld.size) {
    // nothing of a withheld line is left to quote or follow
    const shown = (message: T): T => withheld.has(message.id) ? { ...message, text: line(message, forgotten.has(message.id), checking.has(message.id)), replyToId: undefined } : message;
    allowed = allowed.map(shown);
    replayed = replayed.map(shown);
  }
  replayed = replayWindow(replayed, options);
  return { allowed, replayed, omitted: lines.length - replayed.length, withheld, checking };
}

/** The workspace owner's own direct chat with a bot: an owner-audience turn
 * whose thread is not a room and belongs to the owner. */
export function ownerDirectChat(threadId: string, access: MemoryAccess): boolean {
  return threadId === access.threadId && memoryAccessIsOwnerAudience(access) && !accessIncludesRoom(access)
    && isWorkspaceOwner(threadHumanPrincipal(threadId));
}

/** The ids of a room's generated replies that bots may no longer be shown,
 * for an owner-audience room turn. A room message is a room record: every
 * member reads it, and it is not removed because of what the reader could
 * recall, or because a roster, settings or policy change revoked receipts
 * across the install. Privacy there was enforced when the reply was made:
 * room recall carries a bot's private scopes only for an owner audience, so a
 * reply can only have told the room what the owner could already see.
 *
 * What still withholds a reply is its content: a record or source it used
 * (directly, through derivation lineage, or through an earlier reply it
 * quoted from memory) was forgotten, deleted or changed. The caller shows a
 * visible "Reply withheld" line in its place, never a silent gap.
 *
 * Every other room turn (a channel person's pair room, a chain a channel
 * person started, words nobody proved are the owner's) keeps
 * filterMemoryReplay. */
export function roomReplayWithheld(allowance: LineageAllowance, threadId: string, messages: readonly (ReplayMessage & {role?: string})[], checking?: Set<string>): Set<string> {
  if (!isWorkspaceOwner(threadHumanPrincipal(threadId))) throw new Error("MEMORY_SCOPE_DENIED");
  // A check that cannot finish withholds the reply; it never fails the turn.
  const withheld = replayExclusions(allowance, threadId, messages, null, { failClosed: true, ...(checking ? { checking } : {}) });
  // A line the owner forgot from memory is withheld itself, receipt or not. The
  // owner's own forgotten words are excluded by replayExclusions (1.0.2 revoke-bounded r3).
  for (const id of forgottenMessageSources(threadId, messages.filter(m => m.role !== "user" && !withheld.has(m.id)).map(m => m.id))) { withheld.add(id); checking?.delete(id); }
  // the write-time layer: a room message is a room record, judged on content (no audience: marks and direct facts, no watermark or footprint)
  for (const id of writetimeReplayWithheld(threadId, messages, { audience: null }, checking)) withheld.add(id);
  return withheld;
}

/** Originals of a copy the cross-thread judge reads for one line (XTHREAD-JUDGE R2(c)); a copy of more is withheld. */
const XTHREAD_COPY_ORIGINALS = 16;
/** The most rows one page lookup reads (deny-read.ts lookupPage: fixed seeks, the pending and deny_range reads of at most 257 rows each, a
 * footprint set of at most 33), reserved from the allowance before each page (R4). */
const XTHREAD_PAGE_ROWS = 600;

/** What a verdict of the reader rule rests on (XTHREAD-JUDGE R1): the authority stamp, the deny generation and this connection's write
 * count. Undefined (nothing is kept) inside a transaction or when the generation cannot be read. */
function readerRuleStamp(): string | undefined {
  const authority = authorityStamp();
  if (authority === undefined) return undefined;
  const db = database();
  const generation = denyGeneration(db);
  if (generation < 0) return undefined;
  return `${authority}\u0000${generation}\u0000${totalChanges(db)}`;
}

/** The reader's own rule for the lines a recalled record rests on, for every reader whose audience is not the owner (a channel person, a
 * group guest, a hand-off, a person's own chat, a room turn or any turn whose words were not proven). A line of the reader's own thread is
 * judged as its transcript is (filterMemoryReplay); a line of any other thread is judged with the reader's audience by the write-time
 * lookup, as the reader's own transcript would be (XTHREAD-JUDGE R2): marks including audience-only ones, pending windows, the watermark
 * and the footprint. What that rule leaves out is not handed back by recall or memory search either (0.1.61 lane T2). Undefined for an
 * owner audience, whose rule is the content rule alone (replay-lineage.ts). */
export function readerWithheldMessage(access: MemoryAccess): ((threadId: string, messageId: string, allowance: LineageAllowance, verdict?: { checking?: boolean }) => boolean) | undefined {
  if (memoryAccessIsOwnerAudience(access)) return undefined;
  // A verdict holds only while nothing changed: a receipt revoked or a mark committed while recall waits, or a line rewritten on this
  // connection, is seen by the next check and at dispatch.
  const verdicts = new Map<string, boolean>();
  let stamp: string | undefined;
  let reader: LineageReader | undefined;
  return (threadId, messageId, allowance, verdict) => {
    const now = readerRuleStamp();
    if (now === undefined || now !== stamp) { access = revalidateMemoryAccess(access); verdicts.clear(); stamp = now; reader = undefined; }
    const key = `${threadId}\u0000${messageId}`;
    if (threadId === access.threadId) {
      let known = verdicts.get(key);
      if (known === undefined) {
        const copy = messageCopy(threadId, messageId);
        const checking = new Set<string>();
        known = filterMemoryReplay(allowance, threadId, [{ id: messageId, ...(copy ? { copyOf: copy } : {}) }], access, { persist: false, failClosed: true, checking }).length === 0;
        // a reply left out only because the allowance ran out is not remembered as withheld: the next check, with room, may prove it
        if (checking.has(messageId)) { if (verdict) verdict.checking = true; }
        else if (now !== undefined) verdicts.set(key, known);
      }
      return known;
    }
    // Another thread. Every lookup is paid for before it is made and charged with what it read; a check the allowance cannot cover
    // withholds the line for now and keeps nothing.
    const db = database();
    try {
      allowance.reserveRows("", 2);
      const untrusted = integrityUntrusted(db);
      allowance.spendRows("", 2);
      if (untrusted) { if (verdict) verdict.checking = true; return true; }
      if (verdicts.get(key) === false) return false;
      allowance.reserveRows("", 1);
      const live = lineageLive(db);
      allowance.spendRows("", 1);
      // no line row on this file yet: no write-time marks, and the read-time judge is bound to the reader's own thread (fail closed)
      if (!live) { if (verdict) verdict.checking = true; return true; }
      allowance.reserveRows("", 1);
      const copy = messageCopy(threadId, messageId);
      allowance.spendRows("", 1);
      if (copy && copy.messageIds.length > XTHREAD_COPY_ORIGINALS) return true;
      reader ??= lineageReaderOf(access);
      const pages: Array<[string, string]> = [[threadId, messageId], ...(copy ? copy.messageIds.map(id => [copy.threadId, id] as [string, string]) : [])];
      for (const [thread, id] of pages) {
        allowance.reserveRows("", XTHREAD_PAGE_ROWS);
        const before = denyReadMeter().rows;
        const checking = new Set<string>();
        const held = writetimeReplayWithheld(thread, [{ id, role: "bot" }], reader, checking);
        if (checking.size && verdict) verdict.checking = true;
        allowance.spendRows("", Math.max(1, denyReadMeter().rows - before + 1));
        if (held.size) return true;
      }
      if (now !== undefined) verdicts.set(key, false);
      return false;
    } catch (error) {
      if (isLineageLimit(error)) { if (verdict) verdict.checking = true; return true; }
      throw error;
    }
  };
}

// ---- the entry points of the lineage reads, each timed (see LineageAllowance.timed) ----
/** continuationMemoryRevoked, timed against the allowance's wall-clock budget (1.0.2 lineage-cold r3: nodes bound the count, this bounds the time), with one second look when the clock stopped it. */
/** T3 (DESIGN-T3.md, MAIN approved): the non-destructive probe before the one real continuation check. It reads only the retained
 * session's write-time verdict: no hold is lost or granted, no receipt is marked. True only for exactly checking:pending. */
export function continuationPendingProbe(threadId: string, driverInstance: string, nativeSession: string, access: MemoryAccess): boolean {
  try {
    assertMemoryAccess(access);
    const reader: LineageReader = ownerDirectChat(threadId, access) ? { audience: null } : { audience: lineageReaderAudience(access) };
    const verdict = sessionLookup(database(), sessionKeyOf(threadId, driverInstance, nativeSession), reader);
    return verdict.state === "checking" && verdict.reason === "pending";
  } catch { return false; }
}
/** keepPending (T3: an owner-audience direct turn only): a proof that is exactly checking:pending (a revoke walk not finished, never a
 * settled deny, never lineage-warming or another checking cause) keeps the session. It neither consumes nor grants the hold, sets
 * why.kept, and returns false; the caller sends without new remembered context and the next turn checks again. */
export function continuationMemoryRevoked(allowance: LineageAllowance, threadId: string, driverInstance: string, nativeSession: string, access: MemoryAccess, why: { reason?: string; kept?: boolean } = {}, keepPending = false): boolean { assertMemoryAccess(access); const proof=proveRetainedSession(allowance,sessionKeyOf(threadId,driverInstance,nativeSession),{access,disclosed:true}); const key=sessionHoldKey(threadId,driverInstance,nativeSession,access);if(proof.kind==='fresh'&&keepPending&&proof.cause==='checking'&&proof.reason==='checking'&&proof.detail==='pending'){why.reason='checking:pending';why.kept=true;return false;}if(proof.kind==='fresh'){verdictStore.loseHold(key,'consumed');why.reason=proof.cause==='checking'?(proof.reason==='checking'&&proof.detail?`checking:${proof.detail}`:'lineage-warming'):proof.reason;return true;}if(!closeHooked){closeHooked=true;onDatabaseClose(resetSessionHolds);}if(verdictStore.getHold(key))verdictStore.touchHold(key);else verdictStore.setHold(key,{stamp:authorityStamp()},SESSION_HOLDS_MAX);return false; }

/** A receipt as a write-time ref (DESIGN-WRITETIME 2.2, "receipts"): its lsn for the watermark, and the scopes of the records and sources it
 * holds for the footprint. A receipt already stale against the current policy revision or deletion epoch takes STALE_MEM_LSN, below every
 * watermark (lineage-backfill.ts, as U1 folds a stale receipt); a
 * current one takes the lsn now (a later bump moves past it). Bounded by the receipt's own size (at most 256 records and 1,024 sources).
 * Null when the receipt is gone. */
export function receiptLineageRef(db: ReturnType<typeof database>, bundleId: string): LineageRef | null {
  const row = db.prepare("SELECT d.record_versions AS rv,d.source_versions AS sv,d.policy_revision AS p,d.deletion_epoch AS e,m.policy_revision AS mp,m.deletion_epoch AS me FROM memory_disclosures d, memory_meta m WHERE m.id=1 AND d.bundle_id=?").get(bundleId);
  if (!row) return null;
  const scopes = new Set<string>();
  const cited = (JSON.parse(String(row.rv)) as Array<{ id: string; version: number }>).map(ref => [ref.id, ref.version] as const);
  for (const scope of citedScopes(db, cited)) scopes.add(scope.id);
  for (const scope of db.prepare("SELECT DISTINCT s.scope_id AS s FROM json_each(?) j JOIN memory_sources s ON s.id=j.value->>'id'").all(String(row.sv))) scopes.add(String(scope.s));
  const stale = Number(row.p) !== Number(row.mp) || Number(row.e) !== Number(row.me);
  return { kind: "receipt", bundleId, lsn: stale ? STALE_MEM_LSN : currentLsn(db), scopeIds: [...scopes].sort() };
}

/** The notebooks that exact record versions rest in: (id, kind, owner_key) for tuple refs [[record id, version], ...]. Driven from the cited
 * tuples (one primary-key seek on the record, one on its scope), so the work follows the citations, never the history of the file. A ref
 * naming no record contributes nothing; the scope of an orphaned record is returned only if the scope row exists. */
export function citedScopes(db: ReturnType<typeof database>, refs: ReadonlyArray<readonly [string, number]>): Array<{ id: string; kind: string; owner_key: string }> {
  if (!refs.length) return [];
  return db.prepare("SELECT DISTINCT s.id,s.kind,s.owner_key FROM json_each(?) p CROSS JOIN memory_records r ON r.id=p.value->>0 AND r.version=p.value->>1 CROSS JOIN memory_scopes s ON s.id=r.scope_id")
    .all(JSON.stringify(refs)).map(row => ({ id: String(row.id), kind: String(row.kind), owner_key: String(row.owner_key) }));
}

/** A receipt the running turn of (thread, bot) was handed (a frame, a lookup): it joins that turn's parents, so every note, record or session
 * the turn writes carries it. Outside a turn nothing is recorded. */
export function receiptJoinsTurn(threadId: string, botId: string, bundleId: string, exactTurn?: TurnLineage): void {
  // Legacy admission callers explicitly address all live turns of this member;
  // response preparation additionally checks them against its immutable binding
  // in captureTurnParentAdditions. No newest-thread fallback is permitted.
  const turn = exactTurn ?? runningTurnFor(threadId, botId);
  if (!turn) return;
  if (turn.threadId !== threadId) throw new Error("MEMORY_CONTEXT_REVOKED");
  checkedOpenTurns(turn);
  const ref = receiptLineageRef(database(), bundleId);
  if (!ref) throw new Error("MEMORY_CONTEXT_REVOKED");
  addTurnParents(turn, [ref]);
}

/** A receipt turned 'revoked' here is queued by the v10 flip trigger (receipt-outputs.ts): wake the marker so it is committed soon (until
 * then its lines read "checking"). */
function flipWake(): void { try { wakeFlipMarker(); } catch { /* the next runner tick commits it */ } }
