// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// VENUE-POST-1017 Q4 (CROSS-CHAT-READ-1017 section 2): the people other than the owner who can reach a room thread. A venue post is always
// derived from the bot's own chat with the owner, so a room any other person can reach is never postable. Two facts make a person: a bound
// principal on the thread (a channel conversation, threadHumanPrincipal) that is not the workspace owner, and a `granted` person binding on
// the thread's capture scope (the room scope, or the team scope of shared work) or on the room scope of the venue itself. Anything that
// cannot be read fails closed: the answer is ["unknown"], never empty.
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import { threadCaptureScope } from "./memory/capture-scope.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { scopeRow } from "./memory/scope-id.ts";

/** Person ids (or "unknown") who can reach `threadId` of `group`; empty means owner-only. */
export function roomPeople(db: DatabaseSync, group: { id: string }, threadId: string, roster?: MemoryRoster | null): string[] {
  try {
    const people = new Set<string>();
    const principal = threadHumanPrincipal(threadId, db);
    if (!isWorkspaceOwner(principal)) people.add(principal.personId || "unknown");
    const scopes = new Set<string>();
    const room = scopeRow(db, "room", group.id);
    if (room) scopes.add(room.id);
    const capture = threadCaptureScope(threadId, roster, db);
    if (capture.kind !== "conversation") { const row = scopeRow(db, capture.kind, capture.owner); if (row) scopes.add(row.id); }
    if (scopes.size) {
      const rows = db.prepare("SELECT subject_id FROM memory_scope_bindings WHERE subject_type='person' AND state='granted' AND scope_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify([...scopes]));
      for (const row of rows) people.add(String(row.subject_id));
    }
    return [...people];
  } catch {
    return ["unknown"];
  }
}
