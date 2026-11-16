// SPDX-License-Identifier: AGPL-3.0-or-later
// Permit issuer owner: scperf-p1. Checked helper acknowledgement owner: scperf-p1.
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ reason: "age-blocked", owed: false, trace: [] as string[] }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class {
  identity = "fixture"; backend = "native";
  async embed(texts: string[]) { return texts.map(() => [1]); }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class { exec() {} prepare() { return { get: () => ({ ready: 1 }) }; } close() {} } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  static async create() { return new this(); }
  rebuilt = false;
  prepareModel() {} purgeRecords() {} close() {} tick() {}
  purgeRolledCheckpoints() { return { done: true }; }
  maintenanceOwed() { return false; }
  async maintenanceStep() { state.trace.push("check"); state.owed = false; return { ran: null, gateClear: true }; }
  writerCheckOwed() { return state.owed; }
  stopInfo() { return null; } resetDone() { return null; } ageFillOwed() { return false; }
  async applyBatch() {
    state.owed = state.reason !== "pending-grant";
    if (state.reason === "pending-grant") (await import("./helper-admission.ts")).helperHasGrant(2048);
    return state.reason === "done" || state.reason === "pending-grant" ? { status: "done" } : { status: "failed", reason: state.reason, committed: 1 };
  }
} }));

for (const reason of ["age-blocked", "segment-gate", "merge-floor", "done", "pending-grant"]) {
  it(`settles an owed check and unused permit before the ${reason} acknowledgement`, async () => {
    vi.resetModules(); vi.useFakeTimers(); Object.assign(state, { reason, owed: false, trace: [] });
    const realProcess = process, listeners = new Map<string, (message: unknown) => Promise<void>>();
    const sent: Array<{ type: string; [key: string]: unknown }> = [];
    const workerProcess = Object.create(realProcess);
    Object.defineProperties(workerProcess, {
      on: { value: (event: string, fn: (message: unknown) => Promise<void>) => { listeners.set(event, fn); return workerProcess; } },
      send: { value: (message: { type: string }, cb?: (error: Error | null) => void) => {
        sent.push(message);
        if (message.type === "index-result") state.trace.push("ack");
        if (message.type === "bg-grant-settle") state.trace.push("settle");
        if (message.type === "bg-grant-request") {
          state.trace.push("request");
          setTimeout(() => void listeners.get("message")!({ type: "bg-grant", ticket: { id: "in-flight", bytes: 2048, expiresAt: Date.now() + 60_000 } }), 25);
        }
        cb?.(null); return true;
      } },
      exit: { value: vi.fn() }, resourceUsage: { value: () => realProcess.resourceUsage() },
    });
    vi.stubGlobal("process", workerProcess);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("./worker.ts");
      const emit = (message: unknown) => listeners.get("message")!(message);
      await emit({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
      await vi.advanceTimersByTimeAsync(0);
      if (reason !== "pending-grant") await emit({ type: "bg-grant", ticket: { id: "unused", bytes: 1024, expiresAt: Date.now() + 60_000 } });
      state.trace = [];
      await emit({ type: "index", requestId: "checked", records: [{ id: "committed", version: 1, scopeId: "scope", text: "fixture", deleted: false, archived: true }] });
      await vi.advanceTimersByTimeAsync(200);
      // MAIN RULING 2026-11-14 the checked batch must return its unused permit BEFORE acknowledgement; zero outstanding
      expect(state.trace).toEqual([reason === "pending-grant" ? "request" : "check", "settle", "ack"]);
      expect(state.owed).toBe(false);
      expect(sent.filter(message => message.type === "bg-grant-settle")).toEqual([{ type: "bg-grant-settle", id: reason === "pending-grant" ? "in-flight" : "unused", used: 0 }]);
      expect(sent.filter(message => message.type === "index-result")).toEqual([expect.objectContaining({ requestId: "checked", records: [{ id: "committed", version: 1, deleted: false }] })]);
    } finally {
      await listeners.get("disconnect")?.(undefined);
      vi.clearAllTimers(); errors.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.resetModules();
    }
  });
}
