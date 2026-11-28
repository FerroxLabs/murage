// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Row 86 (TRAIN-1024 F15, q1024-recallmemo): a deletion that lost only to Murage's own running turn makes no further whole attempt
// (no worker, no hold, no plan line) on its schedule while that turn is still running and no program Murage did not start is on the
// homes: the turn's end already wakes the next try (whenEnginesFree). An outside holder, no wake to wait for, or the looks running out
// still get the attempt, so a removable transcript is never left on disk for the life of a long turn.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { probeDeletionHomes } from "./engine-closed.ts";
import { exclOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { InstanceHolds } from "./harness/instance-holds.ts";
import { buildFixture, canaryHits, THREAD, type Fixture } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { useFakeExclusion } from "./testing/engine-exclusion-fake.ts";

type Options = ConstructorParameters<typeof ConversationDeletions>[0];
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-ownlooks-")));
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

/** A deletion of the fixture's conversation while a Murage turn runs on its engine; counts the whole attempts (holds) and workers. */
async function lostToOwnTurn(options: Partial<Options>, wake = true, engine: "codex" | "fuigo" = "codex") {
  const workers = { n: 0 };
  engineHistoryTestHooks.createWorker = () => { workers.n++; return new ScriptedWorker() as unknown as Worker; };
  const fx: Fixture = buildFixture(engine, scratch);
  const holds = new InstanceHolds();
  holds.noteStarted("claude-main", "a-long-turn");
  const attempts = { n: 0 };
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  openDatabases.push(db);
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [5], openRetryMs: 30, slowRetryMs: 60_000, freeRetryMs: 10,
    // holdHomes as index.ts builds it: one registry instance uses the home; a turn still running after the wait skips the home
    holdHomes: async (homes) => {
      attempts.n++;
      const held = await holds.hold(["claude-main"], 20, async () => ({ confirmed: true, release: () => {} }));
      return { release: held.release, skipped: held.busy.length ? homes : [] };
    },
    ...(wake ? { whenEnginesFree: (_homes, since, done) => holds.whenFree(["claude-main"], since, done) } : {}),
    ...options,
  });
  services.push(deletions);
  const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
  expect(report.failed).toContain(fx.homes[0]!.home);
  expect(attempts.n).toBe(1);
  return { fx, holds, deletions, attempts, workers };
}
/** probeHomes as engine-closed.ts answers it: `open` only for a program Murage did not start. */
const probe = (outside: () => boolean): Options["probeHomes"] => (homes) => homes.map((home) => ({ key: `${home.engine}\0${home.home}`, open: outside(), holders: outside() ? "4242:outside-editor" : "" }));

