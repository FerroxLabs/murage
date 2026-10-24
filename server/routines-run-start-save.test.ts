// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 04-A2: a save that fails while a due run is marked running must not leave a running run no engine is working on.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

it("a failed save of the running transition does not strand a recurring routine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murage-a2-")); dirs.push(dir);
  let now = Date.UTC(2026, 9, 21, 9);
  let task = 0;
  const started: string[] = [];
  const options: RoutineManagerOptions = {
    file: join(dir, "routines.json"),
    now: () => now,
    emit: () => {},
    botState: () => "ready",
    goalState: () => "ready",
    createTask: () => ({ threadId: `thread-${++task}` }),
    startTurn: async (botId) => { started.push(botId); },
    startGoal: async () => {},
  };
  const manager = new RoutineManager(options);
  manager.create({ botId: "bot-a", name: "Hourly", prompt: "Work", schedule: { type: "interval", everyMinutes: 60, anchorAt: now } });
  now += 61 * 60_000;
  // the disk fills exactly while the scheduler saves the queued-to-running transition
  const saveNow = vi.spyOn(manager as unknown as { saveNow: () => void }, "saveNow").mockImplementation(() => {
    if (manager.listRuns().some((run) => run.status === "running")) throw enospc();
  });
  await flush();
  await manager.tick().catch(() => {});
  await flush();
  saveNow.mockRestore(); // space is freed
  expect(started).toEqual([]);
  expect(manager.listRuns().filter((run) => run.status === "running")).toEqual([]);
  // the next occurrence is not skipped as an overlap with a ghost
  now += 61 * 60_000;
  await manager.tick(); await flush();
  expect(started).toEqual(["bot-a"]);
  manager.stop();
});
