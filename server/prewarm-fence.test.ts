// The prewarm fence: what a spare's launch may resume. Every refusal is a cold start next turn, never a wrong session.
import { describe, expect, it } from "vitest";

import { checkPrewarmFence } from "./prewarm-fence.ts";
import { PrewarmRefused } from "./drivers/warm-pool.ts";
import type { TaskRecord } from "./store.ts";

const task = (over: Partial<TaskRecord>) => ({ threadId: "t", title: "t", createdAt: 0, resumeCursors: {}, ...over }) as TaskRecord;
const reason = (run: () => void) => {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(PrewarmRefused); return (error as PrewarmRefused).reason; }
  return null;
};
const state = (t: TaskRecord | undefined, over: Partial<{ ownsThread: boolean; instanceNow: string }> = {}) => ({ task: t, ownsThread: true, instanceNow: "i1", ...over });
const clean = task({ sealGeneration: 2, resumeCursors: { i1: "c" }, resumeSeals: { i1: { cursor: "c", generation: 2 } } } as Partial<TaskRecord>);

describe("checkPrewarmFence", () => {
  it("an unsealed thread warms as it always did: a fresh start, or the cursor the store holds", () => {
    expect(reason(() => checkPrewarmFence(state(task({})), "i1", null))).toBeNull();
    expect(reason(() => checkPrewarmFence(state(task({ resumeCursors: { i1: "c" } })), "i1", "c"))).toBeNull();
  });
  it("no task, or a thread that left the bot: no start", () => {
    expect(reason(() => checkPrewarmFence(state(undefined), "i1", "c"))).toBe("thread");
    expect(reason(() => checkPrewarmFence(state(task({}), { ownsThread: false }), "i1", "c"))).toBe("thread");
  });
  it("the dispatch would use another instance now: no start", () => {
    expect(reason(() => checkPrewarmFence(state(clean, { instanceNow: "i2" }), "i1", "c"))).toBe("instance-moved");
  });
  it("a cursor the store no longer names (rewind, engine switch, a clear) is refused, sealed or not", () => {
    expect(reason(() => checkPrewarmFence(state(task({ resumeCursors: { i1: "new" } })), "i1", "old"))).toBe("cursor-moved");
    expect(reason(() => checkPrewarmFence(state(task({})), "i1", "old"))).toBe("cursor-moved");
    expect(reason(() => checkPrewarmFence(state(clean), "i1", "other"))).toBe("cursor-moved");
  });
  it("a sealed thread: no blank spare, and only a cursor bound at or above the seal resumes", () => {
    expect(reason(() => checkPrewarmFence(state(clean), "i1", null))).toBe("sealed-no-cursor");
    expect(reason(() => checkPrewarmFence(state(clean), "i1", "c"))).toBeNull();
    const bumped = { ...clean, sealGeneration: 3 } as TaskRecord;
    expect(reason(() => checkPrewarmFence(state(bumped), "i1", "c"))).toBe("sealed");
    const unbound = task({ sealGeneration: 1, resumeCursors: { i1: "c" } });
    expect(reason(() => checkPrewarmFence(state(unbound), "i1", "c"))).toBe("sealed");
  });
});
