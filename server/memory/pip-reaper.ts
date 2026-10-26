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
import { lstatSync, readFileSync, readdirSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";
import { nativeProcessList } from "../drivers/win-process-table.ts";
import type { NativeProcess } from "../engine-exclusion.ts";
import { addonTreeRemove } from "../link-removal.ts";
import { removeTempRoot, ROOT_NAME, RUN_BOUND_MS, type AttemptTransport, type BootEpoch, type TransportChild } from "./pip-transport.ts";

export const REAPER_TERM_GRACE_MS = 3_000;
export const REAPER_FORCE_WAIT_MS = 1_000;
export const MAX_REAPER_FAILURES = 3;
export const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** sleep, woken at once by `abort`. */
const abortableSleep = (ms: number, abort?: AbortSignal) => !abort ? sleep(ms) : new Promise<void>((r) => {
  if (abort.aborted) { r(); return; }
  const done = () => { clearTimeout(timer); abort.removeEventListener("abort", done); r(); };
  const timer = setTimeout(done, ms);
  abort.addEventListener("abort", done, { once: true });
});

// ---------------------------------------------------------- start times ----

interface RunResult { ok: boolean; code: number | string | null; out: string }
/** One look by a helper process. `abort` ends it at once (execFile's own signal): an interrupted look is a failed one (ok false, code
 *  "ABORT_ERR"), never an empty answer, so no caller reads it as absence. */
const run = (cmd: string, args: string[], abort?: AbortSignal): Promise<RunResult> =>
  abort?.aborted ? Promise.resolve({ ok: false, code: "ABORT_ERR", out: "" }) :
  new Promise((done) => execFile(cmd, args, { timeout: 10_000, encoding: "utf8", windowsHide: true, ...(abort ? { signal: abort } : {}) }, (e, out) =>
    done(abort?.aborted ? { ok: false, code: "ABORT_ERR", out: "" } : { ok: !e, code: e ? ((e as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0, out: String(out ?? "") })));

/** What one look at a process found. "unknown" is a failed look, never evidence the process is gone. */
export type Observation = { state: "absent" } | { state: "present"; startTime: string } | { state: "unknown" };

/** The Windows process list: the app's own native addon (Toolhelp32 + GetProcessTimes + the process's command line), never PowerShell.
 *  Null when it cannot be read in full; every caller treats that as a failed look. The parameter is the test seam. */
export type WindowsProcessSource = () => readonly NativeProcess[] | null;

/** Linux /proc/<pid>/stat field 22; macOS `ps -o lstart= -p`; Windows the creation FILETIME (ticks, as text) from the native process list.
 *  Distinguishes absence from a failed read. */
export async function observeProcess(pid: number, platform: NodeJS.Platform = process.platform, abort?: AbortSignal, windowsList: WindowsProcessSource = nativeProcessList): Promise<Observation> {
  if (!Number.isInteger(pid) || pid <= 1 || abort?.aborted) return { state: "unknown" };
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
    const list = windowsList();
    if (!list || abort?.aborted) return { state: "unknown" };
    const found = list.find((entry) => entry.pid === pid);
    if (!found) return { state: "absent" };
    // a process whose creation time cannot be read is a failed look, never an identity
    return typeof found.start === "number" && found.start > 0 ? { state: "present", startTime: String(Math.round(found.start * 1e7)) } : { state: "unknown" };
  }
  const r = await run("ps", ["-o", "lstart=", "-p", String(pid)], abort);
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
  // A failed look ("unknown": ps could not be spawned or timed out on a loaded host) is retried; a process
  // that is absent is not. Without the retry one slow ps made a healthy child "uncertain-transport".
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = await observeProcess(pid, platform);
    if (seen.state === "present") return { pid, startTime: seen.startTime, registeredAt: now };
    if (seen.state === "absent") return null;
    await sleep(150);
  }
  return null;
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
  /** A stop (maintenance cancelled): every helper look and every wait ends at once, and an interrupted step answers unknown / not
   *  verified, never absent / gone (PIP-REDESIGN 2.5). Not `signal`: that name is the kill function above. */
  abort?: AbortSignal;
}
const defaultSignal = (pid: number, sig: NodeJS.Signals | 0) => { process.kill(pid, sig); };
const observer = (deps: ReaperDeps, platform: NodeJS.Platform) => deps.observe
  ?? (deps.startTime
    ? async (pid: number): Promise<Observation> => { const v = await deps.startTime!(pid); return v === null ? { state: "unknown" } : { state: "present", startTime: v }; }
    : (pid: number) => observeProcess(pid, platform, deps.abort));
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
  const abort = deps.abort;
  const signal = deps.signal ?? defaultSignal, wait = deps.wait ?? ((ms: number) => abortableSleep(ms, abort));
  const term = deps.termGraceMs ?? REAPER_TERM_GRACE_MS, force = deps.forceWaitMs ?? REAPER_FORCE_WAIT_MS;
  if (platform === "win32") return deps.jobName ? stopWindowsJob(deps.jobName, term + force, deps.jobRunner, abort) : false;
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const settled = () => gone(signal, pid) && goneProc(signal, pid);
  // a stop ends the wait at the next 25 ms poll and answers false (not verified gone): the attempt keeps its record for the next pass
  const poll = async (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (settled()) return true; if (abort?.aborted) return false; await wait(Math.min(25, Math.max(1, end - Date.now()))); if (abort?.aborted) return false; }
    return settled();
  };
  if (settled()) return true;
  if (abort?.aborted) return false;
  const send = (sig: NodeJS.Signals) => { try { signal(-pid, sig); } catch { try { signal(pid, sig); } catch { /* verify below */ } } };
  send("SIGTERM");
  if (await poll(term)) return true;
  send("SIGKILL");
  return poll(force);
}

