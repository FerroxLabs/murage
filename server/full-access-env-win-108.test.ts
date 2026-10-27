// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCli } from "./procs.ts";
import { execEnvNow, powerShellEnvProbe, type HandedEnv } from "./engine-env.ts";
import { envGeneration, invalidateEnvCapture, windowsCommandFile } from "./env-path.ts";
import { gitBashPath } from "./tool-discovery.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const launches = vi.hoisted(() => ({ calls: [] as Array<{ file: string; args: string[]; options: any; child: any }>, cleanup: "normal" }));
vi.mock("node:child_process", async original => {
  const real = await original<typeof import("node:child_process")>();
  return { ...real, spawn: (file: string, args: string[], options: any) => {
    const helper = /[\\/]System32[\\/]taskkill.exe$/i.test(file);
    const child = helper && launches.cleanup !== "normal"
      ? real.spawn(process.execPath, ["-e", launches.cleanup === "failed" ? "process.exit(1)" : "setTimeout(()=>{},20000)"], options)
      : real.spawn(file, args, options);
    launches.calls.push({ file, args, options, child }); return child;
  } };
});
const roots: string[] = [];
afterEach(() => {
  for (const { child } of launches.calls.splice(0)) { try { child.kill(); } catch {} }
  launches.cleanup = "normal"; vi.unstubAllEnvs(); invalidateEnvCapture("fixture end");
  for (const dir of roots.splice(0)) removeTempDirSync(dir);
});
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "env108-"))); roots.push(root);
  const cwd = join(root, "work space 日本語"); mkdirSync(cwd);
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  env.MURAGE_ENV_FIXTURE = "ภาษาไทย ☕";
  const hand: HandedEnv = { env, absent: ["MURAGE_108_ABSENT"], capture: "session", pins: new Map(), ownerStartup: {} };
  return { cwd, hand };
};
const run = (file: string, args: string[], cwd: string, timeout = 10_000, maxBuffer = 1024 * 1024) => new Promise<{ error: Error | null; output: string; calls: () => number }>(resolve => {
  let calls = 0;
  execCli(file, args, { cwd, env: process.env, timeout, maxBuffer }, (error, output) => { calls++; resolve({ error, output, calls: () => calls }); });
});
describe.runIf(process.platform === "win32")("108 required real Windows probes", () => {
  it.each(["powershell.exe", "pwsh.exe"])("checks %s with Unicode cwd, closed stdin and hidden window", async shell => {
    const { cwd, hand } = fixture();
    const pinned = shell === "pwsh.exe" ? windowsCommandFile(shell) : shell;
    expect(pinned, "required shell must be installed").toBeTruthy();
    const checked = await execEnvNow(shell, [pinned!, "-NoProfile", "-NonInteractive", "-Command"], hand, cwd);
    expect(checked.unread, "required shell must be installed").toBeUndefined();
    expect(checked.unchecked, "this fixture requires a successful check").toBeUndefined();
    expect(checked.env.MURAGE_ENV_FIXTURE).toBe(hand.env.MURAGE_ENV_FIXTURE);
    const spawn = launches.calls.find(call => call.args.at(-1)?.includes("OpenStandardOutput"))!;
    expect(spawn.options.windowsHide).toBe(true); expect(spawn.child.stdin.writableEnded).toBe(true);
    const delayed = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", `Start-Sleep -Seconds 3; ${powerShellEnvProbe("b".repeat(32))}`], cwd);
    expect(delayed.error).toBeNull(); expect(JSON.parse(delayed.output).nonce).toBe("b".repeat(32));
    const start = Date.now();
    const timed = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 20"], cwd);
    expect(timed.error).not.toBeNull(); expect(Date.now() - start).toBeLessThan(11_750); expect(timed.calls()).toBe(1);
    expect((await execEnvNow(`${shell}-after-timeout`, [pinned!, "-NoProfile", "-Command"], hand, cwd)).unread).toBeUndefined();
  }, 30_000);
  it("checks Git Bash with the Windows execution budget", async () => {
    const { cwd, hand } = fixture();
    const pinned = await gitBashPath(hand.env, envGeneration());
    expect(pinned, "Git Bash is required on this gate").toBeTruthy();
    const checked = await execEnvNow("git-bash", [pinned!, "-c"], hand, cwd);
    expect(checked.unread, "Git Bash is required on this gate").toBeUndefined();
    expect(checked.unchecked, "this fixture requires a successful check").toBeUndefined();
    expect(checked.env.MURAGE_ENV_FIXTURE).toBe(hand.env.MURAGE_ENV_FIXTURE);
  }, 15_000);
  it.each([false, true])("settles once with descendant-held pipes (root exited: %s), then checks again", async exited => {
    const { cwd, hand } = fixture();
    const start = Date.now();
    const result = await run(process.execPath, ["-e", `const child = require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},15000)'],{stdio:['ignore',process.stdout,process.stderr]}); console.log(child.pid); ${exited ? "child.unref(); process.exit(0)" : "setTimeout(()=>{},20000)"}`], cwd);
    expect(result.error).not.toBeNull(); expect(Date.now() - start).toBeLessThan(11_750);
    const descendant = Number(result.output.trim()); if (Number.isInteger(descendant) && descendant > 0) { try { process.kill(descendant); } catch {} }
    const helper = launches.calls.find(call => /taskkill.exe$/i.test(call.file))!;
    expect(helper.file).toMatch(/^[A-Z]:\\.*\\System32\\taskkill.exe$/i);
    expect(helper.args).toEqual(["/PID", String(launches.calls[0]!.child.pid), "/T", "/F"]);
    await new Promise(resolve => setTimeout(resolve, 100)); expect(result.calls()).toBe(1);
    expect((await execEnvNow("retry-real", ["powershell.exe", "-NoProfile", "-Command"], hand, cwd)).unread).toBeUndefined();
  }, 30_000);
  it.each(["normal", "missing", "failed", "overrun"])("bounds overflow cleanup when the helper is %s", async mode => {
    const { cwd } = fixture(); launches.cleanup = mode === "overrun" || mode === "failed" ? mode : "normal";
    if (mode === "missing") vi.stubEnv("SystemRoot", cwd);
    const start = Date.now();
    const result = await run(process.execPath, ["-e", "process.stdout.write('x'.repeat(2*1024*1024)); setTimeout(()=>{},20000)"], cwd, 10_000);
    expect(result.error).not.toBeNull(); expect(Date.now() - start).toBeLessThan(5_000);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(1024 * 1024);
    await new Promise(resolve => setTimeout(resolve, 100)); expect(result.calls()).toBe(1);
    if (mode === "overrun") expect(launches.calls.at(-1)!.child.killed).toBe(true);
  }, 15_000);
});
