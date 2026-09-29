// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The proxy half of computer_exec's long commands: what counts as progress,
// when silence stops a command, and how a Stop or a lost box ends one. The
// box-side shell itself runs for real in computer-proxy-exec.test.ts.
import { describe, expect, it } from "vitest";
import {
  commandSilenceMs,
  parseStatus,
  runBoxExec,
  startScript,
  type BoxExecDeps,
  type BoxExecOptions,
  type BoxRun,
} from "./box-exec.ts";

const OPTS: BoxExecOptions = { firstWaitSec: 20, pollSec: 15, leaseSec: 600, outputCapBytes: 1 << 20 };
const status = (state: string, bytes: number, cpu: number, extra = "") =>
  `EXEC_STATE ${state}\nEXEC_BYTES ${bytes}\nEXEC_CPU ${cpu}\n${extra}`;
const done = (rc: number, out: string) =>
  status("done", out.length, 1, `EXEC_RC ${rc}\nEXEC_STDOUT ${Buffer.from(out).toString("base64")}\nEXEC_STDERR \n`);

/** A scripted box: each round trip returns the next answer; the clock moves by
 * the poll window the proxy asked for, as the real box-side wait does. */
function rig(answers: Array<string | Error>, turnSilenceMs = 20 * 60_000, stopAnswer?: string) {
  let now = 0;
  const scripts: string[] = [];
  let beats = 0;
  const deps: BoxExecDeps = {
    run: async (command: string): Promise<BoxRun> => {
      scripts.push(command);
      if (stopAnswer !== undefined && command.includes("kill -TERM")) return { ok: true, exitCode: 0, stdout: stopAnswer, stderr: "" };
      const wait = command.match(/end=\$\(\(SECONDS \+ (\d+)\)\)/);
      if (wait && !command.includes("mkdir -p")) now += Number(wait[1]) * 1000;
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
  return { deps, scripts, beats: () => beats, now: () => now };
}

describe("computer_exec on the box: silence, not a clock", () => {
  it("a quick command answers from the start request alone", async () => {
    const { deps, scripts } = rig([done(0, "hi\n")]);
    const outcome = await runBoxExec("echo hi", deps, OPTS, new AbortController().signal);
    expect(outcome).toEqual({ kind: "done", exitCode: 0, stdout: "hi\n", stderr: "", dropped: false });
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

  it("processor time with no output is progress", async () => {
    const polls = Array.from({ length: 200 }, (_, i) => status("running", 0, 10 + i));
    const { deps } = rig([status("running", 0, 1), ...polls, done(0, "")], 5 * 60_000);
    const outcome = await runBoxExec("crunch", deps, OPTS, new AbortController().signal);
    expect(outcome.kind).toBe("done");
  });

  it("stops after the silence limit with nothing printed and no work, and collects what it printed", async () => {
    const silent = Array.from({ length: 100 }, () => status("running", 7, 3));
    const collected = status("done", 7, 3, `EXEC_RC 143\nEXEC_STDOUT ${Buffer.from("partial\n").toString("base64")}\nEXEC_STDERR \n`);
    const { deps, scripts, now } = rig([status("running", 7, 3), ...silent], 5 * 60_000, collected);
    const outcome = await runBoxExec("hang", deps, OPTS, new AbortController().signal);
    expect(outcome).toMatchObject({ kind: "silent", silentMs: commandSilenceMs(5 * 60_000), stdout: "partial\n" });
    expect(now()).toBeGreaterThanOrEqual(commandSilenceMs(5 * 60_000));
    expect(scripts.at(-1)).toContain('kill -TERM -- "-$S"');
  });

  it("the command's quiet is measured just inside the turn's own limit", () => {
    expect(commandSilenceMs(20 * 60_000)).toBe(19 * 60_000);
    expect(commandSilenceMs(4_000)).toBe(3_000);
    expect(commandSilenceMs(24 * 60 * 60_000)).toBe(24 * 60 * 60_000 - 60_000);
  });

  it("Stop ends the job on the box and reports stopped", async () => {
    const stop = new AbortController();
    const { deps, scripts } = rig([status("running", 1, 1)], 20 * 60_000, "EXEC_STATE stopping");
    const run = deps.run;
    deps.run = async (command, timeoutMs, signal) => {
      // the person presses Stop while the proxy is waiting on the box
      if (command.includes('date +%s > "$J/lease"') && !command.includes("mkdir -p")) {
        stop.abort();
        expect(signal?.aborted).toBe(true);
        throw new Error("aborted");
      }
      return run(command, timeoutMs, signal);
    };
    const outcome = await runBoxExec("sleep 999", deps, OPTS, stop.signal);
    expect(outcome).toEqual({ kind: "stopped" });
    expect(scripts.at(-1)).toContain('kill -TERM -- "-$S"');
  });

  it("rides out a box that stops answering for a while, and gives up once the lease has ended the job", async () => {
    const outage = Array.from({ length: 10 }, () => new Error("fetch failed"));
    const { deps } = rig([status("running", 1, 1), ...outage, status("running", 2, 1), done(0, "fine")]);
    expect((await runBoxExec("x", deps, OPTS, new AbortController().signal)).kind).toBe("done");

    const lost = Array.from({ length: 400 }, () => new Error("fetch failed"));
    const second = rig([status("running", 1, 1), ...lost]);
    const outcome = await runBoxExec("x", second.deps, OPTS, new AbortController().signal);
    expect(outcome.kind).toBe("failed");
    expect(second.now()).toBeGreaterThanOrEqual(OPTS.leaseSec * 1000);
  });

  it("a start the box could not answer is reported, and whatever it began is stopped", async () => {
    const { deps, scripts } = rig([new Error("HTTP 502"), "EXEC_STATE stopping"]);
    const outcome = await runBoxExec("x", deps, OPTS, new AbortController().signal);
    expect(outcome).toEqual({ kind: "failed", detail: "HTTP 502" });
    expect(scripts.at(-1)).toContain("kill -TERM");
  });

  it("the command travels encoded, so quotes and newlines reach the box unchanged", () => {
    const command = `echo 'a "b"' && printf '%s\\n' $HOME\nexit 4`;
    const script = startScript("0123456789abcdef", command, OPTS);
    const encoded = script.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d > "\$J\/cmd"/)![1];
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(command);
    expect(() => startScript("../../etc", command, OPTS)).toThrow("invalid job id");
  });

  it("parses the box's report", () => {
    expect(parseStatus("EXEC_STATE running\nEXEC_BYTES 12\nEXEC_CPU 40\n")).toMatchObject({ state: "running", bytes: 12, cpu: 40 });
    expect(parseStatus("garbage").state).toBe("unknown");
  });
});
