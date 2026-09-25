import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, stopMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), stopMock: vi.fn() }));

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  spawn: spawnMock,
}));
// The whole-tree stop is the shared procs.ts helper; these tests observe that
// the runner hands its child to it, and the last one runs the real helper.
vi.mock("./procs.ts", async () => ({
  ...(await vi.importActual<typeof import("./procs.ts")>("./procs.ts")),
  awaitCliTreeStopped: stopMock,
}));

import { defaultRunner } from "./vps-computer.ts";

type FakeChild = EventEmitter & {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  spawnMock.mockReturnValue(child);
  return child;
}

describe("default VPS command runner", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    stopMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects output and resolves after the child closes", async () => {
    const child = fakeChild();
    const result = defaultRunner(["info"], { input: "request" });

    child.stdout.write("out");
    child.stderr.write("err");
    child.emit("close", 0, null);

    await expect(result).resolves.toEqual({ stdout: "out", stderr: "err" });
    expect(spawnMock).toHaveBeenCalledWith("docker", ["info"], expect.objectContaining({ shell: false }));
  });

  it("turns stdin EPIPE into a rejected command and stops the whole command tree", async () => {
    const child = fakeChild();
    const result = defaultRunner(["build", "-"], { input: "Dockerfile" });

    child.stdin.emit("error", new Error("write EPIPE"));

    await expect(result).rejects.toThrow("Docker-over-SSH stdin failed: write EPIPE");
    expect(stopMock).toHaveBeenCalledWith(child, 5_000);
    expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true);
    child.emit("close", 1, null);
  });

  // Upstream #1772: a timeout stops docker AND the ssh it launched (its
  // process group), and the command does not settle until that is done, so
  // the caller keeps the VPS lifecycle lock while the remote exec tears down.
  it("waits for the whole-tree stop after a timeout, even when docker closes first", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    let finishCleanup!: (stopped: boolean) => void;
    stopMock.mockReturnValue(new Promise<boolean>((resolve) => { finishCleanup = resolve; }));
    let settled = false;
    const result = defaultRunner(["info"], { timeoutMs: 100 });
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(result).rejects.toThrow("Docker-over-SSH command timed out");

    await vi.advanceTimersByTimeAsync(100);
    expect(stopMock).toHaveBeenCalledWith(child, 5_000);
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);
    finishCleanup(true);
    await rejection;
    expect(child.stdout.destroyed && child.stderr.destroyed).toBe(true);
  });

  it.skipIf(process.platform === "win32").each(["timeout", "stdin"])("reaps an ssh-like grandchild that ignores SIGTERM after %s, leaving an unrelated process alone", async (failure) => {
    const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { awaitCliTreeStopped: realStop } = await vi.importActual<typeof import("./procs.ts")>("./procs.ts");
    stopMock.mockImplementation(realStop);
    const idle = "setInterval(() => {}, 1000)";
    const helperCode = `process.on('SIGTERM', () => {}); console.log(process.pid); ${idle}`;
    const dockerCode = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helperCode)}], { stdio: ['ignore', 'inherit', 'inherit'] }); ${idle}`;
    let docker!: ChildProcess;
    spawnMock.mockImplementation((_command, _args, options) => {
      docker = realSpawn(process.execPath, ["-e", dockerCode], options);
      return docker;
    });
    const unrelated = realSpawn(process.execPath, ["-e", idle], { detached: true, stdio: "ignore" });
    const unrelatedClosed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
    let helper = 0;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const result = defaultRunner(["info"], { timeoutMs: failure === "timeout" ? 1_000 : 20_000 });
    const rejected = expect(result).rejects.toThrow(failure === "timeout" ? "command timed out" : "stdin failed");
    try {
      helper = Number(await new Promise<string>((resolve) => docker.stdout!.once("data", (chunk) => resolve(String(chunk).trim()))));
      expect(alive(helper)).toBe(true);
      if (failure === "stdin") docker.stdin!.emit("error", new Error("write EPIPE"));
      await rejected;
      expect(alive(helper)).toBe(false);
      expect(docker.exitCode !== null || docker.signalCode !== null).toBe(true);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      if (helper && alive(helper)) process.kill(helper, "SIGKILL");
      if (docker && docker.exitCode === null && docker.signalCode === null) docker.kill("SIGKILL");
      if (unrelated.pid && alive(unrelated.pid)) unrelated.kill("SIGKILL");
      await unrelatedClosed;
    }
  }, 20_000);
});
