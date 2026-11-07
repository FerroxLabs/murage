// SPDX-License-Identifier: AGPL-3.0-or-later
// Murage for Chrome activity log (spec section 5, tests F12). One line per
// browser action: when, site, action kind, target label, level, decision, who
// decided and outcome. Never a typed value, a field value or a secret: the
// record shape is a fixed allowlist, typed text is kept as a length only, and
// every string is cleaned and capped. Lives in the data folder under browser-extension/
// activity/<bindingId>.ndjson, inside the reserved browser-extension component
// that a backup never takes and a restore refuses.
import { randomUUID } from "node:crypto";
import { type BigIntStats, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { renameWithRetry, syncParentDirectory, writeFileAtomic } from "./atomic.ts";
import { redactPageOutput } from "./browser-output-redaction.ts";

export const ACTIVITY_MAX_LINES = 2000;
export const ACTIVITY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVITY_MAX_LINE_BYTES = 512;
/** The file is compacted once it holds this many lines over the cap, so a busy task does not rewrite it on every action. */
const COMPACT_SLACK = 100;

export const ACTIVITY_DECISIONS = ["free", "allowed for this task", "you allowed", "you denied", "your turn", "not done", "Full permissive", "intent card"] as const;
export const ACTIVITY_DECIDERS = ["owner", "grant", "full-permissive", "policy", "checker"] as const;
export const ACTIVITY_OUTCOMES = ["done", "failed", "denied", "waiting", "handed over"] as const;

export type BrowserActivityDecision = typeof ACTIVITY_DECISIONS[number];
export type BrowserActivityDecider = typeof ACTIVITY_DECIDERS[number];
export type BrowserActivityOutcome = typeof ACTIVITY_OUTCOMES[number];

/** What a caller hands over. Extra keys are ignored, so a typed value passed by mistake is never written. */
export type BrowserActivityInput = {
  /** A refusal's identity, chosen by the caller so its fallback line can carry the same id: the reader keeps the first record per id. */
  id?: string;
  botId: string; bindingId: string; taskId: string;
  site: string; action: string; target?: string;
  /** True when the target label came from the page, not from Murage. */
  fromPage?: boolean;
  level: 1 | 2 | 3;
  decision: BrowserActivityDecision;
  decidedBy?: BrowserActivityDecider;
  outcome?: BrowserActivityOutcome;
  /** Length of text typed, never the text. */
  textLength?: number;
  routine?: boolean;
};
export type BrowserActivityLine = {
  at: number; botId: string; bindingId: string; taskId: string; site: string; action: string; target: string; fromPage: boolean;
  level: 1 | 2 | 3; decision: BrowserActivityDecision; decidedBy: BrowserActivityDecider; outcome: BrowserActivityOutcome;
  textLength?: number; routine?: true;
  /** Unique per record (older lines have none): the reader keeps the first record per id. */
  id?: string;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);
/** Control, bidi and zero-width characters out, whitespace collapsed, cut by code point. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  return [...text].slice(0, max).join("");
}

function build(input: BrowserActivityInput, at: number): BrowserActivityLine | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (![input.botId, input.bindingId, input.taskId].every(v => typeof v === "string" && ID.test(v))) return undefined;
  if (input.level !== 1 && input.level !== 2 && input.level !== 3) return undefined;
  if (!oneOf(ACTIVITY_DECISIONS, input.decision)) return undefined;
  if (input.decidedBy !== undefined && !oneOf(ACTIVITY_DECIDERS, input.decidedBy)) return undefined;
  if (input.outcome !== undefined && !oneOf(ACTIVITY_OUTCOMES, input.outcome)) return undefined;
  // Page-derived strings (the site, the target label) pass the shared page-output redaction before they are cleaned and capped.
  const action = clean(input.action, 40), site = clean(redactPageOutput(typeof input.site === "string" ? input.site : ""), 80);
  if (!action) return undefined;
  const line: BrowserActivityLine = {
    at, botId: input.botId, bindingId: input.bindingId, taskId: input.taskId, site, action,
    target: clean(redactPageOutput(typeof input.target === "string" ? input.target : ""), 80), fromPage: input.fromPage === true,
    level: input.level, decision: input.decision, decidedBy: input.decidedBy ?? "policy", outcome: input.outcome ?? "done", id: typeof input.id === "string" && UUID.test(input.id) ? input.id : randomUUID(),
  };
  if (Number.isSafeInteger(input.textLength) && input.textLength! >= 0) line.textLength = Math.min(input.textLength!, 1_000_000);
  if (input.routine === true) line.routine = true;
  // Fit the line budget (the newline counts): shorten the free-text fields, never the ids.
  const size = () => Buffer.byteLength(JSON.stringify(line)) + 1;
  while (size() > ACTIVITY_MAX_LINE_BYTES && line.target.length > 0) line.target = [...line.target].slice(0, Math.max(0, [...line.target].length - 8)).join("");
  while (size() > ACTIVITY_MAX_LINE_BYTES && line.site.length > 0) line.site = [...line.site].slice(0, Math.max(0, [...line.site].length - 8)).join("");
  return size() <= ACTIVITY_MAX_LINE_BYTES ? line : undefined;
}

/** How many times a record is written again because its file was moved aside under it. */
const MAX_MOVED_RETRIES = 3;
/** How many times a reader reads the log before it accepts a result while a compaction keeps moving it. */
const MAX_READS = 3;

/** True only for a real match. Bigint: an NTFS file id needs 64 bits. A file id of 0 identifies nothing (some file systems report it). */
export function sameFile(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean { return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino; }

/** Append one record as ONE O_APPEND write of "\n" + json + "\n". The leading newline ends whatever torn line lies before it (a failed
 *  append, a crash, another process), so the record is always a line of its own and nothing needs to read the file's tail first. A short
 *  write is a failure (never continued; the caller retries the whole record); a close failure after a full write is ignored. Returns whether
 *  the file written is still the one at `path`, checked after the write and before the close, so a freed file id cannot be reused and match.
 *  False when in doubt: the caller then reads the log to see, because a record left in a moved file is lost. */
export function appendLine(path: string, json: string, io: { write: typeof writeSync; close: typeof closeSync; sync?: typeof fsyncSync; same?: typeof sameFile } = { write: writeSync, close: closeSync }): boolean {
  const fd = openSync(path, "a", 0o600);
  try {
    // One write call. A short write is a failure, never continued: a continuation could land after another process's record and split
    // both. The caller retries the whole record, whose leading newline ends the torn piece, and the id keeps the reader to one copy.
    const bytes = Buffer.from("\n" + json + "\n");
    const n = io.write(fd, bytes, 0, bytes.length);
    if (n !== bytes.length) throw new Error("activity append was short");
    io.sync?.(fd);
    try { return (io.same ?? sameFile)(fstatSync(fd, { bigint: true }), statSync(path, { bigint: true })); } catch { return false; }
  } finally {
    // A failing close after a full write must not turn a complete append into a failure.
    try { io.close(fd); } catch { /* the line is already written */ }
  }
}

function parse(raw: string, cutoff: number): BrowserActivityLine | undefined {
  try {
    const value = JSON.parse(raw) as BrowserActivityLine;
    if (!value || typeof value !== "object" || !Number.isFinite(value.at) || value.at < cutoff) return undefined;
    if (![value.botId, value.bindingId, value.taskId].every(v => typeof v === "string" && ID.test(v))) return undefined;
    return value;
  } catch { return undefined; }
}

/** `<bindingId>.ndjson.<uuid>.aside`: a log file moved aside by a compaction. A binding id holds no dot, so the id is exact. */
const ASIDE = /^([A-Za-z0-9_-]{1,128})\.ndjson\.[0-9a-f-]{36}\.aside$/;
type StoreIo = NonNullable<Parameters<typeof appendLine>[2]> & { afterMoveAside?: (moved: boolean) => void; beforeCopy?: () => void; landed?: () => boolean; rm?: typeof rmSync; writeMark?: typeof writeFileAtomic; syncFolder?: typeof syncParentDirectory; beforeRead?: (path: string) => void; beforeRelist?: () => void };
const recordKey = (line: BrowserActivityLine) => typeof line.id === "string" ? line.id : JSON.stringify(line);

export class BrowserActivityStore {
  private readonly dir: string;
  private readonly now: () => number;
  /** Lines in each file, read once then counted as they are written. */
  private counts = new Map<string, number>();
  private readonly io?: StoreIo;
  /** `io` is for tests only: it replaces the file calls of an append, and marks the moments of a compaction a test races against. */
  constructor(dir: string, now: () => number = Date.now, io?: StoreIo) { this.dir = dir; this.now = now; this.io = io; }

  private file(bindingId: string) { return join(this.dir, `${bindingId}.ndjson`); }
  /** Files a compaction moved aside and has not finished with: a crash leaves them here, and they are still part of the log. */
  private asides(bindingId: string): string[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    return names.filter(name => ASIDE.exec(name)?.[1] === bindingId).map(name => join(this.dir, name));
  }
  /** Parsed records of these files in order, one per id (or per exact line, for older lines with no id). A file gone since the listing is
   *  skipped, because whoever removed it had already copied it; any other read failure throws, so nothing unread is ever deleted.
   *  A deleted binding has no records, whatever is on disk, so a compaction removes them. */
  private parseFiles(bindingId: string, paths: string[], onGone?: (path: string) => void): BrowserActivityLine[] {
    const cutoff = this.now() - ACTIVITY_MAX_AGE_MS, seen = new Set<string>(), out: BrowserActivityLine[] = [];
    if (this.deleted(bindingId)) return out;
    for (const path of paths) {
      let text: string;
      this.io?.beforeRead?.(path);
      try { text = readFileSync(path, "utf8"); } catch (error) { if ((error as { code?: unknown } | null)?.code === "ENOENT") { onGone?.(path); continue; } throw error; }
      // Blank and torn lines are skipped; the first record per id wins (an id seen twice is one record written twice).
      for (const raw of text.split("\n")) {
        const line = raw ? parse(raw, cutoff) : undefined;
        if (!line || line.bindingId !== bindingId) continue;
        const key = recordKey(line);
        if (seen.has(key)) continue;
        seen.add(key); out.push(line);
      }
    }
    return out;
  }
  private logStat(path: string): BigIntStats | undefined {
    try { return statSync(path, { bigint: true }); } catch (error) { if ((error as { code?: unknown } | null)?.code === "ENOENT") return undefined; throw error; }
  }
  /** A compaction can move the log between listing the asides and reading it, so its records would be in neither. That shows as a different
   *  log after the read than before the listing (birthtime too, because two compactions can bring a freed file id back; no log and then a
   *  log counts as different), as an aside that was not listed, or as a listed aside that has gone: then list and read again. After
   *  MAX_READS the last result stands, so a third unstable read can hide a record for that one read only; the record is still on disk and
   *  the next read shows it. */
  private read(bindingId: string): BrowserActivityLine[] {
    const log = this.file(bindingId), same = this.io?.same ?? sameFile;
    const sameLog = (a: BigIntStats | undefined, b: BigIntStats | undefined) => a && b ? same(a, b) && a.birthtimeNs === b.birthtimeNs : !a && !b;
    let out: BrowserActivityLine[] = [];
    for (let reads = 0; reads < MAX_READS; reads++) {
      const before = this.logStat(log), asides = this.asides(bindingId), listed = new Set(asides);
      let asideGone = false;
      out = this.parseFiles(bindingId, [...asides, log], path => { if (path !== log) asideGone = true; });
      const after = this.logStat(log);
      const stable = !asideGone && sameLog(before, after);
      this.io?.beforeRelist?.();
      // The log is looked at once more after the listing: a compaction creates the log before it removes its asides, so a clean listing with a new log is a change.
      if (stable && this.asides(bindingId).every(aside => listed.has(aside)) && sameLog(after, this.logStat(log))) break;
    }
    return out;
  }
  /** Deletion marks have a folder of their own, so the log folder a reader lists does not grow with every binding ever retired. */
  private get marks() { return join(this.dir, "deleted"); }
  /** A deleted binding's mark: an empty file, kept for good. Binding ids are never used again (a new one is a random UUID), so its being
   *  there is the whole fact: every record of that id stays hidden wherever it turns up, so a copy or a late write by another process
   *  cannot bring it back. Nothing removes a mark, because no check that its records are gone can hold until the mark is removed. */
  private deletedMark(bindingId: string) { return join(this.marks, bindingId); }
  private deleted(bindingId: string): boolean { return existsSync(this.deletedMark(bindingId)); }
  private get syncFolder() { return this.io?.syncFolder ?? syncParentDirectory; }
  /** Throws unless the mark and the marks folder are safe against a power cut. Nothing is removed because of a mark until this has passed:
   *  a mark another process has just written, or whose sync failed, could otherwise be lost while the removal is not. Where the OS or file
   *  system offers no folder sync, syncParentDirectory skips it, by ruling: failing closed would leave a log that can never be deleted. */
  private syncMark(bindingId: string): void { this.syncFolder(this.deletedMark(bindingId)); this.syncFolder(this.marks); }
  /** Shortens the log without ever overwriting or removing bytes of the append path, so no process can lose a record, with no lock:
   *  1. The log is renamed to a private aside name. An append after this creates a new log file, and nothing replaces that file.
   *  2. The asides are read, and what is kept is appended to the log and synced, its folder too (the copy may have just created the file).
   *     Only once that copy is confirmed are the asides removed. If the asides are dropped because of a mark, the mark is synced first.
   *  This holds against process crashes and other processes. A plain append is not synced, so a power cut can lose the most recent lines.
   *  Every write to the log, an appender's or this copy, is confirmed AFTER the write: its file is still the log, or the log read back holds
   *  it. Confirmed at that moment: any later rename comes after the write, and whoever renames reads after renaming, so they read it. Not
   *  confirmed: the write may be in a file nobody will read, so an appender writes again (the id keeps it to one) and a compaction stops
   *  with its sources in place for the next one. So a source is only removed once its records are confirmed in the log, an aside gone at
   *  read time was already copied, and a crash leaves an aside that the reader still reads and the next compaction takes. */
  private compact(bindingId: string): void {
    const path = this.file(bindingId);
    let moved = true;
    try { renameWithRetry(path, `${path}.${randomUUID()}.aside`); } catch (error) { if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw error; moved = false; }
    this.io?.afterMoveAside?.(moved);
    const asides = this.asides(bindingId);
    const kept = this.parseFiles(bindingId, asides).sort((a, b) => a.at - b.at).slice(-ACTIVITY_MAX_LINES);
    this.io?.beforeCopy?.();
    if (kept.length && !appendLine(path, kept.map(line => JSON.stringify(line)).join("\n"), { write: this.io?.write ?? writeSync, close: this.io?.close ?? closeSync, sync: fsyncSync, same: this.io?.same })) {
      const inLog = new Set(this.parseFiles(bindingId, [path]).map(recordKey));
      if (!kept.every(line => inLog.has(recordKey(line)))) throw new Error("activity compaction copy is not confirmed");
    }
    // A failed sync throws, so the sources stay for the next compaction. Kept nothing and not marked: only expired lines go, with nothing to protect.
    if (kept.length) this.syncFolder(path);
    else if (this.deleted(bindingId)) this.syncMark(bindingId);
    for (const aside of asides) rmSync(aside, { force: true });
    if (kept.length) this.counts.set(bindingId, kept.length); else this.counts.delete(bindingId);
  }

  /** Best effort: a log failure must never stop or fail a browser action. True means written to the file; it is not synced per action, so a power cut can lose the most recent lines. */
  record(input: BrowserActivityInput): boolean {
    let line: BrowserActivityLine | undefined;
    try {
      line = build(input, this.now());
      if (!line) return false;
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch { return false; }
    // The record carries its own id. If an append fails part way, the outcome is ambiguous (the json may have landed with only the
    // trailing newline missing), so the file is checked for the id: found = written (true), not found = one retry with the same id.
    // The reader keeps the first record per id, so a retry after a landed record shows one line, and a caller never adds a duplicate.
    const path = this.file(line.bindingId), json = JSON.stringify(line);
    // "Found" means a line the reader accepts (parsed, with this id), not a substring: a record cut off after its id does not count.
    const cutoff = this.now() - ACTIVITY_MAX_AGE_MS, wanted = line.id;
    const landed = () => { if (this.io?.landed) return this.io.landed(); try { return readFileSync(path, "utf8").split("\n").some(raw => raw.includes(`"id":"${wanted}"`) && parse(raw, cutoff)?.id === wanted); } catch { return false; } };
    // Done once the record is in the log file as of now, by appendLine's check or seen there by landed(): a later compaction reads it
    // wherever the log moves next. See compact() for why this check is what keeps a record from being lost.
    for (let failures = 0, moved = 0; ;) {
      try {
        if (appendLine(path, json, this.io) || landed()) break;
        if (++moved > MAX_MOVED_RETRIES) return false;
      } catch {
        if (landed()) break;
        if (++failures > 1) return false;
      }
    }
    // The line is on disk: `true` means "written", and the counting and compaction after it are best effort. A failure there must not
    // report the line as lost (a caller that wrote it would add a second one).
    try {
      const count = (this.counts.get(line.bindingId) ?? this.read(line.bindingId).length - 1) + 1;
      this.counts.set(line.bindingId, count);
      if (count > ACTIVITY_MAX_LINES + COMPACT_SLACK) this.compact(line.bindingId);
    } catch { this.counts.delete(line.bindingId); }
    return true;
  }

  /** Oldest first. Always scoped to one bot, so a binding id of another bot's shows nothing. */
  list(query: { botId: string; bindingId?: string; taskId?: string }): BrowserActivityLine[] {
    try {
      if (!ID.test(query.botId)) return [];
      if (query.bindingId !== undefined && !ID.test(query.bindingId)) return [];
      if (query.taskId !== undefined && !ID.test(query.taskId)) return [];
      const ids = query.bindingId ? [query.bindingId] : this.bindingIds();
      const out: BrowserActivityLine[] = [];
      for (const id of ids) for (const line of this.read(id)) if (line.botId === query.botId && (!query.taskId || line.taskId === query.taskId)) out.push(line);
      out.sort((a, b) => a.at - b.at);
      return out.slice(-ACTIVITY_MAX_LINES);
    } catch { return []; }
  }

  /** Called when a binding is removed: its log goes with it. False: the mark could not be written or made safe against a power cut, so
   *  nothing was removed and a retry is safe. True: the records are hidden for good; a file that could not be removed now goes at the next prune. */
  deleteBinding(bindingId: string): boolean {
    if (!ID.test(bindingId)) return false;
    // The mark goes first, before the files are listed, so a copy in flight in another process lands hidden. An empty file: nothing to rewrite.
    // The folders are synced every time, also for a mark already there: an earlier try may have failed at this step, and a mark lost to a
    // power cut with the records still on disk would bring them back. The second sync covers a marks folder this call has just made.
    try {
      mkdirSync(this.marks, { recursive: true, mode: 0o700 });
      if (!this.deleted(bindingId)) (this.io?.writeMark ?? writeFileAtomic)(this.deletedMark(bindingId), "", { mode: 0o600 });
      this.syncMark(bindingId);
    } catch { return false; }
    for (const path of [this.file(bindingId), ...this.asides(bindingId)]) { try { (this.io?.rm ?? rmSync)(path, { force: true }); } catch { /* the next prune */ } }
    this.counts.delete(bindingId);
    return true;
  }

  /** Drops lines past 30 days and files that are left empty, and takes back anything a crashed compaction left aside. Safe to run at start
   *  and on a timer. One binding's failure leaves that binding as it was and does not stop the others. */
  prune(): void {
    let ids: string[];
    try { ids = this.bindingIds(); } catch { return; }
    for (const id of ids) {
      try {
        const path = this.file(id);
        if (!existsSync(path) || statSync(path).isFile()) this.compact(id);
      } catch { this.counts.delete(id); }
    }
  }

  private bindingIds(): string[] {
    if (!existsSync(this.dir)) return [];
    const ids = new Set<string>();
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith(".ndjson") ? name.slice(0, -7) : ASIDE.exec(name)?.[1];
      if (id && ID.test(id)) ids.add(id);
    }
    return [...ids];
  }
}

let active: BrowserActivityStore | undefined;
/** index.ts sets the store once it knows the data folder; tests pass undefined to reset. */
export function configureBrowserActivity(store: BrowserActivityStore | undefined): void { active = store; }
export function browserActivityStore(): BrowserActivityStore | undefined { return active; }
/** The call later tasks make once per action. Returns false, and writes nothing, when the log is off or the entry is refused. */
export function recordBrowserActivity(input: BrowserActivityInput): boolean { return active ? active.record(input) : false; }
