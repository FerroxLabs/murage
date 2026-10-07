// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runHeadlessCli } from "./headless-text-only.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import { createTempRoot, type TransportIntent } from "../memory/pip-transport.ts";
import { registerChild } from "../memory/pip-reaper.ts";
import { PIP_JOB_REFUSAL } from "../memory/pip-job.ts";
vi.mock("../procs.ts", () => ({ spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn(async () => true) }));
vi.mock("../memory/pip-reaper.ts", () => ({ registerChild: vi.fn(async () => ({ pid: 12345, startTime: "fixture", registeredAt: 1 })) }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pip-win-host-"));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.clearAllMocks();
});
afterEach(() => { Object.defineProperty(process, "platform", platform); rmSync(base, { recursive: true, force: true }); });
it.each([true, false])("job name is durable before spawn and assignment failure refuses without a CLI (registered=%s)", async registered => {
  const temp = createTempRoot(base, "run", 1, "fixture");
  let persisted: TransportIntent | undefined;
  vi.mocked(registerChild).mockResolvedValueOnce(registered ? { pid: 12345, startTime: "fixture", registeredAt: 1 } : null);
  vi.mocked(spawnCli).mockImplementation((_cli, _args, _options, job) => {
    expect(persisted?.jobName).toBe(job?.name);
    expect(job?.name).toMatch(/^Local\\murage-pip-/);
    expect(job?.argsFile).toBe(join(temp.root, "job-args.json"));
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => child.emit("close", PIP_JOB_REFUSAL));
    return child as never;
  });
  const result = await runHeadlessCli({ cli: "fixture.exe", args: ["sensitive prompt"], cwd: temp.work, env: {}, temp, tmpBase: base, outputSchema: { type: "object" }, signal: new AbortController().signal, engine: "fuigo", context: { runId: "run", family: "lived", attempt: 1 }, hooks: { onIntent: async intent => { await Promise.resolve(); persisted = JSON.parse(JSON.stringify(intent)); } } });
  expect(result.verdict).toMatchObject({ state: "refused", detail: "job-assignment-failed" });
  expect(result.isolation.exited).toBe(true);
  expect(spawnCli).toHaveBeenCalledOnce();
  expect(awaitCliTreeStopped).toHaveBeenCalled();
});
it("a failed durable intent write prevents the supervisor spawn", async () => {
  const temp = createTempRoot(base, "run", 1, "fixture");
  await expect(runHeadlessCli({ cli: "fixture.exe", args: [], cwd: temp.work, env: {}, temp, tmpBase: base, outputSchema: { type: "object" }, signal: new AbortController().signal, engine: "fuigo", context: { runId: "run", family: "lived", attempt: 1 }, hooks: { onIntent: async () => { throw new Error("write failed"); } } })).rejects.toThrow("write failed");
  expect(spawnCli).not.toHaveBeenCalled();
});

it.each(["fuigo", "grok", "claude"] as const)("Windows %s admits the requested debug log alongside job args", async engine => {
  const temp = createTempRoot(base, "run", 1, "fixture");
  vi.mocked(spawnCli).mockImplementation((_cli, _args, _options, job) => {
    writeFileSync(temp.debugFile, "text-only completed");
    writeFileSync(job!.argsFile, "{}");
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", structured_output: { ok: true } }) + "\n");
      child.emit("close", 0);
    });
    return child as never;
  });
  const result = await runHeadlessCli({ cli: "fixture.exe", args: [], cwd: temp.work, env: {}, temp, tmpBase: base, outputSchema: { type: "object" }, signal: new AbortController().signal, engine, context: { runId: "run", family: "lived", attempt: 1 } });
  expect(result.verdict).toMatchObject({ state: "validated", structured: { ok: true } });
});
