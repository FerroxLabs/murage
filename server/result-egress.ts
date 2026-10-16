// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one way a stored result leaves the bot that produced it. Every path that copies, mirrors, records or returns a result's text somewhere
// else (the shared answer an asker reads, the copy written into the asker's conversation, the receipt, a hand-off replayed in an event run,
// check/wait_delegation, a delegation's copy into its source thread, a card's result in the project room) asks `releaseStoredResult`, and only
// the ReleasedText it hands back leaves: no other module can make one (server/released-text.ts), and the sinks that write to a bot accept nothing
// else for worker words (server/bot-egress.ts, server/murage-status.ts). The order is fixed:
//   1. delivery authorization for the request the result was written for (sharing revoked since: the reason, no text). A result with no
//      request, or whose request is not this asker's own hand-off, is read only when both sides are positively the owner's own unshared
//      conversations and the reader is the owner, or the reader is not the owner and the reply comes from the peer turn its own ask started
//      with that same not-owner audience; anything unresolved fails closed.
//   2. every message the result stands on is read now, and so is every message those were copied from, all the way back (a breadth-first walk
//      of the copy links, at most 8 deep and 64 messages, each once): one gone means the result is gone (a receipt's cached words never outlive
//      their original); a cycle, a walk past its limits, or an error means withheld.
//   3. for every message on that walk: withheld from bots, a captured message, a forgotten source, memory a non-owner audience may not see,
//      and partition ancestry: the withheld line, never the text.
import { RECEIPT_ORIGIN_UNCONFIRMED_LINE } from "./card-result-source.ts";
import { hostLine } from "./host-words.ts";
import type { FailureCode } from "./failure-code.ts";
import { MurageStatus, status } from "./murage-status.ts";
import { ReleasedText, WorkerText, type EgressOrigin, type SourceRange, type TextLineage } from "./released-text.ts";
import type { WorkerMessage } from "./worker-message.ts";
import type { DatabaseSync } from "node:sqlite";
import { denyLookup, lineageLive } from "./memory/deny-read.ts";
import { addTurnParents, currentTurnLineage } from "./memory/lineage-write.ts";

export type { EgressOrigin };
export interface EgressMessage { id: string; text?: string; copyOf?: { threadId: string; messageIds: string[] }; withheldFromBots?: boolean | "forgotten" | "checking" }

/** What the egress needs to ask about, supplied once by the server (and by tests). */
export interface ResultEgressDeps {
  message: (threadId: string, messageId: string) => EgressMessage | undefined;
  /** The stored messages of a thread, for finding which of them hold a given piece of text (`textHolders`). Absent: none are found. */
  threadMessages?: (threadId: string) => readonly EgressMessage[];
  authorize: (requestId: string, worker: string, destinationThreadId: string) => { ok: true } | { ok: false; code: string; line: string };
  copyOriginWithheld: (copy: EgressOrigin) => boolean;
  capturedMessageWithheld: (threadId: string, messageId: string) => boolean;
  messageSourceForgotten: (threadId: string, messageId: string) => boolean;
  messageMadeWithMemory: (threadId: string, messageId: string) => boolean;
  partitionAllowed: (workerBotId: string, threadId: string, messageIds: string[]) => boolean;
  /** Both sides are positively the owner's own unshared conversations (the origin of the result is given when there is one). */
  ownUnsharedWork: (who: { fromBotId: string; toBotId: string; fromThreadId: string }, origin: EgressOrigin | undefined) => boolean;
  /** The words a withheld result is replaced by; the status table's own `withheld` line when absent. */
  withheldLine?: string;
  /** Whether every line of a conversation up to a message still stands since a hold-log entry (server/turn-source-holds.ts rangeHolds).
   * Absent: no range can be checked, so text that rests on one is not shown. */
  rangeHolds?: (range: SourceRange) => boolean;
  /** Write-time (DESIGN-WRITETIME 6 k, S4): whether every one of these lines of one thread reads shown to the result's reader. The lines'
   * carries already hold the copy chain, so this replaces the walk's per-message rules once the read-time judge goes (S6); until then both
   * apply. index.ts supplies `writetimeLinesShown(database)`. Absent: the read-time rules alone. */
  linesShown?: (threadId: string, messageIds: readonly string[], notOwnerAudience: boolean) => boolean;
}

