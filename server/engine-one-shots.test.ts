// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Murage's own background one-shot runs of an engine read as the engine being open (the CLI is the engine's program). A conversation
// deletion pauses them first: new starts wait, running ones are stopped, and a stopped one starts again afterwards. An owner's turn is
// never stopped by this: while one is live the deletion stays pending, as before.
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { OneShotGate } from "./engine-one-shots.ts";
import { useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";
import { buildFixture, canaryHits, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-oneshots-")));
const openDatabases: DatabaseSync[] = [];
afterAll(() => { for (const db of openDatabases) db.close(); removeTempDirSync(scratch); });
let fake: FakeExclusion;
beforeEach(() => { fake = useFakeExclusion(); });
afterEach(() => { fake.restore(); for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name]; });

/** The deletion's worker, run inline so the fake process list (this thread's) is what it sees. */
class InlineWorker extends EventEmitter {
  threadId = 9;
  postMessage(job: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(job) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
beforeEach(() => { engineHistoryTestHooks.createWorker = () => new InlineWorker() as unknown as Worker; });

/** A one-shot run that shows as the engine's program (a child of this process, as Murage's own runs are) until it is stopped (or `finish` is called). */
function engineRun(gate: OneShotGate, engine: string, log: string[]) {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const result = gate.run(engine, undefined, async (signal) => {
    const end = fake.openEngine(engine, process.pid);
    log.push("start");
    try {
      await Promise.race([done, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
      if (signal.aborted) { log.push("stopped"); throw Object.assign(new Error("cancelled"), { name: "cancelled" }); }
      log.push("finished");
      return "ok";
    } finally { end(); }
  }, true);
  return { result, finish };
}

describe("the gate", () => {
  it("stops a running one-shot, makes new starts wait, and starts the stopped one again after release", async () => {
    const gate = new OneShotGate();
    const log: string[] = [];
    const first = engineRun(gate, "claude", log);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paused = await gate.pause(["claude"], 30, 2_000);
    expect(paused.clear).toBe(true);
    expect(log).toEqual(["start", "stopped"]);
    expect(gate.runningCount("claude")).toBe(0);
    let late = false;
    const waiting = gate.run("claude", undefined, async () => { late = true; return 1; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(late).toBe(false); // gated, not refused
    paused.release();
    expect(await waiting).toBe(1);
    first.finish();
    expect(await first.result).toBe("ok");
    expect(log).toEqual(["start", "stopped", "start", "finished"]);
  });

  it("a one-shot that finishes inside the grace time is left alone", async () => {
    const gate = new OneShotGate();
    const log: string[] = [];
    const run = engineRun(gate, "claude", log);
    await new Promise((resolve) => setTimeout(resolve, 10));
    setTimeout(run.finish, 30);
    const paused = await gate.pause(["claude"], 2_000, 2_000);
    expect(paused.clear).toBe(true);
    expect(log).toEqual(["start", "finished"]);
    paused.release();
    expect(await run.result).toBe("ok");
  });

  it("another engine's one-shots are not paused", async () => {
    const gate = new OneShotGate();
    const log: string[] = [];
    const other = engineRun(gate, "codex", log);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const paused = await gate.pause(["claude"], 20, 20);
    expect(log).toEqual(["start"]);
    paused.release();
    other.finish();
    await other.result;
  });
});

describe("a conversation deletion with the gate wired as the server does", () => {
  async function deleteWith(fx: Fixture, gate: OneShotGate) {
    const data = join(fx.root, "data");
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({
      dataDir: data, database: () => db, retryDelaysMs: [],
      pauseBackgroundRuns: async (engines) => (await gate.pause(engines, 20, 2_000)).release,
    });
    const out = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const pending = deletions.pending().length;
    deletions.dispose();
    return { out, pending };
  }

  it("a background one-shot alive when the deletion starts no longer leaves the home pending, and it runs again afterwards", async () => {
    const fx = buildFixture("claude", scratch);
    const gate = new OneShotGate();
    const log: string[] = [];
    const run = engineRun(gate, "claude", log);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { out, pending } = await deleteWith(fx, gate);
    expect(out.report.failed).toEqual([]);
    expect(pending).toBe(0);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    run.finish();
    expect(await run.result).toBe("ok");
    expect(log).toEqual(["start", "stopped", "start", "finished"]);
  });

  it("without the pause the same one-shot keeps the home pending (the cause)", async () => {
    const fx = buildFixture("claude", scratch);
    const gate = new OneShotGate();
    const log: string[] = [];
    const run = engineRun(gate, "claude", log);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const data = join(fx.root, "data");
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const deletions = new ConversationDeletions({ dataDir: data, database: () => db, retryDelaysMs: [] });
    const out = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    expect(out.report.failed.length).toBeGreaterThan(0);
    expect(deletions.pending()).toHaveLength(1);
    deletions.dispose();
    run.finish();
    await run.result;
  });

  it("an owner turn (not a one-shot) still keeps the deletion pending", async () => {
    const fx = buildFixture("claude", scratch);
    const gate = new OneShotGate();
    const endTurn = fake.openEngine("claude", process.pid);
    try {
      const { out, pending } = await deleteWith(fx, gate);
      expect(out.report.failed.length).toBeGreaterThan(0);
      expect(pending).toBe(1);
      expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
    } finally { endTurn(); }
  });
});

describe("a conversation deletion with the session hold wired as the server does (an idle warm engine of Murage's own)", () => {
  async function deleteHeld(fx: Fixture, hold: (homes: Parameters<NonNullable<ConstructorParameters<typeof ConversationDeletions>[0]["holdHomes"]>>[0], order: string[]) => Promise<{ release: () => void; skipped: typeof fx.homes }>) {
    const data = join(fx.root, "data");
    const db = new DatabaseSync(join(data, "messages.db"));
    openDatabases.push(db);
    const order: string[] = [];
    const deletions = new ConversationDeletions({
      dataDir: data, database: () => db, retryDelaysMs: [],
      holdHomes: (homes) => { order.push("hold"); return hold(homes, order); },
    });
    const out = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
    const pending = deletions.pending().length;
    deletions.dispose();
    return { out, pending, order };
  }

  it("a warm idle session alive at deletion start is closed and awaited before the plan, so the home is not left pending", async () => {
    const fx = buildFixture("claude", scratch);
    const warm = fake.openEngine("claude", process.pid); // the process Murage keeps after a finished turn
    let closedBeforeRelease = false;
    const { out, pending, order } = await deleteHeld(fx, async (_homes, calls) => {
      // closes the idle engine and waits until it has really exited (the adapter's holdIdle)
      await new Promise((resolve) => setTimeout(resolve, 30));
      warm();
      closedBeforeRelease = true;
      return { release: () => { calls.push("release"); }, skipped: [] };
    });
    expect(closedBeforeRelease).toBe(true);
    expect(out.report.failed).toEqual([]);
    expect(pending).toBe(0);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(order).toEqual(["hold", "release"]);
  });

  it("a turn in progress is not closed: the hold skips the home and it stays pending", async () => {
    const fx = buildFixture("claude", scratch);
    const turn = fake.openEngine("claude", process.pid);
    try {
      const { out, pending } = await deleteHeld(fx, async (homes) => ({ release: () => {}, skipped: homes as typeof fx.homes }));
      expect(out.report.failed.length).toBeGreaterThan(0);
      expect(pending).toBe(1);
      expect(canaryHits(fx.root, fx.canaries).length).toBeGreaterThan(0);
    } finally { turn(); }
  });
});
