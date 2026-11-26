// SPDX-License-Identifier: AGPL-3.0-or-later
// cause12 runtime witness for the close path. closeRequested(via) is what the signal handlers and the app-close message both call; it must
// begin the app close (the "Murage closed" notes), THEN start the graceful shutdown, whose cleanup jobs all finish before finalCleanup seals
// the outside-marks store. The static order of the source is pinned in email/external-marks-b3.test.ts; this file starts a REAL server
// process (throwaway HOME, probed port), asks it to close the way the desktop does, and reads the step lines it writes on stderr
// (`event=server-shutdown step=...`) and the seal record it leaves in outside-state.jsonl.
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { childEnv } from "./testing/murage-env.mjs";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const STEPS = ["app-close-begun", "graceful-started", "cleanup-done", "sealed"];
const sealed = (home: string) => {
  const file = join(home, ".murage", "outside-state.jsonl");
  return existsSync(file) && readFileSync(file, "utf8").includes('"k":"seal"');
};

describe("a real server asked to close", () => {
  let child: ChildProcess | undefined, home = "";
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGTERM" });
    child = undefined;
    if (home) await removeTempDir(home);
    home = "";
  });

  async function close(ask: (running: ChildProcess) => void): Promise<{ code: number | null; steps: string[]; stderr: string; sealedBefore: boolean; sealedAfter: boolean }> {
    const port = await freePortBlock([0, 1], 19_699, 200);
    home = mkdtempSync(join(tmpdir(), "murage-close-order-"));
    const data = join(home, ".murage");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    let stdout = "", stderr = "";
    const running = child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true,
      cwd: join(SERVER_DIR, ".."),
      env: childEnv({ HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1) }),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    running.stdout!.on("data", chunk => (stdout += chunk));
    running.stderr!.on("data", chunk => (stderr += chunk));
    const ended = new Promise<number | null>(resolve => running.on("close", code => resolve(code)));
    const deadline = Date.now() + 45_000;
    while (!stdout.includes("murage server on") && Date.now() < deadline && running.exitCode === null) await sleep(10);
    expect(stdout, stderr).toContain("murage server on");
    const sealedBefore = sealed(home);
    ask(running);
    const code = await Promise.race([ended, sleep(30_000).then(() => "timeout" as const)]);
    expect(code, stderr).not.toBe("timeout");
    const steps = [...stderr.matchAll(/^event=server-shutdown step=(\S+)$/gm)].map(match => match[1]!);
    return { code: code as number | null, steps, stderr, sealedBefore, sealedAfter: sealed(home) };
  }

  const inOrder = (result: Awaited<ReturnType<typeof close>>, via: string) => {
    expect(result.sealedBefore, "nothing seals a running server").toBe(false);
    expect(result.code, result.stderr).toBe(0);
    // the close request is noted first, then the four steps, each exactly once and in order
    expect(result.stderr).toContain(`event=server-child-close via=${via}`);
    expect(result.steps, result.stderr).toEqual(STEPS);
    expect(result.stderr.indexOf(`via=${via}`)).toBeLessThan(result.stderr.indexOf("step=app-close-begun"));
    expect(result.sealedAfter, "finalCleanup left its seal record in the outside store").toBe(true);
  };

  it.skipIf(process.platform === "win32")("SIGTERM runs beginAppClose, then gracefulShutdown, and finalCleanup seals last", { timeout: 90_000 }, async () => {
    inOrder(await close(running => running.kill("SIGTERM")), "SIGTERM");
  });

  it("the app-close message runs the same steps in the same order (any platform)", { timeout: 90_000 }, async () => {
    inOrder(await close(running => running.send({ type: "murage:close" })), "message");
  });
});
