// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// W (email design r9 3.6 step 2): before a seal completes, the managed media a sealed conversation names moves into sealed file
// custody: a durable copy (write, fsync, rename), a hash and length check of the copy as stored, a ledger row (mailbox_sealed_media)
// committed after that check, and only then the generic file's removal. A file another conversation or a bot avatar still names keeps
// its generic copy (it is that conversation's too); the sealed copy is the sealed conversation's. Each call walks at most one page of
// sealed rows by rowid and saves its cursor, and every step is idempotent by (thread, name), so a crash anywhere repeats work, never
// loses a file: the generic copy goes only after its sealed copy and ledger row are committed. Sealed bytes are read back only through
// sealedMediaRead, which checks them against the ledger first. The tables are created with the rest of custody (custody.ts); the
// backup inspector accepts them empty and refuses them populated, like the other custody tables, until M3's omission lands.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { attachmentNamesIn } from "../transcript-backfill.ts";
import { MAILBOX_SEALED_MEDIA_DDL } from "./custody.ts";

export const MEDIA_ROWS_PER_CALL = 500;
/** The largest managed file the seal moves (the attachment reader's own ceiling). */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export interface MediaCustodyDeps {
  transaction<T>(fn: (db: DatabaseSync) => T): T;
  /** The sealed custody folder (under the data folder, outside the attachments folder). */
  dir: string;
  /** The generic managed file's path for a bare attachment name. */
  genericPath(name: string): string;
  /** Whether a removed-for-good name (its marker stands): never moved or served again. */
  removed(name: string): boolean;
  /** Remove the generic file (the attachment module's accounting-aware delete); false when it could not be removed. */
  removeGeneric(path: string): boolean;
  /** Whether a bot avatar names this file (it then stays on the generic plane). */
  avatarNames(name: string): boolean;
}

function ensureTables(db: DatabaseSync): void {
  db.exec(MAILBOX_SEALED_MEDIA_DDL);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a regular file of at most MEDIA_MAX_BYTES, or null when nothing is there (never a FIFO, link or folder). */
function readRegular(path: string): Buffer | null {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!stat.isFile()) return null;
  if (stat.size > MEDIA_MAX_BYTES) throw new Error("Managed file is larger than the sealed custody ceiling");
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) throw new Error("Managed file changed while it was read");
  return bytes;
}

