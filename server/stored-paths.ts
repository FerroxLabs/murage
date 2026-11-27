// S5: one lexical rule for stored paths on the server and desktop. No stored path is read or followed.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./config.ts";
import { dataRoots } from "./data-roots.ts";
import { lexicalKey as key, rebaseStoredPath as rebase } from "../shared/stored-root-path.mjs";
export type { RebaseResult, Constructors } from "../shared/stored-root-path.mjs";
import type { RebaseResult, Constructors } from "../shared/stored-root-path.mjs";
export interface RebaseContext { dataDir?: string; previous?: string[]; platform?: NodeJS.Platform }
export function lexicalKey(path: string, platform: NodeJS.Platform = process.platform): string | undefined { return key(path, platform); }
/** A boot-time rebase is done once per rebase input (data dir, recorded previous roots, platform): the one marker row per pass in
 * transcript_index_state names this key and carries the rowid high-water it covered, so a later start reads only rows written after
 * it, and a new previous root (another move or restore) reads every row again. */
export function rebaseInputKey(): string {
  return createHash("sha256").update(JSON.stringify([DATA_DIR, dataRoots().previousRoots(), process.platform])).digest("hex").slice(0, 32);
}
/** The row holding a pass's high-water rowid, as a hash of its natural key (-1: no row there). messages and artifacts have no INTEGER
 * PRIMARY KEY, so a rowid at or below the high-water can be given to a new row (the top row deleted, a VACUUM): the high-water is
 * trusted only while the same row still holds it, otherwise the pass reads every row again. */
function highWaterRow(db: DatabaseSync, table: "messages" | "artifacts", rowid: number): number {
  const row = db.prepare(table === "messages" ? "SELECT thread_id || char(0) || id AS k FROM messages WHERE rowid=?" : "SELECT id AS k FROM artifacts WHERE rowid=?").get(rowid) as { k: string } | undefined;
  return row ? parseInt(createHash("sha256").update(String(row.k)).digest("hex").slice(0, 12), 16) : -1;
}
/** The rowid a pass may start after: its high-water when the marker names this key and the same row still holds it, else 0 (read everything). */
export function rebaseStart(db: DatabaseSync, pass: string, key: string, table: "messages" | "artifacts"): number {
  const row = db.prepare("SELECT cursor, skipped FROM transcript_index_state WHERE name=?").get(`rebase_roots:${pass}:${key}`) as { cursor: number; skipped: number } | undefined;
  if (!row || !(Number(row.cursor) > 0)) return 0;
  return highWaterRow(db, table, Number(row.cursor)) === Number(row.skipped) ? Number(row.cursor) : 0;
}
/** Written in the pass's own transaction, after its updates: an older key's marker goes, so a return to it reads every row again. The
 * marker's skipped column holds the high-water row's identity (highWaterRow). */
export function rebaseDone(db: DatabaseSync, pass: string, key: string, through: number, table: "messages" | "artifacts"): void {
  db.prepare("DELETE FROM transcript_index_state WHERE name LIKE ? AND name<>?").run(`rebase_roots:${pass}:%`, `rebase_roots:${pass}:${key}`);
  db.prepare("INSERT OR REPLACE INTO transcript_index_state(name, done, cursor, skipped) VALUES (?, 1, ?, ?)").run(`rebase_roots:${pass}:${key}`, through, through > 0 ? highWaterRow(db, table, through) : 0);
}
export function rebaseStoredPath(stored: string, constructors: Constructors, context: RebaseContext = {}): RebaseResult {
  return rebase(stored, constructors, { dataDir: context.dataDir ?? DATA_DIR, previous: context.previous ?? dataRoots().previousRoots(), platform: context.platform ?? process.platform });
}
