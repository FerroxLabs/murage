// SPDX-License-Identifier: AGPL-3.0-or-later
// FIRSTRUN-1019 slice F: is there Grok Bot data on this computer to move in? (CONCIERGE 9.1, the Grok row only.)
//
// WHAT IT READS. Bounded Downloads exports and the names-only roster slice in Grok Bot's UI cache.
// Only the encoded roster.last-roster slice is opened; never chats, login material or ~/.grokbot.
// Cache format adapted from OpenMausBot 2fa2a08e2 server/grok-local.ts (Apache-2.0), whose
// cache reader adapts Nous Research's MIT agent-importers plugin; see NOTICE.
// Evidence: _ev/designs/UPSTREAM-SETTINGS-DIFF-1106.md; names-only approval: FIX-LEDGER.md:5848.
//
// A throwing finder is a count of 0 and the flow carries on.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { redactSecretsInText } from "./redact.ts";
import { homedir } from "node:os";
import { join } from "node:path";

import { grokExportToPackage, grokImportFromInput, type GrokImportResult } from "./grok-import.ts";

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
  read(path: string, maxBytes?: number): string;
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
  read: (path, maxBytes = GROK_MAX_BYTES) => {
    // Windows does not supply O_NOFOLLOW. Refuse links before opening on every OS,
    // then compare identities before reading so a swapped final file is refused too.
    const before = lstatSync(path);
    if (!before.isFile() || before.size > maxBytes) throw new Error("not a regular export file");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Checked on the opened descriptor, so nothing swapped in after the listing is read.
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("not a regular export file");
      // Bound the read too: a file that grows after fstat must not bypass the cap.
      const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
      let used = 0;
      while (used < buffer.length) {
        const n = readSync(fd, buffer, used, buffer.length - used, null);
        if (!n) break;
        used += n;
      }
      if (used > opened.size || used > maxBytes) throw new Error("file grew while reading");
      return buffer.subarray(0, used).toString("utf8");
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

const ROSTER_FOLDERS = [["Library", "Application Support", "Grok Bot"], ["AppData", "Roaming", "Grok Bot"], [".config", "Grok Bot"]];
const ROSTER_MAX_BYTES = 32 * 1024 * 1024;
const SLICE_PREFIX = "sand.client.slice.account.";

/** Decode only canonical unpadded base32 filenames, before opening any slice. */
function isRosterSlice(name: string): boolean {
  if (!/^[a-z2-7]{1,512}\.blob$/.test(name)) return false;
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of name.slice(0, -5)) {
    value = (value << 5) | "abcdefghijklmnopqrstuvwxyz234567".indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
    value &= (1 << bits) - 1;
  }
  if (value !== 0 || bits >= 5) return false;
  try {
    const id = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    if (!id.startsWith(SLICE_PREFIX)) return false;
    const separator = id.indexOf(".", SLICE_PREFIX.length);
    return separator > SLICE_PREFIX.length && decodeURIComponent(id.slice(separator + 1)) === "roster.last-roster";
  } catch { return false; }
}

/** Names only. Unknown versions/shapes are refused; no fallback to other cache slices. */
export function readGrokRosterNames(fs: MoveInFs = realMoveInFs): string[] {
  const names = new Set<string>();
  for (const parts of ROSTER_FOLDERS) {
    try {
      let dir = fs.home();
      if (!fs.realDir?.(dir)) continue;
      // Refuse linked ancestors too, not just a linked cache or slice file.
      for (const part of [...parts, "sand-client-persistence"]) {
        dir = join(dir, part);
        if (!fs.realDir?.(dir)) throw new Error("not a real directory");
      }
      const slices = fs.list(dir).filter(isRosterSlice).sort().slice(0, GROK_MAX_FILES);
      for (const file of slices) {
        try {
          const path = join(dir, file);
          const size = fs.size(path);
          if (size === null || size < 0 || size > ROSTER_MAX_BYTES) continue;
          const raw = fs.read(path, ROSTER_MAX_BYTES);
          if (Buffer.byteLength(raw) > ROSTER_MAX_BYTES) continue;
          const data = JSON.parse(raw);
          if (data?.schemaVersion !== 1 || !Array.isArray(data?.value?.rows)) continue;
          for (const row of data.value.rows.slice(0, 1000)) {
            if (!row || typeof row !== "object" || row.isGroup || typeof row.name !== "string") continue;
            const name = row.name.trim();
            // Do not turn credential-looking text into a bot name or silently truncate identities.
            if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name) || redactSecretsInText(name) !== name) continue;
            names.add(name);
            if (names.size >= 1000) return [...names];
          }
        } catch { /* unreadable or unknown slice: no names */ }
      }
    } catch { /* absent, linked or unreadable cache: no names */ }
  }
  return [...names];
}

/** Accepted exports plus names-only roster bots, through the same package import path. */
export async function convertGrokExports(fs: MoveInFs = realMoveInFs): Promise<GrokImportResult[]> {
  const out: GrokImportResult[] = [];
  for (const text of readGrokExports(fs)) {
    try {
      out.push(await grokImportFromInput(text));
    } catch {
      // not an export the importer understands: not counted, not imported
    }
  }
  const exportedNames = new Set(out.flatMap((result) => result.document.package.agents.map((agent) => agent.name)));
  for (const name of readGrokRosterNames(fs)) {
    if (exportedNames.has(name)) continue;
    try {
      const result = grokExportToPackage({ name, description: "", instructions: "Follow the owner's instructions.", skills: [], routines: [], apps: [], memories: [] });
      result.notes.push(`${name}: the app roster contains names only. Add instructions, skills and routines on the bot's profile, or import its export.`);
      result.notes.push("Memories from Grok Bot do not come across, so tell the bot anything it should remember in your first chat.");
      out.push(result);
    } catch { /* a name the package rules refuse is neither counted nor offered */ }
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
