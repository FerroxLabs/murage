// Deterministic close-confirmation bookkeeping (A2). A bare EventEmitter
// stands in for ChildProcess: these cases prove the state machine, while the
// ACP/Pi fixture tests prove it against real child processes.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { ChildTeardown, PROVIDER_CLOSE_DEADLINE_MS, providerCloseDeadlineMs, TurnTeardowns } from "./child-teardown.ts";

const fakeChild = (pid: number | null = 4242) =>
  Object.assign(new EventEmitter(), { pid: pid ?? undefined }) as unknown as ChildProcess;
const budget = { closeMs: 40, maxMs: 400 };

describe("ChildTeardown", () => {
  it("treats a spawn that produced no process as already closed", async () => {
    const teardown = new ChildTeardown(fakeChild(null));
    expect(teardown.closed).toBe(true);
    await expect(teardown.wait(budget)).resolves.toEqual({ closeConfirmed: true });
  });

  it("does not confirm a stop request, only an observed close", async () => {
    const child = fakeChild();
    const teardown = new ChildTeardown(child);
    const waiting = teardown.wait({ closeMs: 1_000, maxMs: 2_000 });
    teardown.markStopRequested();
    let settled = false;
    void waiting.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    child.emit("close", null, "SIGTERM");
    await expect(waiting).resolves.toEqual({ closeConfirmed: true });
    expect(teardown.closed).toBe(true);
  });

  it("reports timeout once termination was requested, then observes a late close", async () => {
    const child = fakeChild();
    const teardown = new ChildTeardown(child);
    teardown.markStopRequested();
    await expect(teardown.wait(budget)).resolves.toEqual({ closeConfirmed: false, reason: "timeout" });
    expect(teardown.closed).toBe(false);
    const again = teardown.wait({ closeMs: 1_000, maxMs: 1_000 });
    child.emit("close", 0, null);
    await expect(again).resolves.toEqual({ closeConfirmed: true });
  });

  it("caps a wait whose termination is never requested", async () => {
    const teardown = new ChildTeardown(fakeChild());
    await expect(teardown.wait({ closeMs: 10, maxMs: 60 })).resolves.toEqual({ closeConfirmed: false, reason: "timeout" });
  });
});

describe("TurnTeardowns", () => {
  it("scopes waits to the exact turn and forgets a child once it closed", async () => {
    const teardowns = new TurnTeardowns();
    const old = fakeChild(1), current = fakeChild(2), other = fakeChild(3);
    teardowns.track("thread", "old-turn", old).markStopRequested();
    teardowns.track("thread", "new-turn", current);
    teardowns.track("other-thread", "other-turn", other);
    old.emit("close", 0, null);
    await expect(teardowns.wait("thread", "old-turn", budget)).resolves.toEqual({ closeConfirmed: true });
    expect(teardowns.pending("thread")).toBe(true);
    const whole = teardowns.wait("thread", undefined, { closeMs: 1_000, maxMs: 1_000 });
    current.emit("close", 0, null);
    await expect(whole).resolves.toEqual({ closeConfirmed: true });
    expect(teardowns.pending("thread")).toBe(false);
    expect(teardowns.pending("other-thread")).toBe(true);
  });

  it("is unconfirmed while any tracked child outlives the budget", async () => {
    const teardowns = new TurnTeardowns();
    const closing = fakeChild(1), stuck = fakeChild(2);
    teardowns.track("a", "one", closing).markStopRequested();
    teardowns.track("b", "two", stuck).markStopRequested();
    const all = teardowns.waitAll(budget);
    closing.emit("close", 0, null);
    await expect(all).resolves.toEqual({ closeConfirmed: false, reason: "timeout" });
    stuck.emit("close", null, "SIGKILL");
    await expect(teardowns.waitAll(budget)).resolves.toEqual({ closeConfirmed: true });
  });
});

it("reads the close deadline at call time and ignores unusable overrides", () => {
  expect(providerCloseDeadlineMs({})).toBe(PROVIDER_CLOSE_DEADLINE_MS);
  expect(providerCloseDeadlineMs({ MURAGE_PROVIDER_CLOSE_MS: "250" })).toBe(250);
  expect(providerCloseDeadlineMs({ MURAGE_PROVIDER_CLOSE_MS: "0" })).toBe(PROVIDER_CLOSE_DEADLINE_MS);
  expect(providerCloseDeadlineMs({ MURAGE_PROVIDER_CLOSE_MS: "soon" })).toBe(PROVIDER_CLOSE_DEADLINE_MS);
});
