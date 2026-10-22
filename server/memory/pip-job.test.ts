// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assignPipJob, closePipJob, createPipJob, PIP_JOB_REFUSAL, PipJobRefusedError, stopWindowsJob } from "./pip-job.ts";
import { killAndVerify, reapAttemptProcess } from "./pip-reaper.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const name = "Local\\murage-pip-fixture";
it.each([
  ["not found", { ok: true, out: '{"state":"absent"}' }, true],
  ["members reach zero", { ok: true, out: '{"state":"present","activeProcesses":0}' }, true],
  ["members remain after the grace", { ok: true, out: '{"state":"present","activeProcesses":2}' }, false],
  ["helper fails", { ok: false, out: '{"state":"absent"}' }, false],
  ["helper output is unreadable", { ok: true, out: "" }, false],
] as const)("Windows job confirmation: %s", async (_label, result, expected) => {
  const runner = vi.fn(async () => result);
  expect(await killAndVerify(0, { platform: "win32", jobName: name, jobRunner: runner, termGraceMs: 300, forceWaitMs: 100 })).toBe(expected);
  expect(runner).toHaveBeenCalledWith(name, 400);
});
it("a thrown helper error retains uncertainty", async () => {
  expect(await stopWindowsJob(name, 0, async () => { throw new Error("denied"); })).toBe(false);
});
it("restart confirms an absent job without requiring a root observation", async () => {
  const observe = vi.fn(async () => ({ state: "unknown" as const }));
  expect(await reapAttemptProcess({ intent: { runId: "r", family: "lived", attempt: 1, tempRoot: "fixture", bootEpoch: { pid: 2, startedAt: 1 }, intentAt: 1, deadlineAt: 2, jobName: name }, child: { pid: 12345, startTime: "old", registeredAt: 1 } }, { platform: "win32", observe, jobRunner: async () => ({ ok: true, out: '{"state":"absent"}' }) })).toEqual({ confirmed: true, how: "child" });
  expect(observe).not.toHaveBeenCalled();
});
it("restart revokes pending launch data before opening a not-yet-created job", async () => {
  const root = mkdtempSync(join(tmpdir(), "pip-job-restart-"));
  const argsFile = join(root, "job-args.json");
  writeFileSync(argsFile, '{"command":"fixture.exe","args":[]}');
  try {
    const jobRunner = vi.fn(async () => {
      expect(existsSync(argsFile)).toBe(false);
      return { ok: true, out: '{"state":"absent"}' };
    });
    expect(await reapAttemptProcess({ intent: { runId: "r", family: "lived", attempt: 1, tempRoot: root, bootEpoch: { pid: 2, startedAt: 1 }, intentAt: 1, deadlineAt: 2, jobName: name } }, { platform: "win32", jobRunner })).toEqual({ confirmed: true, how: "child" });
    expect(jobRunner).toHaveBeenCalledOnce();
  } finally { removeTempDirSync(root); }
});
it("the job lives in the addon: no PowerShell script ships, and a bad name never reaches it", async () => {
  expect(existsSync(new URL("./pip-job-supervisor.ps1", import.meta.url))).toBe(false);
  expect(readFileSync(new URL("../../scripts/bundle-server.mjs", import.meta.url), "utf8")).not.toContain("pip-job-supervisor");
  expect(readFileSync(new URL("./pip-job.ts", import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join("\n")).not.toMatch(/powershell/i);
  expect(() => createPipJob("Global\\murage-pip-x")).toThrow(PipJobRefusedError);
  expect(() => createPipJob("Local\\murage-pip-a;b")).toThrow(PipJobRefusedError);
  const runner = vi.fn(async () => ({ ok: true, out: '{"state":"absent"}' }));
  expect(await stopWindowsJob("Local\\other-job", 0, runner)).toBe(false);
  expect(runner).not.toHaveBeenCalled();
  expect(PIP_JOB_REFUSAL).toBe(220);
});
it.runIf(process.platform !== "win32")("without the Windows addon a PIP job is refused, never run unconfined", () => {
  expect(() => createPipJob("Local\\murage-pip-fixture")).toThrow(PipJobRefusedError);
  expect(assignPipJob({}, 1234)).toBe(false);
  expect(() => closePipJob({})).not.toThrow();
});

it.runIf(process.platform === "win32").each([true, false])("real job owns a detached grandchild (CLI exits=%s)", async exits => {
  const root = mkdtempSync(join(tmpdir(), "pip-job-native-"));
  const jobName = `Local\\murage-pip-${randomUUID()}`;
  const pidFile = join(root, "grandchild.pid");
  const script = join(root, "cli.cjs");
  writeFileSync(script, `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); fs.writeFileSync(process.argv[2], String(child.pid)); child.unref(); ${exits ? '' : 'setInterval(() => {}, 1000);'}`);
  const job = createPipJob(jobName);
  const cli = spawn(process.execPath, [script, pidFile], { stdio: "pipe", windowsHide: true });
  expect(assignPipJob(job, cli.pid!)).toBe(true);
  const closed = new Promise<number | null>((resolve, reject) => { cli.once("close", resolve); cli.once("error", reject); });
  cli.stdin.end();
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(existsSync(pidFile)).toBe(true);
    if (exits) expect(await closed).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await stopWindowsJob(jobName)).toBe(true);
    await closed;
    expect(() => process.kill(pid, 0)).toThrow();
    closePipJob(job);
    expect(await stopWindowsJob(jobName, 0)).toBe(true); // absent
  } finally {
    cli.kill();
    await closed.catch(() => {});
    closePipJob(job);
    removeTempDirSync(root);
  }
}, 45_000);
