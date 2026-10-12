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
// Every step writes a journal of its OWN, under a fresh random name that is created and never replaces anything: a second deletion that
// writes the same engine file can never overwrite the only journal of a row an earlier one left torn. A journal is removed only after
// every row it names is verified cleared. Recovery finds the file by its IDENTITY (device and inode), under whichever name it has now
// (its own name, the aside's, the one it was given back), so a file moved or put back after a failed write is still found; a file the
// engine replaced (a new inode) is searched for the row's skeleton.
//
// The same folder keeps the journal of a JOIN (Kimi's REJOIN, engine-exec.ts): which file the engine's newer rows go into, from which
// file, at which byte, and whether a newline goes first. Sizes and identities only, never a byte of either file.
//
// The journals are written and synced (the file and the folder) before the first overwrite. engine-exec.ts decides when and under which
// hold; this module only reads and writes the records and rebuilds the bytes.
import nodePath from "node:path";
import { randomBytes } from "node:crypto";

import { exclOps, mutOps, realEngineFs } from "./engine-fs.ts";
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
  v: 1 | 2;
  kind: "rows";
  /** the record's own name in the folder (filled in when it is written or listed) */
  id: string;
  /** the name the file had when the record was written (an aside's name when the file was set aside) and its identity */
  path: string;
  dev: string;
  ino: string;
  /** which engine and home it belongs to, how the file is held and which format its rows are in: recovery needs all three */
  engine: string;
  home: string;
  how: string;
  format: string;
  rows: RedoRow[];
  /** set when the barrier after the rows were written was only the fallback (macOS plain fsync): the boot of the operating system
   * they were written in (BootMark). The record is dropped only after the operating system has restarted since (rebootedSince), and the
   * rows read again are found cleared (engine-exec.ts). A record of an earlier build (a start id or counter here) is never dropped on
   * the strength of a restart: it has no boot to compare. */
  fellBack?: BootMark;
}
/** A JOIN in progress: the engine's newer file (`from`, under Murage's private name) is being written into the older one (`into`), at
 * byte `base` of it, after `lead` newline bytes (0 or 1). Writing the same bytes at the same place again changes nothing more. */
export interface JoinRecord {
  v: 2;
  kind: "join";
  id: string;
  into: { path: string; dev: string; ino: string };
  from: { path: string; dev: string; ino: string };
  base: number;
  lead: 0 | 1;
  engine: string;
  home: string;
  /** how many recoveries in a row found the bytes after `base` no longer the start of the newer file (engine-exec.ts undoJoin) */
  undo?: number;
  /** as RedoRecord.fellBack: the join's bytes had only the fallback barrier, in the boot of the operating system named here */
  fellBack?: BootMark;
}
export type AnyRecord = RedoRecord | JoinRecord;

let configured: string | undefined;
/** Where the journals live: `dir` when given (the deletion service passes <data folder>/engine-redo), else $MURAGE_ENGINE_REDO_DIR, else
 * <$MURAGE_DATA_DIR>/engine-redo. Null: nowhere to write one, and then nothing of an engine's is rewritten. */
export function configureRedo(dir: string | undefined): void { configured = dir; }
const isBootMark = (value: unknown): value is BootMark => {
  const mark = value as Partial<BootMark> | null;
  return !!mark && typeof mark === "object" && (mark.boot === null || typeof mark.boot === "string") && typeof mark.uptime === "number" && Number.isFinite(mark.uptime);
};

export function redoDirectory(): string | null {
  if (configured) return configured;
  const env = process.env;
  if (env.MURAGE_ENGINE_REDO_DIR) return env.MURAGE_ENGINE_REDO_DIR;
  return env.MURAGE_DATA_DIR ? nodePath.join(env.MURAGE_DATA_DIR, "engine-redo") : null;
}

/** The boot of the operating system a journal was marked in (RedoRecord.fellBack). `boot`: the system's own id of this boot (Linux
 * /proc/sys/kernel/random/boot_id, macOS kern.bootsessionuuid), null where there is none to read (Windows). `uptime`: seconds since that
 * boot when it was marked (Windows: GetTickCount64, through os.uptime), which only grows within one boot. */
export interface BootMark { boot: string | null; uptime: number }

/** Where the boot is read; tests replace `current` to model a restart of the operating system. */
export const bootOps = {
  current(): BootMark {
    return { boot: exclOps.bootId(), uptime: exclOps.uptimeSeconds() };
  },
};

/** Has the operating system restarted since `mark`? Proven only by a different boot id, or (no id on either side) by an uptime lower
 * than the one marked. A restart of Murage alone is never one: whatever the drive still holds in its cache, a read now could return it,
 * so only a read after a restart of the system can show what reached the drive. Anything that cannot be compared answers no. */
