// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The executor of engine-history deletion: the confined removal primitives, the JSONL rewrites, the SQLite steps, and the loop
// that runs a saved plan. It knows nothing about any engine. It runs only the steps a plan lists, in plan order, each one
// idempotent (a removal of what is already gone is done; a DELETE that matches nothing is done), and it reports each finished
// step so a crash resumes at the first step not done.
//
// THE CONTRACT: Murage starts only when the engine is closed, and edits only under the engine's own lock.
//
// WHAT MAKES A WRITE TO AN ENGINE'S FILE HARMLESS TO THAT ENGINE. Node cannot lock a file or see who has it open, and a scan of
// processes can miss an engine that starts a microsecond after it. So Murage does not rely on the process check for that. The check
// (engine-closed.ts) is a POLICY GATE: it decides whether Murage tries a file now and whether a home counts as finished. Three layers
// keep a write harmless even when an engine starts right after the check:
//   HOLD   a per-file exclusion the engine or the operating system honours (the engine's own lock, a name nobody can open, a handle
//          nobody can share), with `guard()` called INSIDE every unlink, rmdir, rename, link and overwrite just before it is made:
//          the hold is still ours, it is no older than HOLD_MAX_MS (500 ms, for every engine and every class), and the file is
//          still the file that was held. A hold that ran out is taken again once; a second time the step is stale.
//   CAS    the planned bytes are read again on the held file just before each write; a row that is not what the plan saw is not written.
//   REDO   an offsets-and-hashes journal (engine-redo.ts) written and made durable before the engine's lock is taken (so the hold covers
//          only the compare, the overwrites and their sync) and removed only after the rows are on the drive, so a crash or a power cut
//          never leaves a row cut in the middle of a value: the next start finishes it (recoverAll) before anything is planned.
// A file Murage has renamed to a private name (an aside, REJOIN's newer file) can still be written by a process that opened it before
// the rename, whatever that process is called (one the gate cannot name, R7). Such a file is removed only after the addon has shown,
// by the file's identity in every process's open files, that no other process has it open for writing (`noWriters`): nothing written
// later can land in a removed file. Every rename, link and unlink a crash journal depends on is made durable (its folder synced) first.
// The gate is asked immediately before every step (per commit), once before the first and once after the last. An engine that is open
// or cannot be told, a helper that is missing, a name that is taken, a file another program has, or a file system that cannot move a
// file without risking another, changes NOTHING further: the files stay exactly as they are and the home stays pending. Murage never
// merges blindly, or swaps in a weaker destructive operation (no append-merge but REJOIN, no replacing rename, no recursive removal).
//   lock       the engine's own whole-file lock (Fuigo/Grok's unified.jsonl, Codex's history.jsonl): Murage takes the same lock, then
//              compares, overwrites, syncs and verifies the rows it planned, and lets go. Nothing else is written.
//   dirlock    Claude Code's history.jsonl: the engine's own DIRECTORY lock, `history.jsonl.lock`. The public path is never removed:
//              an abandoned lock (10 s untouched, engine closed) is renamed to a private name of Murage's, checked to be the very
//              directory that was seen, and only then removed under that private name; Murage's own lock is released the same way.
//   inplace    Codex's and Kimi's session_index.jsonl (Kimi's on every install: sync detection by markers can never be complete): no lock and no aside. Codex appends to it (write and close) and replaces it by rename, so
//              the rows are compared again on the open file, overwritten in place, synced, and found again by NAME; a new file at
//              the name means Codex's rewrite won and the step is stale.
//   exclusive  a file whose writer has no lock to respect, planned today only to recover an aside an earlier build left: renamed aside (a rename that cannot replace)
//              so no one can open it by name, and only then compared, overwritten, synced, verified and linked back, again only if
//              its name is still free. Windows has the addon open it with sharing off instead. When the engine made a new file at
//              the name meanwhile, both stay and the next attempt joins them (REJOIN).
//   remove     a file or folder an engine owns whole (a transcript, a session folder): renamed aside, no process may have one of its
//              files open for writing (macOS, Linux), read in full against the fingerprint the plan saved (a Codex rollout also
//              against the id, folder and type of its first line), and only then deleted file by file (Windows: each file opened with
//              sharing off only after that read, checked to be the file read, and marked at once); the folders that held them go only
//              when empty. A different read or a holder puts it back and the home is planned again. An aside left by a crash is a
//              file of its own and is judged on its own content.
// With no helper to do this (engine-exclusion.ts) nothing is changed at all (HelperError). Only the rows a plan lists are written,
// and only the bytes of their content. SQLite stores keep SQLite's own protocol (BEGIN IMMEDIATE, a busy timeout, a checkpoint that
// must finish).
//
// THE EXECUTOR NEVER DISCOVERS. A step carries what it was planned from (the names in a folder, the rows of a file and their
// hashes, the ids of a closure, the paste hashes a dropped row may name). When the world no longer matches, the step throws
// StaleError: nothing was changed, the home's other steps are skipped, and the driver plans the home again and saves that plan
// before the next execute. Every read goes through the strict reader (engine-fs.ts) and every change through its mutOps and
// exclOps layers; this file imports neither node:fs nor node:sqlite (engine-plan-structure.test.ts keeps that true).
import nodePath from "node:path";
import type { Stats } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { engineState, type EngineVerdict } from "./engine-closed.ts";
import type { Barrier } from "./engine-exclusion.ts";
import { exclOps, fsOps, mutOps, realEngineFs, type FileWriters } from "./engine-fs.ts";
import { ASIDE_SUFFIX, UNDO_JOIN_TRIES, associationsOf, slugsReferenced, clearEdits, EngineOpenError, evalPred, HelperError, isCleared, isStrictlyInside, JSONL_FORMAT, OPEN_PASS_STEPS, OPEN_REASON, pathApiFor, rowSkeleton, sameFolder, skeletonOf, StaleError, stepPath, type FileRef, type HomePlanData, type JsonlFormat, type RowEdit, type RowRef, type Step } from "./engine-plan-core.ts";
import { dropRedo, editsOf, listRedo, markFellBack, rebootedSince, redoDirectory, rowsRecordsOf, writeJoin, writeRedo, type AnyRecord, type JoinRecord, type RedoRecord, type RedoRow } from "./engine-redo.ts";
import { checkpointTruncate } from "./sqlite-checkpoint.ts";

type RewriteStep = Extract<Step, { k: "rewrite" }>;

// ── confined removal ────────────────────────────────────────────────────

export type RemoveOutcome = "removed" | "absent" | "refused" | "failed";

export function lstatOrNull(path: string): Stats | null {
  try {
    return fsOps.lstat(path) as Stats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw error;
  }
}

/** `target` strictly inside `root`, reached without crossing a symlink: its resolved path, "absent" when a folder on the way (or
 * the root) is not there, "refused" when it is outside the root or the way crosses a link or a file. */
function confine(root: string, target: string): { full: string } | "absent" | "refused" {
  const api = pathApiFor(root);
  if (!isStrictlyInside(root, target, api)) return "refused";
  const parts = api.relative(api.resolve(root), api.resolve(target)).split(api.sep);
  let at = api.resolve(root);
  if (!lstatOrNull(at)) return "absent";
  for (const part of parts.slice(0, -1)) {
    at = api.join(at, part);
    const stat = lstatOrNull(at);
    if (!stat) return "absent";
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "refused";
  }
  return { full: api.join(at, parts[parts.length - 1]!) };
}

/** Remove `target`, which must sit strictly inside `root`, without
 * following a symlink anywhere between them. A symlink target is unlinked
 * as a link. */
export function removeConfined(root: string, target: string): RemoveOutcome {
  try {
    const found = confine(root, target);
    if (found === "refused" || found === "absent") return found;
    const full = found.full;
    const stat = lstatOrNull(full);
    if (!stat) return "absent";
    if (stat.isSymbolicLink() || !stat.isDirectory()) mutOps.unlink(full);
    else {
      try { mutOps.removeTree(full); }
      catch {
        // W-D8: a conversation's workspace keeps read-only skill files
        // (.murage-procedures). The Node inside Electron refuses those on
        // Windows (EPERM), so the folder stayed after Delete and the retry
        // at the next start failed the same way. Give the owner write
        // permission back, never through a link, and try once more.
        allowOwnerWrites(full);
        mutOps.removeTree(full);
      }
    }
    return lstatOrNull(full) ? "failed" : "removed";
  } catch {
    return "failed";
  }
}

/** Adds the owner's write permission to `directory` and everything in it,
 * without following a link or junction. On Windows this clears the
 * read-only attribute. Best effort: whatever still refuses is reported by
 * the removal that follows. */
export function allowOwnerWrites(directory: string): void {
  const reader = realEngineFs();
  const pending = [directory];
  while (pending.length) {
    const at = pending.pop()!;
    let stat: Stats | null;
    try { stat = reader.lstat(at); } catch { continue; }
    if (!stat || stat.isSymbolicLink()) continue;
    try { mutOps.chmod(at, (stat.mode & 0o7777) | (stat.isDirectory() ? 0o700 : 0o600)); } catch { /* reported by the removal */ }
    if (!stat.isDirectory()) continue;
    let names: string[] = [];
    try { names = reader.readdir(at); } catch { continue; }
    for (const name of names) pending.push(nodePath.join(at, name));
  }
}

// ── exclusion ───────────────────────────────────────────────────────────

/** Nothing of an engine's is changed unless the helper that takes exclusion is there. */
function needHelper(): void {
  if (!exclOps.available()) throw new HelperError();
}

const aside = (path: string): string => `${path}${ASIDE_SUFFIX}`;
const isAside = (path: string): boolean => path.endsWith(ASIDE_SUFFIX);
const baseOf = (path: string): string => (isAside(path) ? path.slice(0, -ASIDE_SUFFIX.length) : path);
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

// ── the guard: asked INSIDE every destructive call, just before it ──────────

/** How long a hold on an engine's file may last, for every engine and every class. A step is planned small enough (engine-plan-core.ts
 * STEP_MAX_ROWS, STEP_MAX_BYTES) to finish well inside it. */
export const HOLD_MAX_MS = 500;

/** Throws unless the destructive call that is about to be made may go ahead. `path`: the name the call is about to change, for a
 * guard that knows the identity of some of them. */
type Guard = (path?: string) => void;
const noGuard: Guard = () => {};

/** The hold lasted longer than HOLD_MAX_MS: the chunk of work is taken again once (see `chunk`). */
class HoldExpired extends Error { constructor() { super("hold expired"); this.name = "HoldExpired"; } }

/** A guard for a hold on a file: `alive` (the hold is still ours: the lock fd is held, the lock directory at the public path is the one
 * Murage made, the Windows handle is open), the hold is no older than HOLD_MAX_MS by the monotonic clock, and `same` (the file at the
 * name is still the file that was held). */
function holdGuard(hold: { alive: () => boolean; same?: () => boolean; since: number; what: string }): Guard {
  const ours = (): void => { if (!hold.alive()) throw new EngineOpenError("held", `${hold.what} is no longer ours`); };
  return () => {
    if (hold.same && !hold.same()) throw new StaleError(`${hold.what} was replaced`);
    ours();
    // the age is read LAST, after everything that takes time: no call is made between this and the destructive call that follows
    if (mutOps.now() - hold.since > HOLD_MAX_MS) throw new HoldExpired();
  };
}
/** One chunk of work that takes its own hold. A hold that ran out is taken again once and the chunk redone (every chunk compares what
 * the plan saw again, so redoing it is safe); a second time the step is stale and the home is planned again. */
function chunk(work: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try { work(); return; } catch (error) {
      if (!(error instanceof HoldExpired)) throw error;
      if (attempt >= 1) throw new StaleError("the hold kept running out");
    }
  }
}

// The only places an engine's file is unlinked, removed, renamed, linked or overwritten. Each asks its guard first.
const gUnlink = (guard: Guard, path: string): void => { guard(path); mutOps.unlink(path); };
const gRmdir = (guard: Guard, path: string): void => { guard(path); mutOps.rmdir(path); };
const gLink = (guard: Guard, from: string, to: string): void => { guard(to); mutOps.link(from, to); };
const gMove = (guard: Guard, from: string, to: string): "ok" | "exists" | "unsupported" => { guard(from); return exclOps.renameNoReplace(from, to); };
/** How many overwrites were begun (gPwrite) in this process: a step that throws before it began one changed no engine file's bytes. */
let overwrites = 0;
/** An overwrite is made by single writes, and the guard is asked before EACH of them: a write the system cut short is finished only
 * after the guard has said again that the hold is still ours and young enough. */
