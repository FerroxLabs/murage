// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Msearch review round 8: the helper that owns the index writer answers a "checkpoint" message by truncating the log and
// acknowledging, and acknowledges `ok: false` when the checkpoint was blocked.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ checkpoints: 0, result: true }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  rebuilt = false;
  prepareModel() {}
  checkpointNow() { state.checkpoints++; return state.result; }
  purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return false; }
  purgeRecords() {}
  close() {}
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Array<{ type: string; requestId?: string; ok?: boolean }> }) => Promise<void>) {
  vi.resetModules(); state.checkpoints = 0; state.result = true;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Array<{ type: string; requestId?: string; ok?: boolean }> = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } return realProcess.on(event, listener); } },
    send: { value: (message: { type: string; requestId?: string; ok?: boolean }) => { sent.push(message); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await run({ emit, sent });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}

it("a checkpoint message truncates through the index writer and is acknowledged", async () => {
  await withWorker(async ({ emit, sent }) => {
    emit({ type: "checkpoint", requestId: "c1" });
    expect(state.checkpoints).toBe(1);
    expect(sent.find(message => message.type === "checkpoint-result")).toEqual({ type: "checkpoint-result", requestId: "c1", ok: true });
  });
});

it("a blocked checkpoint is acknowledged as not done", async () => {
  await withWorker(async ({ emit, sent }) => {
    state.result = false;
    emit({ type: "checkpoint", requestId: "c2" });
    expect(sent.find(message => message.type === "checkpoint-result")).toEqual({ type: "checkpoint-result", requestId: "c2", ok: false });
  });
});
