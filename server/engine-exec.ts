// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The executor of engine-history deletion: the confined removal primitives, the JSONL rewrites, the SQLite steps, and the loop
// that runs a saved plan. It knows nothing about any engine. It runs only the steps a plan lists, in plan order, each one
// idempotent (a removal of what is already gone is done; a DELETE that matches nothing is done), and it reports each finished
// step so a crash resumes at the first step not done.
//
// NO ENGINE FILE IS CHANGED UNLESS MURAGE IS SURE IT HOLDS EXCLUSION. Node cannot lock a file, see who has it open, or open it with
// sharing off, so checking a file and then writing it leaves a gap in which an engine can write the same bytes. Every change here is
// therefore made while the engine cannot write, and the exclusion is held from the first comparison to the last verification. Whenever
// Murage is not certain it holds exclusion and has complete, current evidence (a holder it could not rule out, a scan that could
// not be completed, a name that is taken, an earlier copy still aside, a file system that cannot move a file without risking
// another), it changes NOTHING further: the files stay exactly as they are and the home stays pending. It never repairs, merges, or
// swaps in a weaker destructive operation (no append-merge, no replacing rename, no recursive removal).
//   lock       the engine's own whole-file lock (Fuigo/Grok's unified.jsonl, Codex's history.jsonl): Murage takes the same lock, then
//              compares, overwrites, syncs and verifies the rows it planned, and lets go. Nothing else is written.
//   dirlock    Claude Code's history.jsonl: the engine's own DIRECTORY lock, `history.jsonl.lock` (made, kept fresh, removed; a fresh
//              one that is not ours leaves the home pending and is never removed; one untouched for 10 s is abandoned by the engine's
//              own rule). The file stays where it is.
//   exclusive  a file whose writer has no lock to respect (Kimi's and Codex's session_index.jsonl): it is
//              renamed aside (a rename that cannot replace) so no one can open it by name, the processes that already hold it open
//              are looked for (any holder puts it back untouched), and only then is it compared, overwritten, synced, verified and
//              linked back, again only if its name is still free. Windows has the addon open it with sharing off instead and hold
//              that handle throughout.
//   remove     a file or folder an engine owns whole (a transcript, a session folder): renamed aside, checked for holders of its
//              files AND its folders (open, or as a working directory; Windows: files opened with sharing off by the addon), read in
//              full against the fingerprint the plan saved, and only then deleted file by file; the folders that held them go only
//              when empty. A different read or a holder puts it back and the home is planned again. An aside left by a crash is a
//              file of its own and is judged on its own content.
// With no helper to do this (engine-exclusion.ts) nothing is changed at all (HelperError); a holder or a lock someone else keeps
// leaves the home pending (EngineOpenError). Only the rows a plan lists are written, and only the bytes of their content.
// SQLite stores keep SQLite's own protocol (BEGIN IMMEDIATE, a busy timeout, a checkpoint that must finish).
//
// THE EXECUTOR NEVER DISCOVERS. A step carries what it was planned from (the names in a folder, the rows of a file and their
// hashes, the ids of a closure, the paste hashes a dropped row may name). When the world no longer matches, the step throws
// StaleError: nothing was changed, the home's other steps are skipped, and the driver plans the home again and saves that plan
// before the next execute. Every read goes through the strict reader (engine-fs.ts) and every change through its mutOps and
// exclOps layers; this file imports neither node:fs nor node:sqlite (engine-plan-structure.test.ts keeps that true).
import nodePath from "node:path";
import type { Stats } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { exclOps, fsOps, mutOps, realEngineFs } from "./engine-fs.ts";
import { ASIDE_SUFFIX, associationsOf, clearEdits, EngineOpenError, HelperError, isCleared, isStrictlyInside, JSONL_FORMAT, pathApiFor, sha16, StaleError, stepPath, type FileRef, type HeldFile, type HomePlanData, type JsonlFormat, type Step } from "./engine-plan-core.ts";
import { checkpointTruncate } from "./sqlite-checkpoint.ts";

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

/** Nobody else can open or write what is held, and nobody can reach it by a folder they kept: on macOS and Linux it was renamed
 * aside before, so no one can find it by name, and no process holds any of its files OR FOLDERS open or stands in one (else
 * EngineOpenError; a scan that could not be completed counts as held); on Windows each file is opened by the addon with sharing off
 * and stays open until `release`. `forDelete` asks for the right to delete the files. */
