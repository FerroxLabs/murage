// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md.
import { describe, expect, it } from "vitest";
import { makeRuntime, replay } from "./checker.ts";
import { DOMAIN_ONE } from "./domain.ts";
import { keepSuccessIsConfirmed } from "./invariants.current.ts";
import type { Model, Move } from "./model.ts";
import { toWorld } from "./model.ts";
import { apply, enabled } from "./moves.ts";
import { newCoverage } from "./report.ts";
import { restoreReducer } from "./restore-reducer.ts";
import { SEEDS } from "./seeds.ts";

const runtime = () => makeRuntime(DOMAIN_ONE, restoreReducer, newCoverage());
const answer = (requestId: string): Move => ({ t: "net.answer", requestId, result: "ok", fluxStateSeen: "active" });
const prefix: Move[] = [
  { t: "flux.close", inboxId: "i1", reason: "billing" },
  { t: "owner.keep", principal: "owner_desktop", botId: "b1", target: "inbox:i1", tokenId: null, mode: "bot_section", outcome: { ok: true } },
];
const restoreDone: Move[] = [...prefix, { t: "flux.apply", requestId: "r1" }, answer("r1")];
const getDone: Move[] = [{ t: "flux.apply", requestId: "r2" }, answer("r2")];

function check(seed: Model, moves: Move[]) {
  const result = replay(seed, moves, runtime(), true);
  expect(result.steps.flatMap(s => {
    const v = keepSuccessIsConfirmed(s.prev, s.action, s.next);
    return v.ok ? [] : [v];
  })).toEqual([]);
  expect(result.model.env.ext.harnessViolations).toEqual([]);
  return result;
}

