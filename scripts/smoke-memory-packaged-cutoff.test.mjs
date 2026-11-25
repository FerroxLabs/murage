// Release run 44616560307 (macOS Intel): after the retained-index restart the WebAssembly helper had just said "model-ready" but was
// still inside a maintenance step, so the first recall's helper missed searchMemory's own tool cutoff (TOOL_SEMANTIC_CUTOFF_MS) and the
// answer was the designed words-only partial. The smoke failed on that one attempt with "searchMemory never asked the packaged worker".
// The smoke now asks again until the helper answers inside the product's cutoff, bounded, and every answer, partial ones included,
// is checked for denied and deleted records.
import { expect, it } from "vitest";
import { recallUntilAnswered } from "./smoke-memory-packaged.mjs";

const full = { raw: { lexicalRanked: [["gold", 1]] }, answer: { hits: [{ id: "gold" }] } };
const cut = (ids = ["gold"]) => ({ raw: undefined, answer: { partial: true, hits: ids.map(id => ({ id })) } });

it("asks again while the helper misses the product cutoff, then returns the helper's answer", async () => {
  const answers = [cut(), cut([]), full];
  const got = await recallUntilAnswered(async () => answers.shift(), { timeoutMs: 5000, pauseMs: 1 });
  expect(got.raw).toBe(full.raw);
  expect(got.cutoffRetries).toBe(2);
});

it("a partial answer that carries a denied or deleted record fails at once, never retried", async () => {
  let calls = 0;
  await expect(recallUntilAnswered(async () => (++calls, cut(["gold", "deleted-source"])), { timeoutMs: 5000, pauseMs: 1 }))
    .rejects.toThrow(/leaked denied\/deleted/);
  expect(calls).toBe(1);
});

it("a helper that never answers inside the cutoff still fails the smoke when the bound runs out", async () => {
  await expect(recallUntilAnswered(async () => cut(), { timeoutMs: 30, pauseMs: 5 })).rejects.toThrow(/searchMemory never got the packaged worker's answer/);
});

it("an answer the helper did give is returned as is (the caller's exact-gold and degradation checks run on it)", async () => {
  const degraded = { raw: { degradedReason: "local-model-unavailable" }, answer: { hits: [] } };
  let calls = 0;
  expect(await recallUntilAnswered(async () => (++calls, degraded), { timeoutMs: 5000, pauseMs: 1 })).toMatchObject({ raw: degraded.raw, cutoffRetries: 0 });
  expect(calls).toBe(1);
});
