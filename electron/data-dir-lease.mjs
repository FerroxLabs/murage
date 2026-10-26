// SPDX-License-Identifier: Apache-2.0
// Adapted from OpenMausBot electron/data-dir-lease.mjs at
// f85fb3208332810323ede12fbde587e310ba6d59 (v0.1.54).
// Copyright 2026 Milind Soni and the OpenMausBot contributors; see LICENSE/NOTICE.
// Murage adaptations: stable sibling anchors, canonical aliases, strict bounded
// no-follow reads, sanitized errors, bounded acquisition, and sealed release.
// Boot-session detection adapted from upstream PR #937 at b6a27330560c.
// Windows same-boot PID reuse concept adapted from upstream PR #1324 at
// 7c82592ff8b1; Murage binds an exact creation identity instead of wall time.
// This helper never creates, migrates, renames or replaces the installation.
import { execFileSync } from "node:child_process";
import { windowsNative } from "./windows-native.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { isMainThread } from "node:worker_threads";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const CHILD_LEASE_ENV = "MURAGE_INTERNAL_DATA_DIR_LEASE";
const NO_CAPABILITY = Symbol("no private lease capability");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 4096;
const MAX_CLAIM_ATTEMPTS = 32;
const MAX_REAPER_GENERATIONS = 128;
const OWNER_KEYS = ["version", "pid", "host", "token", "createdAt"];
const BOOT_KEYS = ["boot", "uptime"];

const validBoot = (value) => typeof value === "string" && /^[0-9A-Za-z:_.-]{1,128}$/.test(value);
const validUptime = (value) => Number.isSafeInteger(value) && value >= 0;
let cachedBootSession;
function bootSession() {
  if (cachedBootSession !== undefined) return cachedBootSession;
  cachedBootSession = null;
  try {
    const raw = process.platform === "linux" ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      : process.platform === "darwin" ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
      }) : null;
    const value = typeof raw === "string" ? raw.trim() : null;
    if (validBoot(value)) cachedBootSession = value;
  } catch { /* Unknown boot identity cannot prove an owner stale. */ }
  return cachedBootSession;
}

function uptimeMs() {
  try {
    const value = Math.floor(uptime() * 1000);
    return validUptime(value) ? value : null;
  } catch { return null; }
}

// A different known boot, or a backwards since-boot clock when boot identity
// is unavailable, proves death. Wall time is never evidence. Unknown probes
// retain PID exclusion; notably failed uptime must not become zero.
// With recordPath, a live Windows PID is also checked against the owner's
// published creation identity; reapers and delegation checks pass none.
function ownerIsAlive(owner, recordPath) {
  // A record naming this very process is live only while this process holds
  // its token. A container starts its server as the same PID on every restart
  // (Cloud: PID 12) and the container shares the host's boot id, so a record
  // left by the previous start names a live PID on the current boot. Tokens
  // are random per claim and held in memory, so a token this process never
  // held, or has let go of, is a previous process's: stale. Another live
  // process has another PID and keeps PID exclusion below. Only the main
  // thread claims, and a worker thread has its own copy of this module (an
  // empty token set): there a record naming this PID is the running process
  // hosting the thread, and the checks below decide as for any other PID.
  if (owner.pid === process.pid && isMainThread) return heldTokens.has(owner.token);
  const boot = bootSession();
  if (boot !== null && typeof owner.boot === "string") {
    if (owner.boot !== boot) return false;
  } else if (validUptime(owner.uptime)) {
    const current = uptimeMs();
    if (current !== null && current < owner.uptime) return false;
  }
  if (!processIsAlive(owner.pid)) return false;
  return recordPath === undefined || !creationIdentityDisproves(owner, recordPath);
}

