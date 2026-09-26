// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The longest routine instructions Murage keeps, in characters.
 *
 * Routine instructions used to be cut to 20,000 characters on save with no
 * warning, so a long brief whose task sat in its last lines reached the bot
 * without the task (0.1.60 Linux and Windows re-test 2, D4). Every engine now
 * receives a turn's text on stdin or over HTTP, never on a command line, so
 * the limit is about what a routine reasonably holds, not what an engine can
 * take: about 25,000 tokens, a small part of any current model's context.
 * Longer instructions are refused, in the editor before Save and on the
 * server, and never shortened. */
export const ROUTINE_INSTRUCTIONS_MAX = 100_000;

const count = new Intl.NumberFormat("en-US");

/** The one sentence shown when instructions are over the limit. */
export function routineInstructionsTooLongMessage(length: number): string {
  return `Routine instructions can be up to ${count.format(ROUTINE_INSTRUCTIONS_MAX)} characters, and these are ${count.format(length)}. Shorten them, or attach the long part as a file for the bot to read.`;
}

/** The same rule without a count, for a bot's routine tool call. */
export const ROUTINE_INSTRUCTIONS_LIMIT_SENTENCE = `Routine instructions can be up to ${count.format(ROUTINE_INSTRUCTIONS_MAX)} characters. Shorten them, or attach the long part as a file for the bot to read.`;

/** Characters counted the way the server counts them: after trimming. */
export function routineInstructionsLength(text: string): number {
  return text.trim().length;
}
