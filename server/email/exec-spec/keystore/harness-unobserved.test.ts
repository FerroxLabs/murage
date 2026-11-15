// Harness test: a key Flux revokes while it sits in the home's SAVE PIPELINE (rotate-in-flight: 201 for k2 delivered, save queued and
// renamed, owner deletes k2, supervisor crashes so disk = k2) is marked `unobserved`, so the spec's I1 exemption applies.
import { describe, expect, it } from "vitest";
import { CI_DOMAIN } from "./domain.ts";
import { KEYSTORE_REGISTRY } from "./keystore-witnesses.ts";
import { reduce } from "./reducer.ts";
import { seedRotateInFlight } from "./seeds.ts";
import { runCheck } from "./checker.ts";
import { KEYSTORE_WITNESSES } from "./keystore-witnesses.ts";
import { step } from "./world.ts";
import type { Home, HomeEvent } from "./types.ts";
import type { Move } from "./types.ts";

describe("harness: unobserved death of a key in the save pipeline", () => {
  it("dead-on-arrival-durable-unobserved (regression row; rotate-in-flight I1 trace): unobserved is set at the revoke and I1 holds at every step", () => {
    const d = CI_DOMAIN;
    const i1 = KEYSTORE_REGISTRY.find((i) => i.name === "I1_durableHonouredOrRepair")!;
    expect(i1.kind).toBe("step");
    const moves: Move[] = [
      { k: "deliver", reqId: 1, idx: 0, dup: false }, { k: "exec", home: "h1" }, { k: "supStep", home: "h1" }, { k: "supStep", home: "h1" },
      { k: "ownerFluxDelete", key: "b1:k2" }, { k: "crash", home: "h1", mode: "supervisor" },
    ];
    let w = seedRotateInFlight(d).world;
    for (const [i, m] of moves.entries()) {
      const r = step(w, m, reduce, d);
      expect(r.error).toBeUndefined();
      const ok = i1.kind === "step" && i1.check(w, r.action, r.world) && r.commits.every((c) => i1.kind === "step" && i1.check(w, c, r.world));
      expect(ok, `I1 at step ${i + 1} ${JSON.stringify(m)}`).toBe(true);
      if (m.k === "ownerFluxDelete") expect(r.world.pipeDead).toEqual({ h1: { b1: "b1:k2" } });
      if (m.k === "crash") expect(r.world.unobserved).toEqual({ h1: { b1: "b1:k2" } });
      w = r.world;
    }
    expect(w.homes.h1.durable.disk.bots.b1).toBe("b1:k2");
    expect(w.flux.keys["b1:k2"].status).toBe("revoked");
  });

  // MurageMain guard: the harness change must not blind I1. Reducer mutant `loses-honoured-durable-key`: on a drive the reducer
  // overwrites the durable key of a bot with one Flux never honoured, with NO revoke involved. I1 must still fail.
  it("reducer mutant loses-honoured-durable-key is KILLED by I1 (checker not blinded)", () => {
    const mutant = Object.assign((h: Home, ev: HomeEvent) => {
      const r = reduce(h, ev);
      if (ev.t === "drive" && r.state.durable.disk.bots[ev.bot] !== undefined) r.state.durable.disk.bots[ev.bot] = "b1:ghost";
      return r;
    }, { keyRepair: reduce.keyRepair });
    const r = runCheck({ domain: { ...CI_DOMAIN, depth: 4 }, reducer: mutant, invariants: KEYSTORE_REGISTRY, witnesses: KEYSTORE_WITNESSES, maxCounterexamples: 5 });
    console.log(`MUTANT loses-honoured-durable-key: violations=${r.violations.map((v) => v.invariant).join(",")}`);
    expect(r.violations.map((v) => v.invariant)).toContain("I1_durableHonouredOrRepair");
  });
});
