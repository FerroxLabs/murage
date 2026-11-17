// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place a memory record is written. Every row goes through
// `redactSecretsInText`, which keeps credentials out and masks bank, card,
// account and personal id numbers (shared/financial-ids.ts), whatever the
// caller built the text from: a raw payload excerpt (a checkpoint), a copy of
// an older record that was never scrubbed (promote, scope copy, a stance
// counter), or a chunk a worker cut from a payload it leased before the scrub
// rewrote it. Evidence spans refer to source versions, not the derived display
// text (whole-text masks may change its length). record-write.test.ts holds the guard that no other file in
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

/** Reveal records are JSON with authoritative identity/control fields. Scrub
 * the original note before encoding; running extent-A on encoded JSON would
 * swallow its closing quote and change the record's meaning. */
export function safeMemoryRecordText(kind: string, text: string): string {
  if (kind !== "reveal-state") return redactSecretsInText(text);
  if (text.length > 256 * 1024) return "«redacted»";
  try {
    const value = JSON.parse(text);
    if (!value || typeof value.canonId !== "string" || value.audience !== "owner-private" || typeof value.revealed !== "boolean" || typeof value.note !== "string") return "«redacted»";
    return JSON.stringify({ canonId: value.canonId,
      ...(Number.isSafeInteger(value.canonVersion) && value.canonVersion > 0 ? { canonVersion: value.canonVersion } : {}),
      audience: value.audience, revealed: value.revealed, note: redactSecretsInText(value.note) });
  } catch { return "«redacted»"; }
}

/** Insert one memory record with its text redacted. `orIgnore` keeps the
 * callers that relied on INSERT OR IGNORE (a chunk published twice, a
 * candidate proposed twice) as they were. */
export function insertMemoryRecord(db: DatabaseSync, row: MemoryRecordRow, options: { orIgnore?: boolean } = {}): StatementResultingChanges {
  const verb = options.orIgnore ? "INSERT OR IGNORE" : "INSERT";
  return db.prepare(`${verb} INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.version, row.scopeId, row.kind, safeMemoryRecordText(row.kind, row.text), row.assertion, row.state,
    row.ownerPinned ?? 0, row.validFrom, row.validTo ?? null, row.supersedesId ?? null, row.createdAt,
  );
}
