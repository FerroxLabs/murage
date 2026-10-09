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

type Line = (bot: string) => string;
/** The bot's name opening a sentence ("the bot" when unnamed). */
const cap = (bot: string) => bot.charAt(0).toUpperCase() + bot.slice(1);
const RETRY = "Select Retry to send your message again.";

const ENGINE_RESTART: Line = (bot) => `${cap(bot)}'s engine was starting a fresh conversation and needed a moment longer. ${RETRY}`;
const MEMORY_BUSY: Line = (bot) => `${cap(bot)}'s memory was still getting ready for this message. ${RETRY}`;
const MEMORY_CHANGED: Line = (bot) => `${cap(bot)}'s memory changed while this reply was being prepared. ${RETRY}`;
const MEMORY_TOO_MUCH: Line = (bot) => `${cap(bot)} had more history to check than one reply allows. ${RETRY} If it happens again, start a new conversation with ${bot}.`;
const MEMORY_GENERAL: Line = (bot) => `${cap(bot)} couldn't load its memory for this reply. ${RETRY}`;
const GENERAL: Line = (bot) => `Murage couldn't finish ${bot}'s reply. ${RETRY}`;

const SPECIFIC: Record<string, Line> = {
  CLAUDE_SESSION_RESET_TIMEOUT: ENGINE_RESTART,
  CLAUDE_SESSION_NOT_STOPPED: ENGINE_RESTART,
  MEMORY_SESSION_RESET_UNAVAILABLE: ENGINE_RESTART,
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
  MEDIA_WAIT_CONNECTION: (bot) => `${cap(bot)} lost the connection while waiting for a picture or file. ${RETRY}`,
  MURAGE_AGENTS_UNAVAILABLE: (bot) => `${cap(bot)} couldn't reach its teammates for this reply. ${RETRY}`,
};

/** One plain sentence, with the next step, for a turn that failed with an
 *  internal code; undefined when the message does not lead with one. */
export function plainTurnError(message: string, botName?: string): string | undefined {
  const code = turnErrorCode(message);
  if (!code) return undefined;
  const bot = botName?.trim() || "the bot";
  const line = SPECIFIC[code]
    ?? (/^CLAUDE_SESSION_|_SESSION_RESET/.test(code) ? ENGINE_RESTART
      : /(^|_)MEMORY(_|$)/.test(code) ? MEMORY_GENERAL
        : GENERAL);
  return line(bot);
}
