// SPDX-License-Identifier: AGPL-3.0-or-later
// The meter's private addon copy (engine-exclusion.ts privateCopy) lives in a murage-meter-* folder of the temporary directory. This module
// writes the owner marker into that folder, removes this process's own folder at exit, and at startup removes the folders of DEAD processes.
// A folder is touched only when ALL hold: exact name murage-meter-<6 chars>, a real directory (lstat, no link followed) directly inside a
// temporary base, owned by this user, a valid marker, and a pid that is not alive (a reused pid is told apart by its start time where the
// platform gives one; anything unreadable counts as alive). Removal unlinks only the two names we create (a link by that name is unlinked, never followed) and then rmdir (never recursive).
import { closeSync, constants as fsConstants, lstatSync, openSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeSync, fstatSync } from "node:fs";
import path from "node:path";
import { linuxProcStat, probeProcessStartSync, processIsAlive } from "../electron/data-dir-lease.mjs";

export const METER_COPY_PREFIX = "murage-meter-";
export const METER_COPY_MARKER = "owner.json";
export const METER_COPY_FILE = "engine-exclusion.node";
const NAME = /^murage-meter-[A-Za-z0-9]{6}$/;
// METERDL: up to 1.0.19 every worker left a folder (one install held 554); one start clears that backlog, and each removal is four small calls.
export const MAX_SWEEP_REMOVALS = 1024;
const MAX_MARKER_BYTES = 512;

export interface CopyMarker { v: 1; pid: number; start: string | null }
export interface CleanupHost {
  platform: NodeJS.Platform;
  /** POSIX uid of this user, null on Windows */
  uid: number | null;
  /** Windows: the owner SID of `target` (link not followed), null when unknown */
  ownerSid?: (target: string) => string | null;
  pid: number;
  alive: (pid: number) => boolean;
  /** the start time of `pid` in the form the marker holds, or null when it cannot be read */
  startOf: (pid: number) => string | null;
}
export function realCleanupHost(ownerSid?: (target: string) => string | null, processStart?: (pid: number) => string | null): CleanupHost {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    ownerSid,
    pid: process.pid,
    alive: pid => { try { return processIsAlive(pid); } catch { return true; } },
    startOf: pid => {
      if (process.platform === "linux") return linuxProcStat(pid)?.[1] ?? null;
      if (process.platform === "win32") { try { return processStart ? processStart(pid) : probeProcessStartSync(pid); } catch { return null; } }
      return null;
    },
  };
}

/** Writes the owner marker (O_EXCL, 0600, no link followed) into the fresh folder `dir`. */
export function writeCopyMarker(dir: string, host: CleanupHost = realCleanupHost()): void {
  const marker: CopyMarker = { v: 1, pid: host.pid, start: host.startOf(host.pid) };
  const fd = openSync(path.join(dir, METER_COPY_MARKER), fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try { writeSync(fd, JSON.stringify(marker)); } finally { closeSync(fd); }
}

function readMarker(dir: string): CopyMarker | null {
  const file = path.join(dir, METER_COPY_MARKER);
  let st;
  try { st = lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.size > MAX_MARKER_BYTES) return null;
  try {
    const fd = openSync(file, fsConstants.O_RDONLY);
    try {
      const open = fstatSync(fd);
      if (open.dev !== st.dev || open.ino !== st.ino) return null;
      const value = JSON.parse(readFileSync(fd, "utf8")) as Partial<CopyMarker>;
      if (value.v !== 1 || !Number.isSafeInteger(value.pid) || value.pid! <= 0) return null;
      if (value.start !== null && typeof value.start !== "string") return null;
      return { v: 1, pid: value.pid!, start: value.start };
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** true only when the marker's process is provably gone (or its pid now belongs to a process that started at another time). */
export function ownerIsDead(marker: CopyMarker, host: CleanupHost): boolean {
  if (marker.pid === host.pid) return false;
  if (!host.alive(marker.pid)) return true;
  if (marker.start === null) return false;
  const now = host.startOf(marker.pid);
  return now !== null && now !== marker.start;
}

/** Removes the two names we create and then the folder itself with rmdir. Returns false (leaves everything) on anything unexpected. */
function removeFolder(dir: string): boolean {
  try {
    for (const name of readdirSync(dir)) {
      if (name !== METER_COPY_FILE && name !== METER_COPY_MARKER) return false;
    }
    for (const name of [METER_COPY_FILE, METER_COPY_MARKER]) { try { unlinkSync(path.join(dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; } }
    rmdirSync(dir);
    return true;
  } catch { return false; }
}

/** This process's own folder, at exit. false: left in place (Windows keeps a loaded .node open); the next start's sweep removes it. */
export function removeOwnCopyDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory() || !NAME.test(path.basename(dir))) return false;
  } catch { return false; }
  return removeFolder(dir);
}

/** Removes the folders of dead processes under each `base` (a real, canonical temporary directory). `ownDir` is this process's folder. */
export function sweepStaleMeterCopies(bases: string[], ownDir: string | null, host: CleanupHost = realCleanupHost()): string[] {
  const removed: string[] = [];
  const ownSid = host.platform === "win32" && ownDir && host.ownerSid ? host.ownerSid(ownDir) : null;
  for (const base of new Set(bases)) {
    let names: string[];
    try { names = readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (removed.length >= MAX_SWEEP_REMOVALS) return removed;
      if (!NAME.test(name)) continue;
      const dir = path.join(base, name);
      if (ownDir !== null && dir === ownDir) continue;
      try {
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        if (host.platform === "win32") { if (!ownSid || host.ownerSid!(dir) !== ownSid) continue; }
        else if (host.uid === null || st.uid !== host.uid) continue;
        const marker = readMarker(dir);
        if (!marker || !ownerIsDead(marker, host)) continue;
        if (removeFolder(dir)) removed.push(dir);
      } catch { /* leave it */ }
    }
  }
  return removed;
}
