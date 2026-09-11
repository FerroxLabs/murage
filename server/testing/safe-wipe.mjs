// SPDX-License-Identifier: Apache-2.0
// The one recursive delete tests, human specs, fixtures and scripts may use.
//
// Written after the 2026-09-11 21:05 incident: the contents of the developer's
// live ~/.murage were deleted while Murage 0.1.51 was running and eight build
// lanes were running vitest, Playwright human specs and node --test files on
// the same Mac. No transcript shows the delete. vitest fakes HOME before any
// test module loads (server/testing/setup.ts); node --test files, Playwright
// specs, control-murage.ts and shell scripts do not, and several human specs
// wipe MURAGE_E2E_DATA_DIR at module load. Whatever the exact path was, the
// class is "a test or script computed a path and deleted it recursively with
// nothing between the computation and the delete". This module is what sits
// between them, and docs/verification/data-safety.md lists every site.
//
// Policy (assertSafeToWipe): a target may be deleted only when it is
//   - under the OS temp directory, or
//   - explicitly marked scratch: some path segment contains "scratch",
//     "evidence" or ".e2e" (e.g. REPO/.murage-scratch/e2e, lanes/.e2e/LANE), or
//   - strictly inside a root the caller names with `within` (build outputs
//     under the repository, never a home or data directory),
// and never when it
//   - is, contains, or lies inside the real default data dir (~/.murage from
//     both $HOME and the account database, so a faked HOME does not hide it),
//     the legacy ~/.opengrokbot, the companion directory, or a MURAGE_DATA_DIR
//     inherited from the environment that is not itself scratch,
//   - is, or contains, a home directory, the current working directory or a
//     filesystem root, or
//   - holds a live installation lease (`.murage-data-owner-*.lease`) owned by
//     another process on this host, beside it or anywhere inside it.
// A refusal throws SafeWipeRefused naming the path. Nothing is deleted.
//
// This file is plain JavaScript so node --test files, installer tests,
// Playwright specs (TypeScript) and scripts share one implementation; the
// types live in safe-wipe.d.mts. It must stay free of imports from server/
// (beyond the pure lease module) so it loads before any data dir is chosen.
import fs, { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { homedir as osHomedir, hostname, tmpdir as osTmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";

/** Path segments that mark a directory as disposable. */
const SCRATCH_SEGMENT = /scratch|evidence|\.e2e/i;
const LEASE_FILE = /^\.murage-data-owner-[0-9a-f]{64}\.lease$/;
/** How deep the lease scan looks below the target (directories only). */
const LEASE_SCAN_DEPTH = 3;
const LEASE_SCAN_LIMIT = 5_000;
const MAX_LEASE_BYTES = 4096;
const SKIP_SCAN = new Set(["node_modules", ".git", ".pnpm-store"]);

export class SafeWipeRefused extends Error {
  name = "SafeWipeRefused";
  /** @param {string} path @param {string} reason */
  constructor(path, reason) {
    super(`safe-wipe REFUSED to delete ${path}: ${reason}. Nothing was deleted. `
      + "Only OS temp, *scratch*/*evidence*/*.e2e* paths, or a caller-named build root may be wiped, "
      + "and never a Murage data directory (see docs/verification/data-safety.md).");
    this.path = path;
    this.reason = reason;
  }
}

const caseFold = (path, platform) => (platform === "win32" || platform === "darwin") ? path.toLowerCase() : path;

/** Resolve symlinks in the existing prefix of a path without requiring the
 * leaf to exist, so a link inside a scratch tree that points at real data is
 * judged by where it points. Never throws: an unreadable prefix falls back
 * to the lexical path. */
export function canonicalPath(target, depth = 0) {
  const absolute = resolve(target);
  // A symlink leaf is judged by where it points even when the target does
  // not exist yet (realpath fails on a dangling link and would otherwise
  // hand back the link itself, i.e. a scratch-looking name).
  if (depth < 32) {
    try {
      if (lstatSync(absolute).isSymbolicLink()) return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)), depth + 1);
    } catch { /* not a link, or unreadable: fall through to the prefix walk */ }
  }
  let current = absolute;
  const suffix = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return suffix.length ? join(real, ...suffix) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

function isRoot(path) {
  return parse(path).root === path || path === "" || path === ".";
}

