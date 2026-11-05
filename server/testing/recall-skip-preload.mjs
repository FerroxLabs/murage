// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload: every overlapped memory recall is skipped as if it had run past RECALL_WAIT_MS, so a
// test drives the dispatch step's skip branch (index.ts awaitRecall: the early bundle is cancelled and the turn goes
// out with a recall-free bundle) on every turn, whatever the machine's speed. A slow runner reaches that branch only
// now and then; this reaches it every time.
//
// MURAGE_TEST_RECALL_SKIP=1 turns it on. withRecallBudget answers { skipped: "budget" } at once, while the early
// build is usually still running, which is the case a slow machine hits.
//
// Production never loads this file: it is not in the packaged server, and only a test that passes it to `--import`
// with the variable set turns it on. It reads no input from a turn, a bot or a request.
import { register } from "node:module";
import { isMainThread } from "node:worker_threads";

if (isMainThread && process.env.MURAGE_TEST_RECALL_SKIP === "1") register("./recall-skip-loader.mjs", import.meta.url);
