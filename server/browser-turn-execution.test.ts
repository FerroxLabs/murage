import { expect, it, vi } from "vitest";
import { IndependentThreadRuns } from "./independent-thread-runs.ts";
import { BrowserTurnExecution, turnGone } from "./browser-turn-execution.ts";

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

// ── BROWSERQ-1020 (customer-seen on 1.0.19: "1st in line for the browser profile ... About 252 min." after 1m33s) ──
// User failure: my turn sat first in line for the browser behind a turn that could no longer use it.
// MAIN ruling: the owner's Stop always frees the profile; otherwise only positive evidence that the holder is gone does; unknown keeps
// the holder and is asked again every 30 s. Each witness queues the sibling through the real scheduler wait, as a turn's setup does.
const STILL_WAITING = "still waiting";
function firstInLine(runs: IndependentThreadRuns<object>, b: Parameters<IndependentThreadRuns<object>["acquire"]>[0], resources: readonly string[]) {
  const places: number[] = [];
  let state: boolean | "yielded" | typeof STILL_WAITING = STILL_WAITING;
  void runs.acquire(b, resources, (_blockers, position) => places.push(position)).then(result => { state = result; });
  expect(places).toEqual([1]);
  // lets the grant's promise settle, and with fake timers moves no clock
  return async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); return state; };
}
it("BROWSERQ-1020 W1: a Stop the engine has not confirmed hands the browser to the turn first in line, and keeps the folder", async () => {
  const { runs, a, b, resources } = setup();
  const outcome = firstInLine(runs, b, resources);
  expect(await outcome()).toBe(STILL_WAITING);
  // Stop: the run is "stopping" and stays so until its engine child confirms its close (A2). Nothing releases it here.
  expect(runs.cancel(a)).toBe(true);
  expect(await outcome()).toBe(true);
  expect(resources.every(resource => runs.owns(b, resource))).toBe(true);
  expect(runs.get("a")?.phase).toBe("stopping");
  expect(runs.owns(a, "workspace:/a")).toBe(true);
});
it("BROWSERQ-1020 W2: a turn whose browser use was ended while it still runs keeps the profile (unknown), and Stop then frees it", async () => {
  const { runs, execution, a, b, resources } = setup();
  const outcome = firstInLine(runs, b, resources);
  // releaseBrowserCapabilityForThread on a run the reload retained: the entry goes, the run and its engine child are still there.
  execution.forgetThread("a", a.generation);
  expect(() => execution.begin(a, "tools/call", "agent_browser_snapshot")).toThrow(/ended/i);
  expect(await outcome()).toBe(STILL_WAITING);
  expect(runs.owns(a, resources[0])).toBe(true);
  runs.cancel(a);
  expect(await outcome()).toBe(true);
  expect(runs.owns(b, resources[0])).toBe(true);
  expect(runs.owns(a, "workspace:/a")).toBe(true);
});
it("BROWSERQ-1020 W3: a stopped turn's browser step still in flight keeps the profile until that step ends, then frees it", async () => {
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_snapshot");
  const outcome = firstInLine(runs, b, resources);
  runs.cancel(a);
  expect(call.authorized()).toBe(false);
  expect(await outcome()).toBe(STILL_WAITING);
  call.finish(false);
  expect(await outcome()).toBe(true);
  expect(runs.owns(b, resources[0])).toBe(true);
});
it("BROWSERQ-1020 W4: a finished turn whose engine close is unconfirmed keeps the profile while its engine still holds a child, is asked again every 30 s, and frees it once the engine says it holds none", async () => {
  vi.useFakeTimers();
  try {
    const { runs, execution, a, b, resources } = setup();
    runs.dispatch(a); runs.accepted(a, "provider-a");
    let tracked = true, asked = 0;
    execution.gone = owner => { asked++; return turnGone({ conversationExists: true, threadId: owner.threadId, providerTurnId: runs.get(owner.threadId)?.providerTurnId, adapter: { turnChildTracked: () => tracked } }); };
    const outcome = firstInLine(runs, b, resources);
    expect(runs.settling(a)).toBe(true);
    expect(await outcome()).toBe(STILL_WAITING);
    const before = asked;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBeGreaterThanOrEqual(before + 2);
    expect(await outcome()).toBe(STILL_WAITING);
    expect(runs.owns(a, resources[0])).toBe(true);
    tracked = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome()).toBe(true);
    expect(runs.get("a")?.phase).toBe("settling");
    expect(runs.owns(a, "workspace:/a")).toBe(true);
  } finally { vi.useRealTimers(); }
});
it("BROWSERQ-1020 W5: a superseded turn held for its rebuild keeps the profile while nothing is known, and frees it once its conversation is deleted", async () => {
  vi.useFakeTimers();
  try {
    const { runs, execution, a, b, resources } = setup();
    runs.dispatch(a); runs.accepted(a, "provider-a");
    const outcome = firstInLine(runs, b, resources);
    expect(runs.holdForRebuild(a)).toBe(true);
    // no evidence source at all: unknown
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await outcome()).toBe(STILL_WAITING);
    expect(runs.owns(a, resources[0])).toBe(true);
    execution.gone = owner => turnGone({ conversationExists: false, threadId: owner.threadId });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome()).toBe(true);
    expect(runs.rebuilding(a)).toBe(true);
    expect(runs.owns(a, "workspace:/a")).toBe(true);
  } finally { vi.useRealTimers(); }
});
it("BROWSERQ-1020 W6: a stopped turn whose browser use was already ended frees the profile when its last step ends", async () => {
  const { runs, execution, a, b, resources } = setup();
  const call = execution.begin(a, "tools/call", "agent_browser_snapshot");
  const outcome = firstInLine(runs, b, resources);
  execution.forgetThread("a");
  runs.cancel(a);
  expect(await outcome()).toBe(STILL_WAITING);
  call.finish(false);
  expect(await outcome()).toBe(true);
});
it("BROWSERQ-1020 W8: a stopped turn that also drives the computer gives back the profile and keeps its screen", async () => {
  const { runs, a, b, resources } = setup(true);
  const outcome = firstInLine(runs, b, [resources[0]]);
  runs.cancel(a);
  expect(await outcome()).toBe(true);
  expect(runs.owns(b, resources[0])).toBe(true);
  expect(runs.owns(a, resources[1])).toBe(true);
});
it("BROWSERQ-1020 W9: only positive evidence says a turn is gone; an engine that is missing, has no close watch or cannot say is unknown", () => {
  const base = { conversationExists: true, threadId: "a", providerTurnId: "t" };
  expect(turnGone({ ...base, conversationExists: false })).toBe(true);
  expect(turnGone({ ...base, adapter: { knowsTurnClose: () => false } })).toBe(true);
  expect(turnGone({ ...base, adapter: { turnChildTracked: () => false } })).toBe(true);
  expect(turnGone({ ...base, adapter: { knowsTurnClose: () => undefined, turnChildTracked: () => false } })).toBe(true);
  // unknown: the engine is no longer registered, or it has no close watch at all (the reviewer's HIGH)
  expect(turnGone(base)).toBe(false);
  expect(turnGone({ ...base, adapter: {} })).toBe(false);
  expect(turnGone({ ...base, adapter: { knowsTurnClose: () => undefined } })).toBe(false);
  expect(turnGone({ ...base, adapter: { knowsTurnClose: () => true, turnChildTracked: () => false } })).toBe(false);
  expect(turnGone({ ...base, adapter: { turnChildTracked: () => true } })).toBe(false);
  expect(turnGone({ conversationExists: true, threadId: "a", adapter: { knowsTurnClose: () => false } })).toBe(false);
});
it("BROWSERQ-1020 W10: a turn still running is never taken off the browser, whatever the evidence says, and neither is one whose probe throws", async () => {
  vi.useFakeTimers();
  try {
    const { runs, execution, a, b, resources } = setup();
    runs.dispatch(a); runs.accepted(a, "provider-a");
    execution.gone = () => true;
    const outcome = firstInLine(runs, b, resources);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome()).toBe(STILL_WAITING);
    execution.forgetThread("a");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome()).toBe(STILL_WAITING);
    expect(resources.every(resource => runs.owns(a, resource))).toBe(true);
    execution.gone = () => { throw new Error("no answer"); };
    runs.settling(a);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome()).toBe(STILL_WAITING);
  } finally { vi.useRealTimers(); }
});
