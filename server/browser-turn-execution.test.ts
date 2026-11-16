import { expect, it, vi } from "vitest";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { BrowserTurnExecution } from "./browser-turn-execution.ts";

function setup(computer = false) {
  const runs = new IndependentThreadRuns<object>();
  const execution = new BrowserTurnExecution(runs);
  const resources = ["browser:profile", "screen:bot:b"];
  const a = runs.admit("b", "a", {}, [...resources, "workspace:/a"]);
  execution.register(a, resources, computer ? [resources[0]] : resources);
  const b = runs.admit("b", "b", {});
  return { runs, execution, a, b, resources };
}
it("fences in-flight dispatch before releasing, rejects its stale result, and never releases its successor", () => {
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_snapshot");
  execution.waiting(a, "q", true);
  expect(call.authorized()).toBe(false);
  expect(runs.claim(b, resources)).toBe(false);
  call.finish(true);
  expect(runs.claim(b, resources)).toBe(true);
  call.finish(true);
  expect(runs.owns(b, resources[0])).toBe(true);
  expect(() => execution.begin(a, "tools/call", "agent_browser_snapshot")).toThrow(/answer/i);
});
it("keeps every question accounted for and requires a successful new snapshot after reacquiring", () => {
  const { runs, execution, a, b, resources } = setup();
  execution.waiting(a, "q1", true); execution.waiting(a, "q2", true);
  expect(runs.claim(b, resources)).toBe(true);
  execution.waiting(a, "q1", false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_snapshot")).toThrow(/answer/i);
  execution.waiting(a, "q2", false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_snapshot")).toThrow(/another conversation/i);
  runs.release(b);
  expect(() => execution.begin(a, "tools/call", "agent_browser_click")).toThrow(/snapshot/i);
  const failed = execution.begin(a, "tools/call", "agent_browser_snapshot"); failed.finish(false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_click")).toThrow(/snapshot/i);
  execution.begin(a, "tools/call", "agent_browser_snapshot").finish(true);
  const step = execution.begin(a, "tools/call", "agent_browser_click"); expect(step.authorized()).toBe(true); step.finish(true);
});
it("retains the screen for mounted computer work and retains the folder", () => {
  const { runs, execution, a, resources } = setup(true);
  execution.waiting(a, "q", true);
  expect(runs.heldBy(a)).toEqual([resources[1], "workspace:/a"]);
});
it.each(["cancel", "crash", "restart"])("%s cannot restore suspended authority or strand the browser", (end) => {
  const { runs, execution, a, b, resources } = setup();
  execution.waiting(a, "q", true);
  if (end === "cancel") runs.cancel(a);
  runs.release(a); execution.forget(a);
  expect(runs.claim(b, resources)).toBe(true);
  execution.waiting(a, "q", false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_snapshot")).toThrow();
  const successor = runs.admit("b", "a", {});
  execution.register(successor, resources, resources);
  execution.forget(a);
  runs.release(b);
  const current = execution.begin(successor, "tools/call", "agent_browser_snapshot");
  expect(current.authorized()).toBe(true); current.finish(true);
});
it("retains selection admission through a wait so a queued browser choice cannot commit", async () => {
  const { BrowserLifecycleGate } = await import("./browser-lifecycle-gate.ts");
  const lifecycle = new BrowserLifecycleGate();
  const { execution, a } = setup();
  await lifecycle.admitTurn("b", a.threadId, async () => true);
  execution.waiting(a, "q", true);
  // Selection admission remains owned by its existing lifecycle, not the execution reservation.
  expect(lifecycle.hasLease("b")).toBe(true);
  await lifecycle.releaseTurn(a.threadId);
  expect(lifecycle.hasLease("b")).toBe(false);
});

it("a passive screen preview cannot reacquire the suspended browser", () => {
  const { execution, runs, a, b, resources } = setup();
  execution.waiting(a, "q", true); execution.waiting(a, "q", false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_screenshot", true)).toThrow(/preview is paused/);
  expect(runs.claim(b, resources)).toBe(true);
});

it("parks only the extension call awaiting approval; other calls still drain before a sibling acquires", async () => {
  const { runs, execution, a, b, resources } = setup();
  const approving = execution.begin(a, "tools/call", "agent_browser_click");
  const active = execution.begin(a, "tools/call", "agent_browser_snapshot");
  const resume = approving.within(() => execution.approvalWaiting(a.threadId, "extension-card"))!;
  expect(approving.authorized()).toBe(false);
  expect(active.authorized()).toBe(false);
  expect(runs.claim(b, resources)).toBe(false);
  active.finish(true);
  expect(runs.claim(b, resources)).toBe(true);
  let resumed = false;
  const continuing = resume().then(() => { resumed = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(resumed).toBe(false);
  runs.release(b);
  await continuing;
  expect(approving.authorized()).toBe(true);
  expect(active.authorized()).toBe(false);
  approving.finish(true);
  expect(() => execution.begin(a, "tools/call", "agent_browser_click")).toThrow(/snapshot/i);
  execution.begin(a, "tools/call", "agent_browser_snapshot").finish(true);
});

it.each(["stop-before-answer", "stop-while-reacquiring"])("does not revive an extension approval after %s", async end => {
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_click");
  const resume = call.within(() => execution.approvalWaiting(a.threadId, "extension-card"))!;
  expect(runs.claim(b, resources)).toBe(true);
  const pending = end === "stop-while-reacquiring" ? resume() : undefined;
  runs.cancel(a); runs.release(a); execution.forget(a);
  await expect(pending ?? resume()).rejects.toThrow(/ended/i);
  call.finish(false);
  expect(call.authorized()).toBe(false);
  expect(runs.owns(b, resources[0])).toBe(true);
});

it("keeps a bootstrap navigation gated to the extension and leaves the fresh snapshot requirement in place", () => {
  const { execution, a } = setup();
  execution.waiting(a, "q", true); execution.waiting(a, "q", false);
  expect(() => execution.begin(a, "tools/call", "agent_browser_open")).toThrow(/snapshot/i);
  const navigation = execution.begin(a, "tools/call", "agent_browser_open", false, true);
  expect(navigation.bootstrapOnly).toBe(true);
  navigation.finish(true);
  expect(() => execution.begin(a, "tools/call", "agent_browser_click", false, true)).toThrow(/snapshot/i);
  execution.begin(a, "tools/call", "agent_browser_snapshot").finish(true);
  expect(execution.begin(a, "tools/call", "agent_browser_open", false, true).bootstrapOnly).toBe(false);
});


it("releases again when a timed-out approval continuation finishes unwinding", async () => {
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_click");
  expect(call.within(() => execution.approvalWaiting(b.threadId, "wrong-thread"))).toBeUndefined();
  const resume = call.within(() => execution.approvalWaiting(a.threadId, "extension-card"))!;
  expect(runs.claim(b, resources)).toBe(true);
  runs.releaseResources(b, resources);
  await resume(true);
  expect(call.authorized()).toBe(true);
  call.finish(false);
  expect(runs.claim(b, resources)).toBe(true);
});

it("bounds extension reacquisition without polling or a late ownership claim", async () => {
  vi.useFakeTimers();
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_click");
  const resume = call.within(() => execution.approvalWaiting(a.threadId, "card"))!;
  runs.claim(b, resources);
  const claim = vi.spyOn(runs, "claim");
  let outcome: unknown;
  const pending = resume(true).catch(error => { outcome = error; });
  try {
    await vi.advanceTimersByTimeAsync(5_001);
    expect(outcome).toMatchObject({ code: "browser_resume_timeout" });
    expect(claim).toHaveBeenCalledTimes(1);
    await pending;
    runs.release(b);
    expect(runs.owns(a, resources[0])).toBe(false);
    expect(call.authorized()).toBe(false);
  } finally { call.finish(false); runs.cancel(a); vi.useRealTimers(); }
});

it.each(["disconnect", "approval-abort", "cancel", "settling", "forget", "finish"])("immediately cancels extension reacquisition on %s", async end => {
  vi.useFakeTimers();
  const { runs, execution, a, b, resources } = setup();
  const controller = new AbortController();
  const approval = new AbortController();
  const call = execution.begin(a, "tools/call", "agent_browser_click", false, true, controller.signal);
  const resume = call.within(() => execution.approvalWaiting(a.threadId, "card"))!;
  runs.claim(b, resources);
  let outcome: unknown;
  const pending = resume(false, approval.signal).catch(error => { outcome = error; });
  try {
    if (end === "disconnect") controller.abort();
    if (end === "approval-abort") approval.abort();
    if (end === "cancel") runs.cancel(a);
    if (end === "settling") runs.settling(a);
    if (end === "forget") execution.forget(a);
    if (end === "finish") call.finish(false);
    // No timer advances: cancellation must notify the waiter directly.
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ code: "browser_not_authorized" });
    await pending;
    expect(runs.owns(b, resources[0])).toBe(true);
    runs.release(b);
    expect(runs.owns(a, resources[0])).toBe(false);
  } finally { call.finish(false); runs.cancel(a); vi.useRealTimers(); }
});
