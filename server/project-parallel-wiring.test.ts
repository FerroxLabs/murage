// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { automationForTurn, automationRunForTurn } from "./message-automation.ts";
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
it("a 429 retry reuses exactly one persisted user prompt for its request", () => {
  // Execute the actual startTurn selection and append block with a tiny store.
  const start = source.indexOf("  let userMessage = opts?.userMessage");
  const end = source.indexOf("  if (opts?.projectCardRun) {", start);
  // Lane D: the block also stamps the automation origin, so its helpers are passed in too.
  const append = (...args: unknown[]) => new Function("opts", "store", "threadId", "text", "turnImages", "routineRunPrompt", "randomUUID", "automationForTurn", "automationRunForTurn", "routines", ts.transpileModule(source.slice(start, end) + "return userMessage;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...args, automationForTurn, automationRunForTurn, undefined);
  const messages: any[] = [];
  const store = { messagesFor: () => messages, appendMessage: (_thread: string, m: any) => { const row = { ...m, id: `m${messages.length}` }; messages.push(row); return row; } };
  const opts = { projectCardRun: { request: { id: "request" } } };
  const first = append(opts, store, "desk", "Work on card 1", { promote: () => [] }, undefined, () => "uuid");
  const retry = append(opts, store, "desk", "Work on card 1", { promote: () => [] }, undefined, () => "uuid");
  expect(messages.filter(m => m.role === "user" && m.requestId === "request")).toHaveLength(1);
  expect(retry.id).toBe(first.id);
  expect(first.automation).toEqual({ kind: "card" });
});

it("project route interrupt fences request identity and forwards the active generation", async () => {
  const begin = source.indexOf("async function interruptProjectTarget(");
  const end = source.indexOf("async function interruptDirectThread(", begin);
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const direct = new Map([["desk", { botId: "a", generation: "current" }]]);
  const bindings = new Map([["current", "request-b"], ["old", "request-a"]]);
  const interrupt = vi.fn(), prepareBackoffCancellation = vi.fn();
  let state = "running";
  const apply = new Function("directRuns", "internalTurnOwners", "turnRequestByGeneration", "projectCardExecutor", "interruptDirectThread", "roomRequest", "database", code + "return interruptProjectTarget;")(direct, new Map(), bindings, { prepareBackoffCancellation }, interrupt,
    () => ({ state, toBotId: "a", targetThreadId: "desk" }), () => ({}));
  const target = { id: "card-a", assigneeBotId: "a", deskThreadId: "desk", requestId: "request-a" };
  await apply(target); expect(interrupt).not.toHaveBeenCalled();
  state = "queued"; await apply({ ...target, backoff: true }); expect(prepareBackoffCancellation).toHaveBeenCalledWith("request-a"); expect(interrupt).not.toHaveBeenCalled();
  state = "running"; bindings.set("current", "request-a"); await apply(target);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith("a", "desk", "current");
});
it.each([true, false])("direct Stop fences the project request before revoking dispatch ownership (binding present: %s)", bound => {
  const begin = source.indexOf("function cancelDirectTurnDispatch(");
  const end = source.indexOf("\n/**", begin);
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const requestStop = vi.fn(); const bindings = new Map(bound ? [["generation", "request"]] : []);
  const stop = new Function("directRuns", "internalTurnOwners", "turnRequestByGeneration", "projectCardExecutor", "revokeInternalThread", "directTurnDispatchClaims", "recordMemorySettlement", "markCancelledProviderHandshake", "workAdmission", code + "return cancelDirectTurnDispatch;")(
    { get: () => ({ botId: "a", generation: "generation" }), cancel: vi.fn() }, new Map([["desk", { botId: "a", generation: "generation" }]]), bindings, { requestStop },
    () => { expect(requestStop).toHaveBeenCalledWith("request", undefined); bindings.clear(); }, new Map(), vi.fn(), vi.fn(), { liveTurns: () => [{ botId: "a", threadId: "desk", requestId: "request" }] });
  // the owner's own Stop carries no server note: the card says "Stopped by you"
  stop("a", "desk"); expect(requestStop).toHaveBeenCalledExactlyOnceWith("request", undefined);
});

it("a reserved backoff slot contributes no live work to the budget", () => {
  const begin = source.indexOf("  running:()=>{", source.indexOf("const projectBudgetGate ="));
  const end = source.indexOf("\n  line:", begin);
  const code = ts.transpileModule(`const opts={${source.slice(begin,end)}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const deps = { workAdmission: { liveTurns: () => [{ requestId: "retry", groupId: "g", botId: "a", threadId: "desk", startedAt: Date.now() - 5000 }] }, projectUsageTurns: new Map(), projectUsagePending: new Map(), internalTurnOwners: new Map(), turnRequestByGeneration: new Map(), database: () => ({}), roomRequest: () => ({ id: "retry", state: "queued", dispatchedAt: 100, ownerWaitMs: 0, waitingSince: null }) };
  expect(new Function(...Object.keys(deps), code + "return opts.running();")(...Object.values(deps))).toEqual([]);
});
it("an interrupt never crosses a generation replacement during browser cleanup", async () => {
  const begin = source.indexOf("async function interruptDirectThread(");
  const end = source.indexOf("\n/**", begin);
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let generation = "first"; const interruptTurn = vi.fn();
  const deps = { directRuns: { get: () => ({ generation }) }, internalTurnOwners: new Map(), botForDirectThread: () => ({ modelSelection: { instanceId: "fake" } }),
    cancelDirectTurnDispatch: () => ({ phase: "dispatching" }), releaseBrowserCapabilityForThread: async () => { generation = "replacement"; },
    registry: { get: () => ({ adapter: { interruptTurn } }) }, closeOpenApprovals: vi.fn(), stopCloseConfirmed: () => true };
  const interrupt = new Function(...Object.keys(deps), code + "return interruptDirectThread;")(...Object.values(deps));
  await interrupt("a", "desk", "first"); expect(interruptTurn).not.toHaveBeenCalled();
});

it("a stale backoff target interrupts its matching live generation", async () => {
  const begin = source.indexOf("async function interruptProjectTarget("), end = source.indexOf("async function interruptDirectThread(", begin);
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const interrupt = vi.fn();
  const deps = { directRuns: new Map([["desk", { botId: "a", generation: "retry" }]]), internalTurnOwners: new Map(),
    turnRequestByGeneration: new Map([["retry", "request"]]), projectCardExecutor: { prepareBackoffCancellation: vi.fn() },
    interruptDirectThread: interrupt, database: () => ({}), roomRequest: () => ({ state: "running", toBotId: "a", targetThreadId: "desk" }) };
  const apply = new Function(...Object.keys(deps), code + "return interruptProjectTarget;")(...Object.values(deps));
  await apply({ id: "card", requestId: "request", backoff: true, assigneeBotId: "a", deskThreadId: "desk" });
  expect(interrupt).toHaveBeenCalledExactlyOnceWith("a", "desk", "retry");
});