// Windows reuses PIDs within one boot, so a live PID alone cannot prove a
// crashed owner alive. An owner now holds a file of its own open share-none
// (UV_FS_O_EXLOCK) for as long as it holds the lease (identity version 2).
// The kernel closes that handle when the process ends, however it ends, and
// nothing else closes it while the owner lives. So a checker that can open
// the file has exact evidence that the owner is gone, found with one native
// open and no PowerShell (murage-releases #1: an antivirus notice on every
// launch). Version 1 identities (an exact kernel creation FILETIME, from
// 1.0.2) are checked against the process's creation time from the
// engine-exclusion addon, only when a lease is contested. Only a successful, well-formed, different answer proves death;
// every unavailable, slow, denied, busy or missing probe keeps PID exclusion.
const WINDOWS_START = /^[1-9][0-9]{0,19}$/;
// Linux identity (version 3): the owner's /proc starttime, clock ticks since
// boot. With the boot id it names one process exactly, so a live PID with
// another starttime is a reused PID and its owner is gone.
const LINUX_START = /^[0-9]{1,20}$/;
const MAX_FILETIME = 0x7fffffffffffffffn;
const IDENTITY_KEYS = ["version", "pid", "token", "start"];
const HELD_IDENTITY_KEYS = ["version", "pid", "token"];
const MAX_DISPROVED = 64;
const disproved = new Set();
const validStart = (value) => typeof value === "string" && WINDOWS_START.test(value) && BigInt(value) <= MAX_FILETIME;
const identityPath = (recordPath, owner) => `${recordPath}.identity-${owner.token}`;
function isIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isPid(value.pid) || typeof value.token !== "string" || !UUID.test(value.token)) return false;
  const keys = value.version === 1 || value.version === 3 ? IDENTITY_KEYS : value.version === 2 ? HELD_IDENTITY_KEYS : null;
  return Boolean(keys) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && (value.version === 2 || (value.version === 3 ? typeof value.start === "string" && LINUX_START.test(value.start) : validStart(value.start)));
}
// libuv's share-none open flag (Windows only; the documented value where a
// build does not name it).
const EXLOCK = constants.UV_FS_O_EXLOCK ?? 0x10000000;
const heldPath = (recordPath, owner) => `${recordPath}.alive-${owner.token}`;
/** true: the owner still holds its file; false: the file opened, so no
 * process holds it and the owner is gone; null: anything else (missing,
 * busy, denied, unexpected), which keeps exclusion. */
function ownerStillHolds(recordPath, owner) {
  let fd;
  try { fd = openSync(heldPath(recordPath, owner), constants.O_RDONLY); }
  catch (error) { return error?.code === "EBUSY" ? true : null; }
  try { closeSync(fd); } catch { /* opened is the answer */ }
  return false;
}
const ownHeld = new Map();

/** The process's exact creation FILETIME (decimal) from the engine-exclusion addon, as 1.0.2 recorded it ($p.StartTime.ToFileTimeUtc()),
 * or null: not there, unreadable or malformed. null keeps PID exclusion. No PowerShell (murage-releases #1). */
function probeProcessStartSync(pid, native = windowsNative()) {
  if (!isPid(pid) || typeof native?.processStart !== "function") return null;
  try {
    const start = native.processStart(pid);
    return validStart(start) ? start : null;
  } catch { return null; }
}

function readIdentity(recordPath, owner) {
  try {
    const identity = readRecord(identityPath(recordPath, owner), undefined, isIdentity)?.owner;
    return identity && identity.pid === owner.pid && identity.token === owner.token ? identity : null;
  } catch { return null; }
}

function creationIdentityDisproves(owner, recordPath) {
  if (process.platform === "linux") {
    // Only a clean, different starttime disproves; a missing, unreadable or
    // malformed answer keeps PID exclusion. Never any other platform's kind.
    const identity = readIdentity(recordPath, owner);
    if (!identity || identity.version !== 3) return false;
    const stat = linuxProcStat(owner.pid);
    return stat !== null && stat[1] !== identity.start;
  }
  if (process.platform !== "win32") return false;
  const identity = readIdentity(recordPath, owner);
  if (!identity || identity.version === 3) return false;
  const key = `${identity.pid}:${identity.token}:${identity.start ?? "held"}`;
  if (disproved.has(key)) return true;
  if (identity.version === 2) {
    if (ownerStillHolds(recordPath, owner) !== false) return false;
  } else {
    const current = probeProcessStartSync(owner.pid);
    if (current === null || current === identity.start) return false;
  }
  if (disproved.size >= MAX_DISPROVED) disproved.clear();
  disproved.add(key);
  return true;
}

/** Hold this owner's file share-none and publish its identity for the exact,
 * still-held record. No PowerShell runs and nothing waits. Without an
 * identity, checkers keep PID exclusion. */
