// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { PIP_JOB_SUPERVISOR, powershellArgs, stopWindowsJob } from "./pip-job.ts";
import { killAndVerify, reapAttemptProcess } from "./pip-reaper.ts";

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
  expect(runner).toHaveBeenCalledWith("powershell.exe", [...powershellArgs, "-JobName", name, "-Stop", "-WaitMs", "400"], 10400);
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("the supervisor refuses assignment before reading launch data or starting a CLI", () => {
  const source = readFileSync(PIP_JOB_SUPERVISOR, "utf8");
  const assign = source.indexOf('if (-not [PipJob]::AssignProcessToJobObject');
  expect(assign).toBeGreaterThan(0);
  expect(source.slice(assign, source.indexOf("$launch =", assign))).toContain("exit 220");
  expect(source.indexOf("[PipJob]::Launch(")).toBeGreaterThan(assign);
  expect(source).toContain("KILL_ON_JOB_CLOSE = 0x2000");
  expect(source).toContain("$info.ActiveProcesses -eq 0");
  expect(source).toContain("$clock.ElapsedMilliseconds -ge $WaitMs");
  expect(source).toContain("GetLastWin32Error() -eq 2");
  expect(source).not.toContain("BREAKAWAY_OK");
});
it("the server bundle copies the supervisor into the desktop server resource", () => {
  expect(readFileSync(new URL("../../scripts/bundle-server.mjs", import.meta.url), "utf8")).toContain('copyFileSync(join(server, "memory", "pip-job-supervisor.ps1"), join(root, "dist-server", "memory", "pip-job-supervisor.ps1"))');
  expect(readFileSync(new URL("../../electron-builder.yml", import.meta.url), "utf8")).toContain("from: dist-server\n    to: server");
});

it.runIf(process.platform === "win32").each([true, false])("real supervisor owns a detached grandchild (CLI exits=%s)", async exits => {
  const root = mkdtempSync(join(tmpdir(), "pip-job-native-"));
  const jobName = `Local\\murage-pip-${randomUUID()}`;
  const argsFile = join(root, "args.json"), pidFile = join(root, "grandchild.pid");
  const script = join(root, "cli.cjs");
  writeFileSync(script, `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); fs.writeFileSync(process.argv[2], String(child.pid)); child.unref(); ${exits ? '' : 'setInterval(() => {}, 1000);'}`);
  writeFileSync(argsFile, JSON.stringify({ command: process.execPath, args: [script, pidFile] }));
  const supervisor = spawn("powershell.exe", [...powershellArgs, "-JobName", jobName, "-Cwd", root, "-ArgsFile", argsFile], { stdio: "pipe", windowsHide: true });
  const closed = new Promise<number | null>((resolve, reject) => { supervisor.once("close", resolve); supervisor.once("error", reject); });
  supervisor.stdin.end();
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(existsSync(pidFile)).toBe(true);
    if (exits) expect(await closed).toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(await stopWindowsJob(jobName)).toBe(true);
    await closed;
    expect(() => process.kill(pid, 0)).toThrow();
    const { stdout } = await promisify(execFile)("powershell.exe", [...powershellArgs, "-JobName", jobName, "-Stop", "-WaitMs", "0"]);
    expect(JSON.parse(stdout)).toEqual({ state: "absent" });
  } finally {
    supervisor.kill();
    await closed.catch(() => {});
    await stopWindowsJob(jobName);
    rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
