// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The private on-disk store the connected-apps bridge remembers tool lists in
// (and the harness hands a long approved list through). Standalone and
// dependency-light on purpose: the bridge is bundled and spawned as its own
// node process, so nothing here may import server state.
//
// What it holds is sensitive enough to bound (approved account ids, upstream
// descriptions that can carry an address), so:
//   - the directory is private to this user (POSIX: owner only, never a
//     symlink; Windows: the harness verified an owner-only ACL and said so);
//   - nothing older than CACHE_MAX_AGE_MS is ever read, and expired entries
//     are deleted by a throttled prune that runs on every write, at start and
//     on a timer;
//   - the harness purges it when an account is disconnected or signed out.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export const CACHE_MAX_BYTES = 4 * 1024 * 1024;
export const CACHE_MAX_FILES = 64;
/** Nothing older than this is read back, and it is deleted when found. */
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Pruning runs at most this often per process. */
export const PRUNE_EVERY_MS = 10 * 60_000;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,120}$/;

export interface CacheEnv { dir: string | undefined; windowsVerified: boolean }

export function cacheEnvFromProcess(env: Record<string, string | undefined> = process.env): CacheEnv {
  return { dir: env.MURAGE_CONNECTOR_TOOLS_CACHE_DIR || undefined, windowsVerified: env.MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE === "1" };
}

/** The private directory, or null. Created owner-only; must be a real directory
 * (never a symlink); on POSIX owned by this user with no group or other access.
 * On Windows POSIX mode bits mean nothing: the harness checks the directory's
 * ACL with the native helper before it passes the path, and says so with
 * MURAGE_CONNECTOR_TOOLS_CACHE_PRIVATE=1. Without that, a Windows directory is
 * never used (nothing is cached) rather than trusted on inheritance. */
export function privateCacheDir(cache: CacheEnv, create: boolean, platform: string = process.platform): string | null {
  const dir = cache.dir;
  if (!dir) return null;
  if (platform === "win32" && !cache.windowsVerified) return null;
  try {
    if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
    if (platform !== "win32" && typeof process.getuid === "function") {
      if (info.uid !== process.getuid()) return null;
      if ((info.mode & 0o077) !== 0) {
        chmodSync(dir, 0o700);
        if ((lstatSync(dir).mode & 0o077) !== 0) return null;
      }
    }
    return dir;
  } catch {
    return null;
  }
}

/** Read one entry: a regular file of this user, not too big, and not expired
 * (an expired one is deleted). Returns the parsed JSON object or null. */
export function readCacheEntry(dir: string, name: string, now: number = Date.now()): Record<string, unknown> | null {
  if (!SAFE_NAME.test(name)) return null;
  let fd: number | undefined;
  const file = join(dir, name);
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > CACHE_MAX_BYTES) return null;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return null;
    if (now - info.mtimeMs > CACHE_MAX_AGE_MS) {
      closeSync(fd);
      fd = undefined;
      try { unlinkSync(file); } catch { /* gone */ }
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** Write one entry atomically (exclusive temp file, then rename). Returns whether it landed. */
export function writeCacheEntry(dir: string, name: string, body: string, now: number = Date.now()): boolean {
  if (!SAFE_NAME.test(name) || Buffer.byteLength(body) > CACHE_MAX_BYTES) return false;
  const file = join(dir, name);
  const temp = join(dir, `${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); // exclusive: never follows or reuses an existing path
    writeSync(fd, body);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    pruneCacheDir(dir, now);
    return true;
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(temp); } catch { /* none */ }
    return false;
  }
}

const lastPruneAt = new Map<string, number>();
/** Delete what is obsolete: expired entries, stale temp files, and everything
 * beyond the newest CACHE_MAX_FILES. Throttled per directory unless `force`. */
export function pruneCacheDir(dir: string, now: number = Date.now(), force = false): void {
  const last = lastPruneAt.get(dir);
  if (!force && last !== undefined && now - last < PRUNE_EVERY_MS) return;
  lastPruneAt.set(dir, now);
  try {
    const files: { name: string; at: number }[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let info;
      try { info = lstatSync(full); } catch { continue; }
      if (!info.isFile()) continue;
      if (name.endsWith(".tmp")) { if (now - info.mtimeMs > 3600_000) try { unlinkSync(full); } catch { /* gone */ } continue; }
      if (!name.endsWith(".json")) continue;
      if (now - info.mtimeMs > CACHE_MAX_AGE_MS) { try { unlinkSync(full); } catch { /* gone */ } continue; }
      files.push({ name, at: info.mtimeMs });
    }
    files.sort((a, b) => b.at - a.at);
    for (const old of files.slice(CACHE_MAX_FILES)) try { unlinkSync(join(dir, old.name)); } catch { /* gone */ }
  } catch { /* best effort */ }
}

/** Remove every entry (the account was disconnected or signed out). Files only;
 * the directory itself, and anything that is not a plain file, stays. */
export function purgeCacheDir(dir: string): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (!lstatSync(full).isFile()) continue;
        if (name === GENERATION_FILE) continue; // the fence must outlive the purge it announces
        unlinkSync(full);
        removed += 1;
      } catch { /* gone */ }
    }
  } catch { /* none */ }
  return removed;
}

// ── The connection generation (the disconnect fence) ──────────────────
// One small file shared by the harness and every running bridge. The harness
// writes a NEW value BEFORE it purges (disconnect, sign-out). A bridge records
// the value when it starts a list operation and writes it into every entry it
// stores; a reply that comes back under an older value is discarded, an entry
// carrying an older value is never read, and a write that raced the purge is
// removed by its writer. The file is not a `.json`, so pruning and expiry never touch it.
export const GENERATION_FILE = "generation.gen";
const GENERATION_SHAPE = /^[A-Za-z0-9-]{1,64}$/;
/** The value a handoff carries when it was built before any generation was ever written. Explicit, never empty. */
export const INITIAL_GENERATION = "initial";
/** A generation as a handoff names it: "" (none written yet) is the explicit initial value. */
export const generationLabel = (generation: string): string => generation || INITIAL_GENERATION;
/** The current generation ("" when none was ever written). Never throws. */
export function readGeneration(dir: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(join(dir, GENERATION_FILE), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 128) return "";
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "";
    const text = readFileSync(fd, "utf8").trim();
    return GENERATION_SHAPE.test(text) ? text : "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
  }
}
/** Announce a new generation (atomic). Returns it, or "" when the folder is unusable. */
export function bumpGeneration(dir: string): string {
  const next = randomUUID();
  const temp = join(dir, `${GENERATION_FILE}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeSync(fd, next);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, join(dir, GENERATION_FILE));
    return next;
  } catch {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(temp); } catch { /* none */ }
    return "";
  }
}
/** Remove one entry (a write that lost the race with a purge). */
export function removeCacheEntry(dir: string, name: string): void {
  if (!SAFE_NAME.test(name)) return;
  try { unlinkSync(join(dir, name)); } catch { /* gone */ }
}

