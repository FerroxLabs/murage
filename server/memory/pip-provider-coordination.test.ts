// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { endsWithHandle } from "./handle-guard.ts";

// Execute the server callback with offline dependencies; importing index starts a server.
function fixture() {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const callback = source.slice(source.indexOf("onContinuity: async signal =>") + "onContinuity: ".length, source.indexOf(",onCompletedSource:async(jobId,signal)=>"));
  const run = vi.fn(), pending = vi.fn(async () => "bot");
  // both walks run through the closed-handle guard (1.0.3 L3, handle-guard.ts) on one open handle
  const handle = { isOpen: true }, database = () => handle;
  const host = new Function("runPipReflect", "pipReflectPendingSliced", "endsWithHandle", "database", `
    let providerConfigBusy = false, fenced = false, fluxMediaRequests = 0;
    const providerBankDispatchFenced = () => fenced, pipReflectDeps = {};
    return { dispatch: ${callback}, count: () => fluxMediaRequests,
      fence: (busy, bank) => { providerConfigBusy = busy; fenced = bank; } };
  `)(run, pending, endsWithHandle, database) as { dispatch(signal: AbortSignal): Promise<unknown>; count(): number; fence(busy: boolean, bank: boolean): void };
  return { ...host, run, pending };
}

it.each([[true, false], [false, true]])("new-high: provider fence %s/%s prevents continuity dispatch", async (busy, bank) => {
  const f = fixture(); f.fence(busy, bank);
  expect(await f.dispatch(new AbortController().signal)).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled(); expect(f.pending).not.toHaveBeenCalled();
  expect(f.count()).toBe(0);
});

it.each([false, true])("new-high: provider counter covers cancellation through adapter settlement (reject=%s)", async reject => {
  const f = fixture(), abort = new AbortController();
  let settle!: () => void;
  f.run.mockImplementation(() => new Promise((resolve, fail) => { settle = () => reject ? fail(new Error("cancelled")) : resolve("done"); }));
  const outcome = f.dispatch(abort.signal).catch(error => error.message);
  // the pending check is awaited (it runs in slices): the counter is up once the run has started
  await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
  expect(f.count()).toBe(1);
  abort.abort(); await Promise.resolve();
  expect(f.count()).toBe(1);
  settle(); expect(await outcome).toBe(reject ? "cancelled" : "done");
  expect(f.count()).toBe(0);
});
