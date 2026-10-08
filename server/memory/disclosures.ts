import { database, transaction } from "../database.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { accessIncludesRoom, assertMemoryAccess, memoryAccessIsOwnerAudience, memoryAccessNotOwnerAudience, type MemoryAccess } from "./policy.ts";
import { assertMemoryBundle, hydrateDisclosedMemoryRecord } from "./bundle.ts";
import { contentRevoked, databaseStamp, messageCopy, messageSourceForgotten, outputRootsBad, preLineageSessionRevoked, replayExclusions, sessionLineageBad, sessionOutputRoots, type Disclosure, type ReplayAudience, type ReplayMessage } from "./replay-lineage.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";

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
  const result = database().prepare("UPDATE memory_disclosures SET native_session=? WHERE bundle_id=? AND (native_session IS NULL OR native_session=?)").run(nativeSession,bundleId,nativeSession);
  if (!result.changes) throw new Error("MEMORY_DISCLOSURE_SESSION_CONFLICT");
  // its companion receipt (lookups, quoted working context) joins the session too
  database().prepare("UPDATE memory_disclosures SET native_session=? WHERE bundle_id=? AND native_session IS NULL").run(nativeSession,`${bundleId}:lookup`);
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
  assertMemoryAccess(access);
  const row = database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=? AND thread_id=?").get(bundleId,access.threadId);
  if (!row || revoked(row,access)) throw new Error("MEMORY_CONTEXT_REVOKED");
}

function revoked(row: Disclosure, access: MemoryAccess): boolean {
  return revokedReason(row, access) !== null;
}

/** Why a receipt no longer holds, as ids and states only (no content), or
 * null when it still holds. Each branch is the same test revoked() made. */
function revokedReason(row: Disclosure, access: MemoryAccess): string | null {
  if (row.state === "revoked") return "receipt-already-revoked";
  if (row.policy_revision !== access.policyRevision) return "policy-revision";
  if (row.deletion_epoch !== access.deletionEpoch) return "deletion-epoch";
  let step = "parse";
  try {
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) { step = `record ${record.id}@${record.version}`; hydrateDisclosedMemoryRecord(record.id,record.version,access); }
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      step = `source ${source.id}@${source.revision}`;
      const current = database().prepare("SELECT scope_id,state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current) return `${step} missing`;
      if (current.state!=="active") return `${step} state=${String(current.state)}`;
      if (current.revision!==source.revision) return `${step} now@${String(current.revision)}`;
      if (database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return `${step} tombstoned`;
      assertMemoryAccess(access,String(current.scope_id));
    }
    return null;
  } catch (error) { return `${step} ${error instanceof Error ? error.message.slice(0, 60) : "error"}`; }
}

/** Unknown historical sessions also require a fresh replay: legacy disclosure is unproven. */
export function continuationMemoryRevoked(threadId: string, driverInstance: string, nativeSession: string, access: MemoryAccess, why?: { reason?: string }): boolean {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  const rows = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").all(threadId,driverInstance,nativeSession);
  if (!rows.length) { if (why) why.reason = "no-receipts"; return true; }
  let invalid = false;
  const persist = !memoryAccessNotOwnerAudience(access);
  for (const row of rows) {
    const reason = revokedReason(row,access);
    if (reason === null) continue;
    if (why && !why.reason) why.reason = `memory-changed (${reason})`;
    if (persist) database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(row.bundle_id);
    invalid = true;
  }
  if (invalid) { if (why && !why.reason) why.reason = "memory-changed"; return true; }
  // Lineage too: a receipt whose cited reply is withheld no longer holds. The
  // replay window reaches only the newest lines, so an old session's receipts
  // are judged here, every one of them; a check that cannot finish resets the
  // session (0.1.61.1 memreplay review M1).
  const bad = new Set<string>();
  invalid = sessionLineageBad(threadId, driverInstance, nativeSession, readerAudience(access), bad);
  if (persist) for (const id of bad) database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(id);
  if (invalid && why) why.reason = "lineage";
  if (invalid) return true;
  // The replies built on memory that the session's context carried (v6), and
  // a session shown memory before that lineage began, after a later revoke.
  const held = sessionOutputRoots(threadId, driverInstance, nativeSession);
  if (held.over) { if (why) why.reason = "root-ceiling"; return true; }
  if (outputRootsBad(held)) { if (why) why.reason = "session-roots"; return true; }
  if (preLineageSessionRevoked(rows, threadId, driverInstance, nativeSession)) { if (why) why.reason = "pre-lineage"; return true; }
  return false;
}

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
      db.prepare("UPDATE memory_disclosures SET record_versions=?,source_versions=? WHERE bundle_id=?").run(JSON.stringify(recordsBefore),JSON.stringify(sourcesBefore),lookupBundleId);
      return true;
    }
    const outputs = String(frame.output_message_ids);
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)")
      .run(lookupBundleId,frame.thread_id,frame.driver_instance,frame.native_session ?? null,JSON.stringify(recordsBefore),JSON.stringify(sourcesBefore),outputs,frame.policy_revision,frame.deletion_epoch,frame.state,Number(frame.created_at)-1);
    return true;
  });
}