const gPwrite = (guard: Guard, file: FileRef, bytes: Buffer, at: number): void => {
  overwrites++;
  let done = 0;
  do {
    guard();
    const put = mutOps.pwrite(file, done ? bytes.subarray(done) : bytes, at + done) as number | void;
    if (typeof put !== "number") { done = bytes.length; break; } // a stand-in that writes all of it and says nothing
    if (put <= 0) throw Object.assign(new Error("a write put nothing"), { code: "EIO" });
    done += put;
  } while (done < bytes.length);
};

const idOrNull = (path: string): { dev: bigint; ino: bigint; mtimeNs: bigint } | null => {
  try { return mutOps.idOf(path); } catch (error) { if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return null; throw error; }
};

/** A folder's contents as names, listed once, with no link followed: the regular files (what a process can hold open and write),
 * the links and other names (only names), and the folders, parents before children. */
interface Tree { files: string[]; links: string[]; dirs: string[] }
function treeOf(path: string): Tree {
  const reader = realEngineFs();
  const tree: Tree = { files: [], links: [], dirs: [] };
  const pending = [path];
  for (let at = pending.shift(); at !== undefined; at = pending.shift()) {
    const stat = reader.lstat(at);
    if (!stat) continue;
    if (stat.isSymbolicLink()) tree.links.push(at);
    else if (stat.isFile()) tree.files.push(at);
    else if (stat.isDirectory()) {
      tree.dirs.push(at);
      for (const name of reader.readdir(at)) pending.push(nodePath.join(at, name));
    } else tree.links.push(at);
  }
  return tree;
}

/** The guard for the removal of a tree that was moved aside: every file and link is deleted only if it is still the one that was listed
 * (its device and inode are what they were when the tree was listed). A name that now holds something else is a replacement nobody here
 * opened: it stays, and the home is planned again. */
function treeGuard(tree: Pick<Tree, "files" | "links">): Guard {
  const ids = new Map<string, { dev: bigint; ino: bigint }>();
  for (const path of [...tree.files, ...tree.links]) { const id = idOrNull(path); if (id) ids.set(path, id); }
  return (path) => {
    const want = path === undefined ? undefined : ids.get(path);
    if (!want) return;
    const now = idOrNull(path!);
    if (now && (now.dev !== want.dev || now.ino !== want.ino)) throw new StaleError(`${nodePath.basename(path!)} was replaced while it was removed`);
  };
}

/** The size and identity of a file as it was judged (read in full), so that the hold taken afterwards can tell it is still that file. */
interface Judged { ino: number; size: number }
const judgedOf = (path: string): Judged | null => { const stat = lstatOrNull(path); return stat && stat.isFile() ? { ino: stat.ino, size: stat.size } : null; };

/** Windows: deletes each of `files` through a handle nobody can share, opened only now, one file at a time, after what decides was read:
 * the file must still be the one that was judged (the same identity and size, when it was judged), and its delete mark is set at once,
 * so no file is held longer than HOLD_MAX_MS whatever its size or however many there are; the file goes when its handle closes. A file
 * another process has open (even for reading) is not deleted (EngineOpenError "held"). Elsewhere it does nothing: the caller unlinks. */
function markDeleteEach(files: readonly string[], judged: ReadonlyMap<string, Judged>): void {
  if (exclOps.mode !== "win32") return;
  for (const path of files) {
    const file = exclOps.openFile(path, "delete");
    if (!file) throw new EngineOpenError("held", "another process has it open");
    const since = mutOps.now(); // the hold is the handle: from the moment it is ours
    try {
      const want = judged.get(path);
      if (want) {
        const now = mutOps.fstat(file);
        if (now.ino !== want.ino || now.size !== want.size) throw new StaleError(`${nodePath.basename(path)} changed after it was read`);
      }
      if (mutOps.now() - since > HOLD_MAX_MS) throw new StaleError("the hold on the file ran out before it was marked");
      if (!file.markDelete()) throw new EngineOpenError("held", "it could not be marked for removal");
    } finally { mutOps.close(file); }
  }
}

/** The gate of the home being run, asked again inside a step. A process that holds a file Murage has just taken out of reach by name
 * (renamed aside) opened it before the rename and is running now: a closed answer after the rename means nobody can write to it. */
function gateNow(): EngineVerdict {
  if (!currentWindow) return { state: "unknown", via: "enumeration" };
  return openPassGate(currentWindow, engineState(currentWindow.engine, currentWindow.home, { dbs: currentWindow.dbs, identities: currentWindow.identities }));
}
/** DELETION-WHILE-OPEN-107: in an open-home pass the engine being open is expected (the owner's own CLI on the home); what keeps the
 * running CLI's files out of reach is the per-file hold every step of that pass takes (renamed to a private name, then `noWriters`
 * on macOS and Linux; a share-none handle on Windows), never the home gate. An engine that cannot be checked still stops it. Only the
 * removal steps of an open pass run under it (OPEN_PASS_STEPS). */
function openPassGate(window: Pick<Window, "open">, verdict: EngineVerdict): EngineVerdict {
  return window.open && verdict.state === "open" ? { ...verdict, state: "closed" } : verdict;
}
/** An open-home pass never unlinks a link, at the top of a step or inside a folder it removes: the folder is put back and the home
 * stays owed for the closed pass (Grok design r1). */
const linksWaitInOpenPass = (links: readonly string[]): void => {
  if (currentWindow?.open && links.length) throw new EngineOpenError("held", "a link is removed once the engine is closed");
};
const notClosed = (verdict: EngineVerdict): EngineOpenError =>
  new EngineOpenError(verdict.state === "unknown" ? "unchecked" : "open", verdict.state === "unknown" ? "it could not be checked" : "its engine started");

/** macOS, Linux: nobody can write to `paths` any more. They are under a private name of Murage's (renamed aside, or REJOIN's file), so no
 * process can open them by name; what is asked here is whether a process that opened one BEFORE the rename still has it open for
 * writing, by the file's identity in every process's open files (the addon's `writers`). One that does keeps the files where they are
 * (EngineOpenError `kind`): what it writes later is never written into a removed file. After this answers, nothing can start writing to
 * them, so a read made after it is final. A process whose open files cannot be read counts as one that could write, when it could:
 * one of this user's, or any user's but root's when the file lets others write ("could not check"), unless the kernel's own answer
 * (Linux, `openForWrite`) is that no process has them open for writing; root and the system's other users cannot be read by a user
 * program at all. Windows: the share-none handle is the same proof, so nothing is asked. */
function noWriters(paths: readonly string[], kind: "held" | "aside" = "held"): void {
  if (exclOps.mode !== "posix" || !paths.length) return;
  let seen: FileWriters;
  try { seen = exclOps.writers([...paths]); } catch { throw new EngineOpenError("unchecked", "who has the file open could not be read"); }
  // a process named as a writer, or the kernel's own answer (Linux) that one of them is open for writing somewhere, holds them: the
  // kernel counts every open file description in every process and pid namespace, including one no scan of this user's could list.
  // Murage itself never has these paths open for writing when it asks (every caller closes or never opens them for writing first).
  if (seen.writers.length || seen.openForWrite === true) throw new EngineOpenError(kind, "another process has it open for writing");
  if (!seen.unreadable.length) return;
  // Linux: a process of this user whose open files cannot be listed (made undumpable: (sd-pam), ssh-agent, a keyring) is no obstacle
  // when the kernel itself says no process at all has any of the files open for writing (a read lease is granted only then)
  if (seen.openForWrite === false) return;
  const own = exclOps.ownUid();
  const shared = paths.some((path) => ((lstatOrNull(path)?.mode ?? 0) & 0o022) !== 0);
  // Root (uid 0) is never counted, and the system's other users only when the file lets others write: a user program can never read
  // their open files, and every macOS computer runs root daemons, so counting them would leave every deletion pending for good. An
  // engine that runs as root under a name Murage does not know is the identification miss of accepted residual R7 (an engine the gate
  // cannot name), which this check cannot see (engine-exclusion-r25.test.ts documents it).
  if (!seen.unreadable.some((item) => item.uid === null || item.uid === own || (shared && item.uid !== 0))) return;
  // A process that could write and whose open files cannot be read: Murage cannot prove that no one can still write to the file, so it
  // is never removed or cut. The home stays pending with the engine-unchecked line, and Murage tries again (every 10 minutes and at its
  // start). No clock, restart or age of the file is taken as that proof: a descriptor opened after a restart keeps an old ctime.
  throw new EngineOpenError("unchecked", "who has the file open could not be read");
}

/** Moves `from` to `to` in one atomic step that cannot replace anything. "gone": `from` was not there. A taken name, a file system
 * that cannot do this, or (Windows) a file in use leaves everything as it was and the home pending. */
function moveAside(guard: Guard, from: string, to: string): "moved" | "gone" {
  needHelper();
  let outcome: "ok" | "exists" | "unsupported";
  try { outcome = gMove(guard, from, to); } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return "gone";
    if (exclOps.mode === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES")) throw new EngineOpenError("held", "it is in use");
    throw error;
  }
  if (outcome === "exists") throw new EngineOpenError("held", "an earlier copy is still aside");
  if (outcome === "unsupported") throw new EngineOpenError("held", "this file system cannot move a file aside without risking another file");
  return "moved";
}

/** The file or folder at `away` takes the name `original`, if it is free: a file by link (never replaces), then, when the file
 * system has no links, by the atomic no-replace rename. Throws EEXIST when the name is taken (both stay, nothing is merged). When
 * neither is possible the file stays aside and the home is pending (EngineOpenError). */
function giveName(guard: Guard, away: string, original: string, folder: boolean): void {
  if (!folder) {
    let linked = false;
    try { gLink(guard, away, original); linked = true; } catch (error) {
      const code = codeOf(error);
      if (code === "EEXIST") throw error;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EMLINK" && code !== "ENOSYS" && code !== "EXDEV") throw error;
    }
    if (linked) { gUnlink(guard, away); return; }
  }
  const outcome = gMove(guard, away, original);
  if (outcome === "exists") throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  if (outcome === "unsupported") throw new EngineOpenError("held", "this file system cannot give the file its name back without risking another file; it stays aside");
}

/** Puts a file or folder back under its name after it was moved aside and left alone. Never replaces and never merges: if the
 * name was taken meanwhile, or nothing can do it safely, both stay as they are and the home is pending. */
function putBack(asidePath: string, original: string, folder: boolean): void {
  try { giveName(noGuard, asidePath, original, folder); } catch { /* both stay; the aside is judged again */ }
}

