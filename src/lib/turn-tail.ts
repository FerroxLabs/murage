import type { Message } from "@/state/store";

/** Whether the transcript tail should show the "working" dots (the mascot
 * and its timer). They stay for the whole turn: a bot's text in the middle of
 * a turn ("Now I'll build the dashboard") is not its end, and the engine may
 * then spend minutes writing a file before its next step shows (upstream
 * OpenMausBot #3374, Apache-2.0, see NOTICE).
 *
 * A turn ends across three server frames: the settled reply (`message`),
 * `turn.completed`, then the bot patch that flips `busy` off. Deriving the
 * dots from `busy && !streaming` alone re-shows them in that window — the
 * reply lands, the dots pop back under it for a beat, then vanish — and the
 * pinned scroll re-anchors around each height change. That grow-shrink-jump
 * is the end-of-stream jitter. So a settled reply at the tail hides the dots
 * once the turn has ENDED (turn.completed seen, state/turn-status.ts), and they
 * stay hidden until something actually new starts: a tool chip, the user's
 * next prompt, or (in rooms) a different speaker taking the floor. No timer
 * ever hides them.
 */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
  /** rooms: the bot currently speaking. A settled reply from a PREVIOUS
   * speaker doesn't cover this one — its dots are real information. */
  speakerBotId?: string,
  /** The thread's newest turn has completed (state/turn-status.ts). */
  turnEnded = false,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  const settledReply = lastMessage.role === "bot" && lastMessage.kind === "text";
  if (!settledReply) return true;
  if (speakerBotId !== undefined && lastMessage.from?.botId !== speakerBotId) return true;
  return !turnEnded;
}
