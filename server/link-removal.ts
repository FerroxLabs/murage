// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// Removing a skill link must remove the link and nothing it points to.
//
// Murage links skills into the engines' discovery folders: directory
// symlinks on macOS and Linux, directory junctions on Windows. Under the
// app's own runtime on Windows (Electron 43.7.7, its Node 24.21.0) fs.rmSync
// does not treat a junction as a link. Probed on Windows 11 (W1, 2026-10-19):
//   rmSync(junction)                        throws ERR_FS_EISDIR (murage#16)
//   rmSync(junction, { recursive: true })   removes the junction AND every
//                                           file in the folder it points to
//   rmSync(folder holding a junction, { recursive: true })  the same
//   unlinkSync, rmdirSync, fs.rm, fs.promises.rm  remove the link only
// Plain Node 24 removes only the link in every case, which is why Windows CI
// stayed green (link-removal.electron.test.ts now runs under Electron).
//
// So: every link Murage removes goes through removeLink() (lstat, refuse a
// real file or folder, then unlink or rmdir: never rmSync, never recursive),
// and on Windows installNoFollowRmSync() makes every other fs.rmSync in the
// process remove links as links and do recursive removes itself, so the
// runtime's recursive remove never meets a junction.
//
// A recursive remove on Windows goes through the native addon's removeTree
// (native/engine-exclusion/exclusion.c): it opens each folder once, lists it
// and opens and deletes each entry through handles, never through a path, so a
// folder swapped for a junction while the remove runs cannot send it anywhere
// (a path walk can only check, then act on a path someone else may change in
// between). Only when the addon is missing does the path walk below run, and
// that is logged.
import fs, { chmodSync, lstatSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import type { PathLike, RmOptions } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExclusionAddon } from "./engine-exclusion.ts";

/** The file calls removeLink() makes; tests swap them to drive failures. */
export interface LinkFs {
  lstat(path: string): { isSymbolicLink(): boolean };
  unlink(path: string): void;
  rmdir(path: string): void;
  symlink(target: string, path: string, type: "junction" | "dir"): void;
}

export const nodeLinkFs: LinkFs = {
  lstat: path => lstatSync(path),
  unlink: path => unlinkSync(path),
  rmdir: path => rmdirSync(path),
  symlink: (target, path, type) => symlinkSync(target, path, type),
};

