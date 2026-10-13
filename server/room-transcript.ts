// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which room messages a member turn reads, when memory is on (0.1.61
// transcript fix, R-A).
//
// A room message is a room record. For a turn whose audience is the owner,
// every teammate reply stays in the transcript: a roster change, a settings
// change or what this member could recall no longer removes it. A reply that
// used something the owner forgot, deleted or changed is replaced by a
// visible withheld line (room-context.ts), never dropped.
//
// Any other room turn (a channel person's pair room, a chain a channel person
// started, words nobody proved are the owner's) keeps the per-reader replay
// filter unchanged.
import { filterMemoryReplay, roomReplayWithheld } from "./memory/disclosures.ts";
import type { MemoryAccess } from "./memory/policy.ts";
import { database } from "./database.ts";
import { messageMadeWithMemory, messageSourceForgotten, replayExclusions, threadHoldsMemoryLines, type LineageAllowance } from "./memory/replay-lineage.ts";
import { GROUP_CONTEXT_MESSAGES, withholdRoomReplies } from "./room-context.ts";
import type { Message } from "./store.ts";
import type { LineageRef, PromptPart } from "./memory/lineage-types.ts";
import { lineRefs, promptPart } from "./memory/prompt-parts.ts";

export interface RoomTranscript {
  messages: Message[];
  /** Replies shown as a withheld line. Empty for a filtered transcript,
   * whose removed messages are not shown at all. */
  withheld: Set<string>;
  /** Of those, the replies the owner forgot themselves, rather than ones
   * that used something forgotten, deleted or changed. */
  forgotten: Set<string>;
  /** Of those, the replies left out only because earlier context is still being checked: nothing was withdrawn. */
  checking: Set<string>;
  /** The messages checked for this turn. The owner's "bots no longer see
   * this reply" note follows only these. */
  checked: Set<string>;
}

/** Reads one stored message by its id (an indexed read); the pin and a quoted line older than the window are fetched this way. Absent: found by
 * scanning the messages given. */
export type MessageById = (id: string) => Message | undefined;

/** A room turn checks only the lines a member prompt can show: the newest window, the pin and each quoted line. That is bounded work at every
 * room size, with memory on or off, and a line it did not check is never shown. */
export function roomTranscriptForTurn(allowance: LineageAllowance, threadId: string, messages: readonly Message[], ownerAudience: boolean, access: MemoryAccess, pinnedMessageId?: string, byId?: MessageById): RoomTranscript {
  if (!ownerAudience) return boundedFilter(allowance, threadId, messages, access, pinnedMessageId, byId);
  const candidates = promptCandidates(messages, pinnedMessageId, GROUP_CONTEXT_MESSAGES, byId);
  const checking = new Set<string>();
  const withheld = roomReplayWithheld(allowance, threadId, candidates, checking);
  const forgotten = forgottenReplies(threadId, candidates, withheld);
  for (const id of forgotten) checking.delete(id);
  return { messages: withholdRoomReplies(candidates, withheld, forgotten, checking), withheld, forgotten, checking, checked: new Set(candidates.map(m => m.id)) };
}

/** The withheld lines whose own source the owner forgot (the owner's own lines too: 1.0.2 revoke-bounded r3). */
function forgottenReplies(threadId: string, messages: readonly Message[], withheld: ReadonlySet<string>): Set<string> {
  return new Set(messages.filter(m => withheld.has(m.id) && messageSourceForgotten(threadId, m.id)).map(m => m.id));
}

/** The transcript a member reads when memory is not active (capture only,
 * paused or off). Receipts from when it was on still name the replies made
 * with memory, and what the owner forgot since must not come back because
 * memory stopped: the content rule still applies, as a withheld line for the
 * owner's turn and as a dropped line for anyone else. A room that never used
 * memory (no receipt, no copy, no reply with output roots) is read as it is. */