export function rebootedSince(mark: BootMark | undefined): boolean {
  if (!mark) return false;
  let now: BootMark;
  try { now = bootOps.current(); } catch { return false; }
  if (mark.boot !== null && now.boot !== null) return mark.boot !== now.boot;
  if (mark.boot !== null || now.boot !== null) return false;
  return Number.isFinite(now.uptime) && Number.isFinite(mark.uptime) && mark.uptime >= 0 && now.uptime < mark.uptime;
}

const NAME = /^([0-9a-f]{32}|[0-9a-f]{64})\.json$/;

/** Writes a new record under a fresh name (never replacing one) and makes it durable (the file, then its folder) BEFORE anything is
 * overwritten. Returns the record's id. */
function writeRecord(record: Omit<RedoRecord, "id"> | Omit<JoinRecord, "id">): string {
  const dir = redoDirectory();
  if (!dir) throw new Error("no folder for the crash journal");
  mutOps.mkdirp(dir);
  const id = randomBytes(16).toString("hex");
  mutOps.writeDurable(nodePath.join(dir, `${id}.json`), Buffer.from(JSON.stringify({ ...record, id })));
  mutOps.fsyncDir(dir);
  return id;
}
export function writeRedo(record: Omit<RedoRecord, "id" | "v" | "kind">): string { return writeRecord({ v: 2, kind: "rows", ...record }); }
export function writeJoin(record: Omit<JoinRecord, "id" | "v" | "kind">): string { return writeRecord({ v: 2, kind: "join", ...record }); }

/** The record written again with `fellBack` set to this boot of the operating system (a new record first, then the old one dropped: a
 * cut between the two leaves two records of the same work, each finished on its own). Returns the new id. */
export function markFellBack(rec: AnyRecord): string {
  const start = bootOps.current();
  const { id, v: _v, kind: _kind, ...fields } = rec;
  const next = rec.kind === "join"
    ? writeJoin({ ...(fields as Omit<JoinRecord, "id" | "v" | "kind">), fellBack: start })
    : writeRedo({ ...(fields as Omit<RedoRecord, "id" | "v" | "kind">), fellBack: start });
  rec.id = next;
  rec.fellBack = start;
  dropRedo(id);
  return next;
}

/** Removes a record (no error if it is gone). */
export function dropRedo(id: string): void {
  const dir = redoDirectory();
  if (!dir || !/^[0-9a-f]{32,64}$/.test(id)) return;
  try { mutOps.unlink(nodePath.join(dir, `${id}.json`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

const isId = (value: unknown): value is { path: string; dev: string; ino: string } => {
  const item = value as { path?: unknown; dev?: unknown; ino?: unknown } | null;
  return !!item && typeof item.path === "string" && typeof item.dev === "string" && typeof item.ino === "string";
};

/** Every record on disk (a journal of rows, and a join). A file that is not one of ours is left alone (and not listed). A record of
 * the first version (one per engine file, named by the hash of its path) is read as a journal of rows. */
export function listRedo(): AnyRecord[] {
  const dir = redoDirectory();
  if (!dir) return [];
  const reader = realEngineFs();
  const out: AnyRecord[] = [];
  for (const name of reader.readdir(dir)) {
    const named = NAME.exec(name);
    if (!named) continue;
    const text = reader.readText(nodePath.join(dir, name));
    let value: unknown;
    try { value = text === null ? null : JSON.parse(text); } catch { continue; }
    const record = value as Record<string, unknown> | null;
    if (!record || (record.v !== 1 && record.v !== 2) || typeof record.engine !== "string" || typeof record.home !== "string") continue;
    // a boot of the operating system; an earlier build's start id or counter names none: kept, never dropped on a restart
    if (typeof record.fellBack === "string" || typeof record.fellBack === "number") record.fellBack = { boot: null, uptime: -1 } satisfies BootMark;
    else if (record.fellBack !== undefined && !isBootMark(record.fellBack)) continue;
    const id = named[1]!;
    if (record.kind === "join") {
      if (!isId(record.into) || !isId(record.from) || typeof record.base !== "number" || (record.lead !== 0 && record.lead !== 1) || (record.undo !== undefined && (typeof record.undo !== "number" || !(record.undo >= 0)))) continue;
      out.push({ ...(record as unknown as JoinRecord), id });
      continue;
    }
    if (typeof record.path !== "string" || typeof record.dev !== "string" || typeof record.ino !== "string" || !Array.isArray(record.rows) || typeof record.how !== "string" || typeof record.format !== "string") continue;
    out.push({ ...(record as unknown as RedoRecord), kind: "rows", id });
  }
  return out;
}

/** The record ids of rows journals of the file with this identity. */
export const rowsRecordsOf = (records: readonly AnyRecord[], dev: string, ino: string): RedoRecord[] =>
  records.filter((item): item is RedoRecord => item.kind === "rows" && item.dev === dev && item.ino === ino);

/** The bytes a row's journalled edits write, rebuilt from (kind, length) alone. */
export function editsOf(row: RedoRow): RowEdit[] {
  return row.edits.map((edit) => ({ at: edit.at, len: edit.len, kind: edit.kind, bytes: fillFor(edit.kind, edit.len) }));
}
