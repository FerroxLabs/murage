// cause12 (1.0.21 hold): the exit census ([io-census], io-child-meter.ts) was
// written with one writeSync on fd 2. In the packaged server fd 2 is a pipe the
// desktop reads, Node makes it non-blocking, and a full pipe answers EAGAIN: the
// census was silently dropped, and a clean exit then read in the owner's log
// exactly like a server killed before its exit path. This file imports nothing
// new, so on 1.0.21 it fails on behaviour, not on a missing export.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CENSUS_FIXTURE = fileURLToPath(new URL("./testing/io-census-backlog.fixture.ts", import.meta.url));

interface Ended { code: number | null; signal: NodeJS.Signals | null; stderr: string }

/** The census fixture fills its stderr pipe while this parent is not reading,
 * says "exiting" on stdout, and exits. The parent catches up 5 ms later: a
 * busy desktop reading behind, which is when the census used to vanish. */
function runCensusFixture(): Promise<Ended> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CENSUS_FIXTURE, "full"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("latin1"); });
    child.stderr.pause();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      if (stdout.includes("exiting")) setTimeout(() => child.stderr.resume(), 5);
    });
    // A fixture that never said "exiting" must still be read to its end, or this would wait for the timeout.
    child.on("exit", () => setTimeout(() => child.stderr.resume(), 20));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

describe("the exit census survives a full stderr pipe", () => {
  it("writes [io-census] when the desktop reads behind at exit (dropped on 1.0.21)", async () => {
    for (let run = 0; run < 3; run += 1) {
      const ended = await runCensusFixture();
      expect(ended.stderr, "the fixture must really have hit a refusing pipe").not.toContain("stderr never refused");
      expect(ended.code).toBe(0);
      expect(ended.stderr).toMatch(/\[io-census\] \{"OWNED_NODE":2,"ENGINE_EXCLUDED":3,"UNMAPPED_NODE":0\}\n/);
    }
  }, 60_000);
});
