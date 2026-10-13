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
/** The source alias `s` (a memory_sources row) is denied beyond its own state and tombstones: its place, or (a bring-in copy) an
 * origin named in its current payload is missing, deleted, tombstoned at the cited revision, or in a denied place. */
export const DENIED_SOURCE = (s: string) => `(${DENIED_PLACE(s)} OR (${s}.kind='bring-in' AND EXISTS (
  SELECT 1 FROM memory_source_versions ov, json_each(ov.payload,'$.broughtFrom.sources') oj LEFT JOIN memory_sources o ON o.id=json_extract(oj.value,'$.id')
  WHERE ov.source_id=${s}.id AND ov.revision=${s}.revision AND (o.id IS NULL OR o.state='deleted'
    OR EXISTS (SELECT 1 FROM memory_tombstones ot WHERE ot.target_type='source' AND ot.target_id=o.id AND (ot.revision IS NULL OR ot.revision=json_extract(oj.value,'$.revision')))
    OR ${DENIED_PLACE("o")}))))`;
/** A record alias `r` sits in a denied scope (one seek). */
export const DENIED_RECORD_SCOPE = (r: string) => `(${ANY_DENY} AND EXISTS (SELECT 1 FROM memory_deny dn WHERE dn.kind='scope' AND dn.id=${r}.scope_id))`;

/** Whether the conversation itself was deleted (one seek). */
export function threadDenied(db: DatabaseSync, threadId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=?").get(threadId));
}
/** Whether source `id` is denied by its place or its origins (its own state and tombstones are the caller's test). */
export function sourceDenied(db: DatabaseSync, id: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM memory_sources s WHERE s.id=? AND ${DENIED_SOURCE("s")}`).get(id));
}
