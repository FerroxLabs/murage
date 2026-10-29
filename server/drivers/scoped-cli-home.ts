// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Murage-owned stand-in for an engine's own home folder (GROK_HOME,
// CODEX_HOME, Droid's .factory): one state root PER BOT, so one bot's sessions,
// history, caches and instruction files are never another bot's, and nothing a
// bot's turn writes lands in the owner's real folder.
//
// Only what the caller names as `share` is linked through to the owner's real
// folder: the login files, which a real CLI was proved (rig) to refresh THROUGH
// the link, so the owner's real login is updated and never forked. They are
// linked even when absent, so a first sign-in made from a bot turn lands in
// the real folder. Where a symlink is not allowed (Windows without the
// privilege) the login is a hardlink on the same volume, but ONLY for an engine that writes it in
// place (`loginWrites: "in-place"`); an engine that renames over it, or a volume without hardlinks, rejects the turn.
// Never a copy, never a choice between two login files: a hardlinked login is checked to still be ONE file at the start
// of every turn (verifyScopeLogins) and the turn is rejected when it is not (shared-login-link.ts). Every other entry (sessions, history, caches, personal
// items) is simply not in the scope. The caller's `generated` files (a
// filtered config) are written into the scope as copies.
//
// The root is stable per (real folder, bot) and refreshed in place: missing
// links are added and the generated files rewritten; nothing the engine wrote
// in the scope is removed. Worked out once per owner setup (isolation-cache.ts):
// later turns only stat what the first one read.
//
// Scopes of bots that are gone are retired (retireScopes): unused for a long
// time, or beyond a count limit, never one used in the last day, and a login
// file created only inside a retiring scope is moved into the real folder first.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DATA_DIR } from "../config.ts";
import { memoDeps, pathExists } from "./isolation-cache.ts";
import { LoginLinkUnavailableError, linkSharedEntry, nodeLinkIo, sharesFile, type LinkIo, type LinkMode } from "./shared-login-link.ts";
import { ownProcessRecord, processRunning, type ProcessRecord } from "./process-identity.ts";

export interface ScopedCliHomeSpec {
  /** Cache and folder name: native/<kind>-scope/<hash>. */
  kind: string;
  realHome: string;
  /** The bot this scope belongs to. Absent: the one shared root for turns with no bot (probes, helpers). */
  botId?: string;
  /** Login entries linked through to the real folder, even when absent. Nothing else of the owner's is linked. */
  share: readonly string[];
  /** Link the shared entries only once the owner's folder exists. A link into a missing folder cannot be written through, so the
   *  engine writes in the scope meanwhile and retirement hands a login to the owner's folder (Gemini with no ~/.gemini yet). */
  linkOnlyWithFolder?: boolean;
  /** How the engine writes its login files: "in-place" (open, truncate, write: a hardlink stays one file, so it may be used where a
   *  symlink is not allowed) or "replace" (temporary file and rename: only a symlink can share it). Default "replace". */
  loginWrites?: "in-place" | "replace";
  /** Entries of `share` that are lock files: linked when the owner's exists, never checked as a login or handed to the owner's folder. */
  locks?: readonly string[];
  /** Files the scope holds as copies, rewritten on every rebuild (read through isolation-cache). */
  generated?: () => Record<string, string>;
  /** What a fresh process needs, beside the owner folder and bot, to rebuild this spec from the scope's marker (see registerScopeReconstructor). Persisted in the marker. */
  rebuildInputs?: Record<string, string>;
  /** Mirror into this sub-folder of the scope (`.factory` for an engine that takes a HOME); the scope root is returned. */
  subdir?: string;
  /** Folders of the scope's home that hold only rebuildable, non-credential cache or logs: the only things pruned when the scope passes its byte cap. */
  cache?: readonly string[];
}

/**
 * The session contract of a bot's engine state root. Bumped when the place an
 * engine keeps its sessions moves: a cursor recorded under an earlier contract
 * (the owner's real folder, a shared or content-addressed scope) is not found
 * in the bot's root, and the driver then starts ONE new session and replays the
 * conversation the harness sent (never copying old sessions across).
 */
export const SESSION_CONTRACT = 2;

export const scopedCliHomeRoot = (kind: string): string => join(DATA_DIR, "native", `${kind}-scope`);

/** A scope unused for this long is retired. */
export const SCOPE_RETIRE_MAX_AGE_MS = 30 * 24 * 3_600_000;
/** More scopes than this per engine: the least recently used go, if unused for SCOPE_RETIRE_MIN_IDLE_MS. */
export const SCOPE_RETIRE_MAX_COUNT = 64;
export const SCOPE_RETIRE_MIN_IDLE_MS = 24 * 3_600_000;
/** Holds what the scope belongs to; its mtime is the scope's last use (a folder's own mtime is a cache dependency, and must not move on a touch). */
export const SCOPE_MARKER = ".murage-scope.json";
/** The marker the earlier (content-addressed) Gemini scopes left, relative to the scope root. */
const LEGACY_GEMINI_MARKER = join(".gemini", ".murage-scope");
/** Scopes this engine's retirement cannot place, and logins that could not be put back, are moved here and never deleted. */
export const SCOPE_QUARANTINE = ".quarantine";
/** An active bot's scope may hold this many bytes; past it only its declared cache folders are pruned (never sessions, never a login). */
export const SCOPE_MAX_BYTES = 1024 * 1024 * 1024;
/** Pruning touches only a scope nobody has used for this long, and only while it holds the scope's exclusive lease. */
export const SCOPE_PRUNE_MIN_IDLE_MS = SCOPE_RETIRE_MIN_IDLE_MS;
/** The lease lives BESIDE the scope (a dot file in the engine's scope folder), never inside it: taking and dropping it must not
 * change the scope folder, whose signature the isolation caches watch. */
export const scopeLockPath = (root: string): string => join(dirname(root), `.${basename(root)}.prune.lock`);
/** Quarantine is bounded: scope contents past this age or total size are dropped (logins are first set aside, one newest copy of each distinct login is always kept). */
export const QUARANTINE_MAX_AGE_MS = 30 * 24 * 3_600_000;
export const QUARANTINE_MAX_BYTES = 512 * 1024 * 1024;
const QUARANTINE_LOGINS = "logins";
const WALK_ENTRY_LIMIT = 200_000;
const TOUCH_EVERY_MS = 3_600_000;

interface ScopeMarker {
  contract?: number;
  realHome?: unknown;
  botId?: unknown;
  subdir?: unknown;
  share?: unknown;
  cache?: unknown;
  /** How each shared login got into the scope (symlink, hardlink, absent). A hardlink is checked to still be the owner's file at the start of every turn. */
  shareMode?: unknown;
  locks?: unknown;
  /** The names of the generated copies written into the scope on the last build: the only files a rebuild may remove when the owner's source is gone or unusable. */
  generated?: unknown;
  /** Generated names whose owner source was removed (or unusable): no generation carries, copies or rotates them in again from an older generation. Cleared when the owner recreates the source. */
  deletedGenerated?: unknown;
  /** How the engine writes its login (see ScopedCliHomeSpec.loginWrites): a later generation may be hardlinked only for "in-place". */
  loginWrites?: unknown;
  /** The login generation engines are launched on now (absent or 0: the scope root itself). See "Login generations" below. */
  generation?: unknown;
  /** Written by every build, which is always for a launch and precedes it: from then on the current generation's logins are never created or relinked in place (a process may hold them). */
  launched?: unknown;
  /** When each older generation was last launched on (ms, by generation number; recorded as the scope moves off it): old generations are retired by their own age. */
  launchedAt?: unknown;
  /** True when the spec had generated copies: a process that did not build the scope refreshes them from the owner's source (rebuildInputs) or rejects. */
  generates?: unknown;
  rebuildInputs?: unknown;
  owner?: ProcessRecord;
}

/** Told when a scope moved to a new login generation, so the idle engine processes started on the older one can be drained. */
export interface LoginSplitEvent { kind: string; botId: string | null }
let loginSplitHook: ((event: LoginSplitEvent) => void) | null = null;
export function setLoginSplitHook(hook: ((event: LoginSplitEvent) => void) | null): void { loginSplitHook = hook; }
export const LOGIN_ASIDE_DIR = ".login-aside"; // earlier builds set a split login aside here; retirement still retains what they left
/** A login generation of a scope: `login-g<N>` under the scope root (N >= 1). Generation 0 is the scope root itself. */
export const GENERATION_PREFIX = "login-g";
/** Old generations unused for this long (by modification time) are retired; their logins are retained first. */
export const GENERATION_RETIRE_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** What the server tells retirement about the world; without it a bot's scope is never retired. */
export interface ScopeRetentionHooks {
  /** True while the bot exists (its tasks hold the cursors that point into its scope). */
  botExists?: (botId: string) => boolean;
}
let retentionHooks: ScopeRetentionHooks = {};
export function setScopeRetentionHooks(hooks: ScopeRetentionHooks): void {
  retentionHooks = hooks;
}

/** Owner homes and login names each kind has been scoped for in this process: where a legacy scope's logins are adopted to. */
const knownSpecs = new Map<string, Map<string, { share: readonly string[]; subdir: string }>>();
const legacyHandled = new Set<string>();
/** The spec each scope root was last built from in this process: lets a launch that only names the scope's path refresh its generated copies like a normal build. */
const scopeSpecs = new Map<string, ScopedCliHomeSpec>();

/** How a process that did not build a scope rebuilds the spec of one an environment names (kind -> spec from the marker's owner folder, bot and inputs). */
export interface ScopeReconstructInput { realHome: string; botId?: string; inputs: Record<string, string> }
const reconstructors = new Map<string, (input: ScopeReconstructInput) => ScopedCliHomeSpec>();
export function registerScopeReconstructor(kind: string, build: (input: ScopeReconstructInput) => ScopedCliHomeSpec): void { reconstructors.set(kind, build); }

