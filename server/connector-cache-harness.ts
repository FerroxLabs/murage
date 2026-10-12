// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The harness half of the connected-apps tool-list cache (the bridge half is
// connector-proxy.ts, the shared store is connector-cache.ts): deciding whether
// the cache directory may be used at all, handing a long approved list to the
// bridge through a private file, and removing what a disconnect made stale.
//
// Retention, in one place:
//   - entries older than CACHE_MAX_AGE_MS are never read and are deleted;
//   - the harness prunes at start and daily, the bridge on every write and hourly;
//   - everything is purged when an account is disconnected or the person signs out
//     (and the access revision changes, so a warm bridge stops serving its memory);
//   - the folder is excluded from backups (data-dir-inventory.ts);
//   - uninstalling Murage keeps the data folder like every other piece of state;
//     what remains there is bounded by the first rule (7 days without use).
import { existsSync, lstatSync, rmSync } from "node:fs";
import { createPrivateWindowsDirectory } from "../electron/browser-extension-windows.mjs";
import { bumpGeneration, INITIAL_TOOLS_IN_FILE, initialToolsFileName, privateCacheDir, pruneCacheDir, purgeCacheDir, writeCacheEntry } from "./connector-cache.ts";

export interface UsableCacheDir { dir: string; windowsPrivate: boolean }

const WINDOWS_RECHECK_MS = 5 * 60_000;
const windowsChecked = new Map<string, { at: number; ok: boolean }>();

/** The directory the bridge may use, or null (nothing is cached). POSIX: created
 * owner-only and verified. Windows: the native helper creates it with an
 * owner-and-SYSTEM-only ACL or refuses a directory that is broader; a refused
 * directory (a shared or migrated folder) is removed once and made again, since
 * everything in it can be fetched again, and when privacy still cannot be
 * established persistence is turned off rather than trusted. */
export function usableToolsCacheDir(
  dir: string,
  options: { platform?: string; makePrivate?: (dir: string) => void; now?: number } = {},
): UsableCacheDir | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return privateCacheDir({ dir, windowsVerified: false }, true, platform) ? { dir, windowsPrivate: false } : null;
  const now = options.now ?? Date.now();
  const known = windowsChecked.get(dir);
  if (known && now - known.at < WINDOWS_RECHECK_MS) return known.ok ? { dir, windowsPrivate: true } : null;
  const make = options.makePrivate ?? ((target: string) => createPrivateWindowsDirectory(target));
  let ok = false;
  try {
    make(dir);
    ok = true;
  } catch {
    try {
      if (existsSync(dir) && lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink()) {
        rmSync(dir, { recursive: true, force: true });
        make(dir);
        ok = true;
      }
    } catch { ok = false; }
  }
  windowsChecked.set(dir, { at: now, ok });
  return ok ? { dir, windowsPrivate: true } : null;
}
/** Test seam. */
export function forgetWindowsCacheChecks(): void { windowsChecked.clear(); }

/** Hands the complete approved list to the bridge through a private file named by
 * identity and revision. Returns the value for MURAGE_CONNECTOR_INITIAL_TOOLS, or
 * null when no private file could be written. */
export function handOverInitialTools(cache: UsableCacheDir | null, scope: { identity: string; revision: string }, tools: unknown[]): string | null {
  if (!cache) return null;
  const dir = privateCacheDir({ dir: cache.dir, windowsVerified: cache.windowsPrivate }, true);
  if (!dir) return null;
  return writeCacheEntry(dir, initialToolsFileName(scope), JSON.stringify({ revision: scope.revision, tools })) ? INITIAL_TOOLS_IN_FILE : null;
}

/** Everything remembered about connected apps goes (disconnect, sign-out). */
export function purgeToolsCache(dir: string | null): number {
  if (!dir) return 0;
  // Announce first: running bridges stop publishing under the old generation
  // (an in-flight list that lands after the purge is discarded or removed).
  bumpGeneration(dir);
  return purgeCacheDir(dir);
}

/** Deletes what has expired; the bridge does the same when it runs. */
export function pruneToolsCache(dir: string): void {
  pruneCacheDir(dir, Date.now(), true);
}