const sameFileAt = (a: string, b: string): boolean => {
  try {
    const x = mutOps.idOf(a), y = mutOps.idOf(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
};

/** Deletes what a hold covered: its files and links one by one, then its folders, deepest first, each only if it is empty. A name
 * that appeared meanwhile keeps its folder (StaleError); nothing is ever removed recursively. On Windows a marked file died when
 * its handle closed and is NEVER unlinked by name: a file at that name now is a replacement nobody here opened, so it stays and the
 * home is planned again. */
function deleteTree(guard: Guard, tree: Tree): void {
  for (const path of tree.files) {
    if (exclOps.mode === "win32") {
      if (lstatOrNull(path)) throw new StaleError(`${nodePath.basename(path)} was replaced while it was removed`);
      continue;
    }
    try { gUnlink(guard, path); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
  }
  for (const path of tree.links) {
    try { gUnlink(guard, path); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
  }
  for (const dir of [...tree.dirs].reverse()) {
    try { gRmdir(guard, dir); } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT") continue;
      if (code === "ENOTEMPTY" || code === "EEXIST") throw new StaleError(`${nodePath.basename(dir)} gained a name while it was removed`);
      throw error;
    }
  }
}

/** Takes `target` aside, proves nobody has it, reads it in full against `fp` (when given), and deletes it. Held, or a read that
 * differs from the plan, puts it back: EngineOpenError, or StaleError (nothing was removed). `target` may itself be an aside a crash
 * left: it is a file of its own, judged on its own content and ownership, never together with the original. */
function removeGuarded(root: string, target: string, fp: string | undefined, out: { removed: string[] }, owner?: string): void {
  const found = confine(root, target);
  if (found === "refused") throw new Error(`refused (outside its root or through a link) ${target}`);
  if (found === "absent") return;
  const full = found.full;
  const stat = lstatOrNull(full);
  if (!stat) return;
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
    linksWaitInOpenPass([full]);
    // a link is only a name
    needHelper();
    try { gUnlink(treeGuard({ files: [], links: [full] }), full); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
    if (lstatOrNull(full)) throw new Error(`could not remove ${full}`);
    out.removed.push(full);
    return;
  }
  if (isAside(full)) { settleAside(full, baseOf(full), fp, out, false, owner); return; }
  // The original goes aside under its aside name. An aside already there is another file with its own step: it is never
  // replaced, and until it is settled this one waits.
  const away = aside(full);
  if (lstatOrNull(away)) throw new EngineOpenError("held", "an earlier copy is still aside");
  if (moveAside(noGuard, full, away) === "gone") return;
  settleAside(away, full, fp, out, true, owner);
}

/** `created`: this step just moved the original aside, so a refusal puts it back. A leftover aside stays where it is. */
function settleAside(away: string, original: string, fp: string | undefined, out: { removed: string[] }, created: boolean, owner?: string): void {
  const stat = lstatOrNull(away);
  if (!stat) return;
  needHelper();
  const folder = stat.isDirectory();
  const reader = realEngineFs();
  const tree: Tree = folder ? treeOf(away) : { files: [away], links: [], dirs: [] };
  const backIfCreated = () => { if (created) putBack(away, original, folder); };
  const judged = new Map<string, Judged>();
  let same = true;
  try {
    linksWaitInOpenPass(tree.links);
    // macOS, Linux: nobody finds the aside by name, so only a process that opened a file of it BEFORE it was moved can write to it, and
    // that process is running now. The engine must be closed now, after the move, and no process may have a file of it open for
    // writing: then what is read next is final.
    if (exclOps.mode === "posix") {
      const gate = gateNow();
      if (gate.state !== "closed") throw notClosed(gate);
      noWriters(tree.files);
    }
    // Read in full BEFORE any hold (Windows: the handle that deletes is taken after, one file at a time, and checks the file is still
    // the one read: its identity and size).
    const before = folder ? null : judgedOf(away);
    same = fp === undefined || folder || associationsOf(reader, away, []).fp === fp;
    // a Codex rollout: the id, folder and type of its first line must be what the plan saw
    if (same && owner !== undefined) same = !folder && reader.rolloutOwner(away) === owner;
    if (same && before) {
      const after = judgedOf(away);
      if (!after || after.ino !== before.ino || after.size !== before.size) same = false; else judged.set(away, after);
    }
    if (same) markDeleteEach(tree.files, judged);
  } catch (error) {
    backIfCreated();
    throw error;
  }
  if (!same) {
    backIfCreated();
    throw new StaleError(`${nodePath.basename(original)} names something the plan did not see`);
  }
  try { deleteTree(treeGuard(tree), tree); } catch (error) {
    if (error instanceof StaleError) backIfCreated();
    throw error;
  }
  if (lstatOrNull(away)) throw new Error(`could not remove ${original}`);
  out.removed.push(original);
}

/** A folder with nothing in it goes; one that gained a name since the plan stays and the home is planned again. */
function removeEmptyDir(root: string, target: string, out: { removed: string[] }): void {
  const found = confine(root, target);
  if (found === "refused") throw new Error(`refused (outside its root or through a link) ${target}`);
  if (found === "absent") return;
  const stat = lstatOrNull(found.full);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new StaleError(`${nodePath.basename(target)} is no longer a folder`);
  try { gRmdir(noGuard, found.full); out.removed.push(found.full); } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return;
    if (code === "ENOTEMPTY" || code === "EEXIST") throw new StaleError(`${nodePath.basename(target)} gained a name since the plan`);
    throw error;
  }
}

const TRANSCRIPT = /\.jsonl(?:\.murage-deleting)?$/;

/** A folder that holds session ids is not deleted where it stands, and never from a single listing. It is renamed to its aside (by
 * a rename that cannot replace), the aside is listed again, nobody may hold the folder or any file in the entries it will remove
 * (open, or as a working directory), and each entry of THAT listing is removed on its own, only if the plan listed it and (a
 * session file) only while what it names, read in full while held, is what the plan saw. Files are deleted one at a time and the
 * folders that held them only when empty: nothing is removed recursively, so nothing arriving later is deleted unseen. Then the
 * aside itself is removed as an empty folder. Anything else (a name that appeared since, a file that now names another folder)
 * stays, and the step is a change (StaleError): the next plan lists what is there. When the folder had to be kept, or an engine
 * holds something in it, and its place is free, it is put back, so an engine and the owner's other conversations still find it.
 * An aside already there (a crash, or a change reported earlier) is judged the same way first, with the fingerprints the plan
 * saved for ITS files (keyed by the aside's marker), never those of the folder of the same name. */
function removeListed(step: Extract<Step, { k: "remove" }>, out: { removed: string[] }): void {
  const reader = realEngineFs();
  const expect = new Set(step.expect ?? []);
  const away = aside(step.target);
  const api = pathApiFor(step.root);
  const giveBack = () => { if (!lstatOrNull(step.target)) putBack(away, step.target, true); };
  const voucher = (name: string, leftover: boolean): string | undefined => step.assoc?.[leftover ? `${ASIDE_SUFFIX}/${name}` : name];
  /** Removes the listed, unchanged entries of `dir` one by one, then `dir` itself when nothing else is in it. Returns what stays. */
  const settle = (dir: string, leftover: boolean): string[] => {
    const names = reader.readdir(dir);
    const victims = names.filter((name) => expect.has(name));
    const stays = names.filter((name) => !expect.has(name));
    const approved: Array<{ name: string; tree: Tree }> = [];
    if (victims.length) {
      needHelper();
      const trees = victims.map((name) => ({ name, tree: treeOf(api.join(dir, name)) }));
      linksWaitInOpenPass(trees.flatMap((item) => item.tree.links));
      // macOS, Linux: the folder is aside, so only a process that opened a file in it before the move can still write there (see
      // settleAside): the engine must be closed now and no process may have one of its files open for writing, before the reads that decide
      if (exclOps.mode === "posix") {
        const gate = gateNow();
        if (gate.state !== "closed") throw notClosed(gate);
        noWriters(trees.flatMap((item) => item.tree.files));
      }
      for (const { name, tree } of trees) {
        const path = api.join(dir, name);
        const want = voucher(name, leftover);
        // a session file the plan did not fingerprint is not one it can vouch for
        if (step.assoc && TRANSCRIPT.test(name) && want === undefined) { stays.push(name); continue; }
        const judged = new Map<string, Judged>();
        if (want !== undefined) {
          // read in full BEFORE any hold; Windows then holds each file only to check it is the one read and to mark it
          const before = judgedOf(path);
          if (associationsOf(reader, path, []).fp !== want) { stays.push(name); continue; }
          const after = judgedOf(path);
          if (before && (!after || after.ino !== before.ino || after.size !== before.size)) { stays.push(name); continue; }
          if (after) judged.set(path, after);
        }
        markDeleteEach(tree.files, judged);
        approved.push({ name, tree });
      }
    }
    for (const { name, tree } of approved) {
      deleteTree(treeGuard(tree), tree);
      out.removed.push(api.join(dir, name));
    }
    if (stays.length) return stays;
    try { gRmdir(noGuard, dir); out.removed.push(dir); } catch (error) {
      const code = codeOf(error);
      if (code === "ENOENT") return stays;
      if (code === "ENOTEMPTY" || code === "EEXIST") stays.push("(arrived)");
      else throw error;
    }
    return stays;
  };
  const stale = (dir: string, stays: string[]): never => {
    throw new StaleError(`${nodePath.basename(dir)} holds ${stays.length} name${stays.length === 1 ? "" : "s"} the plan did not list or could not vouch for`);
  };
  /** `created`: this step moved the folder aside, so a refusal puts it back. A leftover aside stays exactly where it is. */
  const settleOrGiveBack = (dir: string, leftover: boolean, created: boolean): string[] => {
    try { return settle(dir, leftover); } catch (error) { if (created && (error instanceof EngineOpenError || error instanceof StaleError)) giveBack(); throw error; }
  };
  if (lstatOrNull(away)) {
    const stays = settleOrGiveBack(away, true, false);
    if (stays.length) stale(away, stays);
  }
  const stat = lstatOrNull(step.target);
  if (!stat) return;
  // Only a real folder is moved; a link or a file is removed as it stands.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    removeGuarded(step.root, step.target, undefined, out);
    return;
  }
  if (moveAside(noGuard, step.target, away) === "gone") return;
  const stays = settleOrGiveBack(away, false, true);
  if (stays.length) {
    // Put the folder back if its place is still free: what stayed is not ours, and its engine keeps finding it there.
    giveBack();
    stale(away, stays);
  }
}

// ── Claude's directory lock, and a paste removed only while the history that could name it is held ──────────────────────

/** Does the held file hold `needle` between byte `from` and byte `to`? Read 1 MiB at a time, with the end of each read carried into the next. */
function fileMentions(file: FileRef, needle: string, from = 0, to = Number.POSITIVE_INFINITY): boolean {
  const want = Buffer.from(needle);
  if (!want.length) return false;
  let position = from, tail: Buffer = Buffer.alloc(0);
  while (position < to) {
    const chunkBytes = mutOps.pread(file, Math.min(1024 * 1024, to - position), position);
    if (!chunkBytes.length) return false;
    position += chunkBytes.length;
    const joined = Buffer.concat([tail, chunkBytes]);
    if (joined.includes(want)) return true;
    tail = joined.subarray(Math.max(0, joined.length - (want.length - 1)));
  }
  return false;
}

/** Claude Code locks its history with a DIRECTORY lock, `<file>.lock` (real-engine qualification of 2.1.296): it makes the folder,
 * treats one not touched for 10 s as abandoned, retries for about 9 s and then keeps its row in memory. Murage takes the same lock the
 * same way: it makes the folder (under a private name, then renamed to the public one so that its identity is known from the first moment), and holds it for at most HOLD_MAX_MS. A fresh folder that is not ours is the engine's
 * (or a sign it just started): the home stays pending and it is NEVER removed. The public path `history.jsonl.lock` is never removed at
 * all, by anything: a folder there can be replaced by the engine between any two calls. What is removed is a folder that has been renamed
 * to a PRIVATE name of Murage's and whose identity (device and inode) has been checked there:
 *   - one nobody touched for 10 s is abandoned by the engine's own rule: while Claude is still closed it is renamed to a private name;
 *     if what came off the public path is the very folder that was seen and is still untouched, it is removed under the private name and
 *     Murage makes its own; if it is anything else it is renamed back (when the name is free; else it stays as a recorded leftover) and
 *     the home is pending;
 *   - Murage's own folder is released the same way: renamed to a private name, removed there only if it is the one Murage made, else
 *     renamed back.
 * The folder's identity is recorded when it is made; `guard` (asked inside every destructive call) says it is still ours and not older
 * than HOLD_MAX_MS. */
const LOCK_STALE_MS = 10_000;
const LOCK_FRESH_MS = 1_000;

/** The window of the home that is being run (executeEnginePlans): what stale-lock cleanup asks again before it moves anything. */
interface Window { engine: string; home: string; dbs: string[]; identities: string[]; /** DELETION-WHILE-OPEN-107: an open-home pass */ open?: boolean }
let currentWindow: Window | null = null;
/** The gate's whole verdict, asked again while the lock is taken: an open engine and one that could not be checked are told apart. */
const verdictNow = (ownLock: boolean): EngineVerdict => (currentWindow ? engineState(currentWindow.engine, currentWindow.home, { dbs: currentWindow.dbs, identities: currentWindow.identities, ignoreHistoryLock: ownLock }) : { state: "unknown", via: "enumeration" });
/** Private folders of Murage's that could not be given back or removed (named in the run's result). */
let strays: string[] = [];

const privateName = (lock: string): string => `${lock}.murage-${exclOps.ownPid()}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;

function withDirLock(file: string, work: (guard: Guard, lockAgeMs: () => number, sameFile: (check: () => boolean) => void) => void): void {
  needHelper();
  const lock = `${file}.lock`;
  let mine: { dev: bigint; ino: bigint; mtimeNs: bigint } | null = null;
  let since = 0;
  // ours: the same device and inode AND the modification time Murage stamped on it (an inode number can be handed out again at once)
  const stillMine = (): boolean => {
    try { const now = mutOps.idOf(lock); return !!mine && now.dev === mine.dev && now.ino === mine.ino && now.mtimeNs === mine.mtimeNs; } catch { return false; }
  };
  /** The lock is made under a private name nobody else knows, its identity is read there, and only then does it take the public name by a
   * rename that cannot replace. There is no moment at which the folder at the public path could be someone else's and be recorded as
   * ours. A taken name is EEXIST, exactly as it is for the engine's own mkdir. */
  const take = (): void => {
    const priv = privateName(lock);
    mutOps.mkdir(priv);
    let ok = false;
    try {
      // a time of its own, a little in the past and never more than half a second (so the lock still reads as fresh)
      mutOps.touchAt(priv, Date.now() / 1000 - 0.02 - Math.random() * 0.4);
      const id = mutOps.idOf(priv);
      const outcome = gMove(noGuard, priv, lock);
      if (outcome === "exists") throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      if (outcome === "unsupported") throw new EngineOpenError("held", "this file system cannot take a lock without risking the engine's");
      mine = id;
      since = mutOps.now();
      ok = true;
    } finally {
      if (!ok) { try { gRmdir(noGuard, priv); } catch { /* it stays as a leftover of Murage's own */ } }
    }
  };
  /** A private folder that is not ours goes back under the public name when that is free; otherwise it stays, and is recorded. */
  const giveLockBack = (priv: string): void => {
    try { if (gMove(noGuard, priv, lock) === "ok") return; } catch { /* stays as a leftover */ }
    strays.push(priv);
  };
  const claimed = (): never => { throw new EngineOpenError("open", "its engine holds the lock"); };
  const acquire = (): void => {
    for (let pass = 0; ; pass++) {
      try { take(); return; } catch (error) { if (codeOf(error) !== "EEXIST") throw error; }
      const seen = lstatOrNull(lock);
      if (!seen) { if (pass >= 1) claimed(); continue; } // it went away between the two calls: once more
      if (Date.now() - seen.mtimeMs < LOCK_STALE_MS) claimed();
      // Claude's lock is a folder; anything else at its name is not Claude's to give up, and not Murage's to remove
      if (!seen.isDirectory() || seen.isSymbolicLink()) throw new EngineOpenError("held", "something that is not a lock folder is at its lock's name");
      // Untouched for 10 s: abandoned by the engine's own rule, and replaced only while the engine is still closed. An engine that
      // could not be checked is said so ("could not check"), never "is open".
      const gate = verdictNow(false);
      if (gate.state !== "closed") throw notClosed(gate);
      const priv = privateName(lock);
      let moved: "ok" | "exists" | "unsupported";
      try { moved = gMove(noGuard, lock, priv); } catch (gone) { if (codeOf(gone) === "ENOENT") continue; throw gone; }
      if (moved !== "ok") throw new EngineOpenError("held", "its lock cannot be moved aside");
      // What came off the public path must be the very folder that was seen, and still untouched.
      const got = lstatOrNull(priv);
      if (!got || got.dev !== seen.dev || got.ino !== seen.ino || Date.now() - got.mtimeMs < LOCK_STALE_MS) { giveLockBack(priv); claimed(); }
      gRmdir(noGuard, priv);
      try { take(); } catch (again) { if (codeOf(again) === "EEXIST") claimed(); throw again; }
      const after = verdictNow(true);
      if (after.state !== "closed") { release(); throw notClosed(after); }
      return;
    }
  };
  const release = (): void => {
    if (!mine) return;
    const was = mine;
    mine = null;
    const priv = privateName(lock);
    try {
      if (gMove(noGuard, lock, priv) !== "ok") return;
    } catch (error) { if (codeOf(error) === "ENOENT") return; throw error; }
    const now = idOrNull(priv);
    if (now && now.dev === was.dev && now.ino === was.ino && now.mtimeNs === was.mtimeNs) gRmdir(noGuard, priv);
    else if (now) giveLockBack(priv);
  };
  let fileIsSame: (() => boolean) | undefined;
  acquire();
  try {
    work(holdGuard({ alive: stillMine, same: () => !fileIsSame || fileIsSame(), since, what: "its lock" }), () => { const at = exclOps.mtimeOf(lock); return at === null ? Number.POSITIVE_INFINITY : Date.now() - at; }, (check) => { fileIsSame = check; });
  } finally {
    try { release(); } catch { /* a lock that could not be given up is abandoned by the engine's own rule after 10 s */ }
  }
}

/** At start-up: the private folders a Murage that was killed while it held Claude's lock (or while it removed an abandoned one) left
 * next to `file`, `<file>.lock.murage-<pid>-<random>`. They are Murage's own names, never Claude's, and empty: each one untouched for
 * 10 s is removed (rmdir, so a folder with anything in it stays). The public lock path is never touched. Returns how many went. */
function sweepPrivateLocks(file: string): number {
  const dir = nodePath.dirname(file);
  const prefix = `${nodePath.basename(file)}.lock.murage-`;
  let removed = 0;
  for (const name of exclOps.namesIn(dir)) {
    if (!name.startsWith(prefix) || !/^\d+-[0-9a-z]+$/.test(name.slice(prefix.length))) continue;
    const path = nodePath.join(dir, name);
    const stat = lstatOrNull(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || Date.now() - stat.mtimeMs < LOCK_STALE_MS) continue;
    try { gRmdir(noGuard, path); removed++; } catch { /* not empty, or gone: it stays */ }
  }
  return removed;
}

/** Was the file `history` last seen with `needle` in it, and as which file and how long: the long read of a paste's check, made BEFORE any
 * hold is taken. Null when there is no history. */
function scanHistory(history: string, needle: string): { referenced: boolean; ino: number; size: number } | null {
  if (!lstatOrNull(history)) return null;
  const fd = mutOps.openRead(history);
  try {
    const { ino, size } = mutOps.fstat(fd);
    return { referenced: fileMentions(fd, needle, 0, size), ino, size };
  } finally { mutOps.close(fd); }
}

/** A pasted text goes only when no row of the history names it. The long read comes first, with no hold; the paste is then renamed to
 * a private aside (so Claude cannot open it by name); under Claude's lock only what arrived since the read is looked at, the guard is
 * asked, the lock is checked fresh, and the aside is unlinked. Any check that fails puts the paste back under its name (never over a
 * name that is taken) and the home stays pending. */
function removeUnlessReferenced(step: Extract<Step, { k: "removeUnlessReferenced" }>, out: { removed: string[] }): void {
  const away = aside(step.target);
  if (!lstatOrNull(step.target) && !lstatOrNull(away)) return;
  needHelper();
  const found = confine(step.root, step.target);
  if (found === "refused") throw new Error(`refused (outside its root or through a link) ${step.target}`);
  if (found === "absent") return;
  if (lstatOrNull(aside(step.refFile))) throw new EngineOpenError("held", "its history is still aside");
  const before = scanHistory(step.refFile, step.needle);
  if (before?.referenced) { if (!lstatOrNull(step.target)) putBack(away, step.target, false); return; } // a row that remains still uses it
  // out of Claude's sight before the lock; a copy a crash left aside is judged the same way and is not put back
  let created = false;
  if (lstatOrNull(step.target) && !lstatOrNull(away)) { if (moveAside(noGuard, step.target, away) === "gone") return; created = true; }
  if (!lstatOrNull(away)) return;
  const back = (): void => { if (created || !lstatOrNull(step.target)) putBack(away, step.target, false); };
  const identity = treeGuard({ files: [away], links: [] });
  // the aside as it was judged right after the move: on Windows the share-none deletion handle must still find this very file
  const judged = judgedOf(away);
  try {
    // macOS, Linux: a process that opened the paste before it was moved aside and still has it open for writing keeps it (put back,
    // the home stays pending "held"). Windows: the share-none deletion handle below is that proof.
    noWriters([away]);
    chunk(() => withDirLock(step.refFile, (guard, lockAge) => {
      const fd = lstatOrNull(step.refFile) ? mutOps.openRead(step.refFile) : null;
      try {
        if (fd !== null) {
          const now = mutOps.fstat(fd);
          if (!before || now.ino !== before.ino || now.size < before.size) throw new StaleError("the history was replaced since it was read");
          if (fileMentions(fd, step.needle, before.size, now.size)) throw new Referenced();
        } else if (before) throw new StaleError("the history is gone");
        guard();
        if (lockAge() >= LOCK_FRESH_MS) throw new HoldExpired();
        if (exclOps.mode === "win32") {
          // a handle nobody can share, opened only now and still the file judged after the move: a process that has the paste open
          // (even one that allows delete sharing) refuses it, and it goes back under its name
          if (!judged) throw new EngineOpenError("held", "the paste moved aside could not be judged");
          identity(away); guard(away);
          markDeleteEach([away], new Map([[away, judged]]));
        } else gUnlink((path) => { identity(path); guard(path); }, away);
      } finally { if (fd !== null) mutOps.close(fd); }
    }));
  } catch (error) {
    back();
    if (error instanceof Referenced) return; // a row arrived that names it: the paste stays
    throw error;
  }
  out.removed.push(step.target);
}
/** A row that arrived while the lock was held names the paste: it stays. */
class Referenced extends Error { constructor() { super("referenced"); this.name = "Referenced"; } }

// ── JSONL rewrites ──────────────────────────────────────────────────────

function sameFile(fd: number, path: string): boolean {
  try {
    const want = mutOps.idOf(path), have = mutOps.idOfFd(fd);
    return want.dev === have.dev && want.ino === have.ino;
  } catch { return false; }
}

/** The file is held the way its class says, for at most HOLD_MAX_MS, and `body` runs on it with a guard that is asked inside every
 * destructive call. A hold that ran out is taken again once (see `chunk`).
 *   lock       the engine's own whole-file lock on the open file (LockFileEx on Windows, on a handle the addon owns)
 *   dirlock    the engine's directory lock (withDirLock)
 *   inplace    nothing: the file is opened with every kind of sharing and compared again, byte by byte, before each write
 *   exclusive  the engine's lock if it keeps one, on a file that was already set aside (Windows: a handle nobody can share). Recovery
 *              (recoverAll) may find such a file back under its PLAIN name (put back after the cut): it is then held only by that lock,
 *              which Kimi does not take, so in effect `inplace`. That is enough there: recovery runs only with the engine closed, and
 *              what it writes are the journal's fill bytes, the same whoever writes them, at rows found again by their skeleton.
 * `ino`: the file's inode in the plan; a file with another inode is not the file that was planned (StaleError). */
function withRowHold(how: "lock" | "dirlock" | "inplace" | "exclusive", path: string, ino: number | undefined, body: (file: FileRef, guard: Guard) => void): void {
  const name = nodePath.basename(path);
  chunk(() => {
    if (how === "dirlock") {
      withDirLock(path, (lockGuard, _age, fileIs) => {
        const fd = mutOps.openReadWrite(path);
        try {
          if (!sameFile(fd, path) || (ino && mutOps.fstat(fd).ino !== ino)) throw new StaleError(`${name} was replaced`);
          fileIs(() => sameFile(fd, path)); // asked inside the guard, before the hold's age
          body(fd, lockGuard);
        } finally { mutOps.close(fd); }
      });
      return;
    }
    if (exclOps.mode === "win32") {
      const held = exclOps.openFile(path, how === "exclusive" ? "exclusive" : "shared");
      if (!held) throw new EngineOpenError("held", "another process has it open");
      try {
        if (how === "lock" && !held.lock()) throw new EngineOpenError("held", "its engine holds the lock");
        const since = mutOps.now();
        if (ino && mutOps.fstat(held).ino !== ino) throw new StaleError(`${name} was replaced`);
        body(held, holdGuard({ alive: () => true, since, what: name }));
      } finally { mutOps.close(held); } // closing lets go of the lock
      return;
    }
    const fd = mutOps.openReadWrite(path);
    try {
      if ((how === "lock" || how === "exclusive") && !exclOps.lock(fd)) throw new EngineOpenError("held", "its engine holds the lock");
      const since = mutOps.now();
      if (!sameFile(fd, path) || (ino && mutOps.fstat(fd).ino !== ino)) throw new StaleError(`${name} was replaced`);
      body(fd, holdGuard({ alive: () => true, same: () => sameFile(fd, path), since, what: name }));
    } finally { mutOps.close(fd); } // closing lets go of the lock
  });
}

/** The journals the running step wrote: a chunk that is taken again (its hold ran out) meets its own journal, which is not an earlier
 * change waiting to be finished. Emptied at the start of every step. */
const stepRecords = new Set<string>();

/** A step's rows as read and journalled BEFORE its hold is taken: the identity of the file read, and each row still to clear with the
 * ranges to overwrite and its skeleton. */
interface PreparedRows { dev: string; ino: string; rows: Array<{ row: RowRef; edits: RowEdit[]; skel: string }> }

/** The long part of a rewrite, made with NO hold: the journals already on disk are listed, the planned rows are read and compared by
 * their skeleton, and this step's own journal is written and made durable (the file and its folder). The hold that follows covers only
 * comparing each row again, the overwrites and their sync, so a slow disk under the journal never makes an engine wait or a hold run
 * out. A journal of an EARLIER change to the same file (another deletion's step that failed or was cut) is never replaced: the step is
 * stale, and the next plan finishes that journal first (recoverAll). `physical`: the file as it is named now (an aside's name while the
 * file is aside). */
function prepareRows(step: RewriteStep, format: JsonlFormat, physical: string): PreparedRows {
  const name = nodePath.basename(step.path);
  // Windows, for a file the addon holds (every class but Claude's directory lock): read through a handle of the addon's that shares
  // everything (a probe), so this read never holds the file
  const fd: FileRef | null = exclOps.mode === "win32" && step.how !== "dirlock" ? exclOps.openFile(physical, "probe") : mutOps.openRead(physical);
  if (fd === null) throw new EngineOpenError("held", "it could not be opened to be read");
  try {
    const id = mutOps.idOfFd(fd);
    const dev = String(id.dev), ino = String(id.ino);
    if (step.fp.ino && mutOps.fstat(fd).ino !== step.fp.ino) throw new StaleError(`${name} was replaced`);
    // the same file: the same identity AND the same name (a deleted file's inode number can be given to an unrelated new file)
    if (rowsRecordsOf(listRedo(), dev, ino).some((rec) => !stepRecords.has(rec.id) && plainName(rec.path) === plainName(physical))) throw new StaleError(`${name} has an earlier change to finish first`);
    const rows: PreparedRows["rows"] = [];
    for (const row of step.lines) {
      const cur = mutOps.pread(fd, row.len, row.off);
      if (cur.length !== row.len) throw new StaleError(`${name} changed where a row was planned`);
      const edits = clearEdits(cur, format);
      if (!edits) throw new StaleError(`${name} holds a row that could not be read as one object`);
      if (rowSkeleton(cur, format) !== row.sha) throw new StaleError(`${name} changed where a row was planned`);
      if (edits.length) rows.push({ row, edits, skel: skeletonOf(cur, edits) }); // none: cleared by an earlier run of this step
    }
    if (rows.length) {
      if (!redoDirectory()) throw new HelperError();
      const at = currentWindow;
      stepRecords.add(writeRedo({
        path: physical, dev, ino, engine: at?.engine ?? "", home: at?.home ?? "", how: step.how, format: step.format,
        rows: rows.map((item) => ({ off: item.row.off, len: item.row.len, skel: item.skel, edits: item.edits.map((edit) => ({ at: edit.at, len: edit.len, kind: edit.kind })) })),
      }));
    }
    return { dev, ino, rows };
  } finally { mutOps.close(fd); }
}

/** After the hold is let go: the rows' writes are made durable through the drive's own cache (the folder's sync; macOS F_FULLFSYNC, which
 * covers every write already synced on that drive) and only then are this step's journals removed. A power cut before this keeps the
 * journal, and the next start finishes the rows from it. When the barrier was only the fallback, the journals stay (marked) for a later
 * start to read the rows again and drop them only if they are still cleared (recoverAll). */
function finishPrepared(physical: string): void {
  if (!stepRecords.size) return;
  const barrier = durableBarrier(physical);
  const records = barrier === "fallback" ? listRedo() : [];
  for (const own of [...stepRecords]) {
    if (barrier === "full") dropRedo(own);
    else { const rec = records.find((item) => item.id === own); if (rec) markFellBack(rec); }
    stepRecords.delete(own);
  }
}

/** The one barrier every journal waits for before it is dropped (a rewrite's rows, a recovery's repair, a join's bytes): the file, then
 * its folder, made durable through the drive's own cache (macOS F_FULLFSYNC on each; elsewhere fsync). Windows: the writes were flushed
 * on their own handle (FlushFileBuffers) and a folder cannot be opened; nothing more to do. "full": the journal may go now. "fallback"
 * (a macOS file system without F_FULLFSYNC: plain fsync, which Apple documents may lose or reorder writes on a power cut): the journal
 * stays, marked (engine-redo.ts markFellBack), and only a read after the operating system has restarted, that reads the bytes again and finds them as written drops it. A
 * sync that reported no barrier at all keeps the journal unmarked (HelperError), and the next start finishes the rows from it again. */
function durableBarrier(physical: string): "full" | "fallback" {
  const file = mutOps.fsyncFile(physical);
  const folder = mutOps.fsyncDir(nodePath.dirname(physical));
  if (!known(file) || !known(folder)) throw new HelperError();
  return file === "full" && folder === "full" ? "full" : "fallback";
}
const known = (barrier: Barrier | void): boolean => barrier === "full" || barrier === "fallback";
/** A journal whose barrier fell back, marked in an earlier BOOT of the operating system (engine-redo.ts rebootedSince): only then can a
 * read show what reached the drive rather than what its cache still holds, so only such a journal may be verified and dropped. A restart
 * of Murage alone, any worker, any later run in the same boot, never may. */
const markedBeforeReboot = (rec: AnyRecord): boolean => rec.fellBack !== undefined && rebootedSince(rec.fellBack);

/** With the file held (see withRowHold): each prepared row read again and compared by its skeleton just before its content is
 * overwritten in place, synced, and read back to prove every planned row is cleared. Nothing is written unless every row is as planned
 * (or already cleared by an earlier run of this step), so a change since the plan is a StaleError with the file untouched. */
function commitRows(file: FileRef, step: RewriteStep, format: JsonlFormat, guard: Guard, prepared: PreparedRows): void {
  const name = nodePath.basename(step.path);
  // the file held is the file read (its inode: Windows names a volume two ways, by Node and by the addon, so only the inode is compared)
  if (String(mutOps.idOfFd(file).ino) !== prepared.ino) throw new StaleError(`${name} was replaced since it was read`);
  for (const item of prepared.rows) {
    // read again, just before the write: a row that is no longer what the plan saw is not written
    const cur = mutOps.pread(file, item.row.len, item.row.off);
    if (cur.length !== item.row.len || rowSkeleton(cur, format) !== item.row.sha) throw new StaleError(`${name} changed where a row was planned`);
    if (isCleared(cur, format)) continue;
    const edits = clearEdits(cur, format);
    if (!edits || edits.length !== item.edits.length || edits.some((edit, at) => edit.at !== item.edits[at]!.at || edit.len !== item.edits[at]!.len)) throw new StaleError(`${name} changed where a row was planned`);
    for (const edit of edits) gPwrite(guard, file, edit.bytes, item.row.off + edit.at);
  }
  if (prepared.rows.length) mutOps.fsync(file);
  for (const row of step.lines) {
    if (!isCleared(mutOps.pread(file, row.len, row.off), format)) throw new StaleError(`${name} did not take the change`);
  }
}

/** The file stays where it is; the engine's own lock is taken on it and held while the rows are compared, written and synced. */
function clearUnderLock(step: RewriteStep, format: JsonlFormat): void {
  const prepared = prepareRows(step, format, step.path);
  withRowHold("lock", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, prepared));
  finishPrepared(step.path);
}

/** Claude Code's history: the engine's directory lock (withDirLock) is held while the rows are compared, written, synced and verified.
 * The file stays where it is. */
function clearUnderDirLock(step: RewriteStep, format: JsonlFormat): void {
  const prepared = prepareRows(step, format, step.path);
  withRowHold("dirlock", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, prepared));
  finishPrepared(step.path);
}

/** Codex's session_index.jsonl: no lock and no aside. Codex appends to it (write and close, so a row appended meanwhile commutes with
 * an overwrite of an earlier one) and replaces it by writing a temporary file and renaming it over the name (so a new file at the name
 * means Codex's rewrite won). The rows are compared again on the open file, overwritten and synced; the handle is then let go, and only
 * after that is the file found again BY NAME: the same file, every row cleared. On Windows the handle shares reading, writing and
 * deletion, and is held only for the compare, the overwrite and the flush, so Codex's rename over the name is never refused because of
 * a check of Murage's. A new file at the name (Codex's rewrite won, before or during the hold) makes the step stale: the home is planned
 * again in the same attempt (engine-history-run.ts, up to MAX_ENGINE_ROUNDS) and Codex's new file is cleared then; what Murage wrote
 * into the replaced file went with it, and the journal of those rows finds Codex's new file by the rows' skeletons if it is still there
 * at the next start (recoverAll). */
function clearInPlace(step: RewriteStep, format: JsonlFormat): void {
  const name = nodePath.basename(step.path);
  const prepared = prepareRows(step, format, step.path);
  let written: { dev: bigint; ino: bigint } | undefined;
  withRowHold("inplace", step.path, step.fp.ino, (file, guard) => {
    commitRows(file, step, format, guard, prepared);
    written = mutOps.idOfFd(file);
  });
  const again = exclOps.mode === "win32" ? exclOps.openFile(step.path, "probe") : mutOps.openRead(step.path);
  if (again === null) throw new EngineOpenError("held", "another process has it open");
  try {
    const now = mutOps.idOfFd(again);
    if (!written || now.dev !== written.dev || now.ino !== written.ino) throw new StaleError(`${name} was replaced after it was cleared`);
    for (const row of step.lines) if (!isCleared(mutOps.pread(again, row.len, row.off), format)) throw new StaleError(`${name} did not keep the change`);
  } finally { mutOps.close(again); }
  finishPrepared(step.path);
}

/** The name an engine's second file waits under while it is joined to the first (REJOIN). */
const REJOINING_SUFFIX = ".murage-rejoining";
/** A file's name without the marks Murage gives it while it works on it (aside, rejoining). */
const plainName = (path: string): string => baseOf(path.endsWith(REJOINING_SUFFIX) ? path.slice(0, -REJOINING_SUFFIX.length) : path);
const rejoining = (original: string): string => `${original}${REJOINING_SUFFIX}`;
const MAX_JOIN_BYTES = 64 * 1024 * 1024;

/** REJOIN. The engine started a new file at `original` while Murage had the old one set aside as `away`: the engine's newer rows
 * are written after the old file's, which then goes back to the name (by the caller), so nothing the engine wrote is lost and nothing
 * is hidden from its picker. A join an earlier attempt left half way (its file is still under the private name) is finished first. */
function rejoin(away: string, original: string): void {
  const second = rejoining(original);
  if (lstatOrNull(second)) joinInto(away, second);
  if (!lstatOrNull(original)) return;
  if (moveAside(noGuard, original, second) === "gone") return;
  joinInto(away, second);
}

/** MERGE. The rows of a legacy aside (`bytes`) that go into the public index: not those that name the conversation being deleted, not
 * those the public index (`prefix`, everything before the join's start) already holds byte for byte. A last row without a newline
 * keeps none. Torn or unreadable rows are kept as they are: only a row that parses and matches is dropped. */
function mergedRows(bytes: Buffer, prefix: Buffer, filter: NonNullable<JoinRecord["filter"]>): Buffer {
  const held = new Set(prefix.toString("latin1").split("\n"));
  const lines = bytes.toString("latin1").split("\n");
  const terminated = lines[lines.length - 1] === "";
  if (terminated) lines.pop();
  const out: string[] = [];
  lines.forEach((line, at) => {
    if (line.length === 0 || held.has(line)) return;
    let row: unknown = null;
    try { row = JSON.parse(Buffer.from(line, "latin1").toString("utf8")); } catch { /* kept as it is */ }
    if (row && typeof row === "object" && !Array.isArray(row) && evalPred(filter.pred, row as Record<string, unknown>)) return;
    out.push(at === lines.length - 1 && !terminated ? line : `${line}\n`);
  });
  return Buffer.from(out.join(""), "latin1");
}

/** An aside an earlier build left next to an engine index that is rewritten in place: the index is never moved, replaced or given a
 * private name. Its surviving rows are appended to the public index in place (joinInto, journalled, engine closed), then the aside is
 * deleted; with no public index the aside simply takes the name back. */
function mergeAside(step: RewriteStep): void {
  const original = step.restoreTo!, away = step.path;
  if (!lstatOrNull(original) && lstatOrNull(rejoining(original))) rejoin(away, original); // an earlier build's REJOIN stopped half way
  if (!lstatOrNull(original)) {
    try { giveName(noGuard, away, original, false); return; } catch (error) { if (codeOf(error) !== "EEXIST") throw error; }
  } else if (sameFileAt(away, original)) { gUnlink(treeGuard({ files: [away], links: [] }), away); return; }
  joinInto(original, away, { format: step.format, pred: step.pred });
}

/** Writes the engine's newer file `second` (already under Murage's private name, so no one can open it by name any more) after the
 * rows of `away`, under the lock of both, and removes it only when no one can still be writing to it:
 *   - the rename that gave `second` its private name is made durable (its folder synced) BEFORE the journal of the join is written, so
 *     a power cut can never bring back a public `second` next to a journal that says it is being joined;
 *   - where its bytes go is journalled (engine-redo.ts JoinRecord: the byte of `away` they start at, and whether a newline goes first),
 *     and they are written THERE, by position, never appended: a join cut half way and done again writes the same bytes at the same
 *     place, so a torn tail is completed, never followed by a second copy;
 *   - only a process that opened `second` before it was moved can still write to it, and such a process is running. Before every
 *     write the engine must be closed; after the copy is synced and read back, no process may have `second` open for writing (by its
 *     identity in every process's open files: a writer the gate cannot name is seen here too), and only THEN is its size compared with
 *     what was copied. Nothing can write to it after that look, so the comparison is final: it grew meanwhile, the new bytes are
 *     copied too (a few rounds at most); a writer still has it, both files stay and the home is pending;
 *   - the joined bytes are made durable through the drive's cache before `second` is unlinked, and the unlink before the journal goes. */
function joinInto(away: string, second: string, mergeFilter?: JoinRecord["filter"]): void {
  const name = nodePath.basename(baseOf(away));
  const fromId = mutOps.idOf(second);
  mutOps.fsyncDir(nodePath.dirname(second));
  // the older file is read and locked through a descriptor that cannot write: while Murage asks whether any process has it open for
  // writing (noWriters, below), Murage itself must not be one. Each write goes through a descriptor opened only after that answer.
  const fd = mutOps.openRead(away);
  let record: JoinRecord | undefined;
  // a journal this call wrote, while nothing of the join has been written yet: if the call stops before its first write, the journal
  // goes too (the older file is as it was), so the next attempt journals the join again from the older file's end as it is THEN
  let fresh = false;
  let wrote = false;
  // a join written in an earlier boot of the operating system whose barrier fell back (JoinRecord.fellBack): its bytes are read again, and when they are all there
  // as the join writes them, nothing is written again and no new barrier is needed before the newer file goes
  let verified = false;
  try {
    if (!exclOps.lock(fd)) throw new EngineOpenError("held", "its engine holds the lock");
    const intoId = mutOps.idOfFd(fd);
    const into = { path: away, dev: String(intoId.dev), ino: String(intoId.ino) };
    const from = { path: second, dev: String(fromId.dev), ino: String(fromId.ino) };
    record = listRedo().find((item): item is JoinRecord => item.kind === "join" && item.into.dev === into.dev && item.into.ino === into.ino && item.from.dev === from.dev && item.from.ino === from.ino);
    if (!record) {
      if (!redoDirectory()) throw new HelperError();
      const size = mutOps.fstat(fd).size;
      const last = size > 0 ? mutOps.pread(fd, 1, size - 1) : Buffer.alloc(0);
      const lead: 0 | 1 = last.length === 1 && last[0] !== 0x0a ? 1 : 0;
      const at = currentWindow;
      const fields = { into, from, base: size, lead, engine: at?.engine ?? "", home: at?.home ?? "", ...(mergeFilter ? { filter: mergeFilter } : {}) };
      record = { v: 2, kind: "join", id: writeJoin(fields), ...fields };
      fresh = true;
    }
    for (let round = 0; ; round++) {
      const reading = mutOps.openRead(second);
      let bytes: Buffer;
      try {
        if (!exclOps.lock(reading)) throw new EngineOpenError("held", "its engine holds the lock of its new file");
        const now = mutOps.idOfFd(reading);
        if (String(now.dev) !== from.dev || String(now.ino) !== from.ino) throw new StaleError(`${name}'s new file was replaced while it was joined`);
        const size = mutOps.fstat(reading).size;
        if (size > MAX_JOIN_BYTES) throw new EngineOpenError("aside", "the new file is too large to join here");
        bytes = mutOps.pread(reading, size, 0);
      } finally { mutOps.close(reading); }
      // a merge writes only the rows `into` does not hold and that do not name the conversation (the prefix before the join's start is
      // fixed, so a join done again writes the same bytes)
      const wanted = record.filter ? mergedRows(bytes, mutOps.pread(fd, record.base, 0), record.filter) : bytes;
      const want = wanted.length ? Buffer.concat([record.lead ? Buffer.from("\n") : Buffer.alloc(0), wanted]) : Buffer.alloc(0);
      if (want.length) {
        // the engine closed now, just before the write (a process the gate sees that still has the older file open would be writing
        // where the join writes), and no process at all has the older file open for writing (one the gate cannot name, R7, that
        // opened it before it was set aside): the join writes by position, so a row such a process appended there would be overwritten
        // Accepted residual R8: another program opening Murage's private working files (.murage-deleting, .murage-rejoining) and
        // writing into them while ignoring the lock is not defended here.
        const before = gateNow();
        if (before.state !== "closed") throw notClosed(before);
        noWriters([away], "aside");
        // only now the size, and what is already after the join's start must be the start of what the join writes (an earlier,
        // interrupted run of this same join): anything else there is a row someone else wrote, and the join never writes over it
        const have = mutOps.fstat(fd).size;
        if (have < record.base || have > record.base + want.length) throw new StaleError(`${name} is not the size the join left it`);
        if (have > record.base && !mutOps.pread(fd, have - record.base, record.base).equals(want.subarray(0, have - record.base))) {
          throw new EngineOpenError("aside", `${name} has a row after the join's start that is not the join's`);
        }
        verified = markedBeforeReboot(record) && have === record.base + want.length;
      }
      if (want.length && !verified) {
        const out = mutOps.openReadWrite(away);
        try {
          const outId = mutOps.idOfFd(out);
          if (!sameFile(out, away) || String(outId.dev) !== into.dev || String(outId.ino) !== into.ino) throw new StaleError(`${name} was replaced while it was joined`);
          const guard = holdGuard({ alive: () => true, same: () => sameFile(out, away), since: mutOps.now(), what: name });
          wrote = true;
          gPwrite(guard, out, want, record.base);
          mutOps.fsync(out);
        } finally { mutOps.close(out); }
        if (!mutOps.pread(fd, want.length, record.base).equals(want)) throw new StaleError(`${name} did not take the joined rows`);
      } else if (!want.length) {
        const have = mutOps.fstat(fd).size;
        if (have !== record.base) throw new StaleError(`${name} is not the size the join left it`);
        verified = markedBeforeReboot(record);
      }
      // R8 (accepted): a program that ignores the lock and writes into .murage-deleting / .murage-rejoining is outside this check.
      const gate = gateNow();
      if (gate.state !== "closed") throw notClosed(gate);
      // nobody may still be able to write to the newer file; after this look nobody can start, so the size read next is final
      noWriters([second], "aside");
      const after = lstatOrNull(second);
      if (after && after.size === bytes.length) break;
      if (!after) throw new StaleError(`${name}'s new file went away while it was joined`);
      if (round >= 2) throw new EngineOpenError("aside", "the new file kept growing while it was joined");
    }
  } catch (error) {
    if (fresh && !wrote && record) { try { dropRedo(record.id); } catch { /* the journal stays: recovery finishes or undoes it */ } }
    throw error;
  } finally { mutOps.close(fd); }
  // the joined rows on the drive itself (the file, then its folder: macOS through the drive's cache) before the only other copy of
  // them is unlinked; the unlink on it before the journal goes
  if (!verified && durableBarrier(away) === "fallback") {
    // the only other copy of these rows stays until, after a restart of the operating system, they are found in the older file as written
    markFellBack(record);
    throw new EngineOpenError("aside", `${name}'s joined rows wait for a restart of the computer to be found on the drive`);
  }
  gUnlink(treeGuard({ files: [second], links: [] }), second);
  mutOps.fsyncDir(nodePath.dirname(second));
  dropRedo(record.id);
}

