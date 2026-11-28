import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { fixtureSubscriptionSource } from "./testing/runtime-source-fixture.ts";

// W3 direct (OPENCODE-QUIET-1023, Fable r2 M1): the whole real subscriber runs through its generic
// `else watchdog.touch(...)` with every collaborator stubbed, so removing the early return fails on the touch count.
it.each(["direct", "room"])("%s diagnostic does not enter the actual watchdog/capability subscriber", (threadId) => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const subscription = fixtureSubscriptionSource(source, "bus.subscribeExecution", "Observe acceptance BEFORE terminal capability cleanup");
  expect(subscription).toContain("} else watchdog.touch(event.threadId");
  const touch = vi.fn(), released = vi.fn(), observed = vi.fn(), side = vi.fn();
  const none = () => undefined;
  let subscriber!: (event: unknown) => void;
  runInNewContext(stripTypeScriptTypes(subscription), {
    bus: { subscribeExecution: (fn: typeof subscriber) => { subscriber = fn; } },
    watchdog: { touch, settleCompleted: released, firstResponse: none }, releaseBrowserCapabilityForThread: released,
    observeOwnerLimitProvider: observed,
    botOutsideWrites: { ledger: { by_ptid: new Map(), bind: side, gen_of: none, abnormal: side }, settle: side },
    internalCapabilities: { activeGeneration: none, dispatchingGeneration: none },
    isLifecycleEvent: (e: { type: string }) => !e.type.startsWith("item."), isLedgerEventRefused: () => false, terminalDispatchFor: none, shouldIgnoreProviderEvent: () => false,
    lateProjectWrites: { complete: side }, traceEngineEvent: side, notePromptSent: side,
    store: { botByThread: none, groupByThread: none }, terminalPreparations: new WeakMap(),
    memoryDispatches: new Map(), pendingRoomStops: new Map(), internalTurnOwners: new Map(), freshReplayConfirmations: new Map(),
    turnOutputRoots: new Map(), registry: new Map(), projectTurnLeases: { bind: side, complete: side, heldByStop: none, releaseStopHeld: side },
  });
  subscriber({ type: "turn.diagnostic", threadId, turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touch).toHaveBeenCalledTimes(0);
  expect(observed).not.toHaveBeenCalled(); expect(released).not.toHaveBeenCalled(); expect(side).not.toHaveBeenCalled();
  // The same stubs carry an ordinary event to the generic touch: the slice reaches it.
  subscriber({ type: "item.updated", threadId, turnId: "turn", itemType: "tool" });
  expect(touch).toHaveBeenCalledTimes(1);
});

it("the actual room subscriber leaves tool bookkeeping and liveness unchanged", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const subscription = fixtureSubscriptionSource(source, "bus.subscribeExecution", "openTools.started(e.itemId)");
  const touched = vi.fn();
  let subscriber!: (event: unknown) => void;
  const scope = {
    bus: { subscribeExecution: (fn: typeof subscriber) => { subscriber = fn; } }, unsub: undefined, ownerSend: false,
    shouldIgnoreProviderEvent: () => false, threadId: "room", providerTurnId: "turn",
    openTools: { started: touched, completed: touched }, watchdog: { touch: touched, setRunningLimit: touched },
    roomToolStarted: false, replyText: "", turnFailure: undefined,
    // Collaborators of the tool-start branch, so routing a diagnostic there fails on the assertions below.
    internalGeneration: "generation", roomTurnSilenceMs: () => 0, currentSilenceMinutes: () => 0, directAttemptProvider: () => {},
  };
  runInNewContext(stripTypeScriptTypes(subscription), scope);
  subscriber({ type: "turn.diagnostic", threadId: "room", turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touched).not.toHaveBeenCalled(); expect(scope.roomToolStarted).toBe(false);
  expect(scope.replyText).toBe(""); expect(scope.turnFailure).toBeUndefined();
});
