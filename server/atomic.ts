// Durable, atomic file replace: write to a sibling temp file, fsync it, then
// rename over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a truncated file behind — a
// reader always sees either the complete old contents or the complete new
// ones. Without this, an interrupted writeFileSync produces half-written JSON
// that fails to parse on next boot and is silently treated as empty state.
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

// Windows refuses a rename onto an existing path while anything else holds a
// handle to either file, and a virus scanner or the search indexer opening a
// just-closed file for a few milliseconds is enough. It surfaces as EPERM,
// EACCES or EBUSY from a replacement that would succeed a moment later, and
// every caller treats a throw as a failed save. Only those codes, and only on
// Windows, are retried: on POSIX the same codes are a real permission or mount
// problem that a delay would hide without fixing. Worst case is ~155 ms over
// six attempts, spent synchronously because every caller is a synchronous
// save path — and only ever on the Windows failure path.
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80] as const;
const RETRYABLE_WINDOWS_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* blocking wait not allowed on this thread: retry at once */
  }
}

/** Rename `from` over `to`, retrying only a transient Windows refusal.
 * `rename`, `platform` and `sleep` are injectable for tests: no portable way
 * exists to make a real filesystem produce a transient EPERM on demand. */
export function renameWithRetry(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  platform: NodeJS.Platform = process.platform,
  sleep: (ms: number) => void = sleepSync,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (platform !== "win32" || typeof code !== "string" || !RETRYABLE_WINDOWS_RENAME_CODES.has(code) || delay === undefined) {
        throw error;
      }
      sleep(delay);
    }
  }
}

/** Completed atomic writes per path in this process. A test seam: it is how a
 * store test counts file rewrites without spying on the filesystem. */
const atomicWriteCounts = new Map<string, number>();
export function atomicWriteCount(path: string): number { return atomicWriteCounts.get(path) ?? 0; }

export function writeFileAtomic(path: string, data: string | Uint8Array, options: { mode?: number } = {}): void {
  writeFileAtomicInner(path, data, options);
  atomicWriteCounts.set(path, (atomicWriteCounts.get(path) ?? 0) + 1);
}

function writeFileAtomicInner(path: string, data: string | Uint8Array, options: { mode?: number } = {}): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    // Apply sensitive-file permissions to the temporary inode itself. The
    // final rename preserves them and never leaves a broader-permission
    // config file visible between the write and a later chmod.
    fd = openSync(tmp, "w", options.mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameWithRetry(tmp, path);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

/** Owner state written by a release that passed no mode (or loosened by hand)
 * is tightened to 0600 on load, as upstream #1620 does for the registries.
 * Best effort: a file that cannot be tightened must never stop Murage from
 * loading, and its next save replaces it with a 0600 one anyway. Windows has
 * no POSIX mode bits. Returns whether the mode changed. */
export function tightenOwnerOnlyFile(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  try {
    // Only a plain file: a directory or link in a record's place is damaged
    // state for recovery to report, and chmod would follow a link.
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) === 0) return false;
    chmodSync(path, 0o600);
    return true;
  } catch {
    return false; /* absent, or not ours to change */
  }
}

// ── Coalesced writes ─────────────────────────────────────────────────────────
// A store that changes many times a second (an unread badge, a task switch)
// used to rewrite its whole file on every change. A coalesced write keeps only
// the LAST requested state per key and writes it at most once per window.
//
// Durability contract, stated plainly:
//  - The in-memory state is always the truth; callers never read the file back.
//  - The last state is written within COALESCE_WINDOW_MS, and synchronously on
//    flushCoalesced() (called before backups and snapshots), on process exit
//    and on SIGTERM. A graceful stop therefore never loses the final state.
//  - A hard crash (SIGKILL, power loss) between a change and its flush loses at
//    most about COALESCE_WINDOW_MS of changes. Only cosmetic state may be
//    deferred. Security, owner, consent and delivery records must keep using
//    writeFileAtomic directly (an immediate, durable write).
export const COALESCE_WINDOW_MS = 250;

interface PendingWrite { flush: () => void; timer: ReturnType<typeof setTimeout> | null }
const pendingWrites = new Map<string, PendingWrite>();
let exitHooksInstalled = false;

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", () => { try { flushCoalesced(); } catch { /* exiting: nothing left to report to */ } });
  // Only when nothing else handles SIGTERM: the process owner's own handler
  // (index.ts) flushes through the exit hook above when it exits. Without any
  // handler the default action would kill the process before "exit" fires.
  if (process.listenerCount("SIGTERM") === 0) {
    const onTerm = () => {
      try { flushCoalesced(); } catch { /* best effort */ }
      process.removeListener("SIGTERM", onTerm);
      // Re-raise for the default action only when no handler was added since;
      // a later owner's handler already saw this signal and closes the process.
      if (process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM");
    };
    process.on("SIGTERM", onTerm);
  }
}

/** Ask for `flush` to run once within the window. A later call for the same
 * key replaces the earlier closure (last value wins) without moving the timer,
 * so a steady stream of changes still reaches disk every window. */
export function scheduleCoalesced(key: string, flush: () => void, windowMs = COALESCE_WINDOW_MS): void {
  installExitHooks();
  const existing = pendingWrites.get(key);
  if (existing) {
    existing.flush = flush;
    if (!existing.timer) arm(key, existing, windowMs);
    return;
  }
  const entry: PendingWrite = { flush, timer: null };
  pendingWrites.set(key, entry);
  arm(key, entry, windowMs);
}

/** A failed deferred write stays pending (with no timer), so the next change,
 * an explicit flush, a backup or exit retries it instead of losing it. */
function arm(key: string, entry: PendingWrite, windowMs: number): void {
  entry.timer = setTimeout(() => {
    entry.timer = null;
    try {
      entry.flush();
      if (pendingWrites.get(key) === entry && !entry.timer) pendingWrites.delete(key);
    } catch (error) {
      console.error(`atomic: deferred write for ${key} failed; kept pending, retried on the next change, flush or exit`, error);
    }
  }, windowMs);
  entry.timer.unref?.();
}

/** Drop a pending write because the caller just wrote the same state now. */
export function cancelCoalesced(key: string): void {
  const entry = pendingWrites.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pendingWrites.delete(key);
}

export function hasPendingCoalesced(key?: string): boolean { return key === undefined ? pendingWrites.size > 0 : pendingWrites.has(key); }

/** Run pending writes now (one key, or all). Every pending write is attempted;
 * the first failure is rethrown afterwards. */
export function flushCoalesced(key?: string): void {
  const keys = key === undefined ? [...pendingWrites.keys()] : pendingWrites.has(key) ? [key] : [];
  let failure: unknown;
  let failed = false;
  for (const k of keys) {
    const entry = pendingWrites.get(k);
    if (!entry) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    pendingWrites.delete(k);
    try { entry.flush(); } catch (error) {
      // Still not on disk: keep it pending for the next attempt, and report.
      if (!pendingWrites.has(k)) pendingWrites.set(k, entry);
      if (!failed) { failed = true; failure = error; }
    }
  }
  if (failed) throw failure;
}

/** writeFileAtomic, deferred and coalesced per path. `produce` runs at flush
 * time, so the bytes always reflect the newest state and are built once. */
export function writeFileCoalesced(path: string, produce: () => string | Uint8Array, options: { mode?: number } = {}): void {
  scheduleCoalesced(path, () => writeFileAtomic(path, produce(), options));
}
