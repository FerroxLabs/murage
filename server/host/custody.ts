// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a (designs/1021-m2-w0 r3 D1.6 with r3.2 A6, r5 F3): executor custody records and the identity-verified reap.
//
// Owners: both sides belong to the O1 m2 S1a builder lane (fix/1022-o1m2): the producer is the hosted launcher
// (server/host/host-launch.ts appends the host record before it accepts hello); the consumer is the boot reap in
// server/index.ts, which runs if and only if the custody file exists, in any mode, before the mode decision.
//
// The file is created only on the HOSTED branch, which no shipped build reaches (F1). Records are appended with
// write then fsync, outside any transaction. A record is dropped only once its process group is proven gone.
import { closeSync, constants, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostProcessIdentity } from "../bwrap-process.ts";

export const HOSTED_CUSTODY_FILE = "hosted-custody.jsonl";
/** kboot is the kernel boot id: a pid or group number is only evidence within the kernel boot that recorded it. */
export type CustodyRecord = Readonly<{ boot_id: string; kboot: string; inc: number; role: "host" | "engine"; pid: number; start: string; pgid: number }>;

/** Linux kernel boot id; undefined where it cannot be read (then no record can be proven, and none is ever signalled). */
export function kernelBootId(): string | undefined {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; } catch { return undefined; }
}

export function hostedCustodyPath(dataDir: string): string {
  return join(dataDir, HOSTED_CUSTODY_FILE);
}

/**
 * Opus r2 M: a new or renamed custody file is durable only once its directory entry is. POSIX only; Windows has no
 * directory handle to fsync (and never reaches HOSTED, F1). A failure throws, so the caller treats the record as unwritten.
 */
function fsyncDir(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Producer side: append then fsync (file, then its directory entry), owner-only, outside any transaction. */
export function appendCustodyRecord(dataDir: string, record: CustodyRecord): void {
  const path = hostedCustodyPath(dataDir);
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  fsyncDir(path);
}

export function readCustodyRecords(dataDir: string): CustodyRecord[] {
  const path = hostedCustodyPath(dataDir);
  if (!existsSync(path)) return [];
  const out: CustodyRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as CustodyRecord;
      if (Number.isInteger(value?.pid) && value.pid > 1 && Number.isInteger(value.pgid) && typeof value.start === "string") out.push(value);
    } catch { /* a torn last line from a crash mid-append names no process the reap could prove; it is dropped */ }
  }
  return out;
}

export type ReapDeps = {
  kboot: () => string | undefined;
  identity: (pid: number) => { pid: number; start: string } | undefined;
  /** kill(-pgid, 0) succeeded: some member of the group is alive. */
  groupAlive: (pgid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * Opus r2 M (zombie): kill(-pgid, 0) also succeeds when the only member left is a zombie, which SIGKILL cannot remove,
 * so a record would stay unresolved (and admission closed) until some parent reaps it. On Linux a group counts as alive
 * only while /proc shows a member that is not a zombie. Fail-closed (DECISIONS r3 D6): EPERM, or a member whose stat
 * cannot be read for any reason but its exit, counts as alive.
 */
function groupStatState(pgid: number): "live" | "zombie-only" {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${name}/stat`, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      return "live";
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X") return "live";
    // Opus r3 M1: a thread-group leader that ended its main thread shows Z while its other threads still run.
    if (Number(fields[2]) === pgid && fields[0] === "Z" && liveThreads(name)) return "live";
  }
  return "zombie-only";
}
function liveThreads(pid: string): boolean {
  try { return readdirSync(`/proc/${pid}/task`).length > 1; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
const groupAlive = (pgid: number): boolean => {
  try { process.kill(-pgid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  // Opus r3 M2: SIGKILL the group before the scan, so no member can fork a new one behind the scan's cursor. The group is
  // this record's: its kernel boot matched and Linux does not hand out a pid while a group of that number exists.
  try { process.kill(-pgid, "SIGKILL"); } catch { /* the members left are only zombies */ }
  try { return groupStatState(pgid) === "live"; } catch { return true; }
};
export const reapDeps: ReapDeps = {
  kboot: kernelBootId,
  identity: hostProcessIdentity,
  groupAlive,
  kill: (pid, signal) => { try { process.kill(pid, signal); } catch { /* already gone */ } },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** One record's D1.6 rule. Returns true when the record may be dropped (its group is proven gone). */
function settleRecord(record: CustodyRecord, deps: ReapDeps): boolean {
  // A record from another kernel boot (or one whose boot cannot be compared) names numbers the kernel may have handed to
  // unrelated processes since: it proves nothing, so it is dropped and nothing is signalled. Every process it named died
  // with that kernel boot.
  const kboot = deps.kboot();
  if (!kboot || record.kboot !== kboot) return true;
  const current = deps.identity(record.pid);
  if (current && current.start === record.start) {
    deps.kill(record.pid, "SIGKILL");
    if (record.pgid === record.pid) deps.kill(-record.pgid, "SIGKILL");
    return false;
  }
  // A live pid with a different start token is a reused number; Linux does not reuse a pid while a group of that number exists.
  if (current) return true;
  if (record.pgid === record.pid && deps.groupAlive(record.pgid)) {
    deps.kill(-record.pgid, "SIGKILL");
    return false;
  }
  return true;
}

/**
 * The reap, run at boot (iff the file exists), at host death and at quit. Each pass waits up to 5 s for every group to be
 * proven gone. Unresolved records stay in the file (rewritten atomically); a resolved file is removed.
 */
export async function reapCustody(dataDir: string, deps: ReapDeps = reapDeps, budgetMs = 5_000): Promise<{ reaped: number; unresolved: number }> {
  const path = hostedCustodyPath(dataDir);
  if (!existsSync(path)) return { reaped: 0, unresolved: 0 };
  let open: CustodyRecord[];
  // Fail-closed (DECISIONS r3 D7): a custody file that exists but cannot be read proves nothing about the executors it
  // names. It is kept, counted unresolved (admission stays closed), and never crashes the boot that called the reap.
  try { open = readCustodyRecords(dataDir); } catch { return { reaped: 0, unresolved: 1 }; }
  const total = open.length;
  const deadline = deps.now() + budgetMs;
  for (;;) {
    open = open.filter(record => !settleRecord(record, deps));
    if (!open.length || deps.now() >= deadline) break;
    await deps.sleep(50);
  }
  if (!open.length) rmSync(path, { force: true });
  else {
    const temp = `${path}.tmp`;
    try {
      const fd = openSync(temp, "w", 0o600);
      try { writeSync(fd, open.map(record => `${JSON.stringify(record)}\n`).join("")); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      fsyncDir(path);
    } catch {
      // The original file still holds every record (a superset of the unresolved ones), so the next pass stays complete.
      rmSync(temp, { force: true });
    }
  }
  return { reaped: total - open.length, unresolved: open.length };
}
