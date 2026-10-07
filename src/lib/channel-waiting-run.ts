// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A channel's team-goal routine that is waiting on the person. Its approval
// card lives in the run's own task, so the channel itself only saw the
// member busy ("Thinking 4m") and nothing to answer (0.1.60 low). The
// channel now shows the run's card, with Review opening that task.
import type { Message } from "@/state/store";
import type { RoutineRun } from "./routines";

export function channelWaitingRun(runs: readonly RoutineRun[], group: { id: string; threadId: string }): RoutineRun | undefined {
  return runs.find((run) =>
    run.groupId === group.id &&
    (run.status === "waiting" || run.status === "needs-you") &&
    (run.executionThreadId ?? run.threadId) !== group.threadId);
}

export function waitingRunMessage(run: RoutineRun): Message {
  const executionThreadId = run.executionThreadId ?? run.threadId;
  return {
    id: `waiting-run-${run.id}`,
    role: "bot",
    kind: "routine.run",
    at: run.startedAt ?? run.scheduledFor,
    routineRun: {
      runId: run.id,
      routineId: run.routineId,
      routineName: run.routineName,
      status: run.status,
      ...(executionThreadId ? { executionThreadId } : {}),
      ...(run.attention ? { summary: run.attention } : {}),
    },
  } as Message;
}