/** Durable copy: a fresh temporary file, written in full and fsynced, renamed over the name, then the folder fsynced. */
function writeDurable(dir: string, name: string, bytes: Buffer): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${name}.${process.pid}.${Date.now()}.partial`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } catch (error) { closeSync(fd); try { unlinkSync(temp); } catch { /* best effort */ } throw error; }
  closeSync(fd);
  renameSync(temp, join(dir, name));
  try { const folder = openSync(dir, "r"); try { fsyncSync(folder); } finally { closeSync(folder); } } catch { /* not every platform fsyncs a folder */ }
}

/** The sealed copy as stored matches the ledger's hash and length. */
function sealedCopyMatches(dir: string, name: string, digest: string, length: number): boolean {
  const stored = readRegular(join(dir, name));
  return !!stored && stored.length === length && sha256(stored) === digest;
}

/** Another conversation's row names the file (a substring narrow; a false match only keeps a generic copy). */
function namedElsewhere(db: DatabaseSync, threadId: string, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM messages WHERE thread_id<>? AND json LIKE ? LIMIT 1").get(threadId, `%${name}%`);
}

/** Another conversation's ledger row for the name whose stored sealed copy still matches it, recorded as this conversation's too. */
function adoptSealedCopy(deps: MediaCustodyDeps, threadId: string, name: string): boolean {
  const others = deps.transaction(db => db.prepare("SELECT sha256, bytes FROM mailbox_sealed_media WHERE name=? AND thread_id<>?").all(name, threadId)) as Array<{ sha256: string; bytes: number }>;
  const verified = others.find(row => sealedCopyMatches(deps.dir, name, row.sha256, Number(row.bytes)));
  if (!verified) return false;
  deps.transaction(db => db.prepare("INSERT OR REPLACE INTO mailbox_sealed_media(thread_id, name, sha256, bytes) VALUES (?, ?, ?, ?)").run(threadId, name, verified.sha256, Number(verified.bytes)));
  return true;
}

/** One bounded step: the next page of the conversation's sealed rows, every managed file they name moved into sealed custody.
 *  Throws (the seal stays pending and its caller retries) when a copy fails its check or a generic file cannot be removed. */
export function moveMailboxMediaBatch(deps: MediaCustodyDeps, threadId: string): { moved: number; done: boolean } {
  const page = deps.transaction(db => {
    ensureTables(db);
    const cursor = Number(db.prepare("SELECT cursor FROM mailbox_sealed_media_cursor WHERE thread_id=?").get(threadId)?.cursor ?? 0);
    const rows = db.prepare(`SELECT rowid AS position, json FROM mailbox_sealed_rows WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT ${MEDIA_ROWS_PER_CALL}`)
      .all(threadId, cursor) as Array<{ position: number; json: string }>;
    return rows;
  });
  let moved = 0;
  const names = new Set(page.flatMap(row => attachmentNamesIn(String(row.json))));
  for (const name of names) {
    if (deps.removed(name)) continue;
    const genericPath = deps.genericPath(name);
    const held = deps.transaction(db => db.prepare("SELECT sha256, bytes FROM mailbox_sealed_media WHERE thread_id=? AND name=?").get(threadId, name)) as { sha256: string; bytes: number } | undefined;
    if (!held || !sealedCopyMatches(deps.dir, name, held.sha256, Number(held.bytes))) {
      const bytes = readRegular(genericPath);
      if (!bytes) {
        // another sealed conversation's step moved a file both name (its rows were already projected, so nothing generic named it
        // and its generic copy went): the sealed copy is one per name, so this conversation takes that verified ledger entry
        if (adoptSealedCopy(deps, threadId, name)) { moved++; continue; }
        // no managed file under that name (never saved, or moved by an earlier step whose ledger row is checked above)
        if (held) throw new Error("Sealed copy is missing and no generic copy is left");
        continue;
      }
      const digest = sha256(bytes);
      writeDurable(deps.dir, name, bytes);
      if (!sealedCopyMatches(deps.dir, name, digest, bytes.length)) throw new Error("Sealed copy does not match the managed file");
      deps.transaction(db => db.prepare("INSERT OR REPLACE INTO mailbox_sealed_media(thread_id, name, sha256, bytes) VALUES (?, ?, ?, ?)").run(threadId, name, digest, bytes.length));
      moved++;
    }
    // the generic link goes only after the sealed copy and its ledger row committed, and only when nothing else names the file
    const shared = deps.avatarNames(name) || deps.transaction(db => namedElsewhere(db, threadId, name));
    if (!shared && readRegular(genericPath) && !deps.removeGeneric(genericPath)) throw new Error("Managed file could not leave the generic plane");
  }
  if (page.length) deps.transaction(db => db.prepare("INSERT INTO mailbox_sealed_media_cursor(thread_id, cursor) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET cursor=excluded.cursor").run(threadId, page.at(-1)!.position));
  return { moved, done: page.length < MEDIA_ROWS_PER_CALL };
}

/** The sealed bytes of one managed file of a completed sealed conversation, after the stored copy matched its ledger row. */
export function sealedMediaRead(db: DatabaseSync, dir: string, threadId: string, name: string): { sha256: string; bytes: Buffer } | null {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mailbox_sealed_media'").get();
  if (!table) return null;
  const held = db.prepare("SELECT sha256, bytes FROM mailbox_sealed_media WHERE thread_id=? AND name=?").get(threadId, name) as { sha256: string; bytes: number } | undefined;
  if (!held) return null;
  const stored = readRegular(join(dir, name));
  if (!stored || stored.length !== Number(held.bytes) || sha256(stored) !== held.sha256) return null;
  return { sha256: held.sha256, bytes: stored };
}
