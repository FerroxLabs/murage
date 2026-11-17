// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner edits preserve explicit ceilings. Inherited fallback levels follow
// No limits, including legacy 1.0.18 Full records without explicit provenance.
// Fixtures use temporary files and never dispatch a turn.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import type { SendTurnInput } from "./contracts.ts";
import type { AutoApprover } from "./auto-approve.ts";
import * as routinePermissions from "./routine-permissions.ts";
import { RoutineManager, routinesPrePinFile, type RoutineInput, type RoutineManagerOptions } from "./routines.ts";
import { botPermissionMode, effectiveRoutinePermissionMode } from "./routine-permissions.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = Date.UTC(2026, 9, 3, 12);
const dirs: string[] = [];
const input: RoutineInput = {
  name: "Archive check", prompt: "Read the archive", botId: "bot-a", enabled: false,
  schedule: { type: "interval", everyMinutes: 30, anchorAt: NOW },
};

function fixture(extra: Partial<RoutineManagerOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murage-routine-authority-"));
  dirs.push(dir);
  const file = join(dir, "routines.json");
  const options: RoutineManagerOptions = {
    file, now: () => NOW, botState: () => "ready",
    createTask: () => { throw new Error("No turn is dispatched in this fixture"); },
    startTurn: async () => { throw new Error("No turn is dispatched in this fixture"); },
    ...extra,
  };
  return { file, options, load: () => new RoutineManager(options) };
}

