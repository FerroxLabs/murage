// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.2 rc3f: the held-turn tick claims the starting turn's capture with no lock wait. A busy writer lock there is
// "try again next tick": it must not throw out of the timer callback (that would take the server down), and the
// capture is claimed on the next tick.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, DatabaseBusyError } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { ownerFirst } from "../owner-first.ts";
import { resetParkSweep } from "./park.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";
import { resetWorkerLog } from "./worker-log.ts";
import { resetMemoryClaimCursor } from "./jobs.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const gate = vi.hoisted(() => ({ busy: 0, calls: 0 }));
vi.mock("./jobs.ts", async importOriginal => {
  const original = await importOriginal<typeof import("./jobs.ts")>();
  return { ...original, claimMemoryJob: (...args: Parameters<typeof original.claimMemoryJob>) => {
    gate.calls++;
    if (gate.busy > 0) { gate.busy--; throw new DatabaseBusyError("claim", 0); }
    return original.claimMemoryJob(...args);
  } };
});

type Internals = { child: unknown; ready: boolean };
let controller: MemoryWorkerController, internals: Internals, sent: Array<Record<string, any>>, releases: Array<() => void>;
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => { uncaught.push(error); };

beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); resetParkSweep(); resetMemoryClaimCursor(); resetWorkerLog();
  sent = []; releases = []; gate.busy = 0; gate.calls = 0; uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date"] });
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { kill() {}, on() {}, send: (message: any) => { sent.push(message); } };
  internals.ready = true;
});
afterEach(async () => { process.off("uncaughtException", onUncaught); for (const release of releases.splice(0)) release(); await controller.stop().catch(() => {}); vi.useRealTimers(); vi.restoreAllMocks(); });

it("a busy writer lock during the held-turn tick neither throws nor crashes, and the capture is claimed on the next tick", async () => {
  appendMessage("turn-thread", { id: "p1", at: Date.now(), role: "user", kind: "text", text: "The owner's prompt that this turn sends to its engine" });
  releases.push(ownerFirst.beginStart("turn-thread"));
  gate.busy = 2;
  controller.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(gate.calls).toBeGreaterThan(0);
  expect(sent.filter(m => m.stage === "capture")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(uncaught).toEqual([]);
  expect(sent.filter(m => m.stage === "capture")).toHaveLength(1);
});
