// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The legacy anchor check (LINEAGE-DESIGN-S6 rules 23, 24). A leaf module: memory/deny-read.ts (the door for memory refs) and bot-read.ts
// both use it, and bot-read.ts imports deny-read.ts, so it lives apart from both.
//
// A memory source, or an aggregate citing one, whose anchor message is a Murage-voice row is withheld from a bot viewer. One primary-key
// seek on `messages` plus isMurageVoice on the row's JSON; nothing is scanned or written. Rule 22 means only a source captured before 1.0.3
// can be positive. A positive verdict is memoized per process (rule 2: classification is sticky); a negative one is read again every time.
// Fail closed: an anchor that names a message the check cannot read (no thread, no such row, a row that does not parse) proves nothing
// admissible, so it reads as withheld. Only a source that names no message at all (not a message source) has no anchor to check.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isMurageVoice } from "./murage-voice.ts";

const positive = new WeakMap<DatabaseSync, Set<string>>();
const seeks = new WeakMap<DatabaseSync, StatementSync>();

/** Whether the message a source is anchored at must be withheld from a bot: it classifies as Murage-voice, or it cannot be read (a thread
 * missing beside a message id, no such row, a row that does not parse). A source with no message id is not anchored at a message: false. */
export function murageAnchor(db: DatabaseSync, threadId: string | null | undefined, messageId: string | null | undefined): boolean {
  if (!messageId) return false;
  if (!threadId) return true;
  const key = `${threadId}\u0000${messageId}`;
  const memo = positive.get(db);
  if (memo?.has(key)) return true;
  let seek = seeks.get(db);
  if (!seek) { seek = db.prepare("SELECT json FROM messages WHERE thread_id=? AND id=?"); seeks.set(db, seek); }
  const row = seek.get(threadId, messageId) as { json?: unknown } | undefined;
  // not memoized: a row that arrives later (a restore) is judged on what it is then
  if (!row || typeof row.json !== "string") return true;
  let json: unknown;
  try { json = JSON.parse(row.json); } catch { return true; }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return true;
  if (!isMurageVoice(json)) return false;
  if (memo) memo.add(key); else positive.set(db, new Set([key]));
  return true;
}

/** Whether any cited anchor is Murage-voice or unreadable: one seek per anchor, stopping at the first positive. */
export function anyMurageAnchor(db: DatabaseSync, anchors: Iterable<{ threadId: string | null | undefined; messageId: string | null | undefined }>): boolean {
  for (const anchor of anchors) if (murageAnchor(db, anchor.threadId, anchor.messageId)) return true;
  return false;
}

/** The most primary-key seeks one bare-id anchor check spends; past it the check proves nothing, so the citing text reads as withheld. */
export const ANCHOR_SEEKS_MAX = 8_192;
const SEEK_IN_THREADS = "SELECT m.thread_id AS thread_id, m.id AS id, m.json AS json FROM json_each(?) t CROSS JOIN json_each(?) i CROSS JOIN messages m ON m.thread_id = t.value AND m.id = i.value";

/** Rule 23 for text that cites bare message ids (a project summary): every id is sought by primary key in each thread it may lie in, all in
 * one statement. Withheld (true) when an id is in none of those threads (its anchor is unknown), when a row found is Murage-voice or does not
 * parse, or when the seeks would pass ANCHOR_SEEKS_MAX. The work follows the citations and the threads, never the history. */
export function bareAnchorsWithheld(db: DatabaseSync, threads: Iterable<string>, messageIds: readonly string[]): boolean {
  const ids = [...new Set(messageIds)], places = [...new Set(threads)];
  if (!ids.length) return false;
  if (!places.length || ids.length * places.length > ANCHOR_SEEKS_MAX) return true;
  const rows = db.prepare(SEEK_IN_THREADS).all(JSON.stringify(places), JSON.stringify(ids)) as Array<{ thread_id: string; id: string; json: unknown }>;
  const found = new Set<string>();
  for (const row of rows) {
    const key = `${row.thread_id}\u0000${row.id}`;
    found.add(String(row.id));
    if (positive.get(db)?.has(key)) return true;
    if (typeof row.json !== "string") return true;
    let json: unknown;
    try { json = JSON.parse(row.json); } catch { return true; }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return true;
    if (isMurageVoice(json)) {
      const memo = positive.get(db);
      if (memo) memo.add(key); else positive.set(db, new Set([key]));
      return true;
    }
  }
  return ids.some(id => !found.has(id));
}
