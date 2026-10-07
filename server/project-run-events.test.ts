// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from "vitest";
import { createProjectRunMatcher, ProjectLateWrites } from "./project-run-events.ts";
const event = (type: string, turnId?: string) => ({ type, threadId: "desk", turnId });
it("ignores stale completion before start and binds only this dispatch generation", () => {
  const run = createProjectRunMatcher("desk");
  expect(run.observe(event("turn.completed", "previous"), "old", false)).toBe(false);
  run.dispatch("generation");
  expect(run.observe(event("turn.started", "previous"), "old", false)).toBe(false);
  expect(run.observe(event("turn.completed", "previous"), "generation", false)).toBe(false);
  expect(run.observe(event("turn.started", "current"), "generation", true)).toBe(false);
  expect(run.observe(event("turn.completed", "current"), "generation", false)).toBe(false);
  run.observe(event("turn.started", "current"), "generation", false);
  expect(run.observe(event("turn.completed", "previous"), "generation", false)).toBe(false);
  expect(run.observe(event("turn.completed"), "generation", false)).toBe(false);
  expect(run.observe(event("turn.completed", "current"), "generation", true)).toBe(false);
  expect(run.observe(event("turn.completed", "current"), "generation", false)).toBe(true);
});
it("acceptance binds engines without a start event and synchronous start/completion is matched", () => {
  const run = createProjectRunMatcher("desk"); run.dispatch("g"); run.accept("g", "turn");
  expect(run.observe(event("turn.completed", "turn"), undefined, false)).toBe(true);
  const synchronous = createProjectRunMatcher("desk"); synchronous.dispatch("g");
  synchronous.observe(event("turn.started", "turn"), "g", false);
  expect(synchronous.observe(event("turn.completed", "turn"), "g", false)).toBe(true);
});
it.each(["room", "desk"])("stale terminal keeps %s late claims and retry timers until their matching turn ends", threadId => {
  vi.useFakeTimers();
  try {
    const writes = new ProjectLateWrites(), release = vi.fn(), retry = vi.fn();
    const identity = { threadId, generation: "current-generation", turnId: "current" };
    writes.add(identity, release); writes.retry(identity, "ask", retry);
    writes.complete({ type: "turn.completed", threadId, turnId: "old" });
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250); expect(retry).toHaveBeenCalledTimes(1);
    writes.retry(identity, "ask", retry);
    // This provider turn has been retired: its output is ignored by the fold.
    writes.complete({ type: "turn.completed", threadId, turnId: "current" });
    expect(release).toHaveBeenCalledTimes(1);
    writes.complete({ type: "turn.completed", threadId, turnId: "current" });
    writes.complete({ type: "turn.completed", threadId, turnId: "current" });
    vi.advanceTimersByTime(250);
    expect(release).toHaveBeenCalledTimes(1); expect(retry).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("holds pre-start terminals until acceptance identifies the provider turn", () => {
  const run = createProjectRunMatcher("desk"); run.dispatch("g");
  const terminal = event("turn.completed", "accepted");
  expect(run.observe(event("turn.completed", "previous"), "g", false)).toBe(false);
  expect(run.observe(terminal, "g", false)).toBe(false);
  expect(run.observe(event("turn.completed", "previous"), "g", false)).toBe(false);
  expect(run.accept("other-generation", "accepted")).toBeUndefined();
  expect(run.accept("g", "accepted")).toBe(terminal);
});

it("bound card completion survives an earlier subscriber draining the queued owner turn", () => {
  const run = createProjectRunMatcher("desk"); run.dispatch("card-generation");
  run.observe(event("turn.started", "card-turn"), "card-generation", false);
  let generation = "card-generation";
  const queuedOwnerMessages = ["Owner follow-up"];
  const finish = vi.fn();
  const subscribers = [
    () => { if (queuedOwnerMessages.shift()) generation = "owner-generation"; },
    () => { if (run.observe(event("turn.completed", "card-turn"), generation, false)) finish(); },
  ];
  subscribers.forEach(subscriber => subscriber());
  expect(generation).toBe("owner-generation");
  expect(finish).toHaveBeenCalledTimes(1);
  expect(run.observe(event("turn.completed", "owner-turn"), generation, false)).toBe(false);
  expect(run.observe({ ...event("turn.completed", "card-turn"), threadId: "other" }, generation, false)).toBe(false);
});
