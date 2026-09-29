// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The proxy half of computer_exec's long commands: what counts as progress,
// when silence stops a command, and how a Stop or a lost box ends one. The
// box-side shell runs for real at the end of this file (Linux, as the box
// is) and through the whole proxy in computer-proxy-exec.test.ts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupScript,
  commandSilenceMs,
  cpuProgressTicks,
  parseStatus,
  pollScript,
  runBoxExec,
  startScript,
  stopScript,
  type BoxExecDeps,
  type BoxExecOptions,
  type BoxRun,
} from "./box-exec.ts";

const OPTS: BoxExecOptions = { firstWaitSec: 20, pollSec: 15, leaseSec: 600, outputCapBytes: 1 << 20 };
const status = (state: string, bytes: number, cpu: number, extra = "") =>
  `EXEC_STATE ${state}\nEXEC_BYTES ${bytes}\nEXEC_CPU ${cpu}\nEXEC_HZ 100\n${extra}`;
const done = (rc: number, out: string) =>
  status("done", out.length, 1, `EXEC_RC ${rc}\nEXEC_STDOUT ${Buffer.from(out).toString("base64")}\nEXEC_STDERR \n`);
const isStart = (s: string) => s.includes('setsid bash "$J/sup"');
const isPoll = (s: string) => s.includes("then lease; fi");
const isStop = (s: string) => s.includes("\nsig TERM");

/** A scripted box: each start/poll returns the next answer; the clock moves
 * by the poll window the proxy asked for, as the real box-side wait does. */
