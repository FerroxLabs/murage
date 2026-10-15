// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Is the process a record names still running? A pid alone is not an identity:
// once a process exits the OS can hand its pid to an unrelated one. So a record
// keeps the process's start time beside its pid. Synchronous, for the scoped-home
// build and crash recovery, which run before any turn can start.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessRecord {
  pid: number;
  /** The start time the OS reports for it, or null where none could be read (then the pid alone is compared). */
  id: string | null;
}

/** The OS's start-time stamp for a process, or null when it cannot be read (or on Windows, where it costs a PowerShell start). */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may hold spaces and parens: fields resume after the LAST ")"; field 22 is rest[19].
      const rest = text.slice(text.lastIndexOf(")") + 2).split(" ");
      return /^\d+$/.test(rest[19] ?? "") ? `proc:${rest[19]}` : null;
    }
    if (process.platform === "win32") return null;
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8", timeout: 3_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const id = out.trim().replace(/\s+/g, " ");
    return id || null;
  } catch {
    return null;
  }
}

let own: ProcessRecord | null = null;
/** This process, read once. */
export function ownProcessRecord(): ProcessRecord {
  return (own ??= { pid: process.pid, id: processIdentity(process.pid) });
}

export function recordOf(pid: number | undefined | null): ProcessRecord | undefined {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid, id: processIdentity(pid) } : undefined;
}

/** True while the recorded process is running. When it cannot be told apart from a pid reuse, it counts as running: a scope is only ever recovered once its owner is provably gone. */
export function processRunning(record: ProcessRecord): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true; // EPERM: it exists, and is not ours to signal
  }
  if (record.id === null) return true;
  const now = processIdentity(record.pid);
  return now === null ? true : now === record.id;
}

/** Wait this long without spinning the CPU (synchronous). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
