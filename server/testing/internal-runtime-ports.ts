// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixture-side owner: sc-safety. Production class/writer owners: their modules.
import { DelegatedReplyChecks } from "../delegated-reply-check.ts";
import { PhoneAuthorities } from "../phones/authority.ts";
import { HostComputerBroker } from "../host-computer-broker.ts";
import { ComputerControl } from "../computer-control.ts";
import { MemoryWorkerController } from "../memory/worker-controller.ts";
import { WebDocuments } from "../web-documents.ts";
import { WebDocumentBudget } from "../web-document-budget.ts";
import { ToolResults } from "../tool-results.ts";
import { ProjectTurnLeases } from "../project-turn-leases.ts";
import { BrowserLifecycleGate } from "../browser-lifecycle-gate.ts";
import { AskTurnDevices } from "../ask-turn-device.ts";
import { HeldDuringQuiet } from "../desktop-attention.ts";
import { SseReplay } from "../sse-buffer.ts";
import type { StatePort } from "./source-extract.ts";
import { registerPortConstructor } from "./port-integrity.ts";

// Capture imported constructor and ancestor methods before any case hook.
for (const Constructor of [DelegatedReplyChecks, PhoneAuthorities, HostComputerBroker, ComputerControl, MemoryWorkerController, WebDocuments, WebDocumentBudget, ToolResults, ProjectTurnLeases, BrowserLifecycleGate, AskTurnDevices, HeldDuringQuiet, SseReplay]) if (typeof Constructor === "function") registerPortConstructor(Constructor);

/** Only external I/O/callback edges are configurable. Services are complete
 * production instances, with no substituted authority or admission methods. */
export interface RuntimeFixtureIo {
  hostComputerStart?: ConstructorParameters<typeof HostComputerBroker>[0];
  computerControlChanged?: ConstructorParameters<typeof ComputerControl>[0];
}
const cleanups: Array<() => unknown> = [];
const unavailableHostEngine: NonNullable<RuntimeFixtureIo["hostComputerStart"]> = () => {
  throw new Error("FIXTURE_IO_NOT_CONFIGURED host computer engine start");
};
function port<T>(name: string, fresh: () => T, reason: string, close?: (value: T) => unknown): StatePort {
  return { name, reason, fresh: () => {
    const value = fresh();
    if (close) cleanups.push(() => close(value));
    return value;
  } };
}

/** Call from each case's afterEach, including failed fixture construction.
 * Timers, in-memory SQLite reservations and pending service work belong only
 * to the instances actually materialized by source-extract's lazy state map. */
export async function closeRuntimeFixturePorts(): Promise<void> {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "FIXTURE_RUNTIME_CLEANUP_FAILED");
}

/** Standalone constructors only; no index.ts initializer is evaluated.
 * Authority registries begin empty and are seeded only by real writer calls.
 * In particular, the memory controller is never start()ed by this registry. */
export function runtimeFixturePorts(io: RuntimeFixtureIo = {}): StatePort[] {
  return [
    port("delegatedReplyChecks", () => new DelegatedReplyChecks(), "Real bounded delegated-reply scheduler.", value => value.stop()),
    port("phoneAuthorities", () => new PhoneAuthorities(),
      "Real empty phone authority registry; production mint/revoke operations only.", value => value.revokeAll()),
    port("hostComputer", () => new HostComputerBroker(io.hostComputerStart ?? unavailableHostEngine),
      "Real broker with an explicitly named external engine-start I/O edge.", value => value.drain()),
    port("computerControl", () => new ComputerControl(io.computerControlChanged),
      "Real per-case computer-control state; no desktop or broadcast I/O by default."),
    port("memoryWorker", () => new MemoryWorkerController(),
      "Real standalone, unstarted controller; no worker, idle timer or background job is launched.", value => value.stop()),
    port("webDocuments", () => {
      // The production default uses a process-shared disk ledger. A complete
      // private real ledger preserves all reservation checks without that I/O.
      const budget = new WebDocumentBudget(":memory:");
      try {
        const documents = new WebDocuments(undefined, undefined, undefined, budget);
        cleanups.push(() => { try { documents.dispose(); } finally { budget.close(); } });
        return documents;
      } catch (error) { budget.close(); throw error; }
    }, "Real document store and private in-memory reservation ledger; dispose its expiry timer after each case."),
    port("toolResults", () => new ToolResults(), "Real bounded per-case tool-result storage."),
    port("projectTurnLeases", () => new ProjectTurnLeases(),
      "Real project/folder admission registry; constructors do no path or process I/O.", value => value.disposed(value.generations())),
    port("browserLifecycle", () => new BrowserLifecycleGate(),
      "Real per-case lifecycle/session gate; no browser service is started."),
    port("askTurnDevices", () => new AskTurnDevices(), "Real empty generation-scoped device registry."),
    port("heldDuringQuiet", () => new HeldDuringQuiet(), "Real bounded quiet-hours queue.", value => value.ack()),
    port("replayBuffer", () => new SseReplay(), "Real bounded SSE replay state; no socket is created."),
  ];
}
