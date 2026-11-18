// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for COMBINED verdicts of group g1 (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, base, rq, pk, carry, send, apply, T_I1, orphanRow, swappedStart, prep, sysPrep, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"]) => SEPARATING.push({ id, invariant, trace, settled: false });

// environmentWellFormed#62: Flux applies a request no home sent. Original: r is undefined, the DELETE branch is skipped, accepts; mutant: r.kind throws.
// ownerAuthorityForEveryDestructiveSend (line 1291) rejects an apply of an unsent request.
sep("environmentWellFormed", "sep-environmentWellFormed-62-apply-unsent-request", run(base(), [[apply("nope")]]));

// noRemoveDuringKeep#7: a DELETE sent under an authority id that names no authority. Original: a is undefined, accepts; mutant: a.kind throws.
// ownerAuthorityForEveryDestructiveSend (line 1296) rejects a destructive send with no authority.
sep("noRemoveDuringKeep", "sep-noRemoveDuringKeep-7-delete-without-authority", run(base(), [[send(rq({ requestId: "d1", kind: "DELETE_INBOX", target: "i1", authorityId: "nope", answer: "pending" }))]]));

// keyTargetEntriesNeverDropped#2: a restore prep drops the pending key target of an archived park (key live at Flux, unreferenced). Original: the prep is exempt, accepts; mutant: rejects.
// restorePrepParksEverything (line 1757) rejects a prep that loses a key.
sep("keyTargetEntriesNeverDropped", "sep-keyTargetEntriesNeverDropped-2-prep-drops-live-target", run(from(w => { swappedStart(w); w.carry = carry({ jobId: "js", removals: [{ target: T_I1, botId: "b1", inboxId: "i1", provisionOpId: "op1", evidence: false }] });
  w.local.bindings = {}; w.local.savedKeys = {}; w.local.parks.pk1 = pk(); w.surface = [orphanRow()]; }), [[prep, w => { sysPrep(w); w.local.parks.pk1.keyTargets = []; }]]));
