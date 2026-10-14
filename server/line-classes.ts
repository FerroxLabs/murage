// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which classes of the line index (branch-index.ts) a stored message belongs to.
// The same rules run at write time and in the thread fill, so the index is the
// same however a row got there.
import { ACTION_CLASS_NAMES, LINE_ACTION_BASE, LINE_DELEGATION, LINE_BOT_EMPTY, LINE_OWNER, LINE_REQUEST_CARD, LINE_TEXT } from "./branch-index.ts";
import { rowActions } from "./reply-action-guard.ts";
import type { Message } from "./store.ts";

/** A row that starts a fresh request from the owner (reply-action-guard isOwnerRow). */
export const isOwnerLine = (m: { role?: unknown; murage?: unknown; actorKind?: unknown }): boolean =>
  m.role === "user" && !m.murage && m.actorKind !== "murage" && m.actorKind !== "routine";

/** The classes of one row, from its whole JSON. */
export function lineClassesOf(message: Message): number[] {
  const out: number[] = [];
  if (message.kind === "text" && typeof message.text === "string" && message.text !== "") out.push(LINE_TEXT);
  else if (isOwnerLine(message)) out.push(LINE_OWNER);
  if (message.role === "bot" && message.kind === "text" && !message.copyOf && !message.text) out.push(LINE_BOT_EMPTY);
  if (message.copyOf?.threadId || message.comm?.groupId) out.push(LINE_DELEGATION);
  if (typeof message.card?.requestId === "string" && message.card.requestId !== "") out.push(LINE_REQUEST_CARD);
  if (message.role === "bot" && (message.kind === "activity" || message.comm || message.artifactIds?.length || message.tool?.imageRecord)) {
    const found = new Set<string>();
    const evidence = rowActions(message);
    for (const operation of evidence.operations?.length ? evidence.operations : [evidence]) if (operation.outcome === "completed") for (const cls of operation.classes) found.add(cls);
    ACTION_CLASS_NAMES.forEach((name, i) => { if (found.has(name)) out.push(LINE_ACTION_BASE + i); });
  }
  return out;
}

/** The classes of a row from the columns the fill reads and, for the rows that can be more than a line, its JSON. */
export function lineClassesOfFillRow(row: { role: string; kind: string; text: string | null; body: string | null }): number[] {
  if (row.body !== null) {
    let parsed: Message;
    try { parsed = JSON.parse(row.body) as Message; } catch { return row.kind === "text" && row.text ? [LINE_TEXT] : []; }
    // the text column is the one every other reader of a line trusts (it is written with the row)
    return lineClassesOf({ ...parsed, kind: row.kind as Message["kind"], text: row.text ?? undefined });
  }
  const out: number[] = [];
  if (row.kind === "text" && typeof row.text === "string" && row.text !== "") out.push(LINE_TEXT);
  if (row.role === "bot" && row.kind === "text" && !row.text) out.push(LINE_BOT_EMPTY); // a copy carries its original's thread in JSON, and so has a body
  return out;
}
