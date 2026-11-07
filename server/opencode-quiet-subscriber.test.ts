import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it.each(["direct", "room"])("%s diagnostic does not enter the actual watchdog/capability subscriber", (threadId) => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const comment = source.indexOf("// Observe acceptance BEFORE terminal capability cleanup.");
  const start = source.lastIndexOf("bus.subscribe(", comment);
  const end = source.indexOf("\npresentedRequests.subscribe", start);
  const touch = vi.fn();
  let subscriber!: (event: unknown) => void;
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), {
    bus: { subscribe: (fn: typeof subscriber) => { subscriber = fn; } },
    watchdog: { touch, settleCompleted: touch }, releaseBrowserCapabilityForThread: touch,
    // Accessing any other collaborator before returning is a test failure.
  });
  subscriber({ type: "turn.diagnostic", threadId, turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touch).not.toHaveBeenCalled();
});

it("the actual room subscriber leaves tool bookkeeping and liveness unchanged", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("unsub = bus.subscribe((e: RuntimeEvent) => {", source.indexOf("let unregisterStall = () => {}"));
  const end = source.indexOf("\n    unregisterSetupStall();", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const touched = vi.fn();
  let subscriber!: (event: unknown) => void;
  const scope = {
    bus: { subscribe: (fn: typeof subscriber) => { subscriber = fn; } }, unsub: undefined,
    shouldIgnoreProviderEvent: () => false, threadId: "room", providerTurnId: "turn",
    openTools: { started: touched, completed: touched }, watchdog: { touch: touched, setRunningLimit: touched },
    roomToolStarted: false, replyText: "", turnFailure: undefined,
  };
  runInNewContext(stripTypeScriptTypes(source.slice(start, end)), scope);
  subscriber({ type: "turn.diagnostic", threadId: "room", turnId: "turn", category: "rate_limit", quietMs: 60000 });
  expect(touched).not.toHaveBeenCalled(); expect(scope.roomToolStarted).toBe(false);
  expect(scope.replyText).toBe(""); expect(scope.turnFailure).toBeUndefined();
});
