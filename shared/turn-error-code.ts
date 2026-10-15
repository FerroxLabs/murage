// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A turn that fails inside Murage (the engine session, memory, a mount) ends
// with an internal code as its message: CLAUDE_SESSION_RESET_TIMEOUT,
// MEMORY_REPLAY_LIMIT, sometimes followed by ": developer text". The failure
// card used to show that code as its sentence (1.0.1.1, Sean's screenshot).
// This turns any such code into one plain sentence with what to do next; the
// card keeps the code under Technical details. Specific codes get their own
// sentence; every other code gets its family's, and an unknown family the
// general one, so no code ever reaches the sentence.

/** The internal code a turn failure message leads with, if it leads with one:
 *  upper case words joined by underscores, alone or before a colon. */
export function turnErrorCode(message: string): string | undefined {
  const match = /^\s*([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?::|$)/.exec(message);
  return match?.[1];
}

/** What the person does next. Only "retry" ever mentions the Retry button. */
export type TurnRecovery =
  | "retry"            // the same message can simply be sent again
  | "change-setting"   // a setting must change first (the sentence says where)
  | "link-account"     // a channel account must be linked in Settings
  | "contact"          // wait, check, or reach out; an unchanged retry is not the fix
  | "blocked";         // the provider declined the request; no retry
export interface PlainTurnError { text: string; recovery: TurnRecovery }
export interface PlainTurnOptions {
  /** True when the failure card shows a Retry button (default true). */
  canRetry?: boolean;
}

type Line = (bot: string, again: string) => PlainTurnError;
/** The bot's name opening a sentence ("the bot" when unnamed). */
const cap = (bot: string) => bot.charAt(0).toUpperCase() + bot.slice(1);
const AGAIN_WITH_BUTTON = "Select Retry to send your message again.";
const AGAIN_PLAIN = "Send your message again.";
const retry = (build: (bot: string) => string): Line => (bot, again) => ({ text: `${build(bot)} ${again}`, recovery: "retry" });

const ENGINE_RESTART = retry((bot) => `${cap(bot)}'s engine was starting a fresh conversation and needed a moment longer.`);
const MEMORY_BUSY = retry((bot) => `${cap(bot)}'s memory was still getting ready for this message.`);
const MEMORY_CHANGED = retry((bot) => `${cap(bot)}'s memory changed while this reply was being prepared.`);
const MEMORY_TOO_MUCH: Line = (bot, again) => ({
  text: `${cap(bot)} had more history to check than one reply allows. ${again} If it happens again, start a new conversation with ${bot}.`,
  recovery: "retry",
});
const MEMORY_GENERAL = retry((bot) => `${cap(bot)} couldn't load its memory for this reply.`);
const GENERAL = retry((bot) => `Murage couldn't finish ${bot}'s reply.`);
const HUMAN_LINK: Line = (bot, again) => ({
  text: `${cap(bot)} couldn't match this message to a person in Murage. Open Settings, link the channel account to a person, then ${again.charAt(0).toLowerCase()}${again.slice(1)}`,
  recovery: "link-account",
});
const PROVIDER_BLOCKED: Line = () => ({
  text: "The provider blocked this request. Review your request before sending a new message.",
  recovery: "blocked",
});

const SPECIFIC: Record<string, Line> = {
  CLAUDE_SESSION_RESET_TIMEOUT: ENGINE_RESTART,
  CLAUDE_SESSION_NOT_STOPPED: ENGINE_RESTART,
  // The engine cannot end its retained session, so waiting or retrying adds nothing.
  MEMORY_SESSION_RESET_UNAVAILABLE: (bot) => ({
    text: `${cap(bot)}'s current engine can't start a fresh conversation, which this message needs. Choose a different engine for ${bot} in Provider settings, or start a new conversation with ${bot}.`,
    recovery: "change-setting",
  }),
  MEMORY_MCP_NAME_COLLISION: (bot, again) => ({
    text: `${cap(bot)} has a custom tool named "murage-memory", a name Murage keeps for its own memory. Rename that custom tool in ${bot}'s tool settings, then ${again.charAt(0).toLowerCase()}${again.slice(1)}`,
    recovery: "change-setting",
  }),
  HUMAN_LINK_REQUIRED: HUMAN_LINK,
  MEMORY_CONTEXT_REVOKED: MEMORY_CHANGED,
  MEMORY_DISCLOSURE_SESSION_CONFLICT: MEMORY_CHANGED,
  MEMORY_DISCLOSURE_UNKNOWN: MEMORY_CHANGED,
  MEMORY_VERSION_CONFLICT: MEMORY_CHANGED,
  STALE_MEMORY_SOURCE: MEMORY_CHANGED,
  STALE_MEMORY_LEASE: MEMORY_CHANGED,
  MEMORY_REPLAY_LIMIT: MEMORY_TOO_MUCH,
  MEMORY_LOOKUP_LIMIT: MEMORY_TOO_MUCH,
  MEMORY_RESPONSE_LIMIT: MEMORY_TOO_MUCH,
  MEMORY_WORKER_NOT_READY: MEMORY_BUSY,
  MEMORY_WORKER_START_BACKOFF: MEMORY_BUSY,
  MEMORY_WORKER_START_FAILED: MEMORY_BUSY,
  MEMORY_WORKER_EXITED: MEMORY_BUSY,
  MEMORY_QUERY_DEADLINE: MEMORY_BUSY,
  MEMORY_EXTRACTOR_UNAVAILABLE: MEMORY_BUSY,
  MEDIA_WAIT_CONNECTION: retry((bot) => `${cap(bot)} lost the connection while waiting for a picture or file.`),
  // The hand-off may already have gone through: an unchanged retry could assign it twice.
  MURAGE_AGENTS_UNAVAILABLE: (bot) => ({
    text: `${cap(bot)} couldn't reach its teammates for this reply, so the hand-off may not have gone through. Check the teammates' conversations before asking again, so the request isn't assigned twice.`,
    recovery: "contact",
  }),
  SAFETY_CHECK_FAILED: PROVIDER_BLOCKED,
  SAFETY_POLICY_VIOLATION: PROVIDER_BLOCKED,
};

/** One plain sentence, with the next step and its recovery class, for a turn
 *  that failed with an internal code; undefined when the message does not lead
 *  with one. The sentence says "Retry" only when the card shows that button. */
export function describeTurnError(message: string, botName?: string, options: PlainTurnOptions = {}): PlainTurnError | undefined {
  const code = turnErrorCode(message);
  if (!code) return undefined;
  const bot = botName?.trim() || "the bot";
  const again = options.canRetry === false ? AGAIN_PLAIN : AGAIN_WITH_BUTTON;
  const line = SPECIFIC[code]
    ?? (/^CLAUDE_SESSION_|_SESSION_RESET/.test(code) ? ENGINE_RESTART
      : /^HUMAN_/.test(code) ? HUMAN_LINK
        : /(^|_)MEMORY(_|$)/.test(code) ? MEMORY_GENERAL
          : GENERAL);
  return line(bot, again);
}

/** The sentence alone (see describeTurnError). */
export function plainTurnError(message: string, botName?: string, options: PlainTurnOptions = {}): string | undefined {
  return describeTurnError(message, botName, options)?.text;
}
