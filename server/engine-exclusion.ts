import { windowsCodeIntegrityBlock } from "./windows-code-integrity.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the native addon that takes real exclusion on a coding engine's file (native/engine-exclusion/exclusion.c): the engine's
// own whole-file lock, the list of running processes (so Murage knows whether an engine is open), an atomic rename that never
// replaces, (Windows) handles nobody else can open, and (Windows) a tree removal by handle that never follows a junction
// (link-removal.ts), plus (Windows) the calls that replaced Murage's own PowerShell starts. Node has none of these. engine-fs.ts
// exposes the engine-file result as `exclOps`; the Windows-only callers take it through requireWindowsAddon().
//
// Where it looks: the app's resources folder ($MURAGE_RESOURCES_PATH/engine-exclusion.node) and dist-native/engine-exclusion/
// <platform>-<arch>/ in a source checkout. $MURAGE_ENGINE_EXCLUSION_PATH (a test stand-in or a test build) is honoured ONLY when
// the process is a test (NODE_ENV=test) that is not packaged (no MURAGE_PACKAGED, no resources folder); it is decided before any
// file is loaded, because loading a module runs its code. A missing or broken addon is `null`: the executor then changes no engine
// file at all and says the helper cannot load on this system (HelperError "helper-unloadable" in engine-plan-core.ts). That covers a
// missing file, a require() the loader refuses (an older glibc), and an addon of another version; it is looked for once per process.
import { createRequire } from "node:module";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { realCleanupHost, removeOwnCopyDir, sweepStaleMeterCopies, writeCopyMarker } from "./meter-copy-cleanup.ts";

import type { HeldFile } from "./engine-plan-core.ts";
import { dataDirLeasePaths } from "./data-dir-lease.ts";

/** An opaque handle the addon owns (Windows). JS never reads it; it only hands it back to the addon's handle functions. */
export type NativeHandle = object;