/** Finishes a join a crash or a power cut left half way (recoverAll). Each file is found by its IDENTITY under any name it can have: the
 * older one under its own, plain or aside name; the newer one under its private name or, when a power cut undid that rename, its plain
 * name again.
 *   - both found, the newer one private: the join goes on (joinInto);
 *   - the newer one back under its plain name: nothing written after the older file's recorded end, the journal goes and the next
 *     attempt joins them again from the start; anything there, both files stay exactly as they are and the journal stays (undoJoin:
 *     nothing is ever cut);
 *   - the newer one under no name: it was unlinked, which happens only after the joined bytes were made durable: the join finished;
 *   - the older one under no name: the newer file is the engine's only file, and goes back under its name if that is free; if the
 *     engine has made yet another file at that name meanwhile, the newer file is joined to that one instead (so its rows are neither
 *     stranded under the private name nor hidden from the next plan). Until one of these succeeds the journal stays (pending). */
function finishJoin(rec: JoinRecord): void {
  const base = baseOf(rec.into.path);
  const is = (path: string, want: { dev: string; ino: string }): boolean => { const id = idOrNull(path); return !!id && String(id.dev) === want.dev && String(id.ino) === want.ino; };
  const into = [rec.into.path, base, aside(base)].find((path) => is(path, rec.into));
  const plainFrom = rec.from.path.endsWith(REJOINING_SUFFIX) ? rec.from.path.slice(0, -REJOINING_SUFFIX.length) : null;
  const fromPrivate = is(rec.from.path, rec.from);
  const fromPublic = !fromPrivate && plainFrom !== null && is(plainFrom, rec.from);
  if (into && fromPrivate) { joinInto(into, rec.from.path, rec.filter); return; }
  if (into && fromPublic) { if (undoJoin(into, plainFrom!, rec)) dropRedo(rec.id); return; }
  // the older file is gone: the newer one is the engine's only file, and goes back under its name if that is free, or is joined to the
  // file the engine made at that name since; a failure keeps the journal, so the private file is never forgotten
  if (!into && fromPrivate && plainFrom !== null) {
    try { giveName(noGuard, rec.from.path, plainFrom, false); } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
      joinInto(plainFrom, rec.from.path);
    }
  }
  dropRedo(rec.id);
}

