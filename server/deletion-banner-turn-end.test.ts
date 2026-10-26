// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 follow-up (designs/DELETION-BANNER.md): a deletion whose engine home was skipped because Murage's own turn on that engine was
// still running ("engine-running") is tried again as soon as that turn ends, and is never left to the hours-long cadence. Sean's log
// on 10-21 showed "home left pending (claude): engine-running" four times, and the line never cleared.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { InstanceHolds } from "./harness/instance-holds.ts";
import { buildFixture, canaryHits, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-delbanner-")));
const openDatabases: DatabaseSync[] = [];
const services: ConversationDeletions[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

class ScriptedWorker extends EventEmitter {
  threadId = 12;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function serviceFor(fx: Fixture, options: Partial<ConstructorParameters<typeof ConversationDeletions>[0]>): ConversationDeletions {
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const service = new ConversationDeletions({ dataDir: data, database: () => db, ...options });
  services.push(service);
  return service;
}

/** holdHomes as index.ts builds it: one registry instance uses the home; a turn still running after the wait skips the home. */
function holdThrough(holds: InstanceHolds, calls: { n: number }) {
  return async (homes: Parameters<NonNullable<ConstructorParameters<typeof ConversationDeletions>[0]["holdHomes"]>>[0]) => {
    calls.n++;
    const held = await holds.hold(["claude-main"], 20, async () => ({ confirmed: true, release: () => {} }));
    return { release: held.release, skipped: held.busy.length ? homes : [] };
  };
}

describe("a deletion held back by Murage's own turn", () => {
  it("is tried again when that turn ends, and the record clears (on the base it waited for the schedule, which here is a minute away)", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const holds = new InstanceHolds();
    holds.noteStarted("claude-main", "another-conversation"); // a bot's turn on the same engine, in a different conversation
    const calls = { n: 0 };
    const deletions = serviceFor(fx, {
      retryDelaysMs: [60_000], // no scheduled try can run during this test
      freeRetryMs: 10,
      holdHomes: holdThrough(holds, calls),
      whenEnginesFree: (_homes, since, wake) => holds.whenFree(["claude-main"], since, wake),
    });
    const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(report.failed).toContain(fx.homes[0]!.home);
    expect(deletions.pending()).toHaveLength(1);
    expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);

    holds.noteEnded("claude-main", "another-conversation"); // the turn ends (or the owner pressed Stop)
    for (let waited = 0; waited < 3_000 && deletions.pending().length; waited += 25) await delay(25);
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(deletions.notices().filter((notice) => notice.tryAgain)).toEqual([]);
    expect(calls.n).toBe(2); // the delete, then exactly one try woken by the turn end
  });

  it("while the turn never ends, the schedule keeps trying every few minutes at most, never the hours-long pause", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const holds = new InstanceHolds();
    holds.noteStarted("claude-main", "a-turn-that-runs-all-day");
    const calls = { n: 0 };
    const deletions = serviceFor(fx, { retryDelaysMs: [5], openRetryMs: 30, slowRetryMs: 60_000, holdHomes: holdThrough(holds, calls) });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    await delay(500);
    // base: the delete, the one listed pause, then six hours; here: the delete, the pause, then every 30 ms (capped at 10 minutes)
    expect(calls.n).toBeGreaterThanOrEqual(4);
    expect(deletions.pending()).toHaveLength(1);
  });
});

/** holdHomes that counts how many attempts hold the homes at once. `during(n)` runs inside the n-th hold, before it answers. */
function countingHold(holds: InstanceHolds, during: (n: number) => Promise<void> | void) {
  const seen = { n: 0, inside: 0, most: 0 };
  const holdHomes = async (homes: Parameters<NonNullable<ConstructorParameters<typeof ConversationDeletions>[0]["holdHomes"]>>[0]) => {
    seen.n++;
    seen.inside++;
    seen.most = Math.max(seen.most, seen.inside);
    let released = false;
    const release = () => { if (!released) { released = true; seen.inside--; } };
    try {
      const busy = holds.runningTurns("claude-main") > 0;
      await during(seen.n);
      return { release, skipped: busy ? homes : [] };
    } catch (error) { release(); throw error; }
  };
  return { seen, holdHomes };
}

