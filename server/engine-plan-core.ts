// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The shared vocabulary of engine-history deletion: what a PLAN is, how a planner reads the world, and how it records what
// must change. Deletion is four separate stages (see engine-history-run.ts):
//
//   plan     all reads, no writes. Every engine body is a planner that asks `EngineFs` (the one strict reader) and emits
//            declarative steps through `Planner`. Nothing here can remove, rewrite or delete anything.
//   persist  the whole plan (and the ids it found) is saved with the pending deletion before the first step runs.
//   execute  the steps run, in plan order, each idempotent; a step is marked done as it finishes (engine-exec.ts). The executor
//            never discovers: a step carries what it was planned from, and if the world no longer matches the step is STALE:
//            nothing is changed and the home is planned again (the new plan is saved before the next execute).
//   verify   plan again. The deletion is finished only when a fresh, complete plan of EVERY home, made after the last execute
//            of this attempt, has no content step left. Nothing carries over from an earlier attempt as proof.
//
// This file and the planner files (engine-plan-acp.ts, engine-plan-files.ts) import no node:fs, node:sqlite or node:zlib and
// contain no try/catch: a read that fails throws PlanError out of EngineFs and the driver gives that home no plan at all.
// engine-plan-structure.test.ts keeps it that way.
import nodePath from "node:path";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { DeletionEngine, DeletionLeftover } from "./conversation-deletion.ts";

// ── path helpers shared by planners and the executor ────────────────────

export type PathApi = typeof nodePath.posix;

