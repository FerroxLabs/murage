// Owner: rig-realsize lane. The rig's completion rule (completion.mjs) is part of the release gate's pass/fail. These cases
// use the row shapes the server really writes (sendId + dispatchedIn on the prompt row, turnId + turnTerminal on the final
// reply, dlg-<task>/dres-<task> for a delegation) and prove two things: the thread-level matcher the rig shipped with first
// reported such runs finished, and the per-turn rule reports them unfinished.
import { expect, it } from "vitest";
import { judgeCompletion, openTurns, REPLY } from "./completion.mjs";

/** The first rig's matcher, the same rule as rig.mts at 118fd29ad7 (there over a per-thread list, here over one list filtered
 * by thread): a sent turn counted as finished if ANY ok turn end landed on its thread after the send, and an accepted
 * delegation was never looked at again. Kept only to show the hole. */
function threadLevelMatcher({ sends, ends }) {
  const unfinished = sends.filter((s) => !ends.slice(s.endsBefore).some((e) => e.threadId === s.threadId && e.type === "turn.completed" && e.ok !== false));
  return { red: unfinished.length ? ["unfinishedTurns"] : [] };
}

const ANSWER = `${REPLY} ${"x".repeat(40)}`;
const prompt = (sendId, turnId) => ({ id: `m-${sendId}`, role: "user", kind: "text", text: `__custom_tool__:ops_metrics ${sendId} Long task`, sendId, ...(turnId ? { dispatchedIn: turnId } : {}) });
const step = (turnId, n) => ({ id: `ev-${turnId}-${n}`, role: "bot", kind: "text", text: `Step ${n} of 120 done.`, turnId });
const final = (turnId, text = ANSWER) => ({ id: `ev-${turnId}-final`, role: "bot", kind: "text", text, turnId, turnTerminal: true });
const okEnd = (threadId) => ({ threadId, type: "turn.completed", ok: true, stopReason: "end_turn" });
const delegatedPrompt = (taskId, turnId) => ({ id: `dlg-${taskId}`, role: "user", kind: "text", text: "[Delegated by @Rig Writer 3, another bot in this Murage workspace. Do the work and reply directly.]", ...(turnId ? { dispatchedIn: turnId } : {}) });
const handedBack = (taskId, text = `@Rig Analyst 2 replied to the delegated task:\n\n${ANSWER}`) => ({ id: `dres-${taskId}`, role: "bot", kind: "text", text });
const send = (tag, threadId, sendId, endsBefore = 0) => ({ tag, threadId, sendId, status: 202, endsBefore });

/** One healthy drive: two sent turns on two threads, one delegation from A to B, its answer handed back, A's wake-up turn. */
function healthy() {
  return {
    sends: [send("rigturn-1-0", "thread-a", "send-a1"), send("rigturn-1-1", "thread-b", "send-b1")],
    delegations: [{ tag: "rigturn-1-0", status: 200, taskId: "task-1", fromThreadId: "thread-a", toThreadId: "thread-b" }],
    rowsByThread: {
      "thread-a": [prompt("send-a1", "turn-a1"), step("turn-a1", 1), final("turn-a1"), handedBack("task-1"), final("turn-a-wake")],
      "thread-b": [prompt("send-b1", "turn-b1"), step("turn-b1", 1), final("turn-b1"), delegatedPrompt("task-1", "turn-b-delegated"), step("turn-b-delegated", 1), final("turn-b-delegated")],
    },
    ends: [okEnd("thread-a"), okEnd("thread-b"), okEnd("thread-b"), okEnd("thread-a")],
    starts: [{ threadId: "thread-a" }, { threadId: "thread-b" }, { threadId: "thread-b" }, { threadId: "thread-a" }],
  };
}

it("a healthy drive is finished: every sent turn has its own final reply and the delegation came back", () => {
  const run = healthy();
  expect(judgeCompletion(run)).toMatchObject({ red: [], unfinished: [], delegationsIncomplete: [], badEnds: [], stillRunning: [], turns: 2, delegationsAccepted: 1 });
  expect(threadLevelMatcher(run).red).toEqual([]);
});

it("a sent turn that failed is hidden by the wake-up turn on the same thread: thread-level says finished, per-turn says RED", () => {
  const run = healthy();
  // turn-a1 lost its owner tool and ended ok:false; the delegated answer then woke the bot and THAT turn completed ok
  run.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), step("turn-a1", 1), final("turn-a1", "custom tool failed: no ops_metrics server was mounted"), handedBack("task-1"), final("turn-a-wake")];
  run.ends = [{ threadId: "thread-a", type: "turn.completed", ok: false, stopReason: "mcp_unavailable" }, okEnd("thread-b"), okEnd("thread-b"), okEnd("thread-a")];
  expect(threadLevelMatcher(run).red).toEqual([]);
  const judged = judgeCompletion(run);
  expect(judged.red).toEqual(["unfinishedTurns", "badTurnEnds"]);
  expect(judged.unfinished).toEqual([{ tag: "rigturn-1-0", threadId: "thread-a", reason: expect.stringContaining("turn turn-a1 final reply is not the tool's answer") }]);
  expect(judged.badEnds).toHaveLength(1);
});