describe("one attempt per deletion at a time (GrokBuild High, deletion-banner)", () => {
  it("a turn that ends while the next attempt runs never starts a second attempt beside it", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const holds = new InstanceHolds();
    holds.noteStarted("claude-main", "another-conversation");
    const { seen, holdHomes } = countingHold(holds, async (n) => {
      if (n !== 2) return;
      holds.noteEnded("claude-main", "another-conversation"); // the turn ends while attempt 2 holds the homes
      await delay(150); // attempt 2 is still working when the woken try would start (freeRetryMs 10)
    });
    const deletions = serviceFor(fx, {
      retryDelaysMs: [60_000],
      freeRetryMs: 10,
      holdHomes,
      whenEnginesFree: (_homes, since, wake) => holds.whenFree(["claude-main"], since, wake),
    });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(deletions.pending()).toHaveLength(1);
    await deletions.retryNow();
    await delay(300);
    expect(seen.most).toBe(1);
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });

  it("a second call while an attempt runs waits for it, then tries once more, never beside it", async () => {
    engineHistoryTestHooks.createWorker = () => new ScriptedWorker() as unknown as Worker;
    const fx = buildFixture("codex", scratch);
    const holds = new InstanceHolds();
    holds.noteStarted("claude-main", "another-conversation");
    const { seen, holdHomes } = countingHold(holds, async (n) => { if (n === 2) await delay(100); });
    const deletions = serviceFor(fx, { retryDelaysMs: [60_000], freeRetryMs: 10, holdHomes });
    await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const first = deletions.retryNow();
    await delay(20);
    holds.noteEnded("claude-main", "another-conversation");
    await Promise.all([first, deletions.retryNow()]);
    expect(seen.most).toBe(1);
    expect(seen.n).toBe(3); // the delete, the attempt in flight, and the one asked for while it ran
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
  });
});

describe("InstanceHolds.whenFree", () => {
  it("wakes once, when the last running turn ends after `since`", () => {
    const holds = new InstanceHolds();
    holds.noteStarted("a", "t1");
    holds.noteStarted("b", "t2");
    let woke = 0;
    holds.whenFree(["a", "b"], Date.now(), () => { woke++; });
    expect(woke).toBe(0);
    holds.noteEnded("a", "t1");
    expect(woke).toBe(0); // b is still running
    holds.noteEnded("b", "t2");
    expect(woke).toBe(1);
    holds.noteStarted("a", "t3");
    holds.noteEnded("a", "t3");
    expect(woke).toBe(1); // once only
  });

  it("wakes at once when the turn already ended after `since` (it ended between the hold and the registration)", () => {
    const holds = new InstanceHolds();
    holds.noteStarted("a", "t1");
    const since = Date.now();
    holds.noteEnded("a", "t1");
    let woke = 0;
    holds.whenFree(["a"], since, () => { woke++; });
    expect(woke).toBe(1);
  });

  it("never wakes for an instance that saw no turn end since, and a cancelled wait never wakes", () => {
    const holds = new InstanceHolds();
    holds.noteStarted("a", "t1");
    holds.noteEnded("a", "t1");
    let woke = 0;
    holds.whenFree(["a"], Date.now() + 60_000, () => { woke++; }); // the end was before `since`
    holds.whenFree(["idle-never-confirmed"], Date.now(), () => { woke++; }); // busy only because its idle engines were not confirmed closed
    expect(woke).toBe(0);
    holds.noteStarted("c", "t2");
    const cancel = holds.whenFree(["c"], Date.now(), () => { woke++; });
    cancel();
    holds.noteEnded("c", "t2");
    expect(woke).toBe(0);
  });
});