/** The path module a path is written for: a drive letter or UNC prefix is Windows. */
export function pathApiFor(path: string): PathApi {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? nodePath.win32 : process.platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** True only for a path strictly below `root` (never `root` itself). */
export function isStrictlyInside(root: string, target: string, api: PathApi = pathApiFor(root)): boolean {
  if (!api.isAbsolute(root) || !api.isAbsolute(target)) return false;
  const rel = api.relative(api.resolve(root), api.resolve(target));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${api.sep}`) && !api.isAbsolute(rel);
}

export function sameFolder(a: string, b: string): boolean {
  const api = pathApiFor(a);
  if (api === nodePath.win32) return nodePath.win32.normalize(a).toLowerCase() === nodePath.win32.normalize(b).toLowerCase();
  return nodePath.posix.normalize(a) === nodePath.posix.normalize(b);
}

// ── facts ────────────────────────────────────────────────────────────────

/** Named id sets one engine home's removal depends on (session ids, thread ids, slugs, the databases still owed a verified
 * checkpoint). Saved with the pending deletion and merged back in on every plan, so a retry never depends on files an earlier,
 * interrupted run already removed. */
export class Known {
  private readonly sets = new Map<string, Set<string>>();
  constructor(initial: Record<string, string[]> = {}) {
    for (const [name, values] of Object.entries(initial)) if (Array.isArray(values)) this.sets.set(name, new Set(values.filter((value) => typeof value === "string")));
  }
  get(name: string): Set<string> {
    let set = this.sets.get(name);
    if (!set) { set = new Set(); this.sets.set(name, set); }
    return set;
  }
  add(name: string, ...values: string[]): void { const set = this.get(name); for (const value of values) set.add(value); }
  toJSON(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [name, set] of this.sets) if (set.size) out[name] = [...set].sort();
    return out;
  }
}

// ── errors ───────────────────────────────────────────────────────────────

/** Something that exists could not be looked at (EIO, EACCES, EMFILE, a corrupt zstd frame or SQLite file, a line that names
 * the conversation but does not parse). The home it happened in gets no plan; nothing in it is touched. */
export class PlanError extends Error {
  readonly path: string;
  constructor(path: string, cause?: unknown) {
    const detail = (cause as NodeJS.ErrnoException | undefined)?.code ?? (cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause));
    super(`could not read ${path}${detail ? `: ${detail}` : ""}`);
    this.name = "PlanError";
    this.path = path;
    if (cause !== undefined) this.cause = cause;
  }
}

/** The world no longer matches what a step was planned from (a file changed, a folder gained a name, a database gained a child).
 * Nothing was changed by the step; the home is planned again. Not a failure and never shown to the owner by itself. */
export class StaleError extends Error {
  constructor(what: string) { super(`changed: ${what}`); this.name = "StaleError"; }
}

/** Why Murage did not touch an engine's file now, in one word (the message). open: the engine is running, or holds its lock. held: another
 * program has the file, or Murage's hold on it did not last. aside: the engine started a new file while Murage had the old one set aside.
 * unchecked: Murage could not tell whether the engine is running, or who has the file open (a process of the owner's whose open files
 * the system will not show). Not a failure of Murage's: the home stays pending, the owner is told which of the four it is
 * (conversation-deletion.ts), and it is tried again. */
export type OpenKind = "open" | "held" | "aside" | "unchecked";
export class EngineOpenError extends Error {
  readonly kind: OpenKind;
  readonly detail: string;
  constructor(kind: OpenKind, detail = "") { super(kind); this.name = "EngineOpenError"; this.kind = kind; this.detail = detail; }
}
/** The short reason a home carries for each kind of EngineOpenError. */
export const OPEN_REASON: Readonly<Record<OpenKind, string>> = { open: "engine-open", held: "held", aside: "aside", unchecked: "engine-unchecked" };

/** The native helper that takes real exclusion on an engine's file is missing or will not load: nothing is changed. */
export class HelperError extends Error {
  constructor() { super("helper"); this.name = "HelperError"; }
}

/** How many times the journal of an interrupted join counts that bytes were found after the older file's recorded end. Past it the
 * journal is no longer written again; nothing is ever cut, however often it is found so (engine-exec.ts undoJoin). */
export const UNDO_JOIN_TRIES = 3;

/** A folder that holds session ids is not deleted where it stands: it is renamed to this sibling first, listed again, and
 * removed only if it holds nothing the plan did not list. The name is fixed so a plan made after a crash still finds it. */
export const ASIDE_SUFFIX = ".murage-deleting";

/** What a deletion keeps and clears in each JSONL file an engine owns. A row that belongs to the conversation is NEVER removed, cut,
 * moved or replaced: its content is overwritten in place, byte for byte, so the row stays valid for the engine that reads it, the
 * file keeps its length, and a row another writer appends meanwhile can neither be cut nor skipped over.
 *   ids      the fields a row is matched by (session id, folder). They stay: an identifier is not the conversation's words.
 *   meta     timestamps, kinds, process ids, levels. They stay.
 *   content  words the conversation said (a message, a prompt, a title). A string is overwritten by spaces; any other value
 *            (object, array, number) is replaced whole by the empty value of its type, padded with spaces.
 *   payload  structured context an engine attaches to a row (it can hold text as keys, numbers or arrays). Replaced whole.
 * A field that is in none of these lists is CONTENT: when a field is unknown, it is cleared. A row is cleared when every
 * content and payload value is empty; a record clears only when a fresh plan of every home finds no row that is not. */
export interface JsonlFormat { ids: readonly string[]; meta: readonly string[]; content: readonly string[]; payload: readonly string[]; basis: string }
export const JSONL_FORMAT: Readonly<Record<string, JsonlFormat>> = {
  "fuigo-unified": { ids: ["sid"], meta: ["ts", "src", "pid", "ver", "lvl"], content: ["msg"], payload: ["ctx"], basis: "fuigo-telemetry unified_log.rs LogEntry: ts, src, pid, ver, lvl, sid, msg, ctx" },
  "claude-history": { ids: ["sessionId", "project"], meta: ["timestamp"], content: ["display"], payload: ["pastedContents"], basis: "Claude Code history.jsonl rows: display, pastedContents, timestamp, project, sessionId" },
  "codex-history": { ids: ["session_id"], meta: ["ts"], content: ["text"], payload: [], basis: "Codex message-history rows: session_id, ts, text" },
  "codex-session-index": { ids: ["id"], meta: ["updated_at"], content: ["thread_name"], payload: [], basis: "Codex session_index.jsonl rows: id (a thread UUID), thread_name, updated_at" },
  "kimi-session-index": { ids: ["sessionId", "workDir"], meta: ["sessionDir", "createdAt", "updatedAt", "timestamp"], content: ["title", "lastPrompt"], payload: [], basis: "Kimi session_index.jsonl rows: sessionId, sessionDir, workDir, title, lastPrompt and times" },
};

const SIMPLE_ESCAPE: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/** What a JSON string spells, from the text between its quotes: `\u0074` is `t`. Null for an escape JSON does not have. (Written out
 * rather than parsed so a planner needs no try.) */
function decodeJsonString(raw: string): string | null {
  let out = "";
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at]!;
    if (char !== "\\") { out += char; continue; }
    const next = raw[++at];
    if (next === undefined) return null;
    if (next === "u") {
      const hex = raw.slice(at + 1, at + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(parseInt(hex, 16));
      at += 4;
    } else if (next in SIMPLE_ESCAPE) out += SIMPLE_ESCAPE[next]!;
    else return null;
  }
  return out;
}

export interface FieldSpan { key: string; start: number; end: number; kind: "string" | "object" | "array" | "number" | "literal" }
const WS = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;

/** The top-level fields of one JSON object row, by byte range of each value (a string's range includes its quotes). Keys are
 * decoded with JSON.parse of their quoted text, so an escaped key (`project`) is the key it spells. Null when the bytes are
 * not exactly one well-formed object. */
export function topLevelFields(row: Uint8Array): FieldSpan[] | null {
  let at = 0;
  const skip = () => { while (at < row.length && WS(row[at]!)) at++; };
  const stringEnd = (from: number): number => {
    let end = from + 1;
    while (end < row.length && row[end] !== 0x22) end += row[end] === 0x5c ? 2 : 1;
    return end < row.length ? end + 1 : -1;
  };
  skip();
  if (row[at] !== 0x7b) return null;
  at++;
  const out: FieldSpan[] = [];
  skip();
  if (row[at] === 0x7d) { at++; skip(); return at === row.length ? out : null; }
  for (;;) {
    skip();
    if (row[at] !== 0x22) return null;
    const keyEnd = stringEnd(at);
    if (keyEnd < 0) return null;
    const key = decodeJsonString(Buffer.from(row.subarray(at + 1, keyEnd - 1)).toString("utf8"));
    if (key === null) return null;
    at = keyEnd;
    skip();
    if (row[at] !== 0x3a) return null;
    at++;
    skip();
    const start = at;
    const first = row[at];
    let kind: FieldSpan["kind"];
    if (first === 0x22) {
      const end = stringEnd(at);
      if (end < 0) return null;
      at = end;
      kind = "string";
    } else if (first === 0x7b || first === 0x5b) {
      kind = first === 0x7b ? "object" : "array";
      let depth = 0;
      for (; at < row.length; at++) {
        const byte = row[at]!;
        if (byte === 0x22) { const end = stringEnd(at); if (end < 0) return null; at = end - 1; }
        else if (byte === 0x7b || byte === 0x5b) depth++;
        else if (byte === 0x7d || byte === 0x5d) { depth--; if (depth === 0) { at++; break; } }
      }
      if (depth !== 0) return null;
    } else {
      while (at < row.length && row[at] !== 0x2c && row[at] !== 0x7d && !WS(row[at]!)) at++;
      if (at === start) return null;
      kind = first === 0x74 || first === 0x66 || first === 0x6e ? "literal" : "number";
    }
    out.push({ key, start, end: at, kind });
    skip();
    if (row[at] === 0x2c) { at++; continue; }
    if (row[at] === 0x7d) { at++; skip(); return at === row.length ? out : null; }
    return null;
  }
}

/** One overwrite of a row: `bytes` replace the same number of bytes at `at` (relative to the row's first byte). `kind` and `len` say what the
 * bytes are (see fillFor): they are all a crash journal needs to write them again. */
export interface RowEdit { at: number; bytes: Buffer; kind: EditKind; len: number }
export type EditKind = "string" | "object" | "array" | "number";

/** The bytes that replace a value of `kind` and `len` bytes: a string becomes spaces between its quotes, any other value the empty
 * value of its type padded with spaces. A pure function of (kind, len): a journal needs to keep nothing of the original. */
export function fillFor(kind: EditKind, len: number): Buffer {
  if (kind === "string") return Buffer.concat([Buffer.from('"'), Buffer.alloc(Math.max(0, len - 2), 0x20), Buffer.from('"')]);
  const empty = kind === "object" ? "{}" : kind === "array" ? "[]" : "0";
  return Buffer.concat([Buffer.from(empty), Buffer.alloc(Math.max(0, len - empty.length), 0x20)]);
}

/** The overwrites that clear the conversation's content from one row: exactly the bytes that would change, none for a value that
 * is already empty, so a cleared row has no edits and applying the edits twice changes nothing more. Null when the bytes are not
 * one well-formed object. */
export function clearEdits(row: Uint8Array, format: JsonlFormat): RowEdit[] | null {
  const fields = topLevelFields(row);
  if (!fields) return null;
  const edits: RowEdit[] = [];
  const keep = new Set([...format.ids, ...format.meta]);
  for (const field of fields) {
    if (keep.has(field.key) || field.kind === "literal") continue;
    const length = field.end - field.start;
    const want = fillFor(field.kind, length);
    if (!want.equals(Buffer.from(row.subarray(field.start, field.end)))) edits.push({ at: field.start, bytes: want, kind: field.kind, len: length });
  }
  return edits;
}

/** A hash of a row with every range in `edits` replaced by 0x00: only the ids, the meta fields and the structure are hashed, never a
 * byte of what the edits clear. Two copies of a row, one cleared and one torn half way, have the same skeleton. */
export function skeletonOf(row: Uint8Array, edits: ReadonlyArray<Pick<RowEdit, "at" | "len">>): string {
  const masked = Buffer.from(row);
  for (const edit of edits) masked.fill(0, edit.at, Math.min(masked.length, edit.at + edit.len));
  return createHash("sha256").update(masked).digest("hex");
}

/** What a plan keeps of a row it will clear: a hash of the row with the WHOLE place of every value a clear may overwrite zeroed (the
 * value and the spaces after it, up to the next comma or brace), so the same row hashes the same before its clear, after it, and with
 * only its content changed. Only ids, meta fields, keys and structure go into it: a saved plan never holds a hash of the words it is
 * there to remove. Null when the bytes are not one well-formed object. */
export function rowSkeleton(row: Uint8Array, format: JsonlFormat): string | null {
  const fields = topLevelFields(row);
  if (!fields) return null;
  const keep = new Set([...format.ids, ...format.meta]);
  const ranges: Array<{ at: number; len: number }> = [];
  for (const field of fields) {
    if (keep.has(field.key) || field.kind === "literal") continue;
    let end = field.end;
    while (end < row.length && WS(row[end]!)) end++;
    ranges.push({ at: field.start, len: end - field.start });
  }
  return skeletonOf(row, ranges);
}

/** Has every content and payload value of this row already been cleared? */
export const isCleared = (row: Uint8Array, format: JsonlFormat): boolean => clearEdits(row, format)?.length === 0;

/** Does `text` mention any needle, raw or as it would be escaped inside a JSON string? */
export function mentions(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => needle.length > 0 && (text.includes(needle) || text.includes(JSON.stringify(needle).slice(1, -1))));
}

export const sha16 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
/** Paste hashes a history row names. */
export function pasteHashesOf(row: Record<string, unknown>): string[] {
  if (!row.pastedContents || typeof row.pastedContents !== "object") return [];
  return Object.values(row.pastedContents as Record<string, { contentHash?: unknown }>)
    .map((paste) => paste?.contentHash)
    .filter((hash): hash is string => typeof hash === "string" && /^[a-f0-9]{16,64}$/.test(hash));
}

// ── the strict reader ────────────────────────────────────────────────────

export interface DbReader { all(sql: string, params?: Array<string | number>): Array<Record<string, unknown>> }
export interface JsonLine { text: string; row: Record<string, unknown> | null }

/** A file the native addon holds open on Windows (share-none, or shared with a lock). Every operation on it runs inside the addon
 * on a handle the addon owns; a C runtime descriptor never crosses between the addon and Node. `close` is explicit and final. */
export interface HeldFile {
  /** up to `length` bytes at `position` (fewer at the end of the file) */
  read(length: number, position: number): Buffer;
  /** writes at `position` and returns how many bytes it put (a short write leaves the rest to the caller) */
  write(bytes: Buffer, position: number): number | void;
  sync(): void;
  /** the whole-file lock the engine takes (LockFileEx); false when someone else keeps it */
  lock(): boolean;
  /** the file is deleted when this handle closes; false when that could not be set */
  markDelete(): boolean;
  /** volume and file index, as BigInt */
  id(): { dev: bigint; ino: bigint };
  size(): number;
  close(): void;
}
/** An open descriptor, or a file the addon holds. */
export type FileRef = number | HeldFile;

/** The only way a planner touches the world. Only lstat and readdir may answer "not there" (ENOENT, ENOTDIR). Every other
 * failure throws PlanError, and so does any decode error, SQLite error, or a line that names the conversation but is torn. */
export interface EngineFs {
  /** null when absent */
  lstat(path: string): Stats | null;
  /** is this home in a folder a sync client mirrors (told by the markers the clients leave, never by a folder's name)? Absent: no. */
  syncedHome?(path: string): boolean;
  /** names; absent, not a directory, or a symlink is empty */
  readdir(path: string): string[];
  /** the whole file as text; null when absent or not a plain file */
  readText(path: string): string | null;
  /** the whole file as bytes; null when absent or not a plain file */
  readBytes(path: string): Buffer | null;
  /** the first `bytes` of a plain file; `cut` says the file goes on */
  readHead(path: string, bytes: number): { text: string; cut: boolean } | null;
  /** the first line of a zstd-compressed plain file; null when absent */
  zstdFirstLine(path: string): string | null;
  /** The evidence (rolloutEvidence) of a rollout's first line, plain or zstd (by its name), read from `held` when the caller holds the
   * file open. "" when the file is absent or its first line is not a rollout's. */
  rolloutOwner(path: string, held?: FileRef): string;
  readlink(path: string): string;
  /** null when the database file is absent; `use` queries it */
  withDb<T>(path: string, use: (db: DbReader) => T): T | null;
  /** every line, parsed; a torn line that mentions a needle throws */
  jsonLines(path: string, text: string, needles: readonly string[], cut?: boolean): JsonLine[];
  /** Streams a plain file one line at a time (1 MiB reads, lines split across reads, no size cap on the file). A line over
   * MAX_LINE_BYTES, or any read error, throws PlanError. `cut` is true for a last line with no newline yet. `fd` reads through an
   * open descriptor instead of the path (a file the caller already holds exclusively). False when the file is absent. */
  eachLine(path: string, visit: (line: Buffer, offset: number, cut: boolean) => void, fd?: FileRef): boolean;
  /** eachLine, parsed: `row` is the line as an object, or null (blank, not an object, or a torn last line). A line that does not
   * parse and mentions a needle throws, as in jsonLines. */
  eachRow(path: string, needles: readonly string[], visit: (row: Record<string, unknown> | null, line: Buffer, offset: number, cut: boolean) => void, fd?: FileRef): boolean;
  /** the parsed value; undefined when `text` is empty or unparseable without mentioning a needle */
  jsonValue(path: string, text: string, needles: readonly string[]): unknown;
}

// ── predicates (data, so a plan can be saved and replayed) ───────────────

export interface Clause {
  field: string;
  /** in: exact string match; slashNormIn: with backslashes turned to "/" and trailing "/" cut; sameFolder: the same folder */
  op: "in" | "slashNormIn" | "sameFolder";
  values: string[];
}
export interface Pred { any: Clause[] }

export function evalPred(pred: Pred, row: Record<string, unknown>): boolean {
  return pred.any.some((clause) => {
    const value = row[clause.field];
    if (typeof value !== "string") return false;
    if (clause.op === "in") return clause.values.includes(value);
    if (clause.op === "slashNormIn") return clause.values.includes(value.replace(/\\/g, "/").replace(/\/+$/, ""));
    return clause.values.some((folder) => sameFolder(folder, value));
  });
}

// ── steps ────────────────────────────────────────────────────────────────

/** content: removes what the conversation left. hygiene: tidies a store after (index merge, vacuum); never blocks "verified". */
export type StepClass = "content" | "hygiene";
export interface Fingerprint { size: number; mtimeMs: number; ino: number }
export interface SqlStatement {
  table: string;
  /** may contain {ids}, replaced by one placeholder per id when `useIds` */
  where: string;
  params: Array<string | number>;
  useIds?: boolean;
}
interface StepBase {
  cls: StepClass;
  /** steps of one group stop at the first failure */ group?: string;
  done?: boolean;
  /** a name other steps can wait for (an ownerCheck is "owner:<db>"); ids survive a plan being split or reordered, indexes do not */
  id?: string;
  /** ids of steps that must have FINISHED in this run before this one may start; otherwise it is skipped and the home stays pending */
  needs?: string[];
}
/** One row a blank-in-place rewrite will overwrite: where its line starts, how many bytes it has (without the newline), and its
 * skeleton hash (rowSkeleton: ids, meta and structure, never a byte of the content). The executor writes only where the row there still
 * has that skeleton. */
export interface RowRef { off: number; len: number; sha: string }
export type Step = StepBase & (
  | { k: "remove"; root: string; target: string; /** the names found under `target` (and under its aside) when this was planned; present means the folder is moved aside, listed again, and its entries removed one by one, only those listed here */ expect?: string[]; /** for a Codex rollout: the evidence (rolloutEvidence) of its first line, read again on the held file before it is removed */ owner?: string; /** for a listed folder: the association fingerprint of each .jsonl entry; an entry that no longer matches is kept (see associationsOf) */ assoc?: Record<string, string>; /** for a single file: its association fingerprint, checked before it is removed */ fp?: string; /** Claude Code plan files: kept (and the step counts as done) when any transcript still under `projects` names one of `slugs` when the step runs (slugsReferenced) */ slugRefs?: { projects: string; slugs: string[] }; }
  | { k: "rewrite"; path: string; /** the only mode: the content of the rows in `lines` is overwritten in place (see JSONL_FORMAT) */ mode: "blank"; pred: Pred; needles: string[]; fp: Fingerprint;
      /** the file's format, a key of JSONL_FORMAT */ format: string;
      /** how the engine's writer is kept off the file: "lock" (the engine's own whole-file lock, held while Murage compares, writes and syncs), "dirlock" (the engine's own directory lock, `<file>.lock`, made and refreshed while Murage compares, writes and syncs: Claude Code) "inplace" (no lock and no aside: the rows are compared again on the open file, overwritten, synced and found again by name; Codex's session_index.jsonl, which its writer appends to and replaces by rename) or "exclusive" (the file is moved aside and nobody has it open, or on Windows opened with sharing off) */ how: "lock" | "exclusive" | "dirlock" | "inplace";
      /** a file left aside by an earlier run (or a step of it) that goes back to this name once it is cleared */ restoreTo?: string;
      /** the rows to clear */ lines: RowRef[] }
  | { k: "rmdirIfEmpty"; root: string; target: string }
  | { k: "sqlDelete"; db: string; pragmas: string; /** the threads (ids) that must still belong to these folders, checked inside the transaction */ guard?: { ids: string[]; folders: string[] }; ids?: string[]; closure?: { table: string; idCol: string; parentCol: string; fact: string }; stmts: SqlStatement[] }
  | { k: "ownerCheck"; db: string; pragmas: string; ids: string[]; folders: string[] }
  | { k: "ftsOptimize"; db: string }
  | { k: "checkpoint"; db: string }
  | { k: "vacuumIfFree"; db: string }
  | { k: "removeUnlessReferenced"; root: string; target: string; refFile: string; needle: string }
  | { k: "unlinkIfLinkTo"; path: string; suffixes: string[] }
);
/** The path a step reports when it fails. */
export function stepPath(step: Step): string {
  switch (step.k) {
    case "remove": case "removeUnlessReferenced": case "rmdirIfEmpty": return step.target;
    case "rewrite": case "unlinkIfLinkTo": return step.path;
    default: return step.db;
  }
}

/** What a Codex rollout's first line says about whose it is: its type, working folder and thread id, hashed. A plan carries it, and the
 * executor reads the held file's first line again: a file that now says something else is not the file that was planned. */
export function rolloutEvidence(row: { type?: unknown; payload?: { cwd?: unknown; id?: unknown } } | null | undefined): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  return sha16(Buffer.from(JSON.stringify({ type: row.type, cwd: row.payload?.cwd, id: row.payload?.id })));
}

export interface HomePlanData {
  engine: DeletionEngine;
  home: string;
  steps: Step[];
  /** the programs this engine is configured to run as (real paths of its CLI), so the process check knows a renamed copy */
  identities?: string[];
  /** the home is in a folder a sync client mirrors (decided when it was planned) */
  synced?: true;
}
export interface EnginePlanData { v: 3; homes: Record<string, HomePlanData> }

export const homeKey = (engine: string, home: string): string => `${engine}\0${home}`;
/** An ownerCheck removes nothing: it is a proof other steps wait for, so a plan that holds only checks has no content left to remove. */
export const hasContentSteps = (plan: Pick<HomePlanData, "steps">): boolean => plan.steps.some((step) => step.cls === "content" && step.k !== "ownerCheck");

// ── association fingerprints ─────────────────────────────────────────────

/** The longest single line a planner or the executor will read. A file with a longer line cannot be read in full, so nothing is
 * decided about it (PlanError); there is no limit on the file. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** The cwds and slugs a session transcript names and a hash of them, from a read of the WHOLE file. A planner reads it to decide
 * whom the file belongs to; a step carries the hash and the executor reads it again, with the file held, right before it removes
 * the file: a file that now names something new (another folder, a plan slug) is not the file that was planned and is kept. `fd`
 * reads through a descriptor the caller already holds. */
export function associationsOf(fs: EngineFs, path: string, needles: readonly string[] = [], fd?: FileRef): { cwds: string[]; slugs: string[]; fp: string } {
  const cwds = new Set<string>(), slugs = new Set<string>();
  fs.eachRow(path, needles, (row) => {
    if (typeof row?.cwd === "string") cwds.add(row.cwd);
    if (typeof row?.slug === "string") slugs.add(row.slug);
  }, fd);
  const sorted = { cwds: [...cwds].sort(), slugs: [...slugs].sort() };
  return { cwds: [...cwds], slugs: [...slugs], fp: sha16(Buffer.from(JSON.stringify(sorted))) };
}

// ── Claude Code plan slugs ───────────────────────────────────────────────

const SLUG_DEPTH = 8;
/** Every string value of a `slug` field anywhere in `value` (the row's own field, and any nested one), parsed, so whitespace and
 * escapes in the JSON make no difference. */
function slugFields(value: unknown, into: Set<string>, depth = 0): void {
  if (!value || typeof value !== "object" || depth > SLUG_DEPTH) return;
  if (Array.isArray(value)) { for (const item of value) slugFields(item, into, depth + 1); return; }
  for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
    if (name === "slug" && typeof inner === "string") into.add(inner);
    else if (inner && typeof inner === "object") slugFields(inner, into, depth + 1);
  }
}

/** Which of `slugs` a Claude Code transcript under `projects` (`projects/<folder>/<id>.jsonl`, the aside copies a crash left included)
 * still names, other than the files in `skip` (the transcripts the same plan removes). A plan file is shared by every session that
 * carries its slug, so it goes only when none that stays names it. The slug is read from the parsed rows (never a byte search of the
 * JSON). A row that cannot be parsed and still carries a slug's text, or the word "slug", cannot be told: it counts as naming every
 * slug asked about (the plan file is kept). A file that cannot be read throws (PlanError: nothing of the home is touched). */
export function slugsReferenced(fs: EngineFs, projects: string, slugs: readonly string[], skip: ReadonlySet<string> = new Set()): Set<string> {
  const wanted = new Set(slugs);
  const found = new Set<string>();
  if (!wanted.size) return found;
  const api = pathApiFor(projects);
  for (const folder of fs.readdir(projects)) {
    const dir = api.join(projects, folder);
    for (const file of fs.readdir(dir)) {
      const plain = file.endsWith(ASIDE_SUFFIX) ? file.slice(0, -ASIDE_SUFFIX.length) : file;
      const path = api.join(dir, file);
      if (!plain.endsWith(".jsonl") || skip.has(path) || !fs.lstat(path)?.isFile()) continue;
      fs.eachRow(path, [], (row, line) => {
        if (row) {
          const named = new Set<string>();
          slugFields(row, named);
          for (const slug of named) if (wanted.has(slug)) found.add(slug);
          return;
        }
        const text = line.toString("utf8");
        if (text.trim() !== "" && (text.includes("slug") || [...wanted].some((slug) => text.includes(slug)))) for (const slug of wanted) found.add(slug);
      });
      if (found.size === wanted.size) return found;
    }
  }
  return found;
}

// ── the planner ──────────────────────────────────────────────────────────

export const DEFAULT_PRAGMAS = "PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;";

/** What one engine body talks to. It reads through `fs`, remembers ids in `facts`, and emits steps; it changes nothing. */
/** A rewrite step names at most this many rows and reads at most this many bytes of them, so the hold it takes is short (engine-exec.ts
 * HOLD_MAX_MS): a file with more rows to clear gets one step per chunk. A single row longer than the byte cap is a chunk of its own. */
export const STEP_MAX_ROWS = 256;
export const STEP_MAX_BYTES = 1024 * 1024;

export class Planner {
  /** Ids of steps every step pushed from now on must wait for (ownerCheck). Set by a planner, cleared by it. */
  needing: string[] = [];
  readonly steps: Step[] = [];
  readonly leftovers: DeletionLeftover[] = [];
  readonly fs: EngineFs;
  readonly facts: Known;
  /** the home being planned is in a synced folder: its files are rewritten in place, never moved to a private name */
  synced = false;
  constructor(fs: EngineFs, facts: Known) {
    this.fs = fs;
    this.facts = facts;
  }

  /** Remove exactly `target` (strictly inside `root`) when something is there. `fp` (a file whose content decided it is ours): the
   * executor checks that it still reads the same before it removes it. A target that is itself a recovery name (ASIDE_SUFFIX) is a
   * file of its own: the caller read it and decided its ownership; it is never judged with the file of the same base name. */
  removeExact(root: string, target: string, fp?: string, owner?: string): void {
    if (this.fs.lstat(target) === null) return;
    this.push({ k: "remove", cls: "content", root, target, ...(fp !== undefined ? { fp } : {}), ...(owner !== undefined ? { owner } : {}) });
  }

  /** Remove a file or folder owned by its NAME alone (an id's side file; no content decided it): the copy a crash left aside
   * (ASIDE_SUFFIX) first, as a step of its own, then the file or folder itself. A caller that read the file to decide ownership
   * (`fp`, or a rollout's first line) uses removeExact for each physical file instead. */
  remove(root: string, target: string): void {
    this.removeExact(root, `${target}${ASIDE_SUFFIX}`);
    this.removeExact(root, target);
  }

  /** The names in `dir` and in its aside (see ASIDE_SUFFIX), so an id that a crash left in the aside is still found. */
  namesWithAside(dir: string): string[] {
    return [...new Set([...this.fs.readdir(dir), ...this.fs.readdir(`${dir}${ASIDE_SUFFIX}`)])];
  }

  /** Remove a folder whose names this plan turned into ids. The executor renames it aside, lists it again, and removes the
   * entries of that listing one by one, only those in `expect` and (for a .jsonl entry in `assoc`) only while its association
   * fingerprint is unchanged. Anything else stays, and the home is planned again with what is there. */
  removeListed(root: string, target: string, expect: readonly string[], opts: { assoc?: Record<string, string> } = {}): void {
    if (this.fs.lstat(target) === null && this.fs.lstat(`${target}${ASIDE_SUFFIX}`) === null) return;
    this.push({ k: "remove", cls: "content", root, target, expect: [...new Set(expect)].sort(), ...(opts.assoc && Object.keys(opts.assoc).length ? { assoc: opts.assoc } : {}) });
  }

  /** The cwds and slugs the session file `path` names and a fingerprint of them. Torn rows that mention a needle fail the read
   * (a planner passes the conversation's folders; the executor passes none). Only these fields decide which folder, plan file
   * and history line belong to the conversation, so only a change in them makes a file stale. */
  associationsOf(path: string, needles: readonly string[] = []): { cwds: string[]; slugs: string[]; fp: string } {
    return associationsOf(this.fs, path, needles);
  }

  /** Clear the content of the rows `pred` picks in a JSONL file (see JSONL_FORMAT). Streams the whole file now; emits a step only
   * when a matched row still has content, so a row that is already cleared is not a step. The step names each row (offset,
   * length, hash) so the executor overwrites exactly those bytes. `how` says how the engine's writer is kept off the file when
   * that happens (see the Step type). A last row that has no newline yet and does not parse is unfinished (its writer is
   * mid-write): if it names the conversation the home is not planned (PlanError), otherwise it is left alone. A copy of the file
   * left aside by an earlier run is cleared and put back first. Returns the match count and the text of the rows that stay. */
  rewrite(path: string, o: { pred: Pred; needles: string[]; format: string; how: "lock" | "exclusive" | "dirlock" | "inplace"; collectPastes?: boolean; onMatch?: (row: Record<string, unknown>) => void }): { matched: number; remaining: string } {
    const format = JSONL_FORMAT[o.format];
    if (!format) throw new PlanError(path, new Error("unknown format"));
    const kept: string[] = [];
    let matched = 0;
    const found = new Set<string>();
    const scan = (file: string, restoreTo?: string): void => {
      const stat = this.fs.lstat(file);
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
      const lines: RowRef[] = [];
      this.fs.eachRow(file, o.needles, (row, line, offset, cut) => {
        const text = () => line.toString("utf8");
        if (cut && row === null && line.length > 0 && mentions(text(), o.needles)) throw new PlanError(file, new Error("a row that names this conversation is still being written"));
        if (row && evalPred(o.pred, row)) {
          matched++;
          o.onMatch?.(row);
          if (o.collectPastes) for (const hash of pasteHashesOf(row)) found.add(hash);
          const edits = clearEdits(line, format);
          if (!edits) throw new PlanError(file, new Error("a row that names this conversation could not be read as one object"));
          if (edits.length) lines.push({ off: offset, len: line.length, sha: rowSkeleton(line, format)! });
        } else kept.push(text());
      });
      if (lines.length || restoreTo) {
        // One step per chunk (STEP_MAX_ROWS rows, STEP_MAX_BYTES read) so every hold is short. An aside that goes back to its name
        // (restoreTo) is one step: giving the name back is that step's last act.
        const chunks: RowRef[][] = [];
        for (const row of lines) {
          const last = chunks[chunks.length - 1];
          if (restoreTo || !last || last.length >= STEP_MAX_ROWS || last.reduce((sum, item) => sum + item.len, 0) + row.len > STEP_MAX_BYTES) chunks.push([row]);
          else last.push(row);
        }
        if (!chunks.length) chunks.push([]);
        for (const chunk of chunks) {
          this.push({
            k: "rewrite", cls: "content", path: file, mode: "blank", pred: o.pred, needles: o.needles, format: o.format, how: restoreTo ? "exclusive" : o.how,
            fp: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }, lines: chunk, group: path, ...(restoreTo ? { restoreTo } : {}),
          });
        }
      }
    };
    // The aside first: it goes back to the name before the file there is cleared.
    // (an aside left by an earlier version, which moved Claude's history aside, is still settled the old way)
    const away = `${path}${ASIDE_SUFFIX}`;
    if (o.how === "inplace") {
      // An index rewritten in place is never moved, replaced or renamed. A legacy aside (an earlier build's) is cleared where it is,
      // then its surviving rows are appended to the public index in place (or, with no public index, it takes the name back).
      const stat = this.fs.lstat(away);
      if (stat && stat.isFile() && !stat.isSymbolicLink()) {
        scan(away);
        this.push({ k: "rewrite", cls: "content", path: away, mode: "blank", pred: o.pred, needles: o.needles, format: o.format, how: "inplace", fp: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino }, lines: [], group: path, restoreTo: path });
      }
    } else if (o.how === "exclusive" || o.how === "dirlock") scan(away, path);
    scan(path);
    if (matched && o.collectPastes) this.facts.add("pastes", ...found);
    return { matched, remaining: kept.join("\n") };
  }

  count(db: DbReader, table: string, where: string, params: Array<string | number>): number {
    return Number((db.all(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`, params)[0] as { n?: number } | undefined)?.n ?? 0);
  }

  /** Delete rows in one transaction. A database owed a checkpoint is remembered (dirtyDbs) until the checkpoint is verified. */
  sqlDelete(db: string, spec: { pragmas?: string; guard?: { ids: string[]; folders: string[] }; ids?: string[]; closure?: { table: string; idCol: string; parentCol: string; fact: string }; stmts: SqlStatement[]; changed: number }): void {
    if (spec.changed <= 0) return;
    this.facts.add("dirtyDbs", db);
    this.push({ k: "sqlDelete", cls: "content", group: db, db, pragmas: spec.pragmas ?? DEFAULT_PRAGMAS, ...(spec.guard?.ids.length ? { guard: spec.guard } : {}), ...(spec.ids ? { ids: spec.ids } : {}), ...(spec.closure ? { closure: spec.closure } : {}), stmts: spec.stmts });
  }

  /** The log of a database whose rows were removed must be checkpointed away, or the text stays readable in the -wal. */
  checkpointIfDirty(db: string): void {
    if (this.facts.get("dirtyDbs").has(db)) this.push({ k: "checkpoint", cls: "content", group: db, db });
  }

  /** Adds a step; every step waits for the ids in `needing`. */
  push(step: Step): void { this.steps.push(this.needing.length && !step.needs ? { ...step, needs: [...this.needing] } : step); }
}
