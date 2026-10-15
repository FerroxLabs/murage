// SPDX-License-Identifier: AGPL-3.0-or-later
// The event-log prune's forgotten-message lookup: large transcript columns and SQLite waits stay on this thread. The main database is
// opened read-only; every page is two keyed statements of at most 200 rows (event-log.ts forgottenTextsReader).
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { forgottenTextsReader } from "./harness/event-log.ts";
import type { TranscriptReadRequest } from "./transcript-read.ts";

const port = parentPort;
if (port) {
  const db = new DatabaseSync(workerData.file, { readOnly: true });
  db.exec("PRAGMA busy_timeout=1000");
  let forgotten: ReturnType<typeof forgottenTextsReader> | undefined;
  port.on("message", ({ id, request }: { id: number; request: TranscriptReadRequest }) => {
    try {
      // A test can hold the worker in a synchronous step until a health response releases it.
      if (workerData.gate) { const gate = new Int32Array(workerData.gate); Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); Atomics.wait(gate, 0, 0); }
      if (request.after === 0) forgotten = forgottenTextsReader(db, true);
      if (!forgotten) throw new Error("Forgotten lookup must restart after a worker exit");
      const result = forgotten();
      if (result.last === null) forgotten = undefined;
      port.postMessage({ id, result });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