/** An interrupted join whose newer file came back under its own name (a power cut undid the rename that made it private), seen under the
 * older file's lock. True: the join had written nothing after the older file's recorded end, the state is the one before the join, and
 * the caller drops the journal. Otherwise both files are kept EXACTLY as they are and the journal stays: the home is pending ("aside")
 * and the owner is told so. Murage never shortens or rewrites a file another program may hold: whether the bytes after the recorded
 * end are the join's own or a row another program appended since cannot be settled by any check made before a cut (an editor that
 * ignores the lock can append between the last check and the cut), so nothing is ever cut. The journal counts the times it was found
 * so (`undo`, up to UNDO_JOIN_TRIES, so it is not written again on every start). */
function undoJoin(into: string, _from: string, rec: JoinRecord): boolean {
  const name = nodePath.basename(baseOf(into));
  const fd = mutOps.openRead(into);
  try {
    if (!exclOps.lock(fd)) throw new EngineOpenError("held", "its engine holds the lock");
    if (mutOps.fstat(fd).size <= rec.base) return true;
  } finally { mutOps.close(fd); }
  const refused = (rec.undo ?? 0) + 1;
  if (refused <= UNDO_JOIN_TRIES) countUndo(rec, refused);
  throw new EngineOpenError("aside", `${name} has bytes after an interrupted join's start: both files are kept as they are`);
}

