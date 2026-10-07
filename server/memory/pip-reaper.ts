// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 process ownership primitives (P2-AMENDMENT-v5.1.md A.2). Functions the
// reflection state machine (B3) calls at startup and on idle ticks: child
// registration data, kill-and-verify, the argv sweep, the restart reconciliation
// of one attempt, orphan temp directory removal, and the shared run deadline.
// Every OS seam is injectable so the rules are unit-testable; the defaults act
// on real processes.
import { stopWindowsJob, type JobHelperRunner } from "./pip-job.ts";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { removeTempRoot, RUN_BOUND_MS, type AttemptTransport, type BootEpoch, type TransportChild } from "./pip-transport.ts";

export const REAPER_TERM_GRACE_MS = 3_000;
export const REAPER_FORCE_WAIT_MS = 1_000;
export const MAX_REAPER_FAILURES = 3;
export const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------- start times ----

interface RunResult { ok: boolean; code: number | string | null; out: string }
const run = (cmd: string, args: string[]): Promise<RunResult> =>
  new Promise((done) => execFile(cmd, args, { timeout: 10_000, encoding: "utf8", windowsHide: true }, (e, out) =>
    done({ ok: !e, code: e ? ((e as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0, out: String(out ?? "") })));

/** What one look at a process found. "unknown" is a failed look, never evidence the process is gone. */
export type Observation = { state: "absent" } | { state: "present"; startTime: string } | { state: "unknown" };

/** Linux /proc/<pid>/stat field 22; macOS `ps -o lstart= -p`; Windows Get-Process StartTime. Distinguishes absence from a failed read. */
export async function observeProcess(pid: number, platform: NodeJS.Platform = process.platform): Promise<Observation> {
  if (!Number.isInteger(pid) || pid <= 1) return { state: "unknown" };
  if (platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // comm may contain spaces and parens: fields resume after the last ")".
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19] ? { state: "present", startTime: rest[19] } : { state: "unknown" }; // field 22 overall = index 19 after state(3)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ESRCH" ? { state: "absent" } : { state: "unknown" };
    }
  }
  if (platform === "win32") {
    const r = await run("powershell.exe", ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`]);
    if (!r.ok) return { state: "unknown" };
    return r.out.trim() ? { state: "present", startTime: r.out.trim() } : { state: "absent" };
  }
  const r = await run("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (r.ok) return r.out.trim() ? { state: "present", startTime: r.out.trim() } : { state: "unknown" };
  // ps exits 1 with no output when the pid does not exist; any other failure is a failed look.
  return r.code === 1 && !r.out.trim() ? { state: "absent" } : { state: "unknown" };
}

/** Start time of a live process; null when absent or unreadable (callers that need the difference use observeProcess). */
export async function readProcessStartTime(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const o = await observeProcess(pid, platform);
  return o.state === "present" ? o.startTime : null;
}

/** Child registration, right after spawn. Null means the read failed: the caller kills the tree and marks uncertain-transport. */
export async function registerChild(pid: number | undefined, now = Date.now(), platform: NodeJS.Platform = process.platform): Promise<TransportChild | null> {
  if (pid === undefined) return null;
  const startTime = await readProcessStartTime(pid, platform);
  return startTime ? { pid, startTime, registeredAt: now } : null;
}

// --------------------------------------------------------- kill + verify ----

export interface ReaperDeps {
  platform?: NodeJS.Platform;
  /** Signal a group (negative pid) or a process; throws like process.kill. */
  signal?: (pid: number, sig: NodeJS.Signals | 0) => void;
  /** Start time of a live process, null when it cannot be read. Prefer `observe`. */
  startTime?: (pid: number) => Promise<string | null>;
  observe?: (pid: number) => Promise<Observation>;
  /** Pids whose command line contains the needle; null when the process list could not be read. */
  sweep?: (needle: string) => Promise<number[] | null>;
  jobName?: string;
  jobRunner?: JobHelperRunner;
  termGraceMs?: number; forceWaitMs?: number;
  wait?: (ms: number) => Promise<void>;
}
const defaultSignal = (pid: number, sig: NodeJS.Signals | 0) => { process.kill(pid, sig); };
const observer = (deps: ReaperDeps, platform: NodeJS.Platform) => deps.observe
  ?? (deps.startTime
    ? async (pid: number): Promise<Observation> => { const v = await deps.startTime!(pid); return v === null ? { state: "unknown" } : { state: "present", startTime: v }; }
    : (pid: number) => observeProcess(pid, platform));
const gone = (signal: NonNullable<ReaperDeps["signal"]>, pid: number): boolean => {
  try { signal(-pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
};
const goneProc = (signal: NonNullable<ReaperDeps["signal"]>, pid: number): boolean => {
  try { signal(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
};
/** alive: a signal reached the group; gone: ESRCH; unknown: anything else (EPERM, a foreign group). */
const groupState = (signal: NonNullable<ReaperDeps["signal"]>, pid: number): "alive" | "gone" | "unknown" => {
  try { signal(-pid, 0); return "alive"; } catch (e) { const code = (e as NodeJS.ErrnoException).code; return code === "ESRCH" ? "gone" : "unknown"; }
};

/** SIGTERM the group, wait the grace, SIGKILL, wait, then verify ESRCH. True only when the group is gone. Windows: terminate the named job and confirm zero members. */
export async function killAndVerify(pid: number, deps: ReaperDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const signal = deps.signal ?? defaultSignal, wait = deps.wait ?? sleep;
  const term = deps.termGraceMs ?? REAPER_TERM_GRACE_MS, force = deps.forceWaitMs ?? REAPER_FORCE_WAIT_MS;
  if (platform === "win32") return deps.jobName ? stopWindowsJob(deps.jobName, term + force, deps.jobRunner) : false;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const settled = () => gone(signal, pid) && goneProc(signal, pid);
  const poll = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (settled()) return true; await wait(Math.min(25, Math.max(1, end - Date.now()))); }
    return settled();
  };
  if (settled()) return true;
  const send = (sig: NodeJS.Signals) => { try { signal(-pid, sig); } catch { try { signal(pid, sig); } catch { /* verify below */ } } };
  send("SIGTERM");
  if (await poll(term)) return true;
  send("SIGKILL");
  return poll(force);
}

/** Argv sweep: processes whose command line contains the temp root. Never matches the running process. Null when the process list could not be read. */
export async function sweepByArgv(needle: string, platform: NodeJS.Platform = process.platform): Promise<number[] | null> {
  if (!needle) return [];
  const self = process.pid;
  if (platform === "linux") {
    let names: string[];
    try { names = readdirSync("/proc"); } catch { return null; }
    const pids: number[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === self) continue;
      try { if (readFileSync(join("/proc", name, "cmdline"), "utf8").includes(needle)) pids.push(pid); }
      catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return null; /* a raced exit is fine; anything else is a failed look */ }
    }
    return pids;
  }
  if (platform === "win32") {
    const r = await run("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`]);
    if (!r.ok) return null;
    return r.out.split(/\s+/).filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== self);
  }
  const r = await run("ps", ["-axo", "pid=,command="]);
  if (!r.ok) return null;
  const pids: number[] = [];
  for (const line of r.out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== self && m[2].includes(needle)) pids.push(Number(m[1]));
  }
  return pids;
}