it("a sent turn that never finished is hidden by a later wave on the same bot: thread-level says finished, per-turn says RED", () => {
  const run = healthy();
  // wave 1's turn on thread-a stops mid-way with no final reply and no end event; wave 2 sends to the same bot and completes
  run.sends.push(send("rigturn-2-0", "thread-a", "send-a2", 1));
  run.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), step("turn-a1", 1), step("turn-a1", 2), handedBack("task-1"), prompt("send-a2", "turn-a2"), final("turn-a2")];
  run.ends = [okEnd("thread-b"), okEnd("thread-b"), okEnd("thread-a")];
  run.starts = [{ threadId: "thread-a" }, { threadId: "thread-b" }, { threadId: "thread-b" }, { threadId: "thread-a" }];
  expect(threadLevelMatcher(run).red).toEqual([]);
  const judged = judgeCompletion(run);
  expect(judged.red).toEqual(["unfinishedTurns", "turnsStillRunning"]);
  // even if the stalled turn's start had been missed, its own missing reply is enough
  expect(judgeCompletion({ ...run, starts: run.starts.slice(1) }).red).toEqual(["unfinishedTurns"]);
  expect(judged.unfinished).toEqual([{ tag: "rigturn-1-0", threadId: "thread-a", reason: "turn turn-a1 has no final reply (2 rows of its own)" }]);
});

it("a sent message no turn ever took is unfinished, whatever else completed on the thread", () => {
  const run = healthy();
  run.rowsByThread["thread-a"] = [prompt("send-a1"), handedBack("task-1"), final("turn-a-wake")];
  expect(threadLevelMatcher(run).red).toEqual([]);
  expect(judgeCompletion(run).unfinished).toEqual([{ tag: "rigturn-1-0", threadId: "thread-a", reason: "the sent message was never taken by a turn" }]);
  run.rowsByThread["thread-a"] = [handedBack("task-1"), final("turn-a-wake")];
  expect(judgeCompletion(run).unfinished[0].reason).toBe("the sent message is not in the conversation");
});

it("a delegation that was accepted but never ran is counted done by the first rig and RED by the per-turn rule", () => {
  const run = healthy();
  // the API said queued (200 + task id); the worker never took it, nothing came back
  run.rowsByThread["thread-b"] = [prompt("send-b1", "turn-b1"), final("turn-b1"), delegatedPrompt("task-1")];
  run.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), final("turn-a1")];
  run.ends = [okEnd("thread-a"), okEnd("thread-b")];
  run.starts = [{ threadId: "thread-a" }, { threadId: "thread-b" }];
  expect(threadLevelMatcher(run).red).toEqual([]);
  const judged = judgeCompletion(run);
  expect(judged.red).toEqual(["delegationsIncomplete"]);
  expect(judged.delegationsIncomplete).toEqual([{ tag: "rigturn-1-0", taskId: "task-1", reason: "the delegated prompt was never taken by a turn" }]);
  run.rowsByThread["thread-b"] = [prompt("send-b1", "turn-b1"), final("turn-b1")];
  expect(judgeCompletion(run).delegationsIncomplete[0].reason).toBe("the delegated prompt is not in the conversation");
});

it("a delegated turn that started but did not finish, or whose answer never reached the asker, is incomplete", () => {
  const stalled = healthy();
  stalled.rowsByThread["thread-b"] = [prompt("send-b1", "turn-b1"), final("turn-b1"), delegatedPrompt("task-1", "turn-b-delegated"), step("turn-b-delegated", 1)];
  expect(judgeCompletion(stalled).delegationsIncomplete[0].reason).toBe("turn turn-b-delegated has no final reply (1 rows of its own)");
  const notBack = healthy();
  notBack.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), final("turn-a1")];
  expect(judgeCompletion(notBack).delegationsIncomplete[0].reason).toBe("the delegated answer never reached the asker");
  const withheld = healthy();
  withheld.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), final("turn-a1"), handedBack("task-1", "(no answer yet: @Rig Analyst 2 finished, but the result is not ready)")];
  expect(judgeCompletion(withheld).delegationsIncomplete[0].reason).toContain("the asker got no answer, only:");
  const refused = healthy();
  refused.delegations = [{ tag: "rigturn-1-0", status: 409, fromThreadId: "thread-a", toThreadId: "thread-b" }];
  expect(judgeCompletion(refused).delegationsIncomplete[0].reason).toBe("delegation refused status=409");
});