/** The journal of a join, written again with how many undos were refused (a new record first, then the old one dropped: a cut between
 * the two leaves two records of the same join; each counts on its own and both end the same way, and once one has finished the other
 * finds nothing after the join's start and goes). */
function countUndo(rec: JoinRecord, refused: number): void {
  const { id, v: _v, kind: _kind, ...fields } = rec;
  rec.id = writeJoin({ ...fields, undo: refused });
  rec.undo = refused;
  dropRedo(id);
}

/** The file with no lock protocol: unreachable by name and unheld by any process (or, on Windows, opened with sharing off) while it
 * is cleared. It is never merged blindly and never put back over another file: a name that is taken, or any failure to hold it,
 * leaves every file as it is and the home pending. An aside from an earlier run next to a NEW file the engine made is joined to it
 * first (REJOIN). */
function clearExclusively(step: RewriteStep, format: JsonlFormat): void {
  if (exclOps.mode === "win32") {
    const prepared = prepareRows(step, format, step.path);
    withRowHold("exclusive", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, prepared));
    finishPrepared(step.path);
    return;
  }
  const original = step.restoreTo ?? step.path;
  const away = step.restoreTo ? step.path : aside(step.path);
  if (!step.restoreTo) {
    if (lstatOrNull(away)) {
      // two names for one file (an interrupted link back): the extra name goes. Two different files: both stay for REJOIN.
      if (!lstatOrNull(step.path) || !sameFileAt(away, step.path)) throw new EngineOpenError("aside", "an earlier copy of it is still aside");
      gUnlink(treeGuard({ files: [away], links: [] }), away);
    }
    if (moveAside(noGuard, step.path, away) === "gone") return;
  } else if (lstatOrNull(original)) {
    // The aside of an earlier run, and its name is in use. The same file: nothing but the extra name to drop (the step for the
    // name clears its rows). Another file: the engine started a new one, and the two are joined.
    if (sameFileAt(away, original)) { gUnlink(treeGuard({ files: [away], links: [] }), away); return; }
    rejoin(away, original);
  } else if (lstatOrNull(rejoining(original))) rejoin(away, original); // an earlier REJOIN stopped half way
  let failure: unknown;
  let cleared = false;
  try {
    const prepared = prepareRows(step, format, away);
    withRowHold("exclusive", away, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, prepared));
    finishPrepared(away);
    cleared = true;
  } catch (error) { failure = error; }
  // A file this step just moved aside goes back under its name whatever happened (that undoes its own move). An aside an earlier run
  // left goes back only after it was held and cleared: not holding it leaves it exactly where it is.
  if (!step.restoreTo || cleared) {
    try { giveName(noGuard, away, original, false); } catch (error) {
      failure ??= codeOf(error) === "EEXIST" ? new EngineOpenError("aside", "its name was taken while it was aside; both copies stay") : error;
    }
  }
  if (failure) throw failure;
}

