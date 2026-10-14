// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the server tells a person about a message they sent, as a CODE and never
// as a sentence. The code is what is stored (in the send record and in the
// transcript's notice line); the words are written by the language packs
// (src/locales, keys `sendNotice.<code>`), so the notice reads in the person's
// own language on every device, and a pack that has not caught up falls back to
// the English below.

export const SEND_NOTICE_CODES = ["notRecorded", "lateRefused", "notConfirmed", "refused"] as const;
export type SendNoticeCode = (typeof SEND_NOTICE_CODES)[number];

/** The prefix of a transcript notice line's tool name: `send-notice:<code>`. */
export const SEND_NOTICE_PREFIX = "send-notice:";

/** English, for the surfaces that have no language pack (a Markdown export, a log). */
export const SEND_NOTICE_ENGLISH: Record<SendNoticeCode, string> = {
  notRecorded: "Murage couldn't record that message, so nothing was sent. Your words are still in the box. Try again in a moment.",
  lateRefused: "The bot could not take that message in time and a newer one had already gone ahead, so it was not run. Send it again if you still want it.",
  notConfirmed: "This message may not have reached the bot before Murage closed. It was not sent again. Send it again if you still want it.",
  refused: "This message could not start, so it was not sent. Your words are still here. Send it again when you are ready.",
};

export function isSendNoticeCode(value: unknown): value is SendNoticeCode {
  return typeof value === "string" && (SEND_NOTICE_CODES as readonly string[]).includes(value);
}

/** The activity tool name that carries a notice code. */
export function sendNoticeActivityName(code: SendNoticeCode): string {
  return `${SEND_NOTICE_PREFIX}${code}`;
}

/** The code a transcript notice line carries, or undefined for any other activity name. */
export function sendNoticeCode(name: string | undefined | null): SendNoticeCode | undefined {
  if (typeof name !== "string" || !name.startsWith(SEND_NOTICE_PREFIX)) return undefined;
  const code = name.slice(SEND_NOTICE_PREFIX.length);
  return isSendNoticeCode(code) ? code : undefined;
}

/** English reading of a notice line, for surfaces with no renderer locale. */
export function sendNoticeDisplayName(name: string | undefined | null): string | undefined {
  const code = sendNoticeCode(name);
  return code ? SEND_NOTICE_ENGLISH[code] : undefined;
}
