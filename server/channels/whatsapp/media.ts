// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inbound media on disk (design 5.6). The bridge streams files into DATA_DIR/whatsapp/media/<connectionId>/<chatKey>/
// under generated names and hard caps. This file is the service's half: it checks that a path the bridge reported is
// one of those files, and it sweeps old ones. The sweep lives here and not in the bridge because only the service
// knows which files an unfinished receipt still needs.
import { constants, closeSync, fstatSync, mkdirSync, openSync, realpathSync, existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MEDIA_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PART_MAX_AGE_MS = 24 * 60 * 60_000;

export const mediaRoot = (dataDir: string, connectionId: string): string => join(dataDir, "whatsapp", "media", connectionId);

/**
 * A media root is always <data>/whatsapp/media/<connectionId>. The data folder itself is the owner's choice and may
 * sit behind a link (macOS keeps temp and some home folders under /var -> /private/var, a home can live on a linked
 * volume), so it is resolved once. From <data>/whatsapp down nothing may be a link: every check below runs on this
 * canonical form, where any link in the media tree still shows up as realpath(path) !== path.
 */
function canonicalRoot(root: string): string | null {
  const base = resolve(root), anchor = dirname(dirname(dirname(base)));
  try { return join(realpathSync(anchor), relative(anchor, base)); } catch { return null; }
}

/** `path` (given under either spelling of the root) in canonical form, or null when it is outside the root. */
function canonicalIn(root: string, realRoot: string, path: string): string | null {
  const base = resolve(root), full = resolve(path);
  if (full === base || full.startsWith(base + sep)) return join(realRoot, relative(base, full));
  if (full === realRoot || full.startsWith(realRoot + sep)) return full;
  return null;
}

/** Create only below real directories, checking ancestors before any mkdir. `directory` must be inside `root`. */
export function createMediaDirectory(root: string, directory: string): boolean {
  const realRoot = canonicalRoot(root), dir = realRoot && canonicalIn(root, realRoot, directory);
  if (!dir) return false;
  const make = (current: string): boolean => {
    try {
      if (!existsSync(current)) {
        const parent = dirname(current);
        if (parent === current || !make(parent)) return false;
        mkdirSync(current, { mode: 0o700 });
      }
      const stat = lstatSync(current);
      return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(current) === current;
    } catch { return false; }
  };
  return make(dir);
}

/** Check every directory before reading or writing a media file. */
export function mediaDirectory(root: string, directory: string): boolean {
  const base = canonicalRoot(root), dir = base && canonicalIn(root, base, directory);
  if (!base || !dir) return false;
  try {
    // A linked root or ancestor cannot redirect the connection's media tree.
    if (realpathSync(base) !== base) return false;
    let cursor = base;
    for (const part of ["", ...relative(base, dir).split(sep).filter(Boolean)]) {
      if (part) cursor = join(cursor, part);
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    return realpathSync(dir) === dir;
  } catch { return false; }
}

export function containedMediaFile(root: string, path: string | undefined, maxBytes = 20 * 1024 * 1024): { path: string; bytes: number } | null {
  if (!path || path.includes("\0")) return null;
  const full = resolve(path), realRoot = canonicalRoot(root), real = realRoot && canonicalIn(root, realRoot, full);
  if (!realRoot || !real || !real.startsWith(realRoot + sep) || !mediaDirectory(root, dirname(real))) return null;
  let fd: number | undefined;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes || realpathSync(real) !== real) return null;
    // The caller's spelling of the path is kept, so stored references stay under the data folder it configured.
    return { path: full, bytes: stat.size };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** The file's current size, only within this connection's real media tree. */
export function ownedMediaFile(dataDir: string, connectionId: string, path: string | undefined): { path: string; bytes: number } | null {
  return containedMediaFile(mediaRoot(dataDir, connectionId), path);
}

/** Recheck image references at the final run admission boundary. */
export function whatsappAttachments(dataDir: string, connectionId: string, deliveryId: string, media: readonly { path: string; mime: string }[]) {
  return media.flatMap((item, index) => {
    const file = /^image\/(?:jpeg|png|webp|gif)$/.test(item.mime) ? ownedMediaFile(dataDir, connectionId, item.path) : null;
    return file ? [{ id: `${deliveryId}:${index}`.slice(0, 200), kind: "image" as const, name: file.path.split(sep).at(-1)!.slice(0, 255), path: file.path, size: file.bytes }] : [];
  });
}

/**
 * Deletes media files older than seven days unless an unfinished receipt references them, and interrupted
 * downloads (`.part`) older than a day. Empty chat directories go too. Never follows a link. Returns the count removed.
 */
export function sweepMedia(input: { dataDir: string; connectionId: string; keep: Iterable<string>; nowMs: number }): number {
  const root = resolve(mediaRoot(input.dataDir, input.connectionId));
  if (!existsSync(root) || !mediaDirectory(root, root)) return 0;
  const keep = new Set([...input.keep].map(p => resolve(p)));
  let removed = 0;
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let stat;
      try { stat = lstatSync(path); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { if (depth < 3) walk(path, depth + 1); continue; }
      if (!stat.isFile()) continue;
      const age = input.nowMs - stat.mtimeMs;
      const limit = name.endsWith(".part") ? PART_MAX_AGE_MS : MEDIA_MAX_AGE_MS;
      if (age < limit || keep.has(resolve(path))) continue;
      try { rmSync(path, { force: true }); removed++; } catch { /* best effort */ }
    }
    if (dir !== root) { try { if (readdirSync(dir).length === 0) rmdirSync(dir); } catch { /* best effort */ } }
  };
  walk(root, 0);
  return removed;
}
