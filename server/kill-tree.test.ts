// The drivers spawn their CLI detached so that stopping a turn also stops
// whatever the CLI started (its MCP servers). That guarantee is the whole
// contract of killCliTree, so it is what gets tested: a grandchild must not
// survive the kill on either platform.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { awaitCliTreeStopped, killCliTree, spawnCli } from "./procs.ts";
import { ChildTeardown } from "./drivers/child-teardown.ts";

const IDLE = "setInterval(() => {}, 1000)";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("killCliTree", () => {
  it("owns stdin pipe errors before a CLI can be force-stopped", async () => {
    const child = spawnCli(process.execPath, ["-e", IDLE], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      killCliTree(child);
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  });

  it("reaps a grandchild, not just the process it was handed", async () => {
    // a stand-in CLI: spawns one helper, reports its pid, then idles
    const parent = spawnCli(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(IDLE)}], { stdio: "ignore" });` +
          `console.log(c.pid); ${IDLE}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let grandchild = 0;
    try {
      grandchild = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("helper did not report its pid")), 5_000);
        parent.stdout!.once("data", (chunk) => {
          clearTimeout(timer);
          resolve(Number(String(chunk).trim()));
        });
      });
      expect(grandchild).toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      killCliTree(parent);

      // Read the parent's death off the child object: a POSIX parent stays a
      // live pid as a zombie until Node reaps it. The grandchild has no Child
      // object here, so wait until its pid disappears as the observable proof.
      const exited = () => parent.exitCode !== null || parent.signalCode !== null;
      const deadline = Date.now() + 10_000;
      while ((alive(grandchild) || !exited()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(alive(grandchild)).toBe(false);
      expect(exited()).toBe(true);
    } finally {
      killCliTree(parent);
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }, 20_000);

  it.skipIf(process.platform === "win32").each([false, true])("retains owned group after root close (stubborn root: %s)", async (stubbornRoot) => {
    const helperSource = "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)";
    const parent = spawnCli(process.execPath, ["-e", `
      ${stubbornRoot ? "process.on('SIGTERM',()=>{});" : ""}
      const helper=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helperSource)}],{stdio:['ignore','pipe','ignore']});
      helper.stdout.once('data',pid=>{console.log(String(pid).trim()); ${stubbornRoot ? "" : "process.exit(0);"}});
      setInterval(()=>{},1000);
    `], { stdio: ["pipe", "pipe", "pipe"] });
    const canary = spawnCli(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
    const rootClose = once(parent, "close");
    const teardown = new ChildTeardown(parent);
    let helper = 0;
    try {
      const [[data]] = await Promise.all([once(parent.stdout, "data"), once(canary.stdout, "data")]);
      helper = Number(String(data).trim());
      expect(helper).toBeGreaterThan(1);
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(helper)], { encoding: "utf8" }).trim());
      expect(pgid).toBe(parent.pid);
      expect(alive(canary.pid!)).toBe(true);
      killCliTree(parent);
      teardown.markStopRequested();
      const stopped = awaitCliTreeStopped(parent);
      expect(awaitCliTreeStopped(parent)).toBe(stopped);
      if (!stubbornRoot) {
        await rootClose;
        expect(alive(helper)).toBe(true);
        await expect(teardown.wait({ closeMs: 40, maxMs: 40 })).resolves.toEqual({ closeConfirmed: false, reason: "timeout" });
      }
      await expect(stopped).resolves.toBe(true);
      await expect(teardown.wait({ closeMs: 500, maxMs: 500 })).resolves.toEqual({ closeConfirmed: true });
      expect(alive(helper)).toBe(false);
      expect(alive(parent.pid!)).toBe(false);
      expect(alive(canary.pid!)).toBe(true);
      const signals = vi.spyOn(process, "kill");
      await expect(awaitCliTreeStopped(parent)).resolves.toBe(true);
      expect(signals).not.toHaveBeenCalled();
      signals.mockRestore();
      process.stdout.write(`${JSON.stringify({ case: "owned-group", platform: process.platform, root: parent.pid, helper, pgid, canary: canary.pid, rootGone: true, helperGone: true, canaryAlive: true })}\n`);
    } finally {
      vi.restoreAllMocks();
      await Promise.all([awaitCliTreeStopped(parent), awaitCliTreeStopped(canary)]);
      if (helper && alive(helper)) process.kill(helper, "SIGKILL");
      expect(alive(canary.pid!)).toBe(false);
      process.stdout.write(`${JSON.stringify({ case: "owned-group-cleanup", root: parent.pid, helper, canary: canary.pid, rootGone: !alive(parent.pid!), helperGone: !helper || !alive(helper), canaryGone: !alive(canary.pid!) })}\n`);
    }
  }, 12_000);

  it.skipIf(process.platform === "win32")("refuses group proof for an unowned child", async () => {
    const child = spawn(process.execPath, ["-e", "console.log(process.pid);setInterval(()=>{},1000)"], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await once(child.stdout!, "data");
      const signals = vi.spyOn(process, "kill");
      await expect(awaitCliTreeStopped(child)).resolves.toBe(false);
      expect(signals).not.toHaveBeenCalled();
      signals.mockRestore();
    } finally {
      vi.restoreAllMocks();
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
    }
  });

  it.skipIf(process.platform === "win32")("retains a denied stop and permits an explicit retry", async () => {
    const child = spawnCli(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await once(child.stdout, "data");
      const nativeKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid! && signal !== 0) throw Object.assign(new Error("fixture denied"), { code: "EPERM" });
        return nativeKill(pid, signal);
      });
      vi.spyOn(child, "kill").mockReturnValue(false);
      await expect(awaitCliTreeStopped(child)).resolves.toBe(false);
      expect(alive(child.pid!)).toBe(true);
      vi.restoreAllMocks();
      await expect(awaitCliTreeStopped(child)).resolves.toBe(true);
      expect(alive(child.pid!)).toBe(false);
    } finally {
      vi.restoreAllMocks();
      await awaitCliTreeStopped(child);
    }
  }, 12_000);
});
