// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for g5 EQUIVALENT / COMBINED verdicts (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, tk, au, gd, removeA, no, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"]) => SEPARATING.push({ id, invariant, trace, settled: false });

// guardDiesOnFreshRemove#3: a Remove authority created by a REFUSED owner.remove while the inbox guard stays. Original: invalid creation is skipped, accepts;
// mutant: checks the guard anyway, rejects. authorityCreatedByValidOwnerAction rejects the refused-action creation.
sep("guardDiesOnFreshRemove", "sep-guardDiesOnFreshRemove-3-refused-remove-keeps-guard",
  run(from(w => { w.ghost.tokens.push(tk()); w.local.keepGuards.i1 = gd(); }), [[removeA("tB", { outcome: no("refused") }), w => { w.ghost.authorities.push(au()); }]]));
