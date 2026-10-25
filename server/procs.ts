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
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { assignPipJob, closePipJob, createPipJob, PipJobRefusedError, stopWindowsJob } from "./memory/pip-job.ts";
import { loadExclusionAddon, type NativeHandle } from "./engine-exclusion.ts";
import { createHash, randomUUID } from "node:crypto";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";
import { platformConfirmStopped, recordProcessHandle } from "./platform-process-hooks.ts";

export function resolveCli(cli: string, args: string[] = [], searchPath?: string): ResolvedSpawn {
  return resolveCliSpawn(cli, args, searchPath);
}

/** The PATH of an environment handed to a probe (Windows keys are case-insensitive, so `Path` counts), or undefined. */
export function envSearchPath(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined): string | undefined {
  if (!env) return undefined;
  if (typeof env.PATH === "string") return env.PATH;
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
  return key && typeof env[key] === "string" ? env[key] : undefined;
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
  /** Windows job route (U24): the root is the job launcher; this is the engine CLI it started, from the launcher's report. */
  cliPid?: number;
  /** Windows without a job: the one taskkill this root ever gets was started (a later request sends the root kill only). */
  taskkillSent?: boolean;
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

/** The Windows job a CLI runs in (PIP: Local\\murage-pip-<id>; an engine turn: Local\\murage-pip-eng-<uuid>, the PIP naming the
 *  addon accepts). U24 design R2/R3: on Windows a turn with a job runs on the job route or not at all. The job is created first,
 *  the launcher (job-launcher.ts) is started and put in the job while it is still blocked, and only then does it start the CLI,
 *  so the CLI and everything it ever starts are in the job before their first instruction. A launch that cannot be contained
 *  (no addon, no launcher file, the job could not be created, the launcher could not be assigned) is refused: PIP as before
 *  (PipJobRefusedError / cliJobRefused), an engine with a returned child whose `error` carries code ECONTAIN. */
export interface CliJob { name: string }

/** The one sentence an engine gets when its launch could not be contained (the turn was not started). */
export const ENGINE_CONTAINMENT_MESSAGE = "Murage could not keep this engine's processes under its control, so the turn was not started. Restart Murage and try again; if it keeps happening, reinstall Murage.";
export const ENGINE_CONTAINMENT_CODE = "ECONTAIN";

let containmentWarned = false;
/** Windows engine turns: a fresh named job for the launcher and the CLI. Always a job on Windows (U24 design R3); undefined
 *  elsewhere. A Windows build that cannot contain engines (no usable addon, no launcher file) says so once in the app log; its
 *  launches are refused by spawnCli, never run uncontained. */
export function engineJob(): CliJob | undefined {
  if (process.platform !== "win32") return undefined;
  if (!containmentWarned && !containmentAvailable()) {
    containmentWarned = true;
    console.warn("[procs] engine turns on this Windows build cannot be contained (no usable engine-exclusion addon or job launcher) and will be refused");
  }
  return { name: `Local\\murage-pip-eng-${randomUUID()}` };
}

function containmentAvailable(): boolean {
  let addon: ReturnType<typeof loadExclusionAddon> = null;
  try { addon = loadExclusionAddon(); } catch { return false; }
  if (typeof addon?.jobCreate !== "function" || typeof addon.jobAssign !== "function") return false;
  return launcherPath() !== null;
}

/** The launcher file (job-launcher.ts in dev, its compiled sibling packaged), or null when the build lacks it. */
function launcherPath(): string | null {
  const path = SPAWNED_PROXIES.jobLauncher;
  return existsSync(path) ? path : null;
}

/** The launcher's own environment (U24 design R2.1): fixed, built from nothing the turn controls, so no NODE_OPTIONS, loader or
 *  preload can run code before the launcher's gate. The turn's environment reaches the CLI through the frame, after assignment. */
export function launcherEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["SystemRoot", "SYSTEMDRIVE", "TEMP", "TMP"]) if (typeof base[key] === "string") env[key] = base[key];
  return env;
}

