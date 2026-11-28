// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 (owner-seen): after the update to 1.0.20 the Today block still read "Morning brief did not finish" with the raw code
// wipe-guard-invalid-turn. That run failed on 1.0.19 (more than 512 delete-check roots; 1.0.20 accepts 8192 and stores the plain line,
// server/drivers/murage-exec-wipe.ts GUARD_START_FAILED_LINE), but its stored error is shown for the rest of the day on every routine
// surface. A stored code of Murage's own delete check reads as the same one plain Murage line the 1.0.20 thread card uses; an engine's or
// provider's own code and any sentence stay as they came.
import { describe, expect, it } from "vitest";
import type { RoutineRun } from "@/lib/routines";
import { routineErrorText } from "./routine-error";
import { needsLines, type NeedsLinesInput } from "./today-needs";
import { doneToday } from "./today-model";

const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m).getTime();
const run = (error: string): RoutineRun => ({ id: "run-1", routineId: "r1", routineName: "Morning brief", target: "bot", botId: "nova", runOn: "ember",
  scheduledFor: at(7), status: "failed", manual: false, startedAt: at(7), finishedAt: at(7, 1), createdAt: at(7), error });
const input = (runs: RoutineRun[]): NeedsLinesInput => ({ now: at(12), count: 0, rows: [], restore: [], reconnectApps: [], handoffs: [],
  routines: [{ id: "r1" }], runs, bots: [], botNames: { nova: "Nova" } });
const PLAIN = "Murage couldn't start this reply because its delete protection could not be set up.";

describe("1.0.20: a routine run that failed on 1.0.19 with a delete-check code", () => {
  it("reads as the plain Murage line in Today's Needs you block and in Done today, never the raw code", () => {
    for (const code of ["wipe-guard-invalid-turn", "wipe-guard-file-too-large", "wipe-root-inventory-unavailable"]) {
      expect(needsLines(input([run(code)])).all[0]?.detail, code).toEqual({ raw: PLAIN });
      expect(doneToday([run(code)], { nova: "Nova" }, new Date(at(12)))[0]?.line, code).toEqual({ raw: PLAIN });
      expect(routineErrorText(code)).toBe(PLAIN);
    }
  });

  it("leaves an engine's own code, a sentence and an empty error as they were", () => {
    for (const kept of ["usage_limit_reached", "Gmail is not authorized.", "wipe-guard-invalid-turn because", "my-wipe-guard-invalid-turn"])
      expect(needsLines(input([run(kept)])).all[0]?.detail, kept).toEqual({ raw: kept });
    expect(routineErrorText(undefined)).toBeUndefined();
    expect(needsLines(input([run("")])).all[0]?.detail).toEqual({ key: "ux.l2a.today.look.failedGeneric" });
  });
});
