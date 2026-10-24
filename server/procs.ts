import { cloudTurnLaunch } from "./cloud-home/turn-process.ts";
import { registerCloudTurnUnit } from "./cloud-home/cloud-process-hooks.ts";
// Cross-platform process spawning for the agent CLIs. Four Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
//   4. CreateProcess has a 32,767-character command-line limit. Keep prompt
//      bodies on stdin or in private files and fail clearly if a future
//      driver accidentally puts one back in argv.
import {
  spawn,
  execFile,
  type ChildProcess,
  type ChildProcessByStdio,
  type ExecFileOptions,
  type SpawnOptions,
  type StdioOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assignPipJob, closePipJob, createPipJob, stopWindowsJob } from "./memory/pip-job.ts";
import { loadExclusionAddon, type NativeHandle } from "./engine-exclusion.ts";
import { createHash, randomUUID } from "node:crypto";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";
import { platformConfirmStopped, recordProcessHandle } from "./platform-process-hooks.ts";

export function resolveCli(cli: string, args: string[] = []): ResolvedSpawn {
  return resolveCliSpawn(cli, args);
}

/** Leave headroom below CreateProcess' 32,767 UTF-16 code-unit limit for
 * libuv's quoting and environment-specific executable expansion. */
export const WINDOWS_SAFE_COMMAND_LINE_CHARS = 30_000;

/** Conservative size of the command line libuv will give CreateProcess.
 * JSON string quoting escapes every slash/quote case Windows quoting needs,
 * so this can over-count but cannot hide a dangerous launch. */
export function estimatedWindowsCommandLineChars(resolved: ResolvedSpawn): number {
  return [resolved.command, ...resolved.args].reduce(
    (total, value) => total + JSON.stringify(value).length + 1,
    0,
  );
}

export function assertSafeCliArgv(
  resolved: ResolvedSpawn,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  if (estimatedWindowsCommandLineChars(resolved) <= WINDOWS_SAFE_COMMAND_LINE_CHARS) return;
  const error = new Error(
    "agent CLI launch arguments exceed Windows' command-line limit; pass large prompts through stdin or a file",
  ) as NodeJS.ErrnoException;
  error.code = "ENAMETOOLONG";
  throw error;
}

export const CLI_TERM_GRACE_MS = 3_000;
export const CLI_FORCE_WAIT_MS = 1_000;
/** How long a reset or dispatch caller that passes an explicit deadline waits for
 * the shared confirmation past its SIGTERM grace before reading "not stopped".
 * It is the caller's deadline only: the confirmation keeps running and is
 * joined, not restarted, by later callers. Callers that pass none wait exactly
 * as 1.0.1 did. */
export const CLI_CONFIRM_CAP_MS = 2_500;
/** The deadline a reset or dispatch caller passes for the default SIGTERM grace. */
export const CLI_CALLER_DEADLINE_MS = CLI_TERM_GRACE_MS + CLI_CONFIRM_CAP_MS;
/** How long a pending confirmation stays cached as THE pending stop; past it a
 * retry starts a fresh attempt (the old one may still succeed and is honoured). */
export const CLI_LIFECYCLE_CAP_MS = 20_000;
interface CliOwnership {
  pid: number | undefined;
  platform: NodeJS.Platform;
  jobName?: string;
  closed: boolean;
  stopped: boolean;
  /** POSIX: the root closed and its process group was seen gone. Permanent: the
   * saved numeric group id may belong to an unrelated group from now on, so it is
   * never signalled again; a retry only re-runs the platform confirmation. */
  treeGone?: boolean;
  /** Durable success notification (outlives any attempt or caller deadline). */
  stoppedSignal?: Promise<true>;
  resolveStopped?: (value: true) => void;
  stopping?: Promise<boolean>;
  /** Cut an in-flight stop's SIGTERM grace short: kill the whole tree now. */
  escalate?: () => void;
  observations: StopRouteObservation[];
  observers: Set<StopRouteObserver>;
  /** Windows PIP: the root's `exit` was seen (its streams may stay open while a job member holds them). */
  exited?: boolean;
  /** Windows PIP: the CLI could not be put in its job. It was ended at once and the run is refused (PIP_JOB_REFUSAL). */
  jobRefused?: boolean;
  /** Windows engine: its job could not be created ("create") or the first start could not be put in it ("assign"), so this CLI
   *  runs without one (the taskkill route). */
  jobFallback?: "create" | "assign";
  /** Windows without a job: the taskkill route still in flight. taskkill is a subprocess and can take seconds to answer (5 s to
   *  refuse with "Access denied" when WMI is unavailable to the session), so termination is not delivered until it returns and,
   *  on failure, the fallback kill went out. */
  delivering?: Promise<void>;
  /** When the last tracked delivery finished (Date.now()). */
  deliveredAt?: number;
}
// Evidence belongs to this exact spawn/handle, never a PID recovered after a
// server restart. A retained live session is not stopped until requested.
const cliOwnership = new WeakMap<ChildProcess, CliOwnership>();

