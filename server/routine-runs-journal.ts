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
import { rebaseAttachmentRecord } from "./attachment-paths.ts";
import { writeSync } from "./counted-fs.ts";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFileAtomic, renameWithRetry, syncParentDirectory } from "./atomic.ts";
import { labelWorkCollection } from "./work-collections.ts";

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

interface FileState { lines: number; live: number; clean: boolean; linesKnown: boolean }
/** `view` is the line of the in-memory (attachment-rebased) form, kept only when it differs from the raw line on disk. */
interface PersistedRun { routineId: string; line: string; view?: string }
interface CompactCursor { path: string; fd: number; runs: MapIterator<[string, PersistedRun]>; states: MapIterator<[string, string]>; stateDone: boolean; receipts: MapIterator<[string, string]>; receiptDone: boolean; lines: number }
export class JournalWriteError extends Error {
  readonly filename: string;
  readonly stage: string;
  readonly bytesWritten: number;
  constructor(filename: string, stage: string, bytesWritten: number, cause: unknown) {
    super(`Routine journal ${filename}: ${stage} failed after ${bytesWritten} bytes`, { cause });
    this.name = "JournalWriteError";
    this.filename = filename; this.stage = stage; this.bytesWritten = bytesWritten;
  }
}
const UNCERTAIN = "";
const COPY_SLICE = 64, SYNC_COPY_LIMIT = 256;
interface Parsed { receipts: Map<string, { value: Record<string, unknown> | null; gen: string }>; runs: Map<string, Record<string, unknown>>; routines: Map<string, { routine: Record<string, unknown>; gen: string }>; lines: number; clean: boolean; discarded: number; maxTag: number }

function validProposalReceipt(value: unknown, id: string): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.requestId === id && typeof receipt.messageId === "string" && typeof receipt.botId === "string" && typeof receipt.threadId === "string"
    && ["create", "update", "pause", "resume", "delete", "run_now"].includes(String(receipt.action))
    && receipt.fingerprintVersion === 1 && typeof receipt.fingerprint === "string" && /^[a-f0-9]{64}$/.test(receipt.fingerprint)
    && (receipt.resultId === undefined && receipt.appliedAt === undefined || typeof receipt.resultId === "string" && Number.isFinite(receipt.appliedAt));
}

function parseJournal(text: string, committed: number | undefined, strict = false): Parsed {
  const receipts = new Map<string, { value: Record<string, unknown> | null; gen: string }>();
  const runs = new Map<string, Record<string, unknown>>();
  const routines = new Map<string, { routine: Record<string, unknown>; gen: string }>();
  let lines = 0, discarded = 0, maxTag = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let value: Record<string, unknown> | null;
    try { value = JSON.parse(line) as Record<string, unknown> | null; } catch (error) { if (strict) throw error; continue; /* a torn final line: ignored */ }
    if (!value || typeof value !== "object" || Array.isArray(value)) { if (strict) throw new Error("Invalid routine journal line"); continue; }
    lines += 1;
    const tag = value.$c;
    if (tag !== undefined) {
      if (!Number.isSafeInteger(tag)) { if (strict) throw new Error("Invalid routine journal commit"); discarded += 1; continue; }
      maxTag = Math.max(maxTag, tag as number);
      if (committed !== undefined && (tag as number) > committed) { discarded += 1; continue; }
    }
    const { $c: _tag, ...rest } = value;
    if (rest.$proposal === 1) {
      const receipt = rest.$receipt as { requestId?: unknown; value?: unknown } | undefined;
      const state = rest.$routine as Record<string, unknown> | undefined;
      const invalid = typeof rest.$gen !== "string" || !receipt || typeof receipt.requestId !== "string"
        || (receipt.value !== null && !validProposalReceipt(receipt.value, String(receipt.requestId)))
        || (state !== undefined && (!state || typeof state !== "object" || Array.isArray(state) || typeof state.id !== "string"))
        || (rest.$runs !== undefined && (!Array.isArray(rest.$runs) || rest.$runs.some(run => !run || typeof run !== "object" || Array.isArray(run) || typeof run.id !== "string" || typeof run.routineId !== "string")))
        || (rest.$removed !== undefined && (!Array.isArray(rest.$removed) || rest.$removed.some(id => typeof id !== "string")));
      if (invalid) { if (strict) throw new Error("Invalid routine proposal receipt"); continue; }
      receipts.set(receipt.requestId as string, { value: receipt.value as Record<string, unknown> | null, gen: rest.$gen as string });
      if (Array.isArray(rest.$removed)) for (const id of rest.$removed) if (typeof id === "string") runs.delete(id);
      if (Array.isArray(rest.$runs)) for (const run of rest.$runs as Array<Record<string, unknown>>) if (run && typeof run.id === "string") runs.set(run.id, run);
      if (rest.$routine === undefined) continue;
    }
    const state = rest.$routine as Record<string, unknown> | null | undefined;
    if (state !== undefined) {
      if (!state || typeof state !== "object" || Array.isArray(state) || typeof state.id !== "string" || typeof rest.$gen !== "string") { if (strict) throw new Error("Invalid routine journal state"); continue; }
      if (strict && rest.$runs !== undefined && (!Array.isArray(rest.$runs) || rest.$runs.some(run => !run || typeof run !== "object" || Array.isArray(run) || typeof run.id !== "string"))) throw new Error("Invalid routine journal runs");
      routines.set(state.id, { routine: state, gen: rest.$gen });
      if (Array.isArray(rest.$runs)) for (const run of rest.$runs as Array<Record<string, unknown> | null>) if (run && typeof run === "object" && typeof run.id === "string") runs.set(run.id, run);
      continue;
    }
    if (typeof rest.$del === "string") runs.delete(rest.$del);
    else if (typeof rest.id === "string") runs.set(rest.id, rest);
    else if (strict) throw new Error("Invalid routine journal run");
  }
  return { receipts, runs, routines, lines, clean: text === "" || text.endsWith("\n"), discarded, maxTag };
}

