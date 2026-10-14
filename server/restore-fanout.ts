// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A restore fences a `done` owner send whose transcript line is committed but whose room turns were never
// created. Startup recovery does not fan such a root out: its words come back once as a restore-held chip,
// and only an explicit Send again (with the current restore generation) runs them.
import type { DatabaseSync } from "node:sqlite";

import { markOwnerWordsKept, OWNER_WORDS_KEPT, RESTORE_FANOUT_HELD } from "./room-requests.ts";
import { sendFingerprint } from "./send-idempotency.ts";
import type { SendStore } from "./send-store.ts";

export interface FencedFanoutLine { id: string; role: string; text?: string | null; replyToId?: string | null }

/** Makes the restore-held chip of every fenced root that has none yet. Returns how many chips were made.
 * A root whose chip was made is recorded as kept, so a chip the owner dismissed is never made again. */
export function holdFencedFanouts(db: DatabaseSync, sends: SendStore, linesOf: (threadId: string) => FencedFanoutLine[]): number {
  const rows = db.prepare(`SELECT id, group_id, COALESCE(target_thread_id, root_thread_id) AS thread, result_message_id, to_bot_id AS pin
    FROM room_requests WHERE verb='owner_send' AND state='done' AND outcome_note='${RESTORE_FANOUT_HELD}' AND COALESCE(refusal,'')<>'${OWNER_WORDS_KEPT}' ORDER BY created_at, id`)
    .all() as Array<{ id: string; group_id: string; thread: string; result_message_id: string | null; pin: string | null }>;
  let made = 0;
  for (const row of rows) {
    // Only the thread's last line can be an unanswered message (the same test startup recovery always used).
    const message = linesOf(row.thread).at(-1);
    if (!message || message.id !== row.result_message_id || message.role !== "user" || !message.text) continue;
    try {
      sends.accept({
        kind: "group", ownerId: row.group_id, threadId: row.thread, text: message.text, status: "refused", notice: "refused", queueId: row.id,
        fingerprint: sendFingerprint(message.text, message.replyToId ?? undefined, "chat", row.pin ?? undefined),
        ...(message.replyToId ? { replyToId: message.replyToId } : {}), mode: "chat",
        ...(row.pin ? { responderId: row.pin } : {}), restoreHeld: true,
      });
      markOwnerWordsKept(db, row.id);
      made += 1;
    } catch (error) {
      console.error("could not hold a restored send", error);
    }
  }
  return made;
}
