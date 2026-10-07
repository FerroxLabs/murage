// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// S3: creation and owner edits pin a ceiling; load pins legacy records once.
// Fixtures use temporary files and never dispatch a turn. The reviewer runs
// this file, routine-permissions tests and exact-command tests under Vitest.
// S3b contract: RED regressions for gaps 1-6 and the current selector for gap 7.
// Scope: adjacent tests and SendTurnInput.routeAsks only; no driver fixes.
// Checks: inspect fake protocols, decision assertions and git diff on macOS.
// Runtime checks: focused Vitest files and the routine-approvals Playwright spec
// await an equipped checkout. No Node, pnpm, Vitest or network in this lane.
// Stop after source review and a clean diff check. Runtime rounds/corrections: 0/0.
// Written: all seven gaps, four named extraction seams, fake-CLI controls.
// Evidence: source review, scope/comment checks and git diff --check passed; runtime results unobserved.
// Next: implement the named decisions, then run the focused checks in an equipped checkout.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as atomic from "./atomic.ts";
import type { SendTurnInput } from "./contracts.ts";
import type { AutoApprover } from "./auto-approve.ts";
import * as routinePermissions from "./routine-permissions.ts";
import { RoutineManager, routinesPrePinFile, type RoutineInput, type RoutineManagerOptions } from "./routines.ts";
import { botPermissionMode, effectiveRoutinePermissionMode } from "./routine-permissions.ts";

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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("routine authority", () => {
  // Gap 4: both server send paths must carry a permission-enforcement field at every level.
  it("server turns carry routeAsks below Full and stopLine at Full", () => {
    // SEAM: turnPermissionEnforcement(bot) in routine-permissions.ts, extracted from both index.ts sendTurn builders after applying the effective routine level.
    const enforcement = (routinePermissions as typeof routinePermissions & {
      turnPermissionEnforcement?: (bot: AutoApprover) => Pick<SendTurnInput, "routeAsks" | "stopLine">;
    }).turnPermissionEnforcement;
    expect(enforcement, "both server dispatch paths must opt into permission enforcement").toBeTypeOf("function");
    const profile = { autoApprove: true, fullAccess: true, noLimits: true };
    for (const mode of ["ask", "auto", "full", "unlimited"] as const) {
      const bot = routinePermissions.applyRoutinePermissionMode(profile, mode);
      expect(enforcement!(bot), mode).toEqual(mode === "ask" || mode === "auto" ? { routeAsks: true } : { stopLine: true });
      const capped = routinePermissions.applyRoutinePermissionMode(profile, effectiveRoutinePermissionMode({ permissionMode: mode }, profile));
      expect(enforcement!(capped), `routine ${mode}`).toEqual(enforcement!(bot));
    }
    expect(profile).toEqual({ autoApprove: true, fullAccess: true, noLimits: true });
  });

  it.each([undefined, "inherit", null] as const)("pins creation at Ask for input %s when the bot later rises", (permissionMode) => {
    const bot = { autoApprove: false, fullAccess: false, noLimits: false };
    const f = fixture({ botMode: () => botPermissionMode(bot) });
    const manager = f.load();
    const routine = manager.create({ ...input, ...(permissionMode === undefined ? {} : { permissionMode }) });
    expect(routine.permissionMode).toBe("ask");
    Object.assign(bot, { autoApprove: true, fullAccess: true, noLimits: true });
    expect(effectiveRoutinePermissionMode(manager.listRoutines()[0]!, bot)).toBe("ask");
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
    Object.assign(bot, { fullAccess: true, noLimits: true });
    expect(effectiveRoutinePermissionMode(ask, bot)).toBe("ask");
    const renamed = manager.update(ask.id, { name: "Named archive check" })!;
    expect(renamed.permissionMode).toBe("ask");
    expect(effectiveRoutinePermissionMode(renamed, bot)).toBe("ask");
    const raised = manager.update(ask.id, { permissionMode: "unlimited" })!;
    expect(effectiveRoutinePermissionMode(raised, bot)).toBe("unlimited");
    expect(f.load().listRoutines().find((routine) => routine.id === ask.id)?.permissionMode).toBe("unlimited");
  });

  it.each(["inherit", null] as const)("pins an explicit %s level edit to the bot at that moment", (permissionMode) => {
    const bot = { autoApprove: true, fullAccess: false, noLimits: false };
    const f = fixture({ botMode: () => botPermissionMode(bot) });
    const manager = f.load();
    const routine = manager.create({ ...input, permissionMode: "ask" });
    const updated = manager.update(routine.id, { permissionMode })!;
    expect(updated.permissionMode).toBe("auto");
    Object.assign(bot, { fullAccess: true, noLimits: true });
    expect(effectiveRoutinePermissionMode(updated, bot)).toBe("auto");
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
  it("pins an imported package routine at Ask when it carries no ceiling", () => {
    const f = fixture({ botMode: () => "unlimited" });
    const manager = f.load();
    const prepared = manager.preparePackageAddition([record("imported") as never]);
    expect(JSON.parse(prepared.bytes.toString("utf8")).routines[0].permissionMode).toBe("ask");
    prepared.publish();
    expect(manager.listRoutines().find((routine) => routine.id === "imported")?.permissionMode).toBe("ask");
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
