// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DELETE-HOLDS-ENGINE (designs/DELETE-HOLDS-ENGINE-1017.md r2.7, r3.4, r4.2): while a conversation deletion removes engine history,
// a new turn on that engine waits at most the attempt's budget (`waitMs`) plus the tail of one worker job, never the whole removal.
// The deletion yields at its next safe point, the homes it did not prove are retried when the turn ends, and each yielded attempt
// climbs the hold ladder, so a bot in constant use still gets its deletion done (the top rung runs whole). "Try again now" restarts
// the schedule, never the ladder.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ConversationDeletions, HOLD_WAIT_STEPS_MS, runConversationDeletion, type DeletionEngineHome } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, refuseEngineHistoryJobs, resumeEngineHistory, startEngineHistoryJob, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { InstanceHolds } from "./harness/instance-holds.ts";
import { buildFixture, canaryHits, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-dhe-")));
const openDatabases: DatabaseSync[] = [];
const services: ConversationDeletions[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
  delete process.env.MURAGE_TEST_ENGINE_JOB_HOLD_MS;
  vi.useRealTimers();
});

class ScriptedWorker extends EventEmitter {
  threadId = 12;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Options = ConstructorParameters<typeof ConversationDeletions>[0];
type HoldHomes = NonNullable<Options["holdHomes"]>;
const idle = async () => ({ confirmed: true, release: () => {} });

function serviceFor(fx: Fixture, options: Partial<Options>): ConversationDeletions {
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const service = new ConversationDeletions({ dataDir: data, database: () => db, ...options });
  services.push(service);
  return service;
}

describe("a new turn on the engine never waits for the whole removal", () => {
  it("is let through near the attempt's budget plus one job; the deletion finishes on the retry the turn's end wakes", async () => {
    process.env.MURAGE_TEST_ENGINE_JOB_HOLD_MS = "300"; // every worker job holds the queue 300 ms: a slow engine folder
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const holds = new InstanceHolds();
    const calls = { n: 0 };
    let heldOnce!: () => void;
    const held = new Promise<void>((resolve) => { heldOnce = resolve; });
    const holdHomes: HoldHomes = async (homes) => {
      calls.n++;
      const taking = holds.hold(["claude-main"], 20, idle); // the gate is raised inside this call, synchronously
      if (calls.n === 1) heldOnce();
      const hold = await taking;
      return { release: hold.release, skipped: hold.busy.length ? homes : [], yieldAsked: hold.yieldAsked, yielded: hold.yielded };
    };
    const deletions = serviceFor(fx, {
      retryDelaysMs: [60_000], // no scheduled try can run during this test
      freeRetryMs: 10,
      holdHomes,
      whenEnginesFree: (_homes, since, wake) => holds.whenFree(["claude-main"], since, wake),
    });
    const deleting = runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    await held; // the probe job before the hold has run: the gate is up now
    const started = Date.now();
    await holds.admit("claude-main", "other-conversation"); // the owner's turn in another chat on the same engine
    const waited = Date.now() - started;
    // base: the gate stays up for plan + execute + verify plan, about 900 ms; fixed: asked at 20 ms, the plan job ends near 300 ms
    expect(waited).toBeLessThan(600);

    const { report } = await deleting;
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);

    holds.noteEnded("claude-main", "other-conversation");
    for (let wait = 0; wait < 5_000 && deletions.pending().length; wait += 25) await delay(25);
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(deletions.notices().filter((notice) => notice.tryAgain)).toEqual([]);
    expect(calls.n).toBe(2); // the delete, then the retry woken by the turn end
  }, 15_000);
});

