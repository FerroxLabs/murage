// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-NO-SILENT-HANG (1.0.15, design r5): the watch's rules on an injected clock. Real limits, real frame shapes.
// The driver half is fuigo-no-silent-hang.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyFuigoFrame, FUIGO_COMPACT_SILENT_MS, FUIGO_SILENT_MS, FUIGO_TOOL_SILENT_MS, FuigoSilenceWatch, fuigoWatchLimits,
  type FuigoWatchLimits,
} from "./fuigo-silence.ts";

const SID = "s-watch";
const LIMITS: FuigoWatchLimits = { silentMs: 120_000, toolMs: 1_200_000, compactMs: 1_200_000, failedGraceMs: 10_000 };
const S = 1000;

const update = (u: Record<string, unknown>, meta?: Record<string, unknown>) =>
  ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SID, update: u, ...(meta ? { _meta: meta } : {}) } });
const note = (u: Record<string, unknown>, meta: Record<string, unknown> = {}) =>
  ({ jsonrpc: "2.0", method: "_fuigo/session_notification", params: { sessionId: SID, update: u, _meta: meta } });
const chunk = (text = "x") => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const connectRetry = (attempt: number, reason: string) => note({ sessionUpdate: "retry_state", type: "retrying", attempt, max_retries: 3, reason, error_type: "http" });
const retryThought = (attempt: number) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `Retrying the model (${attempt}/3)` },
  _meta: { "fuigo/retryStatus": { type: "retrying", attempt } } });

