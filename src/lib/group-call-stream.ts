// A channel member's reply, spoken as it is written.
//
// A member's engine turn streams its text into the thread's streaming tail
// long before the block settles as a message. The 1:1 call speaks each
// sentence as the voice host writes it (Speaker.stream); this does the same
// for a room call, with the very same sentence splitting and minimum clip
// size the call's server side uses (server/tts/speech-text.ts), so the first
// audio follows the first sentence instead of the whole block.
//
// Pure: it is handed the text so far and says what is new.
import { firstClauseEnd, MIN_UTTERANCE_CHARS, splitSentences, toUtterances } from "../../server/tts/speech-text";

/** The goal control envelope's opening tag (server/group-goal-run.ts; a test
 *  holds the two together). The server strips the envelope from the settled
 *  message, so the stream must never speak it. */
const GOAL_OPEN = "<murage-goal>";

export class ReplyStreamer {
  /** How much of the block's text has been taken from the stream. */
  private taken = 0;
  /** A sentence shorter than the minimum, waiting for the next to join it. */
  private carry = "";
  private any = false;
  private stopped = false;

  constructor(private readonly say: (clip: string) => void) {}

  /** True once anything of this block has been handed on. */
  get started(): boolean {
    return this.any;
  }

  /** The block's text so far. Each sentence that is complete (the boundary
   *  needs the whitespace after it) goes on once. Text that is empty or has
   *  not grown, as after a settled message clears the stream, changes
   *  nothing. A code fence or a goal envelope ends streaming: what follows
   *  is dealt with at settle(), where the server has already stripped the
   *  envelope and a code block is said as "a code block". */
  update(full: string): void {
    if (this.stopped || full.length <= this.taken) return;
    const cuts = [full.indexOf("```"), full.indexOf(GOAL_OPEN)].filter((at) => at >= 0);
    const usable = cuts.length ? full.slice(0, Math.min(...cuts)) : full;
    const window = usable.slice(this.taken);
    if (!window) return;
    let { sentences, rest } = splitSentences(window, false);
    if (!this.any && !sentences.length) {
      // the block's first piece may stop at a clean clause end, as the 1:1
      // voice host's does, so the member starts sounding sooner
      const at = firstClauseEnd(window, false);
      if (at > 0) {
        sentences = [window.slice(0, at).trim()];
        rest = window.slice(at);
      }
    }
    this.taken += window.length - rest.length;
    this.streamed = full.slice(0, this.taken);
    for (const sentence of sentences) this.emit(sentence);
  }
  private streamed = "";

  /** The block settled as `finalText`. Only when it continues what was
   *  streamed (the same text once trimmed) is the unspoken rest said; a
   *  final that differs, because the server cut a speaker line or changed
   *  the wording, adds nothing: nothing is said twice or from a guessed
   *  offset. */
  settle(finalText: string): void {
    if (this.stopped) return;
    this.stopped = true;
    const done = this.streamed.trim();
    const final = finalText.trim();
    if (done && !final.startsWith(done)) return;
    for (const sentence of toSentences(final.slice(done.length))) this.emit(sentence);
    if (this.carry) {
      const last = this.carry;
      this.carry = "";
      this.any = true;
      this.say(last);
    }
  }

  private emit(text: string): void {
    for (const piece of toUtterances(text, { minChars: 0 })) {
      const clip = this.carry ? `${this.carry} ${piece}` : piece;
      this.carry = "";
      if (clip.length < MIN_UTTERANCE_CHARS) {
        this.carry = clip;
        continue;
      }
      this.any = true;
      this.say(clip);
    }
  }
}

/** Whole text, cut at its sentence ends. */
function toSentences(text: string): string[] {
  const { sentences, rest } = splitSentences(`${text} `);
  return [...sentences, rest.trim()].filter(Boolean);
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

/**
 * The room's reply voice: one block of one member's text at a time, a speaker
 * stream per block (opened lazily, at its first clip), and a mute for a turn
 * the owner interrupted. The component supplies `open`; this holds the rules.
 */
export class RoomReplyVoice<M extends { id: string }> {
  private block: { member?: M; streamer: ReplyStreamer; voice: ReplyVoice | null } | null = null;
  /** The interrupted turn: nothing more of it is spoken until it is over. */
  private muted = false;
  /** The block that last settled; its stream may still be on screen. */
  private settled = "";

  constructor(private readonly open: (member?: M) => ReplyVoice) {}

  private blockFor(member?: M) {
    if (this.block && this.block.member?.id === member?.id) return this.block;
    this.block?.voice?.end();
    const block: NonNullable<RoomReplyVoice<M>["block"]> = {
      member,
      voice: null,
      streamer: new ReplyStreamer((clip) => {
        block.voice ??= this.open(member);
        block.voice.push(clip);
      }),
    };
    this.block = block;
    return block;
  }

  /** The text streaming in for the member now working. */
  update(member: M | undefined, writing: string): void {
    if (!writing) {
      this.settled = "";
      return;
    }
    if (this.muted || !member || this.settled.startsWith(writing.trim())) return;
    this.blockFor(member).streamer.update(writing);
  }

  /** A text message from the member settled. */
  settle(member: M | undefined, text: string): void {
    if (this.muted) return;
    this.blockFor(member).streamer.settle(text);
    this.settled = text;
    this.end();
  }

  /** No more sentences are coming for the block being spoken (a prompt is
   *  about to be asked, or a block settled). Does not end a mute. */
  end(): void {
    this.block?.voice?.end();
    this.block = null;
  }

  /** The turn is over: nothing is working any more. */
  turnOver(): void {
    this.end();
    this.muted = false;
  }

  /** The owner cut the reply off. While something was working, the rest of
   *  that turn (deltas still on their way, a half-written message) is not
   *  spoken, and no speaker stream is opened that would close the mic. */
  interrupt(wasWorking: boolean): void {
    this.end();
    this.muted = wasWorking;
  }
}
