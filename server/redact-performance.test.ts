import { describe, it, expect } from "vitest";
import * as labels from "../shared/md-secret-label.mjs";
const scan = (s: string) => {
  const f = (labels as unknown as { scanSecretText?: (s: string) => { workUnits: number; exhausted: boolean } }).scanSecretText;
  return f ? f(s) : { workUnits: 0, exhausted: false };
};
describe("redact-performance", () => {
  it("redact-performance.detector", () => {
    for (const unit of ["**password**: alpha ", "token:", "a-", " ", "`", "«", "a_", "-----BEGIN PRIVATE KEY-----\n"]) {
      const r = scan(unit.repeat(Math.ceil(262144 / unit.length)).slice(0, 262144)); expect(r.workUnits).toBeGreaterThan(0); expect(r.workUnits).toBeLessThanOrEqual(1048576);
    }
  });
  it("redact-performance.one-unit", () => {
    const st = labels.createLabelStream(); let hit = false;
    for (const c of "**password**" + " ".repeat(600) + ":") if (labels.scanLabelDelta(st, c) >= 0) hit = true;
    expect(hit).toBe(true); expect((st as unknown as { units: number }).units).toBeLessThanOrEqual(4 * 620);
  });
});

// F2 is measured separately from 1B's real bus/serialization path; Wave 3B
// owns the final end-to-end collector benchmark on the integrated head.
import { cpus, loadavg, totalmem } from "node:os";
import { createTurnTextPolicy, type TurnAdmission, type ManifestBatch } from "./redact-turn.ts";
const batch = (text: string, stream: string): ManifestBatch => ({
  envelope: { eventId: "e", instanceId: "i", threadId: "t", generation: 1, intakeOrdinal: 1, createdAt: 0 },
  variant: "M15", carriers: [{ text, stream, path: "delta", mode: "delta" }], controls: {},
});
it("redact-performance.many-streams", () => {
  const p = createTurnTextPolicy();
  for (let i = 0; i < 64; i++) {
    const cap = {} as TurnAdmission; p.admit(cap);
    for (let j = 0; j < 64; j++) p.consume(cap, batch("clean", `s${j}`));
  }
  expect(p.stats()).toMatchObject({ clean: 64, streams: 4096, pending: 20480 });
  expect(p.stats().units).toBeLessThan(4096 * 32);
});
it("redact-performance.one-unit-policy", () => {
  const p = createTurnTextPolicy(), cap = {} as TurnAdmission; p.admit(cap);
  for (let i = 0; i < 65536; i++) p.consume(cap, batch("x", "s"));
  expect(p.stats().pending).toBe(65536);
  expect(p.stats().units).toBeLessThanOrEqual(65536 * 18);
  expect(p.finish(cap, "complete").masked).toBe(false);
  expect(p.stats().units).toBeLessThanOrEqual(65536 * 26);
});
it("redact-performance.detector-timing", { tags: ["perf-budget"] }, () => {
  console.info("l5a1a detector fixture", JSON.stringify({ cpu: cpus()[0]?.model, cores: cpus().length, memory: totalmem(), load: loadavg() }));
  const median = (s: string) => {
    scan(s); const times = Array.from({ length: 7 }, () => { const at = performance.now(); scan(s); return performance.now() - at; }).sort((a, b) => a - b);
    return times[3];
  };
  for (const unit of ["clean text ", "**password**: alpha ", "token:", "a-", " ", "`", "«", "a_", "-----BEGIN PRIVATE KEY-----\n"]) {
    const build = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    const small = median(build(65536)), large = median(build(262144));
    console.info(JSON.stringify({ path: "detector", unit, median64: small, median256: large, ratio: large / Math.max(1, small), exhausted64: scan(build(65536)).exhausted, exhausted256: scan(build(262144)).exhausted }));
    expect(large).toBeLessThan(250); expect(large / Math.max(1, small)).toBeLessThan(6);
  }
});
