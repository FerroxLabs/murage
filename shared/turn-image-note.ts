// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A turn whose images did not all go to the bot says so with one activity
// message whose tool name carries this prefix, the same convention as a
// browser-unavailable note (shared/browser-unavailable.ts). It is a neutral
// line, visible with Settings → Tool calls off, and never an error card: the
// turn went ahead with the images that fit (0.1.61; before, "Attach at most
// four images per turn." failed the whole turn and Retry could not help).
//
// The counts ride the tool name so every surface words the same line from
// the same facts: the chat rows through the renderer's locale catalog, the
// Markdown export and the task timeline through `imagesNotSentDisplayName`.
import { TURN_IMAGE_LIMITS } from "./media-assets.ts";

export const IMAGES_NOT_SENT_PREFIX = "images not sent:";

export interface ImagesNotSent {
  /** Pictures the bot received. */
  sent: number;
  /** Left out because the turn named more than `limit`. */
  overCount: number;
  /** Left out because they did not fit the per-image or per-turn bytes. */
  tooLarge: number;
  /** The per-turn count in force when the note was written. */
  limit: number;
}

/** The activity tool name for a turn that left images out. */
export function imagesNotSentActivityName(counts: Omit<ImagesNotSent, "limit"> & { limit?: number }): string {
  const limit = counts.limit ?? TURN_IMAGE_LIMITS.maxCount;
  return `${IMAGES_NOT_SENT_PREFIX} sent=${counts.sent} over=${counts.overCount} large=${counts.tooLarge} limit=${limit}`;
}

/** The counts an images-left-out note carries, or undefined for any other
 * activity name. */
export function imagesNotSent(name: string | undefined | null): ImagesNotSent | undefined {
  if (typeof name !== "string" || !name.startsWith(IMAGES_NOT_SENT_PREFIX)) return undefined;
  const match = /^ sent=(\d{1,4}) over=(\d{1,4}) large=(\d{1,4}) limit=(\d{1,4})$/.exec(name.slice(IMAGES_NOT_SENT_PREFIX.length));
  if (!match) return undefined;
  const [sent, overCount, tooLarge, limit] = match.slice(1).map(Number) as [number, number, number, number];
  if (overCount + tooLarge === 0) return undefined;
  return { sent, overCount, tooLarge, limit };
}

/** Which sentence a note gets, and the renderer catalog key that says it. */
export type ImagesNotSentKind = "overCount" | "overCountOne" | "tooLarge" | "tooLargeOne" | "both";
export function imagesNotSentKind(counts: ImagesNotSent): ImagesNotSentKind {
  if (counts.overCount && counts.tooLarge) return "both";
  if (counts.overCount) return counts.overCount === 1 ? "overCountOne" : "overCount";
  return counts.tooLarge === 1 ? "tooLargeOne" : "tooLarge";
}

/** The English sentences, mirrored by the renderer's locale catalog
 * (imagesNotSent.*; shared/turn-image-note.test.ts holds them equal). */
export const IMAGES_NOT_SENT_TEMPLATES: Record<ImagesNotSentKind, string> = {
  overCount: "Only the first {limit} images were sent. The other {over} were left out.",
  overCountOne: "Only the first {limit} images were sent. The other one was left out.",
  tooLarge: "{sent} of {total} images were sent. The other {large} were too large and were left out.",
  tooLargeOne: "{sent} of {total} images were sent. One was too large and was left out.",
  both: "{sent} of {total} images were sent. The rest were left out: {over} over the limit of {limit} and {large} too large.",
};

/** The values every template reads. */
export function imagesNotSentParams(counts: ImagesNotSent): Record<"sent" | "total" | "over" | "large" | "limit", number> {
  return { sent: counts.sent, total: counts.sent + counts.overCount + counts.tooLarge, over: counts.overCount, large: counts.tooLarge, limit: counts.limit };
}

/** The plain-words line for surfaces without a renderer locale (the Markdown
 * export, the task timeline), or undefined for any other activity name. */
export function imagesNotSentDisplayName(name: string | undefined | null): string | undefined {
  const counts = imagesNotSent(name);
  if (!counts) return undefined;
  const params = imagesNotSentParams(counts);
  return IMAGES_NOT_SENT_TEMPLATES[imagesNotSentKind(counts)].replace(/\{(\w+)\}/g, (match, key: string) => key in params ? String(params[key as keyof typeof params]) : match);
}

/** The composer's line before sending, when more images are attached than a
 * turn carries (never a block: the send goes ahead with the first ones). */
export const COMPOSER_IMAGES_OVER_LIMIT_TEMPLATES = {
  many: "Only the first {limit} images will be sent. The other {over} will be left out.",
  one: "Only the first {limit} images will be sent. The other one will be left out.",
} as const;