/** Remove generated copies by name: plain file names only, files only (a link or folder is never the copy), never a shared login. */
function dropOwnedCopies(home: string, names: readonly string[], shared: ReadonlySet<string>, links = false): void {
  for (const name of names) {
    if (!name || name.includes("/") || name.includes("\\") || name === ".." || name === "." || shared.has(name)) continue;
    try {
      const path = join(home, name);
      const stat = lstatSync(path);
      if (stat.isFile() || (links && stat.isSymbolicLink())) unlinkSync(path); // a later generation may hold a carried link to an earlier copy
    } catch (error) {
      // Only a copy that is already gone is fine: one that cannot be removed would keep the owner's old settings in force.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    }
  }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

export const scopeId = (realHome: string, botId?: string): string =>
  createHash("sha256").update(JSON.stringify([realHome, botId ?? null])).digest("hex").slice(0, 16);

const lastTouched = new Map<string, number>();
const lastRetired = new Map<string, number>();
const lastGenerationRetire = new Map<string, number>();
export function resetScopeBookkeeping(): void {
  lastTouched.clear();
  lastRetired.clear();
  lastGenerationRetire.clear();
  legacyHandled.clear();
  knownSpecs.clear();
  scopeSpecs.clear();
}

/** Record a use now, whatever the hourly throttle says (a first build, or a startup that holds the lease). */
function forceTouch(root: string, now: number): void {
  // The use record is a write of the launch path: when it cannot be made the turn retries (a removed scope is rebuilt by that retry).
  try { utimesSync(join(root, SCOPE_MARKER), new Date(now), new Date(now)); } catch (error) { throw new ScopeUnavailableError(BUSY_MESSAGE, true, { cause: error }); }
  lastTouched.set(root, now);
}

function readMarker(root: string): ScopeMarker | null {
  const state = readMarkerState(root);
  return state.kind === "ok" ? state.marker : null;
}

type MarkerState = { kind: "ok"; marker: ScopeMarker } | { kind: "missing" } | { kind: "unreadable" };
/** Told apart: no marker at all (not a scope), and a marker that cannot be read right now (empty, partial, unparsable): the second is never taken for the first. */
function readMarkerState(root: string): MarkerState {
  let text: string;
  try { text = readFileSync(join(root, SCOPE_MARKER), "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { kind: "ok", marker: parsed as ScopeMarker } : { kind: "unreadable" };
  } catch { return { kind: "unreadable" }; }
}
const MARKER_UNREADABLE = (): ScopeUnavailableError => new ScopeUnavailableError(BUSY_MESSAGE, true);

/** Write the whole marker atomically (a temporary file renamed over it): a reader sees the old marker or the new one, never an empty or half one. */
function writeMarkerFile(root: string, marker: ScopeMarker): void {
  const path = join(root, SCOPE_MARKER);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* none */ }
    throw error;
  }
}

/** Bytes under a folder (links not followed), stopping once past `limit` or the entry limit. */
function folderBytes(path: string, limit: number): number {
  let total = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length && total <= limit && seen < WALK_ENTRY_LIMIT) {
    const dir = stack.pop()!;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      seen += 1;
      const child = join(dir, name);
      try {
        const s = lstatSync(child);
        if (s.isDirectory()) stack.push(child);
        else if (s.isFile()) total += s.size;
      } catch { /* gone while walking */ }
    }
  }
  return total;
}

const capWarned = new Set<string>();

/** Take the scope's exclusive lease (a lock file naming this process). False when a live other process holds it. */
function acquireLease(root: string): boolean {
  const file = scopeLockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(ownProcessRecord()), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      try {
        const held = JSON.parse(readFileSync(file, "utf8")) as Partial<ProcessRecord>;
        if (typeof held.pid === "number" && processRunning({ pid: held.pid, id: typeof held.id === "string" ? held.id : null })) return false;
        unlinkSync(file); // its holder is provably gone
      } catch { return false; } // unreadable or racing: in doubt, skip
    }
  }
  return false;
}
function releaseLease(root: string): void {
  try { unlinkSync(scopeLockPath(root)); } catch { /* already gone */ }
}
/** True while another live process holds the prune lease on this scope. */
function leaseHeldByOther(root: string): boolean {
  try {
    const held = JSON.parse(readFileSync(scopeLockPath(root), "utf8")) as Partial<ProcessRecord>;
    return typeof held.pid === "number" && held.pid !== process.pid && processRunning({ pid: held.pid, id: typeof held.id === "string" ? held.id : null });
  } catch { return false; }
}

/** Whether any process may be using the scope's engine state: used within SCOPE_PRUNE_MIN_IDLE_MS, or built by another live server process. */
function scopeInUse(root: string, marker: ScopeMarker, now: number): boolean {
  let used: number;
  try { used = statSync(join(root, SCOPE_MARKER)).mtimeMs; } catch { return true; }
  if (now - used < SCOPE_PRUNE_MIN_IDLE_MS) return true;
  const owner = marker.owner;
  if (owner && typeof owner.pid === "number" && owner.pid !== process.pid) {
    try { if (processRunning({ pid: owner.pid, id: typeof owner.id === "string" ? owner.id : null })) return true; } catch { return true; }
  }
  return false;
}

/**
 * Past SCOPE_MAX_BYTES the scope's declared cache folders go (nothing else). Only a scope no process is using is touched:
 * unused for a day, no other live server process built it, and the exclusive lease taken here. A scope in use, or one
 * where this cannot be established, is left alone (in doubt, skip). Never throws. Returns the folders removed.
 */
export function pruneScopeCache(root: string, maxBytes: number = SCOPE_MAX_BYTES, now: number = Date.now()): string[] {
  const removed: string[] = [];
  let leased = false;
  try {
    const marker = readMarker(root);
    if (!marker || !Array.isArray(marker.cache) || !marker.cache.length) return removed;
    if (scopeInUse(root, marker, now)) return removed;
    if (folderBytes(root, maxBytes) <= maxBytes) return removed;
    if (!(leased = acquireLease(root))) return removed;
    // re-read under the lease: a use that landed in between wins
    const again = readMarker(root);
    if (!again || scopeInUse(root, again, now)) return removed;
    const home = typeof marker.subdir === "string" && marker.subdir ? join(root, marker.subdir) : root;
    const share = new Set(Array.isArray(marker.share) ? marker.share.filter((n): n is string => typeof n === "string") : []);
    for (const name of marker.cache) {
      // only a plain single-segment folder the engine left as cache: never a login name, never a link, never a path out of the home
      if (typeof name !== "string" || !name || name.includes("/") || name.includes("\\") || name === ".." || name === "." || share.has(name)) continue;
      const target = join(home, name);
      try {
        const s = lstatSync(target);
        if (!s.isDirectory()) continue;
        rmSync(target, { recursive: true, force: true });
        removed.push(target);
      } catch { /* absent */ }
    }
    if (folderBytes(root, maxBytes) > maxBytes && !capWarned.has(root)) {
      capWarned.add(root);
      console.warn(`engine state for a bot is over its size cap after pruning its cache (${basename(root)}); conversation data is kept`);
    }
  } catch { /* the cap is best effort */ } finally {
    if (leased) releaseLease(root);
  }
  return removed;
}

let linkIo: LinkIo = nodeLinkIo;
/** For tests: the file operations that share a login with the owner's folder (a symlink that is refused, a volume that is not shared). */
export function setLinkIo(io: LinkIo | null): void { linkIo = io ?? nodeLinkIo; }

let leaseWaitMs = 30_000;
/** For tests: how long a startup waits for another process's prune to finish. */
export function setLeaseWaitMs(ms: number): void { leaseWaitMs = ms; }
const BUSY_MESSAGE = "This bot's engine files are being tidied up right now. Try again in a moment.";
const UNAVAILABLE_MESSAGE = "This bot's engine could not be set up in its own folder, so the turn did not start. Try again in a moment.";
/**
 * Why a bot's own engine folder was not set up. A structured code, never text to show: the chat renders the code through the
 * locale packs (`runtimeError.local.<code>.*`, localSetupFailureOf), the English `message` is for logs and fallbacks.
 *   busy              another process held the folder (retryable)
 *   unavailable       the folder could not be built
 *   update-required   the engine's version is unknown or older than the first one proven to honour its own home setting
 *   symlink-required  the login cannot be shared as one file (no symlink allowed, and a hardlink is not possible for this engine or volume)
 *   config-invalid    the owner's settings file a generated copy is made from cannot be read (the copy is removed, the turn rejected)
 *   login-link-lost   a hardlinked login is no longer the same file as the owner's (nothing is repaired)
 */