/** Clears the content of the planned rows. Returns how many rows were planned. A row that no longer matches (or a file that was
 * replaced) is stale; nothing is written in that case. */
function blankRows(step: RewriteStep): number {
  const reader = realEngineFs();
  const path = step.path;
  const stat = reader.lstat(path);
  if (!stat) return 0; // gone: nothing to rewrite
  if (!stat.isFile() || stat.isSymbolicLink()) throw new StaleError(`${nodePath.basename(path)} is no longer a plain file`);
  const format = JSONL_FORMAT[step.format];
  if (step.mode !== "blank" || !format || (step.how !== "lock" && step.how !== "exclusive" && step.how !== "dirlock" && step.how !== "inplace")) throw new StaleError(`${nodePath.basename(path)} was planned in a form that is no longer used`);
  const rows = step.lines ?? [];
  if (!rows.length && !step.restoreTo) return 0;
  if (step.fp.ino && stat.ino !== step.fp.ino) throw new StaleError(`${nodePath.basename(path)} was replaced`);
  needHelper();
  if (step.how === "lock") clearUnderLock(step, format);
  else if (step.how === "dirlock") clearUnderDirLock(step, format);
  else if (step.how === "inplace" && step.restoreTo) mergeAside(step);
  else if (step.how === "inplace") clearInPlace(step, format);
  else clearExclusively(step, format);
  return rows.length;
}

// ── the crash journal: finishing what a crash left half done ─────────────────────────────────────────────────────────────

/** Writes the journalled edits of `rec` again, row by row. A row is first looked for where the journal says it was (the same bytes
 * apart from the ranges to overwrite: the skeleton); if the engine moved it or rewrote the file, every row of the same length with that
 * skeleton is completed instead. A row nothing matches was dropped by the engine: nothing to finish. The edits are idempotent. */
function repairRows(file: FileRef, path: string, rec: RedoRecord, format: JsonlFormat, guard: Guard): void {
  const name = nodePath.basename(path);
  const size = mutOps.fstat(file).size;
  const applied: Array<{ off: number; len: number }> = [];
  const apply = (row: RedoRow, off: number): void => {
    for (const edit of editsOf(row)) gPwrite(guard, file, edit.bytes, off + edit.at);
    applied.push({ off, len: row.len });
  };
  for (const row of rec.rows) {
    let found = false;
    if (row.off + row.len <= size) {
      const starts = row.off === 0 || mutOps.pread(file, 1, row.off - 1)[0] === 0x0a;
      const ends = row.off + row.len >= size || mutOps.pread(file, 1, row.off + row.len)[0] === 0x0a;
      const cur = mutOps.pread(file, row.len, row.off);
      if (starts && ends && cur.length === row.len && skeletonOf(cur, row.edits) === row.skel) { apply(row, row.off); found = true; }
    }
    if (found) continue;
    const hits: number[] = [];
    realEngineFs().eachLine(path, (line, offset) => { if (line.length === row.len && skeletonOf(line, row.edits) === row.skel) hits.push(offset); }, file);
    for (const off of hits) apply(row, off);
  }
  mutOps.fsync(file);
  for (const item of applied) {
    if (!isCleared(mutOps.pread(file, item.len, item.off), format)) throw new StaleError(`${name} did not take the repair`);
  }
}

/** Every row of `rec` that is still in the file (where the journal says, or found by its skeleton as repairRows finds it) is cleared:
 * nothing is written. */
function rowsStillCleared(file: FileRef, path: string, rec: RedoRecord, format: JsonlFormat): boolean {
  const size = mutOps.fstat(file).size;
  for (const row of rec.rows) {
    const hits: number[] = [];
    if (row.off + row.len <= size) {
      const starts = row.off === 0 || mutOps.pread(file, 1, row.off - 1)[0] === 0x0a;
      const ends = row.off + row.len >= size || mutOps.pread(file, 1, row.off + row.len)[0] === 0x0a;
      const cur = mutOps.pread(file, row.len, row.off);
      if (starts && ends && cur.length === row.len && skeletonOf(cur, row.edits) === row.skel) hits.push(row.off);
    }
    if (!hits.length) realEngineFs().eachLine(path, (line, offset) => { if (line.length === row.len && skeletonOf(line, row.edits) === row.skel) hits.push(offset); }, file);
    for (const off of hits) if (!isCleared(mutOps.pread(file, row.len, off), format)) return false;
  }
  return true;
}

export interface RecoveryResult {
  /** engine homes whose journal could not be finished now: the engine is open or cannot be told, or the file is held */
  pending: Array<{ engine: string; home: string; state: "open" | "unknown" | "held" }>;
  /** how many journals were finished */
  repaired: number;
  /** the journals could not be listed (why, short): nothing can be said about any home, so none is planned */
  unreadable?: string;
}

/** Where the file of a journal of rows is now: found by its IDENTITY (device and inode) under any name it can have (the name it was
 * written under, the plain name, the aside's), so a file that was set aside, put back or joined is still found. When no name holds that
 * file, the engine replaced it (a new inode at the name): its rows may have been copied into the new file, which is searched by the
 * rows' skeletons. Null: no file at any of its names. */
function locateJournalled(rec: RedoRecord): string | null {
  const base = plainName(rec.path);
  const names = [...new Set([rec.path, base, aside(base)])];
  const same = names.find((path) => { const id = idOrNull(path); return !!id && String(id.dev) === rec.dev && String(id.ino) === rec.ino; });
  if (same) return same;
  return [base, aside(base)].find((path) => lstatOrNull(path) !== null) ?? null;
}

/** Finishes every journal a crash or a failed write left behind (see engine-redo.ts), before anything is planned: a row cut in the
 * middle of a value is not one JSON object, and no plan could read it. Each journal is finished under the gate and the hold of its
 * file's class; a join is finished the way joinInto does it. A journal whose engine is open, or cannot be told, or whose file is held
 * stays, and its home stays pending. `identities`: the configured programs of each engine home, by `engine\0home`. Never throws. */
export function recoverAll(identities: Readonly<Record<string, readonly string[]>> = {}, lockedFiles: readonly string[] = [], allow?: (key: string) => boolean): RecoveryResult {
  const result: RecoveryResult = { pending: [], repaired: 0 };
  // `lockedFiles`: files locked by a directory lock (Claude Code's history.jsonl); the empty private folders a killed Murage left next to
  // them go first (never the engine's own lock)
  for (const file of new Set(lockedFiles)) { try { sweepPrivateLocks(file); } catch { /* the next start tries again */ } }
  let records: AnyRecord[];
  try { records = listRedo(); } catch (error) {
    const cause = (error as { cause?: unknown })?.cause ?? error;
    return { ...result, unreadable: ((cause as NodeJS.ErrnoException)?.code ?? (cause instanceof Error ? cause.message : String(cause))).slice(0, 160) };
  }
  for (const rec of records) {
    // marked after a barrier that fell back in THIS boot of the operating system (or one that cannot be compared): only a read after a
    // restart of the system can tell whether the bytes reached the drive
    if (rec.fellBack !== undefined && !markedBeforeReboot(rec)) continue;
    const key = `${rec.engine}\0${rec.home}`;
    // `allow`: only the homes this run may touch. A planning attempt passes the homes it holds (`job.only`, computed after Murage's own
    // sessions on them were held); a journal of any other home is left for the attempt that holds that home, so recovery never writes
    // a home whose engine processes were not held first.
    if (allow && !allow(key)) continue;
    const known = [...(identities[key] ?? [])];
    const verdict = engineState(rec.engine, rec.home, { identities: known });
    if (verdict.state !== "closed") { result.pending.push({ engine: rec.engine, home: rec.home, state: verdict.state }); continue; }
    try {
      needHelper();
      currentWindow = { engine: rec.engine, home: rec.home, dbs: [], identities: known };
      if (rec.kind === "join") { finishJoin(rec); result.repaired++; continue; }
      const format = JSONL_FORMAT[rec.format];
      const how = rec.how;
      const path = locateJournalled(rec);
      if (!format || (how !== "lock" && how !== "dirlock" && how !== "inplace" && how !== "exclusive") || path === null) { dropRedo(rec.id); continue; }
      // a journal kept in an earlier boot of the operating system because its barrier fell back: the rows are read again, and when every one is still cleared
      // they reached the drive and the journal goes with nothing written; otherwise they are repaired again from it
      let verified = false;
      withRowHold(how, path, undefined, (file, guard) => {
        if (markedBeforeReboot(rec) && rowsStillCleared(file, path, rec, format)) { verified = true; return; }
        repairRows(file, path, rec, format, guard);
      });
      // the repaired rows through the drive's cache before the journal that would repair them again goes (the same barrier as a
      // rewrite that completes: finishPrepared); after only the fallback the journal stays, marked, until the computer has restarted
      if (!verified && durableBarrier(path) === "fallback") markFellBack(rec);
      else dropRedo(rec.id);
      result.repaired++;
    } catch (error) {
      const kind = error instanceof EngineOpenError ? error.kind : null;
      result.pending.push({ engine: rec.engine, home: rec.home, state: kind === "unchecked" ? "unknown" : kind === "open" ? "open" : "held" });
    } finally { currentWindow = null; }
  }
  return result;
}

// ── SQLite steps ────────────────────────────────────────────────────────

function withDatabase<T>(path: string, pragmas: string, work: (db: DatabaseSync) => T): T | undefined {
  if (lstatOrNull(path) === null) return undefined; // nothing there any more: the step is done
  const db = mutOps.openDbWrite(path, pragmas) as unknown as DatabaseSync;
  try {
    return work(db);
  } finally {
    db.close();
  }
}
const PRAGMAS = "PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;";

/** Deletes in one write transaction, for the ids the plan saved. With a closure the transaction first asks whether the engine
 * has added a child since planning; if it has, nothing is deleted (ROLLBACK) and the step is stale, so the next plan learns the
 * child's id and removes its transcript too. */
