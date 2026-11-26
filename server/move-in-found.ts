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
//
// NEVER ON THE MAIN THREAD (1.0.21 row). macOS holds the open of ~/Downloads until the owner answers its folder question,
// so every folder read here is a promise, a listing is shared while one is in flight, and the polled setup view only
// ever gets the last count while a fresh one is read in the background (grokCountForSetup).
// 1.0.23 row (dlscan): the two folder probes that can raise the OS question (is it a real folder, and its listing) run on a
// worker thread, so a hold takes only that thread: not the main thread, and not one of the shared pool threads every other
// route's file reads wait on. A probe the OS has held for OFF_MAIN_MAX_MS is given up (count 0) and, while its worker is still
// stuck, no second one is started.

import { constants, promises as fsp } from "node:fs";
import { Worker } from "node:worker_threads";
import { windowsHidePrelude } from "../shared/win-hide-child-process.mjs";
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

type Maybe<T> = T | Promise<T>;
/** Fixtures may answer at once; the real one answers with promises, off the main thread. */
export interface MoveInFs {
  home(): string;
  list(dir: string): Maybe<string[]>;
  size(path: string): Maybe<number | null>;
  read(path: string, maxBytes?: number): Maybe<string>;
  /** True when the path is a real directory and not a link; absent in fixtures that do not care. */
  realDir?(path: string): Maybe<boolean>;
}