function recordOwnIdentity(recordPath, owner, isReleased) {
  if (owner.pid !== process.pid) return;
  if (process.platform === "linux") {
    const stat = linuxProcStat("self");
    if (!stat) return;
    try {
      if (isReleased() || !sameOwner(readRecord(recordPath)?.owner, owner)) return;
      publishRecord(identityPath(recordPath, owner), { version: 3, pid: owner.pid, token: owner.token, start: stat[1] });
      // A release that ran while this was published leaves no identity behind.
      if (isReleased() || !sameOwner(readRecord(recordPath)?.owner, owner)) removeIdentity(recordPath, owner);
    } catch { /* Missing identity keeps the PID-only protocol. */ }
    return;
  }
  if (process.platform !== "win32") return;
  let fd;
  try {
    fd = openSync(heldPath(recordPath, owner), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | EXLOCK, 0o600);
  } catch { return; }
  ownHeld.set(owner.token, { fd, path: heldPath(recordPath, owner) });
  try {
    if (isReleased() || !sameOwner(readRecord(recordPath)?.owner, owner)) { removeIdentity(recordPath, owner); return; }
    publishRecord(identityPath(recordPath, owner), { version: 2, pid: owner.pid, token: owner.token });
  } catch { /* Missing identity keeps the PID-only protocol. */ }
}

function removeIdentity(recordPath, owner) {
  if (readIdentity(recordPath, owner)) {
    try { unlinkSync(identityPath(recordPath, owner)); } catch { /* inert, token-scoped leftover */ }
  }
  // The identity goes first, then the held file, so no checker sees an
  // identity whose file nobody holds while its owner lives.
  const held = owner.pid === process.pid ? ownHeld.get(owner.token) : undefined;
  if (held) { ownHeld.delete(owner.token); try { closeSync(held.fd); } catch { /* already closed */ } }
  try { unlinkSync(heldPath(recordPath, owner)); } catch { /* absent, or another process still holds it */ }
}

const MESSAGES = {
  INVALID_DATA_DIR: "Murage cannot lease an invalid installation directory.",
  MIGRATION_REQUIRED: "Migrate legacy data explicitly before acquiring the installation lease.",
  LEASE_PATH_CHANGED: "The installation path changed while preparing its lease; retry after checking the path.",
  LEASE_IO: "Murage could not prepare or update the lock on its data folder. Your data is unchanged; quit and reopen Murage.",
  LEASE_UNREADABLE: "Murage cannot read the installation lease; state has been preserved.",
  LEASE_INVALID: "The installation lease is invalid; state has been preserved.",
  LEASE_BUSY: "Murage is already using this installation. Close the other instance first.",
  LEASE_FOREIGN_HOST: "This installation has an owner or recovery claim on another machine; state has been preserved.",
  LEASE_OWNER_UNVERIFIED: "Murage could not verify the installation lease owner; state has been preserved.",
  LEASE_CHILD_BUSY: "A delegated server is still using this installation. Wait for it to exit before retrying.",
  LEASE_RECOVERY_BUSY: "Another process is recovering the installation lease; retry shortly.",
  LEASE_RECOVERY_LIMIT: "Installation lease recovery exceeded its bounded attempts; state has been preserved.",
  LEASE_NOT_OWNED: "Murage will not release or delegate a lease whose ownership changed.",
  LEASE_DELEGATION_INVALID: "The private installation lease delegation is invalid; refusing to start.",
  LEASE_DELEGATION_CONSUME: "Murage could not consume its private installation lease delegation.",
  LEASE_CLOSING: "The installation owner is releasing its lease; no new server may start.",
};

export class DataDirLeaseError extends Error {
  name = "DataDirLeaseError";
  constructor(code, io) {
    super(MESSAGES[code] ?? MESSAGES.LEASE_IO);
    this.code = code;
    // Deliberately no raw cause: JSON parser and filesystem errors can expose
    // nonce-bearing records, paths or the parent-to-child capability. Only the
    // errno and syscall of a filesystem failure are kept, never its message,
    // so a redacted log can say which call failed.
    const errno = typeof io?.code === "string" && /^E[A-Z0-9]{1,30}$/.test(io.code) ? io.code : undefined;
    const syscall = typeof io?.syscall === "string" && /^[a-z_]{1,20}$/.test(io.syscall) ? io.syscall : undefined;
    if (errno) Object.defineProperty(this, "ioCause", { value: Object.freeze({ errno, ...(syscall ? { syscall } : {}) }), enumerable: false });
  }
}
const fail = (code, io) => new DataDirLeaseError(code, io);
const absent = (error) => error?.code === "ENOENT";
const localHost = () => hostname();

