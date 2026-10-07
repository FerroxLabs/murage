import { readFileSync } from "node:fs";

/** Init processes known to reap orphaned children. */
const REAPING_INITS: ReadonlySet<string> = new Set([
  "systemd", "init", "tini", "docker-init", "dumb-init", "s6-svscan", "runit", "catatonit", "supervisord", "launchd",
]);

/** Pure decision. Returns the warning line, or undefined when nothing needs saying.
 *  `comm` is the contents of /proc/1/comm, or undefined when it could not be read. */
export function pid1ReaperWarning(platform: string, pid: number, comm: string | undefined): string | undefined {
  if (platform !== "linux") return undefined;
  const name = comm?.trim() || "unknown";
  if (pid !== 1 && REAPING_INITS.has(name)) return undefined;
  return `Murage: PID 1 (${pid === 1 ? "murage server" : name}) does not reap orphaned processes. Engine stops cannot be confirmed and warm engines will not be reused. Run the container with --init or tini.`;
}

export function readPid1Comm(): string | undefined {
  try { return readFileSync("/proc/1/comm", "utf8"); }
  catch { return undefined; }
}

/** Startup log only. Never throws and never changes behaviour. */
export function logPid1ReaperCheck(): void {
  try {
    const warning = pid1ReaperWarning(process.platform, process.pid, process.platform === "linux" ? readPid1Comm() : undefined);
    if (warning) console.warn(warning);
  } catch { /* log only */ }
}
