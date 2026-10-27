import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCli } from "./procs.ts";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("execCli combined output budget", () => {
  it.each(["stdout only", "stderr overflow", "stderr after stdout overflow"])("tracks discarded stderr: %s", async (mode) => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const result = new Promise<{ error: Error | null; stderr: string | undefined }>((resolve) => {
      execCli(process.execPath, [], { maxBuffer: 32 }, (error, _stdout, stderr) => resolve({ error, stderr }));
    });
    child.stderr.emit("data", Buffer.from("ordinary diagnostic"));
    if (mode === "stderr overflow") child.stderr.emit("data", Buffer.alloc(40, 120));
    else child.stdout.emit("data", Buffer.alloc(40, 120));
    if (mode === "stderr after stdout overflow") child.stderr.emit("data", Buffer.from("later"));
    child.emit("close", 1, null);
    const { error, stderr } = await result;
    expect(stderr).toBe("ordinary diagnostic");
    // 1.0.8: an overflow settles at once and destroys both pipes, so stderr is
    // cut at the stop whichever stream spent the budget; nothing after it is read
    expect(error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderrTruncated: true });
  });
});