/** Whether a record was written on this computer. The hostname alone cannot
 * say: macOS renames the host when it joins another network, so a lease left
 * by a crash on one network looked like another machine's on the next and the
 * app refused to start until the file was deleted by hand (upstream #2018).
 * The boot session id proves it too: it is random per boot, so no two
 * computers share one. A record from an earlier boot under another name
 * cannot be told apart from another computer's and still fails closed. */
function sameMachine(record) {
  if (record.host === localHost()) return true;
  const boot = bootSession();
  return boot !== null && typeof record.boot === "string" && record.boot === boot;
}

function withoutWindowsNamespace(path) {
  if (process.platform !== "win32") return path;
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[a-z]:\\/i.test(path)) return path.slice(4);
  return path;
}

function normalizedCanonicalPath(path) {
  if (process.platform !== "win32") return path;
  // Collapse Win32 namespace aliases before case-folding. This deliberately
  // over-excludes on Windows directories with opt-in case-sensitive names.
  const ordinary = path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\") ? path.slice(4) : path;
  return ordinary.toLowerCase();
}

/** Resolve existing symlink/junction aliases without creating DATA_DIR. A
 * dangling link or a file in the ancestor chain is not a missing directory. */
function canonicalDataDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir.trim() || /[\r\n\0]/.test(dataDir) || Buffer.byteLength(dataDir) > 32768) throw fail("INVALID_DATA_DIR");
  if (process.platform === "win32" && /^[a-z]:[^\\/]/i.test(dataDir)) throw fail("INVALID_DATA_DIR");
  // Native root resolution can reject the extended drive spelling even when
  // its ordinary spelling exists. Remove only recognized aliases, preserving
  // case for the physical component walk below. Namespace-only names must
  // not silently acquire the meaning of an ordinary Win32 path.
  const ordinary = withoutWindowsNamespace(dataDir);
  if (ordinary !== dataDir) {
    const components = ordinary.slice(parse(ordinary).root.length).split(/[\\/]+/);
    if (components.some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw fail("INVALID_DATA_DIR");
    }
  }
  dataDir = ordinary;
  // Do not resolve '..' before a symlink: link/../data names the parent of
  // the link's physical target, not necessarily the link's lexical parent.
  const absolute = isAbsolute(dataDir) ? dataDir : `${process.cwd()}${sep}${dataDir}`;
  const root = parse(absolute).root;
  let current;
  try { current = realpathSync.native(root); }
  catch { throw fail("INVALID_DATA_DIR"); }
  const suffix = [];
  for (const component of absolute.slice(root.length).split(process.platform === "win32" ? /[\\/]+/ : /\/+/)) {
    if (!component || component === ".") continue;
    if (component === "..") {
      if (suffix.length) throw fail("INVALID_DATA_DIR");
      current = dirname(current);
      continue;
    }
    if (suffix.length) { suffix.push(component); continue; }
    const candidate = join(current, component);
    let stat;
    try { stat = lstatSync(candidate); }
    catch (error) {
      if (!absent(error)) throw fail("INVALID_DATA_DIR");
      suffix.push(component);
      continue;
    }
    try {
      // realpath rejects dangling links; stat after resolution rejects a
      // symlink to a file as well as ordinary non-directory ancestors.
      const existing = realpathSync.native(candidate);
      if (!lstatSync(existing).isDirectory()) throw fail("INVALID_DATA_DIR");
      if (!stat.isDirectory() && !stat.isSymbolicLink()) throw fail("INVALID_DATA_DIR");
      current = existing;
    } catch { throw fail("INVALID_DATA_DIR"); }
  }
  const canonical = normalizedCanonicalPath(resolve(current, ...suffix));
  if (canonical === normalizedCanonicalPath(parse(canonical).root)) throw fail("INVALID_DATA_DIR");
  return canonical;
}

/** The full canonical installation path selects a stable sibling anchor.
 * Replacing only DATA_DIR leaves all ownership records in place. Parent
 * directory renames and hostile same-UID filesystem races are not contained. */
