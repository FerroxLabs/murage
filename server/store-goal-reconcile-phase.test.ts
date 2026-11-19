// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance: the goal reconcile is a boot recovery. Before the process serves, a working receipt is the last run's and is closed; once the
// process serves (closeBootRecoveries, called at listen) a working receipt may be this run's, and a reconcile that arrives late changes nothing.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOTE = "Murage restarted before this goal finished.";
const fresh = () => new Store(() => ({ instanceId: "fixture", model: "fixture" }));
const seedGoal = (store: Store, threadId: string, runId: string) => store.appendMessage(threadId, {
  role: "bot", kind: "goal.run", text: "Goal in progress: coordinating.",
  goalRun: { runId, goal: "Ship the notes", status: "working", coordinatorBotId: "lead-1", coordinatorName: "Lead", turnCount: 1, maxTurns: 13, startedAt: 1 },
});
const statusOf = (store: Store, threadId: string, id: string) => store.messagesFor(threadId).find((message) => message.id === id)?.goalRun?.status;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });

it("W7 before listen the reconcile closes the last run's receipt; after listen a late reconcile leaves this run's goal working", () => {
  const store = fresh(); const bot = store.createBot(); const room = store.createGroup("Launch", [bot.id]);
  const orphan = seedGoal(store, room.threadId, "orphan-before-boot");
  expect(store.reconcileInterruptedGroupGoals(undefined, NOTE, 99)).toBe(1);        // the boot recovery, in its window
  expect(statusOf(store, room.threadId, orphan.id)).toBe("failed");
  store.closeBootRecoveries();                                                       // listen
  const live = seedGoal(store, room.threadId, "started-after-listen");
  expect(store.reconcileInterruptedGroupGoals(undefined, NOTE, 100)).toBe(0);       // a held entry drained late
  expect(statusOf(store, room.threadId, live.id)).toBe("working");
});

it("W7 a new process (a new Store) reconciles again: the latch is per run, so the next start closes what this run left", () => {
  const first = fresh(); const bot = first.createBot(); const room = first.createGroup("Launch", [bot.id]);
  first.closeBootRecoveries();
  const left = seedGoal(first, room.threadId, "left-working");
  closeDatabase();
  const next = fresh();
  expect(next.reconcileInterruptedGroupGoals(undefined, NOTE, 99)).toBe(1);
  expect(statusOf(next, room.threadId, left.id)).toBe("failed");
});
