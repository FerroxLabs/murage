import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { fixtureSubscriptionSource } from "./testing/runtime-source-fixture.ts";

it.each(["direct", "room"])("%s diagnostic does not enter the actual watchdog/capability subscriber", (threadId) => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const subscription = fixtureSubscriptionSource(source, "bus.subscribeExecution", "Observe acceptance BEFORE terminal capability cleanup");
  const touch = vi.fn();
  let subscriber!: (event: unknown) => void;
  runInNewContext(stripTypeScriptTypes(subscription), {
    bus: { subscribeExecution: (fn: typeof subscriber) => { subscriber = fn; } },
    watchdog: { touch, settleCompleted: touch }, releaseBrowserCapabilityForThread: touch,
    // Accessing any other collaborator before returning is a test failure.
  });
  subscriber({ type: "turn.diagnostic", threadId, turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touch).not.toHaveBeenCalled();
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
  };
  runInNewContext(stripTypeScriptTypes(subscription), scope);
  subscriber({ type: "turn.diagnostic", threadId: "room", turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touched).not.toHaveBeenCalled(); expect(scope.roomToolStarted).toBe(false);
  expect(scope.replyText).toBe(""); expect(scope.turnFailure).toBeUndefined();
});
