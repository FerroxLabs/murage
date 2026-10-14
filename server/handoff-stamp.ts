// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the transcript store knows about a hand-off's prompt, and the one thing it asks of its write: a hand-off's prompt (`dlg-<id>`) may only be written in the
// SAME transaction that moves the hand-off's row to `started`, and that is checked in the database, in that transaction, not by who made the callback. There is
// no stamp to register and nothing to forge: a write of a prompt id that did not start its row rolls back. A leaf module, so the store can ask without
// importing the dispatcher.
import type { DatabaseSync } from "node:sqlite";

/** The prefix of a hand-off prompt's message id (pending-delegations-schema.ts delegationTurnKey). */
export const HANDOFF_PROMPT_PREFIX = "dlg-";
export function isHandoffPromptId(id: string | undefined): boolean { return typeof id === "string" && id.startsWith(HANDOFF_PROMPT_PREFIX); }

/** The phase of the hand-off row a prompt id belongs to (by its primary key when the key is `dlg-<id>`, else by the key column), or null when there is none. */
export function handoffPhaseOfPrompt(db: DatabaseSync, promptId: string): string | null {
  const id = promptId.slice(HANDOFF_PROMPT_PREFIX.length);
  const byId = db.prepare("SELECT phase FROM pending_delegations WHERE id=? AND turn_key=?").get(id, promptId) as { phase: string } | undefined;
  if (byId) return byId.phase;
  const byKey = db.prepare("SELECT phase FROM pending_delegations WHERE turn_key=?").get(promptId) as { phase: string } | undefined;
  return byKey?.phase ?? null;
}

/** Wraps a write's `within` so that, inside the write's own transaction and after `within` ran, the prompt's hand-off row went from not started to started. */
export function guardHandoffPrompt(db: () => DatabaseSync, promptId: string, within: (() => void) | undefined): () => void {
  return () => {
    const before = handoffPhaseOfPrompt(db(), promptId);
    within?.();
    if (before === null || before === "started" || handoffPhaseOfPrompt(db(), promptId) !== "started") {
      throw Object.assign(new Error("HANDOFF_PROMPT_REFUSED: a hand-off's prompt is written only in the transaction that starts the hand-off"), { code: "HANDOFF_PROMPT_REFUSED" });
    }
  };
}