/** The frame the server writes to the launcher's stdin once it is in the job: a length line, then that many bytes of JSON. */
export function launcherFrame(env: NodeJS.ProcessEnv | undefined, cwd: string | undefined): Buffer {
  const body = Buffer.from(JSON.stringify({ env: env ?? {}, cwd: cwd ?? "" }), "utf8");
  return Buffer.concat([Buffer.from(`${body.length}\n`, "utf8"), body]);
}

/** Windows job route: the pid of the engine CLI the launcher started (undefined until its report arrives, or off the route). */
export function cliProcessPid(child: ChildProcess): number | undefined {
  return cliOwnership.get(child)?.cliPid;
}
/** The process that IS the engine, for tree probes that look at its children: the CLI behind the launcher, else the child. */
export function engineProcessPid(child: ChildProcess): number | undefined {
  return cliProcessPid(child) ?? child.pid;
}
/** How this CLI's tree is held for Stop: a Windows job (every process it creates is in it) or nothing beyond the root. */
export function cliContainment(child: ChildProcess): "job" | "none" {
  const owned = cliOwnership.get(child);
  return owned?.jobName && !owned.jobRefused ? "job" : "none";
}

const engineContainmentError = (reason: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${ENGINE_CONTAINMENT_MESSAGE} (${reason})`), { code: ENGINE_CONTAINMENT_CODE, syscall: "spawn" });

/** Emit a spawn-time failure the way Node does for ENOENT: `error` on the next tick, to listeners the caller attached right
 *  after spawnCli returned. With no listener the sentence goes to the app log instead of becoming an uncaught exception. */
function emitLaunchError(child: ChildProcess, error: NodeJS.ErrnoException): void {
  process.nextTick(() => {
    if (child.listenerCount("error") > 0) child.emit("error", error);
    else console.warn(`[procs] ${error.message}`);
  });
}

/** An engine launch refused before anything was started (no addon, no launcher, no job): a child object that reports the refusal
 *  as Node reports ENOENT (error, then exit and close with -2), holds no process and no pid. */
function unstartedLaunch(command: string, args: string[], reason: string): ChildProcessByStdio<Writable, Readable, Readable> {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, exitCode: null as number | null, signalCode: null, killed: false, connected: false, spawnfile: command, spawnargs: [command, ...args],
    stdin, stdout, stderr, stdio: [stdin, stdout, stderr, null, null], kill: () => false, ref: () => {}, unref: () => {},
  }) as unknown as ChildProcessByStdio<Writable, Readable, Readable>;
  stdin.on("error", () => {});
  // Owned like any refused launch (cliJobRefused, containment "none"); with no pid there is nothing to stop, so a stop confirms.
  const ownership: CliOwnership = { pid: undefined, platform: process.platform, closed: false, stopped: false, jobRefused: true, observations: [], observers: new Set() };
  cliOwnership.set(child, ownership);
  emitLaunchError(child, engineContainmentError(reason));
  process.nextTick(() => {
    (child as { exitCode: number | null }).exitCode = -2;
    ownership.exited = true;
    child.emit("exit", -2, null);
    stdout.end(); stderr.end();
    ownership.closed = true;
    child.emit("close", -2, null);
  });
  return child;
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
  // Windows, a job (PIP or engine): the job exists before anything does, the launcher is started and put in the job while it is
  // blocked on its stdin, and only then (the frame) does it start the CLI inside the job (U24 design R2). A launch that cannot
  // be contained is refused (R3): PIP throws PipJobRefusedError (job creation) or returns the ended launcher with
  // cliJobRefused; an engine gets a child whose `error` carries ECONTAIN. Nothing ever runs outside its job.
  const contained = process.platform === "win32" && job !== undefined && !launch;
  const forEngine = contained && job!.name.startsWith("Local\\murage-pip-eng-");
  let pipJob: NativeHandle | undefined;
  let launcher: string | null = null;
  if (contained) {
    launcher = launcherPath();
    if (launcher === null) {
      if (forEngine) { console.warn(`[procs] engine launch refused for ${cli}: no job launcher file in this build (${SPAWNED_PROXIES.jobLauncher})`); return unstartedLaunch(command, launchArgs, "launcher file missing"); }
      throw new PipJobRefusedError("launcher");
    }
    try { pipJob = createPipJob(job!.name); }
    catch (error) {
      if (!forEngine) throw error;
      // (1b): the exact cause reaches server.log (and so Export diagnostics): the addon load error or the job create error.
      console.warn(`[procs] engine launch refused for ${cli}: the job could not be created: ${(error as PipJobRefusedError).reason ?? "job"} (${error instanceof Error ? error.message : String(error)})`);
      return unstartedLaunch(command, launchArgs, "job create: " + ((error as PipJobRefusedError).reason ?? "job"));
    }
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
    // PIP and engine turns on Windows use a named job through the launcher; other Windows CLIs use taskkill /T.
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  // The launcher: the server's own Node (process.execPath run as Node) with a fixed environment, the CLI's argv after "--",
  // the turn's cwd and stdio, and a fourth pipe for its one-line report. It executes nothing of the turn's before the frame.
  const startLauncher = () => spawn(process.execPath, [launcher!, "--", command, ...launchArgs], {
    cwd: opts.cwd,
    env: launcherEnvironment(),
    stdio: [...(stdio as Array<unknown>).slice(0, 3), "pipe"] as StdioOptions,
    windowsHide: true,
  }) as ChildProcessByStdio<Writable, Readable, Readable>;
  const child = pipJob ? startLauncher() : start();
  // The assignment is the next synchronous call after spawn() and completes before spawnCli returns. The launcher is blocked on
  // its stdin until the frame, so a refused assignment (the addon could not open or assign it; it has then ended it with
  // PIP_JOB_REFUSAL where it could) ends a process that started nothing: it is ended here too through Node's own handle, its
  // stdin destroyed unwritten, and the launch is refused (cliJobRefused; an engine's child also reports ECONTAIN). A start that
  // failed outright (no pid) is refused the same way: its `error` reports it.
  let jobRefused = false;
  if (pipJob && (child.pid === undefined || !assignPipJob(pipJob, child.pid))) {
    const started = child.pid !== undefined;
    closePipJob(pipJob);
    pipJob = undefined;
    jobRefused = true;
    if (started) {
      try { child.kill(); } catch { /* the addon's terminate, or already gone */ }
      try { child.stdin?.destroy(); } catch { /* nothing is written to a refused launcher */ }
    }
    if (forEngine) emitLaunchError(child, engineContainmentError(started ? "job assign failed" : "launcher did not start"));
    console.warn(`[procs] ${forEngine ? "engine" : "PIP"} launch refused for ${cli}: ${started ? `the launcher (pid ${child.pid}) could not be put in its job (jobAssign failed)` : "the launcher did not start (no pid)"}`);
  }
  if (pipJob) {
    // In the job: the frame releases the launcher, which starts the CLI as a job member. The driver's prompt follows in the same
    // pipe, in order; the launcher reads exactly the frame and the CLI inherits the rest.
    child.stdin?.write(launcherFrame(opts.env, typeof opts.cwd === "string" ? opts.cwd : opts.cwd?.toString()));
    const report = Array.isArray(child.stdio) ? (child.stdio as Array<unknown>)[3] as Readable | null | undefined : undefined;
    if (report) {
      let line = "";
      let done = false;
      report.on("error", () => {});
      report.on("data", (chunk: Buffer) => {
        if (done) return;
        line += chunk.toString("utf8");
        const end = line.indexOf("\n");
        if (end < 0) { if (line.length > 4096) done = true; return; }
        done = true;
        try {
          const parsed = JSON.parse(line.slice(0, end)) as { pid?: unknown; error?: { code?: unknown; syscall?: unknown; path?: unknown } };
          if (typeof parsed.pid === "number") { const owned = cliOwnership.get(child); if (owned) owned.cliPid = parsed.pid; }
          else if (parsed.error) {
            const code = typeof parsed.error.code === "string" ? parsed.error.code : "ESPAWN";
            const path = typeof parsed.error.path === "string" ? parsed.error.path : command;
            const error = Object.assign(new Error(`spawn ${path} ${code}`), { code, syscall: "spawn", path, spawnargs: launchArgs }) as NodeJS.ErrnoException;
            if (child.listenerCount("error") > 0) child.emit("error", error); else console.warn(`[procs] ${error.message}`);
          }
        } catch { /* a report that is not the launcher's: ignored */ }
      });
    }
  }
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
  // The job name stays with a refused launch too (its refusal and its confirmation read it: a refused launcher was never a
  // member, so its own exit is what confirms it).
  const jobName = job?.name;
  const ownership: CliOwnership = { pid: child.pid, platform: process.platform, jobName, closed: false, stopped: false, observations: [], observers: new Set(), ...(jobRefused ? { jobRefused } : {}) };
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
  // A probe runs the file found on the PATH it is handed first (a driver may put its own engine's folder there, the bundled
  // Fuigo's), so the version it reads belongs to the engine a turn on that PATH launches (isolation-cache.ts engineLaunchFile).
  const resolved = resolveCli(cli, args, envSearchPath(opts.env));
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
    options: { windowsHide: boolean; timeout?: number; killSignal?: NodeJS.Signals },
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
  // U24 design R4: one taskkill per root, ever. A repeat while it is in flight joins it (the first route's delivery time is
  // kept); a repeat after it was delivered, with the root still alive, sends the root kill only.
  if (ownership?.delivering) return;
  if (ownership?.taskkillSent) {
    if (child.exitCode === null && child.signalCode === null) {
      let ok = false;
      try { ok = child.kill(); } catch { /* already gone */ }
      try { observer?.({ route: "windows_child_kill", result: ok ? "succeeded" : "failed" }); } catch { /* diagnostics never affect stop */ }
    }
    return;
  }
  if (ownership) { ownership.taskkillSent = true; deliverTracked(ownership, (done) => killCliTreeWith(child, observer, REAL_KILL_DEPS, done), rootKillWatchdog(child, observer)); }
  else killCliTreeWith(child, observer, REAL_KILL_DEPS);
}

/** U24 design R6: the route watchdog. taskkill is a subprocess; Node kills it at WINDOWS_TASKKILL_CAP_MS, but its callback still
 *  rides later lifecycle events. If the route has not settled delivery WINDOWS_ROUTE_WATCHDOG_MS after the cap, the watchdog
 *  sends the root kill itself and settles delivery, so a Stop is never stuck behind a silent taskkill. */
function rootKillWatchdog(child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill">, observer?: StopRouteObserver): { afterMs: number; fallback: () => void } {
  return {
    afterMs: WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS,
    fallback: () => {
      try { observer?.({ route: "windows_child_kill", result: "fallback" }); } catch { /* diagnostics never affect stop */ }
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { const ok = child.kill(); observer?.({ route: "windows_child_kill", result: ok ? "succeeded" : "failed" }); }
      catch { try { observer?.({ route: "windows_child_kill", result: "failed" }); } catch { /* diagnostics */ } }
    },
  };
}

/** Run one termination route and record it as in flight until `done`; with a watchdog, settle it by `afterMs` regardless. */
function deliverTracked(owned: Pick<CliOwnership, "delivering" | "deliveredAt" | "taskkillSent">, start: (done: () => void) => void, watchdog?: { afterMs: number; fallback: () => void }): void {
  let finish!: () => void;
  const delivery = new Promise<void>((resolve) => { finish = resolve; });
  owned.delivering = delivery;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    if (owned.delivering === delivery) { owned.delivering = undefined; owned.deliveredAt = Date.now(); }
    finish();
  };
  if (watchdog) {
    timer = setTimeout(() => { if (finished) return; try { watchdog.fallback(); } finally { done(); } }, watchdog.afterMs);
    timer.unref?.();
  }
  try { start(done); } catch (error) { done(); throw error; }
}

/** Windows, no job (U24 design R6/R7): taskkill is killed at its cap; the watchdog settles delivery a second later at the
 *  latest; the root then has WINDOWS_ROOT_CLOSE_MS from delivery to close; the route's absolute cap is the sum. */
export const WINDOWS_TASKKILL_CAP_MS = 4_000;
export const WINDOWS_ROUTE_WATCHDOG_MS = 1_000;
export const WINDOWS_ROOT_CLOSE_MS = 5_000;
export const WINDOWS_STOP_ROUTE_CAP_MS = WINDOWS_TASKKILL_CAP_MS + WINDOWS_ROUTE_WATCHDOG_MS + WINDOWS_ROOT_CLOSE_MS;
/** Windows job route: how long any caller waits for the job's own answer before reading "not stopped" (the attempt itself
 *  continues: a late empty-job answer still marks the tree stopped and releases every teardown waiter, U24 design R5). */
export const JOB_STOP_CAP_MS = 4_500;

/** Windows without a job: root `close` (every stdio pipe of the root at EOF, so no descendant that inherited them is still
 *  holding them) is what confirms. The close budget counts from delivered termination: taskkill /T is a subprocess and can
 *  take seconds to answer (5 s to refuse with "Access denied" in a session without WMI access), and until it answers, and on
 *  failure the fallback kill went out, nothing has been terminated. A route already in flight (killCliTree's) is joined, not
 *  raced by a second taskkill. Fail-closed: a root that has not closed by then, or a route that never answers by the cap,
 *  reads "not stopped". Exported for tests (the kill route is injected there). */
export function confirmWindowsRootClose(
  child: Pick<ChildProcess, "once" | "off" | "exitCode" | "signalCode" | "kill">,
  owned: { closed: boolean; delivering?: Promise<void>; deliveredAt?: number; taskkillSent?: boolean },
  startRoute: (done: () => void) => void,
  closeMs = WINDOWS_ROOT_CLOSE_MS,
  capMs = WINDOWS_STOP_ROUTE_CAP_MS,
): Promise<boolean> {
  if (owned.closed) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(cap); if (closeTimer) clearTimeout(closeTimer); child.off("close", closed); resolve(value); };
    const closed = () => finish(true);
    const cap = setTimeout(() => finish(false), Math.max(capMs, closeMs));
    // U24: a route that answers after the close landed or the cap fired arms nothing (no stray timer).
    const armClose = () => { if (!settled && !closeTimer) closeTimer = setTimeout(() => finish(false), closeMs); };
    child.once("close", closed);
    const inFlight = owned.delivering;
    if (inFlight) void inFlight.then(armClose);
    // U24 design R6: a route whose callback never comes is settled by the watchdog, which sends the root kill (and says so)
    // before delivery completes and the close budget starts.
    else {
      const watchdog = rootKillWatchdog(child);
      deliverTracked(owned, (done) => startRoute(() => { done(); armClose(); }), { afterMs: watchdog.afterMs, fallback: () => { watchdog.fallback(); armClose(); } });
    }
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
  // U24 design R5: on the Windows job route every caller, the first and every one that joins, reads the answer by
  // JOB_STOP_CAP_MS while the attempt itself continues (a late empty-job answer still marks the tree stopped).
  const jobCap = owned.platform === "win32" && owned.jobName && !owned.jobRefused ? JOB_STOP_CAP_MS : undefined;
  const view = jobCap === undefined ? deadlineMs : Math.min(deadlineMs ?? jobCap, jobCap);
  if (owned.stopping) {
    if (force) { try { owned.escalate?.(); } catch { /* confirmation still decides */ } }
    // Joined, not restarted: this caller still gets its own deadline.
    return callerView(owned.stopping, view);
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
        const rootGone = () => owned.exited === true || owned.closed || child.exitCode !== null || child.signalCode !== null;
        if (owned.jobRefused) {
          // A refused launcher was never a job member and started nothing (no frame): its own exit is what confirms it. It was
          // ended by the addon and through Node's handle at refusal; this only observes.
          observe({ route: "windows_child_kill", result: "requested" });
          if (rootGone()) return true;
          return new Promise<boolean>(resolve => {
            // T9b: a refused launcher still running after CLI_FORCE_WAIT_MS is said in the app log, by pid.
            const overdue = setTimeout(() => { if (!rootGone()) console.warn(`[procs] a refused launcher (pid ${pid}) is still running ${CLI_FORCE_WAIT_MS} ms after it was ended; its exit is still awaited`); }, CLI_FORCE_WAIT_MS);
            overdue.unref?.();
            const onExit = () => { clearTimeout(timer); clearTimeout(overdue); child.off("exit", onExit); child.off("close", onExit); resolve(true); };
            const timer = setTimeout(() => { clearTimeout(overdue); child.off("exit", onExit); child.off("close", onExit); resolve(rootGone()); }, termGraceMs + CLI_FORCE_WAIT_MS);
            child.once("exit", onExit);
            child.once("close", onExit);
            try { child.kill(); } catch { /* already gone */ }
          });
        }
        owned.escalate = () => { void stopWindowsJob(jobName, CLI_FORCE_WAIT_MS); };
        // U24 design R5: terminate the job and confirm on its own count. Every member, the launcher and the CLI included, is in
        // the job before its first instruction (R2), so an empty job is the whole tree gone: nothing is waited for after it.
        // The root's exit and close arrive on their own; a root still reported alive after the empty answer gets the root kill
        // (its handle closes the job then, the same way the supervisor's exit did).
        observe({ route: "windows_job", result: "requested" });
        const emptied = await stopWindowsJob(jobName, termGraceMs + CLI_FORCE_WAIT_MS);
        observe({ route: "windows_job", result: emptied ? "succeeded" : "failed" });
        if (emptied && !rootGone()) { observe({ route: "windows_child_kill", result: "fallback" }); try { child.kill(); } catch { /* already gone */ } }
        // An empty job is the whole tree gone, so the root's close is moments away. It is awaited (bounded) before the stop
        // counts, as POSIX's settled() does: the driver's own close handling (the turn's settle, its last diagnostics and native
        // log rows) has then run, so a dispose, a deletion hold or a turn teardown wait never answers ahead of it.
        if (emptied && !owned.closed) {
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); child.off("close", done); resolve(); };
            const timer = setTimeout(done, CLI_FORCE_WAIT_MS);
            child.once("close", done);
          });
        }
        return emptied;
      }
      // Windows without a job keeps EXACTLY the 1.0.1 stop semantics: one
      // `taskkill /PID <pid> /T /F` while the root is known alive, root close
      // is what confirms, and a closed root is never re-targeted by its retained
      // PID (the number may belong to an unrelated process by then). Proving
      // that every Windows descendant has stopped needs owned job handles; that
      // arrives with the native Job Object lane, not here.
      if (owned.closed) return true;
      // U24 design R4: a root whose one taskkill already went out gets the root kill only, never a second taskkill.
      return confirmWindowsRootClose(child, owned, (done) => {
        if (owned.taskkillSent) { rootKillWatchdog(child, observe).fallback(); done(); return; }
        owned.taskkillSent = true;
        killCliTreeWith(child, observe, REAL_KILL_DEPS, done);
      });
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
  return callerView(attempt, view);
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
    // U24 design R6: taskkill itself is capped. Node ends it at the cap and the callback reports the error, so the root kill
    // fallback goes out and delivery settles; the watchdog in deliverTracked covers a callback that never comes.
    deps.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: WINDOWS_TASKKILL_CAP_MS, killSignal: "SIGKILL" }, (err) => {
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