export function roomTranscriptWithoutMemory(allowance: LineageAllowance, threadId: string, messages: readonly Message[], ownerAudience: boolean, pinnedMessageId?: string, unprovenInOwnerRoom = false, options: { byId?: MessageById; whole?: boolean } = {}): { messages: Message[]; withheld: Set<string>; forgotten: Set<string>; checking: Set<string>; checked: Set<string> } | undefined {
  // `whole`: a direct conversation's replay window, already bounded by the caller (partitionTranscriptWindow); a room is cut to what a member prompt shows.
  const candidates = options.whole ? [...messages] : promptCandidates(messages, pinnedMessageId, GROUP_CONTEXT_MESSAGES, options.byId);
  // A thread with no receipt of its own may still hold replies built on
  // memory from elsewhere (v6 output roots, e.g. cross-thread working
  // context): those are checked too (Astra r4 #3).
  // A thread that captured a reply and then had it forgotten (capture only: no receipt, no root) is not read as it is either: its
  // forgotten lines are withheld below. Two seeks of the thread's own rows (its sources, its source tombstones), never history.
  if (!database().prepare("SELECT 1 FROM memory_disclosures WHERE thread_id=? LIMIT 1").get(threadId) && !candidates.some(m => m.copyOf)
    && !threadHoldsMemoryLines(threadId)
    && !threadHasForgottenSource(threadId)) return undefined;
  const checking = new Set<string>();
  const withheld = replayExclusions(allowance, threadId, candidates, null, { failClosed: true, checking });
  // (a forgotten owner line is already excluded by replayExclusions: 1.0.2 revoke-bounded r3)
  for (const m of candidates) if (m.role !== "user" && !withheld.has(m.id) && messageSourceForgotten(threadId, m.id)) { withheld.add(m.id); checking.delete(m.id); }
  // Words nobody proved are the owner's, in the owner's room, with no memory
  // access to check a reply against: no reply made with memory is shown.
  if (unprovenInOwnerRoom) for (const m of candidates) if (m.role !== "user" && messageMadeWithMemory(threadId, m.id)) { withheld.add(m.id); checking.delete(m.id); }
  const checked = new Set(candidates.map(m => m.id));
  if (!ownerAudience) return { messages: candidates.filter(m => !withheld.has(m.id)), withheld: new Set(), forgotten: new Set(), checking: new Set(), checked };
  const forgotten = forgottenReplies(threadId, candidates, withheld);
  // a line the owner forgot is withdrawn, whatever else ran out
  for (const id of forgotten) checking.delete(id);
  return { messages: withholdRoomReplies(candidates, withheld, forgotten, checking), withheld, forgotten, checking, checked };
}

/** Whether any message line of this thread was forgotten: tombstoned by id (the message source ids of a thread share the prefix
 * message:<thread>:, a range of the tombstones' unique index; every forget, conversation and bot deletion writes one per line it
 * ends), or the conversation itself was deleted (deny.ts). Two seeks, never the thread's sources. */
function threadHasForgottenSource(threadId: string): boolean {
  const db = database(), prefix = `message:${threadId}:`;
  return Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id>=? AND target_id<? LIMIT 1").get(prefix, `message:${threadId};`)
    || db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(threadId));
}

/** The most rows the newest-first walk goes back over to find its lines (text or not): the walk is bounded by rows, not only by lines. */
const WALK_ROWS = 400;

/** The newest `limit` text lines, the pin and every line they quote, in their places in the conversation. The walk goes from the end and
 * stops at `limit` lines or at the row cap; the pin and a quoted line outside it are fetched by id. */
function promptCandidates(messages: readonly Message[], pinnedMessageId: string | undefined, limit: number, byId?: MessageById): Message[] {
  let lines = 0, start = messages.length;
  for (let index = messages.length - 1; index >= 0 && messages.length - index <= WALK_ROWS * Math.ceil(limit / GROUP_CONTEXT_MESSAGES); index -= 1) {
    start = index;
    const row = messages[index]!;
    if (row.kind === "text" && row.text && ++lines >= limit) break;
  }
  const tail = messages.slice(start);
  const have = new Set(tail.map(m => m.id));
  const extras: Message[] = [];
  const fetch = (id: string | undefined) => {
    if (!id || have.has(id)) return;
    const found = byId ? byId(id) : messages.find(m => m.id === id);
    if (found) { have.add(id); extras.push(found); }
  };
  fetch(pinnedMessageId);
  for (const m of tail) fetch(m.replyToId);
  return [...extras.sort((a, b) => a.at - b.at), ...tail];
}

/** A filtered transcript drops what it may not show, so older lines move up
 * into the window: widen the checked tail until the window is full, up to a
 * fixed number of rounds. */
function boundedFilter(allowance: LineageAllowance, threadId: string, messages: readonly Message[], access: MemoryAccess, pinnedMessageId: string | undefined, byId?: MessageById): RoomTranscript {
  let limit = GROUP_CONTEXT_MESSAGES * 2, kept: Message[] = [], candidates: Message[] = [];
  for (let round = 0; round < 4; round++, limit *= 2) {
    candidates = promptCandidates(messages, pinnedMessageId, limit, byId);
    kept = filterMemoryReplay(allowance, threadId, candidates, access, { persist: false, failClosed: true });
    if (kept.filter(m => m.kind === "text" && m.text).length >= GROUP_CONTEXT_MESSAGES || candidates.length >= messages.length) break;
  }
  return { messages: kept, withheld: new Set(), forgotten: new Set(), checking: new Set(), checked: new Set(candidates.map(m => m.id)) };
}

/** The transcript as rendered into a member prompt, as a prompt part (DESIGN-WRITETIME 2.2). A transcript of the turn's own thread is
 * positional (the reply's turn lsn already covers every earlier line), recorded as a prefix of that thread; a transcript of another
 * thread carries a point to each line whose words it shows (a withheld line shows only its withheld line, so it carries nothing). */
export function roomTranscriptPart(text: string, transcriptThreadId: string, turnThreadId: string, transcript: Pick<RoomTranscript, "messages" | "withheld">): PromptPart {
  const refs: LineageRef[] = transcriptThreadId === turnThreadId
    ? [{ kind: "prefix", threadId: transcriptThreadId }]
    : lineRefs(transcriptThreadId, transcript.messages.filter(m => !transcript.withheld.has(m.id)).map(m => m.id));
  return promptPart(text, refs);
}
