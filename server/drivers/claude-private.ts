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
// - The overlay (isolation settings with restated values): one per content, held by each CLI process launched with it and
//   removed when the last one exits, or when the launch fails; this process's folder goes at exit, and a folder left by a
//   process that is gone is swept at boot (sweepClaudePrivate).
// Nothing here logs a path's content.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// ---- the overlay store ----------------------------------------------------------------------------------------------------

const ROOT_NAME = "murage-claude-private";
const PROCESS_DIR = /^p-(\d+)-[0-9a-f]{12}$/;

/** The private root: one per user in the OS temp folder (on POSIX the uid is in the name). */
export function claudePrivateRoot(base: string = tmpdir(), fs: PrivateFs = defaultFs()): string {
  const uid = fs.uid();
  return join(base, uid === undefined ? ROOT_NAME : `${ROOT_NAME}-${uid}`);
}

export class ClaudeOverlayStore {
  private readonly dirName = `p-${process.pid}-${randomBytes(6).toString("hex")}`;
  private readonly held = new Map<string, number>();
  private readonly made = new Set<string>();
  private readonly root: () => string;
  private readonly fs: PrivateFs;
  constructor(root: () => string = () => claudePrivateRoot(), fs: PrivateFs = defaultFs()) {
    this.root = root;
    this.fs = fs;
  }

  /** This process's private folder (where overlays live). */
  dir(): string { return join(this.root(), this.dirName); }

  /** The path an overlay with this content has (named by its hash, so the warm key stays stable across turns). */
  pathFor(text: string): string {
    return join(this.dir(), `${createHash("sha256").update(text).digest("hex").slice(0, 32)}.json`);
  }

  /** Writes the overlay (if no live process holds it already) and takes one hold on it; returns its path. */
  acquire(text: string): string {
    const path = this.pathFor(text);
    const count = this.held.get(path) ?? 0;
    if (count === 0) {
      // made (or verified) on every write: a folder removed or swapped since is never trusted from memory
      const dir = this.dir();
      ensurePrivateDir(this.root(), this.fs);
      ensurePrivateDir(dir, this.fs);
      if (!this.made.has(dir)) {
        this.made.add(dir);
        process.once("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
      }
      writePrivateFile(path, text, this.fs);
    }
    this.held.set(path, count + 1);
    return path;
  }

  /** Drops one hold; the file is removed when the last holder lets go. */
  release(path: string): void {
    const count = this.held.get(path) ?? 0;
    if (count <= 1) {
      this.held.delete(path);
      try { unlinkSync(path); } catch { /* gone */ }
    } else {
      this.held.set(path, count - 1);
    }
  }

  /** The holds per path (tests). */
  holds(): ReadonlyMap<string, number> { return this.held; }
}

/** Boot crash recovery: removes every process folder in the private root whose process is gone (never this process's, never
 * one whose process still runs). Returns the folders removed. A root that is not private is left alone. */
export function sweepClaudePrivate(root: string = claudePrivateRoot(), alive: (pid: number) => boolean = processAlive, fs: PrivateFs = defaultFs()): string[] {
  try { lstatSync(root); } catch { return []; }
  try { verifyPrivateDir(root, fs); } catch { return []; }
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  for (const name of names) {
    const match = PROCESS_DIR.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || alive(pid)) continue;
    const path = join(root, name);
    try {
      // a link is removed as a link, never followed
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(path);
      else rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch { /* next boot */ }
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
