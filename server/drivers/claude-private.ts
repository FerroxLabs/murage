// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// WIN-NOBASH-DESIGN-r2 section 13 and section 14 (MurageMain, 2026-10-21): the files a Claude turn writes that carry the hand's
// values or its hashes, kept private on every platform.
// - The private root and each folder in it: macOS and Linux, a folder at 0700 owned by this user and not a link (lstat, and the
//   handle's identity checked after it is opened); Windows, the native helper's owner-only ACL (protected DACL: this user and
//   SYSTEM only), set and verified by handle with reparse points refused (electron/browser-extension-windows.mjs). Never a
//   PowerShell.
// - A file: a fresh temp created exclusively in that folder (O_CREAT|O_EXCL|O_NOFOLLOW, 0600, its identity checked after the
//   open; on Windows the helper's CREATE_NEW with the owner-only ACL), the complete content written, then renamed into place.
//   No prior bytes are ever read or copied.
// - The overlay (isolation settings with restated values): a flat file in one owner-only root in the data folder, created
//   exclusively under an unguessable name recorded in a manifest, held by each CLI process launched with it and removed (by
//   leaf name) when the last one exits, when the launch fails, or at exit; what a process that is gone left is swept at boot
//   from the manifest (sweepClaudePrivate, section 14.2 N2).
// Nothing here logs a path's content.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { createPrivateWindowsDirectory, writePrivateWindowsData } from "../../electron/browser-extension-windows.mjs";

export interface PrivateFs {
  platform: NodeJS.Platform;
  /** Windows: make (or verify) an owner-only folder; throws when it cannot be made private. */
  makeWindowsDir: (path: string) => void;
  /** Windows: write a whole owner-only file by temp + rename. */
  writeWindowsFile: (path: string, data: string) => void;
  uid: () => number | undefined;
}

const defaultFs = (): PrivateFs => ({
  platform: process.platform,
  makeWindowsDir: createPrivateWindowsDirectory,
  writeWindowsFile: writePrivateWindowsData,
  uid: () => process.getuid?.(),
});

/** Throws unless `path` is a folder this user owns that no one else can open, and not a link. */
function verifyPosixPrivateDir(path: string, uid: number | undefined): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("private folder refused: not a folder");
  if (uid !== undefined && st.uid !== uid) throw new Error("private folder refused: another user owns it");
  if ((st.mode & 0o077) !== 0) throw new Error("private folder refused: others can open it");
}

/** Makes (or verifies) a private folder. A folder that exists and is not private is refused, never repaired. */
export function ensurePrivateDir(path: string, fs: PrivateFs = defaultFs()): void {
  if (fs.platform === "win32") { fs.makeWindowsDir(path); return; }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  verifyPosixPrivateDir(path, fs.uid());
}

/** Verifies (never makes) the folder a caller named. */
export function verifyPrivateDir(path: string, fs: PrivateFs = defaultFs()): void {
  if (fs.platform === "win32") { fs.makeWindowsDir(path); return; }
  verifyPosixPrivateDir(path, fs.uid());
}

/** Writes `data` whole to `path` inside an already-verified private folder: exclusive temp, identity checked, renamed into
 * place. A prior entry at `path` (a file, or a link put there) is unlinked first, never read or followed. */
