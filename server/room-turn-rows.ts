// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rows a room member turn reads. A room can hold hundreds of thousands of
// messages; a member's prompt shows the newest thirty text lines, the pinned
// line and the lines those quote. The turn reads exactly those: the newest text
// lines from the line index (whatever lies between them), the pin and the quoted
// lines by id: the same statements and rows for a room of a thousand messages as
// for one of two hundred thousand.
import { promptRows } from "./external-context-delivery.ts";
import { GROUP_CONTEXT_MESSAGES, roomContextMessages } from "./room-context.ts";
import type { Message } from "./store.ts";

export interface RoomRowsStore {
  /** The newest `limit` text lines of the thread (kind "text" with words), oldest first, from the line index. */
  newestTextLines(threadId: string, limit: number): Message[];
  messageById(threadId: string, messageId: string): Message | undefined;
}

export interface RoomRowsRead {
  /** Oldest first: any older pinned/quoted lines, then the newest text lines. */
  rows: Message[];
  /** Older rows exist that were not read (uncounted). */
  more: boolean;
  /** How many of `rows` are older lines fetched by id. */
  extras: number;
  /** The same read for a wider window of `lines` text lines (a filtered transcript that drops lines widens until it is full). */
  widen(lines: number): RoomRowsRead;
}

/** The rows a member prompt can show: the newest `lines` text lines (30 by default), the pin, and every line the window or
 * the pin quotes, each fetched by id when it is older. Exactly the lines a read of the whole room would have kept, found
 * by the line index: a tool-heavy stretch between two conversations hides nothing, and the work is the window. */
export function readRoomTurnRows(store: RoomRowsStore, threadId: string, pinnedMessageId: string | undefined, lines = GROUP_CONTEXT_MESSAGES): RoomRowsRead {
  const window = store.newestTextLines(threadId, lines);
  const have = new Set(window.map((m) => m.id));
  const older: Message[] = [];
  const fetch = (id: string | undefined): Message | undefined => {
    if (!id) return undefined;
    if (have.has(id)) return window.find((m) => m.id === id);
    const row = store.messageById(threadId, id);
    if (row) { have.add(id); older.push(row); }
    return row;
  };
  const pin = fetch(pinnedMessageId);
  // the pin is shown when it is a line with words, and what it quotes with it
  if (pin && pin.kind === "text" && pin.text) fetch(pin.replyToId);
  for (const m of roomContextMessages(window, Math.max(lines, GROUP_CONTEXT_MESSAGES))) fetch(m.replyToId);
  return { rows: [...older, ...window], more: window.length >= lines, extras: older.length, widen: (wider) => readRoomTurnRows(store, threadId, pinnedMessageId, wider) };
}

/** Whether this route holds a room row back from its prompt (promptRows), so
 * recall must not hand it back either: judged from the rows read, and for a
 * row older than them from the row itself, looked up by id when recall names
 * it. Exactly the rows the whole room would have held back. */
export function roomHeldLookup(store: RoomRowsStore, threadId: string, read: RoomRowsRead, hasTools: boolean): { held: (messageId: string) => boolean; heldIds: Set<string> } {
  const promptIds = new Set(promptRows(read.rows, hasTools).map((row) => row.id));
  const readIds = new Set(read.rows.map((row) => row.id));
  const heldIds = new Set(read.rows.filter((row) => !promptIds.has(row.id)).map((row) => row.id));
  const older = new Map<string, boolean>();
  const held = (messageId: string): boolean => {
    if (heldIds.has(messageId)) return true;
    if (!read.more || readIds.has(messageId)) return false;
    let verdict = older.get(messageId);
    if (verdict === undefined) {
      const row = store.messageById(threadId, messageId);
      verdict = Boolean(row) && promptRows([row!], hasTools).length === 0;
      older.set(messageId, verdict);
    }
    return verdict;
  };
  return { held, heldIds };
}