describe("causal S1: duplicate RESTORE ids", () => {
  it("retains the late-duplicate counterexample schedule, with identical reducer inputs and successful Keep", () => {
    const start = check(SEEDS.fresh(), restoreDone).model;
    const normal = check(start, [{ t: "flux.apply", requestId: "r2" }]).model;
    const copied = check(start, [{ t: "fault.duplicate", requestId: "r1" }, { t: "flux.apply", requestId: "r2" }]).model;
    expect(normal.home).toEqual(copied.home);
    expect(normal.env.ext.results.r2).toEqual(copied.env.ext.results.r2);
    for (const model of [normal, copied]) {
      const done = check(model, [answer("r2")]).model;
      expect(done.env.ghost.keeps[0].succeededAtStep).not.toBeNull();
    }
  });

  it("a copy arriving after a completed GET returns the stored outcome and never reopens a later closing", () => {
    let model = check(SEEDS.fresh(), [...restoreDone, ...getDone]).model;
    const stored = structuredClone(model.env.flux.restoreOutcomes);
    // A later independent closing makes an accidental second execution observable.
    model.env.flux.inboxes.i1 = { ...model.env.flux.inboxes.i1, state: "closing", closingSinceMs: model.env.nowMs, closingSinceStep: model.env.step, closingCause: { kind: "flux", reason: "support" } };
    const before = structuredClone(model.env.flux.inboxes);
    const done = check(model, [{ t: "fault.duplicate", requestId: "r1" }, { t: "flux.apply", requestId: "r1#dup1" }, answer("r1#dup1")]).model;
    expect(done.env.flux.inboxes).toEqual(before);
    expect(done.env.flux.restoreOutcomes).toEqual(stored);
    expect(done.env.ext.results["r1#dup1"]).toEqual(done.env.ext.results.r1);
    expect(done.env.flux.events.filter(e => e.type === "email.inbox.restored")).toHaveLength(1);
  });

  it.each(["r1", "r1#dup1", "r1#dup2"])("in-flight copies join whichever copy commits first (%s), including duplicate-of-duplicate", first => {
    const m = check(SEEDS.fresh(), [...prefix, { t: "fault.duplicate", requestId: "r1" }, { t: "fault.duplicate", requestId: "r1#dup1" }]).model;
    const order = [first, ...["r1", "r1#dup1", "r1#dup2"].filter(id => id !== first)];
    const done = check(m, order.map(requestId => ({ t: "flux.apply", requestId }))).model;
    expect(Object.keys(done.env.flux.restoreOutcomes!)).toEqual(["r1"]);
    expect(done.env.flux.restoreOutcomes!.r1.requestId).toBe(first);
    expect(done.env.ext.results.r1).toEqual(done.env.ext.results["r1#dup1"]);
    expect(done.env.ext.results.r1).toEqual(done.env.ext.results["r1#dup2"]);
    expect(done.env.flux.events.filter(e => e.type === "email.inbox.restored")).toHaveLength(1);
    const confirmed = check(done, [answer(first), ...getDone]).model;
    expect(confirmed.env.ghost.keeps[0].succeededAtStep).not.toBeNull();
  });

  it("the original response may be lost: a duplicate returns the original result and confirms the same op", () => {
    const done = check(SEEDS.fresh(), [...prefix, { t: "flux.apply", requestId: "r1" }, { t: "fault.loseAnswer", requestId: "r1" },
      { t: "fault.duplicate", requestId: "r1" }, { t: "flux.apply", requestId: "r1#dup1" }, answer("r1#dup1"), ...getDone]).model;
    expect(done.env.ghost.keeps[0].succeededAtStep).not.toBeNull();
    expect(done.env.ext.results["r1#dup1"]).toEqual({ answer: "ok", code: null, fluxStateSeen: "active" });
  });

  it("a duplicate may finish first; the still-held original joins after the confirming GET completes", () => {
    const done = check(SEEDS.fresh(), [...prefix, { t: "fault.duplicate", requestId: "r1" },
      { t: "flux.apply", requestId: "r1#dup1" }, answer("r1#dup1"), ...getDone,
      { t: "flux.apply", requestId: "r1" }, answer("r1")]).model;
    expect(done.env.ghost.keeps[0].succeededAtStep).not.toBeNull();
    expect(done.env.ext.results.r1).toEqual(done.env.ext.results["r1#dup1"]);
    expect(done.env.flux.events.filter(e => e.type === "email.inbox.restored")).toHaveLength(1);
    expect(done.env.flux.restoreOutcomes!.r1.requestId).toBe("r1#dup1");
  });

  it("a duplicated confirming GET credits the physical GET that actually delivered the active result", () => {
    const result = check(SEEDS.fresh(), [...restoreDone, { t: "fault.duplicate", requestId: "r2" },
      { t: "flux.apply", requestId: "r2#dup1" }, answer("r2#dup1")]);
    const k = result.model.env.ghost.keeps[0];
    expect(k.succeededAtStep).not.toBeNull();
    expect(k.confirmedBy?.requestId).toBe("r2#dup1");
    expect(result.model.env.flux.requests.find(r => r.requestId === "r2")!.answerSeen).toBeNull();
    expect(result.model.env.flux.requests.find(r => r.requestId === k.confirmedBy!.requestId)!.answerSeen).toMatchObject({ result: "ok", fluxStateSeen: "active" });
  });

  it("the seed-7 refusal is also stored; a late copy cannot execute after the confirming GET", () => {
    const seed = SEEDS.keepRetryAfterRefused();
    const done = check(seed, [{ t: "net.answer", requestId: "r1", result: "refused", fluxStateSeen: "active" }, ...getDone,
      { t: "fault.duplicate", requestId: "r1" }, { t: "flux.apply", requestId: "r1#dup1" },
      { t: "net.answer", requestId: "r1#dup1", result: "refused", fluxStateSeen: "active" }]).model;
    expect(done.env.ext.results["r1#dup1"]).toEqual(seed.env.ext.results.r1);
    expect(done.env.ghost.keeps[0].succeededAtStep).not.toBeNull();
  });

  it("still rejects a second physical execution or a changed duplicate answer", () => {
    const m = check(SEEDS.fresh(), [...restoreDone, ...getDone, { t: "fault.duplicate", requestId: "r1" }]).model;
    const rt = runtime(), move: Move = { t: "flux.apply", requestId: "r1#dup1" };
    expect(enabled(m, rt)).toContainEqual(move);
    const next = apply(m, move, rt).model;
    next.env.flux.inboxes.i1.state = "closing";
    expect(keepSuccessIsConfirmed(toWorld(m), move, toWorld(next))).toMatchObject({ ok: false, invariant: "keepSuccessIsConfirmed" });
    const applied = check(m, [move]).model;
    const answered = apply(applied, answer("r1#dup1"), rt).model;
    answered.env.flux.requests.find(r => r.requestId === "r1#dup1")!.answerSeen!.result = "refused";
    expect(keepSuccessIsConfirmed(toWorld(applied), answer("r1#dup1") as never, toWorld(answered))).toMatchObject({ ok: false, invariant: "keepSuccessIsConfirmed" });
  });

  it("still rejects a confirming GET racing a distinct, unanswered restore id", () => {
    const m = check(SEEDS.fresh(), [...restoreDone, { t: "flux.apply", requestId: "r2" }]).model;
    const original = m.env.flux.requests.find(r => r.requestId === "r1")!;
    m.env.flux.requests.push({ ...original, requestId: "new-restore", flux: "held", appliedAtMs: null, answer: "pending", answerSeen: null });
    const result = apply(m, answer("r2"), runtime());
    expect(result.steps.some(s => !keepSuccessIsConfirmed(s.prev, s.action, s.next).ok)).toBe(true);
  });
});
