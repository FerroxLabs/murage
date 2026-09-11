// Schema v1 engine lifecycle diagnostics (R1-T8): shape, bounds and privacy of
// the recorder itself. ACP wiring against the fake CLI lives in acp.test.ts.
import { describe, expect, it } from "vitest";

import {
  createLifecycleRecorder,
  LIFECYCLE_MAX_EVENT_BYTES,
  type LifecycleRecord,
  type LifecycleSink,
} from "./lifecycle-diagnostic.ts";

function capture() {
  const rows: Array<{ threadId: string; dir: string; source: string; msg: LifecycleRecord; json: string }> = [];
  const sink: LifecycleSink = (threadId, entry) => rows.push({ threadId, ...entry, json: JSON.stringify(entry.msg) });
  return { rows, sink, events: () => rows.map((row) => row.msg.event) };
}
const identity = { threadId: "thread-1", driver: "grokAgent", instanceId: "grok-main", turnId: "turn-1" };

describe("engine lifecycle recorder", () => {
  it("writes schema v1 records correlated by generation and monotonic sequence", () => {
    const { rows, sink } = capture();
    let clock = 1_000;
    const recorder = createLifecycleRecorder({ ...identity, sink, now: () => clock, platform: "linux" });
    recorder.record("spawn_requested");
    clock += 12;
    recorder.record("spawned", { pid: 4321 });
    recorder.record("rpc_requested", { rpcId: 1, method: "initialize" });
    expect(rows.map((row) => [row.threadId, row.dir, row.source])).toEqual(Array(3).fill(["thread-1", "lifecycle", "murage.engine-lifecycle"]));
    expect(rows[0].msg).toEqual({
      type: "engine_lifecycle",
      schema: 1,
      event: "spawn_requested",
      processGeneration: recorder.generation,
      sequence: 1,
      driver: "grokAgent",
      instanceId: "grok-main",
      turnId: "turn-1",
      appVersion: null,
      engineVersion: null,
      platform: "linux",
      elapsedMs: 0,
    });
    expect(rows[1].msg).toMatchObject({ event: "spawned", pid: 4321, sequence: 2, elapsedMs: 12 });
    expect(rows[2].msg).toMatchObject({ event: "rpc_requested", rpcId: 1, method: "initialize", sequence: 3 });
    expect(recorder.generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(rows)).not.toContain("thread-1\",\"type");
    expect(rows.every((row) => !("threadId" in row.msg))).toBe(true);
  });

  it("gives every child its own generation so PID reuse is not one process", () => {
    const { rows, sink } = capture();
    const first = createLifecycleRecorder({ ...identity, sink });
    const second = createLifecycleRecorder({ ...identity, turnId: "turn-2", sink });
    first.record("spawned", { pid: 77 });
    second.record("spawned", { pid: 77 });
    expect(first.generation).not.toBe(second.generation);
    expect(rows.map((row) => row.msg.processGeneration)).toEqual([first.generation, second.generation]);
    expect(rows.map((row) => row.msg.sequence)).toEqual([1, 1]);
  });

  it("retains the close (code, signal) pair, including a raw Windows exit value", () => {
    const { rows, sink } = capture();
    const windows = createLifecycleRecorder({ ...identity, sink, platform: "win32" });
    windows.record("closed", { code: 1073807364, signal: null, settled: false, cancelRequested: false, promptSent: true });
    const posix = createLifecycleRecorder({ ...identity, sink, platform: "darwin" });
    posix.record("closed", { code: null, signal: "SIGTERM", settled: true, cancelRequested: true, promptSent: true });
    expect(rows[0].msg).toMatchObject({ platform: "win32", code: 1073807364, signal: null, settled: false, cancelRequested: false, promptSent: true });
    expect(rows[1].msg).toMatchObject({ platform: "darwin", code: null, signal: "SIGTERM", settled: true, cancelRequested: true });
  });

  it("allowlists methods and errno, bounding pending methods at close", () => {
    const { rows, sink } = capture();
    const recorder = createLifecycleRecorder({ ...identity, sink });
    recorder.record("rpc_requested", { rpcId: 9, method: "_x.ai/private-vendor-call?token=abc" });
    recorder.record("spawn_failed", { errno: "ENOENT" });
    recorder.record("stop_route_result", { route: "posix_group_sigterm", result: "failed", errno: "EWEIRD: /Users/someone/secret" });
    recorder.record("closed", {
      code: 1,
      signal: null,
      pendingMethods: ["session/prompt", "vendor/one", "initialize", "session/prompt", "vendor/two"],
      pendingCount: 5,
    });
    expect(rows[0].msg.method).toBe("other");
    expect(rows[1].msg.errno).toBe("ENOENT");
    expect(rows[2].msg.errno).toBe("other");
    expect(rows[3].msg).toMatchObject({ pendingMethods: ["initialize", "other", "session/prompt"], pendingCount: 5 });
    expect(JSON.stringify(rows)).not.toMatch(/private-vendor|token=abc|someone|EWEIRD/);
  });

  it("refuses secret-shaped identity and invalid fields instead of masking them into the trace", () => {
    const { rows, sink, events } = capture();
    const canary = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
    const leaky = createLifecycleRecorder({ ...identity, turnId: canary, sink });
    leaky.record("spawn_requested");
    leaky.record("rpc_requested", { rpcId: 1, method: "initialize" });
    leaky.record("closed", { code: 0, signal: null });
    expect(events()).toEqual(["events_omitted"]);
    expect(rows[0].msg).toMatchObject({ omitted: 3, omittedReason: "invalid" });
    expect(JSON.stringify(rows)).not.toContain("sk-ant");

    const strict = createLifecycleRecorder({ ...identity, sink });
    strict.record("closed", { code: 0, signal: "SIGNOTREAL" });
    strict.record("rpc_rejected", { rpcId: -999, rpcCode: -32603 });
    strict.record("rpc_rejected", { rpcCode: -32603, httpStatus: 42 });
    strict.record("rpc_rejected", { rpcCode: -32603, httpStatus: 500 });
    strict.record("closed", { code: 0, signal: null });
    const strictRows = rows.slice(1).map((row) => row.msg);
    expect(strictRows.map((msg) => msg.event)).toEqual(["events_omitted", "rpc_rejected", "events_omitted", "closed"]);
    expect(strictRows[0]).toMatchObject({ omitted: 1, omittedReason: "invalid" });
    expect(strictRows[1]).toMatchObject({ rpcCode: -32603, httpStatus: 500 });
    expect(strictRows[2]).toMatchObject({ omitted: 2, omittedReason: "invalid" });
  });

  it("omits an over-size record and keeps the 2 KiB default", () => {
    expect(LIFECYCLE_MAX_EVENT_BYTES).toBe(2048);
    // Size one real record, then allow just that much.
    const probe = capture();
    createLifecycleRecorder({ ...identity, sink: probe.sink, now: () => 0 }).record("rpc_requested", { rpcId: 1, method: "initialize" });
    const limit = Buffer.byteLength(probe.rows[0].json) + 8;
    const { rows, sink } = capture();
    const recorder = createLifecycleRecorder({ ...identity, sink, now: () => 0, maxEventBytes: limit });
    recorder.record("rpc_requested", { rpcId: 2, method: "initialize" });
    recorder.record("closed", {
      code: 1073807364,
      signal: null,
      pendingMethods: ["initialize", "session/new", "session/prompt", "session/load"],
      pendingCount: 4,
      settled: false,
      cancelRequested: false,
      promptSent: true,
    });
    expect(rows.map((row) => row.msg.event)).toEqual(["rpc_requested", "events_omitted"]);
    expect(rows[1].msg).toMatchObject({ omitted: 1, omittedReason: "size" });
    expect(rows.every((row) => Buffer.byteLength(row.json) <= limit)).toBe(true);
  });

  it("caps ordinary events per child and reserves the first stop, one settlement and the close", () => {
    const { rows, sink, events } = capture();
    const recorder = createLifecycleRecorder({ ...identity, sink, maxEvents: 3 });
    for (let id = 1; id <= 5; id++) recorder.record("rpc_requested", { rpcId: id, method: "session/prompt" });
    recorder.record("stop_requested", { reason: "user_cancel" });
    recorder.record("stop_requested", { reason: "driver_dispose" });
    recorder.record("turn_settled", { reason: "turn_complete", settled: true });
    recorder.record("closed", { code: null, signal: "SIGTERM" });
    expect(events()).toEqual([
      "rpc_requested", "rpc_requested", "rpc_requested",
      "events_omitted", "stop_requested",
      "events_omitted", "turn_settled",
      "closed",
    ]);
    expect(rows[3].msg).toMatchObject({ omitted: 2, omittedReason: "budget" });
    expect(rows[4].msg).toMatchObject({ reason: "user_cancel" });
    expect(rows[5].msg).toMatchObject({ omitted: 1, omittedReason: "budget" });
    const sequences = rows.map((row) => row.msg.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("links a late stop callback to its generation without rewriting the close", () => {
    const { rows, sink } = capture();
    const recorder = createLifecycleRecorder({ ...identity, sink, platform: "win32" });
    recorder.observeStopRoute({ route: "windows_taskkill", result: "requested" });
    recorder.record("closed", { code: 1, signal: null, settled: true });
    const closedJson = rows[1].json;
    recorder.observeStopRoute({ route: "windows_taskkill", result: "succeeded" });
    recorder.observeStopRoute({ route: "windows_child_kill", result: "fallback" });
    expect(rows.map((row) => [row.msg.event, row.msg.route, row.msg.result])).toEqual([
      ["stop_route", "windows_taskkill", "requested"],
      ["closed", undefined, undefined],
      ["stop_route_result", "windows_taskkill", "succeeded"],
      ["stop_route", "windows_child_kill", "fallback"],
    ]);
    expect(rows.every((row) => row.msg.processGeneration === recorder.generation)).toBe(true);
    expect(rows[2].msg.sequence).toBeGreaterThan(rows[1].msg.sequence);
    expect(rows[1].json).toBe(closedJson);
  });

  it("never lets a throwing logger reach the caller", () => {
    let calls = 0;
    const recorder = createLifecycleRecorder({
      ...identity,
      sink: () => {
        calls += 1;
        throw new Error("disk full");
      },
    });
    expect(() => recorder.record("spawn_requested")).not.toThrow();
    expect(() => recorder.observeStopRoute({ route: "posix_group_sigterm", result: "requested" })).not.toThrow();
    expect(() => recorder.record("closed", { code: 0, signal: null })).not.toThrow();
    expect(calls).toBe(3);
  });
});