/** Longest a folder probe may be held before the reading gives up; the owner can take a while to answer the OS question. */
export const OFF_MAIN_MAX_MS = 5 * 60_000;
const OFF_MAIN_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
try {
  const { op, path } = workerData;
  parentPort.postMessage({ ok: true, value: op === "list" ? fs.readdirSync(path) : fs.lstatSync(path).isDirectory() });
} catch (error) {
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) });
}
`;
/** Workers that timed out and have not exited: the OS still holds their thread. */
const stuckProbes = new Set<Worker>();
export const stuckProbeCount = (): number => stuckProbes.size;

/** Tests stand the OS hold in for inside the worker, which does not share the main thread's patched modules. */
const PROBE_PRELUDE = Symbol.for("murage.moveIn.probePrelude");

export function offMain<T>(op: "list" | "realDir", path: string, maxMs = OFF_MAIN_MAX_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (stuckProbes.size > 0) return reject(new Error("a folder read is still held by the OS"));
    let worker: Worker;
    try {
      const prelude = (globalThis as Record<symbol, unknown>)[PROBE_PRELUDE];
      worker = new Worker(windowsHidePrelude + (typeof prelude === "string" ? prelude : "") + OFF_MAIN_SOURCE, { eval: true, workerData: { op, path } });
    } catch (error) { return reject(error); }
    worker.unref();
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => finish(() => {
      stuckProbes.add(worker);
      worker.once("exit", () => stuckProbes.delete(worker));
      void worker.terminate().catch(() => {});
      reject(new Error("folder read held too long"));
    }), maxMs);
    timer.unref();
    worker.once("message", (reply: { ok: boolean; value?: T; message?: string }) => finish(() => (reply.ok ? resolve(reply.value as T) : reject(new Error(reply.message)))));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", () => finish(() => reject(new Error("folder read worker ended"))));
  });
}

export const realMoveInFs: MoveInFs = {
  home: () => homedir(),
  list: (dir) => offMain<string[]>("list", dir),
  size: async (path) => {
    // lstat: a link is not a regular file, so a link in Downloads that points at a secrets or chat file is skipped.
    const stat = await fsp.lstat(path);
    return stat.isFile() ? stat.size : null;
  },
  realDir: (path) => offMain<boolean>("realDir", path),
  read: async (path, maxBytes = GROK_MAX_BYTES) => {
    // Windows does not supply O_NOFOLLOW. Refuse links before opening on every OS,
    // then compare identities before reading so a swapped final file is refused too.
    const before = await fsp.lstat(path);
    if (!before.isFile() || before.size > maxBytes) throw new Error("not a regular export file");
    const file = await fsp.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // Checked on the opened descriptor, so nothing swapped in after the listing is read.
      const opened = await file.stat();
      if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("not a regular export file");
      // Bound the read too: a file that grows after fstat must not bypass the cap.
      const buffer = Buffer.alloc(Math.min(opened.size + 1, maxBytes + 1));
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > opened.size || used > maxBytes) throw new Error("file grew while reading");
      return buffer.subarray(0, used).toString("utf8");
    } finally {
      await file.close();
    }
  },
};

/** The export files found, as text. Only Downloads, only files that look like a Grok export. */
export async function readGrokExports(fs: MoveInFs = realMoveInFs): Promise<string[]> {
  try {
    const dir = join(fs.home(), "Downloads");
    // A Downloads folder that is itself a link may lead anywhere: not read.
    if (fs.realDir && !(await fs.realDir(dir))) return [];
    const names = (await fs.list(dir)).filter((name) => GROK_FILE.test(name) && !GROK_NOT_AN_EXPORT.test(name)).sort().slice(0, GROK_MAX_FILES);
    const texts: string[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const size = await fs.size(path);
      if (size === null || size > GROK_MAX_BYTES) continue;
      texts.push(await fs.read(path));
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
export async function readGrokRosterNames(fs: MoveInFs = realMoveInFs): Promise<string[]> {
  const names = new Set<string>();
  for (const parts of ROSTER_FOLDERS) {
    try {
      let dir = fs.home();
      if (!(await fs.realDir?.(dir))) continue;
      // Refuse linked ancestors too, not just a linked cache or slice file.
      for (const part of [...parts, "sand-client-persistence"]) {
        dir = join(dir, part);
        if (!(await fs.realDir?.(dir))) throw new Error("not a real directory");
      }
      const slices = (await fs.list(dir)).filter(isRosterSlice).sort().slice(0, GROK_MAX_FILES);
      for (const file of slices) {
        try {
          const path = join(dir, file);
          const size = await fs.size(path);
          if (size === null || size < 0 || size > ROSTER_MAX_BYTES) continue;
          const raw = await fs.read(path, ROSTER_MAX_BYTES);
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

/** One reading per finder at a time: a listing the OS holds is joined, never queued again behind itself. */
const reading = new WeakMap<MoveInFs, Promise<GrokImportResult[]>>();

/** Accepted exports plus names-only roster bots, through the same package import path. */
export function convertGrokExports(fs: MoveInFs = realMoveInFs): Promise<GrokImportResult[]> {
  const live = reading.get(fs);
  if (live) return live;
  const next = convertOnce(fs).finally(() => { if (reading.get(fs) === next) reading.delete(fs); });
  reading.set(fs, next);
  return next;
}

async function convertOnce(fs: MoveInFs): Promise<GrokImportResult[]> {
  const out: GrokImportResult[] = [];
  for (const text of await readGrokExports(fs)) {
    try {
      out.push(await grokImportFromInput(text));
    } catch {
      // not an export the importer understands: not counted, not imported
    }
  }
  const exportedNames = new Set(out.flatMap((result) => result.document.package.agents.map((agent) => agent.name)));
  for (const name of await readGrokRosterNames(fs)) {
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

/** How long a request the owner made waits on a folder the OS is still holding; past it the request answers and the server moves on. */
export const MOVE_IN_WAIT_MS = 4000;
/** The promise's value, or null once `ms` has passed (the reading carries on; its result is not lost to the next poll). */
export async function withinMs<T>(work: Promise<T>, ms = MOVE_IN_WAIT_MS): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.then((value) => ({ value })), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
  } finally { clearTimeout(timer); }
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
let refreshing: Promise<void> | null = null;
let refreshingSince = 0;
/** How long setup holds its Flux card for the first reading; past this it goes ahead and the Grok offer still arrives while Flux is open if the reading settles later. */
export const PENDING_MAX_MS = 10_000;
let generation = 0;
const FRESH_MS = 60_000;
/**
 * The count the setup view carries: the last one read (0 before the first), never waited for. A stale or missing count
 * starts one background reading, at most once a minute (the setup view is polled); while it is held by the OS the view
 * keeps answering with the last count, and no second reading starts. 0 on any failure.
 */
export function grokCountForSetup(fs: MoveInFs = realMoveInFs, now = Date.now()): number {
  if ((!cached || now - cached.at >= FRESH_MS) && !refreshing) {
    const started = generation;
    const run = findMoveIn(fs)
      .then((found) => { if (generation === started) cached = { at: now, count: found.grok.count }; })
      .catch(() => { if (generation === started) cached = { at: now, count: 0 }; })
      .finally(() => { if (refreshing === run) refreshing = null; });
    refreshing = run;
    refreshingSince = now;
  }
  return cached?.count ?? 0;
}

/** Setup must distinguish a held initial reading from an empty result, but only for PENDING_MAX_MS: a reading the OS never releases cannot take the Flux connect/skip card with it. */
export function grokCountPending(now = Date.now()): boolean {
  return cached === null && refreshing !== null && now - refreshingSince < PENDING_MAX_MS;
}

/** The background reading grokCountForSetup started, if one is running (tests wait on it). */
export function grokCountReading(): Promise<void> | null {
  return refreshing;
}
/** After a move-in: the next setup view starts a fresh reading, and one already running cannot write its older count. */
export function forgetGrokCount(): void {
  generation++;
  cached = null;
  refreshing = null;
}