/** The path holds a real file or folder, not a link: it is never removed. */
export class NotALinkError extends Error {
  readonly code = "ENOTLINK";
  readonly path: string;
  constructor(path: string) {
    super(`Not a link, so it was left in place: ${path}`);
    this.name = "NotALinkError";
    this.path = path;
  }
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * Removes the symlink or junction at `path`, never what it points to.
 * Returns false when nothing is there. Throws NotALinkError for a real file
 * or folder, and the file system's own error when the link cannot go.
 *
 * On Windows unlink removes both a file symlink and a directory junction
 * (libuv opens the reparse point itself); rmdir is the fallback for a
 * directory link unlink refuses. Neither one follows the link.
 */
export function removeLink(path: string, io: LinkFs = nodeLinkFs, platform: NodeJS.Platform = process.platform): boolean {
  let stat: { isSymbolicLink(): boolean };
  try {
    stat = io.lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
  if (!stat.isSymbolicLink()) throw new NotALinkError(path);
  try {
    io.unlink(path);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return true;
    if (platform !== "win32") throw error;
  }
  // A directory link unlink refused: rmdir removes the junction entry only.
  // Checked again first, so a link swapped for a real folder in between is
  // refused rather than removed.
  if (!io.lstat(path).isSymbolicLink()) throw new NotALinkError(path);
  io.rmdir(path);
  return true;
}

/**
 * Points the directory link at `link` to `target`: removes the old link
 * (never what it points to) and makes a junction on Windows, a directory
 * symlink elsewhere. One retry covers a transient lock (an indexer or
 * scanner holding the junction for a moment); the second failure throws.
 * A real file or folder at `link` is never replaced.
 */
export function relinkDirectory(link: string, target: string, io: LinkFs = nodeLinkFs, platform: NodeJS.Platform = process.platform): void {
  for (let attempt = 1; ; attempt++) {
    try {
      removeLink(link, io, platform);
      io.symlink(target, link, platform === "win32" ? "junction" : "dir");
      return;
    } catch (error) {
      if (error instanceof NotALinkError || attempt >= 2) throw error;
    }
  }
}

/** removeLink with the same single retry as relinkDirectory. */
export function removeLinkWithRetry(path: string, io: LinkFs = nodeLinkFs, platform: NodeJS.Platform = process.platform): boolean {
  try {
    return removeLink(path, io, platform);
  } catch (error) {
    if (error instanceof NotALinkError) throw error;
    return removeLink(path, io, platform);
  }
}


/** What the walk reads of an entry: its kind, and its identity to notice a swap. */
export interface EntryStat { isSymbolicLink(): boolean; isDirectory(): boolean; dev?: number; ino?: number }

/** The file calls the no-follow rmSync makes; tests swap them. */
export interface TreeFs extends LinkFs {
  lstatEntry(path: string): EntryStat;
  readdir(path: string): string[];
  chmod(path: string, mode: number): void;
}
export const nodeTreeFs: TreeFs = {
  ...nodeLinkFs,
  lstatEntry: path => lstatSync(path),
  readdir: path => readdirSync(path),
  chmod: (path, mode) => chmodSync(path, mode),
};

/** A read-only entry refuses removal on Windows until its attribute is cleared, as rmSync's own walk does. */
function clearingReadOnly(path: string, mode: number, io: TreeFs, remove: () => void): void {
  try {
    remove();
  } catch (error) {
    if (codeOf(error) !== "EPERM" && codeOf(error) !== "EACCES") throw error;
    io.chmod(path, mode);
    remove();
  }
}

/**
 * Removes `path` and everything under it, deciding every entry by its own
 * lstat at the moment it is removed: a link or junction is removed as a link
 * (removeLink), a folder is emptied then removed, a file is unlinked. Nothing
 * is ever handed to the runtime's recursive remove, so a junction found, or
 * made, anywhere in the tree is never walked into. Any error stops the walk
 * and is thrown; ENOENT for an entry that went away meanwhile is not an error.
 */
export function removeTreeWithoutFollowing(path: string, io: TreeFs = nodeTreeFs): void {
  let stat: EntryStat;
  try {
    stat = io.lstatEntry(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    removeLink(path, io, "win32");
    return;
  }
  if (!stat.isDirectory()) {
    try { clearingReadOnly(path, 0o600, io, () => io.unlink(path)); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
    return;
  }
  const names = io.readdir(path);
  // The names must have come from this same real folder: a folder swapped
  // for a junction between the lstat and the listing would otherwise send
  // the walk into the junction's target. Each name is lstat'ed again below.
  const after = io.lstatEntry(path);
  if (after.isSymbolicLink() || !after.isDirectory() || after.ino !== stat.ino || after.dev !== stat.dev) {
    throw Object.assign(new Error(`The folder changed while it was being removed, so it was left in place: ${path}`), { code: "ECHANGED" });
  }
  for (const name of names) removeTreeWithoutFollowing(join(path, name), io);
  try { clearingReadOnly(path, 0o700, io, () => io.rmdir(path)); } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
}

/** fs accepts a string, a Buffer, or a file: URL. */
function namedPath(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof URL) return value.protocol === "file:" ? fileURLToPath(value) : null;
  return null;
}

type RmSync = (path: PathLike, options?: RmOptions) => void;

/** A remove of `path` and everything under it by handle (the addon's removeTree): true removed, false nothing there. */
export type HandleTreeRemove = (path: string) => boolean;

/** The addon's removeTree, or null when the addon is missing, will not load, or is a build without it. */
export function addonTreeRemove(): HandleTreeRemove | null {
  try {
    const addon = loadExclusionAddon();
    const removeTree = addon?.removeTree;
    return typeof removeTree === "function" ? (path) => removeTree.call(addon, path) : null;
  } catch {
    return null;
  }
}

let pathWalkLogged = false;
let pathWalkNotice: (line: string) => void = (line) => console.warn(line);
/** Where the one path-walk line goes (the server log by default). The recovery CLI sets its own: its stderr carries only its JSON error line. */
export function setPathWalkNotice(sink: (line: string) => void): void { pathWalkNotice = sink; }
function logPathWalk(): void {
  if (pathWalkLogged) return;
  pathWalkLogged = true;
  pathWalkNotice("link removal: the native addon's removeTree is not available here, so recursive removes use the path walk; a folder swapped for a junction while one runs is refused, not prevented");
}
/** A path segment ending in a dot or a space, which Windows drops when it opens the path. */
const REWRITTEN_ON_WINDOWS = /[. ](?:[\\/]|$)/;
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Wraps rmSync so it never follows a link. Every recursive remove is done by
 * `handles()` (the addon's removeTree, by handle) or, only where that is
 * missing, by removeTreeWithoutFollowing (logged once), with rmSync's own
 * force, maxRetries and retryDelay. Without `recursive`, a link is removed as a link and anything
 * else (a file, a folder, a missing path) goes to the runtime's rmSync,
 * which does not walk, so its errors stay its own.
 */
export function noFollowRmSync(original: RmSync, io: TreeFs = nodeTreeFs, handles: () => HandleTreeRemove | null = () => null): RmSync {
  return function rmSyncWithoutFollowingLinks(this: unknown, path: PathLike, options?: RmOptions): void {
    const named = namedPath(path);
    // the runtime rejects the argument; a NUL would end the path early in any native call, so it never gets past here
    if (named === null || named.includes("\0")) return original.call(this, path, options);
    if (options?.recursive) {
      // Never handed to the runtime: its recursive remove follows junctions.
      // Windows drops a trailing dot or space from a path segment, so `DATA_DIR + "."` opens DATA_DIR while every check
      // (the data-dir guard's realpath fails on it, then it compares the string as written) sees another name: refused here.
      const full = resolve(named);
      if (REWRITTEN_ON_WINDOWS.test(full.replace(/^\\\\[?.]\\/, ""))) {
        throw Object.assign(new Error(`EINVAL: Windows would read this path as a different one, rm '${named}'`), { code: "EINVAL", syscall: "rm", path: named });
      }
      const retries = Math.max(0, options.maxRetries ?? 0), delay = Math.max(0, options.retryDelay ?? 100);
      const byHandle = handles();
      if (byHandle) {
        for (let attempt = 0; ; attempt++) {
          try {
            // the resolved form is the one the data-dir guard compared; removeTree also refuses any path Windows would rewrite
            if (byHandle(full) || options.force) return;
            throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${named}'`), { code: "ENOENT", syscall: "rm", path: named });
          } catch (error) {
            if (attempt >= retries || !RETRYABLE.has(codeOf(error) ?? "")) throw error;
            pause(delay * (attempt + 1));
          }
        }
      }
      logPathWalk();
      try {
        io.lstatEntry(full);
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error;
        if (options.force) return;
        throw Object.assign(new Error(`ENOENT: no such file or directory, rm '${named}'`), { code: "ENOENT", syscall: "rm", path: named });
      }
      for (let attempt = 0; ; attempt++) {
        try {
          removeTreeWithoutFollowing(full, io);
          return;
        } catch (error) {
          if (attempt >= retries || !RETRYABLE.has(codeOf(error) ?? "")) throw error;
          pause(delay * (attempt + 1));
        }
      }
    }
    let top: EntryStat | undefined;
    try { top = io.lstatEntry(named); } catch { /* missing or unreadable: the runtime's non-recursive rmSync reports it */ }
    if (top?.isSymbolicLink() && (removeLink(named, io, "win32") || options?.force)) return;
    // A file, or a folder without `recursive` (the runtime refuses it without walking).
    return original.call(this, path, options);
  };
}

let noFollowInstalled = false;

/**
 * Installs noFollowRmSync over fs.rmSync for the whole process on Windows,
 * where the runtime's rmSync follows junctions. Elsewhere rmSync already
 * removes a symlink without following it, and nothing is patched.
 * Install it before data-dir-guard.ts, so that guard still checks first.
 * Returns true when this call installed it.
 */
export function installNoFollowRmSync(platform: NodeJS.Platform = process.platform, handles: () => HandleTreeRemove | null = addonTreeRemove): boolean {
  if (noFollowInstalled || platform !== "win32") return false;
  const owner = fs as unknown as Record<string, unknown>;
  const wrapped = noFollowRmSync(fs.rmSync, nodeTreeFs, handles);
  const existing = Object.getOwnPropertyDescriptor(owner, "rmSync");
  if (existing?.writable) owner.rmSync = wrapped;
  else Object.defineProperty(owner, "rmSync", { value: wrapped, writable: true, configurable: true, enumerable: existing?.enumerable ?? true });
  if (owner.rmSync !== wrapped) throw new Error("link removal could not replace fs.rmSync");
  // Named imports (`import { rmSync } from "node:fs"`) see the new function.
  syncBuiltinESMExports();
  noFollowInstalled = true;
  return true;
}
