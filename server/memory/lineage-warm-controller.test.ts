// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 (extreme scale, lineage-cold): how the lineage warmer is driven. The real MemoryWorkerController, with the warmer's step stood in for:
// a cold start asks for slices until the warmer says it is done; an owner's turn holds the slices off, and a slice already running is told to hand
// back as soon as the owner is waiting (the yield function it is given). The warmer's own steps are covered by lineage-warm-converge.test.ts.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase } from "../database.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

let controller: MemoryWorkerController;
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); });
afterEach(async () => { await controller?.stop().catch(() => {}); });

const started = (options: ConstructorParameters<typeof MemoryWorkerController>[0]) => {
  controller = new MemoryWorkerController(options);
  (controller as unknown as { started: boolean }).started = true;
  return controller;
};
const until = async (done: () => boolean, ms = 4_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); };

it("a cold start asks for slices of warming until the warmer says it has nothing more to do", async () => {
  const answers = [true, true, false];
  let calls = 0;
  started({ onLineageWarm: yieldNow => { expect(typeof yieldNow).toBe("function"); return answers[calls++] ?? false; } });
  controller.wakeLineageWarm(0);
  await until(() => calls >= 3);
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(calls, "three slices, then it stops asking").toBe(3);
});

it("an owner's turn holds the slices off until it has reached the engine, and a running slice is told to hand back while the owner waits", async () => {
  let calls = 0, yieldedWhileHeld: boolean | undefined, yieldedFree: boolean | undefined;
  started({ onLineageWarm: yieldNow => { calls++; yieldedFree = yieldNow(); return false; } });
  const release = controller.holdForTurn();
  controller.wakeLineageWarm(0);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(calls, "no slice while the owner's turn holds the worker").toBe(0);
  release();
  controller.wakeLineageWarm(0);
  await until(() => calls >= 1);
  expect(calls).toBe(1);
  expect(yieldedFree, "nobody is waiting: the slice goes on").toBe(false);
  // a slice that is running when the owner's turn arrives is told so
  let second = 0;
  controller = new MemoryWorkerController({ onLineageWarm: yieldNow => { second++; const hold = controller.holdForTurn(); yieldedWhileHeld = yieldNow(); hold(); return false; } });
  (controller as unknown as { started: boolean }).started = true;
  controller.wakeLineageWarm(0);
  await until(() => second >= 1);
  expect(yieldedWhileHeld, "an owner's turn arrived during the slice").toBe(true);
});