export type ScopeFailureCode = "busy" | "unavailable" | "update-required" | "symlink-required" | "login-link-lost" | "config-invalid";
/** A bot turn's own engine folder could not be set up; the turn is rejected before any spawn. */
export class ScopeUnavailableError extends Error {
  readonly code: ScopeFailureCode;
  /** The engine as the owner knows it (its Settings name), for the localized line. */
  engine?: string;
  // Not a constructor parameter property: the server also runs under Node's type-stripping loader, which cannot erase those.
  readonly busy: boolean;
  constructor(message: string, busy: boolean, options?: { cause?: unknown; code?: ScopeFailureCode; engine?: string }) {
    super(message, options);
    this.name = "ScopeUnavailableError";
    this.busy = busy;
    this.code = options?.code ?? (busy ? "busy" : "unavailable");
    if (options?.engine) this.engine = options.engine;
  }
}
/** The structured tag the chat words in the owner's language (shared/provider-error.ts LOCAL_SETUP_FAILURES). */
export function scopeLocalFailureOf(error: ScopeUnavailableError): "engine-folder-busy" | "engine-folder-unavailable" | "engine-update-required" | "engine-symlink-required" | "engine-login-link-lost" | "engine-config-invalid" {
  switch (error.code) {
    case "busy": return "engine-folder-busy";
    case "update-required": return "engine-update-required";
    case "symlink-required": return "engine-symlink-required";
    case "login-link-lost": return "engine-login-link-lost";
    case "config-invalid": return "engine-config-invalid";
    default: return "engine-folder-unavailable";
  }
}
/** The bot's own engine folder could not be set up (not contention): the turn is rejected, the chat says so in the owner's language. */
export function engineFolderUnavailable(engine: string, cause?: unknown): ScopeUnavailableError {
  return new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false, { cause, engine });
}
/** The owner's settings file that a bot's copy is generated from cannot be read: the copy is removed and the turn is rejected rather than run on stale settings. */
export function engineConfigInvalid(engine: string, cause?: unknown, format: "JSON" | "plain" = "JSON"): ScopeUnavailableError {
  const read = format === "JSON" ? "could not be read as valid JSON" : "could not be read";
  return new ScopeUnavailableError(`${engine}'s settings file ${read}, so the bot's copy of it was removed and the turn did not start. Fix or remove the file, then try again.`, false, { code: "config-invalid", engine, cause });
}
/** An engine whose version is unknown (the probe failed twice) or older than the first proven one: the turn is rejected and the owner is told to update it. */
export function engineUpdateRequired(engine: string, found: string | undefined, min: readonly number[]): ScopeUnavailableError {
  return new ScopeUnavailableError(
    `${engine} ${found ? `version ${found} is older than` : "has no readable version; it must be at least"} ${min.join(".")}, the first one that keeps a bot's engine files in the bot's own folder. Update ${engine}, then try again.`,
    false, { code: "update-required", engine });
}
let scopeRetryBoundMs = 10_000;
/** For tests: how long a turn keeps retrying a busy engine folder before it is rejected. */
export function setScopeRetryBoundMs(ms: number): void { scopeRetryBoundMs = ms; }
/**
 * Run a synchronous scope setup for a turn, failing closed: contention is retried with backoff within a bound, and a scope
 * that still cannot be established rejects the turn (ScopeUnavailableError) instead of letting the engine start in the
 * owner's own home. Any other failure rejects at once.
 */
export async function withScopeRetry<T>(setup: () => T, engine?: string): Promise<T> {
  const deadline = Date.now() + scopeRetryBoundMs;
  let delay = 50;
  for (;;) {
    try { return setup(); } catch (error) {
      if (error instanceof ScopeUnavailableError && engine) error.engine = engine;
      if (error instanceof ScopeUnavailableError && error.busy) {
        if (Date.now() >= deadline) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 1_000);
        continue;
      }
      if (error instanceof ScopeUnavailableError) throw error;
      throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false, { cause: error, ...(engine ? { engine } : {}) });
    }
  }
}
/** True while another live process is pruning any scope of this engine. */
function pruneInProgress(kind: string): boolean {
  const parent = scopedCliHomeRoot(kind);
  try { return readdirSync(parent).some((name) => !name.startsWith(".") && leaseHeldByOther(join(parent, name))); } catch { return false; }
}
/**
 * Engine startup and pruning are mutually exclusive. Await this on the turn path before building a scope: it returns at once
 * unless another live process is pruning, then waits (asynchronously, bounded) and calls `onWaiting` once so the turn can show
 * it is preparing. It rejects if the prune does not finish; the synchronous build below never hands out a scope mid-prune.
 */
