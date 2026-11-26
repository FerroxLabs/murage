import { expect, test } from "vitest";
import { checkTurnMemory } from "./memory.mjs";

const failed = `[memory] fence recovery tier=0 thread=sample-a refused=none parts=0 omitted=37 cause=checking
turn dispatch recall=held thread=sample-a
claude first-token thread=sample-a
memory continuation kept thread=sample-b engine=claude reason=checking:pending (owner turn, nothing remembered added)
turn dispatch recall=withheld thread=sample-b
[memory] fence recovery tier=0 thread=sample-c refused=none parts=0 omitted=51 cause=checking
turn dispatch recall=held thread=sample-c
claude first-token thread=sample-c`;
const recallCode = "CANARY-RECALL-sample";

test.each(["sample-a", "sample-b", "sample-c"])("W15a reports MEMORY_STUCK for %s despite a reply", (thread) => {
  expect(checkTurnMemory(failed, { thread, reply: recallCode, recallCode }).reason).toBe("MEMORY_STUCK");
});

test("W15a requires exactly one full dispatch for a reply, on the correct thread", () => {
  const turn = { thread: "sample", reply: recallCode, recallCode };
  const dispatch = "turn dispatch recall=full thread=sample";
  expect(checkTurnMemory(failed + "\n" + dispatch, turn)).toEqual({
    thread: "sample", dispatch: "full", fence_checking: false, reason: null,
  });
  for (const log of [failed, dispatch + "-other", dispatch + "\n" + dispatch, dispatch.replace("full", "pins")]) {
    expect(checkTurnMemory(log, turn).reason).toBe("MEMORY_STUCK");
  }
});

test("W15a both checking signals override full dispatch and the exact recall code", () => {
  const turn = { thread: "sample", reply: recallCode, recallCode };
  const dispatch = "turn dispatch recall=full thread=sample";
  for (const line of [
    "[memory] fence recovery tier=0 thread=sample refused=none parts=0 omitted=37 cause=checking",
    "memory continuation kept thread=sample engine=claude reason=checking:pending",
  ]) {
    expect(checkTurnMemory(dispatch + "\n" + line, turn).reason).toBe("MEMORY_STUCK");
  }
  expect(checkTurnMemory(dispatch, { ...turn, reply: "something else" }).reason).toBe("TOKEN_MISSING");
  expect(checkTurnMemory("", { ...turn, recallCode: undefined, reply: null }).reason).toBeNull();
  expect(checkTurnMemory("", { thread: "sample", reply: null, checking: true, outcome: "refused" }).reason)
    .toBe("MEMORY_STUCK");
});
