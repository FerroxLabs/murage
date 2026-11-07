// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-MEANS-IT (1.0.20, design r4 section 5): the gate's side of DL. The real disk hooks for the per-text
// TextBudget, and the scan's registry hook bound to the install's DownloadRegistry. The scan hands words and the cwd
// over in their ORIGINAL case (MurageMain ruling, 11-05); the registry folds its own keys, and every disk check here
// uses the name as given, so a mixed-case path is found on a case-sensitive disk. Strip-only TypeScript.

import fs from "node:fs";
import type { DownloadRegistry, FsHooks, MatchOptions } from "./download-registry.ts";
import type { OutsideScanHooks } from "./outside-scan.ts";

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** lstat and realpath on the real disk. ENOENT is "not there" (null); any other failure throws, which the TextBudget
 *  turns into "failed" (a hit, fail closed). */
export function nodeFsHooks(): FsHooks {
  return {
    lstat(p: string) {
      try {
        const stat = fs.lstatSync(p);
        return { dir: stat.isDirectory(), ctime: stat.ctimeMs };
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    realpath(p: string) {
      try {
        return fs.realpathSync.native(p);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
  };
}

/** The scan's `registry` hook for one text: each word (or the implied cwd) is Matched by steps 1-4, with 2c when the scan
 *  says the word is searched. `options` carries the text's one TextBudget, shared with registration and 6.2. */
export function scanRegistryHook(registry: DownloadRegistry, options: MatchOptions): NonNullable<OutsideScanHooks["registry"]> {
  return (word, implied, searched) => registry.match(word, { ...options, searched: implied || searched });
}

/** The scan's `repo` hook for one text (step 5): the named root, else the repo above the cwd, Matched by `matchRepo`. */
export function scanRepoHook(registry: DownloadRegistry, options: MatchOptions): NonNullable<OutsideScanHooks["repo"]> {
  return (root) => registry.matchRepo(root === undefined ? options : { ...options, root });
}
