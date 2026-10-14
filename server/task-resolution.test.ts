// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 4 #4: one definition of "a task the server can still answer for". The pass at start, the hand-off replay and the status route
// ask the same function, so a ticket one of them keeps alive is a ticket the status route answers.
import { describe, expect, it } from "vitest";
import type { DelegationReceipt } from "./delegations.ts";
import type { RoomRequest } from "./room-requests.ts";
import { resolveTask, taskResolvable, taskStatusCode, type TaskResolutionDeps } from "./task-resolution.ts";

const me = { threadId: "ops-thread", botId: "ops" };
const receipt = (sourceThreadId: string): DelegationReceipt => ({ id: "t-receipt", sourceThreadId, toBotId: "kessler", toBotName: "Kessler", status: "done", finishedAt: 1 });
const shared = (over: Partial<RoomRequest>): RoomRequest => ({ id: "t-shared", state: "queued", fromBotId: "ops", toBotId: "kessler", refusal: null, dispatchedAt: null, ...over } as RoomRequest);
function deps(world: { receipt?: DelegationReceipt; pending?: { sourceThreadId: string }; watch?: { sourceThreadId: string }; request?: RoomRequest; sourceThread?: string }): TaskResolutionDeps {
  return {
    receipt: () => world.receipt ?? null,
    pending: () => (world.pending ? { sourceThreadId: world.pending.sourceThreadId, toBotId: "kessler", attempts: 0 } : null),
    watches: () => (world.watch ? [["peer-thread", { taskId: "t", toBotId: "kessler", sourceThreadId: world.watch.sourceThreadId }] as [string, { taskId: string; toBotId: string; sourceThreadId: string }]] : []),
    request: () => world.request ?? null,
    requestSourceThread: () => world.sourceThread ?? me.threadId,
    delivered: "delivered",
  };
}
const cases: Array<[string, Parameters<typeof deps>[0], string | null]> = [
  ["a finished receipt of this conversation", { receipt: receipt(me.threadId) }, "receipt"],
  ["a hand-off waiting in line", { pending: { sourceThreadId: me.threadId } }, "queued"],
  ["a delegated turn running", { watch: { sourceThreadId: me.threadId } }, "running"],
  ["a shared request waiting in line", { request: shared({ state: "queued" }) }, "shared"],
  ["a shared request running", { request: shared({ state: "running", dispatchedAt: 5 }) }, "shared"],
  ["a shared request waiting on the owner", { request: shared({ state: "waiting_owner" }) }, "shared"],
  ["a shared request finished and not yet delivered", { request: shared({ state: "done", refusal: null }) }, "shared"],
  ["a shared request finished and delivered (the receipt is the answer)", { request: shared({ state: "done", refusal: "delivered" }) }, null],
  ["a receipt of another conversation", { receipt: receipt("someone-else") }, "foreign"],
  ["a hand-off in line for another conversation", { pending: { sourceThreadId: "someone-else" } }, "foreign"],
  ["a shared request another bot made", { request: shared({ fromBotId: "other" }) }, "foreign"],
  ["a shared request from another conversation", { request: shared({}), sourceThread: "someone-else" }, "foreign"],
  ["nothing by that id", {}, null],
];

describe("one definition of a task the server can answer for", () => {
  it.each(cases)("%s", (_label, world, kind) => {
    const resolved = resolveTask("t", me, deps(world));
    expect(resolved?.kind ?? null).toBe(kind);
    // resolvable exactly when the status route answers 200
    expect(taskResolvable("t", deps(world), me)).toBe(taskStatusCode(resolved) === 200);
    expect(taskStatusCode(resolved)).toBe(kind === null ? 404 : kind === "foreign" ? 403 : 200);
  });

  it("at start-up nothing is foreign: only whether the task can be answered at all matters", () => {
    for (const [, world, kind] of cases) {
      const answerable = kind !== null;
      expect(taskResolvable("t", deps(world)), kind ?? "none").toBe(answerable);
    }
  });
});
