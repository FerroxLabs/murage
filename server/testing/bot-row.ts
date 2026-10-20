// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tests that build a transcript line or an external update need a BotRow (S6 rule 18b). This mints one the way the owner's routes read a
// row: through the door with the human viewer, which sees every row as stored.
import type { DatabaseSync } from "node:sqlite";
import { botRows, type BotRow } from "../bot-read.ts";
import type { Message } from "../store.ts";

/** The door's BotRow for a row as stored (the human viewer reads no database). */
export function humanRow(row: Partial<Message> & { id: string }): BotRow {
  const message = { role: "user", kind: "text", text: "", at: 0, ...row } as Message;
  return botRows(undefined as unknown as DatabaseSync, { kind: "human" }, "test", [message])[0]!;
}

/** A transcript line's door row, for a test literal: `{ role, text, source: lineSource(text) }`. */
export const lineSource = (text: string, id = "line"): BotRow => humanRow({ id, text });

/** Test literals given their door rows: each line or update gains `source`, minted from its own words. */
export function sourced<T extends { text: string; id?: string }>(rows: readonly T[]): Array<T & { source: BotRow }> {
  return rows.map((row, i) => ({ ...row, source: lineSource(row.text, row.id ?? `line-${i}`) }));
}
