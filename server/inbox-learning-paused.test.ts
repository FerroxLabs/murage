// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings L6: the "Learning paused for the rest of the month" Needs you item. Derived on every read from the month ledger
// against the stored ceiling; counted once; gone after a raise, "Leave paused" or the next month. Tokens only.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { leaveLearningPaused, learningPausedRow, resetLeftLearningPaused, withLearningPaused } from "./inbox-learning-paused.ts";
import { ownerMemoryTicket } from "./memory/authority.ts";
import { readMemoryLearning, updateMemoryLearning } from "./memory/learning-policy.ts";
import { reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { memoryOwnerRoute } from "./memory/settings.ts";
import { learningSpendLedgerId, learningSpendMonth } from "../shared/memory-learning-contract.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
const roster = { bots: [{ id: "bot", threadId: "thread" }], groups: [] } as unknown as MemoryRoster;
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); resetLeftLearningPaused();
});
afterEach(() => resetLeftLearningPaused());

const setCeiling = (input: number, output: number) => { const db = database(); updateMemoryLearning(db, { ceiling: { input, output } }, readMemoryLearning(db).revision); };
const setSpend = (input: number, output: number, at = Date.now()) => database().prepare("INSERT INTO memory_scope_bindings VALUES(?,(SELECT id FROM memory_scopes LIMIT 1),'system','learning-spend',0,'granted',?) ON CONFLICT(id) DO UPDATE SET intent=excluded.intent")
  .run(learningSpendLedgerId(learningSpendMonth(at)), JSON.stringify({ input, output }));

it("shows nothing while the month is under the limit", () => {
  setCeiling(1000, 500); setSpend(999, 499);
  expect(learningPausedRow(database())).toBeNull();
});

it("shows the item with the real figures once either side meets the limit, and the sidebar number counts it once", () => {
  setCeiling(1000, 500); setSpend(400, 500);
  const row = learningPausedRow(database());
  expect(row).toMatchObject({ month: learningSpendMonth(), input: 1000, output: 500, inputUsed: 400, outputUsed: 500, learningRevision: readMemoryLearning(database()).revision });
  expect(withLearningPaused({ decisions: 2 }, row)).toMatchObject({ decisions: 3, learningPaused: { inputUsed: 400 } });
  expect(withLearningPaused({ decisions: 2 }, null)).toEqual({ decisions: 2 });
});

it("a limit of 0 is learning switched off, not a pause to double", () => {
  setCeiling(0, 0);
  expect(learningPausedRow(database())).toBeNull();
});

it("Double the limit and resume: the stored limit doubles, the item is gone on the next read", async () => {
  setCeiling(1000, 500); setSpend(1000, 10);
  const row = learningPausedRow(database())!;
  const status = await memoryOwnerRoute("/api/memory/action", { action: "configure", ceiling: { input: row.input * 2, output: row.output * 2 }, learningRevision: row.learningRevision }, ownerMemoryTicket(), roster) as unknown as { learning: { ceiling: Record<string, unknown> } };
  expect(status.learning.ceiling).toMatchObject({ input: 2000, output: 1000, inputUsed: 1000, paused: false });
  expect(readMemoryLearning(database()).ceiling).toEqual({ input: 2000, output: 1000 });
  expect(learningPausedRow(database())).toBeNull();
});

it("Leave paused sets the item aside for this month only", () => {
  setCeiling(1000, 500); setSpend(1000, 10);
  expect(leaveLearningPaused(database())).toBe(learningSpendMonth());
  expect(learningPausedRow(database())).toBeNull();
  // a different month's pause is a new question
  const next = new Date(); next.setMonth(next.getMonth() + 1, 15);
  setSpend(1000, 10, next.getTime());
  expect(learningPausedRow(database(), next.getTime())).not.toBeNull();
  // nothing to leave when learning is running
  setCeiling(5000, 5000);
  resetLeftLearningPaused();
  expect(leaveLearningPaused(database())).toBeNull();
});

it("resolves itself at the month rollover: the new month's ledger starts empty", () => {
  setCeiling(1000, 500); setSpend(1000, 500);
  expect(learningPausedRow(database())).not.toBeNull();
  const next = new Date(); next.setMonth(next.getMonth() + 1, 2);
  expect(learningPausedRow(database(), next.getTime())).toBeNull();
});

it("Leave paused survives a restart: the choice is read back from the data folder, and only for that month", () => {
  setCeiling(1000, 500); setSpend(1000, 10);
  expect(leaveLearningPaused(database())).toBe(learningSpendMonth());
  // a restart holds nothing in memory: the same call reads the stored choice
  expect(existsSync(join(DATA_DIR, "learning-paused-left.json"))).toBe(true);
  expect(learningPausedRow(database())).toBeNull();
  // the next month is a new question and clears itself
  const next = new Date(); next.setMonth(next.getMonth() + 1, 15);
  setSpend(1000, 10, next.getTime());
  expect(learningPausedRow(database(), next.getTime())).not.toBeNull();
});
