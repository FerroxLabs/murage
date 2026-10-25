// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U24 design R2: the Windows job launcher, run here as a real child under Node on any platform (its logic has nothing
// Windows-specific; the job itself is proven on the gate box). It starts nothing until the frame, starts the CLI with the
// frame's environment and inherited stdio once it arrives, leaves the bytes after the frame to the CLI, mirrors the CLI's
// exit code, and reports a CLI that could not start on fd 3.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launcherEnvironment, launcherFrame } from "./procs.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const LAUNCHER = fileURLToPath(new URL("./job-launcher.ts", import.meta.url));
// The CLI stand-in: prints its marker env var and everything it reads from stdin, then exits 7.
const CLI_SCRIPT = `let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { input += c; }); process.stdin.on("end", () => { process.stdout.write(process.env.MARK + ":" + input); process.exit(7); });`;

const children: ChildProcess[] = [];
let base: string;
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  if (base) removeTempDirSync(base);
});

interface Run { child: ChildProcess; stdout: () => string; report: () => string; exit: Promise<number | null> }
function launch(command: string, args: string[]): Run {
  base = mkdtempSync(join(tmpdir(), "job-launcher-"));
  const child = spawn(process.execPath, [LAUNCHER, "--", command, ...args], {
    cwd: base,
    // what procs.ts gives the launcher on Windows; PATH added only so this host's node can load its type stripper
    env: { ...launcherEnvironment(process.env), PATH: process.env.PATH ?? "" },
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  children.push(child);
  let out = "", rep = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr!.on("data", () => {});
  (child.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => { rep += chunk.toString(); });
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, stdout: () => out, report: () => rep, exit };
}
const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("job launcher", () => {
  it("starts nothing before the frame; after it, the CLI runs with the frame's environment, inherits stdio, gets the bytes after the frame, and its exit code is mirrored", async () => {
    const run = launch(process.execPath, ["-e", CLI_SCRIPT]);
    await settle(400);
    expect(run.stdout()).toBe("");
    expect(run.report()).toBe("");
    expect(run.child.exitCode).toBeNull();
    const frame = launcherFrame({ MARK: "from-frame", PATH: process.env.PATH ?? "" }, base);
    run.child.stdin!.write(frame);
    run.child.stdin!.write("prompt bytes after the frame");
    run.child.stdin!.end();
    await expect(run.exit).resolves.toBe(7);
    await settle(50);
    expect(run.stdout()).toBe("from-frame:prompt bytes after the frame");
    expect(JSON.parse(run.report().trim())).toEqual({ pid: expect.any(Number) });
  });

  it("the launcher's own environment never reaches the CLI as such: the CLI sees only the frame's", async () => {
    const run = launch(process.execPath, ["-e", `process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE) + "|" + String(process.env.MARK)); process.exit(0);`]);
    run.child.stdin!.write(launcherFrame({ MARK: "only-this", PATH: process.env.PATH ?? "" }, base));
    run.child.stdin!.end();
    await expect(run.exit).resolves.toBe(0);
    await settle(50);
    expect(run.stdout()).toBe("undefined|only-this");
  });

  it("a CLI that cannot start is reported on fd 3 as Node reports it, and the launcher exits 127", async () => {
    const run = launch(join(base ?? tmpdir(), "no-such-cli"), []);
    run.child.stdin!.write(launcherFrame({ PATH: process.env.PATH ?? "" }, undefined));
    await expect(run.exit).resolves.toBe(127);
    await settle(50);
    const report = JSON.parse(run.report().trim()) as { error: { code: string; syscall: string; path: string } };
    expect(report.error.code).toBe("ENOENT");
    expect(report.error.syscall).toBe("spawn");
    expect(report.error.path).toContain("no-such-cli");
  });

  // T2e: the launcher's fixed environment is what keeps turn-controlled runtime options from running code before the gate.
  it("a NODE_OPTIONS preload in the turn's environment runs nothing in the launcher (control: the same option handed directly does run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-launcher-preload-"));
    try {
      const marker = join(dir, "ran.txt");
      const preload = join(dir, "preload.cjs");
      writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
      const turnEnv = { ...process.env, NODE_OPTIONS: `--require ${preload}` };
      // control: Node honours the option when it is in the launcher's own environment
      const control = spawn(process.execPath, [LAUNCHER, "--", process.execPath, "-e", "0"], { cwd: dir, env: turnEnv, stdio: ["pipe", "ignore", "ignore", "pipe"] });
      children.push(control);
      control.stdin!.end();
      await new Promise<void>((resolve) => control.once("exit", () => resolve()));
      expect(existsSync(marker)).toBe(true);
      // the real launch: the turn's environment only reaches the CLI through the frame
      const { unlinkSync } = await import("node:fs"); unlinkSync(marker);
      const real = spawn(process.execPath, [LAUNCHER, "--", process.execPath, "-e", "0"], { cwd: dir, env: { ...launcherEnvironment(turnEnv), PATH: process.env.PATH ?? "" }, stdio: ["pipe", "ignore", "ignore", "pipe"] });
      children.push(real);
      real.stdin!.end();
      await new Promise<void>((resolve) => real.once("exit", () => resolve()));
      expect(existsSync(marker)).toBe(false);
    } finally { removeTempDirSync(dir); }
  });

  it("stdin closed before any frame: the launcher exits 0 having started nothing", async () => {
    const run = launch(process.execPath, ["-e", CLI_SCRIPT]);
    run.child.stdin!.end();
    await expect(run.exit).resolves.toBe(0);
    expect(run.stdout()).toBe("");
    expect(run.report()).toBe("");
  });
});
