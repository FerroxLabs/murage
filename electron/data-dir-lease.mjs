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
import { withHideInherit } from "../shared/win-hide-child-process.mjs";
import { execFileSync } from "node:child_process";
import { windowsNative } from "./windows-native.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { isMainThread } from "node:worker_threads";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

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
export function provedOwnerReboot(owner, boot = bootSession(), uptimeValue) {
  if (boot !== null && validBoot(boot) && validBoot(owner.boot)) return owner.boot !== boot;
  if (!validUptime(owner.uptime)) return false;
  const current = uptimeValue === undefined ? uptimeMs() : uptimeValue;
  return validUptime(current) && current < owner.uptime;
}

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
  if (provedOwnerReboot(owner)) return false;
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
// macOS identity (version 4). macOS has no exact process-creation probe in
// Node, so ps reports the owner's start (lstart, to the second, in a fixed C
// locale and UTC): with the boot session it names one process, so a live PID
// with another start is a reused PID and its owner is gone. It lives in the
// token-scoped side file, never in the record, so older versions read records
// unchanged (and ignore a version they do not know).
const DARWIN_START = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/;
const MAX_FILETIME = 0x7fffffffffffffffn;
const IDENTITY_KEYS = ["version", "pid", "token", "start"];
const HELD_IDENTITY_KEYS = ["version", "pid", "token"];
const MAX_DISPROVED = 64;
const disproved = new Set();
const validStart = (value) => typeof value === "string" && WINDOWS_START.test(value) && BigInt(value) <= MAX_FILETIME;
/** Same exact process-start policy for callers fencing external children. */
export function validProcessStart(value, platform = process.platform) {
  return platform === "linux" ? typeof value === "string" && LINUX_START.test(value)
    : platform === "win32" && validStart(value);
}
const identityPath = (recordPath, owner) => `${recordPath}.identity-${owner.token}`;
function isIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isPid(value.pid) || typeof value.token !== "string" || !UUID.test(value.token)) return false;
  const keys = value.version === 1 || value.version === 3 || value.version === 4 ? IDENTITY_KEYS : value.version === 2 ? HELD_IDENTITY_KEYS : null;
  return Boolean(keys) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && (value.version === 2 || (value.version === 4 ? typeof value.start === "string" && DARWIN_START.test(value.start)
      : value.version === 3 ? typeof value.start === "string" && LINUX_START.test(value.start) : validStart(value.start)));
}

/** ps's start time of a live process, normalised, or null: missing,
 * slow, denied or malformed. null keeps PID exclusion. */