export interface IoGrantState {
  sqlDeadline?: boolean;
 rawBytes:number; threadRawBytes:number; backgroundProcess:number; live:boolean; usedBytes:number; capBytes:number; refusedWrites:number;
 ceilingMiss:number; wallTime:number; pageSize:number; readBytes:number; threadReadBytes:number; chargedBytes:number;
}
export interface ExclusionAddon {
  /** Password admission requires OS core dump prevention in this process. */
  disableCoreDumps?(): boolean;
  ioFgBegin?():void;
  ioFgEnd?():IoGrantState;
  ioGrantBegin?(bytes:number,expiresAt:number):void;
  ioGrantEnd?():IoGrantState;
  ioGrantSnapshot?():IoGrantState;
  ioGrantCharge?(bytes:number):void;
  ioAllBg?():void;
  ioMeterUnknown?():void;
  ioMeterAdd?(source:string,bytes:number):void;
  ioMeterBytes?(source:string):number;
  ioMeterTotal?():number|null;
  ioMeterSnapshot?():{total:number;known:boolean;buckets:Array<[string,number]>};
  /** Takes the engine's whole-file lock on `fd`, waiting up to one second. False if another process keeps it. (macOS, Linux) */
  lock(fd: number): boolean;
  /** Every process on this computer. A process that could not be inspected is listed with null where it could not be read. */
  processes(): NativeProcess[];
  /** Renames `from` to `to` atomically and never over an existing name: 0 done, 1 `to` exists, 2 the file system cannot do that.
   * Any other failure throws with the errno name as `code`. */
  renameNoReplace(from: string, to: string): number;
  /** Windows only, additive (no ADDON_VERSION change, not in WINDOWS_NATIVE_FUNCTIONS): MoveFileExW REPLACE_EXISTING|WRITE_THROUGH. Returns 0 once the move is on disk; throws with an errno code. Absent in an older build and on other systems. */
  renameDurable?(from: string, to: string): number;
  /** Windows: kind 0 share-none, 1 share-none with the right to delete, 2 shared with every other opener (for a lock), 3 shared and
   * read only (to look at a lock), 4 a plain directory opened writable for a namespace durability barrier. null when something else has the file open. */
  openFile?(path: string, kind: number): NativeHandle | null;
  handleRead?(handle: NativeHandle, length: number, position: number): Buffer;
  /** ONE write at `position`; returns how many bytes it put (the caller asks its guard again before writing the rest) */
  handleWrite?(handle: NativeHandle, bytes: Buffer, position: number): number;
  handleSync?(handle: NativeHandle): void;
  handleLock?(handle: NativeHandle): boolean;
  handleMarkDelete?(handle: NativeHandle): boolean;
  handleId?(handle: NativeHandle): [bigint, bigint];
  handleSize?(handle: NativeHandle): number;
  handleClose?(handle: NativeHandle): void;
  /** macOS, Linux: the OTHER processes that have one of the files at `paths` open for writing (by device and inode; `index` says which
   * path), and those whose open files could not be read (with the user they run as; null: could not be told). */
  writers?(paths: string[]): FileWriters;
  /** All platforms: the values of `names` in the environment of process `pid`, only the ones it has (Windows matches a name in any case),
   * or null when it cannot be read: gone, another user's, protected, or (Windows) a 32-bit process on 64-bit Windows. macOS
   * KERN_PROCARGS2, Linux /proc/<pid>/environ, Windows the process's PEB. Absent in an older build (engine-closed.ts then counts every
   * engine process, as before). */
  environment?(pid: number, names: string[]): Record<string, string> | null;
  /** macOS, Linux: makes the file's (or folder's) contents durable through the drive's cache (macOS F_FULLFSYNC), and says which barrier
   * it was: "full", or "fallback" (macOS: the file system refuses F_FULLFSYNC, as Apple documents for one without it; plain fsync). */
  fullSync?(fd: number): Barrier;
  version(): number;
  /** macOS (IO-IDLE r3.6): this process's cumulative bytes written to storage (proc_pid_rusage ri_diskio_byteswritten), null when
   *  unreadable; absent elsewhere. The io watchdog's OS floor on macOS (os-disk-written.ts): missing or null is UNKNOWN, never 0. */
  diskWritten?(): number | null;
  /** macOS: this boot of the system's own id (kern.bootsessionuuid); null elsewhere or when it cannot be read. Absent in an older build. */
  bootId?(): string | null;
  /** Windows: WinVerifyTrust's answer for a file's Authenticode signature, on a worker thread: { status (Get-AuthenticodeSignature's
   * names), publisher (the signer's simple name when Valid), code }. Absent in an older build. */
  authenticode?(path: string): Promise<{ status: string; publisher: string; subject?: string; code: number }>;
  /** Windows: removes `path` and everything under it by handle, never following a symlink or junction and never resolving a path
   * below `path` again (link-removal.ts). true removed, false nothing there; throws with a Node errno name as `code`.
   * `beforeFolder` (tests) runs after each folder is opened and before it is listed. Absent in an older build. */
  removeTree?(path: string, beforeFolder?: (relative: string) => void): boolean;
  // Windows, version 8: the calls that replaced every PowerShell Murage started itself (murage-releases #1).
  /** A new named job (Local\\murage-pip-<id>), KILL_ON_JOB_CLOSE, whose only handle is this process's. Throws EEXIST when the name is taken. */
  jobCreate?(name: string): NativeHandle;
  /** Puts `pid` in the job; when that fails the process is ended at once with `refusalCode` and the answer is false. */
  jobAssign?(job: NativeHandle, pid: number, refusalCode: number): boolean;
  /** Closes this process's handle: Windows then ends every process still in the job. */
  jobClose?(job: NativeHandle): void;
  /** Opens the job by name, terminates it and waits up to waitMs for its members to be gone (worker thread). Rejects when it cannot. */
  jobStop?(name: string, waitMs: number): Promise<{ state: "absent" } | { state: "present"; activeProcesses: number }>;
  /** The process's creation FILETIME in decimal (.NET StartTime.ToFileTimeUtc()), or null when it cannot be read. */
  processStart?(pid: number): string | null;
  terminateIfStart?(pid: number, start: string): string;
  processPresence?(pid: number): string;
  /** The drive type (.NET DriveInfo names: Fixed, Removable, Network, ...) and file system of the volume holding `path`, or null. */
  driveInfo?(path: string): { type: string; format: string } | null;
  /** The owner SID of the file or folder itself (a link is not followed), or null. */
  fileOwnerSid?(path: string): string | null;
  /** LookupAccountNameW's SID for an account name in any display language, or null. */
  accountSid?(name: string): string | null;
  /** This computer's own account-domain SID, or null. */
  machineSid?(): string | null;
  /** Version 9: this computer's account domain, the AD domain it is joined to and that domain's forest root (LSA policy), each a
   * domain SID or null (a workgroup computer has no primary or forest root). Throws when the policy cannot be read. */
  domainSids?(): { account: string | null; primary: string | null; forestRoot: string | null };
  /** Version 10: removes both shutdown privileges from this process's primary token and verifies that neither remains. */
  dropShutdownPrivileges?(): { ok: true } | { ok: false; step: "open" | "lookup" | "adjust" | "verify"; error: number };
  /** The installed SAPI voices: { name (the id System.Speech gives), culture, description }. */
  speechVoices?(): Promise<Array<{ name: string; culture: string; description: string }>>;
  /** One utterance (plain text) to a 22,050 Hz 16-bit mono WAV file; true when `voice` was found and used, false for the default voice. */
  speechToWave?(text: string, voice: string, path: string): Promise<boolean>;
  /** Windows (DELETION-WHILE-OPEN-107): another process's working folder, from its PEB; null when it cannot be read. Absent in an older
   * build: the open-home pass then does not run on Windows (engine-closed.ts holdersClearOf fails closed). */
  cwdOf?(pid: number): string | null;
  // Windows, version 11 (CONTRACTS-B 1.3, native/engine-exclusion/anchored-win.c): the anchored opens the Claude Code import reads through.
  // The shapes are WinAnchor in server/claude-code-import.ts; they are `unknown` here so this file stays free of that one.
  anchorBegin?(home: string, budgetMs: number): unknown;
  anchorOpen?(parent: unknown, name: string, want: "dir" | "file"): unknown;
  anchorList?(dir: unknown): unknown;
  anchorRead?(file: unknown, position: number, length: number): Buffer;
  anchorStat?(handle: unknown): unknown;
  anchorClose?(handle: unknown): void;
  anchorEnd?(session: unknown): boolean;
  /** Test-hooks build only (-DANCHOR_TEST_HOOKS, never packaged): the shipped loader and after-pack refuse an addon that exports either. */
  anchorTestStall?(eventName: string): void;
  anchorTestFail?(query: string): void;
}

