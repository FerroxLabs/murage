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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HeldFile } from "./engine-plan-core.ts";

/** An opaque handle the addon owns (Windows). JS never reads it; it only hands it back to the addon's handle functions. */
export type NativeHandle = object;

export interface ExclusionAddon {
  /** Takes the engine's whole-file lock on `fd`, waiting up to one second. False if another process keeps it. (macOS, Linux) */
  lock(fd: number): boolean;
  /** Every process on this computer. A process that could not be inspected is listed with null where it could not be read. */
  processes(): NativeProcess[];
  /** Renames `from` to `to` atomically and never over an existing name: 0 done, 1 `to` exists, 2 the file system cannot do that.
   * Any other failure throws with the errno name as `code`. */
  renameNoReplace(from: string, to: string): number;
  /** Windows: kind 0 share-none, 1 share-none with the right to delete, 2 shared with every other opener (for a lock), 3 shared and
   * read only (to look at a lock). null when something else has the file open. */
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
  /** macOS: this boot of the system's own id (kern.bootsessionuuid); null elsewhere or when it cannot be read. Absent in an older build. */
  bootId?(): string | null;
  /** Windows: WinVerifyTrust's answer for a file's Authenticode signature, on a worker thread: { status (Get-AuthenticodeSignature's
   * names), publisher (the signer's simple name when Valid), code }. Absent in an older build. */
  authenticode?(path: string): Promise<{ status: string; publisher: string; code: number }>;
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
 * process it cannot open. 10: removes and verifies the Windows shutdown privileges. */
export const ADDON_VERSION = 10;

/** The override is for tests only: not in a packaged app, and never outside a test process. */
export function overrideAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" && !env.MURAGE_PACKAGED && !env.MURAGE_RESOURCES_PATH && !env.OMB_RESOURCES_PATH;
}

function candidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: string[] = [];
  if (overrideAllowed()) {
    const explicit = process.env.MURAGE_ENGINE_EXCLUSION_PATH?.trim();
    if (explicit) out.push(explicit);
  }
  const resources = process.env.MURAGE_RESOURCES_PATH ?? process.env.OMB_RESOURCES_PATH;
  if (resources) out.push(path.join(resources, "engine-exclusion.node"));
  out.push(path.join(here, "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node"));
  out.push(path.join(here, "..", "..", "dist-native", "engine-exclusion", `${process.platform}-${process.arch}`, "engine-exclusion.node"));
  return out;
}

const HANDLE_FUNCTIONS = ["openFile", "handleRead", "handleWrite", "handleSync", "handleLock", "handleMarkDelete", "handleId", "handleSize", "handleClose"] as const;
/** Windows, version 10: the native calls and shutdown privilege removal. A packaged build that lacks one is refused when it is assembled
 * (scripts/engine-exclusion-resource.mjs). */
export const WINDOWS_NATIVE_FUNCTIONS = ["authenticode", "jobCreate", "jobAssign", "jobClose", "jobStop", "processStart", "driveInfo", "fileOwnerSid", "accountSid", "machineSid", "domainSids", "dropShutdownPrivileges", "speechVoices", "speechToWave"] as const;

function usable(addon: Partial<ExclusionAddon>): addon is ExclusionAddon {
  if (typeof addon.lock !== "function" || typeof addon.processes !== "function" || typeof addon.renameNoReplace !== "function" || typeof addon.version !== "function") return false;
  try { if (addon.version() !== ADDON_VERSION) return false; } catch { return false; }
  if (process.platform === "win32") for (const name of [...HANDLE_FUNCTIONS, ...WINDOWS_NATIVE_FUNCTIONS]) if (typeof addon[name] !== "function") return false;
  if (process.platform !== "win32" && (typeof addon.writers !== "function" || typeof addon.fullSync !== "function")) return false;
  return true;
}

let loaded: ExclusionAddon | null | undefined;

/** The addon for one of the Windows calls that replaced a PowerShell start. Never a silent fallback: without it the call throws a
 * plain sentence (a packaged build always carries it; a source checkout without a build refuses the feature). */
export function requireWindowsAddon(): ExclusionAddon {
  const addon = loadExclusionAddon();
  if (!addon) throw Object.assign(new Error("Murage's Windows helper (engine-exclusion.node) is missing or out of date. Reinstall Murage to repair it."), { code: "ENGINE_EXCLUSION_MISSING" });
  return addon;
}

/** Looks for the addon again on the next use (tests that switch between the stand-in and the real build). */
export function forgetExclusionAddon(): void { loaded = undefined; }

/** The addon, or null when it is not there or will not load. Looked for once. */
export function loadExclusionAddon(): ExclusionAddon | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  const require = createRequire(import.meta.url);
  for (const file of candidates()) {
    if (!existsSync(file)) continue;
    try {
      const addon = require(file) as Partial<ExclusionAddon>;
      if (usable(addon)) {
        loaded = addon;
        break;
      }
    } catch { /* the next candidate */ }
  }
  return loaded;
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
