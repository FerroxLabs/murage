// SPDX-License-Identifier: AGPL-3.0-or-later
// The rc13 real-data boot, reproduced: right after the first /api/health answer the memory worker (the first after-listen step) started the
// eager identity index builds, which take the writer hold, and every after-listen step and boot recovery that wrote with no budget sat in the
// handle's 1 s wait on the serving thread behind that hold (`[sqlite] busy op=BEGIN IMMEDIATE waited=1068 holder=writer-hold budget=none`,
// a 1249 ms stall, first ping 1292 ms). Here another connection holds the write lock from the moment the port opens until well after the steps
// have run (it stands in for a long index build or a slow disk), so every write of the start meets it.
//
// Pass: nothing of the start waits more than the background budget on the serving thread (no `budget=none` line, no busy wait or slow write
// over 150 ms, no stall named after SQLite), the serving thread wrote nothing before the first health answer, and once the lock is free the
// start finishes its work (the recoveries come back after the lock).
//
// HEADLESS ONLY: a throwaway temp HOME and a probed port, clear of 8799.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const LOCK_HELD_MS = 4_000;

describe.skipIf(process.platform === "win32")("a start whose writes meet a held write lock", () => {
  let child: ChildProcess | undefined, home = "", other: DatabaseSync | null = null;
  afterAll(async () => {
    try { other?.exec("ROLLBACK"); } catch { /* released */ }
    try { other?.close(); } catch { /* closed */ }
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("never waits on the serving thread past the background budget, and writes nothing before the first health answer", async () => {
    const port = await freePortBlock([0, 1], 19_499, 200);
    const base = `http://127.0.0.1:${port}`;
    home = mkdtempSync(join(tmpdir(), "murage-boot-hold-"));
    const data = join(home, ".murage");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    let stdout = "", stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_TURN_TRACE: "1", MURAGE_STALL_MS: "250" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => (stdout += chunk));
    child.stderr!.on("data", chunk => (stderr += chunk));
    const deadline = Date.now() + 45_000;
    // the port is open (the listen callback's line): take the write lock BEFORE the first health request, so the after-listen steps (they start at
    // the first health answer) and everything after them meet it
    while (!stdout.includes("murage server on") && Date.now() < deadline) await sleep(5);
    expect(stdout, stderr).toContain("murage server on");
    other = new DatabaseSync(join(data, "messages.db"));
    other.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const lockedAt = Date.now();
    for (;;) {
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never answered. stderr:\n${stderr}`);
      await sleep(10);
    }
    // pings while the lock is held: the serving thread answers each at once
    const pings: number[] = [];
    while (Date.now() - lockedAt < LOCK_HELD_MS) {
      const started = performance.now();
      await fetch(`${base}/api/health`);
      pings.push(performance.now() - started);
      await sleep(100);
    }
    other.exec("ROLLBACK");
    while (!stdout.includes("phase=startup.deferred.done") && Date.now() < deadline) await sleep(20);
    // the recoveries that met the lock come back after it (a growing pause from 250 ms)
    await sleep(3_000);
    const out = `${stdout}\n${stderr}`;
    expect(out).toMatch(/\[startup\] writes before first health=0\b/);
    expect(out).toContain("phase=startup.deferred.done");
    expect(out.split("\n").filter(line => line.includes("budget=none")), out).toEqual([]);
    const waits = [...out.matchAll(/\[sqlite\] busy op=(.*?) waited=(\d+)/g)].filter(match => Number(match[2]) > 150).map(match => match[0]);
    expect(waits, out).toEqual([]);
    const slowWrites = [...out.matchAll(/\[sqlite\] slow op=(?:exec: )?(BEGIN|INSERT|UPDATE|DELETE|REPLACE|COMMIT)[^\n]*? ms=(\d+)/g)].filter(match => Number(match[2]) > 150).map(match => match[0]);
    expect(slowWrites, out).toEqual([]);
    expect(out.split("\n").filter(line => /\[loop\] stall .*sqlite:/.test(line)), out).toEqual([]);
    expect(Math.max(...pings), pings.map(Math.round).join(",")).toBeLessThan(250);
    expect(out).not.toMatch(/a boot recovery met a held lock/);
  }, 90_000);
});