/** A running process as the addon reports it. `mine`: this user's (null: could not be told). `exe` "" is a process with no program
 * (a zombie; on Windows, a process that has ended while a handle to it is still open); null is one that could not be read. `argv` null: could not be read (Windows: the process's own command line, split as CommandLineToArgvW splits it, exclusion.c). */
export interface NativeProcess {
  pid: number; ppid: number; mine: boolean | null; start: number; exe: string | null; argv: string[] | null;
  /** the user it runs as (macOS, Linux); null where the system has none or it could not be read */
  uid?: number | null;
  /** the name the system gives the process (macOS pbi_comm, Linux /proc/<pid>/comm, Windows the executable's file name); null: could not be read */
  comm?: string | null;
}

/** Who has a set of files open for writing (ExclusionAddon.writers). `openForWrite` (Linux): the kernel's own answer for every process,
 * readable or not (a read lease): false, none has one of them open for writing; true, one does; null or absent, it could not be told. */
export interface FileWriters { writers: Array<{ pid: number; index: number }>; unreadable: Array<{ pid: number; uid: number | null }>; openForWrite?: boolean | null }

/** Which durability barrier a sync gave (ExclusionAddon.fullSync): "full" through the drive's own cache (macOS F_FULLFSYNC; Linux fsync;
 * Windows FlushFileBuffers), "fallback" the plain fsync of a macOS file system that has no F_FULLFSYNC (the documented fallback), "none"
 * a sync that reported no barrier at all (no addon to ask). A journal is dropped at once only after "full"; after "fallback" it stays
 * until a later start reads the bytes again and finds them as written (engine-exec.ts durableBarrier). */
