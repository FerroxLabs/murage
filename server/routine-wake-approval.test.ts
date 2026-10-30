// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-ROUTINE-WAKE-107 (Sean 10-25): Kessler at No limits ran a scheduled routine, handed part of it to a teammate, and the turn
// that resumed it after the reply held `ls`/`tail` on its own files as "This task started outside the desktop". The permission judge
// now takes that follow-through as the routine's turn at the ceiling it carries (tool approvals only); an outside event still blocks.
import { describe, expect, it } from "vitest";

import { approvalHoldNote, type AutoContext } from "./auto-approve.ts";
import { applyRoutinePermissionMode, routineTurnApproval, type RoutinePermissionMode } from "./routine-permissions.ts";
import type { StopHit } from "./stop-line.ts";

const READ = "ls -la ~/.example-bot/ops/ | head -40; tail -15 ~/.example-bot/ops/review-log.md; ls -lat ~/.example-bot/queue/ | head -15";
const bot = (mode: RoutinePermissionMode) => applyRoutinePermissionMode({}, mode);
/** The permission site for a routine wake: the routine's ceiling as the run, the unattended mark lifted for tool approvals only. */
const wake = (mode: RoutinePermissionMode, ceiling: RoutinePermissionMode, context: AutoContext = {}) =>
  routineTurnApproval({ bot: bot(mode), run: { permissionMode: ceiling }, tool: "Bash", summary: READ, context: { stopLine: null, ...context } }).verdict;
/** The same turn as base judged it: unattended, no run. */
const unattended = (mode: RoutinePermissionMode) =>
  routineTurnApproval({ bot: bot(mode), run: null, tool: "Bash", summary: READ, context: { stopLine: null, unattended: true, automated: true } }).verdict;

describe("the follow-through turn of the owner's own routine", () => {
  it("base: the same read-only command is held as an outside start", () => {
    const verdict = unattended("unlimited");
    expect(verdict.approve).toBeNull();
    expect(verdict.source).toBe("unattended-block");
    expect(approvalHoldNote(verdict)).toMatch(/started outside the desktop/);
  });

  it("No limits answers a read-only command, as it does on the routine's own turn", () => {
    expect(wake("unlimited", "unlimited")).toMatchObject({ source: "no-limits" });
    expect(wake("full", "full")).toMatchObject({ source: "full-access" });
  });

  it("never above the ceiling: a routine at Ask, or a bot lowered to Ask, still asks", () => {
    expect(wake("unlimited", "ask").approve).toBeNull();
    expect(wake("ask", "unlimited").approve).toBeNull();
  });

  it("the key guard still holds at No limits on a routine turn; the stop line holds at Full access (No limits lifts it, 1.0.10 A5)", () => {
    const stop: StopHit = { kind: "delete", place: "/Users/x/Documents", what: "Deletes files outside its folder" };
    expect(wake("full", "full", { stopLine: stop })).toMatchObject({ approve: null, source: "stop-line" });
    expect(wake("unlimited", "unlimited", { stopLine: stop })).toMatchObject({ source: "no-limits" });
    const key = routineTurnApproval({ bot: bot("unlimited"), run: { permissionMode: "unlimited" }, tool: "Bash", summary: "cat ~/.ssh/id_ed25519", context: { stopLine: null } }).verdict;
    expect(key.approve).toBeNull();
  });

  it("an outside event's turn keeps the unattended judge even with a routine run attached", () => {
    expect(wake("unlimited", "unlimited", { unattended: true })).toMatchObject({ approve: null, source: "unattended-block" });
  });
});