function journalNames(dir: string): string[] {
  try { return readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort(); } catch { return []; }
}

/** Every committed run in every journal under `dataDir`. A missing folder is empty. */
export function readRoutineRuns(dataDir: string, committed?: number): unknown[] {
  const dir = routineRunsDir(dataDir);
  const all: unknown[] = [];
  for (const name of journalNames(dir)) {
    try { all.push(...[...parseJournal(readFileSync(join(dir, name), "utf8"), committed).runs.values()].map(run => rebaseAttachmentRecord(run))); } catch { /* unreadable file: skipped */ }
  }
  return all;
}

/** Fail-closed authority read. The caller supplies checked, bounded IO; every
 * directory, file and parse error propagates. Parse the same bytes once, with
 * the ordinary commit/tombstone/state-run semantics, without repairing disk.
 * The supplied list may treat an absent journal directory as empty. */
export function readRoutineRunsStrict(dataDir: string, committed: number | undefined, io: {
  list: (dir: string) => string[];
  read: (file: string) => string;
}): unknown[] {
  const dir = routineRunsDir(dataDir), all: unknown[] = [];
  for (const name of io.list(dir).filter(name => name.endsWith(".jsonl")).sort()) {
    const parsed = parseJournal(io.read(join(dir, name)), committed, true);
    for (const run of parsed.runs.values()) all.push(rebaseAttachmentRecord(run));
  }
  return all;
}

/** The routine state lines that apply on top of a routines.json of `generation`, by routine id. */
export function readRoutineStates(dataDir: string, committed: number | undefined, generation: unknown): Map<string, Record<string, unknown>> {
  const states = new Map<string, Record<string, unknown>>();
  if (typeof generation !== "string") return states;
  const dir = routineRunsDir(dataDir);
  for (const name of journalNames(dir)) {
    try { for (const [id, entry] of parseJournal(readFileSync(join(dir, name), "utf8"), committed).routines) if (entry.gen === generation) states.set(id, rebaseAttachmentRecord(entry.routine)); } catch { /* unreadable file: skipped */ }
  }
  return new Map([...states].sort(([, a], [, b]) => (Number.isSafeInteger(a.proposalOrder) ? Number(a.proposalOrder) : -1) - (Number.isSafeInteger(b.proposalOrder) ? Number(b.proposalOrder) : -1)));
}

function proposalReceiptProjection(doc: Record<string, unknown>, dataDir: string): Record<string, unknown>[] {
  const receipts = new Map((Array.isArray(doc.routineRequestReceipts) ? doc.routineRequestReceipts : []).map(receipt => [receipt.requestId as string, receipt as Record<string, unknown>]));
  for (const name of journalNames(routineRunsDir(dataDir))) {
    const parsed = parseJournal(readFileSync(join(routineRunsDir(dataDir), name), "utf8"), routinesCommit(doc));
    for (const [id, entry] of parsed.receipts) if (typeof doc.stateGeneration === "string" && entry.gen === doc.stateGeneration) {
      if (entry.value === null) receipts.delete(id); else receipts.set(id, entry.value);
    }
  }
  return [...receipts.values()].sort((a, b) => (Number.isSafeInteger(b.journalOrder) ? Number(b.journalOrder) : 0) - (Number.isSafeInteger(a.journalOrder) ? Number(a.journalOrder) : 0));
}

/** Lifecycle/export projection of generation-scoped proposal records. */
function applyProposalProjection(doc: Record<string, unknown>, dataDir: string): number {
  const states = readRoutineStates(dataDir, routinesCommit(doc), doc.stateGeneration);
  const routines = Array.isArray(doc.routines) ? [...doc.routines] as Record<string, unknown>[] : [];
  for (const [id, state] of states) {
    const at = routines.findIndex(routine => routine?.id === id);
    if (state.$deleted === true) { if (at >= 0) routines.splice(at, 1); }
    else if (at >= 0) routines[at] = state;
    else routines.unshift(state);
  }
  doc.routines = routines;
  doc.routineRequestReceipts = proposalReceiptProjection(doc, dataDir);
  return states.size;
}

const routineLine = (routineJson: string, generation: string) => `{"$routine":${routineJson},"$gen":${JSON.stringify(generation)}}`;

