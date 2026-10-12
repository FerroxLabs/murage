// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// How a bot's scoped engine home shares the owner's login file with the owner's real folder.
//
// ONE file, two names, never two files. A symlink is the first choice everywhere (the engine refreshes the login THROUGH it,
// so the owner's real login is updated and never forked). Where a symlink cannot be made (Windows without the symlink
// privilege, a volume that has no symlinks) the answer depends on HOW THE ENGINE WRITES ITS LOGIN:
//   - in place (open, truncate, write: Codex FileAuthStorage::save, Gemini cacheCredentials): a HARDLINK to the owner's file
//     stays one file whatever either name is written through, so on one volume it is shared as a hardlink;
//   - by temporary file and rename (Grok write_auth_json_atomic, Droid `atomically`, Qwen cacheQwenCredentials): a rename
//     replaces ONE name and leaves the other on the old bytes, so a hardlink cannot be shared safely. The turn is rejected
//     (LoginLinkUnavailableError) with guidance to enable symlinks, never run on a copy.
// There is no copy and no reconciliation: Murage never chooses between two login files (not by modification time, not by
// anything else), because a refresh the engine makes between a snapshot and a replacement could be rolled back. A hardlinked
// login is checked at the start of every turn (`sharesFile`); when the two names are no longer one file nothing is repaired:
// the scope moves to a NEW login generation linked to the owner's current file (scoped-cli-home.ts, "Login generations").
//
// Every file operation goes through `LinkIo`, so the decision table is tested with an in-memory file system.
import { linkSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";

export interface LinkStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  /** A file id: a bigint from the real file system (a Windows file index does not fit a double), compared for equality only. */
  ino: number | bigint;
  dev: number | bigint;
}

export interface LinkIo {
  symlinkSync(target: string, path: string): void;
  linkSync(existing: string, path: string): void;
  lstatSync(path: string): LinkStat;
  statSync(path: string): LinkStat;
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer, options: { mode: number; flag?: string }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
  mkdirSync(path: string): void;
  /** Where a symlink points (optional: an io without it is compared by file id only). */
  readlinkSync?(path: string): string;
}

export const nodeLinkIo: LinkIo = {
  symlinkSync: (target, path) => symlinkSync(target, path),
  linkSync: (existing, path) => linkSync(existing, path),
  lstatSync: (path) => lstatSync(path, { bigint: true }),
  statSync: (path) => statSync(path, { bigint: true }),
  readFileSync: (path) => readFileSync(path),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
  mkdirSync: (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }); },
  readlinkSync: (path) => readlinkSync(path),
};

export type LinkMode = "symlink" | "hardlink" | "absent";

/** The login cannot be shared as one file: no symlink is allowed and the engine's way of writing it (or the volume) rules out a hardlink. */
export class LoginLinkUnavailableError extends Error {
  readonly reason: "symlink-needed" | "hardlink-failed";
  constructor(reason: "symlink-needed" | "hardlink-failed", options?: { cause?: unknown }) {
    super(reason === "symlink-needed"
      ? "The engine replaces its login file by renaming over it, so the login can only be shared through a symlink, and this account may not create one."
      : "The login could not be shared as a hardlink (the owner's folder is on another volume, or the file system has no hardlinks) and a symlink is not allowed.", options);
    this.name = "LoginLinkUnavailableError";
    this.reason = reason;
  }
}

/** Errors a symlink raises where it is not permitted or not supported (Windows reports a missing privilege as EPERM, some as UNKNOWN). */
const SYMLINK_UNAVAILABLE = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "UNKNOWN"]);
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const exists = (io: LinkIo, path: string): boolean => { try { io.statSync(path); return true; } catch { return false; } };

export interface LinkOptions {
  /** The engine writes this file in place (open, truncate, write), so a hardlink stays one file. False (the default): the engine renames over it, and only a symlink can share it. */
  hardlinkOk?: boolean;
  /** A lock file: only ever opened, never replaced, so a hardlink is always fine, and one that cannot be made is simply not shared. */
  lock?: boolean;
}

/**
 * Put the owner's login `real` into the scope as `scoped`. Symlink first. Where that is not allowed: a hardlink when the engine
 * writes the file in place and `real` exists on the same volume; otherwise it throws LoginLinkUnavailableError (no copy).
 * A login that does not exist yet is not linked (a symlink into a missing folder cannot be written through): the engine
 * writes it in the scope, and retirement hands it to the owner's folder.
 */
export function linkSharedEntry(real: string, scoped: string, io: LinkIo = nodeLinkIo, options: LinkOptions = {}): LinkMode {
  try {
    io.symlinkSync(real, scoped);
    return "symlink";
  } catch (error) {
    if (!SYMLINK_UNAVAILABLE.has(codeOf(error) ?? "")) throw error;
  }
  const hardlinkOk = options.hardlinkOk === true || options.lock === true;
  if (!hardlinkOk) throw new LoginLinkUnavailableError("symlink-needed");
  if (!exists(io, real)) return "absent";
  try {
    io.linkSync(real, scoped);
    return "hardlink";
  } catch (error) {
    if (options.lock) return "absent";
    throw new LoginLinkUnavailableError("hardlink-failed", { cause: error });
  }
}

/**
 * True when `scoped` still follows the owner's file: it is a symlink, or it is the SAME file as `real` (file id and device equal).
 * Both names missing counts as shared (nothing to read). Never throws; anything unreadable is "not shared".
 */
export function sharesFile(real: string, scoped: string, io: LinkIo = nodeLinkIo): boolean {
  try {
    let scopedStat: LinkStat | null = null;
    try { scopedStat = io.lstatSync(scoped); } catch { /* missing */ }
    let realStat: LinkStat | null = null;
    try { realStat = io.statSync(real); } catch { /* missing */ }
    if (scopedStat?.isSymbolicLink()) return true;
    if (!scopedStat && !realStat) return true;
    if (!scopedStat || !realStat) return false;
    return Boolean(scopedStat.ino) && scopedStat.ino === realStat.ino && scopedStat.dev === realStat.dev;
  } catch {
    return false;
  }
}
