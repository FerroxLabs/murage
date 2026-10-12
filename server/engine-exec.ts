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
//   REDO   an offsets-and-hashes journal (engine-redo.ts) written before the first overwrite of a step, so a crash never leaves a row
//          cut in the middle of a value: the next start finishes it (recoverAll) before anything is planned.
// The gate is asked immediately before every step (per commit), once before the first and once after the last. An engine that is open
// or cannot be told, a helper that is missing, a name that is taken, a file another program has, or a file system that cannot move a
// file without risking another, changes NOTHING further: the files stay exactly as they are and the home stays pending. Murage never
// merges blindly, or swaps in a weaker destructive operation (no append-merge but REJOIN, no replacing rename, no recursive removal).
//   lock       the engine's own whole-file lock (Fuigo/Grok's unified.jsonl, Codex's history.jsonl): Murage takes the same lock, then
//              compares, overwrites, syncs and verifies the rows it planned, and lets go. Nothing else is written.
//   dirlock    Claude Code's history.jsonl: the engine's own DIRECTORY lock, `history.jsonl.lock`. The public path is never removed:
//              an abandoned lock (10 s untouched, engine closed) is renamed to a private name of Murage's, checked to be the very
//              directory that was seen, and only then removed under that private name; Murage's own lock is released the same way.
//   inplace    Codex's session_index.jsonl: no lock and no aside. Codex appends to it (write and close) and replaces it by rename, so
//              the rows are compared again on the open file, overwritten in place, synced, and found again by NAME; a new file at
//              the name means Codex's rewrite won and the step is stale.
//   exclusive  a file whose writer has no lock to respect (Kimi's session_index.jsonl): renamed aside (a rename that cannot replace)
//              so no one can open it by name, and only then compared, overwritten, synced, verified and linked back, again only if
//              its name is still free. Windows has the addon open it with sharing off instead. When the engine made a new file at
//              the name meanwhile, both stay and the next attempt joins them (REJOIN).
//   remove     a file or folder an engine owns whole (a transcript, a session folder): renamed aside (Windows: files opened with
//              sharing off by the addon), read in full against the fingerprint the plan saved (a Codex rollout also against the
//              id, folder and type of its first line), and only then deleted file by file; the folders that held them go only
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
import { exclOps, fsOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { ASIDE_SUFFIX, associationsOf, clearEdits, EngineOpenError, HelperError, isCleared, isStrictlyInside, JSONL_FORMAT, OPEN_REASON, pathApiFor, rowSkeleton, sameFolder, skeletonOf, StaleError, stepPath, type FileRef, type HeldFile, type HomePlanData, type JsonlFormat, type RowEdit, type RowRef, type Step } from "./engine-plan-core.ts";
import { dropRedo, editsOf, listRedo, redoDirectory, rowsRecordsOf, writeJoin, writeRedo, type AnyRecord, type JoinRecord, type RedoRecord, type RedoRow } from "./engine-redo.ts";
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
/** An overwrite is made by single writes, and the guard is asked before EACH of them: a write the system cut short is finished only
 * after the guard has said again that the hold is still ours and young enough. */
const gPwrite = (guard: Guard, file: FileRef, bytes: Buffer, at: number): void => {
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

/** What is held while a tree is removed. On macOS and Linux the tree was renamed aside, so no one finds it by name; on Windows each
 * file is opened by the addon with sharing off and stays open until `release`. `forDelete` asks for the right to delete the files. */
interface Hold {
  /** the file to read a held file through (Windows); undefined where the name is enough */
  fileOf(path: string): FileRef | undefined;
  /** the file goes when the hold is released (Windows; elsewhere the caller unlinks). False: it could not be marked. */
  markDelete(path: string): boolean;
  release(): void;
}
function holdTree(tree: Pick<Tree, "files">, forDelete: boolean): Hold {
  needHelper();
  if (exclOps.mode === "posix") return { fileOf: () => undefined, markDelete: () => true, release: () => {} };
  const held = new Map<string, HeldFile>();
  const releaseAll = () => { for (const file of held.values()) { try { mutOps.close(file); } catch { /* already closed */ } } held.clear(); };
  try {
    for (const path of tree.files) {
      const file = exclOps.openFile(path, forDelete ? "delete" : "exclusive");
      if (!file) throw new EngineOpenError("held", "another process has it open");
      held.set(path, file);
    }
  } catch (error) { releaseAll(); throw error; }
  // the mark that deletes a file is set only while the handles are young: the same bound as every other hold
  const since = mutOps.now();
  const markDelete = (path: string): boolean => {
    if (mutOps.now() - since > HOLD_MAX_MS) throw new StaleError("the hold on the files ran out before they were marked");
    return held.get(path)?.markDelete() ?? false;
  };
  return { fileOf: (path) => held.get(path), markDelete, release: releaseAll };
}

/** The gate of the home being run, asked again inside a step. A process that holds a file Murage has just taken out of reach by name
 * (renamed aside) opened it before the rename and is running now: a closed answer after the rename means nobody can write to it. */
function gateNow(): EngineVerdict {
  if (!currentWindow) return { state: "unknown", via: "enumeration" };
  return engineState(currentWindow.engine, currentWindow.home, { dbs: currentWindow.dbs, identities: currentWindow.identities });
}
const notClosed = (verdict: EngineVerdict): EngineOpenError =>
  new EngineOpenError(verdict.state === "unknown" ? "unchecked" : "open", verdict.state === "unknown" ? "it could not be checked" : "its engine started");

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
  const folder = stat.isDirectory();
  const reader = realEngineFs();
  const tree: Tree = folder ? treeOf(away) : { files: [away], links: [], dirs: [] };
  const backIfCreated = () => { if (created) putBack(away, original, folder); };
  let hold: Hold;
  try { hold = holdTree(tree, true); } catch (error) { backIfCreated(); throw error; }
  // macOS, Linux: nobody finds the aside by name, so only a process that opened a file of it BEFORE it was moved can write to it, and that
  // process is running now. The engine must be closed now, after the move and before the read that decides: then what is read is final.
  if (exclOps.mode === "posix") {
    const gate = gateNow();
    if (gate.state !== "closed") { hold.release(); backIfCreated(); throw notClosed(gate); }
  }
  let same = true;
  try {
    // Read in full while held: the file cannot change between this read and the removal.
    same = fp === undefined || folder || associationsOf(reader, away, [], hold.fileOf(away)).fp === fp;
    // a Codex rollout: the id, folder and type of its first line, read again on the held file, must be what the plan saw
    if (same && owner !== undefined) same = !folder && reader.rolloutOwner(away, hold.fileOf(away)) === owner;
    if (same) for (const file of tree.files) if (!hold.markDelete(file)) throw new EngineOpenError("held", "it could not be marked for removal");
  } catch (error) {
    hold.release();
    backIfCreated();
    throw error;
  }
  hold.release();
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
      const trees = victims.map((name) => ({ name, tree: treeOf(api.join(dir, name)) }));
      const hold = holdTree({ files: trees.flatMap((item) => item.tree.files) }, true);
      try {
        // macOS, Linux: the folder is aside, so only a process that opened a file in it before the move can still write there (see
        // settleAside): the engine must be closed now, before the reads that decide
        if (exclOps.mode === "posix") { const gate = gateNow(); if (gate.state !== "closed") throw notClosed(gate); }
        for (const { name, tree } of trees) {
          const path = api.join(dir, name);
          const want = voucher(name, leftover);
          // a session file the plan did not fingerprint is not one it can vouch for
          if (step.assoc && TRANSCRIPT.test(name) && want === undefined) { stays.push(name); continue; }
          if (want !== undefined && associationsOf(reader, path, [], hold.fileOf(path)).fp !== want) { stays.push(name); continue; }
          for (const file of tree.files) if (!hold.markDelete(file)) throw new EngineOpenError("held", "it could not be marked for removal");
          approved.push({ name, tree });
        }
      } finally { hold.release(); }
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
interface Window { engine: string; home: string; dbs: string[]; identities: string[] }
let currentWindow: Window | null = null;
const stillClosed = (ownLock: boolean): boolean => !!currentWindow && engineState(currentWindow.engine, currentWindow.home, { dbs: currentWindow.dbs, identities: currentWindow.identities, ignoreHistoryLock: ownLock }).state === "closed";
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
      // Untouched for 10 s: abandoned by the engine's own rule, and replaced only while the engine is still closed.
      if (!stillClosed(false)) claimed();
      const priv = privateName(lock);
      let moved: "ok" | "exists" | "unsupported";
      try { moved = gMove(noGuard, lock, priv); } catch (gone) { if (codeOf(gone) === "ENOENT") continue; throw gone; }
      if (moved !== "ok") throw new EngineOpenError("held", "its lock cannot be moved aside");
      // What came off the public path must be the very folder that was seen, and still untouched.
      const got = lstatOrNull(priv);
      if (!got || got.dev !== seen.dev || got.ino !== seen.ino || Date.now() - got.mtimeMs < LOCK_STALE_MS) { giveLockBack(priv); claimed(); }
      gRmdir(noGuard, priv);
      try { take(); } catch (again) { if (codeOf(again) === "EEXIST") claimed(); throw again; }
      if (!stillClosed(true)) { release(); throw new EngineOpenError("open", "its engine started"); }
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
  try {
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
        gUnlink((path) => { identity(path); guard(path); }, away);
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
 *   exclusive  the engine's lock if it keeps one, on a file that was already set aside (Windows: a handle nobody can share)
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

/** With the file held (see withRowHold): the planned rows compared by their skeleton, a journal of this step's own written, then each
 * row read again just before its content is overwritten in place, synced, and read back to prove every one is cleared; the step's
 * journals are removed. Nothing is written unless every row is as planned (or already cleared by an earlier run of this step), so a
 * change since the plan is a StaleError with the file untouched. A journal of an EARLIER change to the same file (another deletion's
 * step that failed or was cut) is never replaced: the step is stale, and the next plan finishes that journal first (recoverAll).
 * `physical`: the file as it is named now (an aside's name while the file is aside). */
function commitRows(file: FileRef, step: RewriteStep, format: JsonlFormat, guard: Guard, physical: string): void {
  const name = nodePath.basename(step.path);
  const id = mutOps.idOfFd(file);
  const dev = String(id.dev), ino = String(id.ino);
  if (rowsRecordsOf(listRedo(), dev, ino).some((rec) => !stepRecords.has(rec.id))) throw new StaleError(`${name} has an earlier change to finish first`);
  const planned: Array<{ row: RowRef; edits: RowEdit[]; skel: string }> = [];
  for (const row of step.lines) {
    const cur = mutOps.pread(file, row.len, row.off);
    if (cur.length !== row.len) throw new StaleError(`${name} changed where a row was planned`);
    const edits = clearEdits(cur, format);
    if (!edits) throw new StaleError(`${name} holds a row that could not be read as one object`);
    if (rowSkeleton(cur, format) !== row.sha) throw new StaleError(`${name} changed where a row was planned`);
    if (edits.length) planned.push({ row, edits, skel: skeletonOf(cur, edits) }); // none: cleared by an earlier run of this step
  }
  const finish = (): void => { for (const own of [...stepRecords]) { dropRedo(own); stepRecords.delete(own); } };
  if (!planned.length) { finish(); return; }
  if (!redoDirectory()) throw new HelperError();
  const at = currentWindow;
  stepRecords.add(writeRedo({
    path: physical, dev, ino, engine: at?.engine ?? "", home: at?.home ?? "", how: step.how, format: step.format,
    rows: planned.map((item) => ({ off: item.row.off, len: item.row.len, skel: item.skel, edits: item.edits.map((edit) => ({ at: edit.at, len: edit.len, kind: edit.kind })) })),
  }));
  for (const item of planned) {
    // read again, just before the write: a row that is no longer what the plan saw is not written
    const cur = mutOps.pread(file, item.row.len, item.row.off);
    if (rowSkeleton(cur, format) !== item.row.sha) throw new StaleError(`${name} changed where a row was planned`);
    if (isCleared(cur, format)) continue;
    for (const edit of item.edits) gPwrite(guard, file, edit.bytes, item.row.off + edit.at);
  }
  mutOps.fsync(file);
  for (const row of step.lines) {
    if (!isCleared(mutOps.pread(file, row.len, row.off), format)) throw new StaleError(`${name} did not take the change`);
  }
  finish();
}

/** The file stays where it is; the engine's own lock is taken on it and held while the rows are compared, written and synced. */
function clearUnderLock(step: RewriteStep, format: JsonlFormat): void {
  withRowHold("lock", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, step.path));
}

/** Claude Code's history: the engine's directory lock (withDirLock) is held while the rows are compared, written, synced and verified.
 * The file stays where it is. */
function clearUnderDirLock(step: RewriteStep, format: JsonlFormat): void {
  withRowHold("dirlock", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, step.path));
}

/** Codex's session_index.jsonl: no lock and no aside. Codex appends to it (write and close, so a row appended meanwhile commutes with
 * an overwrite of an earlier one) and replaces it by rename (so a new file at the name means Codex's rewrite won). The rows are
 * compared again on the open file, overwritten, synced, and then found again BY NAME: the same file, every row cleared. */
function clearInPlace(step: RewriteStep, format: JsonlFormat): void {
  const name = nodePath.basename(step.path);
  withRowHold("inplace", step.path, step.fp.ino, (file, guard) => {
    commitRows(file, step, format, guard, step.path);
    const again = exclOps.mode === "win32" ? exclOps.openFile(step.path, "shared") : mutOps.openRead(step.path);
    if (again === null) throw new EngineOpenError("held", "another process has it open");
    try {
      const a = mutOps.idOfFd(again), b = mutOps.idOfFd(file);
      if (a.dev !== b.dev || a.ino !== b.ino) throw new StaleError(`${name} was replaced after it was cleared`);
      for (const row of step.lines) if (!isCleared(mutOps.pread(again, row.len, row.off), format)) throw new StaleError(`${name} did not keep the change`);
    } finally { mutOps.close(again); }
  });
}

/** The name an engine's second file waits under while it is joined to the first (REJOIN). */
const REJOINING_SUFFIX = ".murage-rejoining";
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

/** Writes the engine's newer file `second` (already under Murage's private name, so no one can open it by name any more) after the
 * rows of `away`, under the lock of both, and removes it only when no one can still be writing to it:
 *   - where its bytes go is journalled first (engine-redo.ts JoinRecord: the byte of `away` they start at, and whether a newline goes
 *     first), and they are written THERE, by position, never appended: a join cut half way and done again writes the same bytes at
 *     the same place, so a torn tail is completed, never followed by a second copy;
 *   - only a process that opened `second` before it was moved can still write to it, and such a process is running: after the copy
 *     is synced and read back, the engine must be closed and `second` no longer than what was copied; it grew meanwhile, the new
 *     bytes are copied too (a few rounds at most); the engine is open, both files stay and the home is pending. */
function joinInto(away: string, second: string): void {
  const name = nodePath.basename(baseOf(away));
  const fromId = mutOps.idOf(second);
  const fd = mutOps.openReadWrite(away);
  let record: JoinRecord | undefined;
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
      const fields = { into, from, base: size, lead, engine: at?.engine ?? "", home: at?.home ?? "" };
      record = { v: 2, kind: "join", id: writeJoin(fields), ...fields };
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
      const want = Buffer.concat([record.lead ? Buffer.from("\n") : Buffer.alloc(0), bytes]);
      const have = mutOps.fstat(fd).size;
      if (have < record.base || have > record.base + want.length) throw new StaleError(`${name} is not the size the join left it`);
      if (want.length) {
        const guard = holdGuard({ alive: () => true, same: () => sameFile(fd, away), since: mutOps.now(), what: name });
        gPwrite(guard, fd, want, record.base);
        mutOps.fsync(fd);
        if (!mutOps.pread(fd, want.length, record.base).equals(want)) throw new StaleError(`${name} did not take the joined rows`);
      }
      const gate = gateNow();
      if (gate.state !== "closed") throw notClosed(gate);
      const after = lstatOrNull(second);
      if (after && after.size === bytes.length) break;
      if (!after) throw new StaleError(`${name}'s new file went away while it was joined`);
      if (round >= 2) throw new EngineOpenError("aside", "the new file kept growing while it was joined");
    }
  } finally { mutOps.close(fd); }
  gUnlink(treeGuard({ files: [second], links: [] }), second);
  dropRedo(record.id);
}