describe("a deletion lost to Murage's own running turn (row 86 U3)", () => {
  it("W1: makes no whole attempt on its schedule while that turn runs, then finishes on the turn's end", async () => {
    // looks never run out here (W4 owns that bound): every whole attempt counted is one the own-turn rule failed to skip
    const { fx, holds, deletions, attempts, workers } = await lostToOwnTurn({ probeHomes: probe(() => false), openLooksMax: 1_000 });
    const workersAfterDelete = workers.n;
    await delay(400); // about a dozen ticks of the 30 ms schedule
    // base: every tick is a whole attempt (a hold, a worker and a plan line each); here: only looks
    expect(attempts.n).toBe(1);
    expect(workers.n).toBe(workersAfterDelete);
    expect(deletions.pending()).toHaveLength(1);
    holds.noteEnded("claude-main", "a-long-turn");
    for (let waited = 0; waited < 3_000 && deletions.pending().length; waited += 25) await delay(25);
    expect(deletions.pending()).toEqual([]);
    expect(canaryHits(fx.root, fx.canaries)).toEqual([]);
    expect(attempts.n).toBe(2);
  });

  it("G2 (guard): a program Murage did not start appearing on the home gets the attempt at once (its open-home pass), turn still running", async () => {
    let outside = false;
    const { attempts } = await lostToOwnTurn({ probeHomes: probe(() => outside), openLooksMax: 1_000 });
    await delay(150);
    const before = attempts.n;
    outside = true;
    await delay(150);
    expect(attempts.n).toBeGreaterThan(before);
  });

  it("G2r (guard, production probe): the owner's own program opening the home mid-turn gets the attempt through probeDeletionHomes", async () => {
    // the system's process list is the only thing faked (the native listing); the probe, its holder rules and the attempt's gate are production
    const fake = useFakeExclusion();
    const views = new Map<number, { cwd: string | null; files: string[] | null }>();
    const saved = { procView: exclOps.procView, procCwd: exclOps.procCwd, procFiles: exclOps.procFiles };
    Object.assign(exclOps, { procView: "linux", procCwd: (pid: number) => views.get(pid)?.cwd ?? null, procFiles: (pid: number) => views.get(pid)?.files ?? null });
    try {
      let probes = 0;
      const { fx, deletions } = await lostToOwnTurn({ probeHomes: (owed) => { probes++; return probeDeletionHomes(owed, join(scratch, "native")); }, openLooksMax: 1_000 }, true, "fuigo");
      // an attempt is a call of finish (with an outside holder its own gate stops before any hold or pause)
      const finish = vi.spyOn(deletions, "finish");
      const attempts = { get n() { return finish.mock.calls.length; } };
      await delay(150);
      const before = attempts.n;
      expect(before).toBe(0); // the production probe sees no outside holder: only looks so far
      expect(probes).toBeGreaterThan(0);
      const closeOutside = fake.openEngine("fuigo"); // the owner's own program in a terminal, not Murage's child
      await delay(150);
      expect(probeDeletionHomes(fx.homes, join(scratch, "native")).every((home) => home.open)).toBe(true); // the production probe sees it
      closeOutside();
      expect(attempts.n).toBeGreaterThan(before);
    } finally { Object.assign(exclOps, saved); fake.restore(); }
  });

  it("G5r (guard, production probe): a process list that cannot be read is no proof: the schedule keeps its whole attempts", async () => {
    const fake = useFakeExclusion();
    try {
      const { fx, deletions } = await lostToOwnTurn({ probeHomes: (owed) => probeDeletionHomes(owed, join(scratch, "native")), openLooksMax: 1_000 }, true, "fuigo");
      const finish = vi.spyOn(deletions, "finish");
      // after the loss to the own turn, the system listing fails: engineState says unknown, the probe "not open" with unknown set
      fake.processesFail = true;
      expect(probeDeletionHomes(fx.homes, join(scratch, "native")).every((home) => !home.open && home.unknown)).toBe(true);
      await delay(400);
      expect(finish.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally { fake.restore(); }
  });

  it("G5r2 (guard, production probe): a program seen by the first read, then a second read that fails, is no proof either", async () => {
    const fake = useFakeExclusion();
    const views = new Map<number, { cwd: string | null; files: string[] | null }>();
    const saved = { procView: exclOps.procView, procCwd: exclOps.procCwd, procFiles: exclOps.procFiles };
    Object.assign(exclOps, { procView: "linux", procCwd: (pid: number) => views.get(pid)?.cwd ?? null, procFiles: (pid: number) => views.get(pid)?.files ?? null });
    // inside one probe, every listing after its first throws: engineState (the first read) sees the program, foreignEngineHolders (the
    // second read) cannot read the list. An empty list would not do: that is a real answer ("Murage's own processes alone").
    const firstReadOnly = <T,>(look: () => T): T => {
      const start = fake.processCalls;
      fake.onProcesses = (call) => { if (call > start + 1) throw new Error("the process list could not be read"); };
      try { return look(); } finally { fake.onProcesses = undefined; }
    };
    let failSecond = false;
    const native = join(scratch, "native");
    try {
      const { fx, deletions } = await lostToOwnTurn({ probeHomes: (owed) => (failSecond ? firstReadOnly(() => probeDeletionHomes(owed, native)) : probeDeletionHomes(owed, native)), openLooksMax: 1_000 }, true, "fuigo");
      const finish = vi.spyOn(deletions, "finish");
      failSecond = true; // before the program opens, so no scheduled look ever reads both lists while it is there
      fake.openEngine("fuigo"); // the owner's own program in a terminal, not Murage's child
      // with both reads it is an outside holder (the probe reaches foreignEngineHolders, not the unreadable-list return above it)
      expect(probeDeletionHomes(fx.homes, native).every((home) => home.open)).toBe(true);
      expect(firstReadOnly(() => probeDeletionHomes(fx.homes, native)).every((home) => !home.open && home.unknown)).toBe(true);
      await delay(400);
      expect(finish.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally { Object.assign(exclOps, saved); fake.restore(); }
  });

  it("G3 (guard): with no wake for the turn's end (no whenEnginesFree), the schedule keeps its whole attempts", async () => {
    const { attempts } = await lostToOwnTurn({ probeHomes: probe(() => false), openLooksMax: 1_000 }, false);
    await delay(400);
    expect(attempts.n).toBeGreaterThanOrEqual(4);
  });

  it("G4 (guard): the looks are bounded: after openLooksMax looks an attempt runs anyway", async () => {
    const { attempts } = await lostToOwnTurn({ probeHomes: probe(() => false), openLooksMax: 2 });
    await delay(400);
    expect(attempts.n).toBeGreaterThanOrEqual(3);
  });

  it("G6 (regression of db5cd47049): lost to the own turn with a program Murage did not start already on the home, the looks still force an attempt", async () => {
    // the probe is first asked after the attempt (finishOnce records the holders), so the loss is to the own turn (ownTurnOnly) AND the
    // outsider's holders are recorded: every tick is then a same-holders look, and every openLooksMax looks an attempt is forced, as on base
    const { attempts } = await lostToOwnTurn({ probeHomes: probe(() => true), openLooksMax: 2 });
    await delay(400);
    // db5cd47049: the own-turn rule zeroed the shared looks count at its cap and the same-holders look skipped the forced attempt: 1 for good
    expect(attempts.n).toBeGreaterThanOrEqual(3);
  });

  it("W6: at start-up (reconcile) a deletion the pass skips because Murage's own turn holds its home makes no whole attempt either", async () => {
    // a deletion lost to the running turn; the journal a restart finds holds a second one owed on the same home (the fixture seeds
    // one conversation, so the second record is the first one's copy under its own id: the state two such deletions leave)
    const first = await lostToOwnTurn({ retryDelaysMs: [] });
    const { fx, holds } = first;
    first.deletions.dispose();
    const data = join(fx.root, "data"), journal = join(data, "pending-deletions.json");
    const [owed] = JSON.parse(readFileSync(journal, "utf8")) as Array<{ id: string; lastTriedAt?: number }>;
    writeFileSync(journal, JSON.stringify([{ ...owed, lastTriedAt: 1 }, { ...owed, id: `${owed!.id}-second`, lastTriedAt: 2 }]));
    // the next start, the turn still running: one attempt learns the home is held, the drain skips the other
    const attempts = { n: 0 };
    const after = new ConversationDeletions({
      dataDir: data, database: () => openDatabases.at(-1)!, retryDelaysMs: [5], openRetryMs: 30, slowRetryMs: 60_000, freeRetryMs: 10, openLooksMax: 1_000,
      holdHomes: async (homes) => {
        attempts.n++;
        const held = await holds.hold(["claude-main"], 20, async () => ({ confirmed: true, release: () => {} }));
        return { release: held.release, skipped: held.busy.length ? homes : [] };
      },
      whenEnginesFree: (_homes, since, done) => holds.whenFree(["claude-main"], since, done),
      probeHomes: probe(() => false),
    });
    services.push(after);
    await after.reconcile(() => false, () => {});
    expect(after.pending()).toHaveLength(2);
    expect(attempts.n).toBe(1);
    await delay(400);
    // base: both deletions attempt at every tick; the drain-skipped one alone does without its own-turn record
    expect(attempts.n).toBe(1);
    holds.noteEnded("claude-main", "a-long-turn");
    for (let waited = 0; waited < 3_000 && after.pending().length; waited += 25) await delay(25);
    expect(after.pending()).toEqual([]);
  });

  it("G5 (guard): with no probe (the process list unreadable) the schedule keeps its whole attempts", async () => {
    const { attempts } = await lostToOwnTurn({ probeHomes: () => { throw new Error("no process list"); }, openLooksMax: 1_000 });
    await delay(400);
    expect(attempts.n).toBeGreaterThanOrEqual(4);
  });
});
