// Stopping a spawned harness, and removing the directory it was writing to.
//
// Both halves are races, and CI has lost both. A signal is a request, not an
// event: `kill` returns as soon as the signal is delivered, not when the
// process is gone, and a process that is still alive is still holding — and
// still creating — files under its home. Deleting that directory in the same
// tick as the signal works on a laptop every time and fails on a loaded
// runner, which is the combination that reads as a phantom rather than as a
// bug. It surfaced as EACCES on a temp directory, in a test that had nothing
// to do with whatever was actually slow that day.
//
// So: wait for `close`, with a floor under it, and then retry the delete for
// a moment in case the filesystem is still catching up. A temp directory that
// will not go is never worth failing a green suite over.
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";

/** SIGTERM, then SIGKILL, then remove `home` — each step waiting for the last
 * to actually take effect. Never throws. */
export async function stopAndClean(child: ChildProcess | undefined, home: string): Promise<void> {
  child?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    // and a floor, so a process that somehow survives SIGKILL cannot hang the
    // suite instead
    setTimeout(resolve, 10_000).unref?.();
  });

  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return rmSync(home, { recursive: true, force: true });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  console.warn(
    `test cleanup could not remove ${home}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