export type Barrier = "full" | "fallback" | "none";

/** 7: fullSync says which barrier it gave. 8: the Windows calls that replaced PowerShell. 9: domainSids, and jobAssign ends a
 * process it cannot open. 10: removes and verifies the Windows shutdown privileges. 11: the Windows anchored-open helper (anchor*). */
export const ADDON_VERSION = 11;

/** The override is for tests only: not in a packaged app, and never outside a test process. */
export function overrideAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" && !env.MURAGE_PACKAGED && !env.MURAGE_RESOURCES_PATH && !env.OMB_RESOURCES_PATH;
}

// import.meta is empty when this file is bundled to CommonJS (esbuild format "cjs", as link-removal.electron.test.ts does); the
// bundle's own __filename stands in there.
function moduleFile(): string {
  const url = import.meta.url;
  if (typeof url === "string" && url) return fileURLToPath(url);
  return typeof __filename === "string" ? __filename : path.join(process.cwd(), "engine-exclusion.cjs");
}

function candidates(): string[] {
  const here = path.dirname(moduleFile());
  const out: string[] = [];
  if (overrideAllowed()) {
    const trimmed = process.env.MURAGE_ENGINE_EXCLUSION_PATH?.trim();
    if (trimmed) out.push(path.resolve(trimmed));
  }
  const rawResources = process.env.MURAGE_RESOURCES_PATH ?? process.env.OMB_RESOURCES_PATH;
  // A relative resources root is skipped, never resolved against the working directory.
  if (rawResources && path.isAbsolute(rawResources)) out.push(path.resolve(path.join(rawResources, "engine-exclusion.node")));
  out.push(path.resolve(path.join(here, "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node")));
  out.push(path.resolve(path.join(here, "..", "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node")));
  return out;
}

/** The resolved test override when the gate is open and the trimmed value is non-empty, else undefined (the same path.resolve as candidates()). */
function explicitOverride(): string | undefined {
  if (!overrideAllowed()) return undefined;
  const trimmed = process.env.MURAGE_ENGINE_EXCLUSION_PATH?.trim();
  return trimmed ? path.resolve(trimmed) : undefined;
}

export const HANDLE_FUNCTIONS = ["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose"] as const;
/** Windows, version 10: the native calls and shutdown privilege removal. A packaged build that lacks one is refused when it is assembled
 * (scripts/engine-exclusion-resource.mjs). */
export const WINDOWS_NATIVE_FUNCTIONS = ["authenticode", "jobCreate", "jobAssign", "jobClose", "jobStop", "processStart", "driveInfo", "fileOwnerSid", "accountSid", "machineSid", "domainSids", "dropShutdownPrivileges", "speechVoices", "speechToWave", "anchorBegin", "anchorOpen", "anchorList", "anchorRead", "anchorStat", "anchorClose", "anchorEnd"] as const;

/** Every export only the test-hooks build has (R8, R16). The loader refuses a build exporting ANY name that starts with the prefix, so a new
 * hook cannot ship by being left off this list; the list names each one so each is tested on its own. */
export const ANCHOR_TEST_PREFIX = "anchorTest";
export const ANCHOR_TEST_EXPORTS = ["anchorTestStall", "anchorTestStallOpen", "anchorTestRelease", "anchorTestFail", "anchorTestWhy", "anchorTestDropPrivileges", "anchorTestStallMs", "anchorTestStallExit", "anchorTestStats", "anchorTestCorruptName", "anchorTestDeadlineAtPost", "anchorTestHeapMark", "anchorTestHeapCheck", "anchorTestHeapLeaks", "anchorTestHeapCanary", "anchorTestSchedule", "anchorTestWaitSettled", "anchorTestGateReset"] as const;

/** Whether an addon may be used (test seam: tests hand it a plain object). */
export function addonIsUsable(addon: Partial<ExclusionAddon>, override = false): addon is ExclusionAddon { return usable(addon, override); }

