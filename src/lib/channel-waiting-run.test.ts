// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.60 low (Windows RE-TEST 4 L5): while a channel's team-goal routine
// waited on an approval, the channel said "Ember is working… Thinking 4m"
// and showed no card; the card was only in the routine's task and Inbox.
import { describe, expect, it } from "vitest";
import { channelWaitingRun, waitingRunMessage } from "./channel-waiting-run";
import type { RoutineRun } from "./routines";

const run = (extra: Partial<RoutineRun>): RoutineRun => ({
  id: "r1", routineId: "rt", routineName: "Weekly goal", target: "room", botId: "ember", groupId: "g1",
  runOn: "local", scheduledFor: 1, status: "running", manual: false, createdAt: 1, ...extra,
} as RoutineRun);

describe("a channel's routine that is waiting on you", () => {
  it("is found for its own channel while it waits, and not otherwise", () => {
    const waiting = run({ status: "waiting", attention: "Allow npm install?", executionThreadId: "task-1" });
    expect(channelWaitingRun([waiting], { id: "g1", threadId: "main" })?.id).toBe("r1");
    expect(channelWaitingRun([run({ status: "needs-you", executionThreadId: "task-1" })], { id: "g1", threadId: "main" })?.id).toBe("r1");
    expect(channelWaitingRun([run({ status: "running" })], { id: "g1", threadId: "main" })).toBeUndefined();
    expect(channelWaitingRun([waiting], { id: "g2", threadId: "main" })).toBeUndefined();
    // already looking at the run's own task, where the card itself is
    expect(channelWaitingRun([waiting], { id: "g1", threadId: "task-1" })).toBeUndefined();
  });

  it("becomes a routine card with the question and the task to open", () => {
    const message = waitingRunMessage(run({ status: "waiting", attention: "Allow npm install?", executionThreadId: "task-1" }));
    expect(message.kind).toBe("routine.run");
    expect(message.routineRun).toMatchObject({ runId: "r1", routineName: "Weekly goal", status: "waiting", executionThreadId: "task-1", summary: "Allow npm install?" });
  });
});
