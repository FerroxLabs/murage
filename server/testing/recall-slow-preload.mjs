// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload (1.0.22 mem-strict r8, ASTRA f443268f73 index.ts awaitRecall): a turn's overlapped recall is built as
// production builds it, then held MURAGE_TEST_RECALL_SLOW_MS longer before it settles, as on a loaded machine; the dispatch step
// waits for it through its own awaitRecall (withRecallBudget(early, RECALL_WAIT_MS), the real module). Nothing in recall-budget.ts
// or the dispatch step is changed: a test reads the turn's own `memory recall skipped ... reason=budget` line.
//
// Production never loads this file: it is not in the packaged server, and only a test that passes it to `--import` with the
// variable set turns it on. It reads no input from a turn, a bot or a request.
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

const ms = Number(process.env.MURAGE_TEST_RECALL_SLOW_MS);
if (isMainThread && Number.isFinite(ms) && ms > 0) {
  // `settled` = the hold ended and dispatch had not cancelled the recall (it was still waited for); `cancelled` = dispatch dropped it
  // first (the budget skip, or an authority move that rebuilds it afresh)
  globalThis[Symbol.for("murage.test.recallSlow")] = (work, signal) => {
    console.warn(`RECALL_SLOW_PRELOAD delayed ms=${ms}`);
    return work.then(value => new Promise(resolve => setTimeout(() => { console.warn(`RECALL_SLOW_PRELOAD ${signal?.aborted ? "cancelled" : "settled"}`); resolve(value); }, ms)));
  };
  register("./recall-slow-loader.mjs", import.meta.url);
}
