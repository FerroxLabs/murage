// Copyright 2026 Ferrox Labs
// Retention follows OpenClaw extensions/whatsapp/src/inbound/durable-receive.ts after 4e5bf66fb18 (MIT, OpenClaw Foundation):
// an early version capped pending rows at 450 with a 30-day TTL, so the 451st accepted message was
// hard-deleted before it was ever dispatched. Pending rows are never pruned; only finished rows are.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ingress journal rules (design 3.4 and 5.5). Pure: the bridge owns the file.

export const JOURNAL_DONE_MAX = 5000;
export const JOURNAL_DONE_TTL_MS = 7 * 24 * 60 * 60_000;
/** At most this many pending rows are held in memory or replayed per connect; the rest stay on disk. */
export const JOURNAL_REPLAY_BATCH = 450;
export const JOURNAL_COMPACT_BYTES = 4 * 1024 * 1024;
export const JOURNAL_RESEND_MS = 30_000;

export interface JournalRow {
  seq: number;
  receivedAt: number;
  remoteJid: string;
  id: string;
  done: boolean;
  doneAt?: number;
  /** The serialised message (BufferJSON form), opaque here. */
  payload?: unknown;
}

/** Done rows older than 7 days go, then done rows beyond the newest 5000. A pending row is never removed. */
export function compactJournal(rows: readonly JournalRow[], nowMs: number, limits: { doneMax?: number; doneTtlMs?: number } = {}): JournalRow[] {
  const doneMax = limits.doneMax ?? JOURNAL_DONE_MAX;
  const doneTtlMs = limits.doneTtlMs ?? JOURNAL_DONE_TTL_MS;
  const fresh = rows.filter((row) => !row.done || nowMs - (row.doneAt ?? row.receivedAt) < doneTtlMs);
  const done = fresh.filter((row) => row.done);
  const drop = new Set<JournalRow>(done.length > doneMax ? done.slice(0, done.length - doneMax) : []);
  return fresh.filter((row) => !drop.has(row));
}

/** Pending rows in arrival order, the first `limit` of them, and whether more are waiting on disk. */
export function pendingBatch(rows: readonly JournalRow[], limit: number = JOURNAL_REPLAY_BATCH): { rows: JournalRow[]; truncated: boolean } {
  const pending = rows.filter((row) => !row.done).sort((a, b) => a.seq - b.seq);
  return { rows: pending.slice(0, limit), truncated: pending.length > limit };
}

export const journalKey = (remoteJid: string, id: string): string => `${remoteJid}\u0000${id}`;

/** True when this message is already in the journal (Baileys can redeliver an upsert). */
export function hasMessage(rows: readonly JournalRow[], remoteJid: string, id: string): boolean {
  const key = journalKey(remoteJid, id);
  return rows.some((row) => journalKey(row.remoteJid, row.id) === key);
}

/** Parses an ndjson journal. A torn last line (a crash mid-write) is ignored; any other malformed line is skipped. */
export function parseJournal(text: string): { rows: JournalRow[]; skipped: number } {
  const rows: JournalRow[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<JournalRow>;
      if (value && typeof value.seq === "number" && Number.isInteger(value.seq) && typeof value.id === "string" && typeof value.remoteJid === "string" && typeof value.receivedAt === "number") {
        rows.push({ seq: value.seq, receivedAt: value.receivedAt, remoteJid: value.remoteJid, id: value.id, done: value.done === true, ...(typeof value.doneAt === "number" ? { doneAt: value.doneAt } : {}), ...(value.payload !== undefined ? { payload: value.payload } : {}) });
      } else skipped++;
    } catch {
      skipped++;
    }
  }
  return { rows, skipped };
}

/**
 * The journal is append-only: a row is rewritten (without its payload) when it is marked done. Later lines
 * for the same `seq` win, but a payload is kept from the earlier line.
 */
export function foldJournal(rows: readonly JournalRow[]): JournalRow[] {
  const bySeq = new Map<number, JournalRow>();
  for (const row of rows) {
    const previous = bySeq.get(row.seq);
    bySeq.set(row.seq, previous ? { ...previous, ...row, payload: row.payload !== undefined ? row.payload : previous.payload } : row);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
