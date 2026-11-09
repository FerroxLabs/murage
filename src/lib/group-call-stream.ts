/** Room replies consume authenticated identities and server audio, never raw text. */
import type { CallSpeechReply } from "./bot-call-session";

export class ReplyStreamer {
  private taken = false;
  private closed = false;
  private readonly play: (reply: CallSpeechReply) => void;
  constructor(play: (reply: CallSpeechReply) => void) { this.play = play; }
  get started(): boolean { return this.taken; }
  ready(reply: CallSpeechReply): void {
    if (this.closed || this.taken) return;
    this.taken = true;
    this.play(reply);
  }
  close(): void { this.closed = true; }
}

/** One `[call-diag]` line per member block of a room reply: where the time
 *  from the owner's line to the member's first sound went. Numbers and kinds
 *  only, never words. */
export function groupTurnTiming(t: {
  sentAt: number;
  firstTextAt: number | null;
  firstClipAt: number | null;
  playingAt: number | null;
  piece?: "clause" | "sentence" | null;
  pieceChars?: number;
  ackAt?: number | null;
}): string {
  const ms = (from: number | null | undefined, to: number | null | undefined) => (from && to ? `${Math.max(0, to - from)}` : "-");
  return [
    `[call-diag] group turn timing: sent->first text ${ms(t.sentAt, t.firstTextAt)} ms`,
    `first text->first clip ${ms(t.firstTextAt, t.firstClipAt)} ms`,
    `first clip->playing ${ms(t.firstClipAt, t.playingAt)} ms`,
    `total ${ms(t.sentAt, t.playingAt)} ms`,
    `piece=${t.piece ? `${t.piece}:${t.pieceChars ?? 0}` : "-"}`,
    `ack=${ms(t.sentAt, t.ackAt)}`,
  ].join(", ");
}

/** Keep the first-text stamp of the member's block now writing. A new member,
 *  or the same member after the stream cleared (their previous block settled),
 *  starts a new block. */
export function blockStamp(
  stamps: { block: { memberId: string; at: number } | null },
  memberId: string | undefined,
  writing: string,
  now: number,
): void {
  if (!writing) {
    stamps.block = null;
    return;
  }
  if (memberId && stamps.block?.memberId !== memberId) stamps.block = { memberId, at: now };
}

export interface ReplyVoice {
  push(clip: string): void;
  end(): void;
}

/** Exactly-once admission to the component's existing FIFO playback queue. */
export class RoomReplyVoice<M extends { id: string }> {
  private muted = false;
  private readonly seen = new Set<string>();
  private readonly play: (member: M, reply: CallSpeechReply) => void;
  constructor(play: (member: M, reply: CallSpeechReply) => void) { this.play = play; }
  ready(member: M | undefined, reply: CallSpeechReply): void {
    if (!member || member.id !== reply.botId || this.seen.has(reply.replyId)) return;
    if (this.seen.size >= 4096) { this.muted = true; return; }
    this.seen.add(reply.replyId);
    if (!this.muted) this.play(member, reply);
  }
  end(): void { /* The component owns queued and active audio through playback end. */ }
  turnOver(): void { this.muted = false; }
  interrupt(wasWorking: boolean): void { this.muted = wasWorking; }
}