/** The Windows job a CLI runs in. PIP's (no `fallback`) is required: a job that cannot be created or assigned refuses the run.
 *  An engine's (`fallback: "no-job"`, engineJob) is a better stop route, never a gate: when the job cannot be created the CLI starts
 *  without one, and when the addon could not put the started CLI in it (it has then ended that CLI before any byte reached its
 *  stdin) the CLI is started once more without one. Either way the turn runs and stops through taskkill /T, then the root kill. */
export interface CliJob { name: string; fallback?: "no-job" }

/** Windows engine turns: a fresh named job (Local\\murage-pip-eng-<id>, the PIP naming the addon accepts) when the addon can make one,
 *  so a stop terminates the CLI and every process it started (taskkill /T can be denied, and the root kill alone leaves
 *  grandchildren holding the root's pipes). undefined elsewhere and without the addon: today's taskkill route. */
export function engineJob(): CliJob | undefined {
  if (process.platform !== "win32") return undefined;
  let addon: ReturnType<typeof loadExclusionAddon> = null;
  try { addon = loadExclusionAddon(); } catch { return undefined; }
  if (typeof addon?.jobCreate !== "function") return undefined;
  return { name: `Local\\murage-pip-eng-${randomUUID()}`, fallback: "no-job" };
}

/** Windows: libuv starts the CLI already running, so a process it started before jobAssign is in no job and would escape the job's
 *  stop. Right after a successful assignment, ONE sweep of the native process table puts every descendant of the root in the job
 *  too (a descendant starts no earlier than its parent: an older row under a reused parent pid is not one, and a row whose start
 *  cannot be read is skipped). A descendant the addon
 *  cannot assign is ended by it (the refusal code) and logged; the sweep never throws. Exported for tests. */
export function sweepJobDescendants(job: NativeHandle, rootPid: number): number[] {
  const assigned: number[] = [];
  let rows: Array<{ pid: number; ppid: number; start: unknown }>;
  try { rows = loadExclusionAddon()?.processes() ?? []; } catch (error) { console.warn(`[procs] job sweep: the process table could not be read (${error instanceof Error ? error.message : String(error)})`); return assigned; }
  // The addon reports `start` as seconds (FILETIME ticks / 1e7, fractional); 0 means it could not be read.
  const startOf = (row: { start: unknown }): number | null => typeof row.start === "number" && Number.isFinite(row.start) && row.start > 0 ? row.start : null;
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return assigned;
  const rootStart = startOf(root);
  if (rootStart === null) return assigned; // no start to compare against: assign nothing rather than a stranger
  const queue: Array<{ pid: number; start: number }> = [{ pid: rootPid, start: rootStart }];
  const seen = new Set<number>([rootPid]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid !== parent.pid || seen.has(row.pid) || row.pid === process.pid) continue;
      const start = startOf(row);
      // Unreadable start, or older than its parent (a stale ppid naming a reused pid): skip it, never assign a stranger.
      if (start === null || start < parent.start) continue;
      seen.add(row.pid);
      if (assignPipJob(job, row.pid)) assigned.push(row.pid);
      else console.warn(`[procs] job sweep: descendant ${row.pid} of ${rootPid} could not be put in the job (the addon ended it)`);
      queue.push({ pid: row.pid, start });
    }
  }
  return assigned;
}

