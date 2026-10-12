// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Loads the native addon that takes real exclusion on a coding engine's file (native/engine-exclusion/exclusion.c): the engine's
// own whole-file lock, the list of running processes (so Murage knows whether an engine is open), an atomic rename that never
// replaces, and (Windows) handles nobody else can open. Node has none of these. Only engine-fs.ts imports this module, and it exposes the
// result as `exclOps`.
//
// Where it looks: the app's resources folder ($MURAGE_RESOURCES_PATH/engine-exclusion.node) and dist-native/engine-exclusion/
// <platform>-<arch>/ in a source checkout. $MURAGE_ENGINE_EXCLUSION_PATH (a test stand-in or a test build) is honoured ONLY when
// the process is a test (NODE_ENV=test) that is not packaged (no MURAGE_PACKAGED, no resources folder); it is decided before any
// file is loaded, because loading a module runs its code. A missing or broken addon is `null`: the executor then changes no engine
// file at all and says the helper is missing (HelperError in engine-plan-core.ts).
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
  /** Windows: kind 0 share-none, 1 share-none with the right to delete, 2 shared with every other opener (for a lock). null when
   * something else has the file open. */
  openFile?(path: string, kind: number): NativeHandle | null;
  handleRead?(handle: NativeHandle, length: number, position: number): Buffer;
  handleWrite?(handle: NativeHandle, bytes: Buffer, position: number): void;
  handleSync?(handle: NativeHandle): void;
  handleLock?(handle: NativeHandle): boolean;
  handleMarkDelete?(handle: NativeHandle): boolean;
  handleId?(handle: NativeHandle): [bigint, bigint];
  handleSize?(handle: NativeHandle): number;
  handleClose?(handle: NativeHandle): void;
  version(): number;
}

/** A running process as the addon reports it. `mine`: this user's (null: could not be told). `exe` "" is a process with no program
 * (a zombie); null is one that could not be read. `argv` null: could not be read (Windows: the whole command line is one element). */
export interface NativeProcess {
  pid: number; ppid: number; mine: boolean | null; start: number; exe: string | null; argv: string[] | null;
  /** the user it runs as (macOS, Linux); null where the system has none or it could not be read */
  uid?: number | null;
  /** the name the system gives the process (macOS pbi_comm, Linux /proc/<pid>/comm, Windows the executable's file name); null: could not be read */
  comm?: string | null;
}

export const ADDON_VERSION = 4;

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

function usable(addon: Partial<ExclusionAddon>): addon is ExclusionAddon {
  if (typeof addon.lock !== "function" || typeof addon.processes !== "function" || typeof addon.renameNoReplace !== "function" || typeof addon.version !== "function") return false;
  try { if (addon.version() !== ADDON_VERSION) return false; } catch { return false; }
  if (process.platform === "win32") for (const name of HANDLE_FUNCTIONS) if (typeof addon[name] !== "function") return false;
  return true;
}

let loaded: ExclusionAddon | null | undefined;

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
    write: (bytes, position) => { addon.handleWrite!(live(), bytes, position); },
    sync: () => { addon.handleSync!(live()); },
    lock: () => addon.handleLock!(live()),
    markDelete: () => addon.handleMarkDelete!(live()),
    id: () => { const [dev, ino] = addon.handleId!(live()); return { dev, ino }; },
    size: () => addon.handleSize!(live()),
    close: () => { if (!open) return; open = false; addon.handleClose!(native); },
  };
}