// ------------------------------------------------------------ reconcile ----

export interface ReapOutcome { confirmed: boolean; how: "child" | "sweep" | "gone" | "http" | "unconfirmed" }

/**
 * Kill our orphan for one attempt. Termination is confirmed only by an observation that says so:
 * a failed look (unknown) is never evidence of absence.
 *  - registered root present with the same start time: kill and verify its group;
 *  - present with another start time: the pid was reused, so the original root, and by pid allocation (a pid is not
 *    reused while a group carries it) its group, are gone;
 *  - absent: the root may be gone while a same-group helper lives, so the group is checked and killed too;
 *  - never registered: the argv sweep (the temp root rides in every engine's argv), and a failed process list keeps the root.
 */
export async function reapAttemptProcess(t: AttemptTransport, deps: ReaperDeps = {}): Promise<ReapOutcome> {
  if (t.kind === "http") return { confirmed: true, how: "http" };
  const platform = deps.platform ?? process.platform;
  const signal = deps.signal ?? defaultSignal;
  const observe = observer(deps, platform);
  const unconfirmed: ReapOutcome = { confirmed: false, how: "unconfirmed" };
  if (platform === "win32") {
    if (!t.intent.jobName) return unconfirmed;
    // Revoke launch before observing the job. A supervisor still in Add-Type
    // cannot start later: it reads this file only after joining the named job.
    try { unlinkSync(join(t.intent.tempRoot, "job-args.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unconfirmed; }
    const confirmed = await killAndVerify(t.child?.pid ?? 0, { ...deps, jobName: t.intent.jobName });
    return { confirmed, how: confirmed ? "child" : "unconfirmed" };
  }
  if (t.child) {
    const pid = t.child.pid;
    const obs = await observe(pid);
    if (obs.state === "unknown") return unconfirmed;
    if (obs.state === "present") {
      if (obs.startTime !== t.child.startTime) return { confirmed: true, how: "gone" };
      const ok = await killAndVerify(pid, deps);
      return { confirmed: ok, how: ok ? "child" : "unconfirmed" };
    }
    const group = groupState(signal, pid);
    if (group === "gone") return { confirmed: true, how: "gone" };
    if (group === "unknown") return unconfirmed;
    const ok = await killAndVerify(pid, deps);
    return { confirmed: ok, how: ok ? "child" : "unconfirmed" };
  }
  const sweep = deps.sweep ?? ((needle: string) => sweepByArgv(needle, deps.platform));
  const pids = await sweep(t.intent.tempRoot);
  if (pids === null) return unconfirmed;
  if (!pids.length) return { confirmed: true, how: "gone" };
  let all = true;
  for (const pid of pids) if (!goneProc(signal, pid) && !(await killAndVerify(pid, deps))) all = false;
  return { confirmed: all, how: all ? "sweep" : "unconfirmed" };
}

export const sameBootEpoch = (a: BootEpoch, b: BootEpoch): boolean => a.pid === b.pid && a.startedAt === b.startedAt;

export type ReconcileAction =
  | { action: "none" }
  | { action: "retry"; attempt: number; transport: AttemptTransport }
  | { action: "unstable"; reason: "attempts" | "reaper"; note: string; transport: AttemptTransport }
  | { action: "unconfirmed"; transport: AttemptTransport };

/**
 * Restart and idle-tick rule for one attempt in `requested` or `uncertain-transport`.
 * Same boot epoch: untouched. Older epoch: kill and verify, remove the temp root only after
 * confirmed termination, then pending with attempt + 1 (or refused: unstable). Unconfirmed:
 * the attempt stays uncertain-transport, the directory is kept, 3 failures make it unstable.
 */
export async function reconcileAttempt(t: AttemptTransport, attempt: number, current: BootEpoch, base: string, deps: ReaperDeps = {}, opts: { uncertain?: boolean } = {}): Promise<ReconcileAction> {
  // An attempt of THIS process is active and untouched, unless the runner already settled it uncertain-transport:
  // that one awaits the idle-tick retry and is reconciled even in the same epoch.
  if (!opts.uncertain && sameBootEpoch(t.intent.bootEpoch, current)) return { action: "none" };
  const outcome = await reapAttemptProcess(t, deps);
  if (!outcome.confirmed) {
    const failures = (t.reaperFailures ?? 0) + 1;
    const next: AttemptTransport = { ...t, reaperFailures: failures };
    if (failures >= MAX_REAPER_FAILURES) return { action: "unstable", reason: "reaper", note: `Could not stop a leftover process using ${t.intent.tempRoot}; the folder was kept.`, transport: next };
    return { action: "unconfirmed", transport: next };
  }
  removeTempRoot(base, t.intent.tempRoot);
  if (attempt >= MAX_ATTEMPTS) return { action: "unstable", reason: "attempts", note: "Three attempts did not finish.", transport: t };
  return { action: "retry", attempt: attempt + 1, transport: t };
}

/** Directories under the temp base with no run record are removed only after the sweep finds no process naming them. */
export async function sweepOrphanTempDirs(base: string, known: ReadonlySet<string>, deps: ReaperDeps = {}): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [], kept: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return { removed, kept }; }
  const sweep = deps.sweep ?? ((needle: string) => sweepByArgv(needle, deps.platform));
  for (const name of names) {
    const dir = join(base, name);
    if (known.has(dir)) continue;
    const found = await sweep(dir);
    // A failed process list is not an empty one: the directory stays.
    if ((deps.platform ?? process.platform) === "win32" || found === null || found.length) { kept.push(dir); continue; }
    removeTempRoot(base, dir); removed.push(dir);
  }
  return { removed, kept };
}

// ------------------------------------------------------------- deadline ----

/** deadlineAt is set once per run (firstRequestedAt + 270 s) and shared by every retry. */
export function ensureDeadline<T extends { deadlineAt?: number }>(run: T, firstRequestedAt: number): T & { deadlineAt: number } {
  return run.deadlineAt !== undefined ? (run as T & { deadlineAt: number }) : { ...run, deadlineAt: firstRequestedAt + RUN_BOUND_MS };
}
export const remainingMs = (deadlineAt: number, now = Date.now()): number => Math.max(0, deadlineAt - now);
export const deadlinePassed = (deadlineAt: number, now = Date.now()): boolean => now >= deadlineAt;
