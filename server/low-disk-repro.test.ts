// SPDX-License-Identifier: AGPL-3.0-or-later
// R0 (boot tolerance, ACCEPTANCE.md row R0): the low-disk start on the real path. A real small filesystem (`--tmpfs /strict`, it-remote IT_DOCKER_EXTRA)
// holds the data dir; a ballast file on it takes the free space down before or during a real server start. Nothing is mocked: statfs, ENOSPC and
// SQLITE_FULL are the kernel's and SQLite's. Each leg asserts the property the fix must give (the start answers health and its data survives);
// at the base this row is the reproduction, at the fix head it is a guard.
// Runs only where /strict is a real mount (the it-remote tmpfs run); elsewhere it is skipped because there is no small filesystem to fill.
// HEADLESS ONLY: throwaway HOME under /strict and a probed port.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statfsSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const STRICT = "/strict";
const MiB = 1024 * 1024;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const onStrictMount = (() => { try { return readFileSync("/proc/mounts", "utf8").split("\n").some(line => line.split(" ")[1] === STRICT); } catch { return false; } })();
const free = () => { const s = statfsSync(STRICT); return s.bavail * s.bsize; };

interface Run { child: ChildProcess; out: () => string; exited: () => number | null | undefined; signal: () => string | null }
function start(home: string, port: number, onFirstOutput?: () => void): Run {
  let stdout = "", stderr = "", code: number | null | undefined, signal: string | null = null, fired = false;
  const child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    windowsHide: true,
    cwd: join(SERVER_DIR, ".."),
    env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), HOME: home, USERPROFILE: home, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const first = () => { if (!fired && onFirstOutput) { fired = true; onFirstOutput(); } };
  child.stdout!.on("data", chunk => { stdout += chunk; first(); });
  child.stderr!.on("data", chunk => { stderr += chunk; first(); });
  child.on("exit", (c, s) => { code = c; signal = s; });
  return { child, out: () => `${stdout}\n----stderr----\n${stderr}`, exited: () => code, signal: () => signal };
}
async function healthOk(port: number, deadlineMs: number, run: Run): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (run.exited() !== undefined) return false;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* not up yet */ }
    await sleep(50);
  }
  return false;
}
/** Grows `file` until free space on /strict is at most `targetFree` bytes (0 = until ENOSPC at 1 MiB and then 4 KiB writes). */
function fillTo(file: string, targetFree: number): void {
  const fd = openSync(file, "a");
  try {
    for (const chunk of [MiB, 4096]) {
      const buf = Buffer.alloc(chunk, 1);
      for (;;) {
        const left = free() - targetFree;
        if (left <= 0 || (targetFree > 0 && chunk < MiB)) break;
        try { writeSync(fd, buf, 0, Math.min(chunk, Math.max(left, 1))); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOSPC") break; throw e; }
      }
    }
  } finally { closeSync(fd); }
}
const errorLines = (out: string) => out.split("\n").filter(line => /error|Error|ENOSPC|SQLITE_FULL|database or disk is full|DATABASE_BUSY|wal-recovery|uncaught|unhandled|^\s+at /.test(line)).slice(0, 30).join("\n");

describe.skipIf(!onStrictMount)("R0 low-disk start on a real small filesystem", () => {
  const runs: Run[] = [];
  afterAll(async () => {
    for (const run of runs) if (run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" });
    rmSync(join(STRICT, "r0"), { recursive: true, force: true });
  });

  /** A home with real data: a first start with ample space, two bots and a message through the API, then a clean stop. */
  async function fixture(leg: string, port: number): Promise<{ home: string; data: string; bots: number }> {
    rmSync(join(STRICT, "r0"), { recursive: true, force: true });
    const home = join(STRICT, "r0", leg); const data = join(home, ".murage"); mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: {} }));
    const first = start(home, port); runs.push(first);
    expect(await healthOk(port, 60_000, first), first.out().slice(-4000)).toBe(true);
    const secret = (await (await fetch(`http://127.0.0.1:${port}/api/desktop-secret`)).json()) as { secret: string };
    const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret.secret };
    for (const name of ["Fixture One", "Fixture Two"]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots`, { method: "POST", headers, body: JSON.stringify({ name }) });
      console.log(`[R0 ${leg}] fixture POST /api/bots ${name} -> ${res.status}`);
    }
    const bots = ((await (await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers })).json()) as { bots: unknown[] }).bots.length;
    await waitForExit(first.child, { signal: "SIGTERM" });
    return { home, data, bots };
  }
  function integrity(data: string): string {
    const db = new DatabaseSync(join(data, "messages.db"), { readOnly: true });
    try { return String((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check); } finally { db.close(); }
  }

  /** One leg: `squeeze` makes space scarce (before the start, or from inside it); then the start must answer health, and after the ballast goes a
   * plain start must answer health with the fixture intact. */
  async function leg(name: string, basePort: number, squeeze: { before?: number; duringTo?: number }) {
    const port = await freePortBlock([0, 1], basePort, 200);
    const { home, data, bots } = await fixture(name, port);
    const ballast = join(STRICT, "r0", `${name}.ballast`);
    if (squeeze.before !== undefined) fillTo(ballast, squeeze.before);
    const freeBefore = free();
    let freeAtFill = -1;
    const t0 = Date.now();
    const run = start(home, port, squeeze.duringTo === undefined ? undefined : () => { fillTo(ballast, squeeze.duringTo!); freeAtFill = free(); });
    runs.push(run);
    const ok = await healthOk(port, 60_000, run);
    const ms = Date.now() - t0;
    const exitAtCheck = run.exited();
    if (!ok && run.exited() === undefined) await waitForExit(run.child, { signal: "SIGTERM" });
    const out = run.out();
    console.log(`[R0 ${name}] free before start=${freeBefore} (${(freeBefore / MiB).toFixed(2)} MiB) free after mid-boot fill=${freeAtFill} health=${ok} after ${ms} ms exit=${exitAtCheck} signal=${run.signal()}`);
    console.log(`[R0 ${name}] error lines:\n${errorLines(out)}`);
    console.log(`[R0 ${name}] output tail:\n${out.slice(-3000)}`);
    if (ok) await waitForExit(run.child, { signal: "SIGTERM" });
    rmSync(ballast, { force: true });
    const check = integrity(data);
    const again = start(home, port); runs.push(again);
    const recovered = await healthOk(port, 60_000, again);
    const secret = recovered ? ((await (await fetch(`http://127.0.0.1:${port}/api/desktop-secret`)).json()) as { secret: string }).secret : "";
    const botsAfter = recovered ? ((await (await fetch(`http://127.0.0.1:${port}/api/bots?messages=0`, { headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": secret } })).json()) as { bots: unknown[] }).bots.length : -1;
    console.log(`[R0 ${name}] after ballast removed: integrity=${check} health=${recovered} bots ${bots} -> ${botsAfter}`);
    if (again.exited() === undefined) await waitForExit(again.child, { signal: "SIGTERM" });
    expect({ startAnsweredHealth: ok, exit: exitAtCheck, integrity: check, recovered, botsAfter }, out.slice(-6000))
      .toEqual({ startAnsweredHealth: true, exit: undefined, integrity: "ok", recovered: true, botsAfter: bots });
    expect(existsSync(data)).toBe(true);
  }

  it("R0a free below the 64 MiB worker floor before the start", { timeout: 300_000 }, () => leg("floor", 19_811, { before: 40 * MiB }));
  it("R0b about 0 bytes free before the start", { timeout: 300_000 }, () => leg("zero", 19_831, { before: 0 }));
  it("R0c the disk fills to 0 during the start", { timeout: 300_000 }, () => leg("fill-zero", 19_851, { duringTo: 0 }));
  it("R0d the disk crosses the 64 MiB floor during the start", { timeout: 300_000 }, () => leg("fill-floor", 19_871, { duringTo: 40 * MiB }));
  it("R0e about 1 MiB free before the start", { timeout: 300_000 }, () => leg("one-mib", 19_891, { before: MiB }));
});