/** Linux: how many /proc entries the argv sweep reads between hand-backs of the event loop. */
export const PROC_SWEEP_BATCH = 64;
/** Argv sweep: processes whose command line contains the temp root. Never matches the running process. Null when the process list could not
 *  be read, or when `abort` stopped the look. Linux reads /proc in batches of PROC_SWEEP_BATCH with the loop handed back between them, so a
 *  stop (a timer, a controller) reaches it; `procRoot` is a test seam. */
export async function sweepByArgv(needle: string, platform: NodeJS.Platform = process.platform, abort?: AbortSignal, procRoot = "/proc", windowsList: WindowsProcessSource = nativeProcessList): Promise<number[] | null> {
  if (!needle) return [];
  if (abort?.aborted) return null;
  const self = process.pid;
  if (platform === "linux") {
    let names: string[];
    try { names = readdirSync(procRoot); } catch { return null; }
    const pids: number[] = [];
    let read = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === self) continue;
      // a stop ends the look between entries, and an interrupted look is a failed one (null): never an empty process list
      if (read > 0 && read % PROC_SWEEP_BATCH === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (abort?.aborted) return null;
      }
      read++;
      try { if (readFileSync(join(procRoot, name, "cmdline"), "utf8").includes(needle)) pids.push(pid); }
      catch (e) { const code = (e as NodeJS.ErrnoException).code; if (code !== "ENOENT" && code !== "ESRCH") return null; /* a raced exit is fine; anything else is a failed look */ }
    }
    return abort?.aborted ? null : pids;
  }
  if (platform === "win32") {
    const list = windowsList();
    if (!list || abort?.aborted) return null;
    // Windows matches the command line case-insensitively (the old CIM -like did too); the native list gives it split into arguments
    const wanted = needle.toLowerCase();
    return list
      .filter((entry) => entry.pid !== self && entry.exe !== "" && entry.argv !== null && entry.argv.join(" ").toLowerCase().includes(wanted))
      .map((entry) => entry.pid);
  }
  const r = await run("ps", ["-axo", "pid=,command="], abort);
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
  const sweep = deps.sweep ?? ((needle: string) => sweepByArgv(needle, deps.platform, deps.abort));
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
  if (deps.abort?.aborted) return { action: "none" };
  const outcome = await reapAttemptProcess(t, deps);
  // stopped mid-look: nothing was learned, so nothing is charged (no reaper failure) and nothing changes; the next pass owns the cleanup
  if (deps.abort?.aborted) return { action: "none" };
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
  const sweep = deps.sweep ?? ((needle: string) => sweepByArgv(needle, deps.platform, deps.abort));
  for (const name of names) {
    // a stop ends the sweep between entries: the rest is left for the next hourly pass
    if (deps.abort?.aborted) break;
    const dir = join(base, name);
    if (known.has(dir)) continue;
    const found = await sweep(dir);
    if (deps.abort?.aborted) { kept.push(dir); break; }
    // A failed process list is not an empty one: the directory stays.
    if ((deps.platform ?? process.platform) === "win32" || found === null || found.length) { kept.push(dir); continue; }
    removeTempRoot(base, dir); removed.push(dir);
  }
  return { removed, kept };
}

// ------------------------------------------------- 1.0.3 credential copies ----

