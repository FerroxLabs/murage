// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a limit line goes in a thread. Never replaces a row that has text with empty text.
import type { Message } from "./store.ts";
import { murageLine } from "./murage-line.ts";

export interface LimitLineStore {
  scanNewest(threadId: string, visit: (message: Message) => boolean, limit?: number): boolean;
  patchMessage(threadId: string, id: string, patch: Partial<Message>): unknown;
  appendMessage(threadId: string, message: Message): unknown;
}

/** The plain limit line goes where the engine's own refusal text sits in the thread: that text is the engine's, never the bot's answer.
 * The row keeps non-empty text (the line itself): a row that has text is never emptied, on any path. No such row (the engine refused
 * without relaying text): the line is appended. */
export function putLimitLineInto(store: LimitLineStore, threadId: string, turn: { textActivity?: boolean; text?: string } | undefined, line: string): void {
  const raw = turn?.textActivity ? (turn.text ?? "").trim() : "";
  let rawId: string | undefined;
  if (raw) store.scanNewest(threadId, (message) => {
    if (message.role === "bot" && message.kind === "text" && typeof message.text === "string" && message.text.trim() === raw) { rawId = message.id; return true; }
    return false;
  }, 40);
  const tool = { name: line, ok: false };
  if (rawId && line.trim() && store.patchMessage(threadId, rawId, { kind: "activity", text: line, tool })) return;
  store.appendMessage(threadId, murageLine({ role: "bot", kind: "activity", tool }) as Message);
}
