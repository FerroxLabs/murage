// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIMITS-PROJECT-ROUTINE-107: a routine that posts into a project room is queued as an unattended room request, so a No limits bot
// raised a card for every command of the owner's own scheduled routine there. Its tool approvals are now judged as the routine's turn
// at the lowest of the routine's level, its bot's level when the run was delivered, and the running bot's level now. A webhook or
// channel run, and any request this process did not deliver itself, keep asking.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProjectTables, prepareProjectTablesForRestore, deleteProjectRows } from "./project-tables.ts";
import { initializeMessageTables } from "./message-tables.ts";
import { channelToProjectRows } from "./project-settings.ts";
import { roomRequest, markRequestDispatched } from "./room-requests.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { persistedProjectRoutineOptions, recordProjectRoutine, projectRoutineCeiling, type ProjectRoutineRunFacts, type ProjectRoutineAuthorityCurrent } from "./project-routines.ts";
import { applyRoutinePermissionMode, effectiveRoutinePermissionMode, routineTurnApproval, type RoutinePermissionMode } from "./routine-permissions.ts";

const bot = (mode: RoutinePermissionMode) => applyRoutinePermissionMode({}, mode);
const run = (over: Partial<ProjectRoutineRunFacts> = {}): ProjectRoutineRunFacts => ({ id: "run-1", routineId: "r1", manual: false, triggerSource: "schedule", ...over });

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

describe("the server wiring", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  it("records a ceiling only for a request it just created, and the judge reads it only for an unattended turn", () => {
    expect(source).toContain("persistedProjectRoutineOptions(database(), request, projectRoutineCurrent)");
    expect(source).toMatch(/const routineWake = unattended \? routineWakeCeiling\(event\.threadId\) \?\? \(asker \? projectRoomRoutineCeiling\(event\.threadId, asker\) : undefined\) : undefined;/);
    // The room request keeps its unattended mark; only the validated tool-approval lookup supplies a routine ceiling.
    expect(readFileSync(new URL("./project-routines.ts", import.meta.url), "utf8")).toMatch(/targetThreadId: input\.threadId, unattended: true/);
  });
});

