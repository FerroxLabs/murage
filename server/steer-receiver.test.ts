// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §5 through the real steer path (Astra r5 order 3, M-r6-1): a steer is attributed to the attempt that RECEIVED
// it, captured at the write's fence and held by reference, never to the attempt current after the awaited acknowledgement, and the
// late confirmation (`steer.confirmed`, a late "delivered") stamps that same binding.
import { describe, expect, it } from "vitest";

import { steerWithQuoteLineage } from "./steer-lineage.ts";
import { createSteerReceiver, createTurnAttribution } from "./turn-attribution.ts";

function harness() {
  const stamps: Array<[string, string]> = [];
  const attribution = createTurnAttribution({ stamp: (_thread, id, turnId) => { stamps.push([id, turnId]); } });
  const run = (generation: string, turnId: string, row: string) => {
    attribution.begin(generation, "t", [row]);
    attribution.fencePassed(generation);
    attribution.accepted(generation, turnId);
  };
  return { attribution, stamps, run };
}

/** An engine that is not ready for the steer until `ready()`; then it runs the fence right before its write and takes the text. */
function lateEngine() {
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const adapter = {
    capabilities: { queueing: true },
    steer: async (_thread: string, _text: string, beforeWrite?: () => void) => { await gate; beforeWrite?.(); return true; },
  };
  return { adapter, ready };
}

describe("a steer is attributed to the attempt it was written into", () => {
  it("A receives the steer's wait, A completes and B starts before the engine is ready: the steer goes into B and is stamped with B's turn", async () => {
    const { attribution, stamps, run } = harness();
    run("gA", "TA", "u1");
    let current = "gA";
    const receiver = createSteerReceiver(() => attribution.attempt(current));
    const engine = lateEngine();
    const steering = steerWithQuoteLineage(engine.adapter, "t", "and use the side door", true, {
      holds: () => true, steerId: "s-1", lineage: undefined, onFence: receiver.atFence,
    });
    // A's turn completes while the steer waits, and the next attempt starts
    attribution.completed("TA");
    current = "gB";
    run("gB", "TB", "u2");
    engine.ready();
    expect(await steering).toBe("steer");
    const attempt = receiver.attempt();
    expect(attempt?.turnId).toBe("TB");
    attribution.addDelivered(attempt!, "steer-row");
    expect(stamps).toContainEqual(["steer-row", "TB"]);
    expect(stamps).not.toContainEqual(["steer-row", "TA"]);
  });

  it("the turn ends while the acknowledgement is awaited: the held attempt still names the turn the words reached", async () => {
    const { attribution, stamps, run } = harness();
    run("gA", "TA", "u1");
    const receiver = createSteerReceiver(() => attribution.attempt("gA"));
    const steering = steerWithQuoteLineage(
      { capabilities: { queueing: true }, steer: async (_t: string, _x: string, beforeWrite?: () => void) => { beforeWrite?.(); await Promise.resolve(); attribution.completed("TA"); return true; } },
      "t", "words", true, { holds: () => true, lineage: undefined, onFence: receiver.atFence },
    );
    expect(await steering).toBe("steer");
    expect(attribution.attempt("gA")).toBeUndefined(); // A's entry is gone ...
    attribution.addDelivered(receiver.attempt()!, "steer-row"); // ... the held attempt is not
    expect(stamps).toContainEqual(["steer-row", "TA"]);
  });

  it("a steer whose fence never passed (the wait elapsed, a check refused) has no receiving attempt", async () => {
    const { attribution, run } = harness();
    run("gA", "TA", "u1");
    const receiver = createSteerReceiver(() => attribution.attempt("gA"));
    const delivery = await steerWithQuoteLineage(
      { capabilities: { queueing: true }, steer: async () => false }, "t", "words", true,
      { holds: () => false, lineage: undefined, onFence: receiver.atFence },
    );
    expect(delivery).toBe("queue");
    expect(receiver.attempt()).toBeUndefined();
  });

  it("steer.confirmed and a late delivered stamp the receiving attempt, whether its turn is known yet or not, after it ended or not", () => {
    const { attribution, stamps, run } = harness();
    run("gA", "TA", "u1");
    const held = attribution.attempt("gA");
    attribution.completed("TA");
    attribution.begin("gB", "t", ["u2"]); // the next attempt is current now
    // the engine confirms late: the turn is A's, from the held binding
    expect(attribution.confirmed(held, "s-late")).toBe("TA");
    // a steer taken before acceptance named its turn: the row joins the attempt and is stamped when acceptance names it
    const early = attribution.attempt("gB");
    expect(attribution.confirmed(early, "s-early")).toBeUndefined();
    attribution.fencePassed("gB");
    attribution.accepted("gB", "TB");
    expect(stamps).toContainEqual(["s-early", "TB"]);
    expect(attribution.confirmed(undefined, "s-none")).toBeUndefined();
  });
});
