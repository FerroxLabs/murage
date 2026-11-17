// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trace printer and coverage report.

import type { TraceStep, World } from "./invariants.current.ts";
import { FAULT_MODEL } from "./invariants.current.ts";
import { FAULT_SUBSUMPTION } from "./domain.ts";
import { HOME_EVENT_TYPES } from "./model.ts";
import type { Move } from "./model.ts";
import { BRANCH_IDS } from "./reducer.ts";
import { ALL_WRITES } from "./moves.ts";

export interface Coverage { moves: Record<string, number>; crashPoints: Record<string, number>; events: Record<string, number>; branches: Record<string, number>; states: number; transitions: number }
export const newCoverage = (): Coverage => ({ moves: {}, crashPoints: {}, events: {}, branches: {}, states: 0, transitions: 0 });
export const bump = (r: Record<string, number>, k: string): void => { r[k] = (r[k] ?? 0) + 1; };

export const ALL_MOVE_TYPES: readonly string[] = [
  "owner.keep", "owner.remove", "owner.deleteBot", "owner.tryAgainNow", "owner.reconnect", "owner.setupEmail", "owner.viewSurface", "owner.backup", "owner.restore",
  "auto.boot", "auto.bootPrep", "auto.emailOn", "auto.settle", "auto.tick", "auto.applyEvent", "auto.guardPoll", "net.answer", "net.listing",
  "flux.apply", "flux.emit", "flux.close", "flux.purge", "fault.crash", "fault.loseAnswer", "fault.duplicate", "clock.advance",
];

const brief = (w: World): string => {
  const b = Object.values(w.local.bindings).map(x => x.botId + ":" + x.state).join(",");
  const p = Object.values(w.local.parks).map(x => x.botId + ":" + x.state).join(",");
  const f = Object.values(w.flux.inboxes).map(i => i.inboxId + ":" + i.state).join(",");
  const r = w.flux.requests.map(q => q.requestId + (q.kind[0]) + ":" + q.flux[0] + q.answer[0]).join(",");
  return "proc=" + w.proc.phase + "#" + w.proc.processId + " bind[" + b + "] park[" + p + "] flux[" + f + "] req[" + r + "] guards=" + Object.keys(w.local.keepGuards).length + " t=" + (w.nowMs / 1000).toFixed(0) + "s";
};
export const moveText = (m: Move): string => JSON.stringify(m, (_k, v) => (v === undefined ? undefined : v));

export function printTrace(steps: readonly TraceStep[], seedWorld?: World): string {
  const out: string[] = [];
  if (seedWorld) out.push("   seed: " + brief(seedWorld));
  let last = seedWorld ? brief(seedWorld) : "";
  steps.forEach((s, i) => { const b = brief(s.next); out.push(String(i + 1).padStart(3) + " " + moveText(s.action) + (b === last ? "" : "\n      -> " + b)); last = b; });
  return out.join("\n");
}

export function formatCoverage(c: Coverage, reducerBranches: readonly string[] = BRANCH_IDS): string {
  const miss = (all: readonly string[], seen: Record<string, number>): string[] => all.filter(x => !(x in seen));
  const allCrash = ALL_WRITES.flatMap(w => ["before", "after"].map(x => w + "." + x));
  const faultGaps = FAULT_MODEL.filter(f => !(f in c.moves) && !(f in FAULT_SUBSUMPTION));
  return [
    "states=" + c.states + " transitions=" + c.transitions,
    "moves never fired: " + (miss(ALL_MOVE_TYPES, c.moves).join(", ") || "none"),
    "crash points never fired (" + miss(allCrash, c.crashPoints).length + "/" + allCrash.length + "): " + (miss(allCrash, c.crashPoints).slice(0, 12).join(", ") || "none") + (miss(allCrash, c.crashPoints).length > 12 ? " ..." : ""),
    "reducer events never fired: " + (miss(HOME_EVENT_TYPES, c.events).join(", ") || "none"),
    "reducer branch ids never taken (" + miss(reducerBranches, c.branches).length + "/" + reducerBranches.length + "): " + (miss(reducerBranches, c.branches).join(", ") || "none"),
    "FAULT_MODEL entries with no move and no subsumption note: " + (faultGaps.join(", ") || "none"),
  ].join("\n");
}