/** A reply made with no receipt on a resumed session that holds receipts
 * (memory not active): it rests on everything the session was shown, so it
 * joins the session's receipts as an output (memory schema v6). */
export function linkRetainedSessionOutput(threadId: string, driverInstance: string, nativeSession: string, messageId: string) {
  const row = database().prepare("SELECT bundle_id FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId, driverInstance, nativeSession);
  if (row) linkMemoryDisclosureOutput(String(row.bundle_id), messageId);
}

/** Link every generated output, including tool-result/checkpoint message IDs where applicable.
 * A continuation's output inherits all earlier disclosures in that same native session.
 */
export function linkMemoryDisclosureOutput(bundleId: string, messageId: string) {
  if (!messageId) throw new Error("INVALID_MEMORY_OUTPUT");
  transaction(db => {
    const current = db.prepare("SELECT * FROM memory_disclosures WHERE bundle_id=?").get(bundleId);
    if (!current) throw new Error("MEMORY_DISCLOSURE_UNKNOWN");
    const rows = current.native_session
      ? db.prepare("SELECT bundle_id,output_message_ids FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").all(current.thread_id,current.driver_instance,current.native_session)
      : [current];
    for (const row of rows) {
      const ids: string[] = JSON.parse(String(row.output_message_ids));
      if (!ids.includes(messageId)) db.prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id=?").run(JSON.stringify([...ids,messageId]),row.bundle_id);
    }
  });
}

/** Conservatively omit complete generated messages and downstream paraphrases. Owner text
 * is never inferred dependent: only explicitly linked generated output IDs enter the set.
 * A copy of a generated message (Message.copyOf) is omitted with its original.
 */
export function filterMemoryReplay<T extends ReplayMessage>(threadId: string, messages: readonly T[], access: MemoryAccess, options: {persist?: boolean; failClosed?: boolean} = {}): T[] {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  const invalidBundles = new Set<string>();
  const excluded = replayExclusions(threadId, messages, readerAudience(access), { invalidBundles, failClosed: options.failClosed });
  assertMemoryAccess(access);
  // A direct chat persists what it found invalid, so a resumed session's
  // continuation and acceptance checks see lineage-only invalidation too. A
  // room does not (persist: false, room-transcript.ts): there one reader's
  // access must never revoke a receipt for every later reader, the author
  // included (0.1.61 transcript fix, R-A).
  // A reader whose words were not proven to be the owner's never persists:
  // what it may not see says nothing about the receipt for anyone else.
  if (options.persist !== false && !memoryAccessNotOwnerAudience(access)) for (const id of invalidBundles) database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(id);
  return messages.filter(message=>!excluded.has(message.id));
}

function readerAudience(access: MemoryAccess): ReplayAudience {
  // One check, one answer per distinct receipt content: the receipts of a
  // resumed session cite the same frame (0.1.61.1 memreplay).
  const verdicts = new Map<string, boolean>();
  return { policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, revoked: row => {
    const key = JSON.stringify([row.state, row.policy_revision, row.deletion_epoch, row.record_versions, row.source_versions]);
    let verdict = verdicts.get(key);
    if (verdict === undefined) { verdict = revoked(row, access); verdicts.set(key, verdict); }
    return verdict;
  },
  // An owner-audience reader sees the replies of the owner's bots, so a copy's
  // original (a delegation result) is judged on what it cites, not on whether
  // this reader's access reaches the helper's private checkpoint.
  ...(memoryAccessIsOwnerAudience(access) ? { copyOriginRevoked: (row: Disclosure) => contentRevoked(row, String(row.thread_id)) } : {}) };
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

export interface ReplayWindowOptions { minLines?: number; maxBytes?: number }

/** The newest lines that fit: at least `minLines` (default 40), more while
 * they fit `maxBytes`, oldest dropped first and never a line from the middle.
 * With no byte budget this is the plain newest-40 window. */
export function replayWindow<T extends {text?: string}>(lines: readonly T[], options: ReplayWindowOptions = {}): T[] {
  const minLines = options.minLines ?? DIRECT_REPLAY_LINES;
  const candidates = options.maxBytes === undefined ? lines.slice(-minLines) : lines;
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
 * MEMORY_REPLAY_LIMIT because the whole branch was checked). */
export function filterDirectReplay<T extends ReplayMessage & {kind?: string; text?: string; replyToId?: string}>(threadId: string, messages: readonly T[], access: MemoryAccess, skip: ReadonlySet<string>, options: ReplayWindowOptions = {}): {allowed: T[]; replayed: T[]; omitted: number} {
  const minLines = options.minLines ?? DIRECT_REPLAY_LINES;
  const replayable = (message: T) => message.kind === "text" && Boolean(message.text) && !skip.has(message.id);
  const lines = messages.filter(replayable);
  let allowed: T[] = [], replayed: T[] = [];
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
    if (fresh.length) for (const message of filterMemoryReplay(threadId, fresh, access, { failClosed: true })) kept.add(message.id);
    for (const message of fresh) judged.add(message.id);
    allowed = asked.filter(message => kept.has(message.id));
    replayed = allowed.filter(message => tailIds.has(message.id));
    if (replayed.length >= minLines || limit >= lines.length) break;
  }
  replayed = replayWindow(replayed, options);
  return { allowed, replayed, omitted: lines.length - replayed.length };
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
export function roomReplayWithheld(threadId: string, messages: readonly (ReplayMessage & {role?: string})[]): Set<string> {
  if (!isWorkspaceOwner(threadHumanPrincipal(threadId))) throw new Error("MEMORY_SCOPE_DENIED");
  // A check that cannot finish withholds the reply; it never fails the turn.
  const withheld = replayExclusions(threadId, messages, null, { failClosed: true });
  // A generated reply the owner forgot from memory is withheld itself, receipt
  // or not. The owner's own words never are.
  for (const message of messages) {
    if (message.role === "user" || withheld.has(message.id)) continue;
    if (messageSourceForgotten(threadId, message.id)) withheld.add(message.id);
  }
  return withheld;
}

/** A room turn whose audience is not the owner (a channel person's room,
 * words nobody proved are the owner's) reads the room through
 * filterMemoryReplay. What that filter removes from the transcript is not
 * handed back by recall or memory search either (0.1.61). Undefined
 * for every other turn, whose rule is the content rule alone
 * (replay-lineage.ts). */
export function readerWithheldMessage(access: MemoryAccess): ((threadId: string, messageId: string) => boolean) | undefined {
  // a room turn that is not the owner's, or any turn whose words were not
  // proven (a direct one included)
  if (memoryAccessIsOwnerAudience(access) || (!accessIncludesRoom(access) && !memoryAccessNotOwnerAudience(access))) return undefined;
  // A verdict holds only while nothing changed: a receipt revoked while
  // recall waits is seen by the check after the wait and at dispatch.
  const verdicts = new Map<string, boolean>();
  let stamp: string | undefined;
  return (threadId, messageId) => {
    if (threadId !== access.threadId) return false;
    const now = databaseStamp();
    if (now === undefined || now !== stamp) { verdicts.clear(); stamp = now; }
    let known = verdicts.get(messageId);
    if (known === undefined) {
      const copy = messageCopy(threadId, messageId);
      known = filterMemoryReplay(threadId, [{ id: messageId, ...(copy ? { copyOf: copy } : {}) }], access, { persist: false, failClosed: true }).length === 0;
      verdicts.set(messageId, known);
    }
    return known;
  };
}