/** Finishes a join a crash left half way (recoverAll): the older file is found by its identity under any of its names; the newer one
 * is still under the private name. Either one gone: nothing is left to join, and the journal goes. */
function finishJoin(rec: JoinRecord): void {
  const base = baseOf(rec.into.path);
  const into = [rec.into.path, base, aside(base)].find((path) => { const id = idOrNull(path); return !!id && String(id.dev) === rec.into.dev && String(id.ino) === rec.into.ino; });
  const id = idOrNull(rec.from.path);
  const fromThere = !!id && String(id.dev) === rec.from.dev && String(id.ino) === rec.from.ino;
  if (!into || !fromThere) {
    // the older file is gone: the newer one is the engine's only file, and goes back under its name if that is free
    if (!into && fromThere && rec.from.path.endsWith(REJOINING_SUFFIX)) putBack(rec.from.path, rec.from.path.slice(0, -REJOINING_SUFFIX.length), false);
    dropRedo(rec.id);
    return;
  }
  joinInto(into, rec.from.path);
}

/** The file with no lock protocol: unreachable by name and unheld by any process (or, on Windows, opened with sharing off) while it
 * is cleared. It is never merged blindly and never put back over another file: a name that is taken, or any failure to hold it,
 * leaves every file as it is and the home pending. An aside from an earlier run next to a NEW file the engine made is joined to it
 * first (REJOIN). */
