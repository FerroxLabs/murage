// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Row 86 (TRAIN-1024 F15, q1024-recallmemo), design r5 W-D12a/b: a deletion lost to Murage's own running turn B, with the owner's own
// Claude Code on the home, still gets the open-home pass (DELETION-WHILE-OPEN-107) while B keeps running: the conversation's own files
// go, the shared history row stays owed. Production class, production holder probe (probeDeletionHomes over the system process list),
// real registry holds; only the process list and /proc are faked.
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

import { ConversationDeletions, runConversationDeletion } from "./conversation-deletion.ts";
import { probeDeletionHomes } from "./engine-closed.ts";
import { exclOps } from "./engine-fs.ts";
import { engineHistoryTestHooks, type EngineHistoryJob } from "./engine-history-offthread.ts";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import { InstanceHolds } from "./harness/instance-holds.ts";
import { buildFixture, THREAD } from "./testing/engine-history-fixtures.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { proc, useFakeExclusion, type FakeExclusion } from "./testing/engine-exclusion-fake.ts";

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "murage-ownturn-openpass-")));
const databases: DatabaseSync[] = [];
const services: ConversationDeletions[] = [];
afterAll(() => { for (const db of databases) db.close(); removeTempDirSync(scratch); });

let fake: FakeExclusion;
beforeEach(() => {
  fake = useFakeExclusion();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // what Linux /proc shows for each fake process: it works in the owner's own project and has nothing of the conversation open
  Object.assign(exclOps, { procView: "linux", procCwd: () => "/home/x/work/app", procFiles: () => ["/dev/null"], lsofFiles: () => null });
});
afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
  vi.restoreAllMocks();
  fake.restore();
  for (const name of Object.keys(engineHistoryTestHooks)) delete (engineHistoryTestHooks as Record<string, unknown>)[name];
});

