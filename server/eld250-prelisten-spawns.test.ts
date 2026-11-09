// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// ALL.eld250 (design ELD250-KEEPALL-R3 r3.1, 5.1, tests 6.13 and 6.14): the start-up engine snapshot scan spawned three status probes
// inside the pre-listen task (the ACP `--version` probe through cachedCliVersion, the container runtime check `sh`, and the Pi probe). Each
// spawn now runs in its own macrotask: not before the next turn of the loop, exactly once after it. The roster revoke a legacy binding makes
// stays synchronous in the Store constructor (fail-closed, a regression test). Each test names the mutation it rejects.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushCoalesced } from "./atomic.ts";
import { cachedCliVersion, invalidateCliVersions } from "./cli-version-cache.ts";
import { DATA_DIR } from "./config.ts";
import { sh } from "./container-computer.ts";
import { closeDatabase, database } from "./database.ts";
import { PiDriver } from "./drivers/pi.ts";
import * as procs from "./procs.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { WritetimeFixture } from "./memory/testing/writetime-fixture.ts";

vi.mock("./procs.ts", async (original) => {
  const real = await original<typeof import("./procs.ts")>();
  return { ...real, spawnCli: vi.fn(real.spawnCli) };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = join(HERE, "testing", "fake-pi-cli.ts");
let dir = "";
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
// Every queued microtask (and what each one queues) runs before this resolves: a spawn deferred by queueMicrotask or an already-resolved
// promise has happened by then, one deferred to the next macrotask has not (Astra F3)
const drainMicrotasks = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "eld250-spawn-")); invalidateCliVersions(); });
afterEach(() => { removeTempDirSync(dir); invalidateCliVersions(); vi.restoreAllMocks(); });

describe("start-up status probes spawn in their own task (ALL.eld250 B9, B15)", () => {
  const cli = () => { const path = join(dir, "engine"); writeFileSync(path, "#!/bin/sh\necho 1.0.0\n"); chmodSync(path, 0o755); return path; };

  it("cachedCliVersion: two callers in one task share one promise, no spawn before the next turn, exactly one after", async () => {
    // rejects: a spawn inside the caller's task (the code before), and a second spawn for a shared key
    const path = cli();
    let callback: ((e: Error | null, out: string, err: string) => void) | undefined;
    const run = vi.fn((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => { callback = cb; }) as never;
    const one = cachedCliVersion(path, process.env, run), two = cachedCliVersion(path, process.env, run);
    expect(one).toBe(two);
    expect(run).toHaveBeenCalledTimes(0);
    await drainMicrotasks();
    expect(run).toHaveBeenCalledTimes(0);
    await turn();
    expect(run).toHaveBeenCalledTimes(1);
    callback!(null, "1.0.0", "");
    expect((await one).stdout).toBe("1.0.0");
    expect((await two).stdout).toBe("1.0.0");
    // held: a later caller does not spawn again
    await cachedCliVersion(path, process.env, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cachedCliVersion: an invalidation between the call and its turn resolves the probe without holding it", async () => {
    const path = cli();
    const run = vi.fn((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string, err: string) => void) => { cb(null, "1.0.0", ""); }) as never;
    const probe = cachedCliVersion(path, process.env, run);
    invalidateCliVersions();
    expect((await probe).stdout).toBe("1.0.0");
    await cachedCliVersion(path, process.env, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cachedCliVersion (B15): a runner that throws settles the probe as a failed run, drops the entry, and nothing is uncaught", async () => {
    // rejects: a deferred spawn that loses the synchronous throw (an unhandled exception in the immediate)
    const path = cli();
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const run = vi.fn(() => { throw new Error("spawn EACCES"); }) as never;
      const probe = await cachedCliVersion(path, process.env, run);
      expect(probe).toEqual({ error: expect.objectContaining({ message: "spawn EACCES" }), stdout: "", stderr: "" });
      // the failure is not held: the next call spawns again
      await cachedCliVersion(path, process.env, run).catch(() => undefined);
      expect(run).toHaveBeenCalledTimes(2);
      await turn();
      expect(uncaught).not.toHaveBeenCalled();
    } finally { process.off("uncaughtException", uncaught); }
  });

  it("the container runtime check: no spawn before the next turn, exactly one after", async () => {
    const exec = vi.fn(async () => ({ stdout: "ok", stderr: "" })) as never;
    const pending = sh("docker", ["info"], 8000, exec);
    expect(exec).toHaveBeenCalledTimes(0);
    await drainMicrotasks();
    expect(exec).toHaveBeenCalledTimes(0);
    await turn();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual({ stdout: "ok" });
  });

  it("the Pi probe: no spawnCli before the next turn, exactly one after", async () => {
    chmodSync(FAKE_PI, 0o755);
    const instance = await PiDriver.create({ instanceId: "pi-eld250", displayName: undefined, environment: {}, enabled: true, config: { cli: FAKE_PI, fullAuto: false } });
    try {
      const spawn = vi.mocked(procs.spawnCli);
      spawn.mockClear();
      const snapshot = instance.snapshot();
      expect(spawn).toHaveBeenCalledTimes(0);
      await drainMicrotasks();
      expect(spawn).toHaveBeenCalledTimes(0);
      await turn();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect((await snapshot).state).toBe("available");
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { await instance.dispose(); }
  });
});

describe("the roster revoke stays fail-closed and pre-listen (ALL.eld250 5.1, test 6.14, regression)", () => {
  beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { try { flushCoalesced(); } catch { /* gone */ } closeDatabase(); });
  const live = () => Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE state IN ('prepared','delivered')").get()!.n);
  const make = () => new Store(() => ({ instanceId: "engine-one", model: "one", effort: "medium", connectionId: "account-one" }));

  it("a legacy (pre-v2) roster binding: every live receipt is revoked before the Store constructor returns; the next start revokes nothing", () => {
    // rejects: moving the reconcile revoke out of the constructor's synchronous path
    const first = make(); first.createBot(); flushCoalesced();
    const fx = new WritetimeFixture(database());
    fx.receipt("b1", "T", "d", "x").receipt("b2", "T", "d", "y", { state: "prepared" });
    // a binding written before v2: ids and threads only
    const binding = database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='roster'").get();
    expect(binding).toBeDefined();
    database().prepare("UPDATE memory_scope_bindings SET intent=? WHERE subject_type='system' AND subject_id='roster'").run(JSON.stringify({ bots: [], groups: [] }));
    expect(live()).toBe(2);
    make();
    expect(live()).toBe(0);
    // the binding is v2 now: a second start over the same roster keeps a new receipt
    fx.receipt("b3", "T", "d", "z");
    make();
    expect(live()).toBe(1);
  });
});
