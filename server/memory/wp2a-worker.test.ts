import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  step: { ran: null, gateClear: true } as { ran: string | null; gateClear?: boolean; drain?: boolean },
  stopped: false, owed: false, age: false, fill: 0, sweep: 0, maintenance: 0, seals: 0,
  sealResults: [true] as Array<boolean | Error>,
  stop: null as null | { fileId: string; seq: number; kind: string; reason: string },
  resetDone: 17, creates: [] as unknown[], openingError: false,
}));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; backend = "native"; } }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } close() {} } }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class {
  exec() {} prepare() { return { get: () => ({ ready: 1 }) }; } close() {}
} }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create(_path: string, options: unknown) { state.creates.push(options); return new this(); }
  rebuilt = false;
  prepareModel() {} purgeRecords() {} close() {} tick() {}
  purgeRolledCheckpoints() { return { done: true }; }
  maintenanceOwed() { return false; }
  async maintenanceStep() { state.maintenance++; return state.step; }
  writerStopped() { return state.stopped; }
  writerCheckOwed() { return state.owed; }
  stopInfo() { return state.stop; }
  resetDone() { return state.resetDone; }
  ageFillOwed() { return state.age; }
  fillAgeIndex() { state.fill++; return { done: true }; }
  sweepAgeRowids() { state.sweep++; return { done: true }; }
  async sealAndTruncate() {
    state.seals++;
    const result = state.sealResults.shift();
    if (result instanceof Error) throw result;
    return { truncated: result ?? true };
  }
} }));
type Message = { type: string; requestId?: number; on?: boolean; [key: string]: unknown };
const flush = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const flushNow = flush;
async function withWorker(run: (emit: (m: unknown) => Promise<void>, sent: Message[], exit: ReturnType<typeof vi.fn>) => Promise<void>, age = false, initialStop: typeof state.stop = null, init: Record<string, unknown> = {}) {
  vi.resetModules(); vi.useFakeTimers();
  Object.assign(state, { step: { ran: null, gateClear: true }, stopped: false, owed: false, age,
    fill: 0, sweep: 0, maintenance: 0, seals: 0, sealResults: [true], stop: initialStop, resetDone: 17, creates: [] });
  const exit = vi.fn(), realProcess = process, listeners = new Map<string, (m: unknown) => Promise<void>>(), sent: Message[] = [];
  const workerProcess = Object.create(realProcess);
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, fn: (m: unknown) => Promise<void>) => { listeners.set(event, fn); return workerProcess; } },
    // process.send(message, callback): the callback answers at once (an error when a test closes the channel)
    send: { value: (m: Message, cb?: (error: Error | null) => void) => { sent.push(m); if (typeof cb === "function") cb(state.openingError && m.type === "index-opening" ? new Error("channel closed") : null); return true; } },
    exit: { value: exit },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("./worker.ts");
    const emit = (m: unknown) => listeners.get("message")!(m);
    const initDone = emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model",
      manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] }, ...init });
    if (!state.openingError) await initDone; else await flushNow();
    // Age tests control the first timer. Protocol tests finish the startup sweep first.
    if (!age) await vi.advanceTimersByTimeAsync(0);
    await run(emit, sent, exit);
  } finally {
    // Acknowledge any outstanding hold before discarding fake timers.
    for (const m of sent.filter(m => m.type === "wal-drain")) await listeners.get("message")?.({ type: "wal-drain-ack", requestId: m.requestId });
    await flush();
    await listeners.get("disconnect")?.(undefined);
    vi.clearAllTimers(); errors.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
  }
}