function darwinProcessStart(pid) {
  if (!isPid(pid)) return null;
  try {
    const raw = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], withHideInherit({
      encoding: "utf8", timeout: 5_000, maxBuffer: 1024, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", TZ: "UTC" },
    }));
    const value = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : null;
    return value && DARWIN_START.test(value) ? value : null;
  } catch { return null; }
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
  if (process.platform === "darwin") {
    // Only a clean, different start disproves, as on Linux.
    const identity = readIdentity(recordPath, owner);
    if (!identity || identity.version !== 4) return false;
    const current = darwinProcessStart(owner.pid);
    return current !== null && current !== identity.start;
  }
  if (process.platform !== "win32") return false;
  const identity = readIdentity(recordPath, owner);
  if (!identity || (identity.version !== 1 && identity.version !== 2)) return false;
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
  if (process.platform === "darwin") {
    const start = darwinProcessStart(process.pid);
    if (start === null) return;
    try {
      if (isReleased() || !sameOwner(readRecord(recordPath)?.owner, owner)) return;
      publishRecord(identityPath(recordPath, owner), { version: 4, pid: owner.pid, token: owner.token, start });
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
  removeMachineNote(recordPath, owner);
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
  LEASE_TAKEOVER_REFUSED: "Murage could not confirm that no other computer or process is using this installation; its lock files were left as they are.",
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
function sameMachine(record, host = localHost(), boot) {
  if (record.host === host) return true;
  const currentBoot = boot === undefined ? bootSession() : boot;
  return currentBoot !== null && typeof record.boot === "string" && record.boot === currentBoot;
}

// A lock left by an unclean end (an interrupted update, a force quit), then a
// restart on another network, carries an old name AND an old boot, so the two
// proofs above cannot place it and the Mac stayed on the recovery window at
// every start. Two more proofs of this very computer (macOS only), never of a
// live owner (liveness is still decided by ownerIsAlive):
// 1. new records get a token-scoped note holding a hash of the Mac's own
//    hardware identity (IOPlatformUUID). Another computer has another one, so
//    it still fails closed. Not Linux: container images can bake one
//    machine-id into every copy. Older versions never read the note; a record
//    without one keeps the older proofs.
// 2. a record from before the note named this Mac by its own Bonjour name
//    (LocalHostName, ".local") or its set HostName. Bonjour keeps that name
//    unique on a network, and an unknown or unset name proves nothing.
const MACHINE_KEYS = ["version", "token", "machine"];
const MACHINE_DIGEST = /^[0-9a-f]{64}$/;
const machinePath = (recordPath, owner) => `${recordPath}.machine-${owner.token}`;
const isMachineNote = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === MACHINE_KEYS.length && MACHINE_KEYS.every((key) => Object.hasOwn(value, key))
  && value.version === 1 && typeof value.token === "string" && UUID.test(value.token)
  && typeof value.machine === "string" && MACHINE_DIGEST.test(value.machine);
const darwinProbe = (file, args) => execFileSync(file, [...args], withHideInherit({
  encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
}));
let cachedMachine;
function machineIdentity() {
  if (cachedMachine !== undefined) return cachedMachine;
  cachedMachine = null;
  try {
    const raw = process.platform === "darwin"
      ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(darwinProbe("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]))?.[1] : null;
    if (typeof raw === "string" && /^[0-9A-Fa-f-]{36}$/.test(raw) && !/^[0-]+$/.test(raw)) {
      cachedMachine = createHash("sha256").update(`murage-data-dir-lease-machine-v1\0${raw.toLowerCase()}`).digest("hex");
    }
  } catch { /* Unknown machine identity proves nothing. */ }
  return cachedMachine;
}
let cachedNames;
function ownHostNames() {
  if (cachedNames !== undefined) return cachedNames;
  cachedNames = new Set();
  if (process.platform !== "darwin") return cachedNames;
  for (const key of ["LocalHostName", "HostName"]) {
    let name;
    try { name = darwinProbe("/usr/sbin/scutil", ["--get", key]).trim().toLowerCase(); } catch { continue; }
    if (!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(name)) continue;
    cachedNames.add(name);
    if (key === "LocalHostName" && !name.includes(".")) cachedNames.add(`${name}.local`);
  }
  return cachedNames;
}
function recordOwnMachine(recordPath, owner) {
  const machine = machineIdentity();
  if (!machine) return;
  try { publishRecord(machinePath(recordPath, owner), { version: 1, token: owner.token, machine }); }
  catch { /* Without a note the older proofs still apply. */ }
}
function removeMachineNote(recordPath, owner) {
  try { if (readRecord(machinePath(recordPath, owner), undefined, isMachineNote)) unlinkSync(machinePath(recordPath, owner)); }
  catch { /* inert, token-scoped leftover */ }
}
/** sameMachine, plus the two proofs above for the record stored at recordPath. */
function sameMachineAt(record, recordPath) {
  if (sameMachine(record)) return true;
  let note;
  try { note = readRecord(machinePath(recordPath, record), undefined, isMachineNote)?.owner ?? null; }
  catch { return false; }
  // A note is the owner's own word: it alone decides, so a computer that only
  // shares this Mac's name is never taken for it. Names speak only for records
  // written before notes existed.
  if (note) return note.token === record.token && machineIdentity() !== null && note.machine === machineIdentity();
  return ownHostNames().has(record.host.toLowerCase());
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
export function dataDirIdentity(canonical, platform = process.platform) {
  const identity = platform === "darwin" ? canonical.normalize("NFC").toLowerCase() : canonical;
  return createHash("sha256").update(identity).digest("hex");
}

export function dataDirLeasePaths(dataDir) {
  const canonical = canonicalDataDir(dataDir);
  // Darwin commonly uses a case-insensitive volume. Before a missing leaf
  // exists, realpath cannot normalize that leaf's case. Fold its identity
  // conservatively, while preserving the physical parent path for I/O.
  // Case-sensitive Darwin volumes may therefore over-exclude case-only peers.
  const digest = dataDirIdentity(canonical);
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
    if (publishRecord(path, candidate)) { recordOwnMachine(path, candidate); return true; }
    const current = readRecord(path, target.token)?.owner;
    if (!current) continue;
    if (!sameMachineAt(current, path)) throw fail("LEASE_FOREIGN_HOST");
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
  if (!sameMachineAt(current, path)) throw fail("LEASE_FOREIGN_HOST");
  if (ownerIsAlive(current, path)) throw fail("LEASE_BUSY");
  removeOwnedRecord(path, expected);
  removeIdentity(path, expected);
}

function assertNoLiveChild(paths, exitedChildren = []) {
  const child = readRecord(paths.childLeasePath)?.owner;
  if (!child) return;
  if (!sameMachineAt(child, paths.childLeasePath)) throw fail("LEASE_FOREIGN_HOST");
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
      if (!sameMachineAt(child, paths.childLeasePath)) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(child, paths.childLeasePath)) return result("blocked", "LEASE_CHILD_BUSY");
    }
    const primary = read(paths.leasePath, "primary");
    if (primary) {
      if (!sameMachineAt(primary, paths.leasePath)) return result("blocked", "LEASE_FOREIGN_HOST");
      if (ownerIsAlive(primary, paths.leasePath)) return result("blocked", "LEASE_BUSY");
      let path = `${paths.leasePath}.reap-${primary.token}`;
      for (let generation = 0; generation < MAX_REAPER_GENERATIONS; generation++) {
        const reaper = read(path, "reaper", primary.token);
        if (!reaper) break;
        if (!sameMachineAt(reaper, path)) return result("blocked", "LEASE_FOREIGN_HOST");
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
      recordOwnMachine(path, owner);
      try { guard(); }
      catch (error) { heldTokens.delete(owner.token); removeOwnedRecord(path, owner); removeMachineNote(path, owner); throw error; }
      return owner;
    }
    let current;
    try { current = readRecord(path)?.owner; }
    catch (error) { if (error?.raced) continue; throw error; }
    if (!current) continue;
    if (!sameMachineAt(current, path)) throw fail("LEASE_FOREIGN_HOST");
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
      || !sameMachineAt(owner, paths.leasePath) || !ownerIsAlive(owner)) throw fail("LEASE_DELEGATION_INVALID");
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

/** External-child probes deliberately exclude the current-process held-token shortcut. */
export { validBoot, validUptime, localHost, sameMachine, bootSession, uptimeMs, linuxProcStat, processIsAlive, probeProcessStartSync, darwinProcessStart };

/** This process's currently held installation lease generation, never child death proof. */
export function currentDataDirLeaseEpoch(dataDir) {
  try {
    const paths=dataDirLeasePaths(dataDir);
    for(const path of [paths.childLeasePath,paths.leasePath]){
      const owner=readRecord(path)?.owner;
      if(owner&&owner.pid===process.pid&&heldTokens.has(owner.token)&&sameMachineAt(owner,path))return owner.token;
    }
  }catch{/* Unknown ownership cannot establish Signal coverage. */}
  return null;
}

// Network and cluster filesystems: a folder on one may be in use by another
// computer right now, so its lock files are never set aside from here.
const NETWORK_FS = /^(nfs4?|cifs|smb[23]?|smbfs|afpfs|webdav|davfs|fuse\.sshfs|sshfs|9p|ceph|glusterfs|gfs2?|ocfs2|lustre|afs|beegfs|gpfs|virtiofs|fuse\.rclone)$/;
const unescapeMount = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
/** Whether every path lies on a local volume: the longest mount point
 * holding it is local (macOS mount says "local"; Linux names a non-network
 * filesystem). Anything unreadable, and every other platform, is not local. */
export function pathsOnLocalVolume(targets, platform = process.platform) {
  let mounts;
  try {
    if (platform === "darwin") {
      const raw = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      mounts = String(raw).split("\n").map((line) => /^.+? on (\/.*) \(([^()]*)\)$/.exec(line))
        .filter(Boolean).map((match) => ({ point: match[1], local: match[2].split(",").map((part) => part.trim()).includes("local") }));
    } else if (platform === "linux") {
      mounts = readFileSync("/proc/self/mounts", "utf8").split("\n").map((line) => line.split(" ")).filter((fields) => fields.length >= 3)
        .map((fields) => ({ point: unescapeMount(fields[1]), local: !NETWORK_FS.test(fields[2]) }));
    } else return false;
  } catch { return false; }
  if (!mounts.length) return false;
  return targets.every((target) => {
    let real;
    try { real = realpathSync.native(target); } catch { return false; }
    const holder = mounts.filter(({ point }) => point === "/" || real === point || real.startsWith(`${point}/`))
      .sort((a, b) => b.point.length - a.point.length)[0];
    return holder?.local === true;
  });
}

const UUID_TEXT = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RECORD_SUFFIX = new RegExp(`^(?:|\\.child|\\.closing-${UUID_TEXT}|\\.reap-${UUID_TEXT}(?:-[0-9a-f]{32})*)$`);
const SIDE_SUFFIX = new RegExp(`^(?:\\.child|\\.reap-${UUID_TEXT}(?:-[0-9a-f]{32})*)?\\.(?:identity|alive|machine)-${UUID_TEXT}$`);
function setAsidePlan(paths) {
  const dir = dirname(paths.leasePath);
  const base = basename(paths.leasePath);
  let names;
  try { names = readdirSync(dir); } catch (error) { throw fail("LEASE_IO", error); }
  const records = [], sides = [];
  for (const name of names) {
    if (name !== base && !name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length);
    // The restore marker (.lease.restore.json), candidates mid-publication
    // and anything set aside before are never part of the lock; they stay.
    if (RECORD_SUFFIX.test(suffix)) records.push(join(dir, name));
    else if (SIDE_SUFFIX.test(suffix)) sides.push(join(dir, name));
  }
  return { records, sides };
}

/** Whether "This is my computer, continue" may be offered: inspection reports
 * a foreign claim and the installation and its lock files are on a local
 * volume (a network folder may really be in use by another computer). */
export function foreignDataDirLeaseSetAsideAvailable(dataDir, { localVolume = pathsOnLocalVolume } = {}) {
  try {
    if (inspectDataDirLease(dataDir).code !== "LEASE_FOREIGN_HOST") return false;
    const paths = dataDirLeasePaths(dataDir);
    return localVolume([dirname(paths.leasePath), ...(existsSync(paths.canonicalDataDir) ? [paths.canonicalDataDir] : [])]) === true;
  } catch { return false; }
}

/** The owner said this computer is the only one using this installation
 * ("This is my computer, continue"). Sets the foreign lock records aside by
 * renaming them to `<name>.foreign-<time>` (never deleting, never touching
 * the installation or the restore marker), only when every record is
 * readable and none names a process that may be alive: a same-machine live
 * owner is LEASE_BUSY; a foreign record whose PID is alive here on a boot
 * that cannot be proved over is refused. Any doubt renames nothing. */
export function setAsideForeignDataDirLease(dataDir, { localVolume = pathsOnLocalVolume, now = Date.now } = {}) {
  if (!foreignDataDirLeaseSetAsideAvailable(dataDir, { localVolume })) throw fail("LEASE_TAKEOVER_REFUSED");
  const paths = dataDirLeasePaths(dataDir);
  const { records, sides } = setAsidePlan(paths);
  const checked = [];
  for (const path of records) {
    const suffix = path.slice(paths.leasePath.length);
    const validate = suffix.startsWith(".reap-")
      ? (value) => typeof value?.targetToken === "string" && isOwner(value, value.targetToken) : undefined;
    const read = readRecord(path, undefined, validate);
    if (!read) continue;
    const owner = read.owner;
    // Primary and child carry a liveness identity; recovery claims and seals
    // are checked by PID and boot only, as acquisition checks them.
    const identityFor = suffix === ".child" || suffix === "" ? path : undefined;
    if (sameMachineAt(owner, path)) {
      if (ownerIsAlive(owner, identityFor)) throw fail(suffix === ".child" ? "LEASE_CHILD_BUSY" : "LEASE_BUSY");
    } else if (!provedOwnerReboot(owner) && processIsAlive(owner.pid)) {
      throw fail("LEASE_TAKEOVER_REFUSED");
    }
    checked.push({ path, stat: read.stat });
  }
  const stamp = new Date(now()).toISOString().replace(/[-:.]/g, "");
  const target = (path) => `${path}.foreign-${stamp}`;
  for (const path of [...checked.map((entry) => entry.path), ...sides]) {
    if (existsSync(target(path))) throw fail("LEASE_RECOVERY_BUSY");
  }
  // Recovery claims and seals first, the primary record last, then the
  // token-scoped side files, which nothing reads once their record is gone.
  checked.sort((a, b) => (a.path === paths.leasePath) - (b.path === paths.leasePath));
  let moved = 0;
  for (const { path, stat } of checked) {
    let current;
    try { current = lstatSync(path); } catch (error) { throw absent(error) ? fail("LEASE_RECOVERY_BUSY") : fail("LEASE_IO", error); }
    if (!current.isFile() || !sameFile(stat, current)) throw fail("LEASE_RECOVERY_BUSY");
    try { renameSync(path, target(path)); moved++; } catch (error) { throw fail("LEASE_IO", error); }
  }
  for (const path of sides) {
    try { renameSync(path, target(path)); moved++; } catch { /* inert, token-scoped leftover */ }
  }
  return moved;
}