export function writePrivateFile(path: string, data: string, fs: PrivateFs = defaultFs()): void {
  try {
    lstatSync(path);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (fs.platform === "win32") { fs.writeWindowsFile(path, data); return; }
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.new`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
    // the handle is the file just made at that name, not something swapped in under it
    const held = fstatSync(fd);
    const named = lstatSync(temp);
    if (!held.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino || (held.mode & 0o077) !== 0) throw new Error("private file refused: not the file created");
    const bytes = Buffer.from(data, "utf8");
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(temp); } catch { /* gone */ }
    throw error;
  }
}

// ---- the overlay store (section 14.2 N2) ----------------------------------------------------------------------------------
// One owner-only root inside the data folder (never the OS temp folder), holding flat files only: each overlay is created
// exclusively under an unguessable name (this process's random salt and the content's hash, so a warm process's key stays
// stable while it lives) and its name is recorded in the server-written manifest before the file exists. Removal is by leaf
// name, of a regular file only: a link, junction or folder found at a recorded name is left alone and logged, never followed.
// Nothing here deletes recursively or walks a path.

const MANIFEST = "manifest.json";
const LEAF = /^[0-9a-f]{32}\.json$/;
const SALT = randomBytes(16).toString("hex");
export type PrivateLog = (line: string) => void;
const defaultLog: PrivateLog = (line) => console.warn(line);

/** Creates `path` exclusively (it must not exist) inside an already-verified private folder and writes `data` whole. */
function createPrivateFile(path: string, data: string, fs: PrivateFs): void {
  if (fs.platform === "win32") {
    // the native helper's CREATE_NEW temp with the owner-only ACL, renamed onto a name nothing holds
    let free = false;
    try { lstatSync(path); } catch (error) { free = (error as NodeJS.ErrnoException).code === "ENOENT"; }
    if (!free) throw new Error("private file refused: the name is taken");
    fs.writeWindowsFile(path, data);
    return;
  }
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const held = fstatSync(fd);
    const named = lstatSync(path);
    if (!held.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino || (held.mode & 0o077) !== 0) throw new Error("private file refused: not the file created");
    const bytes = Buffer.from(data, "utf8");
    for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* gone */ }
    throw error;
  }
  closeSync(fd);
}

/** Unlinks `root`/`leaf` when it is a regular file; anything else there (a link, a junction, a folder) is left alone and
 * logged. Returns whether a file was removed. */
function unlinkLeaf(root: string, leaf: string, log: PrivateLog): boolean {
  const path = join(root, leaf);
  let st;
  try { st = lstatSync(path); } catch { return false; }
  if (!st.isFile() || st.isSymbolicLink()) {
    log(`claude private: ${leaf} is not a regular file; left alone`);
    return false;
  }
  try { unlinkSync(path); return true; } catch { return false; }
}

/** Removes the root when it holds nothing (never recursively). */
function rmdirIfEmpty(root: string): void {
  try { rmdirSync(root); } catch { /* not empty, or gone */ }
}

export class ClaudeOverlayStore {
  private readonly held = new Map<string, number>();
  /** The leaf names this process has recorded in the manifest (its live overlays). */
  private readonly listed = new Set<string>();
  private swept = false;
  private hooked = false;
  private readonly root: () => string;
  private readonly fs: PrivateFs;
  private readonly log: PrivateLog;
  constructor(root: () => string, fs: PrivateFs = defaultFs(), log: PrivateLog = defaultLog) {
    this.root = root;
    this.fs = fs;
    this.log = log;
  }

  /** The private root (where overlays live, flat). */
  dir(): string { return this.root(); }

  /** The path an overlay with this content has in this process. */
  pathFor(text: string): string {
    return join(this.root(), `${createHash("sha256").update(`${SALT}\0${text}`).digest("hex").slice(0, 32)}.json`);
  }

  /** Writes the overlay (if no live process holds it already) and takes one hold on it; returns its path. */
  acquire(text: string): string {
    const path = this.pathFor(text);
    const count = this.held.get(path) ?? 0;
    if (count === 0) {
      const root = this.root();
      // a previous process's leftovers go before this one records anything (the manifest is this process's from here on)
      if (!this.swept) { sweepClaudePrivate(root, this.fs, this.log); this.swept = true; }
      // made (or verified) on every write: a folder removed or swapped since is never trusted from memory. The data folder
      // itself is made when missing (on Windows the helper makes each missing folder owner-only)
      if (this.fs.platform !== "win32") mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
      ensurePrivateDir(root, this.fs);
      const leaf = basename(path);
      this.listed.add(leaf);
      try {
        this.writeManifest(root);
        createPrivateFile(path, text, this.fs);
      } catch (error) {
        this.listed.delete(leaf);
        try { this.writeManifest(root); } catch { /* the next boot sweeps */ }
        throw error;
      }
      if (!this.hooked) {
        this.hooked = true;
        process.once("exit", () => { for (const name of [...this.listed]) this.remove(join(root, name)); });
      }
    }
    this.held.set(path, count + 1);
    return path;
  }

  /** Drops one hold; the file is removed when the last holder lets go. */
  release(path: string): void {
    const count = this.held.get(path) ?? 0;
    if (count <= 1) {
      this.held.delete(path);
      this.remove(path);
    } else {
      this.held.set(path, count - 1);
    }
  }

  /** The holds per path (tests). */
  holds(): ReadonlyMap<string, number> { return this.held; }

  private remove(path: string): void {
    const root = dirname(path);
    const leaf = basename(path);
    unlinkLeaf(root, leaf, this.log);
    this.listed.delete(leaf);
    try {
      if (this.listed.size > 0) { this.writeManifest(root); return; }
      unlinkLeaf(root, MANIFEST, this.log);
      rmdirIfEmpty(root);
    } catch { /* the next boot sweeps */ }
  }

  private writeManifest(root: string): void {
    writePrivateFile(join(root, MANIFEST), JSON.stringify([...this.listed].sort()), this.fs);
  }
}

/** Boot crash recovery (N2): for each name the manifest records, a regular file is unlinked by its leaf name; anything else
 * there is left alone and logged. Then the manifest goes and the root is removed if empty. A root that is a link, a junction
 * or not private, and a manifest that is not a regular file, are left alone and logged. Returns the files removed. */
export function sweepClaudePrivate(root: string, fs: PrivateFs = defaultFs(), log: PrivateLog = defaultLog): string[] {
  let st;
  try { st = lstatSync(root); } catch { return []; }
  if (st.isSymbolicLink() || !st.isDirectory()) { log("claude private: the root is not a plain folder; left alone"); return []; }
  try { verifyPrivateDir(root, fs); } catch { log("claude private: the root is not private; left alone"); return []; }
  const manifest = join(root, MANIFEST);
  let names: unknown = [];
  try {
    const mst = lstatSync(manifest);
    if (!mst.isFile() || mst.isSymbolicLink()) { log(`claude private: ${MANIFEST} is not a regular file; left alone`); return []; }
    names = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { log(`claude private: ${MANIFEST} could not be read; left alone`); return []; }
  }
  const removed: string[] = [];
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || !LEAF.test(name)) continue;
    if (unlinkLeaf(root, name, log)) removed.push(join(root, name));
  }
  unlinkLeaf(root, MANIFEST, log);
  rmdirIfEmpty(root);
  return removed;
}

// ---- the gate record (section 13) ---------------------------------------------------------------------------------------

/** The gate record for this run: every line written so far is kept in memory (hashes and lengths only), and each turn the whole
 * record is written fresh into place inside the verified private folder the gate named. Writes are synchronous on the one
 * server thread, so lines are never interleaved or lost. */
export class ClaudeGateRecord {
  private readonly lines = new Map<string, string[]>();
  private readonly fs: PrivateFs;
  constructor(fs: PrivateFs = defaultFs()) {
    this.fs = fs;
  }

  append(path: string, line: string): void {
    verifyPrivateDir(dirname(path), this.fs);
    const next = [...(this.lines.get(path) ?? []), line];
    writePrivateFile(path, `${next.join("\n")}\n`, this.fs);
    this.lines.set(path, next);
  }
}