export class RoutineRunsJournal {
  private readonly dir: string;
  private readonly document: string;
  private readonly counters?: { journalLines: number; compactCopied: number };
  private readonly persisted = labelWorkCollection("journal.persisted", new Map<string, PersistedRun>());
  private readonly persistedByFile = labelWorkCollection("journal.persistedByFile", new Map<string, Map<string, PersistedRun>>());
  private readonly files = labelWorkCollection("journal.files", new Map<string, FileState>());
  private readonly routineLines = labelWorkCollection("journal.routineLines", new Map<string, string>());
  private readonly routineLinesByFile = labelWorkCollection("journal.routineLinesByFile", new Map<string, Map<string, string>>());
  /** Every possibly landed old/new filename, including attempted new IDs. */
  private readonly uncertainTargets = labelWorkCollection("journal.uncertainTargets", new Map<string, Map<string, string>>());
  private readonly uncertainStates = new Map<string, string>();
  private readonly cursors = new Map<string, CompactCursor>();
  private readonly receiptLinesByFile = new Map<string, Map<string, string>>();
  readonly requestReceipts = new Map<string, Record<string, unknown> | null>();
  private readonly uncertainReceipts = new Set<string>();
  private readonly baselineReceipts = new Set<string>();
  private generation: string | undefined;
  private count = 0;
  private pinFailed = false;
  highestTag = 0;
  baselineCommit: number | undefined;
  pendingCommit: number | undefined;
  routineStates = new Map<string, Record<string, unknown>>();
  readonly work = { journalLines: 0, compactCopied: 0, compactFaults: 0, fullTraversals: 0 };
  lastCompactionError: unknown;
  get persistedCount(): number { return this.count; }
  get durabilityKnown(): boolean { return this.baselineCommit !== undefined && this.uncertainTargets.size === 0 && this.uncertainStates.size === 0 && this.pendingCommit === undefined && this.uncertainReceipts.size === 0; }
  resetWork(): void { this.work.journalLines = this.work.compactCopied = this.work.compactFaults = this.work.fullTraversals = 0; }

  constructor(dataDir: string, counters?: { journalLines: number; compactCopied: number }) { this.dir = routineRunsDir(dataDir); this.document = join(dataDir, "routines.json"); this.counters = counters; }

  private file(name: string): FileState {
    let state = this.files.get(name);
    if (!state) {
      state = { lines: 0, live: (this.persistedByFile.get(name)?.size ?? 0) + (this.routineLinesByFile.get(name)?.size ?? 0) + (this.receiptLinesByFile.get(name)?.size ?? 0), clean: true, linesKnown: true };
      this.files.set(name, state);
    }
    return state;
  }
  private runBucket(name: string): Map<string, PersistedRun> {
    let bucket = this.persistedByFile.get(name);
    if (!bucket) this.persistedByFile.set(name, bucket = labelWorkCollection(`journal.runs:${name}`, new Map()));
    return bucket;
  }
  private stateBucket(name: string): Map<string, string> {
    let bucket = this.routineLinesByFile.get(name);
    if (!bucket) this.routineLinesByFile.set(name, bucket = labelWorkCollection(`journal.states:${name}`, new Map()));
    return bucket;
  }
  private setPersisted(id: string, value: PersistedRun | undefined): void {
    const old = this.persisted.get(id), before = old && routineRunsFileName(old.routineId), after = value && routineRunsFileName(value.routineId);
    if (before !== after) {
      if (before) { this.runBucket(before).delete(id); this.file(before).live--; }
      if (after) { this.file(after).live++; }
    }
    if (value) {
      this.file(after!); this.runBucket(after!).set(id, value); this.persisted.set(id, value);
      if (!old) this.count++;
    } else if (old) { this.persisted.delete(id); this.count--; }
  }
  /** Register the manager's normalized load projection, preserving the disk baseline.
   * Call only during load, before recovery or user mutations. */
  loadedRunView(run: RunLike): void {
    const old = this.persisted.get(run.id);
    if (old && old.routineId === run.routineId) old.view = JSON.stringify(run);
  }
  private setState(id: string, line: string | undefined): void {
    const name = routineRunsFileName(id), old = this.routineLines.get(id);
    const file = this.file(name);
    if (line !== undefined) {
      if (old === undefined) file.live++;
      this.routineLines.set(id, line); this.stateBucket(name).set(id, line);
    } else if (old !== undefined) {
      this.routineLines.delete(id); this.stateBucket(name).delete(id); file.live--;
    }
  }
  private abortCursor(name: string): void {
    const cursor = this.cursors.get(name);
    if (!cursor) return;
    this.cursors.delete(name);
    try { closeSync(cursor.fd); } catch { /* already closed */ }
    try { unlinkSync(cursor.path); } catch { /* cleanup is lifecycle/retry safe */ }
  }
  private abortCursors(): void { for (const name of this.cursors.keys()) this.abortCursor(name); }