/** The write-time lookup on a result's lines, for ResultEgressDeps.linesShown: one page lookup per thread. A not-owner audience is judged
 * with no scopes of its own, so any memory footprint withholds (as messageMadeWithMemory does today); the owner audience skips the footprint.
 * Until write-time lineage is written on this file the read-time rules decide alone. */
export function writetimeLinesShown(db: () => DatabaseSync): NonNullable<ResultEgressDeps["linesShown"]> {
  return (threadId, messageIds, notOwnerAudience) => {
    const file = db();
    if (!messageIds.length || !lineageLive(file)) return true;
    // Only policy/epoch age is exempt for the owner's own chat: a roster change alone must not hide a Chief's delegated reply.
    // Keep the owner audience explicit so receipt revocations, content marks and pending checks still bind the result.
    const verdicts = denyLookup(file, { threadId, lines: messageIds.map(messageId => ({ messageId, author: "generated" as const })) },
      { audience: { owner: !notOwnerAudience, scopeIds: [] } }, { ownerOwnChat: !notOwnerAudience });
    return messageIds.every(id => verdicts.get(id)?.state === "shown");
  };
}

export interface StoredResultRef {
  /** The worker's message(s) that hold the result. Absent when a request finished without one. */
  origin?: EgressOrigin;
  /** The request the result was written for; absent on an older receipt. */
  requestId?: string;
  /** The request found for an older receipt is not the same work: never trusted. */
  binding?: "mismatch";
  /** A receipt records who the result was made for; set (true or false) only for receipts. */
  recordedNotOwner?: boolean;
  /** The result was written by the peer turn a direct ask just started for this same not-owner reader, and that turn ran with the reader's
   * not-owner audience (no owner memory, About me, integrations or computers). Only the ask route sets it, and only when it started the turn
   * that way. With it, a not-owner reader is no reason on its own to refuse an unbound reply: the reply must still be the owner's own
   * unshared work, and every message-level rule below still judges it for a not-owner audience. */
  peerTurnNotOwner?: true;
  /** A receipt written before results carried their lineage: its text cannot be checked, so it is withheld. */
  lineageUnknown?: boolean;
  /** The record is Murage's own account of how a request ended (a stop, a refusal, a failure to start), not a worker's words. It references no
   * message and carries no text through the gate: after authorization the gate answers `status`, and the caller writes its own status line. */
  statusOnly?: boolean;
}

export type ReleasedResult =
  | { kind: "text"; text: ReleasedText; copyOf?: EgressOrigin }
  | { kind: "withheld"; line: MurageStatus }
  | { kind: "refused"; line: MurageStatus; code: string }
  | { kind: "status" }
  | { kind: "gone" };

let configured: ResultEgressDeps | undefined;
const mint = ReleasedText.claim();
const unseal = WorkerText.claimUnseal();
export function configureResultEgress(deps: ResultEgressDeps | undefined): void { configured = deps; }

export const COPY_WALK_MAX_DEPTH = 8;
export const COPY_WALK_MAX_NODES = 64;

type Walk = { ok: true; nodes: Array<{ threadId: string; message: EgressMessage }> } | { ok: false; why: "gone" | "withheld" };

/** Every message the result stands on and every message those were copied from. A missing one is `gone`; a cycle, a limit or an error is `withheld`. */
function walkCopies(deps: ResultEgressDeps, origin: EgressOrigin): Walk {
  const nodes: Array<{ threadId: string; message: EgressMessage }> = [];
  const seen = new Set<string>();
  let level: EgressOrigin[] = [origin];
  try {
    for (let depth = 0; level.length; depth += 1) {
      if (depth > COPY_WALK_MAX_DEPTH) return { ok: false, why: "withheld" };
      const next: EgressOrigin[] = [];
      for (const group of level) {
        for (const id of group.messageIds) {
          const key = `${group.threadId}\u0000${id}`;
          if (seen.has(key)) {
            // met again on this walk: a copy of a copy of itself is a cycle; the same original reached twice from different copies is not
            if (depth > 0 && nodes.some(node => node.threadId === group.threadId && node.message.id === id && node.message.copyOf && cyclesBack(deps, node.message.copyOf, group.threadId, id))) return { ok: false, why: "withheld" };
            continue;
          }
          seen.add(key);
          if (nodes.length >= COPY_WALK_MAX_NODES) return { ok: false, why: "withheld" };
          const message = deps.message(group.threadId, id);
          if (!message) return { ok: false, why: "gone" };
          nodes.push({ threadId: group.threadId, message });
          if (message.copyOf) next.push({ threadId: message.copyOf.threadId, messageIds: message.copyOf.messageIds });
        }
      }
      level = next;
    }
  } catch { return { ok: false, why: "withheld" }; }
  return { ok: true, nodes };
}