/** A watch on a clock the test moves. `feed` classifies a real frame shape, as core.ts does. */
function rig(limits: FuigoWatchLimits = LIMITS) {
  let now = 0;
  const watch = new FuigoSilenceWatch(limits, () => now);
  const ctx = { paused: false, toolsRunning: false };
  return {
    watch, ctx,
    at: (ms: number) => { now = ms; },
    feed: (msg: unknown) => watch.frame(classifyFuigoFrame(msg, SID)),
    due: () => watch.check(ctx),
    /** the first moment, ticking each second from now up to `until`, at which a rule fires */
    firstFire: (until: number) => {
      for (let t = now; t <= until; t += S) { now = t; const rule = watch.check(ctx); if (rule) return { rule, at: t }; }
      return null;
    },
  };
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("defaults and knobs", () => {
  it("2 minutes silent, 20 minutes for a tool, 20 minutes for compaction, 10 s after a failed retry", () => {
    expect(fuigoWatchLimits()).toEqual({ silentMs: FUIGO_SILENT_MS, toolMs: FUIGO_TOOL_SILENT_MS, compactMs: FUIGO_COMPACT_SILENT_MS, failedGraceMs: 10_000 });
    expect([FUIGO_SILENT_MS, FUIGO_TOOL_SILENT_MS, FUIGO_COMPACT_SILENT_MS]).toEqual([120_000, 1_200_000, 1_200_000]);
  });

  it("each knob 0 turns its rule off; nonsense keeps the default (test 17)", () => {
    vi.stubEnv("MURAGE_FUIGO_SILENT_MS", "0");
    vi.stubEnv("MURAGE_FUIGO_TOOL_SILENT_MS", "0");
    vi.stubEnv("MURAGE_FUIGO_COMPACT_SILENT_MS", "0");
    vi.stubEnv("MURAGE_FUIGO_FAILED_GRACE_MS", "nope");
    const limits = fuigoWatchLimits();
    expect(limits).toEqual({ silentMs: 0, toolMs: 0, compactMs: 0, failedGraceMs: 10_000 });
    const r = rig(limits);
    r.ctx.toolsRunning = false;
    expect(r.firstFire(4 * 3600 * S)).toBeNull();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    expect(r.firstFire(8 * 3600 * S)).toBeNull();
  });
});

describe("the silence rule", () => {
  it("a hang with no frame fires at 120 s, not at 119 s (test 1)", () => {
    const r = rig();
    r.at(119 * S); expect(r.due()).toBeNull();
    r.at(120 * S); expect(r.due()).toBe("silence");
  });

  it("retries never reset the clock, on either rail, and there is no 45 s connect rule (tests 2, 5, 6)", () => {
    const r = rig();
    r.at(10 * S); r.feed(chunk("Thinking about it"));
    for (let t = 11; t < 130; t += 2) {
      r.at(t * S);
      r.feed(connectRetry(1, "request error: client error (Connect): tcp connect error: Connection refused (os error 111)"));
      r.feed(retryThought(1));
      r.feed(connectRetry(1, "Connection problem; retrying request"));
      expect(r.due()).toBeNull();
    }
    r.at(130 * S); expect(r.due()).toBe("silence");
  });

  it("one blip, then the answer at 60 s: no fire (test 3); 429 and 5xx retries are not progress either (test 4)", () => {
    const r = rig();
    r.at(1 * S); r.feed(connectRetry(1, "Connection problem; retrying request"));
    r.at(30 * S); r.feed(note({ sessionUpdate: "retry_state", type: "retrying", attempt: 1, error_type: "rate_limited" }));
    r.at(45 * S); r.feed(note({ sessionUpdate: "retry_state", type: "retrying", attempt: 2, error_type: "api" }));
    r.at(60 * S); r.feed(chunk("Hello"));
    expect(r.firstFire(179 * S)).toBeNull();
    expect(r.firstFire(181 * S)).toEqual({ rule: "silence", at: 180 * S });
  });

  it("a thought without retry meta, plan, tool argument streaming, response and hook frames are progress (tests 8, L2)", () => {
    for (const frame of [
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } }),
      update({ sessionUpdate: "plan", entries: [] }),
      update({ sessionUpdate: "tool_call_delta_chunk", toolCallId: "t1", delta: "{" }),
      note({ sessionUpdate: "response_started" }),
      note({ sessionUpdate: "response_completed" }),
      note({ sessionUpdate: "hook_execution", hooks: [] }),
      note({ sessionUpdate: "hook_annotation", text: "ok" }),
      note({ sessionUpdate: "turn_completed", prompt_id: "p" }),
      note({ sessionUpdate: "subagent_progress", subagent_id: "a" }),
    ]) expect(classifyFuigoFrame(frame, SID)).toBe("progress");
  });

  it("replay, foreign sessions, steer echoes, command lists and titles are not progress (test 16)", () => {
    expect(classifyFuigoFrame({ ...chunk(), params: { ...chunk().params, _meta: { isReplay: true } } }, SID)).toBeNull();
    expect(classifyFuigoFrame({ ...chunk(), params: { ...chunk().params, sessionId: "someone-else" } }, SID)).toBeNull();
    expect(classifyFuigoFrame({ jsonrpc: "2.0", method: "_fuigo/session/interjection", params: { sessionId: SID, interjectionId: "i" } }, SID)).toBeNull();
    expect(classifyFuigoFrame(update({ sessionUpdate: "available_commands_update", availableCommands: [] }), SID)).toBeNull();
    expect(classifyFuigoFrame(update({ sessionUpdate: "session_info_update", title: "x" }), SID)).toBeNull();
    expect(classifyFuigoFrame({ jsonrpc: "2.0", method: "_fuigo/session/update", params: { sessionId: SID, update: { sessionUpdate: "agent_message_chunk" } } }, SID)).toBeNull();
    expect(classifyFuigoFrame(retryThought(1), SID)).toBeNull();
    // a request from the engine is not a notification
    expect(classifyFuigoFrame({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { sessionId: SID } }, SID)).toBeNull();
  });

  it("a failed retry holds every rule 10 s so Fuigo's typed error lands first (test 13)", () => {
    const r = rig();
    r.at(115 * S); r.feed(note({ sessionUpdate: "retry_state", type: "failed", error_type: "http", message: "reqwest error" }));
    r.at(124 * S); expect(r.due()).toBeNull();
    r.at(125 * S); expect(r.due()).toBe("silence");
  });

  it("an open card or an engine request Murage is answering pauses every clock; the answer restarts them (tests 10, 11)", () => {
    const r = rig();
    r.ctx.paused = true;
    expect(r.firstFire(3 * 3600 * S)).toBeNull();
    r.ctx.paused = false;
    const resumed = 3 * 3600 * S;
    r.at(resumed + 119 * S); expect(r.due()).toBeNull();
    r.at(resumed + 120 * S); expect(r.due()).toBe("silence");
  });

  it("a fallback turn starting is progress; the same running id again is not", () => {
    const r = rig();
    r.at(100 * S); r.watch.queueChanged({ sessionId: SID, entries: [], runningPromptId: "interject-fallback-1" }, SID);
    r.at(200 * S); r.watch.queueChanged({ sessionId: SID, entries: [], runningPromptId: "interject-fallback-1" }, SID);
    r.at(219 * S); expect(r.due()).toBeNull();
    r.at(220 * S); expect(r.due()).toBe("silence");
  });

  it("a replayed or foreign queue frame is not a fallback turn starting", () => {
    const r = rig();
    r.at(100 * S); r.watch.queueChanged({ sessionId: SID, entries: [], runningPromptId: "interject-fallback-9", _meta: { isReplay: true } }, SID);
    r.watch.queueChanged({ sessionId: "someone-else", entries: [], runningPromptId: "interject-fallback-8" }, SID);
    r.at(120 * S); expect(r.due()).toBe("silence");
  });
});