function rig(answers: Array<string | Error>, turnSilenceMs = 20 * 60_000, stopAnswer = "EXEC_STATE stopping") {
  let now = 0;
  const scripts: string[] = [];
  let beats = 0;
  const deps: BoxExecDeps = {
    run: async (command: string): Promise<BoxRun> => {
      scripts.push(command);
      if (isStop(command)) return { ok: true, exitCode: 0, stdout: stopAnswer, stderr: "" };
      const wait = command.match(/end=\$\(\(SECONDS \+ (\d+)\)\)/);
      if (wait && isPoll(command)) now += Number(wait[1]) * 1000;
      const next = answers.shift();
      if (next === undefined) throw new Error("no more answers");
      if (next instanceof Error) throw next;
      return { ok: true, exitCode: 0, stdout: next, stderr: "" };
    },
    turnSilenceMs: () => turnSilenceMs,
    progress: () => {
      beats += 1;
    },
    newId: () => "0123456789abcdef0123",
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return { deps, scripts, beats: () => beats, now: () => now, advance: (ms: number) => (now += ms) };
}

describe("computer_exec on the box: silence, not a clock", () => {
  it("a quick command answers from the start request alone", async () => {
    const { deps, scripts } = rig([done(0, "hi\n")]);
    const outcome = await runBoxExec("echo hi", deps, OPTS, new AbortController().signal);
    expect(outcome).toEqual({ kind: "done", exitCode: 0, stdout: "hi\n", stderr: "", dropped: false, abandoned: false });
    expect(scripts).toHaveLength(1);
  });

  it("an hour of steady output runs to the end, and each change is reported as activity", async () => {
    const polls = Array.from({ length: 240 }, (_, i) => status("running", (i + 1) * 100, 5));
    const { deps, beats, now } = rig([status("running", 10, 5), ...polls, done(0, "ok")]);
    const outcome = await runBoxExec("make", deps, OPTS, new AbortController().signal);
    expect(outcome.kind).toBe("done");
    expect(now()).toBeGreaterThanOrEqual(60 * 60_000);
    expect(beats()).toBeGreaterThanOrEqual(240);
  });

  it("real processor work with no output is progress", async () => {
    // 15 s windows at 100 Hz: 50 ticks is a third of a core
    const polls = Array.from({ length: 200 }, (_, i) => status("running", 0, 10 + 50 * (i + 1)));
    const { deps } = rig([status("running", 0, 10), ...polls, done(0, "")], 5 * 60_000);
    expect((await runBoxExec("crunch", deps, OPTS, new AbortController().signal)).kind).toBe("done");
  });

  it("storage reads and writes with no output are progress (a quiet download)", async () => {
    const polls = Array.from({ length: 60 }, (_, i) => `${status("running", 0, 10)}EXEC_IO ${(i + 1) * 1_000_000}\n`);
    const { deps } = rig([status("running", 0, 10), ...polls, done(0, "")], 5 * 60_000);
    expect((await runBoxExec("curl -so f url", deps, OPTS, new AbortController().signal)).kind).toBe("done");
  });

  it("an idle server's timer ticks are not work: it is stopped as silent", async () => {
    const polls = Array.from({ length: 100 }, (_, i) => status("running", 5, 10 + i));
    const { deps, scripts } = rig([status("running", 5, 10), ...polls], 5 * 60_000);
    const outcome = await runBoxExec("npm run dev", deps, OPTS, new AbortController().signal);
    expect(outcome.kind).toBe("silent");
    expect(isStop(scripts.at(-1)!)).toBe(true);
    expect(cpuProgressTicks(15_000, 100)).toBe(15);
  });

  it("stops after the silence limit with nothing printed and no work, and collects what it printed", async () => {
    const silent = Array.from({ length: 100 }, () => status("running", 7, 3));
    const collected = status("done", 7, 3, `EXEC_RC 143\nEXEC_STDOUT ${Buffer.from("partial\n").toString("base64")}\nEXEC_STDERR \n`);
    const { deps, scripts, now } = rig([status("running", 7, 3), ...silent], 5 * 60_000, collected);
    const outcome = await runBoxExec("hang", deps, OPTS, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: "silent", silentMs: commandSilenceMs(5 * 60_000), stdout: "partial\n" });
    expect(now()).toBeGreaterThanOrEqual(commandSilenceMs(5 * 60_000));
    expect(isStop(scripts.at(-1)!)).toBe(true);
    expect(scripts.at(-1)).toContain("st; collect");
  });

  it("the silence is counted from before the start request, as the turn's is", async () => {
    const { deps, advance } = rig([], 4 * 60_000);
    const run = deps.run;
    let started = 0;
    deps.run = async (command, timeoutMs, signal, wake) => {
      if (isStart(command)) {
        started += 1;
        advance(4 * 60_000); // the start took the whole limit
        return { ok: true, exitCode: 0, stdout: status("running", 0, 0), stderr: "" };
      }
      return run(command, timeoutMs, signal, wake);
    };
    const outcome = await runBoxExec("slow start", deps, OPTS, new AbortController().signal);
    expect(started).toBe(1);
    expect(outcome.kind).toBe("silent");
  });

  it("a command that finished just as it went quiet is reported as finished", async () => {
    const silent = Array.from({ length: 100 }, () => status("running", 7, 3));
    const finished = `EXEC_ALREADY_DONE yes\n${done(0, "all good\n")}`;
    const { deps } = rig([status("running", 7, 3), ...silent], 5 * 60_000, finished);
    expect(await runBoxExec("x", deps, OPTS, new AbortController().signal)).toMatchObject({ kind: "done", exitCode: 0, stdout: "all good\n" });
  });

  it("the command's quiet is measured just inside the turn's own limit", () => {
    expect(commandSilenceMs(20 * 60_000)).toBe(19 * 60_000);
    expect(commandSilenceMs(4_000)).toBe(3_000);
    expect(commandSilenceMs(24 * 60 * 60_000)).toBe(24 * 60 * 60_000 - 60_000);
  });

  it("Stop while waiting on the box ends the job there and reports stopped", async () => {
    const stop = new AbortController();
    const { deps, scripts } = rig([status("running", 1, 1)]);
    const run = deps.run;
    deps.run = async (command, timeoutMs, signal, wake) => {
      if (isPoll(command)) {
        stop.abort();
        expect(signal?.aborted).toBe(true);
        throw new Error("aborted");
      }
      return run(command, timeoutMs, signal, wake);
    };
    expect(await runBoxExec("sleep 999", deps, OPTS, stop.signal)).toEqual({ kind: "stopped" });
    expect(isStop(scripts.at(-1)!)).toBe(true);
  });

  it("Stop during the start request withdraws it and still stops whatever it began", async () => {
    const stop = new AbortController();
    const { deps, scripts } = rig([]);
    let startSignal: AbortSignal | undefined;
    const run = deps.run;
    deps.run = async (command, timeoutMs, signal, wake) => {
      if (isStart(command)) {
        startSignal = signal;
        expect(wake).toBe(true);
        stop.abort();
        throw new Error("aborted");
      }
      expect(wake).toBe(false);
      return run(command, timeoutMs, signal, wake);
    };
    expect(await runBoxExec("x", deps, OPTS, stop.signal)).toEqual({ kind: "stopped" });
    expect(startSignal).toBe(stop.signal);
    expect(isStop(scripts.at(-1)!)).toBe(true);
  });

  it("rides out a box that stops answering for a while, and gives up (stopping the job) once its lease has ended it", async () => {
    const outage = Array.from({ length: 10 }, () => new Error("fetch failed"));
    const { deps } = rig([status("running", 1, 1), ...outage, status("running", 2, 1), done(0, "fine")]);
    expect((await runBoxExec("x", deps, OPTS, new AbortController().signal)).kind).toBe("done");

    const lost = Array.from({ length: 400 }, () => new Error("fetch failed"));
    const second = rig([status("running", 1, 1), ...lost]);
    const outcome = await runBoxExec("x", second.deps, OPTS, new AbortController().signal);
    expect(outcome.kind).toBe("failed");
    expect(second.now()).toBeGreaterThanOrEqual(OPTS.leaseSec * 1000);
    expect(isStop(second.scripts.at(-1)!)).toBe(true);
  });

  it("a start the box could not answer is reported, and whatever it began is stopped", async () => {
    const { deps, scripts } = rig([new Error("HTTP 502")]);
    const outcome = await runBoxExec("x", deps, OPTS, new AbortController().signal);
    expect(outcome).toEqual({ kind: "failed", detail: "HTTP 502" });
    expect(isStop(scripts.at(-1)!)).toBe(true);
  });

  it("the command travels encoded, so quotes and newlines reach the box unchanged", () => {
    const command = `echo 'a "b"' && printf '%s\\n' $HOME\nexit 4`;
    const script = startScript("0123456789abcdef", command, OPTS);
    const encoded = script.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > "\$J\/cmd"/)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(command);
    expect(() => startScript("../../etc", command, OPTS)).toThrow("invalid job id");
  });

  it("parses the box's report", () => {
    expect(parseStatus("EXEC_STATE running\nEXEC_BYTES 12\nEXEC_CPU 40\nEXEC_HZ 250\n")).toMatchObject({ state: "running", bytes: 12, cpu: 40, hz: 250 });
    expect(parseStatus("garbage").state).toBe("unknown");
  });
});

