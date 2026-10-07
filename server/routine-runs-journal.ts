// SPDX-License-Identifier: AGPL-3.0-or-later
// Routine run history, kept out of routines.json.
//
// routines.json used to carry every run (up to 2,000, 6.4 MB on a busy
// install), so each status change rewrote the whole file. Runs now live in an
// append-only journal, one file per routine:
// <dataDir>/events/routine-runs/<id>.jsonl. Each line is either a full run
// snapshot (a later line for the same run id replaces an earlier one) or a
// tombstone {"$del":"<run id>"}. Saving appends only the runs that changed
// since the last save.
//
// Why under events/: 0.1.61 and earlier refuse a backup when the data folder
// holds a top-level name they do not know (BACKUP_UNCLASSIFIED_COMPONENT).
// events/ is an owner folder every shipped release already backs up and
// restores, so a downgrade keeps backing up and keeps the history.
//
// Commit with routines.json: a save that changes routines.json as well (a
// scheduler tick moving nextRunAt, a confirmation receipt, a pause) tags its
// lines with a sequence number {"$c":N} and then writes routines.json with
// runsCommit: N. A tagged line counts only once routines.json records a commit
// at least that high, so a crash between the two writes rolls BOTH back: the
// scheduler fires that occurrence once on the next start, and a confirmation
// retried by the owner is not applied twice. Lines from saves that leave
// routines.json alone carry no tag and count at once. A routines.json with no
// runsCommit (written by 0.1.61 or earlier) accepts every line.
//
// Crash safety: a line is written whole with its newline and fsynced. A torn
// final line (power loss mid-append) fails to parse and is ignored on load; the
// next append starts on a fresh line. A file is compacted (rewritten atomically
// with live runs only) once dead lines outnumber live ones, and at load when it
// held uncommitted lines, so a later commit can never revive them.
//
// Downgrade: a release that still keeps runs inside routines.json reads
// `runs: []` as an empty history and leaves this folder untouched, so
// upgrading again restores the history from here.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

/** The journal folder inside a data folder. */
export function routineRunsDir(dataDir: string): string { return join(dataDir, "events", "routine-runs"); }

type RunLike = { id: string; routineId: string };

/** A file name for a routine id; ids that are not already plain are hashed. */
export function routineRunsFileName(routineId: string): string {
  return /^[A-Za-z0-9_-]{1,80}$/.test(routineId) ? `${routineId}.jsonl` : `h-${createHash("sha256").update(routineId).digest("hex").slice(0, 40)}.jsonl`;
}

/** The commit a routines.json document records; undefined accepts every line. */
export function routinesCommit(doc: unknown): number | undefined {
  const value = (doc as { runsCommit?: unknown } | null)?.runsCommit;
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

interface FileState { lines: number; live: number; clean: boolean }
interface Parsed { runs: Map<string, Record<string, unknown>>; lines: number; clean: boolean; discarded: number; maxTag: number }

function parseJournal(text: string, committed: number | undefined): Parsed {
  const runs = new Map<string, Record<string, unknown>>();
  let lines = 0, discarded = 0, maxTag = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: Record<string, unknown> | null;
    try { value = JSON.parse(line) as Record<string, unknown> | null; } catch { continue; /* a torn final line: ignored */ }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    lines += 1;
    const tag = value.$c;
    if (tag !== undefined) {
      if (!Number.isSafeInteger(tag)) { discarded += 1; continue; }
      maxTag = Math.max(maxTag, tag as number);
      if (committed !== undefined && (tag as number) > committed) { discarded += 1; continue; }
    }
    const { $c: _tag, ...rest } = value;
    if (typeof rest.$del === "string") runs.delete(rest.$del);
    else if (typeof rest.id === "string") runs.set(rest.id, rest);
  }
  return { runs, lines, clean: text === "" || text.endsWith("\n"), discarded, maxTag };
}

function journalNames(dir: string): string[] {
  try { return readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort(); } catch { return []; }
}

/** Every committed run in every journal under `dataDir`. A missing folder is empty. */
export function readRoutineRuns(dataDir: string, committed?: number): unknown[] {
  const dir = routineRunsDir(dataDir);
  const all: unknown[] = [];
  for (const name of journalNames(dir)) {
    try { all.push(...parseJournal(readFileSync(join(dir, name), "utf8"), committed).runs.values()); } catch { /* unreadable file: skipped */ }
  }
  return all;
}

export class RoutineRunsJournal {
  private readonly dir: string;
  /** run id -> the exact line last persisted for it. */
  private readonly persisted = new Map<string, { routineId: string; line: string }>();
  private readonly files = new Map<string, FileState>();
  /** The highest tag present in any file after load, so new tags only grow. */
  highestTag = 0;

  constructor(dataDir: string) { this.dir = routineRunsDir(dataDir); }

