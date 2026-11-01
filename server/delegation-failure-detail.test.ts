// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Review round 7, R7-02 and F7: while a delegation runs, the bot that is waiting on it is told the latest steps of the worker's turn. A step that
// records a failure or a retry (its detail can be a provider's response, a file name, a key's name) is told as the kind of failure, one of five
// codes, and never as the worker's own words. The detail stays in the worker's conversation, where the owner reads it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryStore } from "./boundary-ports.ts";
import { configureBotEgress } from "./bot-egress.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeDatabase } from "./database.ts";
import { checkDelegationRoute, type CheckDelegationRouteContext } from "./handoff-boundary.ts";
import { closeMessageDb } from "./message-db.ts";
import { configureResultEgress, type ResultEgressDeps } from "./result-egress.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const PATH = "/private/OWNER-PLAN.txt";
let messageReads = 0;
beforeEach(() => { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); messageReads = 0; });
afterEach(() => { configureBotEgress(undefined); configureResultEgress(undefined); });

async function poll(rows: Array<{ kind: "text" | "activity"; text?: string; tool?: Record<string, unknown> }>, receipt?: (workerThreadId: string, askerThreadId: string, workerId: string) => Record<string, unknown>) {
  const store = new Store(selection);
  const asker = store.createBot({ name: "Asker" }, { seedMessages: false }), worker = store.createBot({ name: "Worker" }, { seedMessages: false });
  for (const row of rows) store.appendMessage(worker.threadId, { role: "bot", kind: row.kind, ...(row.text !== undefined ? { text: row.text } : {}), ...(row.tool ? { tool: row.tool as never } : {}) });
  const deps: ResultEgressDeps = {
    message: (threadId, id) => { messageReads += 1; return store.messageById(threadId, id); },
    authorize: () => ({ ok: true }), copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true,
  };
  configureResultEgress(deps);
  const sent: Array<{ status: number; body: any }> = [];
  configureBotEgress((_res, status, body) => { sent.push({ status, body }); });
  const context = {
    connectorThread: () => ({ bot: asker, group: undefined }),
    delegationMatch: ["", "task-1"] as unknown as RegExpMatchArray,
    internalClaim: { botId: asker.id, threadId: asker.threadId, generation: "g", depth: 0, kind: "handoff", skillAuthoring: false, expiresAt: Date.now() + 60_000 },
    requireActiveInternal: () => undefined,
    res: {} as never,
    resultEgressDeps: deps,
    store: boundaryStore(store),
    taskResolutionDeps: {
      receipt: () => receipt ? receipt(worker.threadId, asker.threadId, worker.id) as never : null, pending: () => null, request: () => null, requestSourceThread: () => null, delivered: "delivered",
      watches: () => [[worker.threadId, { sourceThreadId: asker.threadId, toBotId: worker.id, taskId: "task-1", startedAtMs: 0 }]] as never,
    },
    url: new URL(`http://127.0.0.1/api/internal/delegations/task-1?fromBotId=${asker.id}&fromThreadId=${asker.threadId}&wait_ms=0`),
  } as unknown as CheckDelegationRouteContext;
  await checkDelegationRoute(context);
  expect(sent).toHaveLength(1);
  return sent[0].body as { status: string; recentActivity: string[]; result?: string };
}

describe("a running delegation's recent activity", () => {
  it("a retry that carries a file name is told as the kind of failure, never with the name", async () => {
    const body = await poll([{ kind: "activity", tool: { name: `retrying: attempt 2/3 in 5s: provider 503 while reading ${PATH}`, ok: true } }]);
    expect(body.recentActivity).toEqual(["retrying after a failure: its provider had an error"]);
    expect(JSON.stringify(body)).not.toContain("OWNER-PLAN");
  });

  it("today's retry line is told as a retry too, in the same words", async () => {
    const body = await poll([{ kind: "activity", tool: { name: "The model is busy. Trying again (attempt 2 of 4).", ok: true } }]);
    expect(body.recentActivity).toEqual(["retrying after a failure: its provider had an error"]);
  });

  it("a runtime error is told as its code, whatever its message and details say", async () => {
    const body = await poll([{ kind: "activity", tool: { name: `error: 401 unauthorized for ${PATH}`, ok: false, errorDetails: `401 unauthorized for ${PATH} (key sk-live-123)` } }]);
    expect(body.recentActivity).toEqual(["error: it is not signed in to its provider"]);
    expect(JSON.stringify(body)).not.toMatch(/OWNER-PLAN|sk-live/);
  });

  it("a failed step is told as a failure even when its name says nothing of one", async () => {
    const body = await poll([{ kind: "activity", tool: { name: `Read ${PATH}`, ok: false } }]);
    expect(JSON.stringify(body)).not.toContain("OWNER-PLAN");
    expect(body.recentActivity).toHaveLength(1);
    expect(body.recentActivity[0]).toMatch(/^error: /);
  });

  it("ordinary steps and the worker's own lines are still told", async () => {
    const body = await poll([{ kind: "activity", tool: { name: "Bash ls", ok: true } }, { kind: "text", text: "Working on the report." }]);
    expect(body.recentActivity).toEqual(["tool: Bash ls", "text: Working on the report."]);
  });

  it("a long run costs five releases, not one per step it has taken", async () => {
    const rows = Array.from({ length: 300 }, (_, index) => ({ kind: "activity" as const, tool: { name: `Bash step ${index}`, ok: true } }));
    const body = await poll(rows);
    expect(body.recentActivity).toEqual([295, 296, 297, 298, 299].map(index => `tool: Bash step ${index}`));
    expect(messageReads).toBeLessThanOrEqual(10);
  });
});

describe("a finished receipt whose original is gone", () => {
  it("tells the bot that the result is no longer available, not an empty answer", async () => {
    const body = await poll([], (workerThreadId, askerThreadId, workerId) => ({
      id: "task-1", sourceThreadId: askerThreadId, toBotId: workerId, toBotName: "Worker", status: "done", result: "THE DELETED ANSWER", finishedAt: Date.now(),
      copyOf: { threadId: workerThreadId, messageIds: ["deleted-message"] }, lineage: true,
    }));
    expect(body.status).toBe("done");
    expect(body.result).toBe("(that result is no longer available)");
    expect(JSON.stringify(body)).not.toContain("DELETED ANSWER");
  });
});
