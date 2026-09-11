// removeTempDir is the teardown behind every suite that spawns a harness
// against a throwaway home. Its admission check (assertSafeToWipe) treats a
// lease whose owner still answers process.kill(pid, 0) as live, and a
// just-killed child can still answer that for a beat (a zombie not yet
// reaped). Judging once before the retry loop turned that beat into a
// one-off SafeWipeRefused on a green suite; the check now runs on every
// attempt, so the wipe waits for the owner to go the way it already waits
// for its files to close (FOLLOW7, SAFEWIPE1 verifier).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataDirLeasePaths } from "../../electron/data-dir-lease.mjs";
import { removeTempDir, waitForExit } from "./cleanup.ts";
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

beforeAll(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), "murage-cleanup-"))); });
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
    await expect(removeTempDir(dir)).rejects.toBeInstanceOf(SafeWipeRefused);
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
