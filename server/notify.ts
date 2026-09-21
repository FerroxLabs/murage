// Notifications — what is worth interrupting someone for.
//
// `BotRecord.notifications` has been a switch in the settings panel that
// nothing read. This is the thing that reads it. The rule it encodes is
// small and deliberate: a bot that is *blocked on you* is worth a buzz, and
// a bot that *finished* is worth one if you asked for it; everything else a
// bot does while it works is not.
//
// A turn that dies before it starts is the first case, not the last: the
// bot is not working, and the fix is usually a setting only a person can
// change, so a retry cannot clear it. A routine failure already buzzed;
// this makes an interactive turn behave the same way.
//
// Delivery is a separate concern. The harness emits a frame; whoever is
// listening decides what to do with it — desktop and paired-phone local
// notifications today, and closed-app APNs delivery once a relay exists.

export type NotifyKind = "approval" | "question" | "done" | "routine-failed" | "turn-failed" | "takeover";

export interface Notification {
  kind: NotifyKind;
  botId: string;
  botName: string;
  threadId: string;
  title: string;
  body: string;
  /** The bot's stored profile image, when it has one; clients show it as
   * the OS notification's icon so every banner carries its bot's face. */
  avatarUrl?: string;
  /** Content and identifying artwork were removed by the privacy policy. */
  privatePreview?: true;
  requestId?: string;
  messageId?: string;
  requestTurnId?: string;
}

/** One line, short enough for a lock screen, with the newlines and code
 * fences of a model's answer flattened out of it. */
export function summarize(text: string, max = 140): string {
  const line = text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Whether a turn that died before it started is worth a banner of its own.
 *
 * Only a turn the PERSON started themselves. Every other kind already has a
 * channel, and buzzing here as well rings twice for one failure:
 *   - a routine run reports through `onDispatchError`, which raises
 *     routine-failed;
 *   - a delegated sub-turn is reported to the bot that asked for it, in its
 *     own thread;
 *   - a card continuation is a resume the person is already looking at, and
 *     the card itself carries the error;
 *   - and a turn Murage started while nobody was at the keyboard exists
 *     BECAUSE something already buzzed — a team incident report is raised on
 *     the back of the routine-failed banner that has just gone out, so its own
 *     dispatch failure is the same failure a second time.
 *
 * That last term is the one this predicate exists for. It was written inline
 * in the dispatch catch without it, which made the team-incident turn — whose
 * commonest cause of failure, a provider being down, is also a leading cause
 * of the routine failure it is reporting — ring the person twice. */
export function turnFailureBuzzes(opts?: {
  automationSource?: string;
  commsDepth?: number;
  cardContinuation?: boolean;
  unattended?: boolean;
}): boolean {
  return opts?.automationSource === undefined && !opts?.commsDepth && !opts?.cardContinuation && !opts?.unattended;
}

export interface NotifyBot {
  id: string;
  name: string;
  threadId: string;
  notifications?: boolean;
}

/** Build the frame for one event, or null when it should stay quiet.
 *
 * Kept pure and separate from the event fold so the policy — which is the
 * part people will argue about — can be read and tested on its own. */
export function buildNotification(
  kind: NotifyKind,
  bot: NotifyBot,
  threadId: string,
  detail: string,
  extra?: { avatarUrl?: string; requestId?: string; messageId?: string; requestTurnId?: string },
): Notification | null {
  // The toggle means what it says: off is off, including for approvals.
  // A bot whose notifications you turned off can still block waiting for
  // you — that is the choice you made, and the chat still shows the card.
  if (bot.notifications === false) return null;

  const body = summarize(detail);
  const title =
    kind === "approval"
      ? `${bot.name} needs approval`
      : kind === "question"
        ? `${bot.name} has a question`
        : kind === "takeover"
          ? `${bot.name} needs your hands`
          : kind === "routine-failed"
            ? `${bot.name}'s routine failed`
            : kind === "turn-failed"
              ? `${bot.name} couldn't start`
              : `${bot.name} finished`;

  // A "finished" with nothing to say is not worth a notification — the
  // badge in the sidebar already carries that much.
  if (kind === "done" && !body) return null;

  return { kind, botId: bot.id, botName: bot.name, threadId, title, body, ...extra };
}
