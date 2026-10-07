import { afterEach, describe, expect, it } from "vitest";
import { beginTurnTrace, endTurnTrace, traceEngineEvent, turnTrace } from "./turn-trace.ts";

afterEach(() => { delete process.env.MURAGE_TURN_TRACE; });

describe("turn trace", () => {
  it("is a shared no-op, logging nothing, when MURAGE_TURN_TRACE is unset", async () => {
    const lines: string[] = [];
    const trace = beginTurnTrace("t1", (l) => lines.push(l));
    expect(trace.enabled).toBe(false);
    trace.mark("received");
    trace.span("x")("ok");
    await expect(trace.time("y", async () => 7)).resolves.toBe(7);
    endTurnTrace("t1", "completed");
    expect(turnTrace("t1")).toBe(trace);
    expect(lines).toEqual([]);
  });

  it("logs elapsed, delta, span durations and rethrows errors when on", async () => {
    process.env.MURAGE_TURN_TRACE = "1";
    let clock = 1000;
    const lines: string[] = [];
    const trace = beginTurnTrace("t2", (l) => lines.push(l), () => clock);
    clock += 50; trace.mark("received", { cold: true, note: "has spaces and /secret/path" });
    clock += 200; await trace.time("mount.connectors", async () => { clock += 30; });
    await expect(trace.time("mount.bad", async () => { clock += 5; throw new Error("boom"); })).rejects.toThrow("boom");
    trace.once("ttft"); trace.once("ttft");
    endTurnTrace("t2", "ok");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^\[turn-trace\] id=[0-9a-f]{8} phase=received at=50ms since=50ms cold=true$/);
    expect(lines[1]).toContain("phase=mount.connectors");
    expect(lines[1]).toContain("outcome=ok ms=30");
    expect(lines[2]).toContain("outcome=error ms=5");
    expect(lines[4]).toContain("phase=turn.done");
    expect(turnTrace("t2").enabled).toBe(false);
  });

  it("engine marks fire once and in order, then turn.done carries counts only", () => {
    process.env.MURAGE_TURN_TRACE = "1";
    const lines: string[] = [];
    beginTurnTrace("t3", (l) => lines.push(l));
    traceEngineEvent({ type: "turn.started", threadId: "t3" });
    traceEngineEvent({ type: "content.delta", threadId: "t3", streamKind: "reasoning_text" });
    expect(lines).toEqual([]);
    traceEngineEvent({ type: "item.started", threadId: "t3", itemType: "tool" });
    traceEngineEvent({ type: "content.delta", threadId: "t3", streamKind: "assistant_text" });
    traceEngineEvent({ type: "content.delta", threadId: "t3", streamKind: "assistant_text" });
    traceEngineEvent({ type: "item.completed", threadId: "t3", itemType: "assistant_text" });
    traceEngineEvent({ type: "turn.completed", threadId: "t3", ok: true, usage: { input: 12, output: 34 } });
    traceEngineEvent({ type: "turn.completed", threadId: "t3", ok: true });
    expect(lines.map((l) => /phase=(\S+)/.exec(l)![1])).toEqual(["engine.first-token", "engine.first-text", "turn.done"]);
    expect(lines[2]).toMatch(/outcome=ok tokensIn=12 tokensOut=34$/);
  });

  it("engine marks are silent when tracing is off", () => {
    const lines: string[] = [];
    beginTurnTrace("t4", (l) => lines.push(l));
    traceEngineEvent({ type: "content.delta", threadId: "t4", streamKind: "assistant_text" });
    traceEngineEvent({ type: "turn.completed", threadId: "t4", ok: true });
    expect(lines).toEqual([]);
  });
});
