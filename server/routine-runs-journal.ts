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
// Routine state lines (1.0.2, bgwork): a routine whose own state moved without
// any other change to routines.json (a scheduler tick moving nextRunAt, a run
// adopting the routine's thread) is not saved by rewriting routines.json, whose
// size grows with every routine. One line {"$routine":{...},"$gen":G} goes to
// that routine's journal instead, with the runs the same change created in
// "$runs", so the cursor and its new run land in one whole line (a torn line
// counts as neither). G is the stateGeneration of the routines.json the line
// applies on top of: every full rewrite of routines.json takes a new
// generation, so a line counts only until the next full rewrite, and a
// routines.json written by another release (no generation) makes every such
// line inert. Releases that do not know these lines skip them (no "id").
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
interface Parsed { runs: Map<string, Record<string, unknown>>; routines: Map<string, { routine: Record<string, unknown>; gen: string }>; lines: number; clean: boolean; discarded: number; maxTag: number }

function parseJournal(text: string, committed: number | undefined): Parsed {
  const runs = new Map<string, Record<string, unknown>>();
  const routines = new Map<string, { routine: Record<string, unknown>; gen: string }>();
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
    const state = rest.$routine as Record<string, unknown> | null | undefined;
    if (state !== undefined) {
      if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.id !== "string" || typeof rest.$gen !== "string") continue;
      routines.set(state.id, { routine: state, gen: rest.$gen });
      if (Array.isArray(rest.$runs)) for (const run of rest.$runs as Array<Record<string, unknown> | null>) if (run && typeof run === "object" && typeof run.id === "string") runs.set(run.id, run);
      continue;
    }
    if (typeof rest.$del === "string") runs.delete(rest.$del);
    else if (typeof rest.id === "string") runs.set(rest.id, rest);
  }
  return { runs, routines, lines, clean: text === "" || text.endsWith("\n"), discarded, maxTag };
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

/** The routine state lines that apply on top of a routines.json of `generation`, by routine id. */
export function readRoutineStates(dataDir: string, committed: number | undefined, generation: unknown): Map<string, Record<string, unknown>> {
  const states = new Map<string, Record<string, unknown>>();
  if (typeof generation !== "string") return states;
  const dir = routineRunsDir(dataDir);
  for (const name of journalNames(dir)) {
    try { for (const [id, entry] of parseJournal(readFileSync(join(dir, name), "utf8"), committed).routines) if (entry.gen === generation) states.set(id, entry.routine); } catch { /* unreadable file: skipped */ }
  }
  return states;
}

const routineLine = (routineJson: string, generation: string) => `{"$routine":${routineJson},"$gen":${JSON.stringify(generation)}}`;

export class RoutineRunsJournal {
  private readonly dir: string;
  /** run id -> the exact line last persisted for it. */
  private readonly persisted = new Map<string, { routineId: string; line: string }>();
  private readonly files = new Map<string, FileState>();
  /** The highest tag present in any file after load, so new tags only grow. */
  highestTag = 0;
  /** routine id -> its latest state line of the current generation (no "$runs"). */
  private readonly routineLines = new Map<string, string>();
  /** The stateGeneration of routines.json that state lines are written against. */
  private generation: string | undefined;
  /** The routine states found at load that apply on top of routines.json. */
  routineStates = new Map<string, Record<string, unknown>>();

  constructor(dataDir: string) { this.dir = routineRunsDir(dataDir); }