export function dataDirLeasePaths(dataDir) {
  const canonical = canonicalDataDir(dataDir);
  // Darwin commonly uses a case-insensitive volume. Before a missing leaf
  // exists, realpath cannot normalize that leaf's case. Fold its identity
  // conservatively, while preserving the physical parent path for I/O.
  // Case-sensitive Darwin volumes may therefore over-exclude case-only peers.
  const identity = process.platform === "darwin" ? canonical.normalize("NFC").toLowerCase() : canonical;
  const digest = createHash("sha256").update(identity).digest("hex");
  const leasePath = join(dirname(canonical), `.murage-data-owner-${digest}.lease`);
  return Object.freeze({ canonicalDataDir: canonical, leasePath, childLeasePath: `${leasePath}.child` });
}

function prepareAnchor(dataDir) {
  const paths = dataDirLeasePaths(dataDir);
  try { mkdirSync(dirname(paths.leasePath), { recursive: true, mode: 0o700 }); }
  catch (error) { throw fail("LEASE_IO", error); }
  if (dataDirLeasePaths(dataDir).leasePath !== paths.leasePath) throw fail("LEASE_PATH_CHANGED");
  return paths;
}

const isPid = (value) => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
function isOwner(value, reaperTarget) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = reaperTarget === undefined ? OWNER_KEYS : [...OWNER_KEYS, "targetToken"];
  return Object.keys(value).every((key) => keys.includes(key) || BOOT_KEYS.includes(key))
    && keys.every((key) => Object.hasOwn(value, key))
    && value.version === 1 && isPid(value.pid)
    && typeof value.host === "string" && value.host.length > 0 && value.host.length <= 255 && !/[\r\n\0]/.test(value.host)
    && typeof value.token === "string" && UUID.test(value.token)
    && Number.isSafeInteger(value.createdAt) && value.createdAt > 0
    && (!Object.hasOwn(value, "boot") || value.boot === null || validBoot(value.boot))
    && (!Object.hasOwn(value, "uptime") || value.uptime === null || validUptime(value.uptime))
    && (reaperTarget === undefined || value.targetToken === reaperTarget);
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameOwner = (a, b) => Boolean(a && b && a.pid === b.pid && a.host === b.host && a.token === b.token && a.createdAt === b.createdAt
  && a.boot === b.boot && a.uptime === b.uptime);

/** The record named by this path changed or went away while it was being
 * read: another contender is publishing, retiring or releasing it. That is
 * an election in progress, not a broken lease; claim() reads it again. */
const racedRead = (code) => Object.assign(fail(code), { raced: true });

/** No follow, no unbounded allocation, no special-file open, no raw causes. */
function readRecord(path, reaperTarget, validate = (value) => isOwner(value, reaperTarget)) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { if (absent(error)) return null; throw fail("LEASE_UNREADABLE"); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES || before.size < 1) throw fail("LEASE_INVALID");
  if ((before.mode & 0o444) === 0) throw fail("LEASE_UNREADABLE");
  let fd;
  try {
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (error) { if (absent(error)) throw racedRead("LEASE_UNREADABLE"); throw error; }
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw fail("LEASE_INVALID");
    if (!sameFile(before, opened)) throw racedRead("LEASE_INVALID");
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RECORD_BYTES) throw fail("LEASE_INVALID");
    let after;
    try { after = lstatSync(path); }
    catch (error) { if (absent(error)) throw racedRead("LEASE_UNREADABLE"); throw error; }
    const final = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink()) throw fail("LEASE_INVALID");
    if (!sameFile(opened, after)) throw racedRead("LEASE_INVALID");
    if (opened.size !== final.size || opened.mtimeMs !== final.mtimeMs || length !== final.size) throw fail("LEASE_INVALID");
    let value;
    try { value = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch { throw fail("LEASE_INVALID"); }
    if (!validate(value)) throw fail("LEASE_INVALID");
    return { owner: value, stat: final };
  } catch (error) {
    if (error instanceof DataDirLeaseError) throw error;
    // A path disappearing during a read is ambiguous, not a fresh install.
    throw fail("LEASE_UNREADABLE");
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

// The tokens of the primary and child records this process holds now. Shared
// by every copy of this module in the process (the server bundle inlines it).
const HELD_TOKENS = Symbol.for("murage.data-dir-lease.held-tokens");
const heldTokens = globalThis[HELD_TOKENS] ??= new Set();

// Linux /proc/<pid>/stat: [state, starttime] or null when unreadable or
// malformed. comm (field 2) may hold spaces and parentheses, so the fields
// are read after the LAST ')'. state is field 3, starttime field 22 (clock
// ticks since boot): index 0 and 19 of the rest.
function linuxProcStat(pid) {
  let raw;
  try { raw = readFileSync(`/proc/${pid}/stat`, "latin1"); } catch { return null; }
  const close = typeof raw === "string" ? raw.lastIndexOf(")") : -1;
  if (close < 0) return null;
  const rest = raw.slice(close + 1);
  if (!/^\s/.test(rest)) return null;
  const fields = rest.trim().split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  if (typeof state !== "string" || !/^[A-Za-z]$/.test(state) || typeof start !== "string" || !LINUX_START.test(start)) return null;
  return [state, start];
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code !== "EPERM") throw fail("LEASE_OWNER_UNVERIFIED");
  }
  // kill(pid, 0) succeeds on a zombie. Where PID 1 does not reap (WSL, a
  // container with a plain init), a killed child stays a zombie for ever and
  // would hold its lease for ever. Only a readable Z or X state proves death;
  // an unreadable /proc keeps the owner alive (fails closed).
  if (process.platform === "linux") {
    const stat = linuxProcStat(pid);
    if (stat && (stat[0] === "Z" || stat[0] === "X")) return false;
  }
  return true;
}

