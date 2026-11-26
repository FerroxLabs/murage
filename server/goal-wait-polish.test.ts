// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";

// Execute the production wait and retry loop with a controlled store and slot
// owner. This makes the read-to-claim race repeatable without racing a provider.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const cut = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const code = ts.transpileModule(cut("async function waitForGroupGoalBot(", "function cancelGroupTurnOperations(") + cut("async function runGroupGoalStep(", "async function runGroupGoalOperation(") + cut("async function runGroupGoalOperation(", "type StartGroupTurnOptions ="), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None } }).outputText;
afterEach(() => vi.useRealTimers());

it("three lost slots share the first wait cap and release every listener", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const bot = { id: "lead", name: "Lead", busy: true };
  const listeners = new Set<(change: { type: string; botId: string }) => void>();
  let losses = 0;
  const deps = {
    GROUP_GOAL_WAIT_MAX_MS: 1000,
    store: { onChange: (listener: (change: { type: string; botId: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    groupGoalBotAvailability: () => bot.busy ? "busy" : "ready",
    updateGroupGoalRunProgress: () => {},
    runGroupMemberTurn: async (...args: unknown[]) => { losses++; bot.busy = true; (args.at(-1) as { result: { outcome: string } }).result.outcome = "busy"; return false; },
  };
  const run = new Function(...Object.keys(deps), code + "return runGroupGoalStep;")(...Object.values(deps));
  let outcome: { outcome: string } | undefined;
  const pending = run({ groupId: "room", threadId: "thread", bot, operation: { botIds: new Set(), goalRun: { turnCount: 0, maxTurns: 13 }, cancellation: new AbortController() }, coordinator: false }).then((value: { outcome: string }) => { outcome = value; });
  for (let n = 0; n < 3; n++) {
    await vi.advanceTimersByTimeAsync(250);
    bot.busy = false;
    for (const listener of [...listeners]) listener({ type: "bot", botId: bot.id });
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(losses).toBe(3);
  await vi.advanceTimersByTimeAsync(250);
  expect(outcome).toMatchObject({ ran: false, outcome: "busy" });
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await pending;
});

it("a provider attempt that ran past the wait cap can still take its one transient retry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  let calls = 0;
  const deps = {
    GROUP_GOAL_WAIT_MAX_MS: 1000,
    groupGoalBotAvailability: () => "ready",
    updateGroupGoalRunProgress: () => {},
    isFluxTerminal: () => false,
    runGroupMemberTurn: async (...args: unknown[]) => {
      calls++;
      const options = args.at(-1) as { onClaimed: () => void; result: { outcome: string; replyText?: string } };
      options.onClaimed();
      if (calls === 1) { await vi.advanceTimersByTimeAsync(2000); options.result.outcome = "dispatch_failed"; }
      else { options.result.outcome = "settled"; options.result.replyText = "Done"; }
      return true;
    },
  };
  const run = new Function(...Object.keys(deps), code + "return runGroupGoalStep;")(...Object.values(deps));
  const outcome = await run({ groupId: "room", threadId: "thread", bot: { id: "lead", name: "Lead" }, operation: { botIds: new Set(), goalRun: { turnCount: 0, maxTurns: 13 }, cancellation: new AbortController() }, coordinator: false });
  expect(outcome).toMatchObject({ ran: true, outcome: "settled", replyText: "Done" });
  expect(calls).toBe(2);
});

it("the goal records blocked at the first cap after the lead loses three slots", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const bot = { id: "lead", name: "Lead", busy: true };
  const listeners = new Set<(change: { type: string; botId: string }) => void>();
  let status: string | undefined, losses = 0;
  const deps = {
    GROUP_GOAL_WAIT_MAX_MS: 1000,
    store: { onChange: (listener: (change: { type: string; botId: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
    groupGoalBotAvailability: () => bot.busy ? "busy" : "ready",
    updateGroupGoalRunProgress: () => {}, inertBot: () => false,
    groupGoalCoordinatorInstructions: () => "", addGroupGoalCoordinatorTurn: () => {}, groupGoalCoordinatorTurns: new Map(),
    finishGroupGoalRun: (_group: string, _operation: unknown, value: string) => { status = value; },
    runGroupMemberTurn: async (...args: unknown[]) => { losses++; bot.busy = true; (args.at(-1) as { result: { outcome: string } }).result.outcome = "busy"; return false; },
  };
  const run = new Function(...Object.keys(deps), code + "return runGroupGoalOperation;")(...Object.values(deps));
  const pending = run({ groupId: "room", threadId: "thread", coordinator: bot, members: [bot], operation: { botIds: new Set(), goalRun: { turnCount: 0, maxTurns: 13 }, cancellation: new AbortController() } });
  for (let n = 0; n < 3; n++) {
    await vi.advanceTimersByTimeAsync(250); bot.busy = false;
    for (const listener of [...listeners]) listener({ type: "bot", botId: bot.id });
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(losses).toBe(3);
  await vi.advanceTimersByTimeAsync(250);
  expect(status).toBe("blocked");
  expect(listeners.size).toBe(0);
  await pending;
});