function clearExclusively(step: RewriteStep, format: JsonlFormat): void {
  if (exclOps.mode === "win32") { withRowHold("exclusive", step.path, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, step.path)); return; }
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
    withRowHold("exclusive", away, step.fp.ino, (file, guard) => commitRows(file, step, format, guard, away));
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
  const base = baseOf(rec.path.endsWith(REJOINING_SUFFIX) ? rec.path.slice(0, -REJOINING_SUFFIX.length) : rec.path);
  const names = [...new Set([rec.path, base, aside(base)])];
  const same = names.find((path) => { const id = idOrNull(path); return !!id && String(id.dev) === rec.dev && String(id.ino) === rec.ino; });
  if (same) return same;
  return [base, aside(base)].find((path) => lstatOrNull(path) !== null) ?? null;
}

/** Finishes every journal a crash or a failed write left behind (see engine-redo.ts), before anything is planned: a row cut in the
 * middle of a value is not one JSON object, and no plan could read it. Each journal is finished under the gate and the hold of its
 * file's class; a join is finished the way joinInto does it. A journal whose engine is open, or cannot be told, or whose file is held
 * stays, and its home stays pending. `identities`: the configured programs of each engine home, by `engine\0home`. Never throws. */
export function recoverAll(identities: Readonly<Record<string, readonly string[]>> = {}): RecoveryResult {
  const result: RecoveryResult = { pending: [], repaired: 0 };
  let records: AnyRecord[];
  try { records = listRedo(); } catch (error) {
    const cause = (error as { cause?: unknown })?.cause ?? error;
    return { ...result, unreadable: ((cause as NodeJS.ErrnoException)?.code ?? (cause instanceof Error ? cause.message : String(cause))).slice(0, 160) };
  }
  for (const rec of records) {
    const key = `${rec.engine}\0${rec.home}`;
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
      withRowHold(how, path, undefined, (file, guard) => repairRows(file, path, rec, format, guard));
      dropRedo(rec.id);
      result.repaired++;
    } catch (error) {
      result.pending.push({ engine: rec.engine, home: rec.home, state: error instanceof EngineOpenError && error.kind === "unchecked" ? "unknown" : error instanceof EngineOpenError && error.kind === "open" ? "open" : "held" });
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
export function executeEnginePlans(plans: Record<string, HomePlanData>, onStep?: (key: string, index: number) => void, hooks: ExecHooks = {}): ExecResult {
  const result: ExecResult = { removed: [], failed: [], failedHomes: [], staleHomes: [], reasons: {}, homeReasons: {}, homeApps: {}, factsDelta: {}, leftovers: [] };
  for (const [key, plan] of Object.entries(plans)) {
    const delta = (result.factsDelta[key] ??= { clear: {} });
    const clear = (name: string, value: string) => { (delta.clear[name] ??= []).push(value); };
    if (plan.steps.every((step) => step.done && step.k !== "ownerCheck")) continue;
    const window: Window = { engine: plan.engine, home: plan.home, dbs: dbsOf(plan), identities: [...(plan.identities ?? [])] };
    const verdict = (): EngineVerdict => engineState(window.engine, window.home, { dbs: window.dbs, identities: window.identities });
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
        let ok = false;
        try {
          runStep(step, result, clear);
          ok = true;
        } catch (error) {
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
