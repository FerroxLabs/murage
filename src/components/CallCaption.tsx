// What the call screen says under the avatar: the owner's own words while
// listening, and what the bot is saying otherwise — plus, once the owner's
// turn has ended, their last line stays up as a muted "You:" line above the
// bot's caption, through "One moment" and the reply, until their next turn
// starts. Without it, a phone call (no partial words while listening) never
// showed the owner's own words on screen at all: the final transcript lands
// in the same render as the switch away from "listening", so the plain
// listening-only line above was painted over before anyone saw it.
//
// While the bot speaks, the caption is read along (ReadAlong.tsx): the
// sentences already heard, the one audible lit word by word, and the ones
// still to come.
//
// The block has one fixed height in every phase: the You row always takes
// its row and the caption slot is as tall as the read-along's maximum, so
// the avatar and its aura above never move between the owner's turn and the
// bot's (call-aura-review.md I4).
import { ReadAlong } from "./ReadAlong";

export function CallCaption({
  phase,
  heard,
  caption,
  spoken,
  queued,
  progress,
  pushToTalk,
}: {
  phase: "listening" | "sending" | "working" | "speaking";
  /** The owner's last line, live while listening; kept afterward until the
   *  next turn clears it (see `listen()` in CallView.tsx). */
  heard: string;
  /** The bot's current spoken utterance, shown whenever not listening. */
  caption?: string;
  /** The reply's sentences already heard and still to come (the speaker's
   *  snapshot), for the read-along while speaking. */
  spoken?: string[];
  queued?: string[];
  /** How far through the current clip the sound has got (ReadAlong). */
  progress?: (chars: number) => number | null;
  pushToTalk: boolean;
}) {
  return (
    <div className="flex w-full max-w-[560px] flex-col items-center gap-1 px-6 text-center">
      <div data-caption-you="" className="h-5 w-full truncate text-[13px] text-ink-secondary/70">
        {phase !== "listening" && heard ? `You: ${heard}` : null}
      </div>
      <div data-caption-slot="" className="h-[9.5rem] w-full overflow-hidden text-[15px] leading-relaxed text-ink">
        <div className="flex max-h-full flex-col items-center justify-end overflow-hidden">
          {phase === "listening" ? (
            heard || (
              <span className="text-ink-secondary">{pushToTalk ? "Release Control + Option to send…" : "Say something…"}</span>
            )
          ) : phase === "speaking" && caption ? (
            <ReadAlong spoken={spoken} current={caption} queued={queued} progress={progress} />
          ) : (
            caption
          )}
        </div>
      </div>
    </div>
  );
}
