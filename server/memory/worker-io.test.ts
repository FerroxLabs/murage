// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3 rehearsal 2 (memory worker write storm): the helper writes the index in its own process, so the parent's io-budget never
// saw those bytes. The helper now reports its own write count (process.resourceUsage().fsWrite, the same reading the parent takes
// of itself) with every index acknowledgement and from its idle maintenance, so the budget can pace index work like any other writer.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fsWrite: 0, owed: false, purges: 0 }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; backend = "native"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  rebuilt = false;
  prepareModel() {}
  upsert() { state.fsWrite += 100; }
  vector() { state.fsWrite += 1; }
  checkpointNow() { return true; }
  // the helper starts a pass at init and after every batch that owes a merge; only an owed merge writes
  purgeRolledCheckpoints() { if (state.owed) { state.purges++; state.fsWrite += 10; } return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return state.owed; }
  purgeRecords() {}
  close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

type Sent = { type: string; requestId?: string; fsWriteBlocks?: number };
async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Sent[] }) => Promise<void>) {
  vi.resetModules(); state.fsWrite = 0; state.owed = false; state.purges = 0;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Sent[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: Sent) => { sent.push(message); return true; } },
    resourceUsage: { value: () => ({ ...realProcess.resourceUsage(), fsWrite: state.fsWrite }) },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

it("an index acknowledgement carries the helper's cumulative write count, taken after the batch was written", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
    await settle();
    const result = sent.find(message => message.type === "index-result" && message.requestId === "b1");
    expect(result).toBeDefined();
    // the batch wrote (upsert 100 + one vector): the count reported is what the process had written once the batch was done
    expect(result!.fsWriteBlocks).toBe(101);
    emit({ type: "index", requestId: "b2", records: [{ id: "r2", version: 1, scopeId: "s", text: "two", deleted: false }] });
    await settle();
    expect(sent.find(message => message.type === "index-result" && message.requestId === "b2")!.fsWriteBlocks).toBe(202);
  });
});

it("idle maintenance that wrote reports its count too, so a merge paid between batches is budgeted", async () => {
  await withWorker(async ({ emit, sent }) => {
    state.owed = true;
    emit({ type: "index", requestId: "b1", records: [{ id: "r1", version: 1, scopeId: "s", text: "one", deleted: false }] });
    // the maintenance waits for the helper to be idle (MAINTENANCE_POLL_MS), then runs its pass and reports
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !sent.some(message => message.type === "io")) await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(state.purges).toBeGreaterThan(0);
    const reports = sent.filter(message => message.type === "io").map(message => message.fsWriteBlocks);
    expect(reports.length).toBeGreaterThan(0);
    expect(Math.max(...reports.map(Number))).toBe(state.fsWrite);
  });
});
