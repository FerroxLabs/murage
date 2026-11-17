// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Module hook for recall-skip-preload.mjs (test-process only). It rewrites server/memory/recall-budget.ts as it
// loads so withRecallBudget always answers { skipped: "budget" }. The rewrite fails loudly if the function moved,
// so a test that relies on it can never pass on a recall that was not skipped.
const MARK = "export async function withRecallBudget<T>(work: Promise<T>, ms = RECALL_WAIT_MS): Promise<RecallWait<T>> {";

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  // MAIN RULING 1115-RECALL-R7 (GrokBuild)
  // Producer owner: recall-r7-a; consumer owner: MAIN (RECALL-SKIP-DROP).
  if (/\/server\/index\.ts$/.test(new URL(url).pathname)) {
    const entry = 'bundle=await buildMemoryBundleAfterReset(query,access,memoryWorker,async()=>{},memoryOptions,buildMemoryBundle);';
    const resumed = 'bundle=await buildMemoryBundle(query,access,memoryWorker,memoryOptions);';
    const source = String(loaded.source);
    if (!source.includes(entry) || !source.includes(resumed)) throw new Error('RECALL_SKIP_PRELOAD: recall entry moved');
    // Force the existing recall calls through the skip branch, preserving their session-reset order.
    return { ...loaded, source: source.replace(entry, 'bundle=await awaitRecall(buildMemoryBundleAfterReset(query,access,memoryWorker,async()=>{},memoryOptions,buildMemoryBundle));').replace(resumed, 'bundle=await awaitRecall(buildMemoryBundle(query,access,memoryWorker,memoryOptions));'), shortCircuit: true };
  }
  if (!/\/server\/memory\/recall-budget\.ts$/.test(new URL(url).pathname)) return loaded;
  const source = String(loaded.source);
  if (!source.includes(MARK)) throw new Error("RECALL_SKIP_PRELOAD: withRecallBudget's signature changed; update server/testing/recall-skip-loader.mjs");
  // The work keeps running (the caller cancels it), and its rejection is silenced as the real budget does.
  const forced = source.replace(MARK, `${MARK}\n  void ms; work.catch(() => {}); if (!(globalThis as any).__recallSkipForced) { (globalThis as any).__recallSkipForced = true; console.warn("RECALL_SKIP_PRELOAD forced"); } return { skipped: "budget" };`);
  return { ...loaded, source: forced, shortCircuit: true };
}