describe("108 durable project routine authority", () => {
  let root: string, dataDir: string, db: DatabaseSync;
  const current = (): ProjectRoutineAuthorityCurrent => ({ sourceBotId: "lead", ownerBinding: "owner-binding", audienceBinding: "room-binding", permissionMode: "unlimited", triggerSource: "schedule" });
  const input = (runId = "durable-run") => ({ groupId: "g", threadId: "room", memberIds: ["lead"], runId, botId: "lead", name: "Check", prompt: "Read the fixture", now: 3,
    authority: { routineId: "r1", ceiling: { permissionMode: "unlimited" as RoutinePermissionMode, triggerSource: "schedule" as const }, ownerBinding: "owner-binding", audienceBinding: "room-binding" } });
  const deliver = (value = input()) => {
    db.exec("BEGIN");
    try { const result = recordProjectRoutine(db, value); db.exec("COMMIT"); return result.requestId; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "routine108-"));
    dataDir = join(root, "installation"); mkdirSync(dataDir);
    db = new DatabaseSync(join(dataDir, "messages.db")); db.exec("PRAGMA foreign_keys=ON");
    initializeMessageTables(db); initializeProjectTables(db);
    channelToProjectRows(db, { groupId: "g", leadBotId: "lead", bulletin: "", now: 1 });
    db.exec("UPDATE project_settings SET mode='ongoing'");
  });
  afterEach(() => { db.close(); removeTempDirSync(root); });
  const options = (id: string, now = current) => persistedProjectRoutineOptions(db, roomRequest(db, id)!, now);
  it("reopens a queued request, admits that exact request and caps its approval at current limits", () => {
    const id = deliver(); db.close(); db = new DatabaseSync(join(dataDir, "messages.db"));
    expect(roomRequest(db, id)?.state).toBe("queued");
    expect(options(id).routineAuthority?.permissionMode).toBe("unlimited");
    expect(markRequestDispatched(db, id, { now: 5, targetThreadId: "room" })).toBe(true);
    for (const level of ["ask", "auto", "full", "unlimited"] as const) {
      const authority = options(id, () => ({ ...current(), permissionMode: level })).routineAuthority!;
      expect(authority.permissionMode).toBe(level);
      const verdict = routineTurnApproval({ bot: bot("unlimited"), run: authority, tool: "Bash", summary: "echo fixture", context: { stopLine: null } }).verdict;
      if (level === "ask") expect(verdict.approve).toBeNull(); else expect(verdict.approve).not.toBeNull();
    }
    expect(effectiveRoutinePermissionMode(options(id).routineAuthority!, bot("ask"))).toBe("ask");
  });
  it("keeps authenticated manual delivery distinct from scheduled delivery", () => {
    const manual = { ...input(), authority: { ...input().authority, ceiling: { permissionMode: "full" as const, triggerSource: "manual" as const } } };
    db.exec("BEGIN"); const id = recordProjectRoutine(db, manual).requestId; db.exec("COMMIT");
    expect(options(id)).toEqual({});
    expect(options(id, () => ({ ...current(), triggerSource: "manual" })).routineAuthority).toEqual({ permissionMode: "full", triggerSource: "manual" });
  });
  it("does not remint or raise a duplicate and rolls request and authority back together", () => {
    const first = input(); first.authority.ceiling.permissionMode = "full";
    const id = deliver(first); expect(deliver()).toBe(id);
    expect(options(id).routineAuthority?.permissionMode).toBe("full");
    db.exec("CREATE TRIGGER fixture_refuse_authority BEFORE INSERT ON project_routine_authority BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    expect(() => deliver(input("rollback"))).toThrow();
    expect(db.prepare("SELECT id FROM room_requests WHERE admission_key='routine:rollback'").get()).toBeUndefined();
  });
  it.each(["cancelled", "done", "waiting_owner", "unknown"])("does not authorize a %s request", state => {
    const id = deliver(); db.prepare("UPDATE room_requests SET state=? WHERE id=?").run(state, id); expect(options(id)).toEqual({});
  });
  it("holds foreign origins, retargeting, changed bindings, deleted sources and corrupt/missing rows", () => {
    const id = deliver(), original = roomRequest(db, id)!;
    for (const patch of [{ origin: "desktop" }, { notOwnerAudience: true }, { toBotId: "other" }, { groupId: "other" }, { targetThreadId: "other" }, { rootThreadId: "other" }]) expect(persistedProjectRoutineOptions(db, { ...original, ...patch } as typeof original, current)).toEqual({});
    for (const patch of [{ sourceBotId: "other" }, { ownerBinding: "other" }, { audienceBinding: "other" }]) expect(options(id, () => ({ ...current(), ...patch }))).toEqual({});
    expect(persistedProjectRoutineOptions(db, original, () => undefined)).toEqual({});
    expect(persistedProjectRoutineOptions(db, original, () => { throw new Error("fixture unavailable"); })).toEqual({});
    db.prepare("UPDATE project_routine_authority SET ceiling='corrupt' WHERE request_id=?").run(id); expect(options(id)).toEqual({});
    db.prepare("DELETE FROM project_routine_authority WHERE request_id=?").run(id); expect(options(id)).toEqual({});
  });
  it("inspects an actual snapshot, drops authority on restore, and accepts a legacy archive", async () => {
    const id = deliver(); expect(() => inspectInstallationDatabase(db)).not.toThrow();
    db.close();
    const snapshot = join(root, "archive.db");
    try { await snapshotInstallationDatabase(dataDir, snapshot); } finally { db = new DatabaseSync(join(dataDir, "messages.db")); }
    const restored = new DatabaseSync(snapshot);
    try {
      expect(() => inspectInstallationDatabase(restored)).not.toThrow();
      prepareProjectTablesForRestore(restored, { groups: [{ id: "g", channelProject: {} }], botIds: new Set(["lead"]), now: 10 });
      expect(restored.prepare("SELECT count(*) n FROM project_routine_authority").get()?.n).toBe(0);
      expect(persistedProjectRoutineOptions(restored, roomRequest(restored, id)!, current)).toEqual({});
      restored.exec("DROP TABLE project_routine_authority");
      expect(() => inspectInstallationDatabase(restored)).not.toThrow();
      expect(() => prepareProjectTablesForRestore(restored, { groups: [{ id: "g", channelProject: {} }], botIds: new Set(["lead"]), now: 11 })).not.toThrow();
      initializeProjectTables(restored); expect(restored.prepare("SELECT count(*) n FROM project_routine_authority").get()?.n).toBe(0);
    } finally { restored.close(); }
  });
  it("deletes the authority with the request and with its project", () => {
    const id = deliver(); db.prepare("DELETE FROM room_requests WHERE id=?").run(id);
    expect(db.prepare("SELECT count(*) n FROM project_routine_authority").get()?.n).toBe(0);
    deliver(input("next")); deleteProjectRows(db, "g", 20);
    expect(db.prepare("SELECT count(*) n FROM project_routine_authority").get()?.n).toBe(0);
  });
});