export async function awaitScopeStart(kind: string, onWaiting?: () => void, engine?: string): Promise<void> {
  if (!pruneInProgress(kind)) return;
  try { onWaiting?.(); } catch { /* a notice is a nicety */ }
  const deadline = Date.now() + leaseWaitMs;
  while (pruneInProgress(kind)) {
    if (Date.now() >= deadline) throw new ScopeUnavailableError(BUSY_MESSAGE, true, engine ? { engine } : undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}

// ---- Login generations -------------------------------------------------------------------------------------------------
// A login shared with the owner as a HARDLINK (a symlink is not allowed) is one file under two names, and it stops being one
// file when the owner's tool replaces theirs by rename. An engine process started on the scope keeps writing the login by the
// path it was given, in place, for as long as it lives, and Murage cannot know which processes those are. So the scope's login
// files live in a GENERATION: generation 0 is the scope root itself, generation N is `login-g<N>` under it, and an engine is
// launched with the CURRENT generation's path (CODEX_HOME, GROK_HOME ... point at it). A running process keeps its path forever.
// When the current generation's login is no longer the owner's file, the generation is NEVER repaired, moved or relinked
// (a process may still write it): a new generation is made, linked to the owner's current login, the marker's `generation`
// pointer is switched in one atomic rename, and the next launch uses the new path. The older generation, with whatever its
// processes wrote into it, is the preserved copy. Everything else of the scope (sessions, config, caches) is carried into a
// generation as links to the earlier one, so the bot's conversation state is one state whichever generation runs.
// An older generation is retired only with its scope, or after GENERATION_RETIRE_MAX_AGE_MS unused, and its logins are
// retained in the quarantine first.
const GEN_DIR = /^login-g(\d+)$/;
const generationOf = (marker: ScopeMarker | null): number => {
  const g = marker?.generation;
  return typeof g === "number" && Number.isInteger(g) && g > 0 ? g : 0;
};
const generationRoot = (root: string, n: number): string => (n > 0 ? join(root, `${GENERATION_PREFIX}${n}`) : root);
const subdirOf = (marker: ScopeMarker): string => (typeof marker.subdir === "string" ? marker.subdir : "");
const validLoginName = (name: unknown): name is string =>
  typeof name === "string" && Boolean(name) && !name.includes("/") && !name.includes("\\") && name !== ".." && name !== ".";
/** Generations present under a scope root, newest first. */
function generationsOnDisk(root: string): number[] {
  try {
    return readdirSync(root).flatMap((name) => { const m = GEN_DIR.exec(name); return m ? [Number(m[1])] : []; }).sort((a, b) => b - a);
  } catch { return []; }
}
/** The scope root of a path that is a scope's engine home (the root itself or one of its generations). */
const scopeRootOfPath = (path: string): string => (GEN_DIR.test(basename(path)) ? dirname(path) : path);

/** Names that belong to the scope's bookkeeping, never carried into a generation. */
const bookkeeping = (name: string): boolean =>
  name === SCOPE_MARKER || name.startsWith(`${SCOPE_MARKER}.`) || name === LOGIN_ASIDE_DIR || name.startsWith(`.${GENERATION_PREFIX}`) || GEN_DIR.test(name);

/** One entry of an earlier generation, linked into a newer one: a symlink to where the entry really is (a directory junction on
 *  Windows without symlink rights); a file falls back to a hardlink, then a copy. False when the source is gone. */
function carryEntry(source: string, dest: string): boolean {
  let target = source;
  try {
    if (lstatSync(source).isSymbolicLink()) target = resolve(dirname(source), readlinkSync(source));
    const isDir = statSync(target).isDirectory();
    try { symlinkSync(target, dest, isDir ? "junction" : "file"); return true; } catch { /* no symlink rights */ }
    if (isDir) return false;
    try { linkSync(target, dest); return true; } catch { /* another volume */ }
    copyFileSync(target, dest);
    return true;
  } catch { return false; }
}

/** Make `dest` carry every entry of the earlier folders (newest first) that it does not have: login names and bookkeeping are
 *  its own. A link whose target is gone is removed. Never touches the earlier folders. */
function carryInto(sources: readonly string[], dest: string, skip: (name: string) => boolean): void {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const have = new Set<string>();
  for (const name of readdirSync(dest)) {
    have.add(name);
    if (skip(name)) continue;
    const path = join(dest, name);
    try {
      if (lstatSync(path).isSymbolicLink()) { try { statSync(path); } catch { unlinkSync(path); have.delete(name); } }
    } catch { /* gone */ }
  }
  for (const source of sources) {
    let names: string[] = [];
    try { names = readdirSync(source); } catch { continue; }
    for (const name of names) {
      if (have.has(name) || skip(name)) continue;
      if (carryEntry(join(source, name), join(dest, name))) have.add(name);
    }
  }
}

/** Carry the scope's state into generation `n` (a folder at `destRoot`): from every earlier generation and the scope root. */
function carryGeneration(root: string, destRoot: string, n: number, subdir: string, loginNames: ReadonlySet<string>, generatedNames: ReadonlySet<string> = new Set(), copyNames: ReadonlySet<string> = new Set(), deletedNames: ReadonlySet<string> = new Set(), committed: number = n - 1): void {
  // Only generations the marker's pointer has committed are sources: a generation above the pointer (left by a pointer write that failed) is never read.
  const earlier = [...generationsOnDisk(root).filter((g) => g < n && g <= committed).map((g) => generationRoot(root, g)), root];
  // Generated copies are the generation's OWN files (never links to an earlier generation's, which a hardlink or copy could not follow
  // when the owner's source is removed or recreated): the nearest earlier copy is copied in, and every build rewrites or removes it here.
  // A generated name the owner removed is never carried or copied in from an older generation (which still holds its last copy).
  const skipped = (name: string) => bookkeeping(name) || loginNames.has(name) || generatedNames.has(name) || deletedNames.has(name);
  const homes = subdir ? earlier.map((dir) => join(dir, subdir)) : earlier;
  const dest = subdir ? join(destRoot, subdir) : destRoot;
  if (subdir) carryInto(earlier, destRoot, (name) => bookkeeping(name) || name === subdir);
  carryInto(homes, dest, skipped);
  // A generated copy comes from the COMMITTED current generation only (the build just refreshed it from the owner's source), never from an
  // older or uncommitted one, and a copy that cannot be made rejects the launch (retryable): there is no fallback to an older copy.
  const currentHome = subdir ? join(generationRoot(root, committed), subdir) : generationRoot(root, committed);
  for (const name of copyNames) {
    if (!validLoginName(name) || deletedNames.has(name)) continue;
    try {
      if (!lstatSync(join(currentHome, name)).isFile()) continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue; // the current generation holds none: nothing to carry
      throw new ScopeUnavailableError(BUSY_MESSAGE, true, { cause: error });
    }
    if (present(join(dest, name))) continue;
    try { copyFileSync(join(currentHome, name), join(dest, name)); } catch (error) { throw new ScopeUnavailableError(BUSY_MESSAGE, true, { cause: error }); }
  }
}

/** The scoped home for `spec`, built or refreshed when the owner's folder changed: the path an engine is launched with (the
 *  scope's CURRENT login generation). Throws when it cannot be built. */
export function scopedCliHome(spec: ScopedCliHomeSpec, now: number = Date.now()): string {
  return scopeSession(spec, now, true).home;
}

/** The scope root for `spec`, built or refreshed, with no generation resolved: for a caller that memoizes the scope and resolves
 *  the launch path per turn with `scopeEngineHome`. */
export function scopedCliRoot(spec: ScopedCliHomeSpec, now: number = Date.now()): string {
  return scopeSession(spec, now, false).home;
}

/** The path to launch an engine with on a built scope: the current generation, moved to a new one when the shared login split. */
export function scopeEngineHome(kind: string, root: string, now: number = Date.now()): string {
  const home = engineHomeLocked(kind, root, now, false);
  if (home === null) throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false);
  return home;
}

/** The marker is read, the logins verified and the use recorded under ONE lease, so a build that rewrites the marker is never seen half
 *  done. An unreadable marker rejects (busy: the turn retries within its bound); it is never taken for "not a scope". Null only for
 *  `mustBeScope` and a folder that has no marker at all. */
function engineHomeLocked(kind: string, root: string, now: number, mustBeScope: boolean): string | null {
  // A scope this process built from a spec is refreshed like any build before its path is resolved (its generated copies follow the
  // owner's sources, so a rotation here never carries a stale copy); the build takes the lease itself.
  let spec = scopeSpecs.get(root);
  if (!spec) {
    // A scope another process (or an earlier run) built: its generated copies are refreshed from the owner's current source like the builder
    // does, by rebuilding the spec from the marker. A scope that generates copies and cannot be rebuilt is rejected (retryable), never launched on a stale copy.
    const state = readMarkerState(root);
    if (state.kind === "unreadable") throw MARKER_UNREADABLE();
    if (state.kind === "ok") spec = reconstructSpec(kind, root, state.marker) ?? undefined;
  }
  if (spec) {
    if (mustBeScope && readMarkerState(root).kind === "missing") return null;
    return scopeSession(spec, now, true).home;
  }
  if (!acquireLease(root)) throw new ScopeUnavailableError(BUSY_MESSAGE, true);
  let home: string;
  try {
    if (mustBeScope && readMarkerState(root).kind === "missing") return null;
    home = verifyScopeLogins(root, kind, now);
    forceTouch(root, now);
  } finally { releaseLease(root); }
  noteScopeUse(kind, root, now);
  return home;
}

/** The spec a scope was built from, rebuilt from its marker; null when the scope generates no copies (nothing to refresh). Throws (retryable) when it generates copies and cannot be rebuilt. */
function reconstructSpec(kind: string, root: string, marker: ScopeMarker): ScopedCliHomeSpec | null {
  const generatedNames = Array.isArray(marker.generated) ? marker.generated : [];
  if (marker.generates !== true && generatedNames.length === 0) return null;
  const build = reconstructors.get(kind);
  const inputs: Record<string, string> = {};
  if (marker.rebuildInputs && typeof marker.rebuildInputs === "object") {
    for (const [key, value] of Object.entries(marker.rebuildInputs as Record<string, unknown>)) if (typeof value === "string") inputs[key] = value;
  }
  if (!build || marker.generates !== true || typeof marker.realHome !== "string") throw new ScopeUnavailableError(BUSY_MESSAGE, true);
  const spec = build({ realHome: marker.realHome, ...(typeof marker.botId === "string" ? { botId: marker.botId } : {}), inputs });
  // The rebuilt spec must be the very scope that was named.
  if (spec.kind !== kind || join(scopedCliHomeRoot(kind), scopeId(spec.realHome, spec.botId)) !== root) throw new ScopeUnavailableError(BUSY_MESSAGE, true);
  return spec;
}

/** An engine home an environment already names (a probe's shared scope, a nested launch): the same scope's CURRENT generation,
 *  resolved at this launch. Null when the path is not a scope of this engine; a scope whose marker cannot be read rejects. */
export function currentScopeHome(kind: string, path: string, now: number = Date.now()): string | null {
  const parent = scopedCliHomeRoot(kind);
  const rel = relative(parent, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const id = rel.split(sep)[0]!;
  if (!id || id.startsWith(".")) return null;
  const root = join(parent, id);
  try { if (!statSync(root).isDirectory()) return null; } catch { return null; }
  return engineHomeLocked(kind, root, now, true);
}

/** Write a generated copy by renaming a temporary file over the name: a link or hardlink at that name is replaced, never written through
 *  (nor a link planted at the temporary name: it is removed first and the file is created exclusively). */
function replaceGenerated(path: string, text: string): void {
  const temporary = `${path}.murage-tmp-${process.pid}`;
  try {
    try { unlinkSync(temporary); } catch { /* none */ }
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* none */ }
    throw error;
  }
}

/**
 * FUIGO-SCOPE-1010 G2: every folder from DATA_DIR/native down to `path` must be a real directory this process owns. A bot at
 * Auto or above can `mv` its own engine home aside and link the owner's real one (~/.fuigo, ~/.grok) in its place; a build that
 * followed that link would write the marker, the lock and the generated config into the owner's home and start the engine there.
 * Checked with lstat, component by component, so no link is ever followed. A link (or junction) at the scope folder or below it is
 * removed (the link only, never its target) when `repair` is set, and the scope is then rebuilt from nothing; anything else that
 * is not a directory we own (a file, another user's folder, a link above the scope folder) refuses the turn.
 */
export function assertOwnedScopeChain(path: string, repair: boolean): void {
  const top = join(DATA_DIR, "native");
  const rel = relative(top, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let current = top;
  const parts = rel === "" ? [] : rel.split(sep);
  for (let depth = 0; depth <= parts.length; depth++) {
    if (depth > 0) current = join(current, parts[depth - 1]!);
    let stat;
    try { stat = lstatSync(current); } catch { return; } // absent: everything below it is made fresh by mkdir
    if (stat.isSymbolicLink()) {
      if (!repair || depth === 0) throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, true);
      try { unlinkSync(current); } catch { try { rmdirSync(current); } catch (error) { throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false, { cause: error }); } }
      console.warn(`[scope] a link stood where a bot's engine folder belongs and was removed; the folder is rebuilt: ${current}`);
      return;
    }
    if (!stat.isDirectory() || (uid !== null && stat.uid !== uid)) throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false);
  }
}

/** The generated copies each build last wrote, by scope root: checked against the disk before every launch (A2). */
const lastGenerated = new Map<string, { base: string; files: Record<string, string> }>();

/**
 * FUIGO-SCOPE-1010 A2: a generated copy is security-critical (the bot's `[permission]` table), and the build cache tracks only the
 * folder and the owner's sources, so a bot that rewrote the copy in place would keep its edit across cached launches. Before every
 * launch each copy must still be a regular file (not a link) holding exactly what the build wrote; one that is not is replaced.
 */
function restoreGenerated(root: string): void {
  const last = lastGenerated.get(root);
  if (!last) return;
  for (const [name, text] of Object.entries(last.files)) {
    const path = join(last.base, name);
    let same = false;
    try { same = lstatSync(path).isFile() && readFileSync(path, "utf8") === text; } catch { /* absent or unreadable: written below */ }
    if (!same) replaceGenerated(path, text);
  }
}

