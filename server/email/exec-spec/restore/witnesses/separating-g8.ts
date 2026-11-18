// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for EQUIVALENT / COMBINED verdicts (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not must-accept or must-reject, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, carriedRemoval, swappedStart, crashAt, bootW, sysPrep, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"]) => SEPARATING.push({ id, invariant, trace, settled: false });

// RPPE#2: a boot prep that THREW with a carried removal left unparked. Original: only an ok boot prep owes the duties, so RPPE accepts; mutant: owes them, rejects.
// restorePrepNeverThrows rejects the threw boot prep.
sep("restorePrepParksEverything", "sep-restorePrepParksEverything-2-threw-boot-prep",
  run(from(w => { Object.assign(w, carriedRemoval()); swappedStart(w); }), [crashAt("W28_job_prepared", "before"), bootW, [{ t: "auto.bootPrep", outcome: "threw" }, () => {}]]));

// RPPE#7: a restore prep whose pending epoch has a carry stamped for ANOTHER job. Original: carry duties do not bind (carryOfJob false), RPPE accepts; mutant: owes them, rejects.
// restoreJobMatchesReality rejects a carry that belongs to another job.
sep("restorePrepParksEverything", "sep-restorePrepParksEverything-7-carry-of-other-job",
  run(from(w => { Object.assign(w, carriedRemoval()); swappedStart(w); w.carry!.jobId = "other"; }), [[{ t: "auto.restorePrepare", outcome: "committed" }, w => { sysPrep(w); }]]));