function sqlDeleteOn(db: DatabaseSync, step: Extract<Step, { k: "sqlDelete" }>): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (step.guard) ownersOn(db, step.guard.ids, step.guard.folders, step.db);
    const ids = new Set(step.ids ?? []);
    const closure = step.closure;
    if (closure && ids.size) {
      const current = [...ids];
      for (const row of db.prepare(`SELECT "${closure.idCol}" AS id FROM "${closure.table}" WHERE "${closure.parentCol}" IN (${current.map(() => "?").join(",")})`).all(...current) as Array<{ id: string }>) {
        if (!ids.has(String(row.id))) throw new StaleError(`${nodePath.basename(step.db)} gained a child session`);
      }
    }
    const list = [...ids];
    for (const stmt of step.stmts) {
      if (stmt.useIds && !list.length) continue;
      const where = stmt.useIds ? stmt.where.replace("{ids}", list.map(() => "?").join(",")) : stmt.where;
      db.prepare(`DELETE FROM "${stmt.table}" WHERE ${where}`).run(...(stmt.useIds ? list : stmt.params));
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
/** A thread whose row is still in the store must still belong to the conversation: its working folder is one of the conversation's
 * folders. A row that now names another folder is someone else's thread, whatever it was when the plan was made: StaleError, so
 * nothing is deleted and the next plan drops the id. A row that is not there is nothing to guard. */
function ownersOn(db: DatabaseSync, ids: readonly string[], folders: readonly string[], name: string): void {
  if (!ids.length) return;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  if (!tables.has("threads")) return;
  const columns = new Set((db.prepare('PRAGMA table_info("threads")').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.has("id") || !columns.has("cwd")) return;
  for (const row of db.prepare(`SELECT id, cwd FROM "threads" WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; cwd: unknown }>) {
    if (typeof row.cwd !== "string" || !folders.some((folder) => sameFolder(folder, row.cwd as string))) throw new StaleError(`${nodePath.basename(name)} holds a thread that is no longer this conversation's`);
  }
}

/** The check on its own, before any other step of the home: the transaction is only opened to see the rows as one moment, then ended. */
function ownerCheckOn(db: DatabaseSync, step: Extract<Step, { k: "ownerCheck" }>): void {
  db.exec("BEGIN IMMEDIATE");
  try { ownersOn(db, step.ids, step.folders, step.db); } finally { try { db.exec("ROLLBACK"); } catch { /* nothing open */ } }
}

/** A reader the engine holds open can keep a TRUNCATE from finishing. The deleted text then still sits in the -wal, so this is
 * NOT done: it throws, the step fails, and the plan keeps it for a retry. */
function checkpointOn(db: DatabaseSync, what: string): void {
  if (!checkpointTruncate(db, "deletion")) throw new Error(`the log of ${what} could not be checkpointed yet`);
}
function ftsOptimizeOn(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("INSERT INTO session_docs_fts(session_docs_fts) VALUES('optimize')");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
/** Fuigo rewrites a session's row as the conversation grows, without secure_delete, so earlier copies of its text sit in free
 * pages that no delete of ours can reach (0.1.60 low). VACUUM rebuilds the file without them. It runs whenever there are free
 * pages, not only when this run deleted rows. A VACUUM or checkpoint that fails leaves earlier copies in the file: it throws. */
function vacuumIfFreeOn(db: DatabaseSync, what: string): void {
  if (Number((db.prepare("PRAGMA freelist_count").get() as { freelist_count?: number } | undefined)?.freelist_count ?? 0) > 0) {
    db.exec("VACUUM");
    checkpointOn(db, what);
  }
}

// ── running a plan ──────────────────────────────────────────────────────

export interface ExecResult {
  removed: string[];
  failed: string[];
  /** keys (`engine\0home`) of the homes with a step that did not finish */
  failedHomes: string[];
  /** keys of the homes with a step whose planned inputs no longer matched: nothing of that step was changed, and the rest of
   * the home was left alone; the home is planned again */
  staleHomes: string[];
  /** why each failed path failed, short */
  reasons: Record<string, string>;
  /** the first reason a step of each home failed */
  homeReasons: Record<string, string>;
  /** the desktop application that is open (Claude, Cursor) when that is why a home is pending, by home key */
  homeApps: Record<string, string>;
  /** databases whose checkpoint is verified, by home key (the only thing an execute run settles) */
  factsDelta: Record<string, { clear: Record<string, string[]> }>;
  /** private folders of Murage's that could not be given back or removed */
  leftovers: string[];
}
export interface ExecHooks {
  /** Test only: called before each step runs; a throw ends the run as a crash would. */
  beforeStep?: (key: string, index: number, step: Step) => void;
  /** Test only: called after the gate said "closed" for a step and before the step's first destructive call: where an engine that
   * starts right after the check is launched. */
  afterGate?: (key: string, index: number, step: Step) => void;
}

function runStep(step: Step, out: { removed: string[] }, clear: (name: string, value: string) => void): void {
  const fs = realEngineFs();
  switch (step.k) {
    case "remove": {
      // a plan file whose slug a transcript that stays now names (one that appeared or was resumed since the plan) is kept
      if (step.slugRefs && slugsReferenced(fs, step.slugRefs.projects, step.slugRefs.slugs).size) return;
      if (step.expect) { removeListed(step, out); return; }
      // A session file removed on its own is removed only while it names, read in full while held, what the plan saw.
      removeGuarded(step.root, step.target, step.fp, out, step.owner);
      return;
    }
    case "rewrite": {
      if (!fs.lstat(step.path)) return; // gone: nothing to rewrite
      const rows = blankRows(step);
      if (rows) out.removed.push(step.path);
      return;
    }
    case "rmdirIfEmpty": removeEmptyDir(step.root, step.target, out); return;
    case "sqlDelete": {
      withDatabase(step.db, step.pragmas, (db) => { sqlDeleteOn(db, step); });
      return;
    }
    case "ownerCheck": withDatabase(step.db, step.pragmas, (db) => { ownerCheckOn(db, step); }); return;
    case "ftsOptimize": withDatabase(step.db, PRAGMAS, ftsOptimizeOn); return;
    case "checkpoint": {
      withDatabase(step.db, PRAGMAS, (db) => checkpointOn(db, step.db));
      clear("dirtyDbs", step.db);
      out.removed.push(step.db);
      return;
    }
    case "vacuumIfFree": withDatabase(step.db, PRAGMAS, (db) => vacuumIfFreeOn(db, step.db)); return;
    case "removeUnlessReferenced": removeUnlessReferenced(step, out); return;
    case "unlinkIfLinkTo": {
      const stat = fs.lstat(step.path);
      if (stat?.isSymbolicLink() && step.suffixes.some((suffix) => fs.readlink(step.path).endsWith(suffix))) { needHelper(); gUnlink(treeGuard({ files: [], links: [step.path] }), step.path); }
      return;
    }
  }
}

/** The SQLite files of a plan (Hermes and OpenCode are checked for a writer by taking their write lock). */
const dbsOf = (plan: HomePlanData): string[] => [...new Set(plan.steps.flatMap((step) => (step.k === "sqlDelete" || step.k === "checkpoint" ? [step.db] : [])))];

/** The reason a home carries when the gate says an engine is not closed: open, or could not be told. */
const gateReason = (verdict: EngineVerdict): string => (verdict.state === "unknown" ? OPEN_REASON.unchecked : OPEN_REASON.open);

/** Runs the steps of each home's plan that are not done, in plan order. `onStep` hears each finished step.
 * The gate (engine-closed.ts) is asked once before the first step, immediately before EVERY step, and once after the last. If it says
 * open or cannot be told at any of those, nothing further is touched and the home stays pending ("engine-open" or
 * "engine-unchecked"). The gate decides whether Murage tries now; what keeps an engine that starts a moment later safe is the hold on
 * each file (see the header). A step that waits for another (`needs`) is skipped unless that one FINISHED in this run. A failed step
 * fails its group (later steps on the same database or file wait) and leaves the home unfinished; the other steps still run. A stale
 * step stops its home: nothing more of it runs until it is planned again. */
export function executeEnginePlans(plans: Record<string, HomePlanData>, onStep?: (key: string, index: number) => void, hooks: ExecHooks = {}, mode: { openHome?: boolean } = {}): ExecResult {
  const result: ExecResult = { removed: [], failed: [], failedHomes: [], staleHomes: [], reasons: {}, homeReasons: {}, homeApps: {}, factsDelta: {}, leftovers: [] };
  for (const [key, plan] of Object.entries(plans)) {
    const delta = (result.factsDelta[key] ??= { clear: {} });
    const clear = (name: string, value: string) => { (delta.clear[name] ??= []).push(value); };
    if (plan.steps.every((step) => step.done && step.k !== "ownerCheck")) continue;
    const window: Window = { engine: plan.engine, home: plan.home, dbs: dbsOf(plan), identities: [...(plan.identities ?? [])], ...(mode.openHome ? { open: true } : {}) };
    // an open-home pass runs nothing but its own removal steps, with no proof to wait for (checked here as well as where it is planned)
    if (mode.openHome && plan.steps.some((step) => !OPEN_PASS_STEPS.has(step.k) || step.needs?.length)) { result.failedHomes.push(key); result.homeReasons[key] ??= "other"; continue; }
    const verdict = (): EngineVerdict => openPassGate(window, engineState(window.engine, window.home, { dbs: window.dbs, identities: window.identities }));
    const failHome = (): void => { if (!result.failedHomes.includes(key)) result.failedHomes.push(key); };
    const pendingHome = (path: string, reason: string, app?: string): void => {
      failHome();
      if (!result.failed.includes(path)) result.failed.push(path);
      result.reasons[path] = reason;
      result.homeReasons[key] ??= reason;
      if (app) result.homeApps[key] ??= app;
    };
    // T0: nothing is touched unless the engine is closed.
    const first = verdict();
    if (first.state !== "closed") { pendingHome(plan.home, gateReason(first), first.app); continue; }
    currentWindow = window;
    let engineOpened: EngineVerdict | null = null;
    const brokenGroups = new Set<string>();
    const finished = new Set<string>();
    let stale = false;
    try {
      plan.steps.forEach((step, index) => {
        if ((step.done && step.k !== "ownerCheck") || stale || engineOpened) return;
        if (step.group && brokenGroups.has(step.group)) { failHome(); return; }
        // a step whose proof did not finish in THIS run does not run, whatever the proof threw
        if (step.needs?.some((id) => !finished.has(id))) { failHome(); result.homeReasons[key] ??= "other"; return; }
        // the gate, immediately before this step's first destructive call
        const gate = verdict();
        if (gate.state !== "closed") { engineOpened = gate; return; }
        hooks.afterGate?.(key, index, step);
        hooks.beforeStep?.(key, index, step);
        stepRecords.clear();
        const overwritesBefore = overwrites;
        let ok = false;
        try {
          runStep(step, result, clear);
          ok = true;
        } catch (error) {
          // a step that stopped before its first overwrite (its hold was refused, or a row changed since the plan) wrote nothing: its own
          // journals describe a change that never began, and go, so recovery never makes a write the step itself refused
          if (overwrites === overwritesBefore) for (const own of [...stepRecords]) { try { dropRedo(own); stepRecords.delete(own); } catch { /* recovery finishes it */ } }
          if (error instanceof StaleError) {
            stale = true;
            if (!result.staleHomes.includes(key)) result.staleHomes.push(key);
            result.homeReasons[key] ??= "changed";
            return;
          }
          const path = stepPath(step);
          if (!result.failed.includes(path)) result.failed.push(path);
          result.reasons[path] = error instanceof EngineOpenError ? OPEN_REASON[error.kind] : ((error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error))).slice(0, 160);
          result.homeReasons[key] ??= result.reasons[path];
          if (step.group) brokenGroups.add(step.group);
          failHome();
        }
        if (ok) {
          if (step.id) finished.add(step.id);
          if (step.k !== "ownerCheck") onStep?.(key, index);
        }
      });
      // T1: an engine that opened while the steps ran leaves the home pending; the next attempt verifies it.
      const last: EngineVerdict = engineOpened ?? verdict();
      if (last.state !== "closed") pendingHome(plan.home, gateReason(last), last.app);
    } finally {
      currentWindow = null;
    }
  }
  result.leftovers = strays.splice(0);
  return result;
}
