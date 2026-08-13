// Killing a CLI *and* everything it started, on every platform.
//
// The drivers spawn their CLI detached so it leads its own process group,
// then kill -pid to reap the whole group — the CLI's MCP servers and
// helper processes included. Process groups are a POSIX concept:
// process.kill(-pid) throws EINVAL on Windows, and the fallback that
// catches it kills the CLI alone, orphaning every server it started.
// Windows tracks the parent/child tree instead, which is what
// `taskkill /T` walks.
import { execFile, type ChildProcess } from "node:child_process";

/** Terminate a spawned CLI together with its descendants. Best-effort and
 * synchronous to call: nothing here throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], (err) => {
      if (!err) return;
      try {
        child.kill(); // taskkill unavailable or already gone — at least the CLI
      } catch {}
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}