function usable(addon: Partial<ExclusionAddon>, override = false): addon is ExclusionAddon {
  if (typeof addon.lock !== "function" || typeof addon.processes !== "function" || typeof addon.renameNoReplace !== "function" || typeof addon.version !== "function") return false;
  try { if (addon.version() !== ADDON_VERSION) return false; } catch { return false; }
  // R16: a build that exports a test hook is loaded only through the test-only override, never from a packaged location.
  if (!override && Object.keys(addon).some((name) => name.startsWith(ANCHOR_TEST_PREFIX))) return false;
  if (process.platform === "win32") for (const name of [...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS]) if (typeof addon[name] !== "function") return false;
  if (process.platform !== "win32" && (typeof addon.writers !== "function" || typeof addon.fullSync !== "function")) return false;
  return true;
}

let loaded: ExclusionAddon | null | undefined;
let loadedPath:string|undefined;
let windowsBlocked = false;
/** Retains the loader verdict for the turn card; this never changes addon admission. */
export function exclusionAddonBlockedByWindows(): boolean { loadExclusionAddon(); return loaded === null && windowsBlocked; }
export function exclusionAddonPath():string|undefined { loadExclusionAddon(); return loadedPath; }

/** The addon for one of the Windows calls that replaced a PowerShell start. Never a silent fallback: without it the call throws a
 * plain sentence (a packaged build always carries it; a source checkout without a build refuses the feature). */
export function requireWindowsAddon(): ExclusionAddon {
  const addon = loadExclusionAddon();
  if (!addon) throw Object.assign(new Error("Murage's Windows helper (engine-exclusion.node) is missing or out of date. Reinstall Murage to repair it."), { code: "ENGINE_EXCLUSION_MISSING" });
  return addon;
}

/** Looks for the addon again on the next use (tests that switch between the stand-in and the real build). */
export function forgetExclusionAddon(): void { loaded = undefined; loadedPath=undefined; windowsBlocked = false; }

/** The addon, or null when it is not there or will not load. Looked for once. */
export function loadExclusionAddon(): ExclusionAddon | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  const require = createRequire(moduleFile());
  for (const file of candidates()) {
    if (!existsSync(file)) continue;
    try {
      const addon = require(file) as Partial<ExclusionAddon>;
      const explicit = explicitOverride();
      if (usable(addon, Boolean(explicit) && file === explicit)) {
        loaded = addon; loadedPath=file;
        break;
      }
    } catch (error) {
      if (process.platform === "win32" && windowsCodeIntegrityBlock(error)) windowsBlocked = true;
    }
  }
  return loaded;
}

/** Folders this thread made. The main thread removes them at exit (the copy is no longer needed then); a Windows process cannot delete the .node it
 * has loaded, so a folder that cannot go is left for the next start's sweep, which recognises it by its marker's dead pid. */
const ownCopyDirs = new Set<string>();
let ownCopyExitHook = false;
function trackOwnCopyDir(dir: string): void {
  ownCopyDirs.add(dir);
  if (!isMainThread || ownCopyExitHook) return;
  ownCopyExitHook = true;
  process.once("exit", () => { for (const own of ownCopyDirs) removeOwnCopyDir(own); });
}
let staleSwept = false;

/** The identity of the private copy the meter chain loads: the same bytes at the parent's require, the SQLite load and the worker's require. */
export interface IoMeterFileId { dev: number; ino: number; size: number; sha256: string }
const insideDir = (child: string, parent: string): boolean => { const rel = path.relative(parent, child); return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); };
function readFd(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size); let off = 0;
  while (off < size) { const n = readSync(fd, buf, off, size - off, off); if (!n) break; off += n; }
  if (off !== size) throw new Error("short read");
  return buf;
}
/** P5g: for the one candidate about to be executed: a regular file (lstat), canonical (realpath === file), opened O_NOFOLLOW twice with the same
 * dev, ino and size; its bytes are read from the descriptor, hashed (sha256) and written to an O_EXCL, mode 0600 file in a fresh 0700 directory
 * outside the working directory, the data directory, the resources root and the module directory. A mismatch returns null (the candidate is skipped). */
