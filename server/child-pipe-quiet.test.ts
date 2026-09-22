// THE NEGATIVE CONTROL IS THE POINT OF THIS FILE.
//
// A test that spawns a guarded child and sees it live proves nothing on its
// own — it passes just as happily if the write never reached the syscall, if
// the child was already gone, or if EPIPE never happened at all. The first
// version of this fixture made exactly that mistake: it killed the child
// first, got ERR_STREAM_DESTROYED instead of EPIPE, and would have reported
// the owner's outage as fixed while the fatal path was never touched.
//
// So the unguarded run is a real assertion here, not a formality. It must die,
// it must die of EPIPE, and its stack must match the one in the owner's log.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const FIXTURE = fileURLToPath(new URL("./testing/child-pipe-quiet.fixture.mjs", import.meta.url));

async function spawnFixture(mode: "guard" | "bare"): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [FIXTURE, mode], { timeout: 20_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

describe("a child's pipe must not be able to kill the server", () => {
  it("dies without the guard, exactly the way the owner's server died", async () => {
    const bare = await spawnFixture("bare");

    expect(bare.code, "an unguarded EPIPE must end the process").not.toBe(0);
    expect(bare.stdout, "it must not reach the end").not.toContain("SURVIVED");
    // The owner's log, line for line.
    expect(bare.stderr).toContain("write EPIPE");
    expect(bare.stderr, "the fatal path, not a caught error").toContain("Unhandled 'error' event");
    expect(bare.stderr).toContain("Emitted 'error' event on Socket instance");

    // THE THREE DEFENCES THAT READ AS SAFE AND ARE NOT.
    expect(bare.stdout, "`writable` reported true right up to the failing syscall")
      .not.toContain("UNREACHABLE");
    expect(bare.stdout, "try/catch cannot see a failure that lands on a later tick")
      .not.toContain("CAUGHT:");
    // THE SHARP ONE, AND IT CORRECTED THIS FILE'S FIRST DRAFT. The callback
    // is not merely too late — it RUNS, reports EPIPE, and the caller's
    // recovery executes. The process dies anyway, because a write callback is
    // not an `'error'` listener and the stream emitted one with nobody
    // listening. Handling the error and hearing the event are different
    // things, and only the second keeps the server alive.
    expect(bare.stdout, "the callback does run; that is the point").toContain("CALLBACK:EPIPE");
  }, 30_000);

  it("survives with the guard, and the write still reports its failure", async () => {
    const guarded = await spawnFixture("guard");

    expect(guarded.code, `guarded run should exit cleanly; stderr: ${guarded.stderr.slice(0, 300)}`).toBe(0);
    expect(guarded.stdout).toContain("SURVIVED");
    // The guard removes the death, not the diagnosis. With the process still
    // alive to run it, the write callback now fires and says EPIPE — which is
    // what the calling code wanted all along.
    expect(guarded.stdout, "the callback the real code relies on must now run").toContain("CALLBACK:EPIPE");
  }, 30_000);
});
