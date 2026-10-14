// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DatabaseSync } from "node:sqlite";

import { promptRows } from "./external-context-delivery.ts";
import { partitionTranscriptMessages } from "./partition-sources.ts";
import type { Message } from "./store.ts";

/** Just the read side of a message map: quote targets are looked up one id at a time. */
export type MessageLookup = { get(id: string): Message | undefined };

/** The quote targets of a turn: every message of the thread that the prompt may
 * show, resolved one id at a time through an indexed read. The partition and
 * prompt-row rules are per message, so a lookup answers exactly what a Map built
 * from the whole filtered thread would, without materialising a long thread a
 * second time for the few quotes a replay carries. */
export function promptQuoteTargets(
  store: { messageById(threadId: string, id: string): Message | undefined },
  db: DatabaseSync,
  botId: string,
  threadId: string,
  hasTools: boolean,
  pending: readonly string[] = [],
): MessageLookup {
  const memo = new Map<string, Message | undefined>();
  return {
    get(id: string) {
      if (memo.has(id)) return memo.get(id);
      const stored = store.messageById(threadId, id);
      const visible = stored ? promptRows(partitionTranscriptMessages(db, botId, threadId, [stored]), hasTools, pending)[0] : undefined;
      memo.set(id, visible);
      return visible;
    },
  };
}