/** Windows engine: why this CLI runs without the job it was given (undefined: it has its job, or was given none). */
export function cliJobFallback(child: ChildProcess): "create" | "assign" | undefined {
  return cliOwnership.get(child)?.jobFallback;
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
  job?: CliJob,
  /** Cloud home only: the Docker client the SERVER itself runs against the owner's own
   * server (vps-computer.ts). It is not an engine turn, holds the home's ssh key and
   * must not go through the turn launcher. Nothing else may ask for this. */
  mode?: { serverTool: "docker" },
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  assertSafeCliArgv(resolved);
  const launch = mode?.serverTool === "docker" && cli === "docker" ? null : cloudTurnLaunch(resolved.command, resolved.args, opts.env, opts.cwd);
  const command = launch?.command ?? resolved.command, launchArgs = launch?.args ?? resolved.args;
  // Windows PIP: the job exists before the CLI does (a taken name or a missing addon refuses the run before anything starts), and the
  // CLI is put in it right after it starts (memory/pip-job.ts, THE WINDOW).
  // An engine's job is optional (CliJob): one that cannot be created starts the CLI without it.
  const optionalJob = job?.fallback === "no-job";
  let jobFallback: "create" | "assign" | undefined;
  let pipJob: NativeHandle | undefined;
  if (process.platform === "win32" && job && !launch) {
    try { pipJob = createPipJob(job.name); }
    catch (error) { if (!optionalJob) throw error; jobFallback = "create"; }
  }
  const { stdio, closeStdin } = launchStdio(opts.stdio);
  const rest: SpawnOptions = { ...opts };
  delete rest.detached;
  delete rest.windowsHide;
  const start = () => spawn(command, launchArgs, {
    ...rest,
    stdio,
    // Cloud home: the launcher itself gets a fixed PATH and cwd and four pipes;
    // the turn's env (handed pins included) rides the request on fd 3, and
    // stdin stays a pipe as Rule 74c requires.
    ...(launch ? { env: { PATH: "/usr/bin:/bin" }, cwd: "/", stdio: ["pipe", "pipe", "pipe", "pipe"] as SpawnOptions["stdio"] } : {}),
    // posix: a new session (setsid), so neither the CLI nor any descendant has
    // a controlling terminal (Rule 74c), and its own process group, so
    // kill(-pid) reaps child MCP servers. win32: a hidden console of its own
    // (CREATE_NO_WINDOW, every stdio piped), never DETACHED_PROCESS: a console
    // descendant of a console-less process would get a new visible console.
    // PIP and engine turns use a named job (an engine's falls back to taskkill /T); other CLIs use taskkill /T.
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three
  let child = start();
  // The assignment is the next synchronous call after spawn() and completes before spawnCli returns, so before any caller can write
  // a byte to the CLI's stdin: a CLI never reads its prompt outside its job. A failed assignment (the addon could not open or assign
  // the process; it has then ended it with PIP_JOB_REFUSAL where it could) ends the CLI here too, through Node's own handle, closes
  // its stdin unwritten and refuses the run (cliJobRefused); no pid: nothing started.
  let jobRefused = false;
  if (pipJob && (child.pid === undefined || !assignPipJob(pipJob, child.pid))) {
    const started = child.pid !== undefined;
    closePipJob(pipJob);
    pipJob = undefined;
    if (started) {
      try { child.kill(); } catch { /* the addon's terminate, or already gone */ }
      try { child.stdin?.destroy(); } catch { /* nothing is written to a refused CLI */ }
    }
    if (!optionalJob) jobRefused = started;
    else if (started) {
      // Engine: the refused start got no byte and is ended (by the addon and by Node's handle above). The turn is not refused: the
      // CLI starts once more, outside any job, and stops through taskkill /T, then the root kill (a nested job not allowed, a
      // process that could not be opened). A start that failed outright (no pid) is returned as it is: its `error` reports it.
      const refused = child;
      refused.on("error", () => {});
      try { refused.stdout?.destroy(); refused.stderr?.destroy(); } catch { /* already closed */ }
      jobFallback = "assign";
      child = start();
    }
  }
  // Assigned: the root's descendants started before the assignment join it too (one sweep).
  if (pipJob && child.pid !== undefined) sweepJobDescendants(pipJob, child.pid);
  if (closeStdin && !jobRefused) child.stdin?.end();

  if (launch) {
    registerCloudTurnUnit(child.pid, launch.unit); // so the Cloud process hooks find the turn's scope without /proc
    const requestPipe = child.stdio[3] as Writable;
    requestPipe.on("error", () => {});
    requestPipe.end(launch.request);
  }

  // A write to a dying child's stdin fails differently per platform, and one
  // of the ways is fatal. On POSIX the kill is synchronous, the stream is
  // already destroyed by the time anything writes, and the write throws into
  // the caller's try/catch. On Windows killCliTree goes through taskkill — a
  // subprocess — so there is a window where the child is dead but its pipe is
  // not, and a write during it errors *asynchronously* on the stream. No
  // driver listens for that, an unlistened stream error is an uncaught
  // exception, and the whole harness exits over one dead CLI. The error
  // carries no information the drivers don't already get from `close`, which
  // is where every one of them settles the turn — so it is swallowed, not
  // logged.
  child.stdin?.on("error", () => {});
  // PIP keeps its job name whatever happened (its refusal reads it); an engine names its job only while the CLI is really in it.
  const jobName = optionalJob ? (pipJob ? job!.name : undefined) : job?.name;
  const ownership: CliOwnership = { pid: child.pid, platform: process.platform, jobName, closed: false, stopped: false, observations: [], observers: new Set(), ...(jobRefused ? { jobRefused } : {}), ...(jobFallback ? { jobFallback } : {}) };
  cliOwnership.set(child, ownership);
  recordProcessHandle(child, [command, ...launchArgs].join(" "), opts.env);
  // As the 1.0.2 supervisor did when its CLI exited: closing the last handle ends every process the CLI left in the job. On the
  // root's `exit`, not `close`: a descendant that inherited stdout or stderr keeps the streams (and so `close`) open until the job
  // ends it, and waiting for `close` would wait for that descendant forever.
  child.once("exit", () => {
    ownership.exited = true;
    if (pipJob) closePipJob(pipJob);
  });
  child.once("close", () => {
    ownership.closed = true;
    if (pipJob) closePipJob(pipJob);
    // Root close keeps ownership of POSIX group members and Windows job
    // members until the corresponding tree confirmation finishes.
    if (ownership.platform !== "win32" || ownership.jobName) void awaitCliTreeStopped(child);
  });
  return child;
}

/** Windows PIP: true when spawnCli could not put this CLI in its job, ended it and refused the run (the caller reads it as the
 *  PIP_JOB_REFUSAL path, whatever exit code the ended CLI reports). */
export function cliJobRefused(child: ChildProcess): boolean {
  return cliOwnership.get(child)?.jobRefused === true;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  if (process.env.MURAGE_CLOUD_ROLE === "home") {
    let child: ReturnType<typeof spawnCli>;
    try { child = spawnCli(cli, args, { env: opts.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", "")); return; }
    let stdout = "", stderr = "", done = false;
    const finish = (error: Error | null) => { if (done) return; done = true; clearTimeout(timer); cb(error, stdout, stderr); };
    const timer = setTimeout(() => { killCliTree(child); finish(new Error("Cloud CLI probe timed out")); }, opts.timeout || 8000);
    const receive = (stream: "out" | "err", data: Buffer) => {
      if (stream === "out") stdout += data.toString(); else stderr += data.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > (opts.maxBuffer ?? 1024 * 1024)) {
        killCliTree(child); finish(new Error("Cloud CLI probe output limit exceeded"));
      }
    };
    child.stdout.on("data", data => receive("out", data));
    child.stderr.on("data", data => receive("err", data));
    child.once("error", finish);
    child.once("close", code => finish(code === 0 ? null : new Error("Cloud CLI probe failed")));
    child.stdin.end();
    return;
  }
  const resolved = resolveCli(cli, args);
  try {
    assertSafeCliArgv(resolved);
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  // execFile cannot start a new session (it drops `detached`), so this is
  // execFile's contract on spawn: all three stdio piped, stdin closed at once
  // (no caller writes to it), output bounded by maxBuffer, the run bounded by
  // timeout. posix: a new session, so the probe and every descendant have no
  // controlling terminal, and a timeout or overflow stops the whole group;
  // win32: a hidden console, never detached (Rule 74c, as spawnCli).
  const win32 = process.platform === "win32";
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  const killSignal = opts.killSignal ?? "SIGTERM";
  let child: ChildProcess;
  try {
    child = spawn(resolved.command, resolved.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(win32 ? {} : { detached: true }),
    });
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  child.stdin?.on("error", () => {});
  child.stdin?.end();
  const out: Buffer[] = [], err: Buffer[] = [];
  let bytes = 0, killed = false, overflow = false, settled = false;
  const stop = () => {
    killed = true;
    const pid = child.pid;
    if (!win32 && pid) {
      try { process.kill(-pid, killSignal); return; } catch { /* the group is gone: the child below */ }
    }
    try { child.kill(killSignal); } catch { /* already gone */ }
  };
  const take = (into: Buffer[]) => (chunk: Buffer) => {
    if (overflow) return;
    bytes += chunk.length;
    if (bytes > maxBuffer) { overflow = true; stop(); return; }
    into.push(chunk);
  };
  child.stdout?.on("data", take(out));
  child.stderr?.on("data", take(err));
  const timer = opts.timeout && opts.timeout > 0 ? setTimeout(stop, opts.timeout) : undefined;
  const finish = (error: Error | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    cb(error, Buffer.concat(out).toString("utf8"), Buffer.concat(err).toString("utf8"));
  };
  child.once("error", (error) => finish(error));
  child.once("close", (code, signal) => {
    if (code === 0 && !killed) return finish(null);
    const error = Object.assign(
      new Error(overflow ? "stdout or stderr maxBuffer length exceeded" : `Command failed: ${[resolved.command, ...resolved.args].join(" ")}`),
      { code: overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : code, killed, signal, cmd: [resolved.command, ...resolved.args].join(" ") },
    );
    finish(error);
  });
}

/** The stdio an engine process gets (Rule 74c): stdin is always a pipe, never
 * inherited (a caller that asked to ignore it gets a pipe closed at once);
 * stdout and stderr are pipes unless the caller ignores them. Extra entries
 * (fds past 2) are kept as given. */
function launchStdio(stdio: SpawnOptions["stdio"]): { stdio: StdioOptions; closeStdin: boolean } {
  const given = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
  const out = (value: unknown) => (value === "ignore" ? "ignore" : "pipe");
  return {
    stdio: ["pipe", out(given[1]), out(given[2]), ...given.slice(3)] as StdioOptions,
    closeStdin: given[0] === "ignore",
  };
}

/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
type SpawnFailure = { message: string; setup: boolean };

export function describeSpawnFailure(err: NodeJS.ErrnoException, cli: string): SpawnFailure {
  if (err.code === "ENOENT")
    return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
  if (err.code === "EACCES" || err.code === "EPERM")
    return { message: `\`${cli}\` isn't executable: check its file permissions`, setup: true };
  if (err.code === "ENAMETOOLONG")
    return {
      message: `\`${cli}\` received too much launch data for Windows; update this provider or pass its prompt through stdin/a file`,
      setup: false,
    };
  return { message: `spawn failed: ${err.message}`, setup: false };
}

/** Which termination route killCliTree chose and what it observed (R1-T8).
 * `requested`/`fallback` mark the route choice; `succeeded`/`failed` its
 * outcome. A succeeded taskkill or delivered SIGTERM is command success, not
 * an observed child exit — only the child's `close` proves that. */
export type StopRoute =
  | "windows_job"
  | "windows_taskkill"
  | "windows_child_kill"
  | "posix_group_sigterm"
  | "posix_child_sigterm"
  | "already_exited";
export type StopRouteResult = "requested" | "succeeded" | "failed" | "fallback";
export interface StopRouteObservation {
  route: StopRoute;
  result: StopRouteResult;
  /** errno code only (e.g. ESRCH); never a message, command path or output. */
  errno?: string;
}
export type StopRouteObserver = (observation: StopRouteObservation) => void;

export interface KillCliTreeDeps {
  platform: NodeJS.Platform;
  execFile: (
    command: string,
    args: string[],
    options: { windowsHide: boolean },
    callback: (error: Error | null) => void,
  ) => void;
  killProcess: (pid: number, signal: NodeJS.Signals) => void;
}

const REAL_KILL_DEPS: KillCliTreeDeps = {
  get platform() { return process.platform; },
  execFile: (command, args, options, callback) => { execFile(command, args, options, (error) => callback(error)); },
  killProcess: (pid, signal) => { process.kill(pid, signal); },
};

/** Stop a CLI and every process it spawned (MCP proxies included). The
 * optional observer reports the route; it can never change or break it. */
export function killCliTree(child: ChildProcess, observer?: StopRouteObserver): void {
  const ownership = cliOwnership.get(child);
  if (ownership && (ownership.platform !== "win32" || ownership.jobName)) {
    void stopOwnedCli(child, ownership, observer);
    return;
  }
  if (process.platform !== "win32" && !ownership) {
    // Unknown handles cannot authorize a negative-PID group signal. Keep
    // the exact-child best-effort fallback for existing auxiliary callers.
    try { child.kill("SIGTERM"); } catch { /* no group ownership */ }
    return;
  }
  if (ownership) deliverTracked(ownership, (done) => killCliTreeWith(child, observer, REAL_KILL_DEPS, done));
  else killCliTreeWith(child, observer, REAL_KILL_DEPS);
}

/** Run one termination route and record it as in flight until `done`. */
function deliverTracked(owned: Pick<CliOwnership, "delivering" | "deliveredAt">, start: (done: () => void) => void): void {
  let finish!: () => void;
  const delivery = new Promise<void>((resolve) => { finish = resolve; });
  owned.delivering = delivery;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    if (owned.delivering === delivery) { owned.delivering = undefined; owned.deliveredAt = Date.now(); }
    finish();
  };
  try { start(done); } catch (error) { done(); throw error; }
}

/** Windows, no job: how long root close may take once termination was delivered, and the absolute cap from the start. */
export const WINDOWS_ROOT_CLOSE_MS = 5_000;
export const WINDOWS_STOP_ROUTE_CAP_MS = 15_000;

/** Windows without a job: root `close` (every stdio pipe of the root at EOF, so no descendant that inherited them is still
 *  holding them) is what confirms. The close budget counts from delivered termination: taskkill /T is a subprocess and can
 *  take seconds to answer (5 s to refuse with "Access denied" in a session without WMI access), and until it answers, and on
 *  failure the fallback kill went out, nothing has been terminated. A route already in flight (killCliTree's) is joined, not
 *  raced by a second taskkill. Fail-closed: a root that has not closed by then, or a route that never answers by the cap,
 *  reads "not stopped". Exported for tests (the kill route is injected there). */
export function confirmWindowsRootClose(
  child: Pick<ChildProcess, "once" | "off">,
  owned: { closed: boolean; delivering?: Promise<void>; deliveredAt?: number },
  startRoute: (done: () => void) => void,
  closeMs = WINDOWS_ROOT_CLOSE_MS,
  capMs = WINDOWS_STOP_ROUTE_CAP_MS,
): Promise<boolean> {
  if (owned.closed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => { clearTimeout(cap); if (closeTimer) clearTimeout(closeTimer); child.off("close", closed); resolve(value); };
    const closed = () => finish(true);
    const cap = setTimeout(() => finish(false), Math.max(capMs, closeMs));
    const armClose = () => { if (!closeTimer) closeTimer = setTimeout(() => finish(false), closeMs); };
    child.once("close", closed);
    const inFlight = owned.delivering;
    if (inFlight) void inFlight.then(armClose);
    else deliverTracked(owned, (done) => startRoute(() => { done(); armClose(); }));
  });
}

/** What a close deadline must allow for: a termination route of this CLI still in flight (`pending`), or when the last one
 *  finished (`settledAt`). A close budget counts from delivery, not from the request: on Windows the request is a taskkill
 *  subprocess, and a deadline that starts before it returns reads a slow taskkill as a child that would not close. */
export interface StopDelivery { pending: Promise<void> | null; settledAt: number | null }
export function cliStopDelivery(child: ChildProcess): StopDelivery {
  const owned = cliOwnership.get(child);
  return { pending: owned?.delivering ?? null, settledAt: owned?.deliveredAt ?? null };
}

/** Request termination and confirm the owned lifecycle. POSIX requires root
 * close and group disappearance; Windows PIP requires named job confirmation.
 * Other Windows callers retain their root-close and taskkill contract. */
export function awaitCliTreeStopped(child: ChildProcess, termGraceMs = CLI_TERM_GRACE_MS, deadlineMs?: number): Promise<boolean> {
  const ownership = cliOwnership.get(child);
  if (!ownership) return Promise.resolve(false);
  return stopOwnedCli(child, ownership, undefined, termGraceMs, false, deadlineMs);
}

/** Like awaitCliTreeStopped, but with no SIGTERM grace: a stop already in
 * flight (the child's own close started one) is escalated at once, so the
 * whole tree is killed now instead of when that stop's grace runs out. */
export function forceCliTreeStopped(child: ChildProcess, deadlineMs = CLI_CONFIRM_CAP_MS): Promise<boolean> {
  const ownership = cliOwnership.get(child);
  if (!ownership) return Promise.resolve(false);
  return stopOwnedCli(child, ownership, undefined, 0, true, deadlineMs);
}

function markStopped(owned: CliOwnership): void {
  owned.stopped = true;
  owned.resolveStopped?.(true);
}

function stopOwnedCli(child: ChildProcess, owned: CliOwnership, observer?: StopRouteObserver, termGraceMs = CLI_TERM_GRACE_MS, force = false, deadlineMs?: number): Promise<boolean> {
  if (observer && !owned.observers.has(observer)) {
    owned.observers.add(observer);
    for (const observation of owned.observations) {
      try { observer(observation); } catch { /* diagnostics never affect stop */ }
    }
  }
  if (owned.stopping) {
    if (force) { try { owned.escalate?.(); } catch { /* confirmation still decides */ } }
    // Joined, not restarted: this caller still gets its own deadline.
    return callerView(owned.stopping, deadlineMs);
  }
  if (owned.stopped) return Promise.resolve(true);
  const pid = owned.pid;
  if (pid === undefined) return Promise.resolve(true); // failed spawn
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || child.pid !== pid) return Promise.resolve(false);
  owned.observations = [];
  const observe: StopRouteObserver = (observation) => {
    owned.observations.push(observation);
    for (const listener of owned.observers) {
      try { listener(observation); } catch { /* diagnostics never affect stop */ }
    }
  };
  const run = async () => {
    if (owned.platform === "win32") {
      if (owned.jobName) {
        const jobName = owned.jobName;
        owned.escalate = () => { void stopWindowsJob(jobName, CLI_FORCE_WAIT_MS); };
        // Terminate the job first (the CLI and every member, by name) and confirm it is empty, never waiting on the root's streams
        // before that: a descendant that inherited stdout or stderr holds them open until the job ends it. Then the root itself must
        // have exited (a refused CLI was never in the job; Node's own handle ends it).
        // The route is reported as the other routes are (R1-T8): the job's termination, then the root kill when the root outlived it.
        observe({ route: "windows_job", result: "requested" });
        const emptied = await stopWindowsJob(jobName, termGraceMs + CLI_FORCE_WAIT_MS);
        observe({ route: "windows_job", result: emptied ? "succeeded" : "failed" });
        const rootGone = () => owned.exited === true || owned.closed || child.exitCode !== null || child.signalCode !== null;
        if (rootGone()) return emptied;
        observe({ route: "windows_child_kill", result: "fallback" });
        const exited = await new Promise<boolean>(resolve => {
          const onExit = () => { clearTimeout(timer); child.off("close", onExit); resolve(true); };
          const timer = setTimeout(() => { child.off("exit", onExit); child.off("close", onExit); resolve(rootGone()); }, CLI_FORCE_WAIT_MS);
          child.once("exit", onExit);
          child.once("close", onExit);
          try { observe({ route: "windows_child_kill", result: child.kill() ? "succeeded" : "failed" }); }
          catch { observe({ route: "windows_child_kill", result: "failed" }); /* confirmation still required */ }
        });
        return emptied && exited;
      }
      // Windows without a job keeps EXACTLY the 1.0.1 stop semantics: one
      // `taskkill /PID <pid> /T /F` while the root is known alive, root close
      // is what confirms, and a closed root is never re-targeted by its retained
      // PID (the number may belong to an unrelated process by then). Proving
      // that every Windows descendant has stopped needs owned job handles; that
      // arrives with the native Job Object lane, not here.
      if (owned.closed) return true;
      return confirmWindowsRootClose(child, owned, (done) => killCliTreeWith(child, observer, REAL_KILL_DEPS, done));
    }
    const settled = () => {
      if (owned.treeGone) return true;
      if (!owned.closed) return false;
      try { process.kill(-pid, 0); return false; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        owned.treeGone = true; // permanent: the number may be reused by an unrelated group
        return true;
      }
    };
    const signal = (value: NodeJS.Signals) => {
      if (owned.treeGone) return;
      try { process.kill(-pid, value); }
      catch { if (!owned.closed) { try { child.kill(value); } catch { /* retain uncertainty */ } } }
    };
    owned.escalate = () => { if (!settled()) signal("SIGKILL"); };
    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (!settled()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await new Promise<void>((resolve) => {
          // Root close is an immediate observation even when a fixture has
          // replaced/restored global timers around a provider RPC deadline.
          const wake = () => { clearTimeout(timer); child.off("close", wake); resolve(); };
          const timer = setTimeout(wake, Math.min(25, remaining));
          child.once("close", wake);
        });
      }
      return true;
    };
    if (settled()) {
      observe({ route: "already_exited", result: "succeeded" });
      return true;
    }
    // Preserve existing diagnostic route/fallback observations, including
    // after root close (the retained group is still ours).
    killCliTreeWith({ pid, exitCode: null, signalCode: null, kill: (value) => owned.closed ? false : child.kill(value) }, observe, REAL_KILL_DEPS);
    if (await wait(termGraceMs)) return true;
    signal("SIGKILL");
    return wait(CLI_FORCE_WAIT_MS);
  };
  // A platform hook (Murage Cloud) can only veto: its answer is ANDed with ours.
  const raw = run().then(async (stopped) => stopped && await platformConfirmStopped(child)).catch(() => false);
  // ONE in-flight confirmation per tree. Every caller (reset, dispatch, close,
  // Stop) joins it instead of starting another stop. Callers without a deadline
  // get the confirmation exactly as 1.0.1 timed it; a reset or dispatch caller
  // passes an explicit deadline (callerView) and reads "not stopped" at it without
  // ending the confirmation. The cache is bounded only so a hung platform hook
  // cannot stay THE pending stop forever: past it a retry starts a fresh attempt,
  // and a success that arrives later is still honoured (stoppedSignal).
  const attempt = raw;
  owned.stopping = attempt;
  const capTimer = setTimeout(() => { if (owned.stopping === attempt) owned.stopping = undefined; }, termGraceMs + CLI_LIFECYCLE_CAP_MS);
  capTimer.unref?.();
  void attempt.then((stopped) => {
    clearTimeout(capTimer);
    if (owned.stopping === attempt) owned.stopping = undefined;
    if (stopped) markStopped(owned);
  });
  return callerView(attempt, deadlineMs);
}

/** One caller's view of the shared confirmation: with a deadline it reads "not
 * stopped" at that deadline without ending or restarting the confirmation. */
function callerView(shared: Promise<boolean>, deadlineMs: number | undefined): Promise<boolean> {
  if (deadlineMs === undefined) return shared;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), deadlineMs);
    timer.unref?.();
    void shared.then((value) => { clearTimeout(timer); resolve(value); });
  });
}

