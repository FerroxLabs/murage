// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A line Murage writes into a bot's conversation in its own voice while (or about) a turn: an error, retry, stop, notice, status or
// waiting line. It may carry the bot's colours and the turn's id, so the transcript and the turn's chip group read it as the bot's, but
// the engine never produced it. Write-time lineage reads the marker (message-db.ts isEngineOutput): such a line is attached to no open
// turn, so it never makes a turn an inherit child, never advances a turn's sessions and can never cause a refusal; it rests only on the
// parents of the turn its turnId names, as its own refs. Presentation reads actorKind, never this. One helper stamps it, so a new kind of
// Murage line cannot forget it: the turn's event fold stamps every row it writes without a provider reply (index.ts pushMessage), and every
// other writer of such a line wraps it in murageLine.
import type { Message } from "./store.ts";

/** The row, marked as written by Murage (never by a turn's engine). */
export function murageLine<T extends Partial<Message> & { role: Message["role"] }>(row: T): T & { murageLine: true } {
  return { ...row, murageLine: true };
}

/** Whether a row carries the marker murageLine stamps. */
export function isMurageLine(message: Pick<Message, "murageLine">): boolean {
  return message.murageLine === true;
}
