// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// INTEL-SMOKE-WORKER-EXIT, the controlled half of worker-disconnect-race.test.ts: a failed send is an "error" event on process.
// A closed channel is expected at a quit and the disconnect handler still closes the index; anything else reaches the log.
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ closed: 0 }));
vi.mock("./embeddings.ts", () => ({ MemoryEmbeddings: class { identity = "fixture"; embed(texts: string[]) { return Promise.resolve(texts.map(() => [1])); } } }));
vi.mock("./index.ts", () => ({ MemoryIndex: class {
  rebuilt = false;
  prepareModel() {}
  purgeRolledCheckpoints() { return { removed: 0, examined: 0, merged: false, done: true }; }
  maintenanceOwed() { return false; }
  purgeRecords() {}
  close() { state.closed++; }
} }));
vi.mock("./eligibility.ts", () => ({ MemoryEligibility: class { pipRecordIds() { return []; } warm() {} close() {} } }));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.restoreAllMocks(); });

async function helper() {
  vi.resetModules(); state.closed = 0;
  const realProcess = process, listeners = new Map<string, (value?: unknown) => void>(), exits: number[] = [];
  const workerProcess = Object.create(realProcess) as NodeJS.Process;
  Object.defineProperties(workerProcess, {
    on: { value: (event: string, listener: (value?: unknown) => void) => { listeners.set(event, listener); return workerProcess; } },
    send: { value: () => true },
    exit: { value: (code: number) => { exits.push(code); } },
    resourceUsage: { value: () => realProcess.resourceUsage() },
  });
  vi.stubGlobal("process", workerProcess);
  await import("./worker.ts");
  listeners.get("message")!({ type: "init", indexPath: "/unused/index", authorityPath: "/unused/authority", modelDirectory: "/unused/model", manifest: { model: "fixture", revision: "1", dimensions: 1, files: [] } });
  return { listeners, exits };
}
const sendFailure = (code: string) => Object.assign(new Error(`write ${code}`), { code });

it("a report that meets a closed channel is quiet, and disconnect still closes the index and exits 0", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { listeners, exits } = await helper();
  for (const code of ["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"]) listeners.get("error")!(sendFailure(code));
  expect(log).not.toHaveBeenCalled();
  expect(state.closed).toBe(0);
  listeners.get("disconnect")!();
  expect(state.closed).toBe(1);
  expect(exits).toEqual([0]);
});

it("any other failed send reaches the log", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { listeners } = await helper();
  listeners.get("error")!(sendFailure("ENOBUFS"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("message send failed"));
});
