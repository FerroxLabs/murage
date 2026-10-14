// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Removes a deleted conversation's history from the engines' own files (Fuigo's search index, Codex's database, Claude's
// projects and the rest) off the server's main thread: those files can be hundreds of megabytes, and rewriting or vacuuming
// one holds the thread that runs it. The same code (runEngineHistoryJob) runs here; this file only passes the job in and
// the answer back. See engine-history-offthread.ts.
import { parentPort } from "node:worker_threads";
import { runEngineHistoryJob } from "./engine-history-run.ts";
import type { EngineHistoryJob } from "./engine-history-offthread.ts";

const port = parentPort;
if (port) {
  port.once("message", (job: EngineHistoryJob) => {
    port.postMessage({ type: "result", result: runEngineHistoryJob(job, (key, index) => port.postMessage({ type: "step", key, index })) });
  });
}
