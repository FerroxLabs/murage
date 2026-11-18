// Worker recovery owner: recall-prod-x; admission owner: scperf-p1; release owner: MAIN.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pinned: true, grant: false, debt: true, seals: 0, embeds: 0, vectors: [] as number[][] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class {
  identity = "fixture"; backend = "native";
  async embed(texts: string[]) { state.embeds++; return texts.map(() => [1]); }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class { exec() {} prepare() { return { get: () => ({ ready: 1 }) }; } close() {} } }));
vi.mock("./index.ts", async () => {
  const { BgDeferred } = await import("../bg-admission.ts");
  return { MemoryIndex: class {
    static async create() { return new this(); }
    rebuilt = false;
    prepareModel() {} purgeRecords() {} close() {} tick() {}
    purgeRolledCheckpoints() { return { done: true }; }
    maintenanceOwed() { return false; }
    writerCheckOwed() { return false; }
    stopInfo() { return null; } resetDone() { return null; } ageFillOwed() { return false; }
    async applyBatch() { return { status: "done" }; }
    async sealAndTruncate() {
      state.seals++;
      if (!state.grant) throw new BgDeferred();
      if (!state.pinned) state.debt = false;
      return { truncated: !state.pinned };
    }
    async vector(_record: unknown, _model: string, _part: number, values: number[]) {
      state.vectors.push(values);
      // WAL debt refuses writes without leaving an owed check; only an admitted checkpoint can clear it.
      if (state.debt) throw new BgDeferred();
    }
  } };
});

it("recovers a vector write after a pinned WAL reader releases, retaining its computed embedding through refused checkpoints", async () => {
  vi.resetModules(); vi.useFakeTimers();
  Object.assign(state, { pinned: true, grant: false, debt: true, seals: 0, embeds: 0, vectors: [] });
  const realProcess = process, listeners = new Map<string, (message: unknown) => Promise<void>>();
  const sent: Array<{ type: string; [key: string]: unknown }> = [];
  const workerProcess = Object.create(realProcess);
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, fn: (message: unknown) => Promise<void>) => { listeners.set(event, fn); return workerProcess; } },
    send: { value: (message: { type: string }, cb?: (error: Error | null) => void) => { sent.push(message); cb?.(null); return true; } },
    exit: { value: vi.fn() }, resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  try {
    await import("./worker.ts");
    const emit = (message: unknown) => listeners.get("message")!(message);
    await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
    await vi.advanceTimersByTimeAsync(0);
    await emit({ type: "index", requestId: "recovery", records: [{ id: "record", version: 1, scopeId: "scope", text: "fixture", deleted: false, archived: false }] });
    await vi.advanceTimersByTimeAsync(200);
    expect(state.seals).toBeGreaterThan(0);
    expect(sent.some(message => message.type === "index-result")).toBe(false);
    state.grant = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.some(message => message.type === "index-result")).toBe(false);
    state.pinned = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(sent.filter(message => message.type === "index-result")).toEqual([expect.objectContaining({ requestId: "recovery", embeddingStatus: "indexed", records: [{ id: "record", version: 1, deleted: false }] })]);
    expect(state.embeds).toBe(1);
    expect(state.vectors.length).toBeGreaterThan(1);
    for (const vector of state.vectors) expect(vector).toBe(state.vectors[0]);
  } finally {
    await listeners.get("disconnect")?.(undefined);
    vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
  }
});