function privateCopy(file: string): { copy: string; id: IoMeterFileId } | null {
  const st = lstatSync(file);
  if (!st.isFile() || realpathSync(file) !== file) return null;
  const nofollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(file, fsConstants.O_RDONLY | nofollow);
  let bytes: Buffer;
  try {
    const first = fstatSync(fd);
    const fd2 = openSync(file, fsConstants.O_RDONLY | nofollow);
    try { const second = fstatSync(fd2); if (!first.isFile() || first.dev !== second.dev || first.ino !== second.ino || first.size !== second.size) return null; }
    finally { closeSync(fd2); }
    bytes = readFd(fd, first.size);
  } finally { closeSync(fd); }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The first temporary folder outside every protected directory (launchers may put TMPDIR inside the data folder).
  // Roots and unresolvable hints must not disable the remaining protections.
  const forbidden = [process.cwd(), process.env.MURAGE_DATA_DIR ?? path.join(homedir(), ".murage"), process.env.MURAGE_RESOURCES_PATH, process.env.OMB_RESOURCES_PATH, path.dirname(moduleFile())]
    .filter((root): root is string => !!root)
    .flatMap(root => { try { return [dataDirLeasePaths(root).canonicalDataDir]; } catch { return []; } });
  let base: string | null = null;
  for (const candidate of process.platform === "win32" ? [tmpdir()] : [tmpdir(), "/tmp", "/var/tmp"]) {
    let real: string;
    try { real = realpathSync.native(candidate); } catch { continue; }
    const comparable = process.platform === "win32" ? real.toLowerCase() : real;
    if (!forbidden.some(root => insideDir(comparable, root))) { base = real; break; }
  }
  if (base === null) throw new Error("no temporary directory outside the protected directories for the private copy");
  const dir = realpathSync(mkdtempSync(path.join(base, "murage-meter-")));
  trackOwnCopyDir(dir);
  writeCopyMarker(dir);
  const copy = path.join(dir, "engine-exclusion.node");
  const out = openSync(copy, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | nofollow, 0o600);
  let dev: number, ino: number;
  try {
    let at = 0;
    while (at < bytes.length) { const n = writeSync(out, bytes, at, bytes.length - at, at); if (!(n > 0)) throw new Error("the private copy made no write progress"); at += n; }
    const copied = fstatSync(out); dev = copied.dev; ino = copied.ino;
  } finally { closeSync(out); }
  // The copy is proven by reading it back, not by a durability barrier: a fresh no-follow descriptor must see the same inode and size and bytes
  // with the published sha256, so a short or foreign write is never executed. The copy is this process's scratch (removed at exit, swept after a
  // crash), so it takes no fsync; a barrier here ran inside the first durable write that loads the meter and reordered that write's own syncs.
  const back = openSync(copy, fsConstants.O_RDONLY | nofollow);
  try {
    const seen = fstatSync(back);
    if (!seen.isFile() || seen.dev !== dev || seen.ino !== ino || seen.size !== bytes.length || createHash("sha256").update(readFd(back, seen.size)).digest("hex") !== sha256) { removeOwnCopyDir(dir); return null; }
  } finally { closeSync(back); }
  return { copy, id: { dev, ino, size: bytes.length, sha256 } };
}

/** Once per process, main thread: removes the folders of dead processes beside our own (Windows reads owner and start time through this addon). */
function sweepOnce(ownCopy: string, addon: Partial<ExclusionAddon>): void {
  if (staleSwept || !isMainThread) return;
  staleSwept = true;
  try {
    const own = path.dirname(ownCopy);
    sweepStaleMeterCopies([path.dirname(own)], own, realCleanupHost(
      addon.fileOwnerSid ? target => addon.fileOwnerSid!(target) : undefined,
      addon.processStart ? pid => addon.processStart!(pid) : undefined));
  } catch { /* a failed sweep leaves folders for the next start */ }
}

/** METERDL: the one private copy of a process. Every loaded image of the addon keeps its thread-local meter state (meter.c METER_TLS) for the
 * life of the process, and macOS has a fixed number of thread-local keys: a fresh copy per worker aborted the server near the 498th worker
 * (_tlv_bootstrap_error in m_read). So only the main thread makes and proves the copy, and publishes its path and identity in the worker
 * environment data, which every Worker started afterwards (and every Worker those start) inherits. A worker loads that same file: same path,
 * same image, no new key and no new temporary folder. */