describe("\"Try again now\" restarts the schedule, never the ladder (r4.1)", () => {
  it("(c) presses with Murage's own turn running each time climb the hold waits; on the base every press reset them to 250 ms", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const waits: number[] = [];
    const holdHomes: HoldHomes = async (homes, waitMs) => { waits.push(waitMs ?? -1); return { release: () => {}, skipped: homes }; };
    const deletions = serviceFor(fx, { retryDelaysMs: [60_000], holdHomes });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    for (let press = 0; press < 5; press++) await deletions.retryNow();
    expect(waits).toEqual([...HOLD_WAIT_STEPS_MS]); // [250, 1000, 4000, 15000, 60000, 240000]: the delete, then five presses
    expect(deletions.pending()).toHaveLength(1);
  });

  it("(d, r3.4 a) presses between yields: five yielded attempts, a verified mark included, then the top rung runs whole", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const waits: number[] = [];
    const holdHomes: HoldHomes = async (_homes, waitMs) => {
      waits.push(waitMs ?? -1);
      return { release: () => {}, skipped: [], yieldAsked: () => true, yielded: Promise.resolve() }; // a turn always waits at the gate
    };
    const deletions = serviceFor(fx, { retryDelaysMs: [60_000], holdHomes });
    const first = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(first.report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
    // A mark from an earlier attempt does not hide a yield: the home is owed again and the attempt still counts as a loss.
    const journal = join(fx.root, "data", "pending-deletions.json");
    const entries = JSON.parse(readFileSync(journal, "utf8")) as Array<{ homesVerified?: string[] }>;
    const keys = fx.homes.map((home: DeletionEngineHome) => `${home.engine}\0${home.home}`);
    entries[0]!.homesVerified = keys;
    writeFileSync(journal, JSON.stringify(entries));
    await deletions.retryNow();
    expect(deletions.pending()).toHaveLength(1);
    expect(deletions.pending()[0]!.homesVerified ?? []).toEqual([]);
    // a press while an attempt is in flight: that attempt, then one more after it
    await Promise.all([deletions.retryNow(), deletions.retryNow()]);
    expect(deletions.pending()).toHaveLength(1);
    await deletions.retryNow(); // the fifth yield (60 s rung)
    expect(deletions.pending()).toHaveLength(1);
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
    await deletions.retryNow(); // the 240 s rung: may not yield, runs whole
    expect(waits).toEqual([...HOLD_WAIT_STEPS_MS]);
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("InstanceHolds asks each hold at its own budget (r2.4)", () => {
  it("a hold nobody waits on is never asked", async () => {
    const holds = new InstanceHolds();
    const hold = await holds.hold(["x"], 20, idle);
    await delay(80);
    expect(hold.yieldAsked()).toBe(false);
    hold.release();
  });

  it("two overlapping holds: each is asked at its own due time, and the second keeps its timer after the first releases", async () => {
    const holds = new InstanceHolds();
    const short = await holds.hold(["x"], 20, idle);
    const long = await holds.hold(["x"], 200, idle);
    let admitted = false;
    const admitting = holds.admit("x", "turn").then(() => { admitted = true; });
    await delay(80);
    expect(short.yieldAsked()).toBe(true);
    expect(long.yieldAsked()).toBe(false);
    short.release();
    await delay(40);
    expect(admitted).toBe(false); // the gate is still up for the long hold
    expect(long.yieldAsked()).toBe(false);
    await delay(200);
    expect(long.yieldAsked()).toBe(true);
    await long.yielded;
    long.release();
    await admitting;
    expect(admitted).toBe(true);
  });

  it("a turn let through because the hold released before its budget leaves no timer behind", async () => {
    vi.useFakeTimers();
    const holds = new InstanceHolds();
    const hold = await holds.hold(["x"], 200, async () => undefined);
    const admitting = holds.admit("x", "turn");
    await vi.advanceTimersByTimeAsync(50);
    expect(hold.yieldAsked()).toBe(false);
    hold.release();
    await admitting;
    expect(vi.getTimerCount()).toBe(0);
    expect(hold.yieldAsked()).toBe(false);
  });
});

/** A worker that answers at once but leaves only when the test says so (a worker stuck in native code after terminate()). */
class LingeringWorker extends EventEmitter {
  threadId = 13;
  postMessage(_message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: { removed: [], failed: [], leftovers: [] } })); }
  terminate() { return Promise.resolve(0); }
  leave() { this.emit("exit", 0); }
}

describe("every job path returns a real exit slot (r3.2)", () => {
  it("(r3.4 b) a job refused while closing has an `exited` that waits for the earlier worker still running", async () => {
    const worker = new LingeringWorker();
    const job: EngineHistoryJob = { kind: "plan", homes: [], folders: [], memoryFolders: [], sessions: {} };
    try {
      const earlier = startEngineHistoryJob(job, { createWorker: () => worker as unknown as Worker });
      await earlier.result; // answered; the worker has not left
      refuseEngineHistoryJobs();
      const refused = startEngineHistoryJob(job);
      expect((await refused.result).removed).toEqual([]);
      let exited = false;
      void refused.exited.then(() => { exited = true; });
      await delay(30);
      expect(exited).toBe(false);
      worker.leave();
      await refused.exited;
      expect(exited).toBe(true);
    } finally {
      worker.leave();
      resumeEngineHistory();
    }
  });
});
