// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Windows process table without PowerShell (murage-releases #1: an
// antivirus notice, and a visible PowerShell start, every time the app looked
// at its engines). Two sources, neither a script host:
//   - the app's own native addon (engine-exclusion.node `processes()`): pid,
//     parent pid, creation FILETIME and command line, from the Toolhelp32
//     snapshot and GetProcessTimes (Windows never reports a parent's start, so
//     the dead-parent rule stays in process-tree.ts);
//   - System32\tasklist.exe /FO CSV /NH for the working set ("Mem Usage"), only
//     when the caller needs resident sizes. The number's separators and the
//     "K" depend on the display language, so only its digits are read.
// Either source failing, or answering something this module does not
// recognise, is "no table" (null): callers fail closed, as they did when the
// PowerShell probe failed. Without the addon (a source checkout that never built
// it) there is no table either: warm engines are recycled, never reused.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { loadExclusionAddon, type NativeProcess } from "../engine-exclusion.ts";

const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const TASKLIST_TIMEOUT_MS = 3_500;

/** One row of the Windows process table: pid, parent pid, creation time
 * (`start`: FILETIME ticks as text, the identity; `startMs`: epoch ms) and
 * working set in bytes. A value Windows does not report is null / "". */
export interface WindowsProcessRow { pid: number; ppid: number; startMs: number | null; start: string; rssBytes: number | null }

/** The native process list; null when the addon is missing, too old or the list could not be completed. */
export function nativeProcessList(): NativeProcess[] | null {
  try {
    const addon = loadExclusionAddon();
    if (!addon) return null;
    const list = addon.processes();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** Exported for tests: parse `tasklist /FO CSV /NH`. pid -> working set bytes. Null unless every line is a well-formed five-field row
 * (a cut-off or damaged answer proves nothing); a row whose "Mem Usage" has no digits (N/A) is simply not in the map. */
export function parseTasklistMemory(stdout: string): Map<number, number> | null {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const out = new Map<number, number>();
  for (const line of lines) {
    const fields = /^"((?:[^"]|"")*)","(\d{1,10})","((?:[^"]|"")*)","((?:[^"]|"")*)","((?:[^"]|"")*)"$/.exec(line.trim());
    if (!fields) return null;
    const digits = fields[5]!.replace(/\D/g, "");
    if (digits) out.set(Number(fields[2]), Number(digits) * 1024);
  }
  return out;
}

function tasklistMemory(): Promise<Map<number, number> | null> {
  const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  return new Promise((resolve) => {
    try {
      execFile(join(root, "System32", "tasklist.exe"), ["/FO", "CSV", "/NH"], { timeout: TASKLIST_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(parseTasklistMemory(String(stdout ?? "")));
      });
    } catch {
      resolve(null);
    }
  });
}

/** Exported for tests: rows from the native list (and the working sets, when asked for). A process that has ended but is still
 * held open by a handle (exe "") is not a running process and is left out. A parent link whose parent started AFTER the child is dropped:
 * Windows keeps a dead parent's pid as the parent id, and that pid may since belong to another process. */
export function rowsFromNative(list: readonly NativeProcess[], memory: ReadonlyMap<number, number> | null): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = [];
  for (const entry of list) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || !Number.isInteger(entry.ppid) || entry.ppid < 0 || entry.exe === "") continue;
    const ticks = typeof entry.start === "number" && entry.start > 0 ? Math.round(entry.start * 1e7) : null;
    rows.push({
      pid: entry.pid,
      ppid: entry.ppid,
      startMs: ticks === null ? null : Math.floor(ticks / 10_000) - FILETIME_EPOCH_OFFSET_MS,
      start: ticks === null ? "" : String(ticks),
      rssBytes: memory?.get(entry.pid) ?? null,
    });
  }
  const startOf = new Map(rows.map((row) => [row.pid, row.startMs]));
  return rows.map((row) => {
    const parentStart = startOf.get(row.ppid);
    const stale = row.pid === row.ppid || (parentStart != null && row.startMs !== null && parentStart > row.startMs);
    return stale ? { ...row, ppid: 0 } : row;
  });
}

/** The Windows process table; null when it could not be read in full (callers then fail closed: never reuse). `memory`: also read
 * every working set (the warm pool's budget); a failed memory read is a failed table. */
export async function windowsProcessTable(options: { memory?: boolean } = {}): Promise<WindowsProcessRow[] | null> {
  const list = await new Promise<NativeProcess[] | null>((resolve) => setImmediate(() => resolve(nativeProcessList())));
  if (!list) return null;
  let memory: Map<number, number> | null = null;
  if (options.memory) {
    memory = await tasklistMemory();
    if (!memory) return null;
  }
  return rowsFromNative(list, memory);
}