function scopeSession(spec: ScopedCliHomeSpec, now: number, resolveGeneration: boolean): { root: string; home: string } {
  const id = scopeId(spec.realHome, spec.botId);
  const root = join(scopedCliHomeRoot(spec.kind), id);
  let specs = knownSpecs.get(spec.kind);
  if (!specs) knownSpecs.set(spec.kind, (specs = new Map()));
  specs.set(spec.realHome, { share: spec.share, subdir: spec.subdir ?? "" });
  scopeSpecs.set(root, spec);
  // Never hand out a scope another process is deleting from, cached or not. Turn paths await awaitScopeStart first.
  // Not just a check: the exclusive lease is TAKEN here and held until the scope is built and its use recorded, so a pruner
  // cannot start (its own acquire fails) between "nobody is pruning" and "this scope is in use".
  assertOwnedScopeChain(root, true); // G2: never a link anywhere from DATA_DIR/native to the scope folder
  mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
  if (!acquireLease(root)) throw new ScopeUnavailableError(BUSY_MESSAGE, true);
  let result: string;
  let home: string;
  try {
  result = memoDeps(`${spec.kind}-scope`, id, () => {
    const base = spec.subdir ? join(root, spec.subdir) : root;
    assertOwnedScopeChain(base, true);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const state = readMarkerState(root);
    if (state.kind === "unreadable") throw MARKER_UNREADABLE(); // another process is rewriting it, or it is damaged: never rebuilt over, the turn retries
    const earlier = state.kind === "ok" ? state.marker : null;
    const generation = generationOf(earlier);
    // The generated copies live in the CURRENT generation's own home (a later generation is not a link into generation 0's).
    const genRoot = generationRoot(root, generation);
    const genBase = spec.subdir ? join(genRoot, spec.subdir) : genRoot;
    assertOwnedScopeChain(genBase, true);
    if (generation > 0) mkdirSync(genBase, { recursive: true, mode: 0o700 });
    // An established generation (an engine was launched on it) never has a login created or relinked in place: a process may hold it.
    const established = earlier?.launched === true; // the marker below declares the scope launched: every build is for a launch
    const earlierModes = earlier?.shareMode && typeof earlier.shareMode === "object" ? earlier.shareMode as Record<string, unknown> : {};
    const shareMode: Record<string, LinkMode> = {};
    const earlierGenerated = Array.isArray(earlier?.generated) ? (earlier.generated as unknown[]).filter((n): n is string => typeof n === "string") : [];
    const earlierDeleted = Array.isArray(earlier?.deletedGenerated) ? (earlier.deletedGenerated as unknown[]).filter((n): n is string => typeof n === "string") : [];
    let generated: Record<string, string>;
    try { generated = spec.generated?.() ?? {}; } catch (error) {
      // The owner's source cannot be used (a config that does not parse): the copies of it made earlier are removed, never left in force,
      // and recorded as deleted so no rotation brings an older generation's copy back.
      dropOwnedCopies(genBase, earlierGenerated, new Set(spec.share), generation > 0);
      try { writeMarker(root, (m) => { m.deletedGenerated = [...new Set([...earlierDeleted, ...earlierGenerated])]; }); } catch { /* the turn is rejected below either way */ }
      throw error;
    }
    // A copy whose source is gone (the owner deleted the config) is removed too: only files an earlier build generated, never the engine's own.
    dropOwnedCopies(genBase, earlierGenerated.filter((name) => !(name in generated)), new Set(spec.share), generation > 0);
    // The durable deletion record: every name removed so far and not recreated since. Every carry and rotation excludes these.
    const deleted = [...new Set([...earlierDeleted, ...earlierGenerated.filter((name) => !(name in generated))])].filter((name) => !(name in generated));
    // Recorded as dependencies, so the scope is rebuilt when the owner's folder or one of its logins appears.
    const realFolder = pathExists(spec.realHome);
    for (const name of spec.share) {
      if (name in generated) continue;
      const scoped = join(base, name);
      const real = join(spec.realHome, name);
      pathExists(real);
      const prior = earlierModes[name];
      // Once the scope has moved to a later generation, generation 0's login is the preserved older copy: never linked or touched here.
      if (generation > 0) { shareMode[name] = prior === "hardlink" || prior === "symlink" || prior === "absent" ? prior : "symlink"; continue; }
      // Already there: our link, or a login the engine wrote in the scope (handed to the owner's folder when the scope retires, never overwriting theirs).
      if (present(scoped) || established) {
        // An established generation with a missing login is not repaired here: the launch check (verifyScopeLogins) starts a new generation.
        shareMode[name] = prior === "hardlink" || prior === "symlink" || prior === "absent" ? prior : "symlink";
        continue;
      }
      if (spec.linkOnlyWithFolder && !realFolder) { shareMode[name] = "absent"; continue; }
      try {
        shareMode[name] = linkSharedEntry(real, scoped, linkIo, { hardlinkOk: spec.loginWrites === "in-place", lock: (spec.locks ?? []).includes(name) });
      } catch (error) {
        if (error instanceof LoginLinkUnavailableError) throw new ScopeUnavailableError(error.message, false, { code: "symlink-required", cause: error });
        throw error;
      }
    }
    try {
      const marker: ScopeMarker = { contract: SESSION_CONTRACT, realHome: spec.realHome, botId: spec.botId ?? null, subdir: spec.subdir ?? "", share: spec.share, cache: spec.cache ?? [], locks: spec.locks ?? [], loginWrites: spec.loginWrites ?? "replace", shareMode, generated: Object.keys(generated), deletedGenerated: deleted, generates: Boolean(spec.generated), rebuildInputs: spec.rebuildInputs ?? {}, owner: ownProcessRecord(), ...(generation > 0 ? { generation } : {}), launched: true, ...(earlier?.launchedAt && typeof earlier.launchedAt === "object" ? { launchedAt: earlier.launchedAt } : {}) };
      writeMarkerFile(root, marker);
    } catch (error) {
      // Never launch on a scope whose launched flag, generation pointer or logins mode was not persisted: the next build would see it as unlaunched and relink in place.
      throw new ScopeUnavailableError(BUSY_MESSAGE, true, { cause: error });
    }
    if (generation > 0) {
      // the current generation follows the scope's state: new entries of the earlier folders are carried in
      const loginNames = new Set(spec.share.filter((n) => !(n in generated)));
      carryGeneration(root, genRoot, generation, spec.subdir ?? "", loginNames, new Set([...Object.keys(generated), ...earlierGenerated]), new Set(), new Set(deleted)); // written (or removed) below, never carried
    }
    // The generated copies follow the owner's source: written by replacing the file (never through a link or a hardlink that an earlier
    // generation or the owner shares), so a removal or recreation of the source reaches the current generation too.
    assertOwnedScopeChain(genBase, false);
    for (const [name, text] of Object.entries(generated)) replaceGenerated(join(genBase, name), text);
    lastGenerated.set(root, { base: genBase, files: generated });
    pathExists(base); // a removed scope is rebuilt on the next turn
    return root;
  });
  // A login shared as a hardlink (no symlink allowed) must still be ONE file with the owner's before the engine starts.
  // When it is not, the scope moves to a new generation (the older one is left exactly as it is).
  home = resolveGeneration ? verifyScopeLogins(result, spec.kind, now) : result;
  // G2 and A2, on every call (a cached build included): the folder launched is still ours, and its generated copies are the build's.
  assertOwnedScopeChain(home, false);
  restoreGenerated(result);
  // the use record (marker mtime) is written while the lease is still ours
  forceTouch(result, now);
  } finally { releaseLease(root); }
  noteScopeUse(spec.kind, result, now);
  return { root: result, home };
}

const statOrNull = (path: string, follow: boolean) => {
  try { return follow ? linkIo.statSync(path) : linkIo.lstatSync(path); } catch { return null; }
};

/** Rewrite the marker atomically (a temporary file renamed over it): a reader sees the old marker or the new one, never half of one.
 *  The marker's mtime is the scope's last use and is kept. */
function writeMarker(root: string, change: (marker: ScopeMarker) => void): void {
  const marker = readMarker(root);
  if (!marker) throw new ScopeUnavailableError(BUSY_MESSAGE, true); // nothing to persist into: never launch on a pointer that was not saved
  change(marker);
  const path = join(root, SCOPE_MARKER);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    let before: { atime: Date; mtime: Date } | null = null;
    try { before = statSync(path); } catch { /* none */ }
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temporary, path);
    if (before) utimesSync(path, before.atime, before.mtime);
  } catch {
    try { unlinkSync(temporary); } catch { /* none */ }
    throw new ScopeUnavailableError(BUSY_MESSAGE, true);
  }
}

/** True when a symlink in the scope still leads to the owner's login: it points at the owner's path (even before that file exists), or resolves to the same file. */
function symlinkFollowsOwner(real: string, scoped: string, owner: { ino: number | bigint; dev: number | bigint } | null): boolean {
  try {
    const target = linkIo.readlinkSync ? linkIo.readlinkSync(scoped) : readlinkSync(scoped);
    if (resolve(dirname(scoped), target) === resolve(real)) return true;
  } catch { /* unreadable link: compared by file id below */ }
  const through = statOrNull(scoped, true);
  return Boolean(owner && through && through.ino && through.ino === owner.ino && through.dev === owner.dev);
}

const loginLost = (name: string): ScopeUnavailableError =>
  new ScopeUnavailableError(`The login ${name} in this bot's engine folder is no longer the same file as the owner's, so the turn did not start.`, false, { code: "login-link-lost" });

/**
 * Logins the scope shares as a hardlink (a symlink was not allowed): each must still be the SAME file as the owner's (file id and
 * device) in the CURRENT generation. When one is not, the generation is left exactly as it is (an engine process on it may still
 * write its login in place; whatever it writes stays in that generation) and a NEW generation is made, linked to the owner's
 * current login (a symlink where one can now be made), and the scope's current-generation pointer is switched atomically. The
 * engine is launched on the new generation, and the idle engines of the old one are drained. The owner signed out (no file to
 * link to) makes no generation: the turn is rejected with the sign-in message (login-link-lost) and recovers once they sign in.
 * Returns the engine home to launch with. Symlinked logins need nothing. Caller holds the scope's lease.
 */
