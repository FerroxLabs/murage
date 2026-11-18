// design1019-approval-attention section 5: crash and restart recovery of approval attention.
//
// Owners: design1019-approval-attention owns the specification; the approval-attention builder owns this boot reconciliation
// and its call in server/index.ts. Room requests keep their own boot sweep (reconcileRoomRequestsAtBoot) and project cards keep
// their own transitions (applyCardWaiting); this module only composes them and never decides an answer, a Stop or a run result.
//
// Attention is derived, process-local state: no generation scope, human wait or watchdog request survives a restart. A board
// card left parked on the owner (`waiting/owner_approval`) by a dead process is therefore never live after boot, whatever the
// saved card still says. The one exception is a card whose run request is still open after the room-request sweep (a request
// another boot owner keeps, e.g. a hand-off partner): that owner decides it, so the card is left to it.
import type { DatabaseSync } from "node:sqlite";
import { applyCardWaiting } from "./project-cards.ts";
import { isTerminalRoomRequestState, roomRequest } from "./room-requests.ts";

export const ATTENTION_RESTART_REASON = "This step stopped at a restart";

/** Runs after reconcileRoomRequestsAtBoot and before dispatch opens. Each owner wait a dead process left is moved to the existing
 * restart wait (Retry or Skip), never resumed, answered or reported as a Stop. Idempotent: a repeated pass finds nothing to do.
 * Bounded by the projects' waiting cards: one indexed (group_id, state) seek per project, never the transcript or card history. */
export function reconcileDeadOwnerWaits(db: DatabaseSync, now: number): { repaired: string[] } {
  const repaired: string[] = [];
  const has = (name: string) => Boolean(db.prepare("SELECT 1 AS x FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  if (!has("project_work_items") || !has("project_settings")) return { repaired };
  const groups = db.prepare("SELECT group_id FROM project_settings").all() as Array<{ group_id: string }>;
  const waiting = db.prepare("SELECT id, request_id, waiting_on FROM project_work_items WHERE group_id=? AND state='waiting'");
  for (const { group_id } of groups) {
    for (const row of waiting.all(group_id) as Array<{ id: string; request_id: string | null; waiting_on: string | null }>) {
      let kind: unknown;
      try { kind = row.waiting_on ? (JSON.parse(row.waiting_on) as { kind?: unknown }).kind : undefined; } catch { kind = undefined; }
      if (kind !== "owner_approval") continue;
      // The indexed run record decides, never the saved board card: an open request still has a boot owner.
      const request = row.request_id ? roomRequest(db, row.request_id) : null;
      if (request && !isTerminalRoomRequestState(request.state)) continue;
      const moved = applyCardWaiting(db, { cardId: row.id, actor: { kind: "server" }, waiting: { kind: "restart" }, reason: ATTENTION_RESTART_REASON, now });
      if (moved.ok) repaired.push(row.id);
    }
  }
  return { repaired };
}