export interface CredentialSweepDeps {
  platform?: NodeJS.Platform;
  /** Removes one directory ENTRY, never what a link points at (tests). Default: win32 the addon's removeTree (the top opened as itself),
   *  else, and where the addon is missing, unlinkSync (unlink never follows the last component). Never rmSync. */
  removeEntry?: (path: string) => void;
  log?: (line: string) => void;
  /** The real path of a folder (tests). Default realpathSync.native. */
  realpath?: (path: string) => string;
}
const credentialSweepLogged = new Set<string>();
function logOnce(deps: CredentialSweepDeps, key: string, line: string): void {
  if (credentialSweepLogged.has(key)) return;
  credentialSweepLogged.add(key);
  (deps.log ?? ((l: string) => console.warn(l)))(line);
}
const isRealDir = (s: Stats) => s.isDirectory() && !s.isSymbolicLink();
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Removes the `.credentials.json` copies 1.0.3's text-only Claude runs left in `<base>/<root>/home/`, on every platform and independent of
 *  any run record or process (CLAUDE-SCOPE.md Part B, B.1 step 5). Fail closed: a root or home that is a link (a junction is one on
 *  Windows), or whose real path is not exactly the path walked, is skipped and its copy kept; only the file entry itself is ever removed.
 *  Residual, stated in the design: a same-user process can swap `home` between the check and the unlink; that is detected and logged. */
export function sweepStaleCredentialCopies(base: string, deps: CredentialSweepDeps = {}): { removed: string[]; kept: string[] } {
  const removed: string[] = [], kept: string[] = [];
  let realBase: string, names: string[];
  const realpath = deps.realpath ?? ((path: string) => realpathSync.native(path));
  try { realBase = realpath(base); names = readdirSync(realBase); } catch (error) {
    if (errCode(error) !== "ENOENT") logOnce(deps, `base\0${base}`, `pip: stale credential sweep could not list ${base} (${errCode(error) ?? "error"}); retried next pass`);
    return { removed, kept };
  }
  const platform = deps.platform ?? process.platform;
  const removeEntry = deps.removeEntry ?? ((path: string) => {
    const tree = platform === "win32" ? addonTreeRemove() : null;
    if (tree) tree(path); else unlinkSync(path);
  });
  for (const name of names) {
    if (!ROOT_NAME.test(name)) continue;
    const root = join(realBase, name), home = join(root, "home"), file = join(home, ".credentials.json");
    let homeBefore: Stats;
    try {
      const rootStat = lstatSync(root);
      if (!isRealDir(rootStat)) { if (rootStat.isSymbolicLink()) { kept.push(file); logOnce(deps, `redirected\0${root}`, `pip: stale credential sweep skipped ${root}: redirected`); } continue; }
      homeBefore = lstatSync(home);
    } catch (error) {
      if (errCode(error) === "ENOENT") continue;
      kept.push(file); logOnce(deps, `stat\0${root}`, `pip: stale credential sweep skipped ${root} (${errCode(error) ?? "error"})`); continue;
    }
    if (!isRealDir(homeBefore)) {
      if (homeBefore.isSymbolicLink()) { kept.push(file); logOnce(deps, `redirected\0${home}`, `pip: stale credential sweep skipped ${home}: redirected`); }
      continue;
    }
    let real: string | null = null;
    try { real = realpath(home); } catch { /* unresolvable: treated as redirected */ }
    if (real !== home) { kept.push(file); logOnce(deps, `redirected\0${home}`, `pip: stale credential sweep skipped ${home}: redirected`); continue; }
    let entry: Stats;
    try { entry = lstatSync(file); } catch (error) {
      if (errCode(error) === "ENOENT") continue;
      kept.push(file); logOnce(deps, `stat\0${file}`, `pip: stale credential sweep kept ${file} (${errCode(error) ?? "error"}); retried next pass`); continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) { kept.push(file); logOnce(deps, `kind\0${file}`, `pip: stale credential sweep skipped ${file}: not a file`); continue; }
    try { removeEntry(file); } catch (error) {
      kept.push(file); logOnce(deps, `remove\0${file}`, `pip: stale credential sweep kept ${file} (${errCode(error) ?? "error"}); retried next pass`); continue;
    }
    removed.push(file);
    // detection, not prevention: a home swapped under the walk is reported; nothing further is removed in that root this pass
    let homeAfter: Stats | null = null;
    try { homeAfter = lstatSync(home); } catch { /* gone: reported below */ }
    if (!homeAfter || homeAfter.dev !== homeBefore.dev || homeAfter.ino !== homeBefore.ino || !isRealDir(homeAfter)) {
      (deps.log ?? ((l: string) => console.warn(l)))(`pip: stale credential sweep: ${home} swapped during sweep`);
    }
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
