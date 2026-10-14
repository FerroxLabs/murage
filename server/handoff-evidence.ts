// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Evidence that the provider ran a hand-off's turn, recorded WHEN THE ENGINE'S REPLY IS WRITTEN, in the same transaction as the reply.
//
// A hand-off whose turn was handed to the provider and then cut short (a crash, a lost connection) is held for the owner unless something shows the provider
// ran it. What shows it is a message written WITH A PROVIDER REPLY: the marker that only server/provider-reply.ts can make, handed to the store by the one
// fold that saw the engine's own event (index.ts foldRuntimeEvent). A turn id on the stored row proves nothing (Murage stamps one on its own error and status
// lines too), so no property of the row is consulted. The reply must also answer the hand-off's prompt: its parent chain leads back to the `dlg-<id>` prompt
// without crossing another owner message. That is decided once, here, as the message is stored, and recorded on the hand-off's own row
// (`pending_delegations.evidence_at`). Nothing is inferred later from row order or from timestamps.
import type { DatabaseSync } from "node:sqlite";
import { isProviderReply, type ProviderReply } from "./provider-reply.ts";

/** How many links of a reply's parent chain are followed looking for the hand-off's prompt. */
export const HANDOFF_EVIDENCE_ROWS = 64;
const PROMPT_PREFIX = "dlg-";

interface Written {
  id: string;
  role: string;
  turnId?: string;
  parentId?: string | null;
}

/** Called for every message as it is written, with the provider reply the fold minted for it (none for a line Murage wrote). Cheap for everything that is not a
 * provider reply: no marker, or a marker for another thread or turn, ends it before any query. */
export function noteHandoffEvidence(db: DatabaseSync, threadId: string, message: Written, reply?: ProviderReply): void {
  // a marker that was not minted by server/provider-reply.ts (a cast, a lookalike) is a bug in the caller, not an absent proof: it throws, and the write rolls back
  if (reply !== undefined && !isProviderReply(reply)) throw new Error("PROVIDER_REPLY_FORGED: the value handed to the store is not a provider reply the fold minted");
  if (reply === undefined || reply.threadId !== threadId || !message.turnId || reply.turnId !== message.turnId || message.role !== "bot") return;
  let link = typeof message.parentId === "string" ? message.parentId : null;
  if (link === null) return;
  const read = db.prepare("SELECT role, json_extract(json, '$.parentId') AS parent, json_extract(json, '$.turnId') AS turn, json_extract(json, '$.provenance') AS provenance FROM messages WHERE thread_id=? AND id=?");
  for (let step = 0; step < HANDOFF_EVIDENCE_ROWS && link !== null; step++) {
    if (link.startsWith(PROMPT_PREFIX)) { markEvidence(db, threadId, link); return; }
    const row = read.get(threadId, link) as { role: string; parent: string | null; turn: string | null; provenance: string | null } | undefined;
    if (!row || row.role === "user") return;              // another owner message ends the turn's window
    // an earlier PROVIDER line of this very turn already decided (a line Murage wrote in the same turn, an error or a wait chip, decided nothing: the walk goes on past it).
    // (The mark can only end the walk early, never grant evidence: a forged mark costs the hand-off its proof, which holds it for the owner.)
    if (row.turn === message.turnId && row.provenance === "provider") return;
    link = typeof row.parent === "string" ? row.parent : null;
  }
}

function markEvidence(db: DatabaseSync, threadId: string, turnKey: string): void {
  try {
    const now = Date.now();
    const id = turnKey.slice(PROMPT_PREFIX.length);
    // the usual key is `dlg-<id>`: the row is found by its primary key. A hand-off whose id is not a legal message id has its key hashed, so no row has that id:
    // only then is the key column searched.
    if (db.prepare("SELECT 1 AS x FROM pending_delegations WHERE id=?").get(id) !== undefined) {
      db.prepare("UPDATE pending_delegations SET evidence_at=? WHERE id=? AND turn_key=? AND target_thread_id=? AND phase='started' AND evidence_at IS NULL").run(now, id, turnKey, threadId);
    } else {
      db.prepare("UPDATE pending_delegations SET evidence_at=? WHERE turn_key=? AND target_thread_id=? AND phase='started' AND evidence_at IS NULL").run(now, turnKey, threadId);
    }
  } catch (error) {
    // a database without the hand-off table (a fixture, a restore in progress) has nothing to record; anything else is a real failure and must not be hidden
    if (!/no such (table|column)/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
}
