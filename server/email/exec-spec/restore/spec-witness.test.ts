// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CI gate: the WITNESS PASS for the revised restore-park spec. Every spec witness (must-reject / must-accept) is run through the registered
// PredicateSet and through the spec's own runWitnesses(); every invariant must have both kinds; every Astra/Fable round-4 High must be
// tagged. Any mismatch fails with the witness id, the expectation and the actual verdict. Predicates and witnesses are never edited here.

import { describe, expect, it } from "vitest";
import { STATE_INVARIANTS, STEP_INVARIANTS, TRACE_INVARIANTS } from "./invariants.current.ts";
import { ACTIVE_PREDICATES, predicateNames } from "./predicates.ts";
import { runAll } from "./run.ts";
import { runSpecWitnesses, specMissing } from "./witnesses/specRun.ts";
import { runWitnesses, witnessCoverage } from "./witnesses/spec.ts";
import { BASE_PIN, BASE_WITNESSES, CM_GROUP_FILES, WITNESSES } from "./witnesses/witnesses-all.ts";

const fmt = (r: { id: string; invariant: string; expect?: string; why: string }): string => r.id + " [" + r.invariant + (r.expect ? " expected " + r.expect : "") + "]: actual " + r.why;

describe("restore-park spec: witness pass", () => {
  it("registers every spec invariant (39) in the active predicate set", () => {
    const want = [...Object.keys(STEP_INVARIANTS), ...Object.keys(STATE_INVARIANTS), ...Object.keys(TRACE_INVARIANTS)].sort();
    expect(want.length).toBe(39);
    expect(predicateNames(ACTIVE_PREDICATES).sort()).toEqual(want);
  });
  it("the spec's own runWitnesses() agrees with every witness (" + WITNESSES.length + ")", () => {
    expect(BASE_WITNESSES.length).toBe(BASE_PIN); // the base spec witnesses; a clause-mutant group never changes this
    for (const [g, f] of Object.entries(CM_GROUP_FILES)) expect([g, f.witnesses.length]).toEqual([g, f.pin]); // each group file pins itself (PIN in its own file)
    expect(WITNESSES.length).toBe(BASE_PIN + Object.values(CM_GROUP_FILES).reduce((n, f) => n + f.pin, 0));
    expect(new Set(WITNESSES.map(w => w.id)).size).toBe(WITNESSES.length);
    expect(runWitnesses(WITNESSES).filter(r => !r.ok).map(fmt)).toEqual([]);
  });
  it("the same witnesses pass through the harness PredicateSet", () => {
    expect(runSpecWitnesses(WITNESSES, ACTIVE_PREDICATES).filter(r => !r.ok).map(fmt)).toEqual([]);
  });
  it("witnessCoverage(): no invariant lacks a reject or an accept witness, every High has one", () => {
    expect(witnessCoverage(WITNESSES)).toEqual({ missing: [], highsMissing: [], r2EscapesMissing: [] });
    expect(specMissing(WITNESSES, ACTIVE_PREDICATES)).toEqual([]);
  });
  it("runAll runs the spec witnesses FIRST and aborts on a mismatch", () => {
    const out = runAll({ specWitnesses: WITNESSES, predicates: ACTIVE_PREDICATES, seeds: ["fresh"], check: { maxDepth: 1, walks: 1, walkDepth: 2 } });
    expect(out.text).toContain("predicates=restore-park spec r3.1");
  });
});