// The box-side shell itself, run with the real bash.
describe.skipIf(process.platform !== "linux")("computer_exec's box-side records (real shell)", () => {
  const home = mkdtempSync(join(tmpdir(), "box-exec-"));
  const env = { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const sh = (script: string) => parseStatus(spawnSync("bash", ["-c", script], { env, encoding: "utf8", timeout: 30_000 }).stdout);
  // a zombie waiting for the container's init to reap it is dead
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "")[0] !== "Z";
    } catch {
      return false;
    }
  };
  const opts: BoxExecOptions = { firstWaitSec: 1, pollSec: 1, leaseSec: 600, outputCapBytes: 1 << 20 };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("a poll whose answer was lost can be asked again; cleanup removes the record", () => {
    const id = "aa00000000000001";
    expect(sh(startScript(id, "echo once; exit 5", opts))).toMatchObject({ state: "done", exitCode: 5, stdout: "once\n" });
    expect(sh(pollScript(id, 1))).toMatchObject({ state: "done", exitCode: 5, stdout: "once\n" });
    sh(cleanupScript(id));
    expect(sh(pollScript(id, 1)).state).toBe("missing");
  });

  it("a stop that arrives before its start leaves a tombstone, and the start never runs the command", () => {
    const id = "aa00000000000002";
    const marker = join(home, "should-not-exist");
    expect(sh(stopScript(id, false)).state).toBe("missing");
    expect(sh(startScript(id, `touch ${marker}`, opts)).state).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  });

  it("the command keeps the box's own umask", () => {
    const expected = spawnSync("bash", ["-c", "umask"], { env, encoding: "utf8" }).stdout.trim();
    expect(sh(startScript("aa00000000000003", "umask", opts)).stdout.trim()).toBe(expected);
  });

  it("a record from before a reboot is never signalled, and reads as gone", () => {
    const id = "aa00000000000004";
    const pidFile = join(home, "reboot.pid");
    expect(sh(startScript(id, `echo $$ > ${pidFile}; sleep 60`, opts)).state).toBe("running");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const boot = join(home, ".cache", "murage-exec", id, "boot");
    const real = readFileSync(boot, "utf8");
    writeFileSync(boot, "another-boot\n");
    expect(sh(pollScript(id, 1)).state).toBe("missing");
    sh(stopScript(id, false));
    expect(alive(pid)).toBe(true);
    // put the real boot back and stop it properly
    writeFileSync(boot, real);
    expect(sh(stopScript(id, true)).state).toBe("done");
    expect(alive(pid)).toBe(false);
  });

  it("Stop reaches a process that moved to a session of its own", () => {
    const id = "aa00000000000005";
    const pidFile = join(home, "escaped.pid");
    expect(sh(startScript(id, `setsid sleep 60 & echo $! > ${pidFile}; wait`, opts)).state).toBe("running");
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    sh(stopScript(id, true));
    expect(alive(pid)).toBe(false);
  });
});