  /** Lifecycle only. Pin the original legacy projection before returning to any writer. */
  load(committed: number | undefined, generation?: string): unknown[] {
    this.abortCursors();
    this.persisted.clear(); this.persistedByFile.clear(); this.files.clear();
    this.routineLines.clear(); this.routineLinesByFile.clear(); this.uncertainTargets.clear(); this.uncertainStates.clear();
    this.receiptLinesByFile.clear(); this.requestReceipts.clear(); this.uncertainReceipts.clear();
    this.count = 0; this.routineStates = new Map(); this.generation = generation; this.highestTag = 0;
    this.baselineCommit = undefined; this.pendingCommit = undefined;
    this.baselineReceipts.clear();
    try {
      const document = JSON.parse(readFileSync(this.document, "utf8")) as { routineRequestReceipts?: Array<{ requestId?: unknown }> };
      for (const receipt of Array.isArray(document.routineRequestReceipts) ? document.routineRequestReceipts : []) if (typeof receipt?.requestId === "string") this.baselineReceipts.add(receipt.requestId);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const all: unknown[] = [];
    // Only our ignored incremental temps are removed; never other atomic writers' temps.
    try { for (const name of readdirSync(this.dir)) if (name.endsWith(".jsonl.compact")) unlinkSync(join(this.dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of journalNames(this.dir)) {
      const path = join(this.dir, name);
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      const parsed = parseJournal(text, committed);
      if (parsed.maxTag >= Number.MAX_SAFE_INTEGER) throw new JournalWriteError(name, "tag-exhausted", 0, new Error("Commit tag range exhausted"));
      this.highestTag = Math.max(this.highestTag, parsed.maxTag);
      this.files.set(name, { lines: parsed.lines, live: 0, clean: parsed.clean, linesKnown: true });
      for (const [id, receipt] of parsed.receipts) if (generation !== undefined && receipt.gen === generation) {
        this.rememberReceipt(name, id, receipt.value);
      }
      for (const [id, entry] of parsed.routines) {
        if (generation === undefined || entry.gen !== generation) continue;
        this.routineStates.set(id, rebaseAttachmentRecord(entry.routine));
        this.setState(id, routineLine(JSON.stringify(entry.routine), generation));
      }
      for (const [id, run] of parsed.runs) {
        const rebased = rebaseAttachmentRecord(run), line = JSON.stringify(run), view = JSON.stringify(rebased);
        all.push(rebased);
        // The raw line stays the baseline for what is on disk; the rebased view only stops an unchanged in-memory run from being rewritten.
        this.setPersisted(id, { routineId: String(run.routineId ?? ""), line, ...(view === line ? {} : { view }) });
      }
      if (parsed.discarded > 0) {
        const live = [...this.receiptBucket(name).values(), ...this.stateBucket(name).values(), ...[...this.runBucket(name).values()].map(value => value.line)];
        if (live.length === 0) { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
        else writeFileAtomic(path, live.join("\n") + "\n", { mode: 0o600 });
        const file = this.file(name); file.lines = live.length; file.clean = true;
      }
    }
    if (Math.max(committed ?? 0, this.highestTag) >= Number.MAX_SAFE_INTEGER) throw new JournalWriteError("routines.json", "tag-exhausted", 0, new Error("Commit tag range exhausted"));
    this.establishBaseline(committed);
    return all;
  }

  /** Revalidating an existing marker also covers a new process after a pin's ambiguous directory-sync failure. */
  private establishBaseline(committed: number | undefined): void {
    let stage = "baseline-read";
    try {
      let original: Record<string, unknown> = {};
      try { original = JSON.parse(readFileSync(this.document, "utf8")) as Record<string, unknown>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("routines.json is not an object");
      const existing = routinesCommit(original);
      const baseline = committed ?? Math.max(existing ?? 0, this.highestTag);
      if (baseline >= Number.MAX_SAFE_INTEGER) throw new JournalWriteError("routines.json", "tag-exhausted", 0, new Error("Commit tag range exhausted"));
      if (existing !== baseline || this.pinFailed) {
        stage = "baseline-pin";
        mkdirSync(dirname(this.document), { recursive: true, mode: 0o700 });
        writeFileAtomic(this.document, JSON.stringify({ ...original, runsCommit: baseline }, null, 2), { mode: 0o600, syncDir: true });
      } else {
        // No rename or projection change: an established reader leaves inode/mtime ownership intact.
        stage = "baseline-barrier";
        const fd = openSync(this.document, "r+");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        syncParentDirectory(this.document);
      }
      this.pinFailed = false; this.baselineCommit = baseline;
    } catch (cause) {
      this.pinFailed = true;
      if (cause instanceof JournalWriteError) throw cause;
      throw new JournalWriteError("routines.json", stage, 0, cause);
    }
  }

  /** Progress uses byte offsets, including multibyte strings and torn-tail separators. */
  private writeAll(fd: number, body: string, name: string, stage: string): void {
    const buffer = Buffer.from(body, "utf8");
    let offset = 0;
    try {
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset, null);
        if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) throw new Error("Invalid write progress");
        offset += written;
      }
    } catch (cause) { throw new JournalWriteError(name, stage, offset, cause); }
  }

  private writeAppends(appends: Map<string, string[]>, targets: Map<string, Map<string, string>>, states: Map<string, string>, changed: Map<string, PersistedRun>, removed: Map<string, RunLike>): number {
    // Register the entire attempted set before even mkdir, including removal-only files.
    for (const name of appends.keys()) this.file(name);
    let filename = appends.keys().next().value ?? "", stage = "mkdir", bytesWritten = 0, written = 0;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const [name, lines] of appends) {
        filename = name; stage = "open"; bytesWritten = 0;
        const state = this.file(name), body = (state.clean ? "" : "\n") + lines.join("\n") + "\n";
        const fd = openSync(join(this.dir, name), "a", 0o600);
        try {
          stage = "write"; this.writeAll(fd, body, name, stage); bytesWritten = Buffer.byteLength(body);
          stage = "fsync"; fsyncSync(fd);
        } finally { closeSync(fd); }
        state.lines += lines.length; state.clean = true; written += lines.length;
        this.work.journalLines += lines.length;
        if (this.counters) this.counters.journalLines += lines.length;
      }
    } catch (cause) {
      for (const name of appends.keys()) { const file = this.file(name); file.clean = false; file.linesKnown = false; this.abortCursor(name); }
      for (const [id, attempted] of targets) {
        const uncertain = this.uncertainTargets.get(id) ?? new Map<string, string>();
        for (const [name, routineId] of attempted) uncertain.set(name, routineId);
        this.uncertainTargets.set(id, uncertain);
        const value = changed.get(id) ?? this.persisted.get(id) ?? removed.get(id);
        if (value) this.setPersisted(id, { routineId: value.routineId, line: UNCERTAIN });
      }
      for (const id of states.keys()) { this.setState(id, undefined); this.uncertainStates.set(id, routineRunsFileName(id)); }
      if (cause instanceof JournalWriteError) throw cause;
      throw new JournalWriteError(filename, stage, bytesWritten, cause);
    }
    return written;
  }