class InlineWorker extends EventEmitter {
  threadId = 9;
  postMessage(message: EngineHistoryJob) { setImmediate(() => this.emit("message", { type: "result", result: runEngineHistoryJob(message) })); }
  terminate() { setImmediate(() => this.emit("exit", 0)); return Promise.resolve(0); }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let next = 0;
/** The owner's own Claude Code on `home`, started in a terminal (not Murage's child), in another folder. */
const ownerClaude = (home: string) => {
  const item = { ...proc("/Users/x/.local/share/claude/versions/2.1.310", ["claude"], 8600 + next++), ppid: 1 };
  fake.processes.push(item);
  fake.environments.set(item.pid, { HOME: scratch, CLAUDE_CONFIG_DIR: home });
};
const CANARY = "canary-claude-5521";

/** Conversation A's deletion while Murage turn B (another thread) runs on the instance that uses the home; B never ends here. */
async function lostToTurnB(openLooksMax: number, onFirstHold?: (home: string) => void, probeThrows = () => false) {
  const fx = buildFixture("claude", scratch);
  const home = fx.homes[0]!.home;
  const workers = { n: 0 };
  engineHistoryTestHooks.createWorker = () => { workers.n++; return new InlineWorker() as unknown as Worker; };
  const data = join(fx.root, "data");
  mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(join(data, "messages.db"));
  databases.push(db);
  const holds = new InstanceHolds();
  holds.noteStarted("claude-main", "turn-b");
  const holdCalls = { n: 0 };
  const looks: Array<{ open: boolean; attempts: number }> = [];
  const deletions = new ConversationDeletions({
    dataDir: data, database: () => db, retryDelaysMs: [5], openRetryMs: 30, slowRetryMs: 60_000, freeRetryMs: 10, openLooksMax,
    // holdHomes as index.ts builds it: one registry instance uses the home; B still running after the wait skips the home
    holdHomes: async (homes) => {
      holdCalls.n++;
      if (holdCalls.n === 1) onFirstHold?.(home);
      const held = await holds.hold(["claude-main"], 20, async () => ({ confirmed: true, release: () => {} }));
      return { release: held.release, skipped: held.busy.length ? homes : [] };
    },
    whenEnginesFree: (_homes, since, done) => holds.whenFree(["claude-main"], since, done),
    // every look's answer is kept, with how many attempts (finish) had started by then
    probeHomes: (owed) => {
      if (probeThrows()) throw new Error("the probe failed");
      const answer = probeDeletionHomes(owed, join(scratch, "native"));
      looks.push({ open: answer.some((item) => item.open), attempts: attempts.n });
      return answer;
    },
  });
  const attempts = { n: 0 };
  const finish = deletions.finish.bind(deletions);
  vi.spyOn(deletions, "finish").mockImplementation((...args) => { attempts.n++; return finish(...args); });
  services.push(deletions);
  const { report } = await runConversationDeletion(deletions, { threadIds: [THREAD], engineHomes: fx.homes }, () => true);
  expect(report.failed).toContain(home);
  expect(holdCalls.n).toBe(1);
  const project = fx.gone[0]!;
  expect(existsSync(project)).toBe(true); // nothing removed yet: the hold lost to B before the plan
  const own = [join(home, "debug", "sess-claude-1.txt"), join(home, "file-history", "sess-claude-1")]; // the session's side files
  expect(own.every((path) => existsSync(path))).toBe(true);
  attempts.n = 0;
  return { fx, home, holds, deletions, holdCalls, workers, project, own, looks, attempts, history: join(home, "history.jsonl") };
}
const until = async (done: () => boolean, ms = 3_000) => { for (let waited = 0; waited < ms && !done(); waited += 10) await delay(10); };

it("W-D12a: the owner's Claude Code opening the home after the loss gets the open-home pass on that tick, B still running", async () => {
  const w = await lostToTurnB(1_000);
  const workersAfterLoss = w.workers.n;
  await delay(150); // several 30 ms ticks
  // base: every tick is a whole attempt (a worker, a hold, a plan line); here only looks while B runs and nobody else is on the home
  expect(w.holdCalls.n).toBe(1);
  expect(w.workers.n).toBe(workersAfterLoss);
  const looksBefore = w.looks.length;
  ownerClaude(w.home);
  await until(() => !existsSync(w.project));
  // the open-home pass removed A's own files (project folder and side files); B was never ended and never held for it; the shared row
  // stays owed
  expect(existsSync(w.project)).toBe(false);
  expect(w.own.filter((path) => existsSync(path))).toEqual([]);
  // on that tick: the first look that saw the owner's CLI was followed by the attempt (its tick probes twice: the own-turn look, then the
  // same-holders check), not by another look
  expect(w.looks.slice(looksBefore).filter((look) => look.open && look.attempts === 0).length).toBeLessThanOrEqual(2);
  expect(w.attempts.n).toBe(1);
  expect(w.holdCalls.n).toBe(1);
  expect(readFileSync(w.history, "utf8")).toContain(CANARY);
  expect(w.deletions.pending()).toHaveLength(1);
  // the next ticks, the CLI still open: the base same-holder looks, no further whole attempt
  await delay(150);
  expect(w.attempts.n).toBe(1);
});

it("W-D12a variant: the probe throws when the owner's Claude Code opens the home: a real attempt, and its open-home pass", async () => {
  let throws = false;
  const w = await lostToTurnB(1_000, undefined, () => throws);
  throws = true;
  ownerClaude(w.home);
  await until(() => !existsSync(w.project));
  expect(existsSync(w.project)).toBe(false);
  expect(w.own.filter((path) => existsSync(path))).toEqual([]);
  expect(w.holdCalls.n).toBe(1);
  expect(readFileSync(w.history, "utf8")).toContain(CANARY);
});

it("W-D12b: the owner's Claude Code already open at the loss: same-holder looks, then the forced attempt's open-home pass, B still running", async () => {
  const w = await lostToTurnB(3, (home) => ownerClaude(home));
  // the outsider arrived inside the first hold (after that attempt's own outsider check), so the loss is to B and its holders are
  // recorded: the first ticks (5 ms, then every 30 ms) are same-holder looks, no attempt
  await delay(50);
  expect(w.attempts.n).toBe(0);
  expect(existsSync(w.project)).toBe(true);
  await until(() => !existsSync(w.project));
  // the looks run out (openLooksMax 3) and the forced attempt runs its open-home pass: A's own files go while B keeps running
  expect(existsSync(w.project)).toBe(false);
  expect(w.own.filter((path) => existsSync(path))).toEqual([]);
  expect(w.attempts.n).toBe(1);
  expect(w.looks.filter((look) => look.attempts === 0).length).toBeGreaterThanOrEqual(3);
  expect(w.holdCalls.n).toBe(1);
  expect(readFileSync(w.history, "utf8")).toContain(CANARY);
  expect(w.deletions.pending()).toHaveLength(1);
});