describe("the compaction deadline (r5-1, r5-2)", () => {
  it("attempt 1 cut at 300 s, attempt 2 done at 484 s: no fire (test 20)", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    expect(r.firstFire(484 * S)).toBeNull();
    r.feed(note({ sessionUpdate: "auto_compact_completed" }));
    expect(r.firstFire(603 * S)).toBeNull();
    expect(r.firstFire(605 * S)).toEqual({ rule: "silence", at: 604 * S });
  });

  it("Astra's case: three attempts with 30 s header waits, done at 995 s: no fire (test 20b)", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    expect(r.firstFire(995 * S)).toBeNull();
    r.feed(note({ sessionUpdate: "auto_compact_completed" }));
    expect(r.due()).toBeNull();
  });

  it("a compaction silent to 1200 s fires the compaction rule; at 1199 s nothing (test 21)", () => {
    const r = rig();
    r.at(50 * S); r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(1249 * S); expect(r.due()).toBeNull();
    r.at(1250 * S); expect(r.due()).toBe("compact");
  });

  it("a repeated start keeps the first moment: one operation, one clock", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(600 * S); r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(1200 * S); expect(r.due()).toBe("compact");
  });

  it("order A: compaction, flush start, flush done, compaction silent 200 s: no fire; compaction done, then 120 s: silence (test 22)", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(1 * S); r.feed(note({ sessionUpdate: "memory_flush_started" }));
    r.at(5 * S); r.feed(note({ sessionUpdate: "memory_flush_completed", result: "written" }));
    expect(r.watch.compactSince).toBe(0);
    expect(r.firstFire(205 * S)).toBeNull();
    r.at(300 * S); r.feed(note({ sessionUpdate: "auto_compact_completed" }));
    expect(r.firstFire(419 * S)).toBeNull();
    expect(r.firstFire(421 * S)).toEqual({ rule: "silence", at: 420 * S });
  });

  it("order B: flush, compaction start and done, flush silent: the flush clock holds and fires at the deadline (test 23)", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "memory_flush_started" }));
    r.at(10 * S); r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(100 * S); r.feed(note({ sessionUpdate: "auto_compact_cancelled", reason: "user_cancelled" }));
    expect(r.watch.flushSince).toBe(0);
    expect(r.firstFire(1199 * S)).toBeNull();
    expect(r.due()).toBeNull();
    r.at(1200 * S); expect(r.due()).toBe("compact");
  });

  it("buffered model and tool frames arriving after the start never clear it (test 27, Astra r4 High 2)", () => {
    const r = rig();
    r.ctx.toolsRunning = true;
    r.at(10 * S); r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(11 * S); r.feed(note({ sessionUpdate: "response_completed" }));
    r.feed(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
    r.ctx.toolsRunning = false;
    expect(r.watch.compactSince).toBe(10 * S);
    expect(r.firstFire(311 * S)).toBeNull();
    r.feed(note({ sessionUpdate: "auto_compact_completed" }));
    expect(r.firstFire(432 * S)).toEqual({ rule: "silence", at: 431 * S });
  });

  it("a lost end (Fuigo sends none for a suppressed compaction): held by the deadline, not the 2 minute rule (test 27b)", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(5 * S); r.feed(chunk("back on the model"));
    expect(r.firstFire(1199 * S)).toBeNull();
    expect(r.firstFire(1200 * S)).toEqual({ rule: "compact", at: 1200 * S });
  });

  it("a card open during compaction slides its clock: the owner's wait never counts", () => {
    const r = rig();
    r.feed(note({ sessionUpdate: "auto_compact_started" }));
    r.at(1000 * S); r.ctx.paused = true; expect(r.due()).toBeNull();
    r.at(5000 * S); expect(r.due()).toBeNull();
    r.ctx.paused = false;
    r.at(6199 * S); expect(r.due()).toBeNull();
    r.at(6200 * S); expect(r.due()).toBe("compact");
  });
});