/** Does following `from` copy links come back to the message (threadId, id)? Bounded the same way as the walk. */
function cyclesBack(deps: ResultEgressDeps, from: EgressOrigin, threadId: string, id: string): boolean {
  let level: EgressOrigin[] = [from];
  const seen = new Set<string>();
  for (let depth = 0; level.length && depth <= COPY_WALK_MAX_DEPTH; depth += 1) {
    const next: EgressOrigin[] = [];
    for (const group of level) for (const mid of group.messageIds) {
      if (group.threadId === threadId && mid === id) return true;
      const key = `${group.threadId}\u0000${mid}`;
      if (seen.has(key) || seen.size >= COPY_WALK_MAX_NODES) continue;
      seen.add(key);
      const message = deps.message(group.threadId, mid);
      if (message?.copyOf) next.push({ threadId: message.copyOf.threadId, messageIds: message.copyOf.messageIds });
    }
    level = next;
  }
  return false;
}

const withheldResult = (deps: ResultEgressDeps): ReleasedResult => ({ kind: "withheld", line: withheldLine(deps) });
/** The line a withheld result is replaced by: the server's own words for it when it supplies them, otherwise the status table's. */
const withheldLine = (deps: ResultEgressDeps | undefined): MurageStatus => deps?.withheldLine === undefined ? status("withheld") : hostLine(deps.withheldLine);

/** `worker`: the bot that produced the result. `authority.fromBotId` and `destinationThreadId`: who is asking and where the text would go.
 * `text`: the text as it was recorded (a receipt, or the reply just written); read from the stored message when absent. */
