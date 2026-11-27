// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Module hook for recall-slow-preload.mjs (test-process only). Wraps ONE call: the overlapped recall a turn starts at slot
// acquisition (index.ts early.start -> buildMemoryBundle), so the real build is held by the preload's delay before it settles.
// The dispatch step (if(early)bundle=await awaitRecall(early)) and recall-budget.ts are left as they are. The rewrite fails
// loudly if the call moved, so the test can never pass on a turn whose recall was not held.
const SLOW = 'globalThis[Symbol.for("murage.test.recallSlow")]';
const EARLY = "const built = await buildMemoryBundle(query, access, memoryWorker, { ...options, signal, allowance });";
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!/\/server\/index\.ts$/.test(new URL(url).pathname)) return loaded;
  const source = String(loaded.source);
  if (source.split(EARLY).length !== 2) throw new Error("RECALL_SLOW_PRELOAD: the overlapped recall moved");
  return { ...loaded, shortCircuit: true, source: source.replace(EARLY, `const built = await ${SLOW}(buildMemoryBundle(query, access, memoryWorker, { ...options, signal, allowance }), signal);`) };
}
