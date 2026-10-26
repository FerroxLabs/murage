// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-PROJECT-ROUTINE-107: a routine that posts into a project room is queued as an unattended room request, so a No limits bot
// raised a card for every command of the owner's own scheduled routine there. Its tool approvals are now judged as the routine's turn
// at the lowest of the routine's level, its bot's level when the run was delivered, and the running bot's level now. A webhook or
// channel run, and any request this process did not deliver itself, keep asking.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ProjectRoutineCeilings, projectRoutineCeiling, type ProjectRoutineRunFacts } from "./project-routines.ts";
import { applyRoutinePermissionMode, effectiveRoutinePermissionMode, routineTurnApproval, type RoutinePermissionMode } from "./routine-permissions.ts";

const READ = "ls -la ~/work/ | head -40; tail -15 ~/work/notes.md";
const bot = (mode: RoutinePermissionMode) => applyRoutinePermissionMode({}, mode);
const run = (over: Partial<ProjectRoutineRunFacts> = {}): ProjectRoutineRunFacts => ({ id: "run-1", routineId: "r1", manual: false, triggerSource: "schedule", ...over });
const request = (over: Record<string, unknown> = {}) => ({ id: "req-1", verb: "routine" as const, fromKind: "routine" as const, origin: "server" as const, admissionKey: "routine:run-1", unattended: true, notOwnerAudience: false, ...over });

describe("the ceiling taken when the run is delivered to the room", () => {
  it("a scheduled or manual run: the lower of the routine's level and its bot's level then", () => {
    expect(projectRoutineCeiling(run(), { permissionMode: "unlimited" }, bot("unlimited"))).toEqual({ permissionMode: "unlimited", triggerSource: "schedule" });
    expect(projectRoutineCeiling(run({ manual: true, triggerSource: "manual" }), { permissionMode: "unlimited" }, bot("auto"))).toEqual({ permissionMode: "auto", triggerSource: "manual" });
    expect(projectRoutineCeiling(run({ triggerSource: undefined, manual: true }), { permissionMode: "full" }, bot("unlimited"))).toEqual({ permissionMode: "full", triggerSource: "manual" });
  });

  it("a webhook or channel run, another audience, or no routine or bot: none, so it keeps asking", () => {
    expect(projectRoutineCeiling(run({ triggerSource: "webhook" }), { permissionMode: "unlimited" }, bot("unlimited"))).toBeUndefined();
    expect(projectRoutineCeiling(run({ triggerSource: "channel", humanPrincipal: { kind: "guest" } }), { permissionMode: "unlimited" }, bot("unlimited"))).toBeUndefined();
    expect(projectRoutineCeiling(run({ notOwnerAudience: true }), { permissionMode: "unlimited" }, bot("unlimited"))).toBeUndefined();
    expect(projectRoutineCeiling(run({ humanPrincipal: { kind: "owner" } }), { permissionMode: "unlimited" }, bot("unlimited"))).toBeUndefined();
    expect(projectRoutineCeiling(run(), undefined, bot("unlimited"))).toBeUndefined();
    expect(projectRoutineCeiling(run(), { permissionMode: "unlimited" }, undefined)).toBeUndefined();
  });
});

describe("the room turn that runs the delivered request", () => {
  const recorded = (mode: RoutinePermissionMode = "unlimited") => { const c = new ProjectRoutineCeilings(); c.record("req-1", "r1", { permissionMode: mode, triggerSource: "schedule" }); return c; };

  it("carries the recorded ceiling, lowered by the routine's level now", () => {
    expect(recorded().turnOptions(request(), () => "unlimited")).toEqual({ routineAuthority: { permissionMode: "unlimited", triggerSource: "schedule" }, projectRoutine: true });
    expect(recorded().turnOptions(request(), () => "auto").routineAuthority?.permissionMode).toBe("auto");
    expect(recorded("full").turnOptions(request(), () => "unlimited").routineAuthority?.permissionMode).toBe("full");
  });

  it("nothing for a request this process did not deliver (a restart), a routine since deleted, or any other request", () => {
    expect(new ProjectRoutineCeilings().turnOptions(request(), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request(), () => undefined)).toEqual({});
    expect(recorded().turnOptions(request({ verb: "room_turn" }), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request({ fromKind: "bot" }), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request({ origin: "desktop" }), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request({ admissionKey: "owner:1" }), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request({ notOwnerAudience: true }), () => "unlimited")).toEqual({});
    expect(recorded().turnOptions(request({ id: "req-2" }), () => "unlimited")).toEqual({});
    const forgot = recorded(); forgot.forget("req-1");
    expect(forgot.turnOptions(request(), () => "unlimited")).toEqual({});
  });

  it("keeps at most its limit, oldest out first", () => {
    const c = new ProjectRoutineCeilings(2);
    for (const id of ["a", "b", "c"]) c.record(id, "r1", { permissionMode: "unlimited", triggerSource: "schedule" });
    expect(c.turnOptions(request({ id: "a" }), () => "unlimited")).toEqual({});
    expect(c.turnOptions(request({ id: "c" }), () => "unlimited").projectRoutine).toBe(true);
  });
});

describe("the verdict", () => {
  /** The judge for a project routine turn: the ceiling (capped by the running bot now) as the run, the unattended mark lifted for tool approvals only. */
  const judged = (running: RoutinePermissionMode, ceiling: RoutinePermissionMode) => {
    const authority = recorded(ceiling);
    const options = authority.turnOptions(request(), () => "unlimited");
    const mode = effectiveRoutinePermissionMode(options.routineAuthority!, bot(running));
    return routineTurnApproval({ bot: bot(running), run: { permissionMode: mode }, tool: "Bash", summary: READ, context: { stopLine: null } }).verdict;
  };
  function recorded(mode: RoutinePermissionMode) { const c = new ProjectRoutineCeilings(); c.record("req-1", "r1", { permissionMode: mode, triggerSource: "schedule" }); return c; }

  it("No limits answers a read-only command of the owner's own project routine; Full access as Full access", () => {
    expect(judged("unlimited", "unlimited")).toMatchObject({ source: "no-limits" });
    expect(judged("full", "unlimited")).toMatchObject({ source: "full-access" });
  });

  it("never above the lowest level: a routine at Ask, or a bot lowered to Ask, still asks", () => {
    expect(judged("unlimited", "ask").approve).toBeNull();
    expect(judged("ask", "unlimited").approve).toBeNull();
  });

  it("a webhook or channel run keeps the unattended judge", () => {
    const verdict = routineTurnApproval({ bot: bot("unlimited"), run: null, tool: "Bash", summary: READ, context: { stopLine: null, unattended: true, automated: true } }).verdict;
    expect(verdict).toMatchObject({ approve: null, source: "unattended-block" });
  });
});

describe("the server wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("records a ceiling only for a request it just created, and the judge reads it only for an unattended turn", () => {
    expect(source).toMatch(/if \(delivery\.created && ceiling\) projectRoutineCeilings\.record\(delivery\.requestId, run\.routineId, ceiling\);/);
    expect(source).toMatch(/const routineWake = unattended \? routineWakeCeiling\(event\.threadId\) \?\? \(asker \? projectRoomRoutineCeiling\(event\.threadId, asker\) : undefined\) : undefined;/);
    // the room request itself stays unattended on disk: a restart, or any process that did not deliver it, keeps asking
    expect(readFileSync(new URL("./project-routines.ts", import.meta.url), "utf8")).toMatch(/targetThreadId: input\.threadId, unattended: true/);
  });
});