describe("the tool rule (r4 H3, r5-3, r5-4)", () => {
  it("a tool in progress silent 1200 s fires the tool rule, never the 2 minute rule; an update at 1190 s restarts it (test 24)", () => {
    const r = rig();
    r.ctx.toolsRunning = true;
    r.feed(update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" }));
    r.at(1190 * S); r.feed(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" }));
    expect(r.firstFire(2389 * S)).toBeNull();
    expect(r.firstFire(2390 * S)).toEqual({ rule: "tool", at: 2390 * S });
  });

  it("model progress while a tool is still marked running restarts the tool clock too (test 24b, Fable M-b)", () => {
    const r = rig();
    r.ctx.toolsRunning = true;
    r.feed(update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" }));
    r.at(1190 * S); r.feed(chunk("still streaming"));
    r.at(2389 * S); expect(r.due()).toBeNull();
    r.at(2390 * S); expect(r.due()).toBe("tool");
  });

  it("a card over a running tool past 1200 s: no fire; answered, then silent 1200 s: fires (test 26)", () => {
    const r = rig();
    r.ctx.toolsRunning = true;
    r.ctx.paused = true;
    expect(r.firstFire(3000 * S)).toBeNull();
    r.ctx.paused = false;
    r.watch.progress(); // the answer Murage wrote
    r.at(4199 * S); expect(r.due()).toBeNull();
    r.at(4200 * S); expect(r.due()).toBe("tool");
  });
});

describe("the live M3 capture (Fuigo 1.0.32, refused port, pins 3/15; design r4 M3 RESULT) (test 28)", () => {
  // probe/out-1.0.32.jsonl: retry_state on both rails at these ms, all error_type http; failed at 66029; then
  // turn_completed at 66052 and the prompt's RPC error.
  const INNER = "request error: error sending request for url (http://127.0.0.1:9/v1/chat/completions): client error (Connect): tcp connect error: Connection refused (os error 111)";
  const OUTER = "Connection problem; retrying request";
  const RETRIES: Array<[number, number, string]> = [
    [397, 1, INNER], [592, 2, INNER], [3836, 1, OUTER], [6082, 1, INNER], [6315, 2, INNER], [11037, 2, OUTER],
    [22266, 1, INNER], [22428, 2, INNER], [26378, 3, OUTER], [61069, 1, INNER], [61253, 2, INNER],
  ];

  it("no reason says \"connection failed\"; nothing fires at 45 s; Fuigo's failed frame lands inside the grace", () => {
    const r = rig();
    for (const [ms, attempt, reason] of RETRIES) {
      expect(reason.includes("connection failed")).toBe(false);
      r.at(ms); r.feed(connectRetry(attempt, reason)); r.feed(retryThought(attempt));
      expect(r.due()).toBeNull();
    }
    r.at(45 * S); expect(r.due()).toBeNull();
    r.at(66_029); r.feed(note({ sessionUpdate: "retry_state", type: "failed", error_type: "http", message: "reqwest error stream" }));
    r.at(66_052); r.feed(note({ sessionUpdate: "turn_completed", stop_reason: "error", error_kind: "http" }));
    expect(r.due()).toBeNull();
  });

  it("the same frames without the failed frame, turn_completed and the RPC result: the silence rule at 120 s", () => {
    const r = rig();
    for (const [ms, attempt, reason] of RETRIES) { r.at(ms); r.feed(connectRetry(attempt, reason)); r.feed(retryThought(attempt)); }
    r.at(119_999); expect(r.due()).toBeNull();
    r.at(120_000); expect(r.due()).toBe("silence");
  });
});
