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
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep, win32 } from "node:path";

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
// crashed owner alive. The kernel creation FILETIME of a process never
// changes, so the exact value its owner published is clock- and DST-free
// evidence. Only a successful, well-formed, different answer proves death;
// every unavailable, slow, denied or malformed probe keeps PID exclusion.
const WINDOWS_START = /^[1-9][0-9]{0,19}$/;
const MAX_FILETIME = 0x7fffffffffffffffn;
const IDENTITY_KEYS = ["version", "pid", "token", "start"];
const IDENTITY_OUTPUT_BYTES = 64;
const CHECK_PROBE_TIMEOUT_MS = 5_000;
const SELF_PROBE_TIMEOUT_MS = 10_000;
const MAX_DISPROVED = 64;
const disproved = new Set();
const validStart = (value) => typeof value === "string" && WINDOWS_START.test(value) && BigInt(value) <= MAX_FILETIME;
const identityPath = (recordPath, owner) => `${recordPath}.identity-${owner.token}`;
function isIdentity(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === IDENTITY_KEYS.length && IDENTITY_KEYS.every((key) => Object.hasOwn(value, key))
    && value.version === 1 && isPid(value.pid) && typeof value.token === "string" && UUID.test(value.token) && validStart(value.start);
}

function windowsProcessStartQuery(pid) {
  const root = process.env.SystemRoot;
  if (!isPid(pid) || typeof root !== "string" || !/^[A-Za-z]:\\[^\0\r\n"]*$/.test(root)) return null;
  // Same trusted Windows PowerShell 5.1 shape as the browser signature probe.
  const script = String.raw`$env:PSModulePath=$PSHOME+'\Modules'; $ErrorActionPreference='Stop'; `
    + `$p=[System.Diagnostics.Process]::GetProcessById(${pid}); [Console]::Out.Write(([string]$p.Id)+':'+([string]($p.StartTime.ToFileTimeUtc())))`;
  return {
    command: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
  };
}

function parseProcessStart(pid, output) {
  if (typeof output !== "string" || output.length > IDENTITY_OUTPUT_BYTES) return null;
  const match = /^([1-9][0-9]{0,9}):([0-9]+)$/.exec(output.replace(/^\uFEFF/, "").trim());
  return match && Number(match[1]) === pid && validStart(match[2]) ? match[2] : null;
}

function probeProcessStartSync(pid) {
  const query = windowsProcessStartQuery(pid);
  if (!query) return null;
  try {
    return parseProcessStart(pid, execFileSync(query.command, query.args, {
      encoding: "utf8", timeout: CHECK_PROBE_TIMEOUT_MS, maxBuffer: IDENTITY_OUTPUT_BYTES, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch { return null; }
}

let selfStart;
function probeOwnStart() {
  selfStart ??= new Promise((settle) => {
    const query = windowsProcessStartQuery(process.pid);
    if (!query) return settle(null);
    try {
      const child = execFile(query.command, query.args, {
        encoding: "utf8", timeout: SELF_PROBE_TIMEOUT_MS, maxBuffer: IDENTITY_OUTPUT_BYTES, windowsHide: true,
      }, (error, stdout) => settle(error ? null : parseProcessStart(process.pid, stdout)));
      // Identity is an optimization for later recovery; never hold exit.
      child?.unref?.();
      child?.stdout?.unref?.();
      child?.stderr?.unref?.();
    } catch { settle(null); }
  });
  return selfStart;
}

function readIdentity(recordPath, owner) {
  try {
    const identity = readRecord(identityPath(recordPath, owner), undefined, isIdentity)?.owner;
    return identity && identity.pid === owner.pid && identity.token === owner.token ? identity : null;
  } catch { return null; }
}

function creationIdentityDisproves(owner, recordPath) {
  if (process.platform !== "win32") return false;
  const identity = readIdentity(recordPath, owner);
  if (!identity) return false;
  const key = `${identity.pid}:${identity.token}:${identity.start}`;
  if (disproved.has(key)) return true;
  const current = probeProcessStartSync(owner.pid);
  if (current === null || current === identity.start) return false;
  if (disproved.size >= MAX_DISPROVED) disproved.clear();
  disproved.add(key);
  return true;
}

/** Publish this process's creation identity for its exact, still-held record
 * without blocking startup. Absence is safe: checkers keep PID exclusion. */
function recordOwnIdentity(recordPath, owner, isReleased) {
  if (process.platform !== "win32" || owner.pid !== process.pid) return;
  void probeOwnStart().then((start) => {
    try {
      if (start === null || isReleased() || !sameOwner(readRecord(recordPath)?.owner, owner)) return;
      publishRecord(identityPath(recordPath, owner), { version: 1, pid: owner.pid, token: owner.token, start });
      // A release that raced the publication must not leave a live-looking identity.
      if (isReleased()) removeIdentity(recordPath, owner);
    } catch { /* Missing identity keeps the PID-only protocol. */ }
  }, () => {});
}

function removeIdentity(recordPath, owner) {
  if (!readIdentity(recordPath, owner)) return;
  try { unlinkSync(identityPath(recordPath, owner)); } catch { /* inert, token-scoped leftover */ }
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

/** No follow, no unbounded allocation, no special-file open, no raw causes. */
function readRecord(path, reaperTarget, validate = (value) => isOwner(value, reaperTarget)) {
  let before;
  try { before = lstatSync(path); }
  catch (error) { if (absent(error)) return null; throw fail("LEASE_UNREADABLE"); }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES || before.size < 1) throw fail("LEASE_INVALID");
  if ((before.mode & 0o444) === 0) throw fail("LEASE_UNREADABLE");
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw fail("LEASE_INVALID");
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_RECORD_BYTES) throw fail("LEASE_INVALID");
    const after = lstatSync(path);
    const final = fstatSync(fd);
    if (!after.isFile() || after.isSymbolicLink() || !sameFile(opened, after)
      || opened.size !== final.size || opened.mtimeMs !== final.mtimeMs || length !== final.size) throw fail("LEASE_INVALID");
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

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw fail("LEASE_OWNER_UNVERIFIED");
  }
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
    if (current.host !== localHost()) throw fail("LEASE_FOREIGN_HOST");
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
  if (current.host !== localHost()) throw fail("LEASE_FOREIGN_HOST");
  if (ownerIsAlive(current, path)) throw fail("LEASE_BUSY");
  removeOwnedRecord(path, expected);
  removeIdentity(path, expected);
}

function assertNoLiveChild(paths) {
  const child = readRecord(paths.childLeasePath)?.owner;
  if (!child) return;
  if (child.host !== localHost()) throw fail("LEASE_FOREIGN_HOST");
  if (ownerIsAlive(child, paths.childLeasePath)) throw fail("LEASE_CHILD_BUSY");
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
      if (child.host !== host) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(child, paths.childLeasePath)) return result("blocked", "LEASE_CHILD_BUSY");
    }
    const primary = read(paths.leasePath, "primary");
    if (primary) {
      if (primary.host !== host) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(primary, paths.leasePath)) return result("blocked", "LEASE_BUSY");
      let path = `${paths.leasePath}.reap-${primary.token}`;
      for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation++) {
        const reaper = read(path, "reaper", primary.token);
        if (!reaper) break;
        if (reaper.host !== host) return result("blocked", "LEASE_FOREIGN_HOST");
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
      try { guard(); }
      catch (error) { removeOwnedRecord(path, owner); throw error; }
      return owner;
    }
    const current = readRecord(path)?.owner;
    if (!current) continue;
    if (current.host !== owner.host) throw fail("LEASE_FOREIGN_HOST");
    if (ownerIsAlive(current, path)) throw fail("LEASE_BUSY");
    retireDeadOwner(path, current);
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
    release() {
      if (released) return false;
      if (!sameOwner(readRecord(paths.leasePath)?.owner, owner)) throw fail("LEASE_NOT_OWNED");
      // Refusing an already-live child leaves delegation usable for a later
      // fallback attempt. The seal then closes the child-start/release race.
      assertNoLiveChild(paths);
      const seal = closingPath(paths, owner);
      if (!publishRecord(seal, owner) && !sameOwner(readRecord(seal)?.owner, owner)) throw fail("LEASE_NOT_OWNED");
      try {
        assertNoLiveChild(paths);
        removeOwnedRecord(paths.leasePath, owner);
        released = true;
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
      || owner.host !== localHost() || !ownerIsAlive(owner)) throw fail("LEASE_DELEGATION_INVALID");
    assertNotClosing(paths, owner);
  };
  validateParent();
  const owner = claim(paths.childLeasePath);
  try { validateParent(); }
  catch (error) { removeOwnedRecord(paths.childLeasePath, owner); throw error; }
  let released = false;
  recordOwnIdentity(paths.childLeasePath, owner, () => released);
  return Object.freeze({
    ownerPid: owner.pid,
    delegated: true,
    release() {
      if (released) return false;
      removeOwnedRecord(paths.childLeasePath, owner);
      released = true;
      removeIdentity(paths.childLeasePath, owner);
      return true;
    },
  });
}
