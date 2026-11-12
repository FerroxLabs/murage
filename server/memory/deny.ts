// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The deny facts a forget, a deleted conversation or a deleted bot writes in its own commit, as the one predicate every
// engine-facing reader applies (1.0.2 revoke-bounded r3). A source is denied from the commit on when it is deleted or tombstoned
// (each reader keeps its own revision rule for those), when its conversation or its bot's scope has a memory_deny row, or when it
// is a bring-in copy brought from a source that is gone, tombstoned or denied (one level, the forget half of
// applyMemoryTombstones' rule). A record in a denied scope is refused the same way. Every term is a primary-key seek, so no reader's cost follows how
// much was ever forgotten; the durable job (memory-revocation.ts) only brings the stored states into line afterwards.
// Offline-safe: no runtime imports.
import type { DatabaseSync } from "node:sqlite";

/** Whether any conversation or bot was ever deleted: an uncorrelated probe SQLite evaluates once per statement, so a file with no
 * deny row pays nothing per row for the seeks below. */
const ANY_DENY = "EXISTS (SELECT 1 FROM memory_deny)";
/** The conversation or scope of source alias `s` is denied (two primary-key seeks). */
export const DENIED_PLACE = (s: string) =>
  `(${ANY_DENY} AND (EXISTS (SELECT 1 FROM memory_deny dn WHERE dn.kind='thread' AND dn.id=${s}.thread_id) OR EXISTS (SELECT 1 FROM memory_deny dn WHERE dn.kind='scope' AND dn.id=${s}.scope_id)))`;
/** A branch change of the source's conversation is still being flipped in slices (memory/branch-change.ts): until it finishes, a source of
 * that conversation may still be 'active' on a branch the owner left, so every reader withholds it (rc3f). One uncorrelated probe, so an
 * empty branch_change costs nothing per row, then one primary-key seek on thread_id: the cost never follows the history's size. */
export const BRANCH_CHANGE_PENDING = (s: string) =>
  `(EXISTS (SELECT 1 FROM branch_change) AND EXISTS (SELECT 1 FROM branch_change bc WHERE bc.thread_id=${s}.thread_id))`;
/** The source alias `s` (a memory_sources row) is denied beyond its own state and tombstones: its place, or (a bring-in copy) an
 * origin named in its current payload is missing, deleted, tombstoned at the cited revision, or in a denied place. */
export const DENIED_SOURCE = (s: string) => `(${DENIED_PLACE(s)} OR ${BRANCH_CHANGE_PENDING(s)} OR (${s}.kind='bring-in' AND EXISTS (
  SELECT 1 FROM memory_source_versions ov, json_each(ov.payload,'$.broughtFrom.sources') oj LEFT JOIN memory_sources o ON o.id=json_extract(oj.value,'$.id')
  WHERE ov.source_id=${s}.id AND ov.revision=${s}.revision AND (o.id IS NULL OR o.state='deleted'
    OR EXISTS (SELECT 1 FROM memory_tombstones ot WHERE ot.target_type='source' AND ot.target_id=o.id AND (ot.revision IS NULL OR ot.revision=json_extract(oj.value,'$.revision')))
    OR ${DENIED_PLACE("o")}))))`;
/** A record alias `r` sits in a denied scope (one seek). */
export const DENIED_RECORD_SCOPE = (r: string) => `(${ANY_DENY} AND EXISTS (SELECT 1 FROM memory_deny dn WHERE dn.kind='scope' AND dn.id=${r}.scope_id))`;

/** Whether the owner excluded the conversation from memory: the list saved by memory settings, read from what is committed. */
export function threadExcluded(db: DatabaseSync, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings' AND e.value=? LIMIT 1").get(threadId));
}
/** Whether the conversation itself was deleted (one seek). */
export function threadDenied(db: DatabaseSync, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(threadId));
}
/** A deleted conversation or the reader's deleted bot ends that reader's authority, even while its cached roster still exists.
 * Share the foreground thread check's one statement; no per-record query is added to a long session's validation. */
export function memoryReaderDenied(db: DatabaseSync, threadId: string, botId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?
    UNION ALL SELECT 1 FROM memory_scopes s JOIN memory_deny d ON d.kind='scope' AND d.id=s.id
    WHERE s.kind='bot' AND s.owner_key=? LIMIT 1`).get(threadId, botId));
}
/** Whether source `id` is denied by its place or its origins (its own state and tombstones are the caller's test). */
export function sourceDenied(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_sources s WHERE s.id=? AND ${DENIED_SOURCE("s")}`).get(id));
}

/** Background work keeps a conservative publication fence across conversation and bot deletions.
 * This durable counter is deliberately separate from the foreground authority epoch.
 * One primary-key lookup, independent of the number of deleted conversations or bots. */
export function learningDeletionEpoch(db: DatabaseSync): number {
  return Number(db.prepare("SELECT deletion_epoch + COALESCE((SELECT revision FROM memory_scope_bindings WHERE id='thread-deletion-clock'),0) AS epoch FROM memory_meta WHERE id=1").get()!.epoch);
}
export function noteThreadDeletion(db: DatabaseSync): void {
  // Prefer the roster's workspace (one key lookup). Offline/empty files may have
  // no roster yet; a private bookkeeping scope keeps this counter out of bot deletion.
  let scope = db.prepare("SELECT scope_id FROM memory_scope_bindings WHERE id='memory-roster-policy'").get()?.scope_id;
  if (!scope) {
    scope = "system:thread-deletion-clock";
    db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES(?,'workspace','system:thread-deletion-clock','[]',0)").run(scope);
  }
  db.prepare("INSERT INTO memory_scope_bindings(id,scope_id,subject_type,subject_id,revision,state,intent) VALUES('thread-deletion-clock',?,'system','thread-deletion-clock',1,'granted','{}') ON CONFLICT(id) DO UPDATE SET revision=revision+1").run(scope);
}
