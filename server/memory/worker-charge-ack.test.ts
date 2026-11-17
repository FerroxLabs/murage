// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MEMW r3.2.6 A2' (worker end of the charge IPC): the helper accepts a charge-ack only when it names the same (helperRunId, fileId,
// attempt) as the charge it is waiting on. An ack for another run id, file or attempt is ignored and never grants.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ charge: null as null | ((c: { helperRunId: string; fileId: string; attempt: number; bytes: number }) => Promise<boolean>) }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; backend = "native"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", async () => ({ MemoryIndex: class extends (await import("../testing/worker-index-mock.ts")).MockWorkerIndex {
  static override async create(path: string, opts: { charge: (c: { helperRunId: string; fileId: string; attempt: number; bytes: number }) => Promise<boolean> }) { state.charge = opts.charge; return new this(path); }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

type Sent = { type: string; helperRunId?: string; fileId?: string; attempt?: number; bytes?: number };
async function withWorker(run: (ctx: { emit: (m: unknown) => void; sent: Sent[] }) => Promise<void>) {
  vi.resetModules(); state.charge = null;
  const realProcess = process, listeners = new Map<string, (message: unknown) => void>(), sent: Sent[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (message: unknown) => void) => { if (event === "message" || event === "disconnect") { listeners.set(event, listener); return workerProcess; } listeners.set(event, listener); return workerProcess; } },
    send: { value: (message: Sent, callback?: (error: Error | null) => void) => { sent.push(message); callback?.(null); return true; } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = listeners.get("message")!;
    emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await vi.waitFor(() => expect(state.charge).not.toBeNull());
    await run({ emit, sent });
  } finally { vi.unstubAllGlobals(); vi.resetModules(); }
}

it("a charge-ack for another helperRunId, file or attempt is ignored; only the matching ack grants", async () => {
  await withWorker(async ({ emit, sent }) => {
    let answer: boolean | null = null;
    void state.charge!({ helperRunId: "fixture-run", fileId: "f1", attempt: 7, bytes: 4096 }).then(granted => { answer = granted; });
    const charge = sent.find(message => message.type === "charge")!;
    expect(charge).toMatchObject({ fileId: "f1", attempt: 7, bytes: 4096 });
    expect(typeof charge.helperRunId).toBe("string");
    const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    emit({ type: "charge-ack", fileId: "f1", attempt: 7, granted: true, helperRunId: `not-${charge.helperRunId}` });
    emit({ type: "charge-ack", fileId: "f1", attempt: 7, granted: true });
    emit({ type: "charge-ack", fileId: "f2", attempt: 7, granted: true, helperRunId: charge.helperRunId });
    emit({ type: "charge-ack", fileId: "f1", attempt: 8, granted: true, helperRunId: charge.helperRunId });
    await flush();
    expect(answer).toBeNull();                       // none of the four resolved the wait
    emit({ type: "charge-ack", fileId: "f1", attempt: 7, granted: true, helperRunId: charge.helperRunId });
    await vi.waitFor(() => expect(answer).toBe(true));
  });
});
