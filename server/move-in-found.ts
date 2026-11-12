// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice F: is there Grok Bot data on this computer to move in? (CONCIERGE 9.1, the Grok row only.)
//
// WHAT IT READS. Only Grok Bot export files sitting in the person's Downloads folder (a name that says grok, ending in
// .json, at most 20 files of at most 16 MB each), and only to count the ones the shipped importer accepts. It never
// opens sand-secrets.json, cookies, the ~/.grokbot folder or any chat, and the answer carries a label and a count,
// never a path. The upstream finder this row was meant to lift (grok-local.ts, MIT) is not in this repository, so this is
// written fresh against the same rules; the Grok Bot app's own roster is not read in 1.0.19.
//
// A throwing finder is a count of 0 and the flow carries on.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { grokImportFromInput, type GrokImportResult } from "./grok-import.ts";

export const GROK_MAX_FILES = 20;
export const GROK_MAX_BYTES = 16 * 1024 * 1024;
// Only names that say bot export: grok, then bot(s), export, helper, agent(s), team or roster. A name like grok-config.json is not one.
const GROK_FILE = /^(?:.*[\s_.-])?grok[\s_-]*(?:bots?|exports?|helpers?|agents?|teams?|roster)(?![A-Za-z])[^/\\]*\.json$/i;
/** Names that say the file is something other than a bot export: never opened, whatever the contents. */
const GROK_NOT_AN_EXPORT = /chat|conversation|cookie|secret|history|session|token|credential|memor/i;

export interface MoveInFs {
  home(): string;
  list(dir: string): string[];
  size(path: string): number | null;
  read(path: string): string;
  /** True when the path is a real directory and not a link; absent in fixtures that do not care. */
  realDir?(path: string): boolean;
}

export const realMoveInFs: MoveInFs = {
  home: () => homedir(),
  list: (dir) => readdirSync(dir),
  size: (path) => {
    // lstat: a link is not a regular file, so a link in Downloads that points at a secrets or chat file is skipped.
    const stat = lstatSync(path);
    return stat.isFile() ? stat.size : null;
  },
  realDir: (path) => lstatSync(path).isDirectory(),
  read: (path) => {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Checked on the opened descriptor, so nothing swapped in after the listing is read.
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > GROK_MAX_BYTES) throw new Error("not a regular export file");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  },
};

/** The export files found, as text. Only Downloads, only files that look like a Grok export. */
export function readGrokExports(fs: MoveInFs = realMoveInFs): string[] {
  try {
    const dir = join(fs.home(), "Downloads");
    // A Downloads folder that is itself a link may lead anywhere: not read.
    if (fs.realDir && !fs.realDir(dir)) return [];
    const names = fs.list(dir).filter((name) => GROK_FILE.test(name) && !GROK_NOT_AN_EXPORT.test(name)).sort().slice(0, GROK_MAX_FILES);
    const texts: string[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const size = fs.size(path);
      if (size === null || size > GROK_MAX_BYTES) continue;
      texts.push(fs.read(path));
    }
    return texts;
  } catch {
    return [];
  }
}

/** Exports the shipped importer accepts, converted. */
export async function convertGrokExports(fs: MoveInFs = realMoveInFs): Promise<GrokImportResult[]> {
  const out: GrokImportResult[] = [];
  for (const text of readGrokExports(fs)) {
    try {
      out.push(await grokImportFromInput(text));
    } catch {
      // not an export the importer understands: not counted, not imported
    }
  }
  return out;
}

export interface MoveInFound { grok: { label: string; count: number } }

export async function findMoveIn(fs: MoveInFs = realMoveInFs): Promise<MoveInFound> {
  try {
    return { grok: { label: "Grok Bot", count: (await convertGrokExports(fs)).length } };
  } catch {
    return { grok: { label: "Grok Bot", count: 0 } };
  }
}

let cached: { at: number; count: number } | null = null;
const FRESH_MS = 60_000;
/** The count the setup view carries, re-read at most once a minute (the setup view is polled). 0 on any failure. */
export async function grokCountForSetup(fs: MoveInFs = realMoveInFs, now = Date.now()): Promise<number> {
  if (cached && now - cached.at < FRESH_MS) return cached.count;
  const count = (await findMoveIn(fs)).grok.count;
  cached = { at: now, count };
  return count;
}
export function forgetGrokCount(): void {
  cached = null;
}