export function releaseStoredResult(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text?: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedResult {
  if (!deps) throw new Error("The result gate is not configured");
  const recorded = text === undefined ? undefined : unseal(text);
  const origin = ref.origin;
  const ids = origin?.messageIds ?? [];
  // Every message the result stands on, and every one those were copied from, is read now: a receipt's cached words carry no authority of
  // their own, and one original that is gone or flagged takes the whole result with it.
  const walk = origin ? walkCopies(deps, origin) : undefined;
  const stored = walk?.ok ? walk.nodes.find(node => node.threadId === origin!.threadId && node.message.id === ids[0])?.message : undefined;
  // 1. authorization (the stored message is read first only to learn where a copy came from)
  if (ref.requestId && ref.binding !== "mismatch") {
    const verdict = deps.authorize(ref.requestId, worker, destinationThreadId);
    if (!verdict.ok) return { kind: "refused", line: hostLine(verdict.line), code: verdict.code };
  } else if (ref.binding === "mismatch" || (notOwnerAudience && ref.peerTurnNotOwner !== true) || ref.recordedNotOwner === true
    || !deps.ownUnsharedWork({ fromBotId: authority.fromBotId, toBotId: worker, fromThreadId: destinationThreadId }, stored?.copyOf ?? origin)) {
    return { kind: "refused", line: status("origin_unconfirmed"), code: "origin_unconfirmed" };
  }
  // A status-only record is Murage's own account of how a request ended: it references no worker message and carries no worker text.
  if (ref.statusOnly === true) return { kind: "status" };
  // 2. the stored messages, as read now: gone means gone, whatever text was recorded beside them
  if (origin && walk && !walk.ok) return walk.why === "gone" ? { kind: "gone" } : withheldResult(deps);
  if (origin && (ids.length === 0 && recorded === undefined)) return { kind: "gone" };
  const body = recorded ?? stored?.text;
  if (body === undefined) return { kind: "gone" };
  // Worker text that names no stored message has no origin the rules above could read, so none of them has been applied to it: it is withheld.
  if (recorded !== undefined && ids.length === 0) return withheldResult(deps);
  // 3. the message-level rules, for every message on the walk
  let withheld = ref.lineageUnknown === true || (ref.recordedNotOwner === false && notOwnerAudience);
  try {
    if (origin && walk?.ok) {
      for (const { threadId, message } of walk.nodes) {
        if (message.withheldFromBots !== undefined && message.withheldFromBots !== false) withheld = true;
        if (message.copyOf && deps.copyOriginWithheld(message.copyOf)) withheld = true;
        if (deps.capturedMessageWithheld(threadId, message.id) || deps.messageSourceForgotten(threadId, message.id) || (notOwnerAudience && deps.messageMadeWithMemory(threadId, message.id))) withheld = true;
        if (!deps.partitionAllowed(worker, message.copyOf?.threadId ?? threadId, message.copyOf?.messageIds ?? [message.id])) withheld = true;
      }
      if (ids.length && deps.copyOriginWithheld(origin)) withheld = true;
      // write-time: every line on the walk, by thread (a page lookup each)
      if (deps.linesShown) {
        const byThread = new Map<string, string[]>();
        for (const { threadId, message } of walk.nodes) byThread.set(threadId, [...(byThread.get(threadId) ?? []), message.id]);
        for (const [threadId, lineIds] of byThread) if (!deps.linesShown(threadId, lineIds, notOwnerAudience)) withheld = true;
      }
    }
  } catch { withheld = true; }
  if (withheld) return withheldResult(deps);
  // write-time (DESIGN-WRITETIME 2.4: hand-off, ask and delegate results): the released words rest on every line of the walk. A turn running
  // on the destination thread is handed them now, so they join its parents (its replies, notes and session carry them). Outside a turn
  // nothing is recorded here: a copy written into the thread carries its originals itself (message-db.ts).
  if (origin && walk?.ok) {
    const turn = currentTurnLineage(destinationThreadId);
    if (turn) addTurnParents(turn, walk.nodes.map(({ threadId, message }) => ({ kind: "line" as const, threadId, messageId: message.id })));
  }
  return { kind: "text", text: mint(body, origin && ids.length ? { threadId: origin.threadId, messageIds: [...ids] } : undefined), ...(origin && ids.length ? { copyOf: origin } : {}) };
}

/** What an ask hands back to the bot that asked (and what is mirrored beside it): the gate's answer in the shape the ask needs. A result that is
 * withheld or gone comes back as the withheld line with no link to its original; a refusal carries the reason and nothing else. */
export type ReleasedAskReply =
  | { ok: true; text: ReleasedText; copyOf?: EgressOrigin; withheld: false }
  | { ok: true; text: MurageStatus; withheld: true }
  | { ok: false; line: MurageStatus; code: string };

export function releaseAskReply(
  ref: StoredResultRef, worker: string, destinationThreadId: string, authority: { fromBotId: string }, notOwnerAudience: boolean, text: WorkerText,
  deps: ResultEgressDeps | undefined = configured,
): ReleasedAskReply {
  const released = releaseStoredResult(ref, worker, destinationThreadId, authority, notOwnerAudience, text, deps);
  if (released.kind === "text") return { ok: true, text: released.text, ...(released.copyOf ? { copyOf: released.copyOf } : {}), withheld: false };
  if (released.kind === "refused") return { ok: false, line: released.line, code: released.code };
  return { ok: true, text: released.kind === "withheld" ? released.line : withheldLine(deps ?? configured), withheld: true };
}

/** One row of a conversation that is about to be quoted to a bot (a running delegation's recent activity), reduced to what the gate lets through.
 * Every field the row would render (its text, its tool name) is released together or not at all. A row that records a failure or a retry is never
 * quoted: it is released as the kind of failure it describes, one of the few codes a bot may be told, and the provider's own words stay where
 * the owner reads them. */
export type ReleasedRow = { text?: ReleasedText; tool?: ReleasedText; failure?: { kind: "retrying" | "error"; code: FailureCode } };
export function releaseMessage(
  message: WorkerMessage,
  release: (message: { id: string; text: WorkerText }) => ReleasedResult,
): ReleasedRow | undefined {
  const fields: Array<["text" | "tool", WorkerText]> = [];
  if (message.kind === "text" && message.text?.present) fields.push(["text", message.text]);
  if (message.kind === "activity" && message.tool?.name.present) fields.push(["tool", message.tool.name]);
  if (!fields.length) return undefined;
  const row: ReleasedRow = {};
  for (const [field, words] of fields) {
    const released = release({ id: message.id, text: words });
    if (released.kind !== "text") return undefined;
    if (field === "tool" && message.failure) return { failure: { kind: message.failure, code: words.failureCode() } };
    row[field] = released.text;
  }
  return row;
}

/** At most this many stored lines a piece of worker text's sources may name (server/steer-lineage.ts TURN_SOURCES_MAX). */
export const SOURCES_MAX = 1600;

/** The same released words, resting on more: a reader shown them takes that into its own turn's sources (server/steer-lineage.ts). */
export function releasedWithLineage(text: ReleasedText, lineage: Partial<TextLineage>): ReleasedText { return mint(text, undefined, lineage); }

/** Whether every stored line the writing turn carried (its sources) still stands, by the same message rules the gate applies to the message
 * itself: one gone (deleted), withheld from bots, a copy whose original is withheld, captured and withheld on content, forgotten, or (for a
 * reader who is not the owner's audience) made with memory, and the text derived from that turn is not shown. `ranges` are the stretches of
 * conversations it carried: each is one indexed question (no line of it withheld, forgotten or deleted since the turn took it), however long
 * the conversation. Past the limit, or any check that cannot finish: not shown. */
export function turnSourcesHold(sources: ReadonlyArray<EgressOrigin>, notOwnerAudience: boolean, deps: ResultEgressDeps | undefined = configured,
  ranges: ReadonlyArray<SourceRange> = []): boolean {
  if (!deps) return false;
  let count = 0;
  try {
    if (ranges.length && (!deps.rangeHolds || ranges.length > 64)) return false;
    for (const range of ranges) if (!deps.rangeHolds!(range)) return false;
    for (const group of sources) for (const id of group.messageIds) {
      if (++count > SOURCES_MAX) return false;
      const message = deps.message(group.threadId, id);
      if (!message) return false;
      if (message.withheldFromBots !== undefined && message.withheldFromBots !== false) return false;
      if (message.copyOf && deps.copyOriginWithheld(message.copyOf)) return false;
      if (deps.capturedMessageWithheld(group.threadId, id) || deps.messageSourceForgotten(group.threadId, id)) return false;
      if (notOwnerAudience && deps.messageMadeWithMemory(group.threadId, id)) return false;
    }
  } catch { return false; }
  return true;
}

void RECEIPT_ORIGIN_UNCONFIRMED_LINE;

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
/** A stretch of a note this long, found in a message, ties the note to it. */
const HOLDER_SPAN = 24;
const HOLDER_STEP = 4;
const HOLDER_THREADS = 4;
const HOLDER_MESSAGES = 8;
const HOLDER_SCAN = 2000;

/** The stored messages that hold words of `text`: the provenance of a piece of worker text that was written down apart from its message (a
 * note on a card). A message holds the note when any stretch of 24 characters of it (or all of it, if shorter) is in the message, or when a
 * message of that length or more is wholly in the note. Newest first, at most eight a thread and four threads. A note that matches nothing has
 * no checkable origin, and the caller leaves it out (server/project-notes.ts). */
export function textHolders(threadIds: ReadonlyArray<string | null | undefined>, text: string, deps: ResultEgressDeps | undefined = configured): EgressOrigin[] {
  if (!deps?.threadMessages) return [];
  const note = squash(text);
  if (!note) return [];
  const spans: string[] = [];
  if (note.length <= HOLDER_SPAN) spans.push(note);
  else for (let at = 0; at + HOLDER_SPAN <= note.length; at += HOLDER_STEP) spans.push(note.slice(at, at + HOLDER_SPAN));
  const found: EgressOrigin[] = [];
  for (const threadId of [...new Set(threadIds.filter((id): id is string => typeof id === "string" && id !== ""))].slice(0, HOLDER_THREADS)) {
    const rows = deps.threadMessages(threadId);
    const ids: string[] = [];
    for (let index = rows.length - 1; index >= Math.max(0, rows.length - HOLDER_SCAN) && ids.length < HOLDER_MESSAGES; index--) {
      const body = rows[index]!.text;
      if (typeof body !== "string") continue;
      const flat = squash(body);
      if (flat && (spans.some(span => flat.includes(span)) || (flat.length >= 16 && note.includes(flat)))) ids.push(rows[index]!.id);
    }
    if (ids.length) found.push({ threadId, messageIds: ids });
  }
  return found;
}