it("only the turn's own final engine reply counts: not another turn's, not a Murage line, not a second one", () => {
  const other = healthy();
  other.rowsByThread["thread-b"] = [prompt("send-b1", "turn-b1"), final("turn-other"), delegatedPrompt("task-1", "turn-b-delegated"), final("turn-b-delegated")];
  expect(judgeCompletion(other).unfinished[0].reason).toBe("turn turn-b1 has no final reply (0 rows of its own)");
  const line = healthy();
  line.rowsByThread["thread-b"][2] = { ...final("turn-b1"), murageLine: true };
  expect(judgeCompletion(line).red).toEqual(["unfinishedTurns"]);
  const notLast = healthy();
  notLast.rowsByThread["thread-b"][2] = { ...final("turn-b1"), turnTerminal: undefined };
  expect(judgeCompletion(notLast).red).toEqual(["unfinishedTurns"]);
  const twice = healthy();
  twice.rowsByThread["thread-b"].splice(3, 0, { ...final("turn-b1"), id: "ev-again" });
  expect(judgeCompletion(twice).unfinished[0].reason).toBe("turn turn-b1 has 2 final replies");
});

it("a refused send, and any turn end of the drive that is not completed ok, is RED", () => {
  const refused = healthy();
  refused.sends[1] = { ...refused.sends[1], status: 503 };
  expect(judgeCompletion(refused).unfinished).toEqual([{ tag: "rigturn-1-1", threadId: "thread-b", reason: "send refused status=503" }]);
  for (const end of [{ threadId: "thread-a", type: "turn.failed" }, { threadId: "thread-a", type: "turn.interrupted" }, { threadId: "thread-a", type: "turn.completed", ok: false, stopReason: "memory_refused" }, { threadId: "thread-a", type: "turn.completed" }]) {
    const run = healthy();
    run.ends.push(end);
    expect(judgeCompletion(run).red).toEqual(["badTurnEnds"]);
  }
});

it("a turn that started and has not ended when the run is judged is RED: the wake-up after a delegated reply is a turn too", () => {
  const run = healthy();
  // the delegated answer came back and woke the asker; the rig judged before that wake-up turn ended
  run.rowsByThread["thread-a"] = [prompt("send-a1", "turn-a1"), step("turn-a1", 1), final("turn-a1"), handedBack("task-1"), step("turn-a-wake", 1)];
  run.ends = [okEnd("thread-a"), okEnd("thread-b"), okEnd("thread-b")];
  expect(threadLevelMatcher(run).red).toEqual([]);
  const judged = judgeCompletion(run);
  expect(judged.red).toEqual(["turnsStillRunning"]);
  expect(judged.stillRunning).toEqual([{ threadId: "thread-a", generation: null, started: 2, ended: 1 }]);
  expect(openTurns({ starts: [{ threadId: "t" }], ends: [] })).toEqual([{ threadId: "t", generation: null, started: 1, ended: 0 }]);
  expect(openTurns({ starts: [{ threadId: "t" }], ends: [okEnd("t")] })).toEqual([]);
  // the rule is never skipped by leaving the starts out
  expect(() => judgeCompletion({ ...healthy(), starts: undefined })).toThrow("starts and ends");
});

it("ids the rule cannot trust are unfinished: a send id seen twice, an accepted delegation with no task id", () => {
  const twice = healthy();
  twice.rowsByThread["thread-b"].push(prompt("send-b1", "turn-b1"));
  expect(judgeCompletion(twice).unfinished).toEqual([{ tag: "rigturn-1-1", threadId: "thread-b", reason: "send id appears 2 times" }]);
  const noTask = healthy();
  noTask.delegations = [{ tag: "rigturn-1-0", status: 200, fromThreadId: "thread-a", toThreadId: "thread-b" }];
  expect(judgeCompletion(noTask).delegationsIncomplete).toEqual([{ tag: "rigturn-1-0", taskId: null, reason: "accepted delegation has no task id" }]);
});

it("still running is judged by the newest start's own generation: a dispatch prepared again starts twice and ends once", () => {
  const gen = (threadId, generation, extra = {}) => ({ threadId, generation, ...extra });
  const end = (threadId, generation) => ({ ...okEnd(threadId), generation });
  // as the server emits it: start (generation 4), context revoked during dispatch, start again (generation 7), end (generation 7)
  expect(openTurns({ starts: [gen("t", 4), gen("t", 7)], ends: [end("t", 7)] })).toEqual([]);
  // the newest start has no end of its own: an older turn's end does not close it, however many ends there are
  expect(openTurns({ starts: [gen("t", 4), gen("t", 7)], ends: [end("t", 4)] })).toEqual([{ threadId: "t", generation: 7, started: 2, ended: 1 }]);
  expect(openTurns({ starts: [gen("t", 4), gen("t", 7), gen("t", 9)], ends: [end("t", 4), end("t", 7), end("u", 9)] })).toEqual([{ threadId: "t", generation: 9, started: 3, ended: 2 }]);
  // one conversation's end never closes another's start
  expect(openTurns({ starts: [gen("t", 4), gen("u", 5)], ends: [end("t", 4)] })).toEqual([{ threadId: "u", generation: 5, started: 1, ended: 0 }]);
  // an end without a generation cannot be matched: fall back to counting, which keeps the doubled start open
  expect(openTurns({ starts: [gen("t", 4), gen("t", 7)], ends: [okEnd("t")] })).toEqual([{ threadId: "t", generation: 7, started: 2, ended: 1 }]);
});
