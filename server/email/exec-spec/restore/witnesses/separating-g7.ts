// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for g7 COMBINED verdicts (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
import { from, run, clk, twoBots, deleteB1, ls, pendingRow, type Witness } from "./spec.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];

// markerNeverArchivedAndConsumedAtBoot#13: a boot prep that THREW with the marker still live. Original: only an "ok" boot prep owes the marker's removal, so it accepts; mutant: any boot prep owes it, rejects.
// restorePrepNeverThrows rejects the threw boot prep.
SEPARATING.push({ id: "sep-markerNeverArchivedAndConsumedAtBoot-13-threw-boot-prep-marker", invariant: "markerNeverArchivedAndConsumedAtBoot", settled: false,
  trace: run(from(w => { w.fs.liveMarker = { resetId: "r1" }; w.proc.phase = "boot_prep"; w.proc.processId = 2; w.ghost.lastBootAtMs = w.nowMs; }), [[{ t: "auto.bootPrep", outcome: "threw" }, () => {}]]) });
void clk;

// deletedBotAuthorityDead#28: the deleted bot's OLD lease L1 (authorized, not sending) survives the delete beside the delete's own lease LD, both on i1. Original: only a (newly) sending lease is judged, accepts;
// mutant: any lease whose authority predates the delete is judged, rejects. keepAndRemoveSerialized rejects the two leases on i1.
SEPARATING.push({ id: "sep-deletedBotAuthorityDead-28-old-lease-survives-delete", invariant: "deletedBotAuthorityDead", settled: false,
  trace: run(from(w => { Object.assign(w, twoBots()); Object.assign(w.local.leases.L1, { phase: "authorized", attemptId: null, attempts: [] }); }),
    [[deleteB1[0], w => { deleteB1[1]!(w); w.local.leases.LD = ls({ removalId: "LD", authorityId: "aD" }); w.surface = [pendingRow()]; }]]) });