interface Hold {
  /** the file to read a held file through (Windows); undefined where the name is enough */
  fileOf(path: string): FileRef | undefined;
  /** the file goes when the hold is released (Windows; elsewhere the caller unlinks). False: it could not be marked. */
  markDelete(path: string): boolean;
  release(): void;
}
function holdTree(tree: Pick<Tree, "files" | "dirs">, forDelete: boolean): Hold {
  needHelper();
  if (exclOps.mode === "posix") {
    const ids: Array<{ dev: bigint; ino: bigint }> = [];
    for (const path of [...tree.files, ...tree.dirs]) {
      try { ids.push(mutOps.idOf(path)); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
    }
    if (exclOps.openers(ids).some(Boolean)) throw new EngineOpenError("another process has it open");
    return { fileOf: () => undefined, markDelete: () => true, release: () => {} };
  }
  const held = new Map<string, HeldFile>();
  const releaseAll = () => { for (const file of held.values()) { try { mutOps.close(file); } catch { /* already closed */ } } held.clear(); };
  try {
    for (const path of tree.files) {
      const file = exclOps.openFile(path, forDelete ? "delete" : "exclusive");
      if (!file) throw new EngineOpenError("another process has it open");
      held.set(path, file);
    }
  } catch (error) { releaseAll(); throw error; }
  return { fileOf: (path) => held.get(path), markDelete: (path) => held.get(path)?.markDelete() ?? false, release: releaseAll };
}

/** Moves `from` to `to` in one atomic step that cannot replace anything. "gone": `from` was not there. A taken name, a file system
 * that cannot do this, or (Windows) a file in use leaves everything as it was and the home pending. */
function moveAside(from: string, to: string): "moved" | "gone" {
  needHelper();
  let outcome: "ok" | "exists" | "unsupported";
  try { outcome = exclOps.renameNoReplace(from, to); } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return "gone";
    if (exclOps.mode === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES")) throw new EngineOpenError("it is in use");
    throw error;
  }
  if (outcome === "exists") throw new EngineOpenError("an earlier copy is still aside");
  if (outcome === "unsupported") throw new EngineOpenError("this file system cannot move a file aside without risking another file");
  return "moved";
}

/** The file or folder at `away` takes the name `original`, if it is free: a file by link (never replaces), then, when the file
 * system has no links, by the atomic no-replace rename. Throws EEXIST when the name is taken (both stay, nothing is merged). When
 * neither is possible the file stays aside and the home is pending (EngineOpenError). */
function giveName(away: string, original: string, folder: boolean): void {
  if (!folder) {
    let linked = false;
    try { mutOps.link(away, original); linked = true; } catch (error) {
      const code = codeOf(error);
      if (code === "EEXIST") throw error;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EMLINK" && code !== "ENOSYS" && code !== "EXDEV") throw error;
    }
    if (linked) { mutOps.unlink(away); return; }
  }
  const outcome = exclOps.renameNoReplace(away, original);
  if (outcome === "exists") throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
  if (outcome === "unsupported") throw new EngineOpenError("this file system cannot give the file its name back without risking another file; it stays aside");
}

/** Puts a file or folder back under its name after it was moved aside and left alone. Never replaces and never merges: if the
 * name was taken meanwhile, or nothing can do it safely, both stay as they are and the home is pending. */
function putBack(asidePath: string, original: string, folder: boolean): void {
  try { giveName(asidePath, original, folder); } catch { /* both stay; the aside is judged again */ }
}

const sameFileAt = (a: string, b: string): boolean => {
  try {
    const x = mutOps.idOf(a), y = mutOps.idOf(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch { return false; }
};

/** Deletes what a hold covered: its files and links one by one, then its folders, deepest first, each only if it is empty. A name
 * that appeared meanwhile keeps its folder (StaleError); nothing is ever removed recursively. */
function deleteTree(tree: Tree): void {
  for (const path of [...tree.files, ...tree.links]) {
    try { mutOps.unlink(path); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
  }
  for (const dir of [...tree.dirs].reverse()) {
    try { mutOps.rmdir(dir); } catch (error) {
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
function removeGuarded(root: string, target: string, fp: string | undefined, out: { removed: string[] }): void {
  const found = confine(root, target);
  if (found === "refused") throw new Error(`refused (outside its root or through a link) ${target}`);
  if (found === "absent") return;
  const full = found.full;
  const stat = lstatOrNull(full);
  if (!stat) return;
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) {
    // a link is only a name
    needHelper();
    try { mutOps.unlink(full); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
    if (lstatOrNull(full)) throw new Error(`could not remove ${full}`);
    out.removed.push(full);
    return;
  }
  if (isAside(full)) { settleAside(full, baseOf(full), fp, out, false); return; }
  // The original goes aside under its aside name. An aside already there is another file with its own step: it is never
  // replaced, and until it is settled this one waits.
  const away = aside(full);
  if (lstatOrNull(away)) throw new EngineOpenError("an earlier copy is still aside");
  if (moveAside(full, away) === "gone") return;
  settleAside(away, full, fp, out, true);
}

/** `created`: this step just moved the original aside, so a refusal puts it back. A leftover aside stays where it is. */
function settleAside(away: string, original: string, fp: string | undefined, out: { removed: string[] }, created: boolean): void {
  const stat = lstatOrNull(away);
  if (!stat) return;
  const folder = stat.isDirectory();
  const reader = realEngineFs();
  const tree: Tree = folder ? treeOf(away) : { files: [away], links: [], dirs: [] };
  const backIfCreated = () => { if (created) putBack(away, original, folder); };
  let hold: Hold;
  try { hold = holdTree(tree, true); } catch (error) { backIfCreated(); throw error; }
  let same = true;
  try {
    // Read in full while held: the file cannot change between this read and the removal.
    same = fp === undefined || folder || associationsOf(reader, away, [], hold.fileOf(away)).fp === fp;
    if (same) for (const file of tree.files) if (!hold.markDelete(file)) throw new EngineOpenError("it could not be marked for removal");
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
  try { deleteTree(tree); } catch (error) {
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
  try { mutOps.rmdir(found.full); out.removed.push(found.full); } catch (error) {
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
      const hold = holdTree({ files: trees.flatMap((item) => item.tree.files), dirs: [dir, ...trees.flatMap((item) => item.tree.dirs)] }, true);
      try {
        for (const { name, tree } of trees) {
          const path = api.join(dir, name);
          const want = voucher(name, leftover);
          // a session file the plan did not fingerprint is not one it can vouch for
          if (step.assoc && TRANSCRIPT.test(name) && want === undefined) { stays.push(name); continue; }
          if (want !== undefined && associationsOf(reader, path, [], hold.fileOf(path)).fp !== want) { stays.push(name); continue; }
          for (const file of tree.files) if (!hold.markDelete(file)) throw new EngineOpenError("it could not be marked for removal");
          approved.push({ name, tree });
        }
      } finally { hold.release(); }
    }
    for (const { name, tree } of approved) {
      deleteTree(tree);
      out.removed.push(api.join(dir, name));
    }
    if (stays.length) return stays;
    try { mutOps.rmdir(dir); out.removed.push(dir); } catch (error) {
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
  const settleOrGiveBack = (dir: string, leftover: boolean): string[] => {
    try { return settle(dir, leftover); } catch (error) { if (error instanceof EngineOpenError || error instanceof StaleError) giveBack(); throw error; }
  };
  if (lstatOrNull(away)) {
    const stays = settleOrGiveBack(away, true);
    if (stays.length) stale(away, stays);
  }
  const stat = lstatOrNull(step.target);
  if (!stat) return;
  // Only a real folder is moved; a link or a file is removed as it stands.
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    removeGuarded(step.root, step.target, undefined, out);
    return;
  }
  if (moveAside(step.target, away) === "gone") return;
  const stays = settleOrGiveBack(away, false);
  if (stays.length) {
    // Put the folder back if its place is still free: what stayed is not ours, and its engine keeps finding it there.
    giveBack();
    stale(away, stays);
  }
}

// ── a paste is removed only while the history that could name it is held ──────────────────────────────────────────────────

/** Does the held file hold `needle` anywhere? Read in full, 1 MiB at a time, with the end of each read carried into the next. */
function fileMentions(file: FileRef, needle: string): boolean {
  const want = Buffer.from(needle);
  if (!want.length) return false;
  let position = 0, tail: Buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = mutOps.pread(file, 1024 * 1024, position);
    if (!chunk.length) return false;
    position += chunk.length;
    const joined = Buffer.concat([tail, chunk]);
    if (joined.includes(want)) return true;
    tail = joined.subarray(Math.max(0, joined.length - (want.length - 1)));
  }
}

/** Claude Code locks its history with a DIRECTORY lock, `<file>.lock` (real-engine qualification of 2.1.296): it makes the folder,
 * treats one not touched for 10 s as abandoned, retries for about 9 s and then keeps its row in memory. Murage takes the same lock the
 * same way: it makes the folder, keeps it fresh (touches it) while it works, and removes it when it is done. A folder that is there
 * and fresh is the engine's: nothing is changed and the home is pending. A fresh folder is never removed; one nobody touched for 10 s
 * is abandoned by the engine's own rule and is replaced. The hold is kept short (a compare, a write and a sync). */
const LOCK_STALE_MS = 10_000;
function withDirLock(file: string, work: (refresh: () => void) => void): void {
  needHelper();
  const lock = `${file}.lock`;
  const refresh = () => { try { mutOps.touch(lock); } catch { /* the lock is checked again when it is let go */ } };
  const take = (): void => { mutOps.mkdir(lock); };
  try { take(); } catch (error) {
    if (codeOf(error) !== "EEXIST") throw error;
    const stat = lstatOrNull(lock);
    if (stat && Date.now() - stat.mtimeMs < LOCK_STALE_MS) throw new EngineOpenError("its engine holds the lock");
    if (stat) { try { mutOps.rmdir(lock); } catch (gone) { if (codeOf(gone) !== "ENOENT") throw new EngineOpenError("its engine holds the lock"); } }
    try { take(); } catch (again) { if (codeOf(again) === "EEXIST") throw new EngineOpenError("its engine holds the lock"); throw again; }
  }
  try {
    refresh();
    work(refresh);
    refresh();
  } finally {
    try { mutOps.rmdir(lock); } catch { /* already gone */ }
  }
}

/** Runs `work` with the history file held out of reach of its writer (Claude's directory lock, see withDirLock), so a reference
 * cannot appear between the check and the removal `work` does. `references(needle)` reads the held file. A lock the engine holds, or
 * an earlier copy of the history left aside, leaves everything as it is and the home pending. */
function withHistoryHeld(history: string, work: (references: (needle: string) => boolean) => void): void {
  needHelper();
  if (lstatOrNull(aside(history))) throw new EngineOpenError("its history is still aside");
  if (!lstatOrNull(history)) { work(() => false); return; }
  withDirLock(history, (refresh) => {
    const fd = mutOps.openRead(history);
    try { work((needle) => { refresh(); return fileMentions(fd, needle); }); } finally { mutOps.close(fd); }
  });
}

function removeUnlessReferenced(step: Extract<Step, { k: "removeUnlessReferenced" }>, out: { removed: string[] }): void {
  if (!lstatOrNull(step.target) && !lstatOrNull(aside(step.target))) return;
  withHistoryHeld(step.refFile, (references) => {
    // A pasted text stays while a line that remains in the history, or one that arrived, still uses it.
    if (references(step.needle)) return;
    removeGuarded(step.root, aside(step.target), undefined, out);
    removeGuarded(step.root, step.target, undefined, out);
  });
}

// ── JSONL rewrites ──────────────────────────────────────────────────────

/** With the file excluded (see the header): the planned rows compared by their hash, their content overwritten in place, synced,
 * and read back to prove every one is cleared. Nothing is written unless every row is as planned (or already cleared by an earlier
 * run of this step), so a change since the plan is a StaleError with the file untouched. */
function clearRowsOn(fd: FileRef, name: string, rows: readonly { off: number; len: number; sha: string }[], format: JsonlFormat): void {
  const writes: Array<{ at: number; bytes: Buffer }> = [];
  for (const row of rows) {
    const cur = mutOps.pread(fd, row.len, row.off);
    if (cur.length !== row.len) throw new StaleError(`${name} changed where a row was planned`);
    const edits = clearEdits(cur, format);
    if (!edits) throw new StaleError(`${name} holds a row that could not be read as one object`);
    if (sha16(cur) !== row.sha) {
      if (edits.length === 0) continue; // cleared by an earlier run of this step
      throw new StaleError(`${name} changed where a row was planned`);
    }
    for (const edit of edits) writes.push({ at: row.off + edit.at, bytes: edit.bytes });
  }
  if (!writes.length) return;
  for (const write of writes) mutOps.pwrite(fd, write.bytes, write.at);
  mutOps.fsync(fd);
  for (const row of rows) {
    if (!isCleared(mutOps.pread(fd, row.len, row.off), format)) throw new StaleError(`${name} did not take the change`);
  }
}

function sameFile(fd: number, path: string): boolean {
  try {
    const want = mutOps.idOf(path), have = mutOps.idOfFd(fd);
    return want.dev === have.dev && want.ino === have.ino;
  } catch { return false; }
}

/** The file stays where it is; the engine's own lock is taken on it and held while the rows are compared, written and synced. On
 * Windows the addon opens it shared (the engine keeps its own handles), takes the lock on that handle, and every read and write
 * runs in the addon on that handle. */
function clearUnderLock(step: Extract<Step, { k: "rewrite" }>, format: JsonlFormat): void {
  const name = nodePath.basename(step.path);
  if (exclOps.mode === "win32") {
    const held = exclOps.openFile(step.path, "shared");
    if (!held) throw new EngineOpenError("another process has it open");
    try {
      if (!held.lock()) throw new EngineOpenError("its engine holds the lock");
      if (step.fp.ino && mutOps.fstat(held).ino !== step.fp.ino) throw new StaleError(`${name} was replaced`);
      clearRowsOn(held, name, step.lines, format);
    } finally { mutOps.close(held); } // closing lets go of the lock
    return;
  }
  const fd = mutOps.openReadWrite(step.path);
  try {
    if (!exclOps.lock(fd)) throw new EngineOpenError("its engine holds the lock");
    if (!sameFile(fd, step.path) || (step.fp.ino && mutOps.fstat(fd).ino !== step.fp.ino)) throw new StaleError(`${name} was replaced`);
    clearRowsOn(fd, name, step.lines, format);
  } finally { mutOps.close(fd); } // closing lets go of the lock
}

/** Claude Code's history: the engine's directory lock (withDirLock) is held while the rows are compared, written, synced and verified.
 * The file stays where it is. */
function clearUnderDirLock(step: Extract<Step, { k: "rewrite" }>, format: JsonlFormat): void {
  const name = nodePath.basename(step.path);
  withDirLock(step.path, () => {
    const fd = mutOps.openReadWrite(step.path);
    try {
      if (!sameFile(fd, step.path) || (step.fp.ino && mutOps.fstat(fd).ino !== step.fp.ino)) throw new StaleError(`${name} was replaced`);
      clearRowsOn(fd, name, step.lines, format);
    } finally { mutOps.close(fd); }
  });
}

/** The file with no lock protocol: unreachable by name and unheld by any process (or, on Windows, opened with sharing off) while it
 * is cleared. It is never merged with another file and never put back over one: a name that is taken, an aside from an earlier run
 * that is not this same file, or any failure to hold it leaves every file as it is and the home pending. */
function clearExclusively(step: Extract<Step, { k: "rewrite" }>, format: JsonlFormat): void {
  const name = nodePath.basename(step.path);
  if (exclOps.mode === "win32") {
    const held = exclOps.openFile(step.path, "exclusive");
    if (!held) throw new EngineOpenError("another process has it open");
    try {
      if (step.fp.ino && mutOps.fstat(held).ino !== step.fp.ino) throw new StaleError(`${name} was replaced`);
      clearRowsOn(held, name, step.lines, format);
    } finally { mutOps.close(held); }
    return;
  }
  const original = step.restoreTo ?? step.path;
  const away = step.restoreTo ? step.path : aside(step.path);
  if (!step.restoreTo) {
    if (lstatOrNull(away)) {
      // two names for one file (an interrupted link back): the extra name goes. Two different files: both stay.
      if (!lstatOrNull(step.path) || !sameFileAt(away, step.path)) throw new EngineOpenError("an earlier copy of it is still aside");
      mutOps.unlink(away);
    }
    if (moveAside(step.path, away) === "gone") return;
  } else if (lstatOrNull(original)) {
    // The aside of an earlier run, and its name is in use. The same file: nothing but the extra name to drop (the step for the
    // name clears its rows). Another file: neither is touched.
    if (!sameFileAt(away, original)) throw new EngineOpenError("its name was taken while it was aside; both copies stay");
    mutOps.unlink(away);
    return;
  }
  let failure: unknown;
  let cleared = false;
  try {
    if (exclOps.openers([mutOps.idOf(away)]).some(Boolean)) throw new EngineOpenError("another process has it open");
    const fd = mutOps.openReadWrite(away);
    try {
      // An engine that does lock this file is respected too; one that does not never stops this.
      if (!exclOps.lock(fd)) throw new EngineOpenError("its engine holds the lock");
      if (mutOps.idOfFd(fd).ino !== mutOps.idOf(away).ino || (step.fp.ino && mutOps.fstat(fd).ino !== step.fp.ino)) throw new StaleError(`${name} was replaced`);
      clearRowsOn(fd, name, step.lines, format);
      cleared = true;
    } finally { mutOps.close(fd); }
  } catch (error) { failure = error; }
  // A file this step just moved aside goes back under its name whatever happened (that undoes its own move). An aside an earlier run
  // left goes back only after it was held and cleared: not holding it leaves it exactly where it is.
  if (!step.restoreTo || cleared) {
    try { giveName(away, original, false); } catch (error) {
      failure ??= codeOf(error) === "EEXIST" ? new EngineOpenError("its name was taken while it was aside; both copies stay") : error;
    }
  }
  if (failure) throw failure;
}

/** Clears the content of the planned rows. Returns how many rows were planned. A row that no longer matches (or a file that was
 * replaced) is stale; nothing is written in that case. */
function blankRows(step: Extract<Step, { k: "rewrite" }>): number {
  const reader = realEngineFs();
  const path = step.path;
  const stat = reader.lstat(path);
  if (!stat) return 0; // gone: nothing to rewrite
  if (!stat.isFile() || stat.isSymbolicLink()) throw new StaleError(`${nodePath.basename(path)} is no longer a plain file`);
  const format = JSONL_FORMAT[step.format];
  if (step.mode !== "blank" || !format || (step.how !== "lock" && step.how !== "exclusive" && step.how !== "dirlock")) throw new StaleError(`${nodePath.basename(path)} was planned in a form that is no longer used`);
  const rows = step.lines ?? [];
  if (!rows.length && !step.restoreTo) return 0;
  if (step.fp.ino && stat.ino !== step.fp.ino) throw new StaleError(`${nodePath.basename(path)} was replaced`);
  needHelper();
  if (step.how === "lock") clearUnderLock(step, format); else if (step.how === "dirlock") clearUnderDirLock(step, format); else clearExclusively(step, format);
  return rows.length;
}

/** Rows a predicate picks, found now, as the rows a clear would overwrite (the standalone form of what a planner records). */
function rowsOf(path: string, drop: (row: Record<string, unknown>) => boolean, needles: readonly string[], format: JsonlFormat): { rows: Array<{ off: number; len: number; sha: string }>; ino: number } | null {
  const reader = realEngineFs();
  const stat = reader.lstat(path);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  const rows: Array<{ off: number; len: number; sha: string }> = [];
  reader.eachRow(path, needles, (row, line, offset) => {
    if (row && drop(row) && !isCleared(line, format)) rows.push({ off: offset, len: line.length, sha: sha16(line) });
  });
  return { rows, ino: stat.ino };
}

/** Clear the rows a predicate picks in a shared JSONL log, keeping the file's inode and its length: Fuigo writers hold O_APPEND
 * handles on it and its own trim rewrites in place for that reason (fuigo-telemetry unified_log.rs `trim_file`). Done under the
 * log's own lock like every other change to it. */
export function scrubJsonlInPlace(path: string, drop: (row: Record<string, unknown>) => boolean, needles: readonly string[] = []): number {
  const found = rowsOf(path, drop, needles, JSONL_FORMAT["fuigo-unified"]!);
  if (!found || !found.rows.length) return 0;
  const step = { k: "rewrite", cls: "content", path, mode: "blank", pred: { any: [] }, needles: [...needles], format: "fuigo-unified", how: "lock", fp: { size: 0, mtimeMs: 0, ino: found.ino }, lines: found.rows } as Extract<Step, { k: "rewrite" }>;
  return blankRows(step);
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

/** Removes the rows of Fuigo's session search index (`<home>/sessions/session_search.sqlite`, fuigo-session-search fts.rs) that
 * belong to these sessions: by session id, and by the conversation's own folder in case a session directory was already gone.
 * The same steps a plan lists (delete, merge the index, checkpoint, vacuum), run in a row. Returns whether anything was
 * removed; throws when a step could not be verified. */
export function scrubFuigoSearchIndex(path: string, sessionIds: readonly string[], folders: readonly string[]): boolean {
  const ids = [...new Set(sessionIds)], cwds = [...new Set(folders)];
  if (!ids.length && !cwds.length) return false;
  const db = mutOps.openDbWrite(path, PRAGMAS) as unknown as DatabaseSync;
  try {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((row) => row.name));
    if (!tables.has("session_docs")) return false;
    const where = [ids.length ? `session_id IN (${ids.map(() => "?").join(",")})` : "", cwds.length ? `cwd IN (${cwds.map(() => "?").join(",")})` : ""].filter(Boolean).join(" OR ");
    const before = Number((db.prepare(`SELECT count(*) AS n FROM session_docs WHERE ${where}`).get(...ids, ...cwds) as { n?: number } | undefined)?.n ?? 0);
    sqlDeleteOn(db, { k: "sqlDelete", cls: "content", db: path, pragmas: PRAGMAS, stmts: [{ table: "session_docs", where, params: [...ids, ...cwds] }] });
    if (tables.has("session_docs_fts")) ftsOptimizeOn(db);
    checkpointOn(db, "the search index");
    vacuumIfFreeOn(db, "the search index");
    return before > 0;
  } finally {
    db.close();
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
  /** databases whose checkpoint is verified, by home key (the only thing an execute run settles) */
  factsDelta: Record<string, { clear: Record<string, string[]> }>;
}
export interface ExecHooks {
  /** Test only: called before each step runs; a throw ends the run as a crash would. */
  beforeStep?: (key: string, index: number, step: Step) => void;
}

function runStep(step: Step, out: { removed: string[] }, clear: (name: string, value: string) => void): void {
  const fs = realEngineFs();
  switch (step.k) {
    case "remove": {
      if (step.expect) { removeListed(step, out); return; }
      // A session file removed on its own is removed only while it names, read in full while held, what the plan saw.
      removeGuarded(step.root, step.target, step.fp, out);
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
      if (stat?.isSymbolicLink() && step.suffixes.some((suffix) => fs.readlink(step.path).endsWith(suffix))) { needHelper(); mutOps.unlink(step.path); }
      return;
    }
  }
}

/** Runs the steps of each home's plan that are not done, in plan order. `onStep` hears each finished step. A failed step fails
 * its group (later steps on the same database or file wait) and leaves the home unfinished; the other steps still run. A stale
 * step stops its home: nothing more of it runs until it is planned again. */
export function executeEnginePlans(plans: Record<string, HomePlanData>, onStep?: (key: string, index: number) => void, hooks: ExecHooks = {}): ExecResult {
  const result: ExecResult = { removed: [], failed: [], failedHomes: [], staleHomes: [], reasons: {}, homeReasons: {}, factsDelta: {} };
  for (const [key, plan] of Object.entries(plans)) {
    const delta = (result.factsDelta[key] ??= { clear: {} });
    const clear = (name: string, value: string) => { (delta.clear[name] ??= []).push(value); };
    const brokenGroups = new Set<string>();
    let stale = false;
    plan.steps.forEach((step, index) => {
      if (step.done || stale) return;
      if (step.group && brokenGroups.has(step.group)) {
        if (!result.failedHomes.includes(key)) result.failedHomes.push(key);
        return;
      }
      hooks.beforeStep?.(key, index, step);
      let finished = false;
      try {
        runStep(step, result, clear);
        finished = true;
      } catch (error) {
        if (error instanceof StaleError) {
          stale = true;
          if (!result.staleHomes.includes(key)) result.staleHomes.push(key);
          result.homeReasons[key] ??= "changed";
          return;
        }
        const path = stepPath(step);
        if (!result.failed.includes(path)) result.failed.push(path);
        result.reasons[path] = ((error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error))).slice(0, 160);
        result.homeReasons[key] ??= result.reasons[path];
        if (step.group) brokenGroups.add(step.group);
        if (!result.failedHomes.includes(key)) result.failedHomes.push(key);
      }
      if (finished) onStep?.(key, index);
    });
  }
  return result;
}