export function verifyScopeLogins(root: string, kind = basename(dirname(root)).replace(/-scope$/, ""), now: number = Date.now()): string {
  const state = readMarkerState(root);
  if (state.kind === "unreadable") throw MARKER_UNREADABLE();
  const marker = state.kind === "ok" ? state.marker : null;
  const current = generationOf(marker);
  const engineRoot = generationRoot(root, current);
  if (!marker || typeof marker.realHome !== "string" || !Array.isArray(marker.share)) return engineRoot;
  const modes = marker.shareMode && typeof marker.shareMode === "object" ? marker.shareMode as Record<string, unknown> : {};
  const locks = new Set(Array.isArray(marker.locks) ? marker.locks : []);
  const generated = new Set(Array.isArray(marker.generated) ? marker.generated : []);
  const home = subdirOf(marker) ? join(engineRoot, subdirOf(marker)) : engineRoot;
  // Established: an engine was launched on this generation (a later generation always was). A process may hold its logins by path, so
  // a login that is missing or split in it is never created, relinked or repaired there: a new generation is made.
  const established = marker.launched === true || current > 0;
  if (current > 0) { try { mkdirSync(home, { recursive: true, mode: 0o700 }); } catch { /* the engine makes it */ } }
  for (const name of marker.share as unknown[]) {
    if (!validLoginName(name) || locks.has(name) || generated.has(name)) continue;
    const mode = modes[name];
    const real = join(marker.realHome, name);
    const scoped = join(home, name);
    const scopedStat = statOrNull(scoped, false);
    const owner = statOrNull(real, true);
    if (mode === "hardlink") {
      // A symlink here is held to the same rule as in any mode: it must lead to the owner's CURRENT login (sharesFile alone takes any link).
      if (scopedStat?.isSymbolicLink()) {
        if (symlinkFollowsOwner(real, scoped, owner)) continue;
        if (!owner) throw loginLost(name);
        return startGeneration(root, marker, kind, current, now);
      }
      if (sharesFile(real, scoped, linkIo)) continue;
      if (!owner && !scopedStat) { if (established) throw loginLost(name); continue; } // both gone: nothing to read
      if (!owner) throw loginLost(name); // the owner is signed out: nothing to link to; rejected until they sign in
      return startGeneration(root, marker, kind, current, now);
    }
    if (!established) continue; // nothing launched yet
    if (!scopedStat) {
      // missing in an established generation: a new generation linked to the owner's current login, or a rejection when there is none
      if (!owner) { if (mode === "absent") continue; throw loginLost(name); }
      return startGeneration(root, marker, kind, current, now);
    }
    // Present: its identity is checked in EVERY mode (symlink, absent, or a file the engine wrote), never taken on trust.
    if (scopedStat.isSymbolicLink()) {
      if (symlinkFollowsOwner(real, scoped, owner)) continue;
      if (!owner) throw loginLost(name); // a detached link and no owner login to move to: the stale login is never launched with
      return startGeneration(root, marker, kind, current, now);
    }
    if (owner && Boolean(scopedStat.ino) && scopedStat.ino === owner.ino && scopedStat.dev === owner.dev) continue; // still the owner's file
    if (!owner) { if (mode === "absent") continue; throw loginLost(name); } // a login the engine wrote while the owner had none is the bot's own; any other mode lost its link
    return startGeneration(root, marker, kind, current, now); // a different file from the owner's: a split
  }
  return engineRoot;
}

/** Make generation `max + 1`: every shared login linked to the owner's current file, the scope's other state carried in. Never writes the older ones. */
function startGeneration(root: string, marker: ScopeMarker, kind: string, current: number, now: number): string {
  const realHome = marker.realHome as string;
  const subdir = subdirOf(marker);
  const generated = new Set(Array.isArray(marker.generated) ? marker.generated.filter((n): n is string => typeof n === "string") : []);
  const locks = new Set(Array.isArray(marker.locks) ? marker.locks : []);
  const deleted = new Set(Array.isArray(marker.deletedGenerated) ? marker.deletedGenerated.filter((n): n is string => typeof n === "string") : []);
  const earlierModes = marker.shareMode && typeof marker.shareMode === "object" ? marker.shareMode as Record<string, unknown> : {};
  const loginNames = new Set((marker.share as unknown[]).filter(validLoginName).filter((n) => !generated.has(n)));
  retireOrphanGenerations(root, marker, current);
  const next = Math.max(current, ...generationsOnDisk(root)) + 1;
  const temporary = join(root, `.${GENERATION_PREFIX}${next}.tmp-${process.pid}`);
  if (!temporary.startsWith(`${root}${sep}`)) throw new ScopeUnavailableError(UNAVAILABLE_MESSAGE, false);
  const finalRoot = generationRoot(root, next);
  // the scope's last use is when the generation it leaves was last launched on
  let lastUse = now;
  try { lastUse = statSync(join(root, SCOPE_MARKER)).mtimeMs; } catch { /* now */ }
  try {
    rmSync(temporary, { recursive: true, force: true }); // only this process's own leftover of an earlier attempt
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const home = subdir ? join(temporary, subdir) : temporary;
    carryGeneration(root, temporary, next, subdir, loginNames, generated, generated, deleted, current);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const shareMode: Record<string, LinkMode> = {};
    for (const name of loginNames) {
      shareMode[name] = linkSharedEntry(join(realHome, name), join(home, name), linkIo, {
        hardlinkOk: marker.loginWrites === "in-place" || earlierModes[name] === "hardlink",
        lock: locks.has(name),
      });
      if (shareMode[name] === "hardlink" && !sharesFile(join(realHome, name), join(home, name), linkIo)) throw loginLost(name);
    }
    renameSync(temporary, finalRoot);
    writeMarker(root, (m) => { m.generation = next; m.launched = true; m.launchedAt = { ...(m.launchedAt && typeof m.launchedAt === "object" ? m.launchedAt as Record<string, unknown> : {}), [String(current)]: lastUse }; m.shareMode = { ...(m.shareMode && typeof m.shareMode === "object" ? m.shareMode as Record<string, unknown> : {}), ...shareMode }; });
  } catch (error) {
    try { rmSync(temporary, { recursive: true, force: true }); } catch { /* left for the next attempt */ }
    if (error instanceof LoginLinkUnavailableError) throw new ScopeUnavailableError(error.message, false, { code: "symlink-required", cause: error });
    throw error;
  }
  try { loginSplitHook?.({ kind, botId: typeof marker.botId === "string" ? marker.botId : null }); } catch { /* draining is best effort */ }
  return finalRoot;
}

/** The owner folder a scope was built from (its marker's realHome), or null for a folder that is not a Murage scope. Takes the scope root or one of its generations. */
export function scopeSourceOf(root: string): string | null {
  const marker = readMarker(scopeRootOfPath(root));
  return marker && typeof marker.realHome === "string" ? marker.realHome : null;
}

/** A scope was used this turn: its last-use time moves (at most hourly), earlier Gemini scopes' logins are adopted once, and unused ones are retired. For a caller that memoizes around scopedCliHome. */
export function noteScopeUse(kind: string, root: string, now: number = Date.now()): void {
  // A cached scope's use record moves under the same lease a build takes; when it cannot be taken, a pruner is at work: say so.
  if (now - (lastTouched.get(root) ?? 0) >= TOUCH_EVERY_MS) {
    if (!acquireLease(root)) throw new ScopeUnavailableError(BUSY_MESSAGE, true);
    try { forceTouch(root, now); } finally { releaseLease(root); }
  }
  // Old generations are retired on their own schedule: a scope touched every turn (forceTouch) must still retire what it has outgrown.
  if (now - (lastGenerationRetire.get(root) ?? 0) >= TOUCH_EVERY_MS && acquireLease(root)) {
    lastGenerationRetire.set(root, now);
    try { retireOldGenerations(root, now); } finally { releaseLease(root); }
  }
  adoptLegacyScopes(kind, root);
  retireScopes(kind, root, now);
}

const scopeNames = (parent: string, keepRoot: string): string[] => {
  try {
    return readdirSync(parent).filter((name) => !name.startsWith(".")).map((name) => join(parent, name)).filter((path) => path !== keepRoot);
  } catch { return []; }
};

const isLegacyGeminiScope = (path: string): boolean => {
  try { return lstatSync(join(path, LEGACY_GEMINI_MARKER)).isFile(); } catch { return false; }
};

