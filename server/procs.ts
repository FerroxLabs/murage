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
} from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { powershellArgs, stopWindowsJob } from "./memory/pip-job.ts";
import { createHash } from "node:crypto";
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
/** The longest one confirmation attempt may run past its SIGTERM grace.
 * Chosen to sit inside the waits that depend on it: a reset waits 2 s for a
 * forced stop and a dispatch on a quarantined thread waits up to 3 s. With the
 * old 20 s a hung platform hook stayed cached as the pending attempt, so every
 * retry inside that window joined it and failed again. At 2.5 s (forced stops
 * have no SIGTERM grace) a hung hook costs at most one failed wait: the cap
 * clears the cached attempt before the dispatch window ends, and the dispatch
 * loop then starts a fresh one. A late confirmation still counts when it arrives. */
export const CLI_CONFIRM_CAP_MS = 2_500;
interface CliOwnership {
  pid: number | undefined;
  platform: NodeJS.Platform;
  jobName?: string;
  closed: boolean;
  /** Windows without a job: a taskkill /T /F of this tree already succeeded. */
  taskkillOk?: boolean;
  stopped: boolean;
  /** Windows without a job: a tree-stop (taskkill /T) failed. Root closure
   * cannot clear it; only a later successful taskkill /T can. */
  treeStopFailed?: boolean;
  stopping?: Promise<boolean>;
  /** Cut an in-flight stop's SIGTERM grace short: kill the whole tree now. */
  escalate?: () => void;
  observations: StopRouteObservation[];
  observers: Set<StopRouteObserver>;
}
// Evidence belongs to this exact spawn/handle, never a PID recovered after a
// server restart. A retained live session is not stopped until requested.
const cliOwnership = new WeakMap<ChildProcess, CliOwnership>();

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
  job?: { name: string; argsFile: string },
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  assertSafeCliArgv(resolved);
  let command = resolved.command, launchArgs = resolved.args;
  if (process.platform === "win32" && job) {
    writeFileSync(job.argsFile, JSON.stringify(resolved), { mode: 0o600 });
    command = "powershell.exe";
    launchArgs = [...powershellArgs, "-JobName", job.name, "-Cwd", String(opts.cwd), "-ArgsFile", job.argsFile];
  }
  const child = spawn(command, launchArgs, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: PIP uses a named job; other CLIs use taskkill /T.
    ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
  }) as ChildProcessByStdio<Writable, Readable, Readable>; // callers always pipe all three

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
  const ownership: CliOwnership = { pid: child.pid, platform: process.platform, jobName: job?.name, closed: false, stopped: false, observations: [], observers: new Set() };
  cliOwnership.set(child, ownership);
  recordProcessHandle(child, [command, ...launchArgs].join(" "), opts.env);
  child.once("close", () => {
    ownership.closed = true;
    // Root close keeps ownership of POSIX group members and Windows job
    // members until the corresponding tree confirmation finishes.
    if (ownership.platform !== "win32" || ownership.jobName) void awaitCliTreeStopped(child);
  });
  return child;
}

export function execCli(
  cli: string,
  args: string[],
  opts: ExecFileOptions,
  cb: (err: Error | null, stdout: string, stderr?: string) => void,
): void {
  const resolved = resolveCli(cli, args);
  try {
    assertSafeCliArgv(resolved);
  } catch (error) {
    queueMicrotask(() => cb(error instanceof Error ? error : new Error(String(error)), "", ""));
    return;
  }
  execFile(resolved.command, resolved.args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
    cb(err, stdout, stderr),
  );
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
  killCliTreeWith(child, ownership ? (observation) => {
    if (observation.route === "windows_taskkill" && observation.result === "succeeded") { ownership.taskkillOk = true; ownership.treeStopFailed = false; }
    else if (observation.route === "windows_taskkill" && observation.result === "failed") ownership.treeStopFailed = true;
    try { observer?.(observation); } catch { /* diagnostics never affect stop */ }
  } : observer, REAL_KILL_DEPS);
}

/** Request termination and confirm the owned lifecycle. POSIX requires root
 * close and group disappearance; Windows PIP requires named job confirmation.
 * Other Windows callers retain their root-close and taskkill contract. */
export function awaitCliTreeStopped(child: ChildProcess, termGraceMs = CLI_TERM_GRACE_MS): Promise<boolean> {
  const ownership = cliOwnership.get(child);
  if (!ownership) return Promise.resolve(false);
  return stopOwnedCli(child, ownership, undefined, termGraceMs);
}

/** Like awaitCliTreeStopped, but with no SIGTERM grace: a stop already in
 * flight (the child's own close started one) is escalated at once, so the
 * whole tree is killed now instead of when that stop's grace runs out. */
export function forceCliTreeStopped(child: ChildProcess): Promise<boolean> {
  const ownership = cliOwnership.get(child);
  if (!ownership) return Promise.resolve(false);
  return stopOwnedCli(child, ownership, undefined, 0, true);
}

