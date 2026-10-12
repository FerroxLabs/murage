// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The crash journal of a JSONL rewrite. A row of an engine's history is cleared by overwriting the bytes of its content fields in
// place; a crash (or a power cut) can leave one of those overwrites half done, and a row cut in the middle of a value is no longer one
// JSON object, so nothing could read it, plan it or finish it. Before the first overwrite of a step Murage writes down WHERE each row
// is and which byte ranges it will overwrite with what KIND of fill; after the step is verified the record is deleted. After a crash
// the record is enough to finish the job, because the fill bytes are a pure function of (kind, length) (engine-plan-core.ts fillFor).
//
// What the journal never holds: the text of a row, a hash of any byte that is being cleared, a span's bytes, or a needle. The one hash
// in it, `skel`, is a SHA-256 of the row with every range that will be overwritten replaced by zeros: only ids, times and structure go
// into it. A journal that kept the deleted words, or a hash that could confirm a guess of them, would itself be a copy of what the
// deletion is there to remove.
//
// The journal is a file per engine file in <data folder>/engine-redo/, named by the hash of the engine file's path. It is written and
// synced (the file and the folder) before the first overwrite, and removed after the step is verified. engine-exec.ts decides when and
// under which hold; this module only reads and writes the records and rebuilds the bytes.
import nodePath from "node:path";
import { createHash } from "node:crypto";

import { mutOps, realEngineFs } from "./engine-fs.ts";
import { fillFor, type EditKind, type RowEdit } from "./engine-plan-core.ts";

export interface RedoEdit { at: number; len: number; kind: EditKind }
export interface RedoRow {
  /** where the row starts and how many bytes it has (without its newline) */
  off: number;
  len: number;
  /** SHA-256 of the row with every edit range zeroed (ids, times and structure only) */
  skel: string;
  edits: RedoEdit[];
}
export interface RedoRecord {
  v: 1;
  /** the file that was being written (an aside's name when the file was set aside) and its identity */
  path: string;
  dev: string;
  ino: string;
  /** which engine and home it belongs to, how the file is held and which format its rows are in: recovery needs all three */
  engine: string;
  home: string;
  how: string;
  format: string;
  rows: RedoRow[];
}

let configured: string | undefined;
/** Where the journals live: `dir` when given (the deletion service passes <data folder>/engine-redo), else $MURAGE_ENGINE_REDO_DIR, else
 * <$MURAGE_DATA_DIR>/engine-redo. Null: nowhere to write one, and then nothing of an engine's is rewritten. */
export function configureRedo(dir: string | undefined): void { configured = dir; }
export function redoDirectory(): string | null {
  if (configured) return configured;
  const env = process.env;
  if (env.MURAGE_ENGINE_REDO_DIR) return env.MURAGE_ENGINE_REDO_DIR;
  return env.MURAGE_DATA_DIR ? nodePath.join(env.MURAGE_DATA_DIR, "engine-redo") : null;
}

const fileOf = (dir: string, path: string): string => nodePath.join(dir, `${createHash("sha256").update(path).digest("hex")}.json`);

/** Writes the record and makes it durable (the file, then its folder) BEFORE anything is overwritten. */
export function writeRedo(record: RedoRecord): void {
  const dir = redoDirectory();
  if (!dir) throw new Error("no folder for the crash journal");
  mutOps.mkdirp(dir);
  const file = fileOf(dir, record.path);
  mutOps.writeDurable(file, Buffer.from(JSON.stringify(record)));
  mutOps.fsyncDir(dir);
}

/** Removes the record of `path` (no error if there is none). */
export function dropRedo(path: string): void {
  const dir = redoDirectory();
  if (!dir) return;
  try { mutOps.unlink(fileOf(dir, path)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Every record on disk. A file that is not one of ours is left alone (and not listed). */
export function listRedo(): RedoRecord[] {
  const dir = redoDirectory();
  if (!dir) return [];
  const reader = realEngineFs();
  const out: RedoRecord[] = [];
  for (const name of reader.readdir(dir)) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const text = reader.readText(nodePath.join(dir, name));
    let value: unknown;
    try { value = text === null ? null : JSON.parse(text); } catch { continue; }
    const record = value as Partial<RedoRecord> | null;
    if (!record || record.v !== 1 || typeof record.path !== "string" || !Array.isArray(record.rows) || typeof record.engine !== "string" || typeof record.home !== "string" || typeof record.how !== "string" || typeof record.format !== "string") continue;
    out.push(record as RedoRecord);
  }
  return out;
}

/** The bytes a row's journalled edits write, rebuilt from (kind, length) alone. */
export function editsOf(row: RedoRow): RowEdit[] {
  return row.edits.map((edit) => ({ at: edit.at, len: edit.len, kind: edit.kind, bytes: fillFor(edit.kind, edit.len) }));
}