  /** The committed runs, in file then append order. Primes the change tracker
   * and drops uncommitted lines from disk so no later commit can revive them. */
  load(committed: number | undefined, generation?: string): unknown[] {
    this.persisted.clear();
    this.files.clear();
    this.routineLines.clear();
    this.routineStates = new Map();
    this.generation = generation;
    this.highestTag = 0;
    const all: unknown[] = [];
    for (const name of journalNames(this.dir)) {
      const path = join(this.dir, name);
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      const parsed = parseJournal(text, committed);
      for (const [id, entry] of parsed.routines) {
        if (generation === undefined || entry.gen !== generation) continue;
        this.routineStates.set(id, entry.routine);
        this.routineLines.set(id, routineLine(JSON.stringify(entry.routine), generation));
      }
      const stateLines = [...parsed.routines.values()].filter(entry => generation !== undefined && entry.gen === generation).length;
      if (parsed.discarded > 0) {
        const live = [...[...parsed.routines.keys()].flatMap(id => this.routineLines.get(id) ?? []), ...[...parsed.runs.values()].map(run => JSON.stringify(run))];
        if (live.length === 0) { try { unlinkSync(path); } catch { /* already gone */ } }
        else writeFileAtomic(path, live.join("\n") + "\n", { mode: 0o600 });
        if (live.length > 0) this.files.set(name, { lines: live.length, live: live.length, clean: true });
      } else {
        this.highestTag = Math.max(this.highestTag, parsed.maxTag);
        this.files.set(name, { lines: parsed.lines, live: parsed.runs.size + stateLines, clean: parsed.clean });
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

  /** A full routines.json write took `generation`: every state line before it is spent. */
  setGeneration(generation: string): void {
    this.generation = generation;
    this.routineLines.clear();
  }

  /** True when a state line of the current generation is live (routines.json alone is not the whole state). */
  hasRoutineLines(): boolean { return this.routineLines.size > 0; }

  /** Incremental save (1.0.2 bgwork): append only what the caller says changed, untagged, so its cost
   * follows the change and never the number of routines or runs. Each changed routine is one state line
   * carrying the changed runs of that routine; other changed runs are plain lines; `removed` runs get a
   * tombstone. One write and one fsync per touched routine file. Throws if a line cannot be made durable. */
  append(input: { runs: readonly RunLike[]; routines: ReadonlyArray<{ id: string }>; removed: readonly RunLike[] }): number {
    if (input.routines.length && this.generation === undefined) throw new Error("routine state lines need a routines.json generation");
    const appends = new Map<string, string[]>();
    const add = (routineId: string, line: string) => {
      const name = routineRunsFileName(routineId);
      (appends.get(name) ?? appends.set(name, []).get(name)!).push(line);
    };
    const changed = new Map<string, { routineId: string; line: string }>();
    const changedBy = new Map<string, Array<[string, { routineId: string; line: string }]>>();
    for (const run of input.runs) {
      const line = JSON.stringify(run);
      if (this.persisted.get(run.id)?.line === line) continue;
      const value = { routineId: run.routineId, line };
      changed.set(run.id, value);
      (changedBy.get(run.routineId) ?? changedBy.set(run.routineId, []).get(run.routineId)!).push([run.id, value]);
    }
    const states = new Map<string, string>(), carriedAll: Array<[string, { routineId: string; line: string }]> = [];
    for (const routine of input.routines) {
      const state = routineLine(JSON.stringify(routine), this.generation!);
      const carried = (changedBy.get(routine.id) ?? []).filter(([id]) => changed.has(id));
      for (const [id] of carried) changed.delete(id);
      if (!carried.length && this.routineLines.get(routine.id) === state) continue;
      states.set(routine.id, state);
      add(routine.id, carried.length ? `${state.slice(0, -1)},"$runs":[${carried.map(([, value]) => value.line).join(",")}]}` : state);
      carriedAll.push(...carried);
    }
    for (const value of changed.values()) add(value.routineId, value.line);
    for (const run of input.removed) {
      const old = this.persisted.get(run.id);
      if (old) add(old.routineId, JSON.stringify({ $del: run.id }));
    }
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
    // Live lines per file, kept exact so the compaction trigger below costs O(1) per append.
    const delta = new Map<string, number>();
    const bump = (routineId: string, by: number) => { const name = routineRunsFileName(routineId); delta.set(name, (delta.get(name) ?? 0) + by); };
    for (const [id, value] of [...changed, ...carriedAll]) { if (!this.persisted.has(id)) bump(value.routineId, 1); this.persisted.set(id, value); }
    for (const run of input.removed) { const old = this.persisted.get(run.id); if (old) { bump(old.routineId, -1); this.persisted.delete(run.id); } }
    for (const [id, state] of states) { if (!this.routineLines.has(id)) bump(id, 1); this.routineLines.set(id, state); }
    for (const name of appends.keys()) {
      const file = this.files.get(name)!;
      file.live = Math.max(0, file.live + (delta.get(name) ?? 0));
      // Without this a scheduled routine's file grows with uptime: only a full routines.json write compacted.
      // Best effort: the lines above are already durable, so a failed rewrite leaves the file as it was and is retried.
      if (file.lines > 2 * file.live + 50) { try { this.compactFile(name); } catch { /* retried on the next append */ } }
    }
    return written;
  }

  /** Rewrite one journal with its live lines only (atomic: temp file, fsync, rename). */
  private compactFile(name: string): void {
    const keep: string[] = [];
    for (const [routineId, line] of this.routineLines) if (routineRunsFileName(routineId) === name) keep.push(line);
    for (const { routineId, line } of this.persisted.values()) if (routineRunsFileName(routineId) === name) keep.push(line);
    const state = this.files.get(name);
    if (!state || keep.length === 0 || state.lines <= 2 * keep.length + 50) { if (state) state.live = keep.length; return; }
    writeFileAtomic(join(this.dir, name), keep.join("\n") + "\n", { mode: 0o600 });
    state.lines = keep.length; state.live = keep.length; state.clean = true;
  }

  /** Rewrite a journal with only live runs (and the live state line) once dead lines dominate it. */
  compact(live: Map<string, { routineId: string; line: string }> = this.persisted): void {
    const byFile = new Map<string, string[]>();
    for (const [routineId, line] of this.routineLines) (byFile.get(routineRunsFileName(routineId)) ?? byFile.set(routineRunsFileName(routineId), []).get(routineRunsFileName(routineId))!).push(line);
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

/** Before an older release opens this data folder (the "Prepare to reinstall" step): fold every routine state
 * line into routines.json and rewrite every journal as plain committed run lines, the shape 1.0.1 reads. 1.0.1
 * skips state lines (they have no "id"), so without this it would see each cursor as of the last full rewrite and
 * run an occurrence that already ran, and it would miss runs carried inside a state line. routines.json is written
 * first, without its stateGeneration (so the old lines go inert): a crash between the two steps leaves both
 * readable by this release, and running the step again finishes it. Idempotent. Returns how many routines moved. */
export function foldRoutineStateForDowngrade(file: string): { routines: number; journals: number } {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { routines: 0, journals: 0 }; throw error; }
  const doc = JSON.parse(text) as Record<string, unknown>;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("routines.json is not an object");
  const dataDir = dirname(file);
  const committed = routinesCommit(doc);
  const states = readRoutineStates(dataDir, committed, doc.stateGeneration);
  let moved = 0;
  if (Array.isArray(doc.routines)) doc.routines = (doc.routines as Array<Record<string, unknown>>).map(routine => {
    const state = states.get(String(routine?.id));
    if (!state) return routine;
    moved += 1;
    return state;
  });
  if (moved > 0 || "stateGeneration" in doc) {
    const { stateGeneration: _spent, ...rest } = doc;
    writeFileAtomic(file, JSON.stringify(rest, null, 2), { mode: 0o600 });
  }
  const journals = journalNames(routineRunsDir(dataDir)).length;
  mapRoutineRuns(dataDir, run => run, committed);
  return { routines: moved, journals };
}

/** routines.json with its run history put back inline, the shape 0.1.61 wrote.
 * For tests and diagnostics; nothing in the app reads the file this way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readRoutinesWithRuns(file: string): Record<string, any> & { runs: any[] } {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const states = readRoutineStates(dirname(file), routinesCommit(doc), doc.stateGeneration);
  if (states.size && Array.isArray(doc.routines)) doc.routines = (doc.routines as Array<Record<string, unknown>>).map(routine => states.get(String(routine?.id)) ?? routine);
  const byId = new Map<string, Record<string, unknown>>();
  for (const run of readRoutineRuns(dirname(file), routinesCommit(doc))) byId.set(String((run as { id: string }).id), run as Record<string, unknown>);
  if (Array.isArray(doc.runs)) for (const run of doc.runs as Record<string, unknown>[]) byId.set(String(run.id), run);
  return { ...doc, runs: [...byId.values()] };
}
