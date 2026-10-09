// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Recall reads the word index straight from the main process (PROPOSAL-v2 10.2,
// AUDIT M7). Until now every search went through the helper's one queue, behind
// whatever capture or index batch it was running, and missed its 500 ms budget
// whenever a backlog was draining (5 of 8 searches in the evidence run).
//
// One persistent read-only handle to memory-index.db. MATCH first, ordered by rank
// and cut to a page, restricted to the caller's scopes through the entries table
// (a primary-key probe per ranked hit, so the cursor still stops at the limit). The
// caller then checks each hit against the authoritative tables: current state, access
// scope, identity, audience and withheld sources, exactly as before. The reader never
// writes, never holds a read transaction between calls (statements run to completion),
// and gives up after a short busy wait instead of holding the thread.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DATA_DIR } from "../config.ts";
import type { IndexHit } from "./index.ts";
import { logSwallowed } from "./worker-log.ts";

/** Most words of a query that take part in the MATCH. */
export const RECALL_TERM_LIMIT = 8;
/** First page of ranked hits, and the most one search reads in all. */
export const RECALL_FIRST_PAGE = 50;
export const RECALL_MAX_HITS = 200;
const BUSY_MS = 50;

export type LexicalPage = { hits: IndexHit[]; more: boolean };
export type IndexReaderState = "ready" | "missing" | "unreadable" | "blocked";

interface Open { path: string; ino: number; dev: number; db: DatabaseSync; statement: StatementSync }
let open: Open | null = null;
let blocked = false;
let lastState: IndexReaderState = "missing";

export const RECALL_SEARCH_SQL = `SELECT l.id AS id,l.version AS version FROM lexical l JOIN entries e ON e.id=l.id AND e.version=CAST(l.version AS INTEGER)
  WHERE l.lexical MATCH ?1 AND e.scope_id IN (SELECT value FROM json_each(?2)) ORDER BY l.rank LIMIT ?3 OFFSET ?4`;

function indexPath() { return join(DATA_DIR, "memory-index.db"); }

export function memoryIndexTerms(query: string): string[] {
  return [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])].slice(0, RECALL_TERM_LIMIT);
}

/** While the helper is starting (it may rebuild or rename a damaged index) the main process holds no handle. */
export function blockMemoryIndexReader(): void { blocked = true; closeMemoryIndexReader(); }
export function unblockMemoryIndexReader(): void { blocked = false; }
export function closeMemoryIndexReader(): void {
  const current = open; open = null;
  try { current?.db.close(); } catch { /* idempotent */ }
}
export function memoryIndexReaderState(): IndexReaderState { return lastState; }

function handle(): Open | null {
  if (blocked) { lastState = "blocked"; return null; }
  const path = indexPath();
  let stat;
  try { stat = statSync(path); } catch { closeMemoryIndexReader(); lastState = "missing"; logSwallowed("recall", "MEMORY_INDEX_MISSING"); return null; }
  if (open && open.path === path && open.ino === stat.ino && open.dev === stat.dev) return open;
  closeMemoryIndexReader();
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
    // A file the helper has not finished creating has no word table yet.
    db.prepare("SELECT 1 FROM entries LIMIT 1").get();
    open = { path, ino: stat.ino, dev: stat.dev, db, statement: db.prepare(RECALL_SEARCH_SQL) };
    lastState = "ready";
    return open;
  } catch (error) {
    lastState = existsSync(path) ? "unreadable" : "missing";
    logSwallowed("recall", error);
    return null;
  }
}

/** Ranked word hits for the scopes, or null when the index cannot be read (the caller falls back to the helper). */
export function lexicalPage(query: string, scopeIds: readonly string[], limit: number, offset = 0): LexicalPage | null {
  const terms = memoryIndexTerms(query);
  if (!terms.length) return { hits: [], more: false };
  const current = handle();
  if (!current) return null;
  const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" OR ");
  try {
    const rows = current.statement.all(expression, JSON.stringify(scopeIds), limit + 1, offset);
    const more = rows.length > limit;
    const hits = rows.slice(0, limit).map((row, index) => ({ id: String(row.id), version: Number(row.version), score: 1 / (60 + offset + index + 1), lexical: true as const }));
    return { hits, more };
  } catch (error) {
    // A damaged or half-built index: drop the handle so the next call reopens, and let the helper path answer.
    closeMemoryIndexReader();
    lastState = "unreadable";
    logSwallowed("recall", error);
    return null;
  }
}
