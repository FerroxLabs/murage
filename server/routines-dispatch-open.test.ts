// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The scheduler dispatches nothing until its host says the state a dispatch
// reads exists (rehearsal 2, 1.0.3: a run due at boot dispatched while
// server/index.ts was still being evaluated, threw, and wedged its thread).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager } from "./routines.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });

it("holds due, manual and webhook work until dispatch opens, then runs it on the first tick", async () => {
  const root = mkdtempSync(join(tmpdir(), "murage-dispatch-open-")); roots.push(root);
  let now = Date.UTC(2026, 9, 19, 9), open = false, sequence = 0;
  const started: string[] = [];
  const manager = new RoutineManager({
    file: join(root, "routines.json"), now: () => now, dispatchOpen: () => open,
    botState: () => "ready", createTask: () => ({ threadId: `thread-${++sequence}` }),
    startTurn: async (_bot, _thread, _prompt, _runOn, trigger) => { started.push(trigger); },
  });
  manager.create({ botId: "a", name: "Brief", prompt: "Brief", schedule: { type: "once", at: now + 60_000 } });
  const manual = manager.create({ botId: "b", name: "Manual", prompt: "Work", schedule: { type: "once", at: now + 86_400_000 } });
  now += 120_000;
  manager.start();
  manager.runNow(manual.id);
  manager.enqueueWebhook({ webhookId: "hook", webhookName: "Hook", prompt: "Hook", botId: "c", runOn: "ember", deliveryId: "d1", receivedAt: now });
  await manager.tick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(started).toEqual([]);
  open = true;
  await manager.tick();
  await vi.waitFor(() => expect([...started].sort()).toEqual(["manual", "schedule", "webhook"]));
  manager.stop();
});