function publishRecord(path, owner) {
  const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`;
  let fd;
  let created = false;
  try {
    fd = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(owner)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try { linkSync(candidate, path); return true; }
    catch (error) { if (error?.code === "EEXIST") return false; throw fail("LEASE_IO", error); }
  } catch (error) {
    if (error instanceof DataDirLeaseError) throw error;
    throw fail("LEASE_IO", error);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    if (created) {
      try { unlinkSync(candidate); }
      catch (error) { if (!absent(error)) throw fail("LEASE_IO", error); }
    }
  }
}

function removeOwnedRecord(path, expected) {
  const record = readRecord(path);
  if (!record || !sameOwner(record.owner, expected)) throw fail("LEASE_NOT_OWNED");
  try {
    const current = lstatSync(path);
    if (!current.isFile() || !sameFile(record.stat, current)) throw fail("LEASE_NOT_OWNED");
    unlinkSync(path);
  } catch (error) {
    if (error instanceof DataDirLeaseError) throw error;
    throw fail("LEASE_IO", error);
  }
}

const newOwner = () => ({ version: 1, pid: process.pid, host: localHost(), token: randomUUID(), createdAt: Date.now(), boot: bootSession(), uptime: uptimeMs() });

// Recovery claims are immutable. A dead reaper's random token chooses its
// successor's path, so contenders never remove a newer election record.
// Old reaper records are intentionally retained: pruning requires a separate
// offline protocol. Both traversal depth and each record's size are bounded.
function claimReaper(leasePath, target) {
  let path = `${leasePath}.reap-${target.token}`;
  for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation++) {
    const candidate = { ...newOwner(), targetToken: target.token };
    if (publishRecord(path, candidate)) return true;
    const current = readRecord(path, target.token)?.owner;
    if (!current) continue;
    if (!sameMachine(current)) throw fail("LEASE_FOREIGN_HOST");
    if (ownerIsAlive(current)) return false;
    const digest = createHash("sha256").update(current.token).digest("hex").slice(0, 32);
    path = `${leasePath}.reap-${target.token}-${digest}`;
  }
  throw fail("LEASE_RECOVERY_LIMIT");
}

function retireDeadOwner(path, expected) {
  if (!claimReaper(path, expected)) throw fail("LEASE_RECOVERY_BUSY");
  const current = readRecord(path)?.owner;
  if (!current || !sameOwner(current, expected)) return;
  if (!sameMachine(current)) throw fail("LEASE_FOREIGN_HOST");
  if (ownerIsAlive(current, path)) throw fail("LEASE_BUSY");
  removeOwnedRecord(path, expected);
  removeIdentity(path, expected);
}

function assertNoLiveChild(paths, exitedChildren = []) {
  const child = readRecord(paths.childLeasePath)?.owner;
  if (!child) return;
  if (!sameMachine(child)) throw fail("LEASE_FOREIGN_HOST");
  if (!ownerIsAlive(child, paths.childLeasePath)) return;
  // The caller spawned this exact child and watched it exit cleanly (code 0),
  // so a record still naming its PID is leftover from a stop that arrived
  // before the child could release (the OS can lag the exit event). Only that
  // observed PID qualifies: any other live holder still refuses release.
  const observed = Array.isArray(exitedChildren)
    && exitedChildren.some((entry) => entry && entry.pid === child.pid && entry.code === 0);
  if (!observed) throw fail("LEASE_CHILD_BUSY");
  removeOwnedRecord(paths.childLeasePath, child);
  // The child's identity and held file are its own, token-scoped leftovers.
  heldTokens.delete(child.token);
  removeIdentity(paths.childLeasePath, child);
}

/** Diagnostic snapshot only: "available" never grants ownership. Acquisition
 * must still perform its own election and race checks. Never creates anchors,
 * retires owners, or exposes nonce-bearing records to the recovery renderer. */
export function inspectDataDirLease(dataDir) {
  const safeHost = (host) => typeof host === "string" && /^[A-Za-z0-9._:-]{1,255}$/.test(host) ? host : null;
  let currentHost = null;
  let claimKind = null;
  let recordedHost = null;
  const result = (status, code) => Object.freeze({ status, code, claimKind, recordedHost, currentHost });
  try {
    const host = localHost();
    currentHost = safeHost(host);
    const paths = dataDirLeasePaths(dataDir);
    const read = (path, kind, target) => {
      claimKind = kind;
      recordedHost = null;
      const owner = readRecord(path, target)?.owner;
      if (owner) recordedHost = safeHost(owner.host);
      return owner;
    };
    // Match primary acquisition: the child guard runs before the primary,
    // and only a dead primary requires traversing its immutable reapers.
    const child = read(paths.childLeasePath, "child");
    if (child) {
      if (!sameMachine(child)) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(child, paths.childLeasePath)) return result("blocked", "LEASE_CHILD_BUSY");
    }
    const primary = read(paths.leasePath, "primary");
    if (primary) {
      if (!sameMachine(primary)) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(primary, paths.leasePath)) return result("blocked", "LEASE_BUSY");
      let path = `${paths.leasePath}.reap-${primary.token}`;
      for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation++) {
        const reaper = read(path, "reaper", primary.token);
        if (!reaper) break;
        if (!sameMachine(reaper)) return result("blocked", "LEASE_FOREIGN_HOST");
        if (ownerIsAlive(reaper)) return result("blocked", "LEASE_RECOVERY_BUSY");
        if (generation === MAX_REAPER_GENERATIONS - 1) return result("blocked", "LEASE_RECOVERY_LIMIT");
        const digest = createHash("sha256").update(reaper.token).digest("hex").slice(0, 32);
        path = `${paths.leasePath}.reap-${primary.token}-${digest}`;
      }
    }
    claimKind = null;
    recordedHost = null;
    return result("available", null);
  } catch (error) {
    return result("error", error instanceof DataDirLeaseError ? error.code : "LEASE_IO");
  }
}

function claim(path, guard = () => {}) {
  const owner = newOwner();
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    guard();
    if (publishRecord(path, owner)) {
      heldTokens.add(owner.token);
      try { guard(); }
      catch (error) { heldTokens.delete(owner.token); removeOwnedRecord(path, owner); throw error; }
      return owner;
    }
    let current;
    try { current = readRecord(path)?.owner; }
    catch (error) { if (error?.raced) continue; throw error; }
    if (!current) continue;
    if (!sameMachine(current)) throw fail("LEASE_FOREIGN_HOST");
    if (ownerIsAlive(current, path)) throw fail("LEASE_BUSY");
    try { retireDeadOwner(path, current); }
    catch (error) { if (!error?.raced) throw error; }
  }
  throw fail("LEASE_RECOVERY_LIMIT");
}

// A crash can retain an old seal. It names only that primary nonce and is
// inert after a successor takes ownership; offline pruning is separate work.
const closingPath = (paths, owner) => `${paths.leasePath}.closing-${owner.token}`;
function assertNotClosing(paths, owner) {
  if (readRecord(closingPath(paths, owner))) throw fail("LEASE_CLOSING");
}

/** Claim exclusive primary ownership. Integration must finish any explicit
 * legacy migration first; passing upstream's migration options is refused. */
export function acquireDataDirLease(dataDir, options) {
  if (options !== undefined) throw fail("MIGRATION_REQUIRED");
  const paths = prepareAnchor(dataDir);
  const owner = claim(paths.leasePath, () => assertNoLiveChild(paths));
  let released = false;
  recordOwnIdentity(paths.leasePath, owner, () => released);
  return Object.freeze({
    ownerPid: owner.pid,
    delegated: false,
    /** `options.exitedChildren`: [{ pid, code }] for server children this
     * process spawned and saw exit; a code-0 exit clears that child's record. */
    release(options) {
      if (released) return false;
      const exitedChildren = options?.exitedChildren;
      if (!sameOwner(readRecord(paths.leasePath)?.owner, owner)) {
        // The record is another owner's now: it is left as it is, but what is
        // this handle's own (its token, and on Windows its share-none file
        // and that file's identity) goes, or the handle would pin the file
        // for the life of the process and claim an ownership it lost.
        heldTokens.delete(owner.token);
        removeIdentity(paths.leasePath, owner);
        throw fail("LEASE_NOT_OWNED");
      }
      // Refusing an already-live child leaves delegation usable for a later
      // fallback attempt. The seal then closes the child-start/release race.
      assertNoLiveChild(paths, exitedChildren);
      const seal = closingPath(paths, owner);
      if (!publishRecord(seal, owner) && !sameOwner(readRecord(seal)?.owner, owner)) throw fail("LEASE_NOT_OWNED");
      try {
        assertNoLiveChild(paths, exitedChildren);
        removeOwnedRecord(paths.leasePath, owner);
        released = true;
        heldTokens.delete(owner.token);
        removeIdentity(paths.leasePath, owner);
      } finally {
        // Safe to unseal after success (no matching primary remains) or a
        // refused release (this same primary still excludes other owners).
        removeOwnedRecord(seal, owner);
      }
      return true;
    },
    utilityServerLeaseEnvironment() {
      if (released || !sameOwner(readRecord(paths.leasePath)?.owner, owner)) throw fail("LEASE_NOT_OWNED");
      assertNotClosing(paths, owner);
      return Object.freeze({ [CHILD_LEASE_ENV]: `v1:${owner.pid}:${owner.token}` });
    },
  });
}

function consumeCapability(environment) {
  let value;
  try {
    value = environment[CHILD_LEASE_ENV];
    if (value === undefined) return NO_CAPABILITY;
    delete environment[CHILD_LEASE_ENV];
    if (environment[CHILD_LEASE_ENV] !== undefined) throw fail("LEASE_DELEGATION_CONSUME");
  } catch { throw fail("LEASE_DELEGATION_CONSUME"); }
  return value;
}

export function acquireDataDirLeaseForProcess(dataDir, environment = process.env) {
  const encoded = consumeCapability(environment);
  if (encoded === NO_CAPABILITY) return acquireDataDirLease(dataDir);
  const match = typeof encoded === "string" && /^v1:([1-9][0-9]{0,9}):([0-9a-f-]{36})$/.exec(encoded);
  if (!match || !isPid(Number(match[1])) || !UUID.test(match[2])) throw fail("LEASE_DELEGATION_INVALID");
  const paths = prepareAnchor(dataDir);
  const validateParent = () => {
    const owner = readRecord(paths.leasePath)?.owner;
    if (!owner || owner.pid !== Number(match[1]) || owner.token !== match[2]
      || !sameMachine(owner) || !ownerIsAlive(owner)) throw fail("LEASE_DELEGATION_INVALID");
    assertNotClosing(paths, owner);
  };
  validateParent();
  const owner = claim(paths.childLeasePath);
  try { validateParent(); }
  catch (error) { heldTokens.delete(owner.token); removeOwnedRecord(paths.childLeasePath, owner); throw error; }
  let released = false;
  recordOwnIdentity(paths.childLeasePath, owner, () => released);
  return Object.freeze({
    ownerPid: owner.pid,
    delegated: true,
    release() {
      if (released) return false;
      removeOwnedRecord(paths.childLeasePath, owner);
      released = true;
      heldTokens.delete(owner.token);
      removeIdentity(paths.childLeasePath, owner);
      return true;
    },
  });
}
