// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for EQUIVALENT / COMBINED verdicts of group g3 (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, carry, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"]) => SEPARATING.push({ id, invariant, trace, settled: false });
const armed = (w: import("../invariants.current.ts").World) => { w.fs.restoreJob = { id: "j9", archiveId: "A", source: "desktop", phase: "armed", at: 0 }; };

// carryImmutable#3 (`next.carry`, line 2324): an armed job's capture step that DELETES the carry. Original: next.carry is null, nothing to judge, accepts. Mutant: !same(prev, null) holds,
// the armed-capture branch reads next.carry.jobId and throws (counts as rejecting). outgoingCapturedBeforeSwap (carry deleted before its prep committed) rejects the deletion.
sep("carryImmutable", "sep-carryImmutable-3-capture-deletes-carry",
  run(from(w => { armed(w); w.carry = carry({ jobId: "j9" }); }), [[{ t: "auto.captureOutgoing" }, w => { w.carry = null; }]]));

// carryImmutable#4 (`!same(prev.carry, next.carry)`, line 2324): an armed job's capture step that leaves a carry of ANOTHER job untouched. Original: the carry did not change, accepts.
// Mutant: judges the unchanged carry's provenance and rejects it. restoreJobMatchesReality (carry belongs to another job) rejects the state.
sep("carryImmutable", "sep-carryImmutable-4-capture-leaves-other-jobs-carry",
  run(from(w => { armed(w); w.carry = carry({ jobId: "other" }); }), [[{ t: "auto.captureOutgoing" }, () => {}]]));
