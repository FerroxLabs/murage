// removeTempDir is the teardown behind every suite that spawns a harness
// against a throwaway home. Its admission check (assertSafeToWipe) treats a
// lease whose owner still answers process.kill(pid, 0) as live, and a
// just-killed child can still answer that for a beat (a zombie not yet
// reaped). Judging once before the retry loop turned that beat into a
// one-off SafeWipeRefused on a green suite; the check now runs on every
// attempt, so the wipe waits for the owner to go the way it already waits
// for its files to close (FOLLOW7, SAFEWIPE1 verifier).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";
import { registerTestHandle, settleInternals, settleTestHandlesSync } from "../test-handle-registry.ts";
import { backoffDelays, cleanupInternals, removeTempDir, removeTempDirSync, waitForExit } from "./cleanup.ts";
import { SafeWipeRefused, safeWipe, safeWipeSync } from "./safe-wipe.mjs";

let scratch: string;
const holders: ChildProcess[] = [];

const spawnHolder = () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  holders.push(child);
  return child;
};
const writeLease = (dataDir: string, pid: number) => {
  const { leasePath } = dataDirLeasePaths(dataDir);
  writeFileSync(leasePath, `${JSON.stringify({ version: 1, pid, host: hostname(), token: "0".repeat(64), createdAt: Date.now() })}\n`, { mode: 0o600 });
  return leasePath;
};
const fixture = (name: string) => {
  const dir = join(scratch, name, "data"); mkdirSync(dir, { recursive: true });
  const marker = join(dir, "messages.db"); writeFileSync(marker, "marker");
  return { dir, marker };
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// .native: removeTempDir reports the canonical spelling, which on Windows
// expands an 8.3 short temp name (RUNNER~1) that the JS realpath keeps.
beforeAll(() => { scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-cleanup-"))); });
afterAll(async () => {
  for (const child of holders) await waitForExit(child, { signal: "SIGTERM" });
  safeWipeSync(scratch);
});

describe("removeTempDir", () => {
  it("re-judges the lease on every attempt, so an owner that dies mid-teardown no longer refuses the wipe", async () => {
    const holder = spawnHolder();
    const { dir, marker } = fixture("dies-between-attempts");
    writeLease(dir, holder.pid!);
    const removal = removeTempDir(dir);
    // While the owner is alive every attempt refuses and nothing is deleted.
    await sleep(350);
    expect(existsSync(marker)).toBe(true);
    await waitForExit(holder, { signal: "SIGKILL" });
    // The owner is gone: a later attempt admits the wipe and the promise
    // resolves instead of having thrown on the first judgement.
    await removal;
    expect(existsSync(dir)).toBe(false);
  });

  it("still refuses, without deleting, when the owner outlives every attempt", async () => {
    const holder = spawnHolder();
    const { dir, marker } = fixture("outlives");
    writeLease(dir, holder.pid!);
    await expect(removeTempDir(dir, { budgetMs: 1_500 })).rejects.toBeInstanceOf(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
  }, 10_000);

  it("removes an admitted directory and tolerates a missing one", async () => {
    const { dir } = fixture("plain");
    await removeTempDir(dir);
    expect(existsSync(dir)).toBe(false);
    await removeTempDir(dir);
  });
});

describe("safeWipe", () => {
  it("re-judges the lease on every attempt the way removeTempDir does", async () => {
    const holder = spawnHolder();
    const { dir, marker } = fixture("async-dies-between-attempts");
    writeLease(dir, holder.pid!);
    const removal = safeWipe(dir);
    await sleep(350);
    expect(existsSync(marker)).toBe(true);
    await waitForExit(holder, { signal: "SIGKILL" });
    expect(await removal).toBe(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("still refuses, without deleting, when the owner outlives every attempt", async () => {
    const holder = spawnHolder();
    const { dir, marker } = fixture("async-outlives");
    writeLease(dir, holder.pid!);
    await expect(safeWipe(dir, { maxRetries: 3 })).rejects.toBeInstanceOf(SafeWipeRefused);
    expect(existsSync(marker)).toBe(true);
  });
});

describe("removeTempDir outside the OS temp directory", () => {
  it("admits a folder inside the working directory, and still refuses one outside both", async () => {
    const inside = join(process.cwd(), `.cleanup-test-${process.pid}`);
    mkdirSync(join(inside, "data"), { recursive: true }); writeFileSync(join(inside, "data", "x"), "x");
    await removeTempDir(inside);
    expect(existsSync(inside)).toBe(false);
    await expect(removeTempDir(join(process.cwd(), ".."), { budgetMs: 50 })).rejects.toBeInstanceOf(SafeWipeRefused);
    await expect(removeTempDir(process.cwd(), { budgetMs: 50 })).rejects.toBeInstanceOf(SafeWipeRefused);
  });
});

describe("backoffDelays", () => {
  it("doubles from 50 ms, caps at 1 s and spends exactly the budget", () => {
    const delays = backoffDelays();
    expect(delays.slice(0, 7)).toEqual([50, 100, 200, 400, 800, 1000, 1000]);
    expect(delays.reduce((a, b) => a + b, 0)).toBe(15_000);
    expect(Math.max(...delays)).toBe(1_000);
  });
  it("honours a smaller budget and first delay", () => {
    expect(backoffDelays({ budgetMs: 500, firstDelayMs: 100, maxDelayMs: 300 })).toEqual([100, 200, 200]);
  });
});

describe("removeTempDir retries", () => {
  const real = { ...cleanupInternals };
  afterEach(() => { Object.assign(cleanupInternals, real); });
  const failing = (times: number, code: string) => {
    let calls = 0;
    cleanupInternals.remove = (path: string) => {
      if (calls++ < times) throw Object.assign(new Error(`${code}: busy ${path}`), { code });
      real.remove(path);
    };
    return () => calls;
  };

  it("retries an EPERM with growing waits, then removes the directory", async () => {
    const { dir } = fixture("eperm-then-ok");
    const calls = failing(4, "EPERM");
    const waits: number[] = [];
    cleanupInternals.sleep = async (ms: number) => { waits.push(ms); };
    await removeTempDir(dir);
    expect(calls()).toBe(5);
    expect(waits).toEqual([50, 100, 200, 400]);
    expect(existsSync(dir)).toBe(false);
  });

  it("warns, and does not throw, when the directory never goes", async () => {
    const { dir } = fixture("enotempty-forever");
    failing(Infinity, "ENOTEMPTY");
    const waits: number[] = [];
    cleanupInternals.sleep = async (ms: number) => { waits.push(ms); };
    const warn = vi.fn(); cleanupInternals.warn = warn;
    await removeTempDir(dir);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(15_000);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain("ENOTEMPTY");
    expect(existsSync(dir)).toBe(true);
  });

  it("throws instead when strict", async () => {
    const { dir } = fixture("strict");
    failing(Infinity, "EPERM");
    cleanupInternals.sleep = async () => {};
    await expect(removeTempDir(dir, { strict: true })).rejects.toThrow(/EPERM/);
  });

  it("never swallows a refusal, even when the removal would have worked", async () => {
    cleanupInternals.sleep = async () => {};
    await expect(removeTempDir(join(scratch, "..", ".."), { budgetMs: 100 })).rejects.toBeInstanceOf(SafeWipeRefused);
  });

  it("the sync variant retries with a blocking backoff and throws when it never goes", () => {
    const { dir } = fixture("sync-retry");
    const calls = failing(3, "EBUSY");
    const waits: number[] = [];
    cleanupInternals.sleepSync = (ms: number) => { waits.push(ms); };
    removeTempDirSync(dir);
    expect(calls()).toBe(4);
    expect(waits).toEqual([50, 100, 200]);
    expect(existsSync(dir)).toBe(false);

    const stuck = fixture("sync-stuck");
    failing(Infinity, "EBUSY");
    expect(() => removeTempDirSync(stuck.dir)).toThrow(/EBUSY/);
    expect(() => removeTempDirSync(stuck.dir, { strict: false, budgetMs: 100 })).not.toThrow();
  });

  it("the sync variant still refuses a path that is not a temp directory", () => {
    expect(() => removeTempDirSync(join(scratch, "..", ".."), { budgetMs: 100 })).toThrow(SafeWipeRefused);
  });
});

describe("removeTempDir settles open data handles first", () => {
  it("runs flush, close, then stop (awaited) for a closer registered from another module copy, only for handles under the directory", async () => {
    const { dir } = fixture("settle");
    const other = fixture("settle-elsewhere");
    const order: string[] = [];
    let stopFinished = false;
    const off = [
      registerTestHandle("stop", async () => { order.push("stop"); await sleep(30); stopFinished = true; }),
      registerTestHandle("close", d => { order.push(`close:${d === dir}`); }),
      registerTestHandle("flush", () => { order.push("flush"); }),
    ];
    try { await removeTempDir(dir); } finally { off.forEach(f => f()); }
    expect(stopFinished).toBe(true);
    expect(order.slice(0, 3)).toEqual(["flush", "close:true", "stop"]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other.dir)).toBe(true);
  });
});

describe("settleTestHandlesSync waits for a leaving checkpointer's files", () => {
  const real = settleInternals.sleepSync;
  afterEach(() => { settleInternals.sleepSync = real; });
  it("keeps waiting, with growing steps, until the thread has removed its -wal and -shm", () => {
    const { dir } = fixture("sync-wait");
    const wal = join(dir, "messages.db-wal"); const shm = join(dir, "messages.db-shm");
    writeFileSync(wal, "w"); writeFileSync(shm, "s");
    let asked = 0;
    const off = registerTestHandle("stop", () => { asked++; return new Promise<void>(() => {}); }, () => [wal, shm]);
    const waits: number[] = [];
    settleInternals.sleepSync = (ms: number) => { waits.push(ms); if (waits.length === 3) rmSync(wal); if (waits.length === 4) rmSync(shm); };
    try { settleTestHandlesSync(dir); } finally { off(); }
    expect(asked).toBeGreaterThan(0);
    expect(waits).toEqual([5, 10, 20, 40]);
    expect(existsSync(wal) || existsSync(shm)).toBe(false);
  });
  it("gives up after its bound rather than hanging", () => {
    const { dir } = fixture("sync-wait-bound");
    const wal = join(dir, "messages.db-wal"); writeFileSync(wal, "w");
    const off = registerTestHandle("stop", () => undefined, () => [wal]);
    const waits: number[] = [];
    settleInternals.sleepSync = (ms: number) => { waits.push(ms); };
    try { settleTestHandlesSync(dir, 100); } finally { off(); }
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(100);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThan(200);
  });
});
