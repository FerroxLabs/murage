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
import { createHash } from "node:crypto";
import { resolveCliSpawn, type ResolvedSpawn } from "./env-path.ts";

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
    "agent CLI launch arguments exceed Windows' safe command-line limit; pass large prompts through stdin or a file",
  ) as NodeJS.ErrnoException;
  error.code = "ENAMETOOLONG";
  throw error;
}

export function spawnCli(
  cli: string,
  args: string[],
  opts: SpawnOptions,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const resolved = resolveCli(cli, args);
  assertSafeCliArgv(resolved);
  const child = spawn(resolved.command, resolved.args, {
    ...opts,
    // posix: own process group so kill(-pid) reaps child MCP servers;
    // win32: taskkill /T does the reaping instead (see killCliTree)
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
    return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
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
  killCliTreeWith(child, observer, REAL_KILL_DEPS);
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
      if (!err) {
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