/** Move a scope aside instead of deleting what Murage cannot place. Never throws. */
function quarantine(parent: string, path: string, now: number): boolean {
  try {
    const dir = join(parent, SCOPE_QUARANTINE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    renameSync(path, join(dir, `${basename(path)}-${now}`));
    return true;
  } catch { return false; }
}

/** Earlier Gemini scopes (content-addressed, `.gemini/.murage-scope`) keep their logins: adopted once per process, before anything can retire them. */
function adoptLegacyScopes(kind: string, keepRoot: string): void {
  const parent = scopedCliHomeRoot(kind);
  if (legacyHandled.has(parent)) return;
  legacyHandled.add(parent);
  for (const path of scopeNames(parent, keepRoot)) {
    if (isLegacyGeminiScope(path) && !readMarker(path)) adoptLogins(kind, path, null);
  }
}

/** Retire this engine's unused scopes (at most once an hour per process). Never throws.
 *  Kept, always: the scope of a bot that still exists (its tasks hold cursors into it), one a live
 *  other server process built, and any used in the last day. Scopes it cannot place are quarantined. */
export function retireScopes(kind: string, keepRoot: string, now: number = Date.now(), force = false): string[] {
  const parent = scopedCliHomeRoot(kind);
  if (!force && now - (lastRetired.get(parent) ?? 0) < TOUCH_EVERY_MS) return [];
  lastRetired.set(parent, now);
  const retired: string[] = [];
  try {
    const scopes = scopeNames(parent, keepRoot).flatMap((path) => {
      try {
        const s = statSync(path);
        if (!s.isDirectory()) return [];
        const marker = readMarker(path);
        let used = s.mtimeMs;
        try { used = statSync(join(path, SCOPE_MARKER)).mtimeMs; } catch { /* no marker: the folder's time */ }
        return [{ path, used, marker, legacy: !marker && isLegacyGeminiScope(path) }];
      } catch { return []; }
    }).sort((a, b) => b.used - a.used);
    // keepRoot counts toward the limit
    scopes.forEach((scope, index) => {
      const idle = now - scope.used;
      if (idle < SCOPE_RETIRE_MIN_IDLE_MS) return;
      if (!scope.marker && !scope.legacy) { quarantine(parent, scope.path, now); return; } // not ours to place
      if (scope.marker && scopeProtected(scope.marker)) {
        pruneScopeCache(scope.path, SCOPE_MAX_BYTES, now);
        if (acquireLease(scope.path)) { try { retireOldGenerations(scope.path, now); } finally { releaseLease(scope.path); } }
        return;
      }
      if (idle >= SCOPE_RETIRE_MAX_AGE_MS || index + 1 >= SCOPE_RETIRE_MAX_COUNT) {
        try {
          if (!adoptLogins(kind, scope.path, scope.marker)) return; // a login that could not be placed keeps the scope
          rmSync(scope.path, { recursive: true, force: true });
          retired.push(scope.path);
        } catch { /* kept until the next pass */ }
      } else if (scope.marker) pruneScopeCache(scope.path, SCOPE_MAX_BYTES, now); // idle a day, not retiring: its cache may be pruned
    });
  } catch { /* no scopes yet */ }
  enforceQuarantineBounds(kind, now);
  return retired;
}

/** Newest modification time among a generation folder and its login files (a login written in place changes the file, not the folder). */
function generationLastUse(dir: string | null, home: string, names: readonly string[], launchedAt = 0): number {
  let latest = launchedAt; // when an engine was last launched on THIS generation (recorded in the marker), whatever the scope's own use
  for (const path of [...(dir ? [dir] : []), ...names.map((n) => join(home, n))]) {
    try { latest = Math.max(latest, lstatSync(path).mtimeMs); } catch { /* absent */ }
  }
  return latest;
}

/**
 * Retire generations older than the current one that nothing has used for GENERATION_RETIRE_MAX_AGE_MS. Their logins are retained
 * first (handed to the owner's folder or kept aside, see adoptOneLogin) and only then removed, a login that could not be retained
 * stays; the folder itself goes only once nothing but links is left in it (state a process of that generation made is never
 * deleted). The current generation is never retired. Caller holds the scope's lease. Never throws.
 */
function retireOldGenerations(root: string, now: number): void {
  try {
    const marker = readMarker(root);
    if (!marker || typeof marker.realHome !== "string" || !Array.isArray(marker.share)) return;
    const current = generationOf(marker);
    const subdir = subdirOf(marker);
    const names = (marker.share as unknown[]).filter(validLoginName);
    for (const g of [...generationsOnDisk(root), 0]) {
      if (g >= current) continue;
      const dir = generationRoot(root, g);
      const home = subdir ? join(dir, subdir) : dir;
      // generation 0 is the scope root itself: its folder time is the scope's, only its login files say when it was last used
      const launched = (marker.launchedAt as Record<string, unknown> | undefined)?.[String(g)];
      if (now - generationLastUse(g > 0 ? dir : null, home, names, typeof launched === "number" ? launched : 0) < GENERATION_RETIRE_MAX_AGE_MS) continue;
      if (!retainGeneration(root, marker, g, names)) continue;
    }
  } catch { /* retirement is best effort */ }
}

/** A generation's logins retained (handed to the owner's folder or kept aside) and then removed; the folder goes once only links are left in it. False when a login could not be retained (it stays). */
function retainGeneration(root: string, marker: ScopeMarker, g: number, names: readonly string[]): boolean {
  const subdir = subdirOf(marker);
  const dir = generationRoot(root, g);
  const home = subdir ? join(dir, subdir) : dir;
  let retained = true;
  for (const name of names) {
    const path = join(home, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isFile() && !adoptOneLogin(path, join(marker.realHome as string, name), name, root, false)) { retained = false; continue; }
    try { unlinkSync(path); } catch { retained = false; }
  }
  if (!retained) return false;
  if (g > 0) removeIfOnlyLinks(dir, 3);
  return true;
}

/** A generation above the committed pointer was left by a switch whose pointer write failed: it was never launched on. Its logins are
 *  retained by the usual rules and the folder removed; whatever stays is ignored (never a source for a later generation). Never throws. */
function retireOrphanGenerations(root: string, marker: ScopeMarker, current: number): void {
  try {
    if (typeof marker.realHome !== "string" || !Array.isArray(marker.share)) return;
    const names = (marker.share as unknown[]).filter(validLoginName);
    const generated = (Array.isArray(marker.generated) ? marker.generated : []).filter((n): n is string => typeof n === "string");
    const subdir = subdirOf(marker);
    for (const g of generationsOnDisk(root)) {
      if (g <= current) continue;
      const dir = generationRoot(root, g);
      // its generated copies are the (possibly stale) files this generation was given: never launched on, so they go first
      try { dropOwnedCopies(subdir ? join(dir, subdir) : dir, generated, new Set(names), true); } catch { /* left; the generation is ignored */ }
      retainGeneration(root, marker, g, names);
    }
  } catch { /* the orphan is ignored either way */ }
}

/** Remove a folder when everything under it is a link or an empty folder; a regular file anywhere keeps the folder. True when removed. */
function removeIfOnlyLinks(dir: string, depth: number): boolean {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return false; }
  const links: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (stat.isSymbolicLink()) links.push(path);
    else if (stat.isDirectory() && depth > 0 && removeIfOnlyLinks(path, depth - 1)) continue;
    else return false;
  }
  for (const path of links) { try { unlinkSync(path); } catch { return false; } }
  try { rmdirSync(dir); return true; } catch { return false; }
}

/** Whether a scope must stay: its bot exists (or cannot be asked about), or another live server process built it. */
function scopeProtected(marker: ScopeMarker): boolean {
  if (typeof marker.botId === "string") {
    try {
      if (!retentionHooks.botExists || retentionHooks.botExists(marker.botId)) return true;
    } catch { return true; }
  }
  const owner = marker.owner;
  if (owner && typeof owner.pid === "number" && owner.pid !== process.pid) {
    try { if (processRunning({ pid: owner.pid, id: typeof owner.id === "string" ? owner.id : null })) return true; } catch { return true; }
  }
  return false;
}

