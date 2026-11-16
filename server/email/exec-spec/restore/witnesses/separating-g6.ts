// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SEPARATING HISTORIES for g6 EQUIVALENT / COMBINED verdicts (clause-mutants.test.ts). NOT witnesses: not in WITNESSES, not in the combined gate.
// Each is a history on which the clause mutant and the original disagree and which a DIFFERENT predicate (the verdict's `by`) rejects.
import { run, from, rq, apply, clk, kept, closeBy, tick, nolive, prepMarks, clearJob, rcRow, ticks, type Witness } from "./spec.ts";
import { CHECKER, type World } from "../invariants.current.ts";

type Sep = { id: string; invariant: string; trace: Witness["trace"]; settled: boolean };
export const SEPARATING: Sep[] = [];
const sep = (invariant: string, id: string, trace: Witness["trace"], settled = false) => SEPARATING.push({ id, invariant, trace, settled });
void [rq, tick];

// keepEndsActive#1 / #2: a Keep whose success step and success time were NOT written together (one null), inbox deleted and never restored past the bound.
// Original: the null-pair record is skipped (accepts); mutant: judges it (rejects). environmentWellFormed rejects the half-written pair.
const halfKeep = (field: "succeededAtStep" | "succeededAtMs") => from((w: World) => { Object.assign(w, kept()); w.ghost.keeps[0][field] = null; });
sep("keepEndsActive", "sep-keepEndsActive-1-half-keep-step-null", run(halfKeep("succeededAtStep"), [[apply("d1"), closeBy("d1")], [clk(10_000_000_000)]]));
const evDelivered: [import("../invariants.current.ts").Action, ((w: World) => void)?] = [{ t: "auto.applyEvent", eventId: "e-d1" }, (w: World) => { w.flux.events.find(e => e.eventId === "e-d1")!.deliveredToHome = true; }];
sep("keepEndsActive", "sep-keepEndsActive-2-half-keep-ms-null", run(halfKeep("succeededAtMs"), [[apply("d1"), closeBy("d1")], evDelivered, [clk(10_000_000_000)]]));

// heldInputDrains#4: an event born IN the window-ending step (atStep after prev.step) that is never delivered. Original: not held (accepts);
// mutant: held, never applied within the bound (rejects). environmentWellFormed rejects a deleted event for an inbox that is not purged.
const BND = CHECKER.livenessBound;
const prepRun: [import("../invariants.current.ts").Action, ((w: World) => void)?] = [prepMarks[0], (w: World) => { prepMarks[1]!(w); w.proc.phase = "running"; w.surface = [rcRow()]; }];
const endWithEvent: typeof prepRun = [prepRun[0], (w: World) => { prepRun[1]!(w); w.flux.events.push({ eventId: "eS", type: "email.inbox.deleted", inboxId: "i1", atMs: w.nowMs, atStep: w.step, deliveredToHome: false, reason: null }); }];
sep("heldInputDrains", "sep-heldInputDrains-4-event-born-in-window-end-step", nolive([endWithEvent, clearJob, ...ticks(BND)]));