function stopOwnedCli(child: ChildProcess, owned: CliOwnership, observer?: StopRouteObserver, termGraceMs = CLI_TERM_GRACE_MS, force = false): Promise<boolean> {
  if (observer && !owned.observers.has(observer)) {
    owned.observers.add(observer);
    for (const observation of owned.observations) {
      try { observer(observation); } catch { /* diagnostics never affect stop */ }
    }
  }
  if (owned.stopping) {
    if (force) { try { owned.escalate?.(); } catch { /* confirmation still decides */ } }
    return owned.stopping;
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
        // End the exact supervisor first, including its pre-job startup window.
        // Its last handle closes on exit and terminates every job member.
        if (!owned.closed) {
          const closed = await new Promise<boolean>(resolve => {
            const onClose = () => { clearTimeout(timer); resolve(true); };
            const timer = setTimeout(() => { child.off("close", onClose); resolve(false); }, termGraceMs + CLI_FORCE_WAIT_MS);
            child.once("close", onClose);
            try { child.kill(); } catch { /* confirmation still required */ }
          });
          if (!closed) return false;
        }
        return stopWindowsJob(owned.jobName, termGraceMs + CLI_FORCE_WAIT_MS);
      }
      if (owned.closed && !owned.treeStopFailed) return true;
      if (owned.closed) {
        // The root is gone but an earlier tree-stop failed, so descendants may
        // remain. Only a successful taskkill /T clears that; asking for a closed
        // root's tree must not be answered by "the root already exited".
        return new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          REAL_KILL_DEPS.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
            clearTimeout(timer);
            const gone = !err || taskkillProcessGone(err);
            if (gone) owned.treeStopFailed = false;
            resolve(gone);
          });
        });
      }
      return new Promise<boolean>((resolve) => {
        // Root close alone proves nothing about the tree: taskkill must also
        // have succeeded (or found the root already gone), or it is unconfirmed.
        let rootClosed = false;
        // A taskkill already issued by killCliTree and accepted is not repeated:
        // a second one finds the root gone and would read as a failure.
        let treeKilled: boolean | undefined = owned.taskkillOk ? true : undefined;
        const finish = (value: boolean) => { clearTimeout(timer); child.off("close", closed); resolve(value); };
        const settle = () => {
          if (treeKilled === false) finish(false);
          else if (rootClosed && treeKilled === true) finish(true);
        };
        const closed = () => { rootClosed = true; settle(); };
        const timer = setTimeout(() => finish(false), 5_000);
        child.once("close", closed);
        const killTree = () => killCliTreeWith(child, (observation) => {
          observe(observation);
          if (observation.route === "windows_taskkill" && observation.result === "succeeded") { treeKilled = true; owned.treeStopFailed = false; }
          else if (observation.route === "windows_taskkill" && observation.result === "failed") { treeKilled = false; owned.treeStopFailed = true; }
          else if (observation.route === "already_exited") treeKilled = true;
          settle();
        }, REAL_KILL_DEPS);
        owned.escalate = killTree;
        if (!owned.taskkillOk) killTree();
      });
    }
    const settled = () => {
      if (!owned.closed) return false;
      try { process.kill(-pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    const signal = (value: NodeJS.Signals) => {
      try { process.kill(-pid, value); }
      catch { if (!owned.closed) { try { child.kill(value); } catch { /* retain uncertainty */ } } }
    };
    owned.escalate = () => signal("SIGKILL");
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
  // A confirmation that never resolves (a hung helper or platform hook) must
  // not stay cached as the thread's pending stop forever: past this bound it
  // reads "not stopped" and a later explicit retry makes a fresh attempt.
  let capTimer: NodeJS.Timeout | undefined;
  const attempt = new Promise<boolean>((resolve) => {
    capTimer = setTimeout(() => resolve(false), termGraceMs + CLI_CONFIRM_CAP_MS);
    capTimer.unref?.();
    void raw.then((value) => { clearTimeout(capTimer); resolve(value); });
  });
  owned.stopping = attempt;
  void attempt.then((stopped) => {
    if (owned.stopping === attempt) owned.stopping = undefined;
    if (stopped) owned.stopped = true;
  });
  // A late confirmation, after the bound passed, still counts once it arrives.
  void raw.then((value) => { if (value) owned.stopped = true; });
  return attempt;
}

/** taskkill exit code 128: "the process was not found" (already exited). */
function taskkillProcessGone(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 128;
}

/** killCliTree with injectable OS seams, so route selection and fallback
 * ordering are unit-testable. Mocked routes do not establish Windows runtime
 * behavior. */
export function killCliTreeWith(
  child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  observer: StopRouteObserver | undefined,
  deps: KillCliTreeDeps,
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
    return;
  }

  if (deps.platform === "win32") {
    observe("windows_taskkill", "requested");
    deps.execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
      // Exit 128: the process is already gone, which is what a stop wants.
      // Any other failure (access denied, ...) leaves the tree unconfirmed.
      if (!err || taskkillProcessGone(err)) {
        observe("windows_taskkill", "succeeded");
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
