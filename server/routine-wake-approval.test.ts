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
  routineTurnApproval({ bot: bot(mode), run: { permissionMode: ceiling, permissionExplicit: true }, tool: "Bash", summary: READ, context: { stopLine: null, ...context } }).verdict;
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
    expect(wake("full", "ask").approve).toBeNull();
    expect(wake("ask", "unlimited").approve).toBeNull();
  });

  // MAIN RULING 2026-11-13 wipe-only: ordinary stop lines and key reads run at No limits.
  it("ordinary stop lines and a key read run at No limits on a routine turn", () => {
    const stop: StopHit = { kind: "delete", place: "/Users/x/Documents", what: "Deletes files outside its folder" };
    expect(wake("unlimited", "unlimited", { stopLine: stop })).toMatchObject({ approve: expect.any(String), source: "no-limits" });
    const key = routineTurnApproval({ bot: bot("unlimited"), run: { permissionMode: "unlimited" }, tool: "Bash", summary: "cat ~/.ssh/id_ed25519", context: { stopLine: null } }).verdict;
    expect(key.approve).toBeTruthy();
  });

  // MAIN RULING 2026-11-13 wipe-only: an outside trigger keeps effective No limits.
  it("an outside event follows the routine's No limits ceiling", () => {
    expect(wake("unlimited", "unlimited", { unattended: true })).toMatchObject({ approve: expect.any(String), source: "no-limits" });
  });
});


// MAIN RULING 2026-11-13 wipe-only: an explicit Ask ceiling survives follow-through.
it("No limits follow-through preserves a saved explicit Ask ceiling", () => {
  expect(wake("unlimited", "ask").approve).toBeNull();
});
