// SPDX-License-Identifier: AGPL-3.0-or-later
// O1 m2 S1a F3 reap rule (designs/1021-m2-w0 r5 F3, r3 D1.6): a custody file left by an earlier HOSTED boot is reaped by a
// production COORDINATOR boot, in any mode, before the mode decision. Owner: O1 m2 S1a builder lane (fix/1022-o1m2), both
// sides (producer server/host/host-launch.ts, consumer the boot reap in server/index.ts).
//
// This file imports no lane module on purpose: the identical witness runs on the pre-lane base (dev/1022 b45d0259e6),
// where a production boot ignores the file and the recorded executor survives, so it fails at the behavioural assertion
// (Astra r9 High 1). The behavioural assertions come before the diagnostic [fuigo-mode] line, which the base never prints.
// The same rule is also witnessed in hosted-s1a.test.ts with the module/spawn trace (no host launch); this copy exists
// so the pre-lane base can run it.
// Ordering (Opus/Astra r10 Medium): the reap finishes before the boot goes on, so the executor is already dead (a
// zombie of this test process, or gone) the moment the server first answers health. A reap deferred past listen passes
// a wait-for-exit check but not this synchronous sample.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { freePortBlock } from "../testing/ports.ts";
import { childEnv } from "../testing/murage-env.mjs";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(SERVER_DIR, "..");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Synchronous liveness sample: exited, reaped, or a zombie all count as dead; running or sleeping does not. */
const deadNow = (child: ChildProcess): boolean => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try { return readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ")[1]!.split(/\s+/)[0] === "Z"; } catch { return true; }
};

describe.skipIf(process.platform !== "linux")("F3 reap on a production boot (real server child)", () => {
  const children: ChildProcess[] = [];
  const homes: string[] = [];
  afterAll(async () => {
    for (const child of children) await waitForExit(child, { signal: "SIGTERM" });
    for (const home of homes) await removeTempDir(home);
  });

  it("F3: a production boot reaps a leftover custody file by identity, then removes it", async () => {
    const leftover = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    children.push(leftover);
    await new Promise(resolve => leftover.once("spawn", resolve));
    const start = readFileSync(`/proc/${leftover.pid}/stat`, "utf8").split(") ")[1]!.split(/\s+/)[19]!;

    const home = mkdtempSync(join(tmpdir(), "murage-f3-reap-"));
    homes.push(home);
    const dataDir = join(home, ".murage");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {} }));
    const custody = join(dataDir, "hosted-custody.jsonl");
    writeFileSync(custody, `${JSON.stringify({ boot_id: "fixture-boot", kboot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), inc: 1, role: "engine", pid: leftover.pid, start, pgid: leftover.pid })}\n`);

    // A production boot: no preload, and no test-runner markers in the child's environment.
    const port = await freePortBlock([0, 1], 19_620, 200);
    let stdout = "", stderr = "";
    const server = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: ROOT,
      env: childEnv({ HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), VITEST: "", NODE_TEST_CONTEXT: "" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(server);
    server.stdout!.on("data", chunk => (stdout += chunk));
    server.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 45_000;
    let deadAtListen: boolean | undefined;
    for (;;) {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.ok && ((await health.json()) as { pid?: number }).pid === server.pid) { deadAtListen = deadNow(leftover); break; }
      } catch { /* not up yet */ }
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`server never came up. stderr:\n${stderr.slice(-4000)}`);
      await sleep(25);
    }

    expect(deadAtListen, "the reap finished before the server answered its first health check").toBe(true);
    // Observe only: waitForExit would send its own SIGKILL and make this assertion tautological.
    const gone = leftover.exitCode !== null || leftover.signalCode !== null
      || await Promise.race([new Promise<boolean>(resolve => leftover.once("exit", () => resolve(true))), sleep(5_000).then(() => false)]);
    expect({ gone, signal: leftover.signalCode }, "the recorded executor was SIGKILLed by the boot reap").toEqual({ gone: true, signal: "SIGKILL" });
    expect(readdirSync(dataDir).filter(file => /custody/i.test(file)), "a resolved custody file is removed").toEqual([]);
    expect(stdout.split("\n").find(line => line.startsWith("[fuigo-mode] ")), stderr.slice(-2000))
      .toBe("[fuigo-mode] mode=COORDINATOR reason=hosted_unqualified driver=FuigoAgentDriver hello=none forwarderInits=0 custodyUnresolved=0");
  }, 90_000);
});
