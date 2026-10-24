// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place a memory record is written. Every row goes through
// `redactSecretsInText`, which keeps credentials out and masks bank, card,
// account and personal id numbers (shared/financial-ids.ts), whatever the
// caller built the text from: a raw payload excerpt (a checkpoint), a copy of
// an older record that was never scrubbed (promote, scope copy, a stance
// counter), or a chunk a worker cut from a payload it leased before the scrub
// rewrote it. The mask keeps the byte length, so evidence spans over the text
// stay valid. record-write.test.ts holds the guard that no other file in
// server/ spells the insert.
import type { DatabaseSync, StatementResultingChanges } from "node:sqlite";
import { redactSecretsInText } from "../redact.ts";

export interface MemoryRecordRow {
  id: string;
  version: number;
  scopeId: string;
  kind: string;
  text: string;
  assertion: string;
  state: "candidate" | "active" | "superseded" | "archived" | "deleted";
  ownerPinned?: number;
  validFrom: number;
  validTo?: number | null;
  supersedesId?: string | null;
  createdAt: number;
}

/** Insert one memory record with its text redacted. `orIgnore` keeps the
 * callers that relied on INSERT OR IGNORE (a chunk published twice, a
 * candidate proposed twice) as they were. */
export function insertMemoryRecord(db: DatabaseSync, row: MemoryRecordRow, options: { orIgnore?: boolean } = {}): StatementResultingChanges {
  const verb = options.orIgnore ? "INSERT OR IGNORE" : "INSERT";
  return db.prepare(`${verb} INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.version, row.scopeId, row.kind, redactSecretsInText(row.text), row.assertion, row.state,
    row.ownerPinned ?? 0, row.validFrom, row.validTo ?? null, row.supersedesId ?? null, row.createdAt,
  );
}
