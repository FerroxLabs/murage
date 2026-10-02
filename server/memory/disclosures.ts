import { database, transaction } from "../database.ts";
import type { MemoryBundle } from "../../shared/memory.ts";
import { accessIncludesRoom, assertMemoryAccess, memoryAccessIsOwnerAudience, memoryAccessNotOwnerAudience, type MemoryAccess } from "./policy.ts";
import { assertMemoryBundle, hydrateDisclosedMemoryRecord } from "./bundle.ts";
import { databaseStamp, messageCopy, messageMadeWithMemory, messageSourceForgotten, replayExclusions, type Disclosure, type ReplayAudience, type ReplayMessage } from "./replay-lineage.ts";
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
}

/** Record actual adapter acceptance while dispatch authority is still live.
 * A terminal event may arrive before sendTurn resolves: its observer must call
 * this BEFORE terminal capability revocation, then skip duplicate finalization
 * at promise resolution. Session binding alone is not acceptance.
 */
export function deliverMemoryDisclosure(bundleId: string, access: MemoryAccess, nativeSession?: string) {
  assertMemoryAccess(access);
  const row = database().prepare("SELECT * FROM memory_disclosures WHERE bundle_id=? AND thread_id=?").get(bundleId,access.threadId);
  if (!row || revoked(row,access)) throw new Error("MEMORY_CONTEXT_REVOKED");
  if (nativeSession) bindMemoryDisclosureSession(bundleId,nativeSession);
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE bundle_id=? AND state='prepared'").run(bundleId);
}

function revoked(row: Disclosure, access: MemoryAccess): boolean {
  if (row.state === "revoked" || row.policy_revision !== access.policyRevision || row.deletion_epoch !== access.deletionEpoch) return true;
  try {
    const records: Array<{id:string;version:number}> = JSON.parse(String(row.record_versions));
    for (const record of records) hydrateDisclosedMemoryRecord(record.id,record.version,access);
    const sources: Array<{id:string;revision:number}> = JSON.parse(String(row.source_versions));
    for (const source of sources) {
      const current = database().prepare("SELECT scope_id,state,revision FROM memory_sources WHERE id=?").get(source.id);
      if (!current || current.state!=="active" || current.revision!==source.revision || database().prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(source.id,source.revision)) return true;
      assertMemoryAccess(access,String(current.scope_id));
    }
    return false;
  } catch { return true; }
}

/** Unknown historical sessions also require a fresh replay: legacy disclosure is unproven. */
export function continuationMemoryRevoked(threadId: string, driverInstance: string, nativeSession: string, access: MemoryAccess): boolean {
  assertMemoryAccess(access);
  if (threadId !== access.threadId) throw new Error("MEMORY_SCOPE_DENIED");
  const rows = database().prepare("SELECT * FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").all(threadId,driverInstance,nativeSession);
  if (!rows.length) return true;
  let invalid = false;
  const persist = !memoryAccessNotOwnerAudience(access);
  for (const row of rows) if (revoked(row,access)) {
    if (persist) database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(row.bundle_id);
    invalid = true;
  }
  return invalid;
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
  return { policyRevision: access.policyRevision, deletionEpoch: access.deletionEpoch, revoked: row => revoked(row, access) };
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
 * handed back by recall or memory search either (0.1.61 room privacy fix). Undefined
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

/** The replay check gave up on a long thread (too many receipts, nodes, depth
 * or parents). Only that error: any other fault still fails the turn. */
export function memoryReplayLimited(error: unknown): boolean {
  return error instanceof Error && error.message.split(":")[0] === "MEMORY_REPLAY_LIMIT";
}
const degradedThreads = new Set<string>();
/** Said once per conversation, so a long thread does not flood the log. */
export function noteReplayLimitDegraded(threadId: string) {
  if (degradedThreads.has(threadId) || degradedThreads.size > 256) return;
  degradedThreads.add(threadId);
  console.warn("[memory] replay check over limit, turn ran without recalled memory");
}
/** The transcript for a turn that runs WITHOUT memory because the replay check
 * could not finish. Nothing it cannot verify crosses: a person's own words
 * stay; a reply made under a memory receipt, a copy of one, or anything this
 * cannot look up is left out. Only the newest lines are looked at. */
export function replayWithoutMemory<T extends ReplayMessage>(threadId: string, messages: readonly T[]): T[] {
  return messages.slice(-200).filter(message => {
    if (message.role === "user") return true;
    try { return !message.copyOf && !messageMadeWithMemory(threadId, message.id); } catch { return false; }
  });
}

/** How many of a conversation's newest text lines a turn's replay check covers.
 * A turn replays only the newest 40 (index.ts), and a withheld line is replaced
 * by an older one, so three times that leaves room for most of them to be
 * withheld and the transcript to still fill. Older lines are never replayed,
 * so nothing outside this window reaches a bot or is recalled from it. */
export const REPLAY_WINDOW_TEXT_LINES = 120;
/** Hard cap on messages in the window, however many non-text lines (tool
 * activity, cards) sit between the text lines. */
export const REPLAY_WINDOW_MESSAGES = 1000;
/** The newest messages a turn can replay: back to the REPLAY_WINDOW_TEXT_LINES-th
 * text line from the end, never more than REPLAY_WINDOW_MESSAGES. */
export function recentReplayWindow<T extends ReplayMessage & { kind?: string; text?: unknown }>(messages: readonly T[]): T[] {
  let lines = 0, start = messages.length;
  while (start > 0 && messages.length - start < REPLAY_WINDOW_MESSAGES) {
    start--;
    const message = messages[start];
    if (message.kind === "text" && message.text && ++lines >= REPLAY_WINDOW_TEXT_LINES) break;
  }
  return messages.slice(start);
}
/** filterMemoryReplay for a direct chat's turn: only the recent window is
 * checked, and a line whose check runs past its budget is withheld instead of
 * failing the turn. A conversation of any length replays (and recalls) its
 * recent lines in full; what it cannot verify it does not show. */
export function filterMemoryReplayRecent<T extends ReplayMessage & { kind?: string; text?: unknown }>(threadId: string, messages: readonly T[], access: MemoryAccess, options: { persist?: boolean } = {}): T[] {
  return filterMemoryReplay(threadId, recentReplayWindow(messages), access, { ...options, failClosed: true });
}
