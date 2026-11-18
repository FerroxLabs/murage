// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for EQUIVALENT / COMBINED verdicts of group g4 (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, row, carry, keepHist, sysJob, pk, NOW, type Witness } from "./spec.ts";
import { RESTORE_FINISHING_LINE } from "../invariants.current.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"]) => SEPARATING.push({ id, invariant, trace, settled: false });
void row; void RESTORE_FINISHING_LINE;

// admissionPinned#3 (phase operand, line 2012): an owner.restore refused restore_finishing while the job is ARMED, with no line on the home row. Original: the job is not prepared/aborted, so the
// window rule at 2019-2023 accepts the pure refusal. Mutant: the finished-job branch also runs for the armed job and fails at 2016 (no line). keptKeysProtected 1420-1422 rejects it.
sep("admissionPinned", "sep-admissionPinned-3-armed-restore-refused-no-line",
  run(from(w => { w.fs.restoreJob = { id: "j9", archiveId: "A", source: "desktop", phase: "armed", at: 0 }; }),
    [[{ t: "owner.restore", source: "desktop", archiveId: "B", outcome: { ok: false, code: "restore_finishing" } } as never, () => {}]]));

// keptStaysKept#3 (`auto.swap` exemption, line 1680): a swap step that parks a kept target but writes NO restore record. Original: swap steps are exempt, accepts. Mutant: sees the park of a kept
// target with no later restore and rejects. restoreJobProtocol (2279 / 2300: a swap that does not add its job's restore record is not a legal swapped write) rejects the swap.
sep("keptStaysKept", "sep-keptStaysKept-3-swap-parks-kept-no-restore-record",
  run(from(w => { keepHist(w, { claimedAtStep: -2, succeededAtStep: 0, succeededAtMs: NOW, confirmedBy: { requestId: "g1", atStep: -1 } }); sysJob(w, "A", "desktop", "captured"); w.carry = carry({ jobId: "js" }); }),
    [[{ t: "auto.swap", source: "desktop", archiveId: "A", blind: false }, w => { w.fs.restoreJob!.phase = "swapped"; w.local.parks.pk1 = pk(); }]]));