export const IO_METER_HANDOFF_KEY = "murage.ioMeterCopy";
interface IoMeterHandoff { path: string; id: IoMeterFileId; override: boolean }
/** Off the main thread: the main thread's proven copy, re-checked (canonical regular file, same dev/ino/size/sha256) before it executes. No hand-off,
 * or one that does not check out, leaves this thread unqualified (null); a worker never makes a copy of its own. */
function loadHandedIoMeter(require: NodeJS.Require):{addon:ExclusionAddon;path:string;id:IoMeterFileId}|null {
  let handed: Partial<IoMeterHandoff> | undefined;
  try { handed = getEnvironmentData(IO_METER_HANDOFF_KEY) as Partial<IoMeterHandoff> | undefined; } catch { return null; }
  const file = handed?.path, id = handed?.id;
  if (typeof file !== "string" || !path.isAbsolute(file) || !id || !Number.isSafeInteger(id.size) || typeof id.sha256 !== "string") return null;
  try {
    if (!lstatSync(file).isFile() || realpathSync(file) !== file) return null;
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.dev !== id.dev || st.ino !== id.ino || st.size !== id.size) return null;
      if (createHash("sha256").update(readFd(fd, st.size)).digest("hex") !== id.sha256) return null;
    } finally { closeSync(fd); }
    const addon = require(file) as Partial<ExclusionAddon>;
    if (!usable(addon, handed!.override === true && overrideAllowed()) || !addon.ioMeterAdd || !addon.ioMeterTotal || !addon.ioMeterBytes) return null;
    return { addon, path: file, id: { dev: id.dev, ino: id.ino, size: id.size, sha256: id.sha256 } };
  } catch { return null; }
}

/** Metering is independent of the engine-lock stand-in: select a qualified binary with a VFS entry point. Only the private copy is executed. */
export function loadIoMeterAddon():{addon:ExclusionAddon;path:string;id:IoMeterFileId}|null {
  const require=createRequire(moduleFile());
  if(!isMainThread)return loadHandedIoMeter(require);
  for(const file of candidates()){
    if(!existsSync(file))continue;
    let copyDir:string|null=null;
    try{
      const held=privateCopy(file);
      if(!held)continue;
      copyDir=path.dirname(held.copy);
      const addon=require(held.copy) as Partial<ExclusionAddon>;
      const explicit=explicitOverride();
      if(usable(addon,Boolean(explicit)&&file===explicit)&&addon.ioMeterAdd&&addon.ioMeterTotal&&addon.ioMeterBytes){
        sweepOnce(held.copy,addon);
        // A hand-off that cannot be published leaves later workers unqualified; it never costs this thread its meter.
        try{setEnvironmentData(IO_METER_HANDOFF_KEY,{path:held.copy,id:held.id,override:Boolean(explicit)&&file===explicit} satisfies IoMeterHandoff);}catch{/* workers fail closed */}
        return {addon,path:held.copy,id:held.id};
      }
      removeOwnCopyDir(copyDir);
    }catch{if(copyDir)removeOwnCopyDir(copyDir);/* a source checkout without a native build remains explicitly unqualified */}
  }
  return null;
}

/** A file the addon holds, as the rest of the deletion code sees it: every call goes into the addon, on the handle it owns. */
export function heldFileOf(addon: ExclusionAddon, native: NativeHandle): HeldFile {
  let open = true;
  const live = (): NativeHandle => { if (!open) throw Object.assign(new Error("the handle is closed"), { code: "EBADF" }); return native; };
  return {
    read: (length, position) => addon.handleRead!(live(), length, position),
    write: (bytes, position) => { const put = addon.handleWrite!(live(), bytes, position); return typeof put === "number" ? put : bytes.length; },
    sync: () => { addon.handleSync!(live()); },
    lock: () => addon.handleLock!(live()),
    markDelete: () => addon.handleMarkDelete!(live()),
    id: () => { const [dev, ino] = addon.handleId!(live()); return { dev, ino }; },
    size: () => addon.handleSize!(live()),
    close: () => { if (!open) return; open = false; addon.handleClose!(native); },
  };
}