  private ensureBaseline(): void {
    if (this.baselineCommit !== undefined) return;
    let document: Record<string, unknown> = {};
    try { document = JSON.parse(readFileSync(this.document, "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.load(routinesCommit(document), typeof document.stateGeneration === "string" ? document.stateGeneration : this.generation);
  }

  /** Incremental, untagged durability. Visits only declared changes and touched-file buckets. */
  append(input: { runs: readonly RunLike[]; routines: ReadonlyArray<{ id: string }>; removed: readonly RunLike[] }): number {
    this.ensureBaseline();
    if (this.pendingCommit !== undefined) throw new JournalWriteError("routines.json", "recovery-required", 0, undefined);
    if (input.routines.length && this.generation === undefined) throw new Error("routine state lines need a routines.json generation");
    return this.persist(input.runs, input.routines, input.removed);
  }

  private receiptBucket(name: string): Map<string, string> {
    let bucket = this.receiptLinesByFile.get(name);
    if (!bucket) this.receiptLinesByFile.set(name, bucket = new Map());
    return bucket;
  }
  private setReceiptLine(name: string, id: string, line: string): void {
    const bucket = this.receiptBucket(name);
    if (!bucket.has(id)) this.file(name).live++;
    bucket.set(id, line);
  }
  private rememberReceipt(name: string, id: string, value: Record<string, unknown> | null): void {
    if (value === null && !this.baselineReceipts.has(id)) {
      this.requestReceipts.delete(id);
      if (this.receiptBucket(name).delete(id)) this.file(name).live--;
      return;
    }
    this.requestReceipts.set(id, value);
    this.setReceiptLine(name, id, JSON.stringify({ $proposal: 1, $gen: this.generation, $receipt: { requestId: id, value } }));
  }
  /** One fsynced line is the atomic unit for a proposal's definition, live
   * runs and keyed receipt. Receipt-free commitScoped retains its own guard. */
  proposal(input: { routineId: string; routine?: { id: string }; receiptId: string; receipt: object | null; runs?: readonly RunLike[]; removed?: readonly RunLike[] }): void {
    this.ensureBaseline();
    if (this.pendingCommit !== undefined || this.generation === undefined) throw new Error("Proposal requires a published journal generation");
    const name = routineRunsFileName(input.routineId);
    if (input.routine && input.routine.id !== input.routineId || [...(input.runs ?? []), ...(input.removed ?? [])].some(run => routineRunsFileName(run.routineId) !== name)) throw new Error("Proposal escaped its journal file");
    const line = JSON.stringify({ $proposal: 1, $gen: this.generation, $receipt: { requestId: input.receiptId, value: input.receipt }, ...(input.routine ? { $routine: input.routine } : {}), $runs: input.runs ?? [], $removed: (input.removed ?? []).map(run => run.id) });
    const targets = new Map<string, Map<string, string>>(), changed = new Map<string, PersistedRun>(), removed = new Map<string, RunLike>(), states = new Map<string, string>();
    for (const run of input.runs ?? []) { targets.set(run.id, new Map([[name, run.routineId]])); changed.set(run.id, { routineId: run.routineId, line: JSON.stringify(run) }); }
    for (const run of input.removed ?? []) { targets.set(run.id, new Map([[name, run.routineId]])); removed.set(run.id, run); }
    if (input.routine) states.set(input.routine.id, routineLine(JSON.stringify(input.routine), this.generation));
    try { this.writeAppends(new Map([[name, [line]]]), targets, states, changed, removed); }
    catch (error) { this.uncertainReceipts.add(name); throw error; }
    this.rememberReceipt(name, input.receiptId, input.receipt as Record<string, unknown> | null);
    this.uncertainReceipts.delete(name);
    for (const [id, value] of changed) { this.setPersisted(id, value); this.uncertainTargets.delete(id); }
    for (const id of removed.keys()) { this.setPersisted(id, undefined); this.uncertainTargets.delete(id); }
    for (const [id, state] of states) { this.setState(id, state); this.uncertainStates.delete(id); }
    // A receipt absent from the base needs no tombstone in a replacement:
    // compaction omits both intent and delete. A receipt-only empty file can
    // be retired immediately after its durable deletion, without a scan.
    if (this.file(name).live === 0 && !this.uncertainReceipts.has(name)) {
      this.abortCursor(name);
      try { unlinkSync(join(this.dir, name)); syncParentDirectory(join(this.dir, name)); this.files.delete(name); this.receiptLinesByFile.delete(name); }
      catch (error) { this.lastCompactionError = error; this.work.compactFaults++; }
      return;
    }
    // Compaction copies only a fixed slice and retains live receipt records.
    try { this.compactFile(name, [line]); } catch (error) { this.lastCompactionError = error; this.work.compactFaults++; this.abortCursor(name); }
  }

  private persist(runs: readonly RunLike[], routines: ReadonlyArray<{ id: string }>, removals: readonly RunLike[], tag?: number): number {
    const appends = new Map<string, string[]>(), changed = new Map<string, PersistedRun>(), states = new Map<string, string>(), removed = new Map<string, RunLike>();
    const targets = new Map<string, Map<string, string>>();
    const addFile = (name: string, line: string) => {
      const stamped = tag === undefined ? line : `${line.slice(0, -1)},"$c":${tag}}`;
      (appends.get(name) ?? appends.set(name, []).get(name)!).push(stamped);
    };
    const target = (id: string, routineId: string) => { const name = routineRunsFileName(routineId); (targets.get(id) ?? targets.set(id, new Map()).get(id)!).set(name, routineId); };
    const tombstones = new Set<string>();
    const removeFrom = (id: string, name: string, routineId: string) => {
      const key = JSON.stringify([id, name]);
      target(id, routineId);
      if (!tombstones.has(key)) { tombstones.add(key); addFile(name, JSON.stringify({ $del: id })); }
    };
    const byRoutine = new Map<string, string[]>();
    for (const run of runs) {
      const value = { routineId: run.routineId, line: JSON.stringify(run) }, old = this.persisted.get(run.id);
      if ((old?.line === value.line || old?.view === value.line) && !this.uncertainTargets.has(run.id)) continue;
      target(run.id, run.routineId);
      if (old && routineRunsFileName(old.routineId) !== routineRunsFileName(run.routineId)) removeFrom(run.id, routineRunsFileName(old.routineId), old.routineId);
      for (const [name, routineId] of this.uncertainTargets.get(run.id) ?? []) if (name !== routineRunsFileName(run.routineId)) removeFrom(run.id, name, routineId);
      changed.set(run.id, value);
      (byRoutine.get(run.routineId) ?? byRoutine.set(run.routineId, []).get(run.routineId)!).push(run.id);
    }
    const carried = new Set<string>();
    for (const routine of routines) {
      const state = routineLine(JSON.stringify(routine), this.generation!), ids = byRoutine.get(routine.id) ?? [];
      if (!ids.length && this.routineLines.get(routine.id) === state && !this.uncertainStates.has(routine.id)) continue;
      states.set(routine.id, state);
      for (const id of ids) carried.add(id);
      addFile(routineRunsFileName(routine.id), ids.length ? `${state.slice(0, -1)},"$runs":[${ids.map(id => changed.get(id)!.line).join(",")}]}` : state);
    }
    for (const [id, value] of changed) if (!carried.has(id)) addFile(routineRunsFileName(value.routineId), value.line);
    for (const run of removals) {
      removed.set(run.id, run);
      const old = this.persisted.get(run.id);
      if (old) removeFrom(run.id, routineRunsFileName(old.routineId), old.routineId);
      for (const [name, routineId] of this.uncertainTargets.get(run.id) ?? []) removeFrom(run.id, name, routineId);
    }
    if (!appends.size) return 0;
    const written = this.writeAppends(appends, targets, states, changed, removed);
    for (const [id, value] of changed) { this.setPersisted(id, value); this.uncertainTargets.delete(id); }
    for (const id of removed.keys()) { this.setPersisted(id, undefined); this.uncertainTargets.delete(id); }
    for (const [id, line] of states) { this.setState(id, line); this.uncertainStates.delete(id); }
    if (tag === undefined) for (const [name, lines] of appends) {
      try { this.compactFile(name, lines); }
      catch (cause) { this.lastCompactionError = cause; this.work.compactFaults++; this.abortCursor(name); }
    }
    return written;
  }

  /** Full traversal is restricted to owner/lifecycle recovery, never a scoped retry. */
  sync(runs: readonly RunLike[], tag?: number): number {
    this.ensureBaseline();
    if (tag !== undefined) {
      if (!Number.isSafeInteger(tag) || tag <= this.baselineCommit! || (tag <= this.highestTag && tag !== this.pendingCommit)) throw new JournalWriteError("routines.json", "invalid-tag", 0, undefined);
      this.highestTag = Math.max(this.highestTag, tag); this.pendingCommit = tag;
    } else if (this.pendingCommit !== undefined) throw new JournalWriteError("routines.json", "recovery-required", 0, undefined);
    this.abortCursors(); this.work.fullTraversals++;
    const next = new Set(runs.map(run => run.id)), removed: RunLike[] = [];
    for (const [id, old] of this.persisted) if (!next.has(id)) removed.push({ id, routineId: old.routineId });
    const written = this.persist(runs, [], removed, tag);
    if (tag === undefined) this.compact();
    return written;
  }

  markCommitted(tag: number): void {
    if (!Number.isSafeInteger(tag) || tag < (this.baselineCommit ?? 0)) throw new Error("Invalid published journal commit");
    this.baselineCommit = tag;
    if (this.pendingCommit !== undefined && tag >= this.pendingCommit) this.pendingCommit = undefined;
  }
  setGeneration(generation: string, receiptIds: Iterable<string> = []): void {
    this.abortCursors(); this.generation = generation;
    for (const id of this.routineLines.keys()) this.setState(id, undefined);
    this.uncertainStates.clear();
    for (const [name, bucket] of this.receiptLinesByFile) this.file(name).live -= bucket.size;
    this.receiptLinesByFile.clear(); this.requestReceipts.clear(); this.uncertainReceipts.clear();
    this.baselineReceipts.clear(); for (const id of receiptIds) this.baselineReceipts.add(id);
  }
  hasRoutineLines(): boolean { return this.routineLines.size > 0 || this.uncertainStates.size > 0 || this.requestReceipts.size > 0; }

  private safeToCompact(name: string): boolean {
    const file = this.file(name);
    return this.pendingCommit === undefined && !this.uncertainReceipts.has(name) && file.clean && file.linesKnown;
  }
  private atomicCompact(name: string, body: string): void {
    writeFileAtomic(join(this.dir, name), body, { mode: 0o600, ops: {
      write: ((fd: number, data: string) => this.writeAll(fd, data, name, "compact-write")) as typeof import("node:fs").writeFileSync,
    } });
  }
  private compactFile(name: string, mirrored: readonly string[] = []): void {
    const file = this.file(name);
    if (!this.safeToCompact(name)) return;
    let cursor = this.cursors.get(name);
    if (!cursor && file.lines <= 2 * file.live + 50) return;
    if (!cursor && file.live <= SYNC_COPY_LIMIT) {
      const keep: string[] = [];
      for (const line of this.receiptBucket(name).values()) keep.push(line);
      for (const line of this.stateBucket(name).values()) keep.push(line);
      for (const value of this.runBucket(name).values()) keep.push(value.line);
      this.work.compactCopied += keep.length;
      if (this.counters) this.counters.compactCopied += keep.length;
      this.atomicCompact(name, keep.length ? keep.join("\n") + "\n" : "");
      file.lines = keep.length; file.clean = true;
      return;
    }
    if (!cursor) {
      const path = join(this.dir, `${name}.compact`), fd = openSync(path, "w", 0o600);
      cursor = { path, fd, runs: labelWorkCollection(`journal.runs:${name}`, this.runBucket(name).entries()), states: labelWorkCollection(`journal.states:${name}`, this.stateBucket(name).entries()), stateDone: false, receipts: this.receiptBucket(name).entries(), receiptDone: false, lines: 0 };
      this.cursors.set(name, cursor);
    } else if (mirrored.length) {
      this.writeAll(cursor.fd, mirrored.join("\n") + "\n", name, "compact-mirror");
      cursor.lines += mirrored.length;
      this.work.journalLines += mirrored.length;
      if (this.counters) this.counters.journalLines += mirrored.length;
    }
    const copied: string[] = [];
    let done = false;
    for (let visits = 0; visits < COPY_SLICE; visits++) {
      if (!cursor.receiptDone) {
        const entry = cursor.receipts.next();
        if (!entry.done) { const current = this.receiptBucket(name).get(entry.value[0]); if (current !== undefined) copied.push(current); continue; }
        cursor.receiptDone = true;
      }
      if (!cursor.stateDone) {
        const entry = cursor.states.next();
        if (!entry.done) { const current = this.stateBucket(name).get(entry.value[0]); if (current !== undefined) copied.push(current); continue; }
        cursor.stateDone = true;
      }
      const entry = cursor.runs.next();
      if (entry.done) { done = true; break; }
      const current = this.runBucket(name).get(entry.value[0]);
      if (current !== undefined) copied.push(current.line);
    }
    if (copied.length) { this.writeAll(cursor.fd, copied.join("\n") + "\n", name, "compact-copy"); cursor.lines += copied.length; this.work.compactCopied += copied.length; if (this.counters) this.counters.compactCopied += copied.length; }
    if (!done) return;
    fsyncSync(cursor.fd); closeSync(cursor.fd);
    // Remove the closed cursor before rename so cleanup never closes a reused descriptor.
    this.cursors.delete(name);
    try { renameWithRetry(cursor.path, join(this.dir, name)); }
    catch (cause) { try { unlinkSync(cursor.path); } catch { /* best effort */ } throw cause; }
    file.lines = cursor.lines; file.clean = true;
  }

  /** Explicit lifecycle compaction may traverse all files. Pending tags stay tagged until publication. */
  compact(): void {
    this.abortCursors();
    if (this.pendingCommit !== undefined) {
      // Compatibility for lifecycle callers predating markCommitted: check the actual publication.
      const committed = routinesCommit(JSON.parse(readFileSync(this.document, "utf8")));
      if (committed !== undefined && committed >= this.pendingCommit) this.markCommitted(committed);
      else return;
    }
    this.work.fullTraversals++;
    for (const [name, file] of this.files) {
      if (!file.linesKnown || !file.clean) {
        // A full lifecycle sync has resolved all logical uncertainty before rewriting unknown tails.
        if (this.uncertainTargets.size || this.uncertainStates.size || this.uncertainReceipts.size) continue;
        const keep = [...this.receiptBucket(name).values(), ...this.stateBucket(name).values(), ...[...this.runBucket(name).values()].map(value => value.line)];
        this.atomicCompact(name, keep.length ? keep.join("\n") + "\n" : "");
        file.lines = keep.length; file.clean = file.linesKnown = true;
      } else if (file.live === 0) {
        try { unlinkSync(join(this.dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      } else {
        // Full compaction is lifecycle work; finish its bounded cursors here, never in append.
        do { this.compactFile(name); } while (this.cursors.has(name));
      }
    }
  }

  /** Diagnostic only: validates both directions before consumers trust a live count. */
  verifyFileIndexes(): string[] {
    const errors: string[] = [];
    if (this.count !== this.persisted.size) errors.push("persistedCount");
    for (const [id, value] of this.persisted) {
      const name = routineRunsFileName(value.routineId);
      if (this.persistedByFile.get(name)?.get(id) !== value) errors.push(`persistedByFile.membership:${id}`);
    }
    for (const [name, bucket] of this.persistedByFile) {
      if (!this.files.has(name)) errors.push(`files.membership:${name}`);
      for (const [id, value] of bucket) if (routineRunsFileName(value.routineId) !== name || this.persisted.get(id) !== value) errors.push(`persisted.membership:${id}`);
    }
    for (const [id, line] of this.routineLines) if (this.routineLinesByFile.get(routineRunsFileName(id))?.get(id) !== line) errors.push(`routineLinesByFile.membership:${id}`);
    for (const [name, bucket] of this.routineLinesByFile) {
      if (!this.files.has(name)) errors.push(`files.membership:${name}`);
      for (const [id, line] of bucket) if (routineRunsFileName(id) !== name || this.routineLines.get(id) !== line) errors.push(`routineLines.membership:${id}`);
    }
    for (const [name, file] of this.files) {
      if (file.live !== (this.persistedByFile.get(name)?.size ?? 0) + (this.routineLinesByFile.get(name)?.size ?? 0) + (this.receiptLinesByFile.get(name)?.size ?? 0)) errors.push(`files.live:${name}`);
      if (!Number.isSafeInteger(file.live) || file.live < 0 || !Number.isSafeInteger(file.lines) || file.lines < 0) errors.push(`files.count:${name}`);
    }
    for (const [id, targets] of this.uncertainTargets) {
      if (!this.persisted.has(id) || !targets.size) errors.push(`uncertainTargets.membership:${id}`);
      for (const [name, routineId] of targets) if (!this.files.has(name) || routineRunsFileName(routineId) !== name || this.files.get(name)!.linesKnown) errors.push(`uncertainTargets.file:${id}:${name}`);
    }
    for (const [id, name] of this.uncertainStates) if (this.routineLines.has(id) || !this.files.has(name) || routineRunsFileName(id) !== name) errors.push(`uncertainStates.membership:${id}`);
    return errors;
  }
  rebuildFileIndexes(): void {
    this.abortCursors();
    this.persistedByFile.clear(); this.routineLinesByFile.clear(); this.count = this.persisted.size;
    for (const file of this.files.values()) file.live = 0;
    for (const [id, value] of this.persisted) { const name = routineRunsFileName(value.routineId); this.file(name); this.runBucket(name).set(id, value); this.file(name).live++; }
    for (const [name, bucket] of this.receiptLinesByFile) this.file(name).live += bucket.size;
    for (const [id, line] of this.routineLines) { const name = routineRunsFileName(id); this.file(name); this.stateBucket(name).set(id, line); this.file(name).live++; }
  }
}

/** Rewrite every journal under `dataDir` with `change` applied to each
 * committed run (compacted, untagged, atomic per file). Restore preparation
 * uses it to suspend runs that were still pending when the backup was taken. */
export function mapRoutineRuns(dataDir: string, change: (run: Record<string, unknown>) => Record<string, unknown>, committed?: number): void {
  const dir = routineRunsDir(dataDir);
  for (const name of journalNames(dir)) {
    const path = join(dir, name);
    const parsed = parseJournal(readFileSync(path, "utf8"), committed);
    const runs = [...parsed.runs.values()].map(run => change(run));
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
  const moved = applyProposalProjection(doc, dataDir);
  if (moved > 0 || "stateGeneration" in doc) {
    const { stateGeneration: _spent, ...rest } = doc;
    writeFileAtomic(file, JSON.stringify(rest, null, 2), { mode: 0o600 });
  }
  const journals = journalNames(routineRunsDir(dataDir)).length;
  mapRoutineRuns(dataDir, run => run, committed);
  return { routines: moved, journals };
}

/** Read durable receipts without reconstructing unrelated definitions and run history. */
export function readRoutineRequestReceipts(file: string): Record<string, unknown>[] {
  return proposalReceiptProjection(JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>, dirname(file));
}

/** routines.json with its run history put back inline, the shape 0.1.61 wrote.
 * For tests and diagnostics; nothing in the app reads the file this way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readRoutinesWithRuns(file: string): Record<string, any> & { runs: any[] } {
  const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  applyProposalProjection(doc, dirname(file));
  const byId = new Map<string, Record<string, unknown>>();
  for (const run of readRoutineRuns(dirname(file), routinesCommit(doc))) byId.set(String((run as { id: string }).id), run as Record<string, unknown>);
  if (Array.isArray(doc.runs)) for (const run of doc.runs as Record<string, unknown>[]) byId.set(String(run.id), run);
  return { ...doc, runs: [...byId.values()] };
}