/** Has this tree's stop ever been confirmed (however late)? */
export function cliTreeConfirmedStopped(child: ChildProcess): boolean {
  return cliOwnership.get(child)?.stopped === true;
}

/** Resolves true whenever this tree's stop is finally confirmed, however late
 * (after any caller deadline or the cache bound); never resolves otherwise and
 * holds no timer, so a session can register to be released by it. */
export function cliTreeStoppedSignal(child: ChildProcess): Promise<true> {
  const owned = cliOwnership.get(child);
  if (!owned) return new Promise<true>(() => {});
  if (owned.stopped) return Promise.resolve(true);
  return owned.stoppedSignal ??= new Promise<true>((resolve) => { owned.resolveStopped = resolve; });
}

/** killCliTree with injectable OS seams, so route selection and fallback
 * ordering are unit-testable. Mocked routes do not establish Windows runtime
 * behavior. */
export function killCliTreeWith(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  observer: StopRouteObserver | undefined,
  deps: KillCliTreeDeps,
  /** Called once the route has finished: the signal sent, or taskkill answered and, on failure, the fallback kill sent. */
  done?: () => void,
): void {
  try { killCliTreeRoute(child, observer, deps, done); }
  catch (error) { done?.(); throw error; }
}

function killCliTreeRoute(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  observer: StopRouteObserver | undefined,
  deps: KillCliTreeDeps,
  done: (() => void) | undefined,
): void {
  const observe = (route: StopRoute, result: StopRouteResult, error?: unknown) => {
    if (!observer) return;
    try {
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      observer(typeof errno === "string" ? { route, result, errno } : { route, result });
    } catch {
      /* diagnostics never affect termination */
    }
  };
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    observe("already_exited", "succeeded");
    done?.();
    return;
  }

  if (deps.platform === "win32") {
    observe("windows_taskkill", "requested");
    deps.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      if (!err) {
        observe("windows_taskkill", "succeeded");
        done?.();
        return;
      }
      observe("windows_taskkill", "failed", err);
      observe("windows_child_kill", "fallback");
      try {
        // taskkill is unavailable or the tree lookup failed. At least stop
        // the process we own instead of leaving the entire turn running.
        observe("windows_child_kill", child.kill() ? "succeeded" : "failed");
      } catch (error) {
        /* already gone */
        observe("windows_child_kill", "failed", error);
      }
      done?.();
    });
    return;
  }
  observe("posix_group_sigterm", "requested");
  try {
    deps.killProcess(-pid, "SIGTERM");
    observe("posix_group_sigterm", "succeeded");
  } catch (groupError) {
    observe("posix_group_sigterm", "failed", groupError);
    observe("posix_child_sigterm", "fallback");
    try {
      observe("posix_child_sigterm", child.kill("SIGTERM") ? "succeeded" : "failed");
    } catch (error) {
      /* already gone */
      observe("posix_child_sigterm", "failed", error);
    }
  }
  done?.();
}

/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir: string, tag: string): string {
  if (process.platform === "win32") return (
    // Named pipes share a global namespace; DATA_DIR cannot isolate two
    // concurrent app instances the way a POSIX socket directory does.
    `\\\\.\\pipe\\murage-perm-${process.pid}-${tag}`
  );
  const preferred = join(dataDir, `perm-${tag}.sock`);
  // Count bytes, not characters: canonical macOS paths gain /private and
  // multibyte usernames can cross sun_path's limit with few visible letters.
  if (Buffer.byteLength(preferred) < 104) return preferred;
  const scope = createHash("sha256").update(`${dataDir}\0${process.pid}\0${tag}`).digest("hex").slice(0, 24);
  const filename = `murage-perm-${scope}.sock`;
  const temporary = join(tmpdir(), filename);
  // TMPDIR may itself be too deep. The broker chmods its socket to0600; the
  // hash includes installation, process and tag to avoid cross-root aliases.
  return Buffer.byteLength(temporary) < 104 ? temporary : join("/tmp", filename);
}