  /** The committed runs, in file then append order. Primes the change tracker
   * and drops uncommitted lines from disk so no later commit can revive them. */
  load(committed: number | undefined): unknown[] {
    this.persisted.clear();
    this.files.clear();
    this.highestTag = 0;
    const all: unknown[] = [];
    for (const name of journalNames(this.dir)) {
      const path = join(this.dir, name);
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      const parsed = parseJournal(text, committed);
      if (parsed.discarded > 0) {
        const live = [...parsed.runs.values()].map(run => JSON.stringify(run));
        if (live.length === 0) { try { unlinkSync(path); } catch { /* already gone */ } }
        else writeFileAtomic(path, live.join("\n") + "\n", { mode: 0o600 });
        if (live.length > 0) this.files.set(name, { lines: live.length, live: live.length, clean: true });
      } else {
        this.highestTag = Math.max(this.highestTag, parsed.maxTag);
        this.files.set(name, { lines: parsed.lines, live: parsed.runs.size, clean: parsed.clean });
      }
      for (const [id, run] of parsed.runs) {
        all.push(run);
        this.persisted.set(id, { routineId: String(run.routineId ?? ""), line: JSON.stringify(run) });
      }
    }
    return all;
  }

  /** Append what changed, tagged with `tag` when given. Throws if a line cannot
   * be made durable. */
  sync(runs: readonly RunLike[], tag?: number): number {
    const appends = new Map<string, string[]>();
    const stamp = (line: string) => tag === undefined ? line : `${line.slice(0, -1)},"$c":${tag}}`;
    const add = (routineId: string, line: string) => {
      const name = routineRunsFileName(routineId);
      const list = appends.get(name) ?? [];
      list.push(stamp(line));
      appends.set(name, list);
    };
    const next = new Map<string, { routineId: string; line: string }>();
    for (const run of runs) {
      const line = JSON.stringify(run);
      next.set(run.id, { routineId: run.routineId, line });
      if (this.persisted.get(run.id)?.line !== line) add(run.routineId, line);
    }
    for (const [id, old] of this.persisted) if (!next.has(id)) add(old.routineId, JSON.stringify({ $del: id }));
    if (appends.size === 0) return 0;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let written = 0;
    for (const [name, lines] of appends) {
      const path = join(this.dir, name);
      const state = this.files.get(name) ?? { lines: 0, live: 0, clean: true };
      const body = (state.clean ? "" : "\n") + lines.join("\n") + "\n";
      const fd = openSync(path, "a", 0o600);
      try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      state.lines += lines.length; state.clean = true;
      this.files.set(name, state);
      written += lines.length;
    }
    if (tag !== undefined) this.highestTag = Math.max(this.highestTag, tag);
    this.persisted.clear();
    for (const [id, value] of next) this.persisted.set(id, value);
    // An uncommitted tag must stay on disk until routines.json records it:
    // compacting now would drop the tag and make those lines count early.
    if (tag === undefined) this.compact(next);
    return written;
  }

  /** Rewrite a journal with only live runs once dead lines dominate it. */
  compact(live: Map<string, { routineId: string; line: string }> = this.persisted): void {
    const byFile = new Map<string, string[]>();
    for (const { routineId, line } of live.values()) {
      const name = routineRunsFileName(routineId);
      (byFile.get(name) ?? byFile.set(name, []).get(name)!).push(line);
    }
    for (const [name, state] of this.files) {
      const keep = byFile.get(name) ?? [];
      state.live = keep.length;
      const path = join(this.dir, name);
      if (keep.length === 0) {
        try { unlinkSync(path); } catch { /* already gone */ }
        this.files.delete(name);
      } else if (state.lines > 2 * keep.length + 50) {
        writeFileAtomic(path, keep.join("\n") + "\n", { mode: 0o600 });
        state.lines = keep.length;
      }
    }
  }
}

/** Rewrite every journal under `dataDir` with `change` applied to each
 * committed run (compacted, untagged, atomic per file). Restore preparation
 * uses it to suspend runs that were still pending when the backup was taken. */
export function mapRoutineRuns(dataDir: string, change: (run: Record<string, unknown>) => Record<string, unknown>, committed?: number): void {
  const dir = routineRunsDir(dataDir);
  for (const name of journalNames(dir)) {
    const path = join(dir, name);
    const runs = [...parseJournal(readFileSync(path, "utf8"), committed).runs.values()].map(run => change(run));
    writeFileAtomic(path, runs.map(run => JSON.stringify(run)).join("\n") + (runs.length ? "\n" : ""), { mode: 0o600 });
  }
}

/** routines.json with its run history put back inline, the shape 0.1.61 wrote.
 * For tests and diagnostics; nothing in the app reads the file this way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readRoutinesWithRuns(file: string): Record<string, any> & { runs: any[] } {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const byId = new Map<string, Record<string, unknown>>();
  for (const run of readRoutineRuns(dirname(file), routinesCommit(doc))) byId.set(String((run as { id: string }).id), run as Record<string, unknown>);
  if (Array.isArray(doc.runs)) for (const run of doc.runs as Record<string, unknown>[]) byId.set(String(run.id), run);
  return { ...doc, runs: [...byId.values()] };
}