/** `child` is strictly inside `parent`. */
function isInside(child, parent, platform) {
  const rel = relative(caseFold(parent, platform), caseFold(child, platform));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function isSame(a, b, platform) {
  return caseFold(a, platform) === caseFold(b, platform);
}
function sameOrInside(child, parent, platform) {
  return isSame(child, parent, platform) || isInside(child, parent, platform);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

/** Read one lease record leniently. No file means no lease; a present but
 * malformed record is treated as live (unknown), because "cannot prove it
 * dead" must not become "safe to wipe". */
function leaseOwner(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { return error?.code === "ENOENT" ? null : { pid: NaN, host: null, unknown: true }; }
  try {
    if (!stat.isFile() || stat.size > MAX_LEASE_BYTES) return { pid: NaN, host: null, unknown: true };
    const record = JSON.parse(readFileSync(path, "utf8"));
    return { pid: record?.pid, host: record?.host ?? null, unknown: false };
  } catch {
    return { pid: NaN, host: null, unknown: true };
  }
}

/**
 * Why a lease record stops a wipe, or null. A record another host wrote, or
 * one this code cannot read, proves nothing about a process on this machine,
 * so outside the OS temp dir both refuse ("cannot prove it dead" is not
 * "safe"). Under the OS temp dir only a live local owner refuses: fixtures
 * plant foreign and malformed records there on purpose, and a real
 * installation does not live in the temp dir.
 */
function leaseIsLive(path, selfPid, disposable) {
  const owner = leaseOwner(path);
  if (!owner) return null;
  if (owner.unknown) return disposable ? null : "unreadable lease record";
  if (owner.host && owner.host !== hostname()) return disposable ? null : `lease held on another host (${owner.host})`;
  if (owner.pid === selfPid) return null;
  return processAlive(owner.pid) ? `lease held by live process ${owner.pid}` : null;
}

/** Every lease that would name `target` or a directory inside it. */
function findLiveLease(target, selfPid, disposable) {
  const sibling = leaseFor(target);
  if (sibling) {
    const reason = leaseIsLive(sibling, selfPid, disposable);
    if (reason) return { lease: sibling, reason };
  }
  let visited = 0;
  const queue = [{ dir: target, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > LEASE_SCAN_LIMIT) return null;
      if (entry.isFile() && LEASE_FILE.test(entry.name)) {
        const lease = join(dir, entry.name);
        const reason = leaseIsLive(lease, selfPid, disposable);
        if (reason) return { lease, reason };
      } else if (entry.isDirectory() && depth < LEASE_SCAN_DEPTH && !SKIP_SCAN.has(entry.name)) {
        queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

/** The sibling lease path the installation lease module would use for a
 * data dir, from the shipped lease module so the two never disagree;
 * null when the path cannot be a data dir at all. */
function leaseFor(dataDir) {
  try { return dataDirLeasePaths(dataDir).leasePath; }
  catch { return null; }
}

function realHomes(options) {
  const homes = new Set();
  for (const candidate of [options.homedir ?? osHomedir(), accountHome()]) {
    if (candidate) homes.add(canonicalPath(candidate));
  }
  return [...homes];
}

function accountHome() {
  try { return userInfo().homedir || null; }
  catch { return null; }
}

function context(options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const tmp = canonicalPath(options.tmpdir ?? osTmpdir());
  const underTmp = (p) => !isRoot(tmp) && sameOrInside(p, tmp, platform);
  const scratchMarked = (p) => p.split(/[\\/]+/).some(segment => SCRATCH_SEGMENT.test(segment));
  return { platform, env, underTmp, scratchMarked, homes: realHomes(options), cwd: canonicalPath(options.cwd ?? process.cwd()), selfPid: options.selfPid ?? process.pid };
}

/** The rules no allow rule can outrank. Throws on the first hit. */
function denyRules(path, ctx) {
  const { platform, env, underTmp, scratchMarked, homes, cwd } = ctx;
  if (isRoot(path)) throw new SafeWipeRefused(path, "filesystem root");
  if (sameOrInside(cwd, path, platform)) throw new SafeWipeRefused(path, `is or contains the working directory ${cwd}`);
  for (const home of homes) {
    // A throwaway home under the OS temp dir (vitest) is disposable, and so
    // is everything the data dir rules below would derive from it. The
    // account's real home is always in `homes` too, so a faked HOME never
    // hides the real installation.
    if (underTmp(home)) continue;
    if (sameOrInside(home, path, platform)) throw new SafeWipeRefused(path, `is or contains the home directory ${home}`);
    for (const name of [".murage", ".opengrokbot", ".murage-companion"]) {
      const dataDir = join(home, name);
      if (sameOrInside(path, dataDir, platform) || isInside(dataDir, path, platform)) {
        throw new SafeWipeRefused(path, `is, contains or lies inside the Murage data directory ${dataDir}`);
      }
    }
  }
  for (const [name, value] of [["MURAGE_DATA_DIR", env.MURAGE_DATA_DIR], ["MURAGE_COMPANION_DIR", env.MURAGE_COMPANION_DIR]]) {
    if (!value) continue;
    const dataDir = canonicalPath(value);
    if (isRoot(dataDir) || underTmp(dataDir) || scratchMarked(dataDir)) continue;
    if (sameOrInside(path, dataDir, platform) || isInside(dataDir, path, platform)) {
      throw new SafeWipeRefused(path, `is, contains or lies inside ${name}=${dataDir}, which is not a scratch location`);
    }
  }
}

function liveLeaseRule(path, ctx) {
  const live = findLiveLease(path, ctx.selfPid, ctx.underTmp(path));
  if (live) throw new SafeWipeRefused(path, `${live.reason} (${live.lease})`);
}

/**
 * Decide whether `target` may be deleted recursively. Returns the canonical
 * path and the rule that admitted it; throws SafeWipeRefused otherwise.
 * @param {string} target
 * @param {import("./safe-wipe.d.mts").SafeWipeOptions} [options]
 */
export function assertSafeToWipe(target, options = {}) {
  if (typeof target !== "string" || !target.trim()) throw new SafeWipeRefused(String(target), "empty or non-string path");
  if (/[\0\r\n]/.test(target)) throw new SafeWipeRefused(target, "control characters in path");
  const ctx = context(options);
  const path = canonicalPath(target);
  denyRules(path, ctx);

  let admitted = null;
  if (ctx.underTmp(path)) admitted = "tmpdir";
  else if (ctx.scratchMarked(path)) admitted = "scratch-segment";
  else if (options.within) {
    const within = canonicalPath(options.within);
    if (isRoot(within)) throw new SafeWipeRefused(path, "`within` names a filesystem root");
    for (const home of ctx.homes) if (sameOrInside(home, within, ctx.platform)) throw new SafeWipeRefused(path, `\`within\` ${within} is or contains a home directory`);
    if (isInside(path, within, ctx.platform)) admitted = "within";
    else throw new SafeWipeRefused(path, `is not strictly inside \`within\` ${within}`);
  }
  if (!admitted) throw new SafeWipeRefused(path, "not under the OS temp directory, not marked scratch/evidence/.e2e, and no `within` root given");

  // Admission-only callers (a Playwright config validating MURAGE_E2E_DATA_DIR
  // while last run's harness may still own it) skip the lease scan; every
  // delete path in this module keeps it.
  if (options.checkLeases !== false) liveLeaseRule(path, ctx);
  return { path, admitted };
}

/**
 * Deny-only check for the process-wide guard: everything assertSafeToWipe
 * refuses outright, without requiring the target to be a recognised scratch
 * location. Installed by installSafeWipeGuard so an unrouted recursive delete
 * still cannot reach a data directory.
 * @param {string} target
 * @param {import("./safe-wipe.d.mts").SafeWipeOptions} [options]
 */
export function assertNotProtected(target, options = {}) {
  if (typeof target !== "string") return;
  const ctx = context(options);
  const path = canonicalPath(target);
  denyRules(path, ctx);
  liveLeaseRule(path, ctx);
}

/**
 * Delete `target` recursively after assertSafeToWipe admits it. Missing
 * targets are fine (force). Retries cover a just-killed child letting go of
 * its files; a refusal is never retried.
 * @param {string} target
 * @param {import("./safe-wipe.d.mts").SafeWipeOptions} [options]
 */
export function safeWipeSync(target, options = {}) {
  const { path } = assertSafeToWipe(target, { ...options, checkLeases: true });
  rmSync(path, { recursive: true, force: true, maxRetries: options.maxRetries ?? 3, retryDelay: options.retryDelay ?? 100 });
  return path;
}

/**
 * Async twin of safeWipeSync with a longer retry window, for teardown of a
 * fixture whose child process may still be closing files (Windows).
 * @param {string} target
 * @param {import("./safe-wipe.d.mts").SafeWipeOptions} [options]
 */
export async function safeWipe(target, options = {}) {
  const { path } = assertSafeToWipe(target, { ...options, checkLeases: true });
  const attempts = options.maxRetries ?? 20;
  const delay = options.retryDelay ?? 100;
  let lastError;
  for (let i = 0; i <= attempts; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return path;
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

let guardInstalled = false;
/**
 * Patch node:fs so every recursive rm/rmSync/rmdir in this process runs
 * assertNotProtected first. Idempotent. Used by the vitest setup file and the
 * node --test preload so files that were never routed through safeWipeSync
 * still cannot reach a data directory. Named imports see the patch because
 * Node's builtin ESM facades are re-synced after the assignment.
 * @param {import("./safe-wipe.d.mts").SafeWipeOptions} [options]
 */
export function installSafeWipeGuard(options = {}) {
  if (guardInstalled) return false;
  guardInstalled = true;
  const recursive = (opts) => Boolean(opts && typeof opts === "object" && opts.recursive);
  const originalRmSync = fs.rmSync;
  fs.rmSync = function guardedRmSync(path, opts) {
    if (recursive(opts)) assertNotProtected(String(path), options);
    return originalRmSync.call(this, path, opts);
  };
  const originalRm = fs.rm;
  fs.rm = function guardedRm(path, opts, callback) {
    if (recursive(opts)) {
      try { assertNotProtected(String(path), options); }
      catch (error) {
        const cb = typeof opts === "function" ? opts : callback;
        if (typeof cb === "function") { process.nextTick(cb, error); return; }
        throw error;
      }
    }
    return originalRm.call(this, path, opts, callback);
  };
  const originalPromisesRm = fs.promises.rm;
  fs.promises.rm = async function guardedPromisesRm(path, opts) {
    if (recursive(opts)) assertNotProtected(String(path), options);
    return originalPromisesRm.call(this, path, opts);
  };
  const originalRmdirSync = fs.rmdirSync;
  fs.rmdirSync = function guardedRmdirSync(path, opts) {
    if (recursive(opts)) assertNotProtected(String(path), options);
    return originalRmdirSync.call(this, path, opts);
  };
  syncBuiltinESMExports();
  return true;
}
