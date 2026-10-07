// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A picture sent to a bot whose model cannot see it is left out of the turn,
// and the conversation says so with one activity message whose tool name
// carries this prefix and the number of pictures (0.1.61 G11). Before, the
// bytes went to the provider anyway and the turn ended in its raw 400. Same
// convention as a browser-unavailable note: neutral, visible with Settings →
// Tool calls off, never an error card; the bot's reply follows it.
export const IMAGES_LEFT_OUT_PREFIX = "images left out:";

export function imagesLeftOutActivityName(count: number): string {
  return `${IMAGES_LEFT_OUT_PREFIX} ${Math.max(1, Math.floor(count))}`;
}

/** How many pictures the note covers, or undefined for any other activity. */
export function imagesLeftOutCount(name: string | undefined | null): number | undefined {
  if (typeof name !== "string" || !name.startsWith(IMAGES_LEFT_OUT_PREFIX)) return undefined;
  const count = Number(name.slice(IMAGES_LEFT_OUT_PREFIX.length).trim());
  return Number.isInteger(count) && count > 0 ? count : 1;
}

/** The plain sentence, naming the bot. The renderer's locale catalog mirrors
 * it (imagesLeftOut.one / .other); this copy serves the Markdown export and
 * the task timeline. */
export function imagesLeftOutSentence(botName: string, count: number): string {
  return count > 1
    ? `${botName} can't see images, so I left the pictures out.`
    : `${botName} can't see images, so I left the picture out.`;
}

export function imagesLeftOutDisplayName(name: string | undefined | null, botName: string): string | undefined {
  const count = imagesLeftOutCount(name);
  return count === undefined ? undefined : imagesLeftOutSentence(botName, count);
}