/** One login file of a scope handed to the owner's folder (see adoptLogins). True when there is nothing left to place. */
function adoptOneLogin(scoped: string, real: string, name: string, scopeRoot: string, createOwner = true): boolean {
  let stat;
  try { stat = lstatSync(scoped); } catch { return true; }
  if (!stat.isFile()) return true; // a link, or not a file: nothing of the engine's own
  try {
    const bytes = readFileSync(scoped);
    if (createOwner) {
      try {
        mkdirSync(dirname(real), { recursive: true, mode: 0o700 });
        writeFileSync(real, bytes, { flag: "wx", mode: 0o600 });
        try { utimesSync(real, stat.atime, stat.mtime); } catch { /* time is a nicety */ }
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    let same = false;
    try { same = readFileSync(real).equals(bytes); } catch { /* unreadable: keep both */ }
    if (same) return true;
    if (setAsideLogin(dirname(scopeRoot), name, bytes, stat.mtimeMs, basename(scopeRoot))) {
      console.warn(`engine login kept aside, not replacing the owner's newer or different one (${name})`);
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST"; // the same copy was already set aside
  }
}

/**
 * A login the engine wrote INSIDE a scope (a first sign-in whose destination was not yet linked, or a replaced
 * file) goes to the owner's real folder first, and the real folder's own login is NEVER replaced: a missing one
 * is created exclusively (an owner sign-in that lands in between wins), one with the same bytes is left, and a
 * different one means both are kept, the scope's copy under quarantine/logins. True when every login is placed.
 * `marker` null is an earlier Gemini scope: it takes the owner folder and login names this process scoped.
 */
function adoptLogins(kind: string, scopeRoot: string, marker: ScopeMarker | null): boolean {
  let realHome: string;
  let subdir: string;
  let share: unknown;
  if (marker) {
    if (typeof marker.realHome !== "string" || !Array.isArray(marker.share)) return false; // unreadable marker: keep, do not guess
    realHome = marker.realHome;
    subdir = typeof marker.subdir === "string" ? marker.subdir : "";
    share = marker.share;
  } else {
    const known = [...(knownSpecs.get(kind) ?? [])].filter(([, spec]) => spec.subdir === ".gemini");
    if (known.length !== 1) return false; // no single owner folder to adopt into yet: keep
    realHome = known[0]![0];
    subdir = ".gemini";
    share = known[0]![1].share;
  }
  let placed = true;
  // Every generation's logins, newest first: the newest takes an absent owner's file, an older one that differs is kept aside.
  const roots = [...generationsOnDisk(scopeRoot).map((g) => generationRoot(scopeRoot, g)), scopeRoot];
  roots.forEach((generationDir, index) => {
    const home = subdir ? join(generationDir, subdir) : generationDir;
    for (const name of share as unknown[]) {
      if (!validLoginName(name)) continue;
      if (!adoptOneLogin(join(home, name), join(realHome, name), name, scopeRoot, index === 0)) placed = false;
    }
  });
  // Copies set aside inside the scope (a split login) are retained, never deleted with the scope: moved to the retained logins.
  const asideDir = join(scopeRoot, LOGIN_ASIDE_DIR);
  let entries: string[] = [];
  try { entries = readdirSync(asideDir); } catch { /* none */ }
  for (const entry of entries) {
    const name = /^\d+-\d+-(.+)$/.exec(entry)?.[1];
    try {
      const file = join(asideDir, entry);
      const stat = lstatSync(file);
      if (!name || !stat.isFile()) { placed = false; continue; }
      setAsideLogin(dirname(scopeRoot), name, readFileSync(file), stat.mtimeMs, basename(scopeRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; // the same copy was already retained
      placed = false;
    }
  }
  return placed;
}


const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const LOGIN_SEP = "__";
interface AsideLogin { path: string; name: string; hash: string; mtime: number }

/** Every login set aside, parsed from its `<scope>__<name>__<hash>__<mtime>` file name. Unparseable files are never touched by retention. */
function asideLogins(parent: string): AsideLogin[] {
  const dir = join(parent, SCOPE_QUARANTINE, QUARANTINE_LOGINS);
  migrateAsideLogins(parent);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: AsideLogin[] = [];
  for (const file of names) {
    const parts = file.split(LOGIN_SEP);
    if (parts.length < 4) continue;
    const mtime = Number(parts[parts.length - 1]);
    const hash = parts[parts.length - 2]!;
    if (!Number.isFinite(mtime) || !/^[0-9a-f]{16}$/.test(hash)) continue;
    out.push({ path: join(dir, file), name: parts.slice(1, -2).join(LOGIN_SEP), hash, mtime });
  }
  return out;
}

/**
 * One login kept once must carry the newest timestamp of its copies, or age and byte limits would drop the freshest login.
 * Returns true once the kept copy carries a stamp at least `mtime` (renamed when it had to move), false when the refresh
 * could not be made (the caller then keeps its own source file).
 */
function refreshAsideStamp(dir: string, copies: string[], mtime: number): boolean {
  const stamp = (f: string) => Number(f.split(LOGIN_SEP).slice(-1)[0]);
  const newest = copies.reduce<string | null>((best, f) => (best === null || stamp(f) > stamp(best) ? f : best), null);
  if (newest === null) return false;
  if (!(mtime > stamp(newest))) return true;
  const parts = newest.split(LOGIN_SEP);
  parts[parts.length - 1] = String(mtime);
  try { renameSync(join(dir, newest), join(dir, parts.join(LOGIN_SEP))); return true; } catch { return false; }
}

/**
 * Earlier builds named a set-aside login `<scope>-<name>-<mtime>`. Rename each into the current
 * `<scope>__<name>__<hash>__<mtime>` form so retention and deduplication see it (an identical copy already there is dropped).
 * Returns how many files were migrated. Never throws.
 */
export function migrateAsideLogins(parent: string): number {
  const dir = join(parent, SCOPE_QUARANTINE, QUARANTINE_LOGINS);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  const known = [...new Set([...[...knownSpecs.values()].flatMap((m) => [...m.values()].flatMap((v) => v.share))])].sort((a, b) => b.length - a.length);
  let migrated = 0;
  for (const file of names) {
    if (file.includes(LOGIN_SEP)) continue;
    const m = /^(.+)-(\d{10,})$/.exec(file);
    if (!m) continue;
    const stem = m[1]!;
    let scope: string; let name: string;
    const hit = known.find((n) => stem.endsWith(`-${n}`));
    if (hit) { name = hit; scope = stem.slice(0, -(hit.length + 1)); }
    else {
      const cred = /^(.*?)-(\.?(?:auth|oauth_creds|credentials?|token|tokens|api[_-]?keys?)(?:[._-][^/]*)?)$/i.exec(stem);
      if (cred) { scope = cred[1]!; name = cred[2]!; }
      else { const i = stem.lastIndexOf("-"); if (i <= 0) continue; scope = stem.slice(0, i); name = stem.slice(i + 1); }
    }
    try {
      const path = join(dir, file);
      const s = lstatSync(path);
      if (!s.isFile()) continue;
      const hash = sha(readFileSync(path)).slice(0, 16);
      const target = join(dir, [scope, name, hash, m[2]].join(LOGIN_SEP));
      // The directory as it is NOW, not as it was listed: an earlier rename here changed the name a later legacy copy of the same login must find.
      const current = readdirSync(dir);
      const twins = current.filter((n) => n.includes(LOGIN_SEP) && n.split(LOGIN_SEP).slice(1, -2).join(LOGIN_SEP) === name && n.split(LOGIN_SEP).slice(-2, -1)[0] === hash);
      if (existsSync(target) || twins.length) {
        // The same login is already there: keep ONE copy, stamped with the newest time either copy had. The source goes only
        // once the kept copy carries that time; a refresh that failed leaves the source for the next pass.
        if (!refreshAsideStamp(dir, existsSync(target) && !twins.includes(basename(target)) ? [...twins, basename(target)] : twins, Number(m[2]))) continue;
        unlinkSync(path);
      } else renameSync(path, target);
      migrated += 1;
    } catch { /* left for the next pass */ }
  }
  return migrated;
}

/** Set a login aside under quarantine/logins, once per distinct (login name, bytes): an identical copy is not stored again. True when a new copy was written. */
function setAsideLogin(parent: string, name: string, bytes: Buffer, mtimeMs: number, from: string): boolean {
  const hash = sha(bytes).slice(0, 16);
  const dir = join(parent, SCOPE_QUARANTINE, QUARANTINE_LOGINS);
  const twins = asideLogins(parent).filter((l) => l.name === name && l.hash === hash);
  // A refresh that could not be made falls through to a new copy with the newer stamp: the source is never dropped on a failed refresh.
  if (twins.length && refreshAsideStamp(dir, twins.map((l) => basename(l.path)), Math.round(mtimeMs))) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, [from, name, hash, String(Math.round(mtimeMs))].join(LOGIN_SEP)), bytes, { flag: "wx", mode: 0o600 });
  return true;
}

/** File names that may hold a login inside a quarantined scope: the logins this process scoped, and the usual credential file names. */
function loginNames(kind: string): Set<string> {
  const names = new Set<string>();
  for (const spec of knownSpecs.get(kind)?.values() ?? []) for (const n of spec.share) names.add(n);
  return names;
}
const CREDENTIAL_NAME = /^(?:\.?(?:auth|oauth_creds|credentials?|token|tokens|api[_-]?keys?)(?:[._-][^/]*)?)$/i;

/** Walk a quarantined scope (links not followed, bounded) for files that look like logins. */
function findLogins(dir: string, names: Set<string>): string[] {
  const found: string[] = [];
  const stack: Array<[string, number]> = [[dir, 0]];
  let seen = 0;
  while (stack.length && seen < WALK_ENTRY_LIMIT) {
    const [current, depth] = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(current); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const child = join(current, entry);
      try {
        const s = lstatSync(child);
        if (s.isDirectory()) { if (depth < 4) stack.push([child, depth + 1]); }
        else if (s.isFile() && (names.has(entry) || CREDENTIAL_NAME.test(entry))) found.push(child);
      } catch { /* gone */ }
    }
  }
  return found;
}

/** Bytes held by quarantine (set-aside logins and parked scopes). */
export function quarantineBytes(kind: string): number {
  return folderBytes(join(scopedCliHomeRoot(kind), SCOPE_QUARANTINE), Number.MAX_SAFE_INTEGER);
}

/**
 * Quarantine never grows without bound. Set-aside logins are deduplicated by content and per login name only the
 * newest copy of each distinct login is ever dropped for age (the newest copy of every name always stays). Parked scopes
 * go oldest first once past QUARANTINE_MAX_AGE_MS or while the total is over QUARANTINE_MAX_BYTES, but a scope's logins are
 * set aside first, and a scope whose login could not be set aside is kept. Never throws.
 */
export function enforceQuarantineBounds(kind: string, now: number = Date.now(), maxBytes: number = QUARANTINE_MAX_BYTES, maxAgeMs: number = QUARANTINE_MAX_AGE_MS): void {
  const parent = scopedCliHomeRoot(kind);
  try {
    // 1. logins: identical copies collapse to the newest; superseded versions of a name age out, the newest of each name stays
    const all = asideLogins(parent);
    const byHash = new Map<string, AsideLogin[]>();
    for (const l of all) byHash.set(`${l.name}\u0000${l.hash}`, [...(byHash.get(`${l.name}\u0000${l.hash}`) ?? []), l]);
    const keep: AsideLogin[] = [];
    for (const copies of byHash.values()) {
      copies.sort((a, b) => b.mtime - a.mtime);
      keep.push(copies[0]!);
      for (const dup of copies.slice(1)) { try { unlinkSync(dup.path); } catch { /* kept */ } }
    }
    const newestOfName = new Map<string, AsideLogin>();
    for (const l of keep) { const cur = newestOfName.get(l.name); if (!cur || l.mtime > cur.mtime) newestOfName.set(l.name, l); }
    for (const l of keep) {
      if (newestOfName.get(l.name) === l) continue; // the newest copy of a login is never dropped
      if (now - l.mtime >= maxAgeMs) { try { unlinkSync(l.path); } catch { /* kept */ } }
    }

    // under byte pressure superseded versions of a login go, oldest first; the newest copy of each name stays
    const evictSuperseded = () => {
      if (quarantineBytes(kind) <= maxBytes) return;
      const latest = new Map<string, AsideLogin>();
      const cur = asideLogins(parent);
      for (const l of cur) { const c = latest.get(l.name); if (!c || l.mtime > c.mtime) latest.set(l.name, l); }
      for (const l of cur.filter((x) => latest.get(x.name) !== x).sort((a, b) => a.mtime - b.mtime)) {
        if (quarantineBytes(kind) <= maxBytes) break;
        try { unlinkSync(l.path); } catch { /* kept */ }
      }
    };
    evictSuperseded();

    // 2. parked scopes: oldest first, past the age or while over the size cap
    const q = join(parent, SCOPE_QUARANTINE);
    let names: string[] = [];
    try { names = readdirSync(q).filter((n) => n !== QUARANTINE_LOGINS); } catch { return; }
    const parked = names.flatMap((n) => {
      try { const s = lstatSync(join(q, n)); const parkedAt = Number(/-(\d{10,})$/.exec(n)?.[1]); return [{ path: join(q, n), mtime: Number.isFinite(parkedAt) ? parkedAt : s.mtimeMs, dir: s.isDirectory() }]; } catch { return []; }
    }).sort((a, b) => a.mtime - b.mtime);
    const logins = loginNames(kind);
    let total = quarantineBytes(kind);
    for (const item of parked) {
      const expired = now - item.mtime >= maxAgeMs;
      if (!expired && total <= maxBytes) continue;
      let setAside = true;
      if (item.dir) {
        for (const file of findLogins(item.path, logins)) {
          try {
            const s = lstatSync(file);
            setAsideLogin(parent, basename(file), readFileSync(file), s.mtimeMs, basename(item.path));
          } catch { setAside = false; }
        }
      }
      if (!setAside) continue; // a login that could not be kept keeps its scope
      const size = folderBytes(item.path, Number.MAX_SAFE_INTEGER);
      try { rmSync(item.path, { recursive: true, force: true }); total -= size; } catch { /* kept until the next pass */ }
    }
    evictSuperseded();
    if (quarantineBytes(kind) > maxBytes && !capWarned.has(q)) {
      capWarned.add(q);
      console.warn(`engine quarantine is over its size cap (${kind}); set-aside logins are kept`);
    }
  } catch { /* retention is best effort */ }
}