it("age fill and sweep wait when maintenance ran", async () => withWorker(async () => {
  state.step = { ran: "merge", gateClear: true };
  await vi.advanceTimersByTimeAsync(0);
  expect(state.maintenance).toBe(1); expect(state.fill).toBe(0); expect(state.sweep).toBe(0);
}, true));
it("age fill and sweep require gateClear true including a missing field", async () => withWorker(async () => {
  state.step = { ran: null };
  await vi.advanceTimersByTimeAsync(0);
  expect(state.maintenance).toBe(1); expect(state.fill).toBe(0); expect(state.sweep).toBe(0);
  state.step = { ran: null, gateClear: false };
  await vi.advanceTimersByTimeAsync(51);
  expect(state.maintenance).toBe(2); expect(state.fill).toBe(0); expect(state.sweep).toBe(0);
}, true));
it("age fill and sweep wait for a stopped writer", async () => withWorker(async () => {
  state.stopped = true;
  await vi.advanceTimersByTimeAsync(0);
  expect(state.maintenance).toBe(1); expect(state.fill).toBe(0); expect(state.sweep).toBe(0);
}, true));
it("age fill and sweep wait for an owed writer check", async () => withWorker(async () => {
  state.owed = true;
  await vi.advanceTimersByTimeAsync(0);
  expect(state.maintenance).toBe(1); expect(state.fill).toBe(0); expect(state.sweep).toBe(0);
}, true));
it("age fill runs and reports index-aged when every gate is clear", async () => withWorker(async (_emit, sent) => {
  await vi.advanceTimersByTimeAsync(0);
  expect(state.fill).toBe(1);
  expect(sent.filter(m => m.type === "index-aged")).toEqual([{ type: "index-aged" }]);
  await vi.advanceTimersByTimeAsync(1);
  expect(state.sweep).toBe(1);
}, true));
it("drain waits for ack and retries sealing until truncated before releasing hold", async () => withWorker(async (emit, sent) => {
  state.step = { ran: null, drain: true }; state.sealResults = [false, true];
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  const on = sent.filter(m => m.type === "wal-drain");
  expect(on).toEqual([{ type: "wal-drain", requestId: 1, on: true }]); expect(state.seals).toBe(0);
  await emit({ type: "wal-drain-ack", requestId: 999 }); await flush(); expect(state.seals).toBe(0);
  await emit({ type: "wal-drain-ack", requestId: 1 }); await flush();
  expect(state.seals).toBe(1); expect(sent.filter(m => m.type === "wal-drain")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(50);
  expect(state.seals).toBe(2);
  expect(sent.filter(m => m.type === "wal-drain")).toEqual([...on, { type: "wal-drain", requestId: 2, on: false }]);
  await emit({ type: "wal-drain-ack", requestId: 2 }); await flush();
}, true));
it("drain releases hold even when sealing throws", async () => withWorker(async (emit, sent) => {
  state.step = { ran: null, drain: true }; state.sealResults = [new Error("fixture seal failure")];
  await vi.advanceTimersByTimeAsync(0); await flush();
  await emit({ type: "wal-drain-ack", requestId: 1 }); await flush();
  expect(state.seals).toBe(1);
  expect(sent.filter(m => m.type === "wal-drain")).toEqual([
    { type: "wal-drain", requestId: 1, on: true }, { type: "wal-drain", requestId: 2, on: false },
  ]);
  await emit({ type: "wal-drain-ack", requestId: 2 }); await flush();
}, true));
it("index-stop is reported once per fileId and seq", async () => withWorker(async (_emit, sent) => {
  // every maintenance pass reports the stop; the age loop waits MAINTENANCE_POLL_MS between passes while gateClear is absent
  state.step = { ran: null };
  state.stop = { fileId: "a", seq: 1, kind: "merge", reason: "fixture" };
  await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(51);
  state.stop = { ...state.stop, seq: 2 }; await vi.advanceTimersByTimeAsync(51); await vi.advanceTimersByTimeAsync(51);
  state.stop = { ...state.stop, fileId: "b" }; await vi.advanceTimersByTimeAsync(51); await vi.advanceTimersByTimeAsync(51);
  expect(sent.filter(m => m.type === "index-stop")).toEqual([
    { type: "index-stop", fileId: "a", seq: 1, kind: "merge", reason: "fixture" },
    { type: "index-stop", fileId: "a", seq: 2, kind: "merge", reason: "fixture" },
    { type: "index-stop", fileId: "b", seq: 2, kind: "merge", reason: "fixture" },
  ]);
}, true));
it("init carries R into MemoryIndex.create({charge, reset}); an init without R passes no reset (r3.2.8 3.2)", async () => {
  await withWorker(async () => {
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).toMatchObject({ reset: { resetId: 29, resets: 2, kind: "fill" } });
  }, false, null, { reset: { resetId: 29, resets: 2, kind: "fill" } });
  await withWorker(async () => {
    expect(state.creates).toHaveLength(1);
    expect(state.creates[0]).not.toHaveProperty("reset");
  });
});
it("reset-exit exits at once with no close; the worker has no live reset message any more (r3.2.8 section 8)", async () => withWorker(async (emit, sent, exit) => {
  const closes = vi.spyOn((await import("./index.ts")).MemoryIndex.prototype, "close");
  await emit({ type: "reset", resetId: 23, resets: 1, kind: "fill" });
  expect(sent.some(m => m.type === "reset-result")).toBe(false);
  expect(exit).not.toHaveBeenCalled();
  await emit({ type: "reset-exit" });
  expect(exit).toHaveBeenCalledWith(0);
  expect(closes).not.toHaveBeenCalled();
}));

it("initialised carries resetDone, walOverStop and stop", async () => withWorker(async (_emit, sent) => {
  expect(sent.find(m => m.type === "initialised")).toEqual({ type: "initialised", reset: false, resetDone: 17, walOverStop: state.stop, stop: state.stop, wasm: false, scrubOwed: false });
}, false, { fileId: "startup", seq: 8, kind: "merge", reason: "fixture" }));

it("index-opening is sent before MemoryIndex.create, which runs only after the send callback (r3.2.8-H.1 6)", async () => withWorker(async (_emit, sent) => {
  const types = sent.map(m => m.type);
  expect(types.indexOf("index-opening")).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("index-opening")).toBeLessThan(types.indexOf("initialised"));
  expect(state.creates).toHaveLength(1);
}));
it("a failed index-opening send (the channel closed) exits 0 and never opens the index", async () => {
  state.openingError = true;
  try {
    await withWorker(async (_emit, sent, exit) => {
      expect(exit).toHaveBeenCalledWith(0);
      expect(state.creates).toHaveLength(0);
      expect(sent.some(m => m.type === "initialised")).toBe(false);
    });
  } finally { state.openingError = false; }
});
it("every charge message carries opening from the index's flag (H.1 1)", async () => withWorker(async (_emit, sent) => {
  const send = (state.creates[0] as { charge: (c: unknown) => Promise<boolean> }).charge;
  void send({ helperRunId: "h", fileId: "f", attempt: 1, bytes: 5, opening: true });
  void send({ helperRunId: "h", fileId: "f", attempt: 2, bytes: 6, opening: false });
  void send({ helperRunId: "h", fileId: "f", attempt: 3, bytes: 7 });
  const charges = sent.filter(m => m.type === "charge");
  expect(charges.map(m => m.opening)).toEqual([true, false, false]);
}));
