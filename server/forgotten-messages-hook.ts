// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1023-cleanfix: what the app does when forgotten material turns out to come from messages (memory-revocation.ts forgottenMessages,
// inside the Forget's commit or the job step that ends more of its sources). One body for every process that finishes Forget work:
// the app's runner (server/index.ts) and the one-time clean-up command (server/memory-reset-hidden-rules.ts).
// Owner of this module: q1023-cleanfix. Owners of its steps: project-tables.ts markProjectDerivedStale (project lanes),
// harness/event-log.ts recordEventLogForget (event-log lane). Owner of the hook slot: memory-revocation.ts (revoke marker lanes).
import type { DatabaseSync } from "node:sqlite";
import { recordEventLogForget } from "./harness/event-log.ts";
import type { ForgottenMessagesHook } from "./memory/memory-revocation.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { projectMessagePlaces } from "./project-memory-tools.ts";
import { markProjectDerivedStale } from "./project-tables.ts";

/** What the hook reads besides the store's tables: the roster (which project holds a thread) and when a message was written. */
export interface ForgottenMessagesContext {
  roster(): MemoryRoster;
  /** When a message was written, by its key; undefined when it is no longer in its thread. */
  messageAt(db: DatabaseSync, threadId: string, messageId: string): number | undefined;
}

/** The hook the app registers (forget.ts onMemoryMessagesForgotten): derived project text citing the messages goes stale (SPEC-P 15.3), and
 * the messages leave the event log too: the lines of their turn and any line carrying their text. The record that they must go commits
 * with the forget; the rewrite is a streamed background job that resumes after a crash, and until it finishes the Inspector serves none of
 * the thread's lines (harness/event-log.ts). */
export function forgottenMessagesHook(context: ForgottenMessagesContext): ForgottenMessagesHook {
  return (db, messageIds, threadOf) => {
    const places = projectMessagePlaces(db, { roster: context.roster(), messageAt: (thread, id) => context.messageAt(db, thread, id), messageIds, threadOf });
    markProjectDerivedStale(db, messageIds, messageId => places.get(messageId));
    recordEventLogForget(db, messageIds);
  };
}
