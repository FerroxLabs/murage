// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot d5a85c700: once stop() is called (server shutdown, a restore, a Cloud home pause) a
// scheduler pass already in flight dispatches nothing more. The runs it did not reach stay queued, not failed, and
// go out on the next start().
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

it("a stop during a dispatch keeps the rest of the pass queued until the next start", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-routine-stop-")); roots.push(root);
  let now = Date.UTC(2026, 9, 29, 9), sequence = 0;
  const started: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let manager: RoutineManager;
  manager = new RoutineManager({
    file: join(root, "routines.json"), now: () => now, dispatchOpen: () => true,
    botState: () => "ready", createTask: () => ({ threadId: `thread-${++sequence}` }),
    startTurn: async (bot) => {
      started.push(bot);
      if (started.length === 1) { manager.stop(); await held; }
    },
  });
  for (const bot of ["a", "b", "c"]) manager.create({ botId: bot, name: `Brief ${bot}`, prompt: "Brief", schedule: { type: "once", at: now + 60_000 } });
  now += 120_000;
  const pass = manager.tick();
  await vi.waitFor(() => expect(started).toHaveLength(1));
  release();
  await pass;
  await manager.tick();
  expect(started).toHaveLength(1);
  const waiting = manager.listRuns().filter((run) => run.status === "queued");
  expect(waiting).toHaveLength(2);
  manager.start();
  await vi.waitFor(() => expect([...started].sort()).toEqual(["a", "b", "c"]));
  manager.stop();
});