function record(id: string, fields: Record<string, unknown> = {}) {
  return {
    ...input, id, target: "bot", runOn: "ember", durationMinutes: 30, attachments: [],
    nextRunAt: null, createdAt: NOW, updatedAt: NOW, ...fields,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("routine authority", () => {
  // Gap 4: both server send paths must carry a permission-enforcement field at every level.
  // MAIN RULING 2026-11-13 wipe-only: No limits is carried through dispatch; explicit lower choices survive.
  it("server turns carry routeAsks below Full and stopLine at Full", () => {
    // SEAM: turnPermissionEnforcement(bot) in routine-permissions.ts, extracted from both index.ts sendTurn builders after applying the effective routine level.
    const enforcement = (routinePermissions as typeof routinePermissions & {
      turnPermissionEnforcement?: (bot: AutoApprover) => Pick<SendTurnInput, "routeAsks" | "stopLine" | "askLevel">;
    }).turnPermissionEnforcement;
    expect(enforcement, "both server dispatch paths must opt into permission enforcement").toBeTypeOf("function");
    const profile = { autoApprove: true, fullAccess: true, noLimits: true };
    for (const mode of ["ask", "auto", "full", "unlimited"] as const) {
      const bot = routinePermissions.applyRoutinePermissionMode(profile, mode);
      expect(enforcement!(bot), mode).toEqual(mode === "ask" ? { routeAsks: true, askLevel: true } : mode === "auto" ? { routeAsks: true } : mode === "unlimited" ? { stopLine: true, noLimits: true } : { stopLine: true });
      const capped = routinePermissions.applyRoutinePermissionMode(profile, effectiveRoutinePermissionMode({ permissionMode: mode, permissionExplicit: true }, profile));
      expect(enforcement!(capped), `routine ${mode}`).toEqual(enforcement!(bot));
    }
    expect(profile).toEqual({ autoApprove: true, fullAccess: true, noLimits: true });
  });

  it.each([undefined, "inherit", null] as const)("keeps an Ask fallback for input %s and inherits the bot's later No limits", (permissionMode) => {
    const bot = { autoApprove: false, fullAccess: false, noLimits: false };
    const f = fixture({ botMode: () => botPermissionMode(bot) });
    const manager = f.load();
    const routine = manager.create({ ...input, ...(permissionMode === undefined ? {} : { permissionMode }) });
    expect(routine.permissionMode).toBe("ask");
    Object.assign(bot, { autoApprove: true, fullAccess: true, noLimits: true });
    // MAIN RULING 2026-11-13 wipe-only: an inherited Ask fallback follows No limits.
    expect(effectiveRoutinePermissionMode(manager.listRoutines()[0]!, bot)).toBe("unlimited");
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("ask");
    expect(JSON.parse(readFileSync(f.file, "utf8")).routines[0].permissionMode).toBe("ask");
  });

  it("tightens an unlimited ceiling with the bot and raises an Ask ceiling only through a level edit", () => {
    const bot = { autoApprove: true, fullAccess: true, noLimits: true };
    const f = fixture({ botMode: () => botPermissionMode(bot) });
    const manager = f.load();
    const unlimited = manager.create({ ...input, permissionMode: "unlimited" });
    Object.assign(bot, { fullAccess: false, noLimits: false });
    expect(effectiveRoutinePermissionMode(unlimited, bot)).toBe("auto");
    expect(manager.listRoutines()[0]!.permissionMode).toBe("unlimited");

    const ask = manager.create({ ...input, permissionMode: "ask" });
    Object.assign(bot, { fullAccess: true, noLimits: false });
    expect(effectiveRoutinePermissionMode(ask, bot)).toBe("ask");
    const renamed = manager.update(ask.id, { name: "Named archive check" })!;
    expect(renamed.permissionMode).toBe("ask");
    expect(effectiveRoutinePermissionMode(renamed, bot)).toBe("ask");
    Object.assign(bot, { noLimits: true });
    const raised = manager.update(ask.id, { permissionMode: "unlimited" })!;
    expect(effectiveRoutinePermissionMode(raised, bot)).toBe("unlimited");
    expect(f.load().listRoutines().find((routine) => routine.id === ask.id)?.permissionMode).toBe("unlimited");
  });

  it("H2 No limits preserves a saved explicit Ask ceiling without rewriting its choice", () => {
    const profile={autoApprove:true,fullAccess:true,noLimits:false};
    const f=fixture({botMode:()=>botPermissionMode(profile)});
    const manager=f.load();const routine=manager.create({...input,permissionMode:"ask"});
    expect(effectiveRoutinePermissionMode(routine,profile)).toBe("ask");
    profile.noLimits=true;
    expect(effectiveRoutinePermissionMode(routine,profile)).toBe("ask");
    expect(routine.permissionExplicit).toBe(true);
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("ask");
    profile.noLimits=false;
    expect(effectiveRoutinePermissionMode(routine,profile)).toBe("ask");
  });

  it.each(["inherit", null] as const)("keeps a fallback on %s and follows the bot at No limits", (permissionMode) => {
    const bot = { autoApprove: true, fullAccess: false, noLimits: false };
    const f = fixture({ botMode: () => botPermissionMode(bot) });
    const manager = f.load();
    const routine = manager.create({ ...input, permissionMode: "ask" });
    const updated = manager.update(routine.id, { permissionMode })!;
    expect(updated.permissionMode).toBe("auto");
    Object.assign(bot, { fullAccess: true, noLimits: true });
    // MAIN RULING 2026-11-13 wipe-only: inherit/null clears the explicit ceiling.
    expect(effectiveRoutinePermissionMode(updated, bot)).toBe("unlimited");
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("auto");
  });

  it.each([{}, { botMode: () => undefined }])("pins Ask when the bot level is unavailable: %j", (options) => {
    const f = fixture(options);
    const manager = f.load();
    expect(manager.create(input).permissionMode).toBe("ask");
    const routine = manager.create({ ...input, permissionMode: "unlimited" });
    expect(manager.update(routine.id, { permissionMode: "inherit" })?.permissionMode).toBe("ask");
  });

  it("pins legacy modes at load, preserves receipts and the original, and leaves a second load unchanged", () => {
    const botMode = vi.fn<NonNullable<RoutineManagerOptions["botMode"]>>((id) => id === "unknown" ? undefined : "unlimited");
    const f = fixture({ botMode });
    const receipt = {
      requestId: "request-a", messageId: "message-a", botId: "bot-a", threadId: "thread-a",
      action: "create", fingerprintVersion: 1, fingerprint: "a".repeat(64), resultId: "legacy", appliedAt: NOW,
    };
    const original = JSON.stringify({ version: 1, runs: [], routineRequestReceipts: [receipt], routines: [
      record("legacy"), record("unknown", { botId: "unknown" }),
      record("pinned", { permissionMode: "full" }),
      ...["root", "inherit", null, 3, false, {}].map((permissionMode, index) => record(`invalid-${index}`, { permissionMode })),
    ] }, null, 2);
    writeFileSync(f.file, original);
    const manager = f.load();
    expect(manager.listRoutines().map((routine) => routine.permissionMode)).toEqual([
      "unlimited", "ask", "full", "ask", "ask", "ask", "ask", "ask", "ask",
    ]);
    expect(botMode.mock.calls.map(([id]) => id)).toEqual(["bot-a", "unknown"]);
    expect(manager.routineRequestReceipt(receipt.requestId)).toEqual(receipt);
    expect(readFileSync(routinesPrePinFile(f.file), "utf8")).toBe(original);
    const migrated = readFileSync(f.file, "utf8");
    expect(JSON.parse(migrated).routines.map((routine: { permissionMode: string }) => routine.permissionMode))
      .toEqual(manager.listRoutines().map((routine) => routine.permissionMode));
    expect(JSON.parse(migrated).routineRequestReceipts).toEqual([receipt]);
    expect(JSON.parse(migrated).runsCommit).toBe(1);
    expect(atomic.atomicWriteCount(f.file)).toBe(1);
    expect(atomic.atomicWriteCount(routinesPrePinFile(f.file))).toBe(1);

    botMode.mockClear();
    botMode.mockReturnValue("ask");
    expect(f.load().listRoutines()).toEqual(manager.listRoutines());
    expect(botMode).not.toHaveBeenCalled();
    expect(readFileSync(f.file, "utf8")).toBe(migrated);
    expect(readFileSync(routinesPrePinFile(f.file), "utf8")).toBe(original);
    expect(atomic.atomicWriteCount(f.file)).toBe(1);
    expect(atomic.atomicWriteCount(routinesPrePinFile(f.file))).toBe(1);
  });

  // MAIN RULING 2026-11-13 wipe-only: 1.0.18 stored inherited Full too;
  // only permissionExplicit proves an owner-selected lower routine ceiling.
  it("legacy Full follows No limits through scheduled metadata while explicit Full survives", () => {
    const f = fixture({ botMode: () => "unlimited" });
    writeFileSync(f.file, JSON.stringify({ version: 1, routines: [
      record("inherited", { permissionMode: "full" }),
      record("explicit", { permissionMode: "full", permissionExplicit: true }),
    ] }));
    const routines = f.load().listRoutines();
    const profile = { autoApprove: true, fullAccess: true, noLimits: true };
    const inheritedRun = { ...routines[0]!, triggerSource: "schedule" };
    const explicitRun = { ...routines[1]!, triggerSource: "schedule" };
    expect(effectiveRoutinePermissionMode(inheritedRun, profile)).toBe("unlimited");
    expect(effectiveRoutinePermissionMode(explicitRun, profile)).toBe("full");
    expect(f.load().listRoutines()).toEqual(routines);
  });

  it("pins a legacy routine to Ask without a bot callback", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ version: 1, routines: [record("legacy")] }));
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("ask");
    expect(JSON.parse(readFileSync(f.file, "utf8")).routines[0].permissionMode).toBe("ask");
    expect(existsSync(routinesPrePinFile(f.file))).toBe(true);
  });

  it.each(["backup", "rewrite"] as const)("finishes migration after interruption during the %s", (stage) => {
    const f = fixture({ botMode: () => "auto" });
    const original = JSON.stringify({ version: 1, runs: [], routines: [record("legacy")] });
    writeFileSync(f.file, original);
    const interruptedPath = stage === "backup" ? routinesPrePinFile(f.file) : f.file;
    const write = atomic.writeFileAtomic;
    const injected = vi.spyOn(atomic, "writeFileAtomic").mockImplementation((path, data, options) => {
      if (path === interruptedPath) {
        writeFileSync(`${path}.interrupted.tmp`, '{"version":');
        throw new Error("fixture interrupted write");
      }
      write(path, data, options);
    });
    expect(() => f.load()).toThrow("fixture interrupted write");
    expect(readFileSync(f.file, "utf8")).toBe(original);
    if (stage === "rewrite") expect(readFileSync(routinesPrePinFile(f.file), "utf8")).toBe(original);
    else expect(existsSync(routinesPrePinFile(f.file))).toBe(false);
    injected.mockRestore();

    expect(f.load().listRoutines()[0]!.permissionMode).toBe("auto");
    expect(JSON.parse(readFileSync(f.file, "utf8")).routines[0].permissionMode).toBe("auto");
    expect(readFileSync(routinesPrePinFile(f.file), "utf8")).toBe(original);
    expect(atomic.atomicWriteCount(routinesPrePinFile(f.file))).toBe(1);
    const migrated = readFileSync(f.file, "utf8");
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("auto");
    expect(readFileSync(f.file, "utf8")).toBe(migrated);
  });

  it("keeps an existing pre-pin copy when another legacy file needs migration", () => {
    const f = fixture({ botMode: () => "full" });
    const backup = JSON.stringify({ version: 1, routines: [record("first-upgrade")] });
    mkdirSync(dirname(routinesPrePinFile(f.file)), { recursive: true });
    writeFileSync(routinesPrePinFile(f.file), backup);
    writeFileSync(f.file, JSON.stringify({ version: 1, routines: [record("legacy")] }));
    expect(f.load().listRoutines()[0]!.permissionMode).toBe("full");
    expect(readFileSync(routinesPrePinFile(f.file), "utf8")).toBe(backup);
    expect(atomic.atomicWriteCount(routinesPrePinFile(f.file))).toBe(0);
  });
  it("pins an imported package routine at Ask when it carries no ceiling", async () => {
    const bot = { autoApprove: true, fullAccess: true, noLimits: true };
    const f = fixture({ botMode: () => botPermissionMode(bot), createTask: () => ({ threadId: "00000000-0000-4000-8000-000000000004" }), startTurn: async () => {} });
    const manager = f.load();
    const prepared = manager.preparePackageAddition([record("imported", { threadId: "00000000-0000-4000-8000-000000000003" }) as never]);
    const bytes = JSON.parse(prepared.bytes.toString("utf8"));
    expect(bytes.routines[0]).not.toHaveProperty("permissionMode");
    expect(bytes.routines[0]).not.toHaveProperty("permissionExplicit");
    writeFileSync(f.file, prepared.bytes);
    prepared.publish();
    for (const current of [manager, f.load()]) {
      const routine = current.listRoutines().find((routine) => routine.id === "imported")!;
      expect(routine).not.toHaveProperty("permissionMode");
      expect(effectiveRoutinePermissionMode(routine, bot)).toBe("ask");
      expect(effectiveRoutinePermissionMode(current.routineForConversation(routine.threadId!)!, bot)).toBe("ask");
      expect(JSON.parse(readFileSync(f.file, "utf8")).routines[0]).not.toHaveProperty("permissionMode");
    }
    const queued = manager.runNow("imported")!;
    await manager.tick();
    const run = manager.runById(queued.id)!;
    expect(effectiveRoutinePermissionMode(manager.routineRunForThread(run.threadId!)!, bot)).toBe("ask");
    manager.update("imported", { name: "Still awaiting a choice" });
    expect(effectiveRoutinePermissionMode(manager.routineById("imported")!, bot)).toBe("ask");
    const chosen = manager.update("imported", { permissionMode: "full" })!;
    expect(effectiveRoutinePermissionMode(chosen, bot)).toBe("full");
    expect(chosen).not.toHaveProperty("permissionPending");
    expect(effectiveRoutinePermissionMode(f.load().routineById("imported")!, bot)).toBe("full");
  });
});

// S3b review: a queued handoff never keeps a level the routine has since lowered.
it("caps a queued peer source at the routine's current level", async () => {
  const { capQueuedPeerSource } = await import("./routine-permissions.ts");
  const queued = { permissionMode: "full", triggerSource: "schedule" } as const;
  expect(capQueuedPeerSource(queued, "ask").permissionMode).toBe("ask");
  expect(capQueuedPeerSource({ ...queued, permissionMode: "ask" }, "full").permissionMode).toBe("ask");
  expect(capQueuedPeerSource(queued, null)).toEqual(queued);
});
