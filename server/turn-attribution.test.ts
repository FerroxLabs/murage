// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BOTADDED-DESIGN-V3 r6 §5: a user row is stamped `dispatchedIn` with the accepted provider turn once the server's submission
// fence passed AND acceptance named the turn, in either order (N7b), keyed by the attempt so an older turn's late completion
// never touches a newer attempt (N7). The real server's wiring on three engines is in turn-attribution-engines.e2e.test.ts.
import { describe, expect, it } from "vitest";
import { createTurnAttribution } from "./turn-attribution.ts";

const harness = () => {
  const stamps: Array<[string, string, string]> = [];
  const attribution = createTurnAttribution({ stamp: (threadId, messageId, turnId) => { stamps.push([threadId, messageId, turnId]); } });
  return { attribution, stamps };
};

describe("turn attribution at the shared fence", () => {
  it("N7b: the fence before acceptance (Claude) stamps once, at acceptance", () => {
    const { attribution, stamps } = harness();
    attribution.begin("g1", "t", ["u1"]);
    attribution.fencePassed("g1");
    expect(stamps).toEqual([]);
    attribution.accepted("g1", "T1");
    attribution.fencePassed("g1"); // a relaunch passes the fence again
    expect(stamps).toEqual([["t", "u1", "T1"]]);
  });

  it("N7b: acceptance before the fence (ACP, Codex) stamps once, at the fence", () => {
    const { attribution, stamps } = harness();
    attribution.begin("g1", "t", ["u1", "u0"]);
    attribution.accepted("g1", "T1");
    expect(stamps).toEqual([]);
    attribution.fencePassed("g1");
    attribution.accepted("g1", "T-other"); // acceptance names the turn once
    expect(stamps).toEqual([["t", "u1", "T1"], ["t", "u0", "T1"]]);
  });

  it("N7b: a fence that refused (threw) never stamps, even when acceptance follows", () => {
    const { attribution, stamps } = harness();
    attribution.begin("g1", "t", ["u1"]);
    attribution.accepted("g1", "T1");
    attribution.ended("g1");
    attribution.fencePassed("g1");
    expect(stamps).toEqual([]);
  });

  it("N7b: a re-dispatch of the same rows is a new attempt and overwrites with its own turn", () => {
    const { attribution, stamps } = harness();
    attribution.begin("g1", "t", ["u1"]);
    attribution.fencePassed("g1"); attribution.accepted("g1", "T1");
    attribution.begin("g2", "t", ["u1"]);
    attribution.accepted("g2", "T2"); attribution.fencePassed("g2");
    expect(stamps).toEqual([["t", "u1", "T1"], ["t", "u1", "T2"]]);
  });

  it("N7: A fenced and accepted, Stop, attempt B, then A's late completion: B's entry is intact and B stamps B's turn", () => {
    const { attribution, stamps } = harness();
    attribution.begin("A", "t", ["u1"]);
    attribution.fencePassed("A"); attribution.accepted("A", "TA");
    attribution.begin("B", "t", ["u2"]);
    attribution.completed("TA");
    expect(attribution.attempt("A")).toBeUndefined();
    expect(attribution.attempt("B")).toBeDefined();
    attribution.fencePassed("B"); attribution.accepted("B", "TB");
    expect(stamps).toEqual([["t", "u1", "TA"], ["t", "u2", "TB"]]);
  });

  it("synthetic card rows are never stamped", () => {
    const { attribution, stamps } = harness();
    attribution.begin("g", "t", ["card-1", "u1"]);
    attribution.fencePassed("g"); attribution.accepted("g", "T");
    expect(stamps).toEqual([["t", "u1", "T"]]);
  });

  it("a steer holds its attempt by reference: the turn ending meanwhile or a newer attempt cannot change its turn", () => {
    const { attribution, stamps } = harness();
    attribution.begin("A", "t", ["u1"]);
    attribution.fencePassed("A"); attribution.accepted("A", "TA");
    const held = attribution.attempt("A")!;
    attribution.completed("TA");
    attribution.begin("B", "t", ["u2"]);
    attribution.fencePassed("B"); attribution.accepted("B", "TB");
    expect(held.turnId).toBe("TA");
    // a steer taken before acceptance is stamped when the attempt stamps
    attribution.begin("C", "t", ["u3"]);
    const early = attribution.attempt("C")!;
    attribution.addDelivered(early, "s1");
    attribution.fencePassed("C"); attribution.accepted("C", "TC");
    expect(stamps.filter(([, id]) => id === "s1")).toEqual([["t", "s1", "TC"]]);
    // and one taken after it is stamped at once
    attribution.addDelivered(early, "s2");
    expect(stamps.at(-1)).toEqual(["t", "s2", "TC"]);
  });

  it("entries are bounded: an attempt that never ends cannot grow the map forever", () => {
    const stamps: unknown[] = [];
    const attribution = createTurnAttribution({ stamp: () => { stamps.push(1); }, limit: 3 });
    for (let i = 0; i < 10; i++) attribution.begin(`g${i}`, "t", [`u${i}`]);
    expect(attribution.size()).toBe(3);
    expect(attribution.attempt("g0")).toBeUndefined();
    expect(attribution.attempt("g9")).toBeDefined();
  });

  it("a stamp that throws does not stop the others", () => {
    const seen: string[] = [];
    const attribution = createTurnAttribution({ stamp: (_t, id) => { if (id === "bad") throw new Error("gone"); seen.push(id); } });
    attribution.begin("g", "t", ["bad", "u1"]);
    attribution.fencePassed("g"); attribution.accepted("g", "T");
    expect(seen).toEqual(["u1"]);
  });
});
