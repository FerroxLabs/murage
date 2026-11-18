import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { launcherFrame, spawnCli } from "../procs.ts";
import { cloudTurnLaunch } from "../cloud-home/turn-process.ts";
import * as cloudTurnProcess from "../cloud-home/turn-process.ts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

beforeEach(() => {
  vi.spyOn(cloudTurnProcess, "cloudTurnLaunch").mockImplementation(() => { throw new Error("fixture engine launcher reached"); });
  vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, stdio: [stdin, stdout, stderr],
      pid: undefined, exitCode: null, signalCode: null, kill: () => true });
    queueMicrotask(() => { child.emit("exit", 0, null); child.emit("close", 0, null); stdin.destroy(); stdout.destroy(); stderr.destroy(); });
    return child as never;
  });
  syncBuiltinESMExports();
});
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

it("T-S1-WINDOWS-IPC: an explicit proxy channel survives the job-launch frame", () => {
  const env = { MURAGE_RELEASE_INSTANCE: "one", MURAGE_RELEASE_TOKEN: "fixture" };
  expect(() => launcherFrame(env, fixtureBotFolder())).toThrow("MEMORY_CONTEXT_REVOKED");
  let frame: Buffer | undefined;
  expect(() => { frame = launcherFrame(env, fixtureBotFolder(), true); }).not.toThrow(); // red: base refuses every consuming launcher frame
  const body = JSON.parse(frame!.subarray(frame!.indexOf(10) + 1).toString());
  expect(body).toMatchObject({ proxyIpc: true, env });
  // Actual launcher/IPC delivery is exercised by T-WIN-LAUNCH.
});

it("T-S1-CLOUD-SERVER-SPAWN: admitted children bypass only the engine launcher", () => {
  vi.stubEnv("MURAGE_CLOUD_ROLE", "home");
  const options = { cwd: fixtureBotFolder(), env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
  expect(() => spawnCli(process.execPath, ["-e", ""], options, undefined, { serverTool: "mcp" })).not.toThrow();
  expect(childProcess.spawn).toHaveBeenCalledOnce();
  expect(cloudTurnLaunch).not.toHaveBeenCalled();
  expect(() => spawnCli(process.execPath, ["-e", ""], options)).toThrow("fixture engine launcher reached");
  expect(() => spawnCli(process.execPath, ["-e", ""], {
    ...options, env: { ...options.env, MURAGE_CLOUD_TURN_ENGINE: "codex" },
  }, undefined, { serverTool: "mcp" })).toThrow("fixture engine launcher reached");
  expect(childProcess.spawn).toHaveBeenCalledOnce();
});
