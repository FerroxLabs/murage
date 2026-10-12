// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.2 round 2, P2-A: extractions waiting for the owner-first gate are not work in progress. A steady stream of
// them (one every ten seconds, each waiting up to 120 s) kept the idle learning lanes from ever asking the gate.
// Also: a forget does not wait for the owner (it is a synchronous write, not an engine call) and its derived
// cleanup is not gated either, so it completes under sustained owner pressure.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerFirst } from "../owner-first.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { forgetMemory, memoryDeletionStatus } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

type Internals = { child: unknown; ready: boolean; onWorkerMessage(child: unknown, message: unknown): void };
let controller: MemoryWorkerController | undefined;
let release: (() => void) | undefined;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => { release?.(); release = undefined; await controller?.stop().catch(() => {}); controller = undefined; closeDatabase(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("a steady stream of extractions waiting for the owner does not keep the idle learning lanes from running", async () => {
  setMemoryMode("capture");
  const idle = vi.fn(async () => false);
  const extracted: string[] = [];
  controller = new MemoryWorkerController({ onIdleConsolidation: idle, onCompletedSource: async id => { extracted.push(id); } });
  release = ownerFirst.beginOwnerTurn(); // the owner is in a long turn, the whole time
  controller.start();
  // An arrival every ten seconds, each waiting up to the 120 s bound: the waiting set is never empty after the first.
  for (let at = 0; at < 300; at += 10) { controller.completedSource(`source-${at}`); await vi.advanceTimersByTimeAsync(10_000); }
  expect(idle.mock.calls.length).toBeGreaterThan(0); // the idle lanes asked the gate and were admitted at its bound
  expect(extracted.length).toBeGreaterThan(0); // and the extractions were not starved either
});

it("an extraction that was waiting is tracked apart from running work, and stop() still waits for it", async () => {
  setMemoryMode("capture");
  controller = new MemoryWorkerController({ onIdleConsolidation: async () => false, onCompletedSource: async () => {} });
  release = ownerFirst.beginOwnerTurn();
  controller.start();
  controller.completedSource("waiting");
  const internals = controller as unknown as { consolidationTasks: Set<unknown>; admissionWaiters: Set<unknown> };
  expect(internals.consolidationTasks.size).toBe(0);
  expect(internals.admissionWaiters.size).toBe(1);
  await controller.stop();
  expect(internals.admissionWaiters.size).toBe(0);
});

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
it("a forget completes, and its derived cleanup runs, while the owner is in a turn", async () => {
  setMemoryMode("active"); reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  const turn = memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", turn);
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  database().prepare("UPDATE memory_jobs SET status='cancelled'").run(); // no extraction job: only the index work is under test
  database().prepare("INSERT OR IGNORE INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(record);

  controller = new MemoryWorkerController();
  const internals = controller as unknown as Internals;
  const indexed: Array<{ id: string; deleted: boolean }> = [];
  internals.child = { kill() {}, on() {}, send: (message: any) => {
    if (message.type === "index") { indexed.push(...message.records.map((r: any) => ({ id: r.id, deleted: r.deleted }))); internals.onWorkerMessage(internals.child, { type: "index-result", requestId: message.requestId, records: message.records, embeddingStatus: "indexed" }); }
  } };
  internals.ready = true;
  controller.start();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(indexed.some(r => r.id === record && !r.deleted)).toBe(true);

  release = ownerFirst.beginOwnerTurn(); // sustained owner pressure from here on
  const admit = vi.spyOn(ownerFirst, "admit");
  const result = forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(result.status).toBe("excluded");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(indexed.some(r => r.id === record && r.deleted)).toBe(true);
  expect(memoryDeletionStatus().pending).toBe(0);
  expect(admit.mock.calls.filter(([kind]) => /forget|projection|index/.test(String(kind)))).toEqual([]);
});
