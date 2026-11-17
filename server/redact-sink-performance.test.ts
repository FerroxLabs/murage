// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// L5a 3B: detector and actual bus/serialization/sink timings are separate.
// These tests do not certify policy allocation bounds; 1A owns those counters.
import { cpus, loadavg } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createLabelStream, findSecretLabels, scanLabelDelta } from "../shared/md-secret-label.mjs";
import type { RuntimeEvent } from "./contracts.ts";
import { EventBus } from "./harness/bus.ts";
import { redactSecretsForSink } from "./redact.ts";

// PROVISIONAL INTERFACE: frozen F4 exists only after 1B. The base raw path is
// exercised unchanged, so a safety assertion fails on leaked bytes, not import.
function listen(bus: EventBus, callback: (value: unknown) => void) {
  const current = bus as unknown as {
    subscribeAudience?: (fn: (e: unknown) => void, options: { durable: boolean }) => () => void;
    subscribe: (fn: (e: unknown) => void, options: { durable: boolean }) => () => void;
  };
  return current.subscribeAudience ? current.subscribeAudience(callback, { durable: false })
    : current.subscribe(callback, { durable: false });
}
const HOSTILE = [
  ["labels", "**password**: alpha1234 "], ["pem", "-----BEGIN PRIVATE KEY-----"],
  ["hyphens", "a-"], ["whitespace", " \t"], ["marks", "`«»_"], ["underscores", "a_"],
  ["clean", "The next step is ready.\n"],
] as const;
function medianRun(run: () => void) {
  run(); // warmup, never included in the median
  const samples = Array.from({ length: 7 }, () => {
    const start = performance.now(); run(); return performance.now() - start;
  }).sort((a, b) => a - b);
  return samples[3]!;
}
function sample(unit: string, size: number) { return unit.repeat(Math.ceil(size / unit.length)).slice(0, size); }

describe("redact-performance", () => {
  it("redact-performance.detector", { tags: ["perf-budget"] }, () => {
    const measurements = HOSTILE.map(([shape, unit]) => {
      const small = sample(unit, 64 * 1024), large = sample(unit, 256 * 1024);
      const t64 = medianRun(() => { findSecretLabels(small); });
      const t256 = medianRun(() => { findSecretLabels(large); });
      return { shape, t64, t256, ratio: t256 / Math.max(t64, 0.1) };
    });
    console.info(JSON.stringify({ path: "detector", hardware: cpus()[0]?.model, cpus: cpus().length, load: loadavg(), measurements }));
    for (const row of measurements) {
      expect(row.t256, row.shape).toBeLessThan(250);
      expect(row.ratio, row.shape).toBeLessThan(6);
    }
  });

  it("redact-performance.end-to-end", { tags: ["perf-budget"] }, () => {
    const bus = new EventBus(() => {});
    let serializations = 0;
    const off = listen(bus, value => { redactSecretsForSink(JSON.stringify(value)); serializations++; });
    let id = 0;
    const run = (text: string) => bus.publish({ eventId: `perf-${++id}`, provider: "fake", threadId: "perf-thread",
      createdAt: "2026-11-10T00:00:00.000Z", type: "item.completed", itemType: "assistant_text", origin: "engine", text } as RuntimeEvent);
    try {
      const measurements = HOSTILE.map(([shape, unit]) => {
        const small = sample(unit, 64 * 1024), large = sample(unit, 256 * 1024);
        const t64 = medianRun(() => run(small));
        const t256 = medianRun(() => run(large));
        return { shape, t64, t256, ratio: t256 / Math.max(t64, 0.1) };
      });
      console.info(JSON.stringify({ path: "bus+serialization+sink", hardware: cpus()[0]?.model, load: loadavg(), measurements }));
      expect(serializations).toBeGreaterThan(0);
      for (const row of measurements) {
        expect(row.t256, row.shape).toBeLessThan(250);
        expect(row.ratio, row.shape).toBeLessThan(6);
      }
    } finally { off(); bus.detachAll(); }
  });

  it("redact-performance.one-unit", () => {
    // A proxy counts real scanner state operations, independently of timings.
    // This is scanner work only, not a fabricated collector allocation metric.
    function count(size: number) {
      let operations = 0;
      const state = new Proxy(createLabelStream(), {
        get(target, key, receiver) { operations++; return Reflect.get(target, key, receiver); },
        set(target, key, value, receiver) { operations++; return Reflect.set(target, key, value, receiver); },
      });
      const text = sample("ordinary words a_b\n", size);
      for (const char of text) expect(scanLabelDelta(state, char)).toBe(-1);
      expect(state.win.length).toBeLessThanOrEqual(18);
      return operations;
    }
    const small = count(16 * 1024), large = count(64 * 1024);
    expect(large).toBeLessThanOrEqual(small * 4 + 128);
    expect(large).toBeLessThan(64 * 1024 * 40);
    console.info(JSON.stringify({ path: "one-unit-scanner-state", operations16Ki: small, operations64Ki: large }));
  });

  it("redact-performance.many-streams", () => {
    // Interleaving 4,096 independent detector states must not share a latch.
    // CLEAN admission/stream-cap allocation remains the 1A policy suite's proof.
    const streams = Array.from({ length: 4096 }, () => createLabelStream());
    for (const char of "ordinary line\n") for (const state of streams) expect(scanLabelDelta(state, char)).toBe(-1);
    expect(scanLabelDelta(streams[0]!, "**password**:")).toBeGreaterThanOrEqual(0);
    for (const state of streams.slice(1)) {
      expect(scanLabelDelta(state, "still clean\n")).toBe(-1);
      expect(state.win.length).toBeLessThanOrEqual(18);
    }
  });

  it("redact-performance.end-to-end.unknown-accessor", async () => {
    let getterReads = 0;
    const unknown = Object.defineProperty({}, "tripwire", { enumerable: true, get() { getterReads++; return "PRIVATE_ACCESSOR_VALUE"; } });
    const input = { eventId: "accessor", provider: "fake", threadId: "accessor-thread", createdAt: "2026-11-10T00:00:00.000Z",
      type: "content.delta", streamKind: "assistant_text", delta: "**password**:", raw: { source: "fixture", payload: unknown } } as RuntimeEvent;
    const bus = new EventBus(() => {});
    let release!: () => void;
    let held = true;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    bus.gateDeliveries({ held: () => held, wait: () => waiting, isBusy: () => false });
    // Accounting must not stringify the raw graph, even while a writer waits.
    const current = bus as unknown as { subscribeExecution?: (fn: (e: unknown) => void) => () => void;
      subscribe: (fn: (e: unknown) => void) => () => void };
    const delivered: unknown[] = [];
    const off = current.subscribeExecution ? current.subscribeExecution(e => delivered.push(e)) : current.subscribe(e => delivered.push(e));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      bus.publish(input);
      const accountedRaw = stringify.mock.calls.some(([value]) => value === input);
      held = false; release();
      await vi.waitFor(() => expect(delivered).toHaveLength(1));
      expect(delivered[0]).toBe(input);
      expect(getterReads).toBe(0);
      expect(accountedRaw).toBe(false);
    } finally { held = false; release(); stringify.mockRestore(); off(); bus.detachAll(); }
  });
});