/** The file the harness writes a long approved list to, and the bridge reads. */
export const initialToolsFileName = (scope: { identity: string; revision: string }): string => `initial-${scope.identity}-${scope.revision}.json`;
/** The value of MURAGE_CONNECTOR_INITIAL_TOOLS that says "the list is in the file". */
export const INITIAL_TOOLS_IN_FILE = "@file";
/** The value that says "the approved list could not be handed over: ask the harness for it". */
export const INITIAL_TOOLS_ASK_HARNESS = "@harness";

// ── Time budgets (one place, so a test can hold them against every engine) ──
/** The ONE absolute deadline of a tools/list in the bridge: the hold for the real
 * list and any authoritative fetch spend from it, never beyond. */
export const CONNECTOR_LIST_DEADLINE_MS = 8_000;
/** What the answer needs after the deadline to reach the engine (process pipes, engine scheduling). */
export const CONNECTOR_LIST_TRANSPORT_MARGIN_MS = 2_000;
/** The list/startup limit Murage configures for every engine that has one
 * (Pi's list deadline, Codex's startup timeout, Claude's MCP_TIMEOUT): at least
 * twice the bridge's deadline, so the bridge always answers first. */
export const ENGINE_MCP_LIST_LIMIT_MS = 20_000;

// ── Mounts that were served only a stand-in (session recovery) ──────────
// Codex and the ACP engines never list again after the first answer. When the
// bridge had to serve a provisional list, it files a marker here; the driver
// that owns a warm engine reads it at the next turn and starts a fresh engine
// (same conversation, new MCP mount), which then lists the remembered real
// list at once. The bridge removes the marker when it serves a real list.
export interface MountRef { cache: CacheEnv; identity: string; revision: string; thread: string }
/** Per account+bot AND chat thread: another thread's engine holding a real list never clears this one's. */
export const mountMarkerName = (identity: string, thread: string): string => `incomplete-${identity}-${createHash("sha256").update(thread).digest("hex").slice(0, 16)}.json`;
export function markMountIncomplete(ref: MountRef): void {
  const dir = privateCacheDir(ref.cache, true);
  if (dir) writeCacheEntry(dir, mountMarkerName(ref.identity, ref.thread), JSON.stringify({ revision: ref.revision, at: Date.now(), ready: false }));
}
/** The authoritative list is now cached (under `generation`) for an engine that holds the stand-in:
 * from here, and only from here, the driver may replace that engine. Only an existing marker is updated. */
export function markMountReady(ref: MountRef, generation: string): void {
  const dir = privateCacheDir(ref.cache, false);
  if (!dir) return;
  const name = mountMarkerName(ref.identity, ref.thread);
  const entry = readCacheEntry(dir, name);
  if (entry && entry.revision === ref.revision) writeCacheEntry(dir, name, JSON.stringify({ revision: ref.revision, at: entry.at ?? Date.now(), ready: true, generation }));
}
export function clearMountIncomplete(ref: MountRef): void {
  const dir = privateCacheDir(ref.cache, false);
  if (dir) removeCacheEntry(dir, mountMarkerName(ref.identity, ref.thread));
}
/** The engine holds the stand-in AND the real list has been confirmed available under the current
 * connection generation. A marker still waiting for its list (discovery keeps failing) never
 * recycles: the warm engine stays, and the bridge keeps probing with backoff. */
export function mountIncomplete(ref: MountRef): boolean {
  const dir = privateCacheDir(ref.cache, false);
  const entry = dir ? readCacheEntry(dir, mountMarkerName(ref.identity, ref.thread)) : null;
  return !!entry && !!dir && entry.revision === ref.revision && entry.ready === true
    && (typeof entry.generation === "string" ? entry.generation : "") === readGeneration(dir);
}
