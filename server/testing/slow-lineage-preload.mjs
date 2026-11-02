// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-process-only preload for server/claude-resume-slow-check.test.ts. It stands in for a cold database on a slow machine: while the
// flag file exists, the first read of a session's door epoch (the first lineage read of every resume check) holds the event loop for
// MURAGE_TEST_SLOW_LINEAGE_MS and removes the flag, so exactly one check meets a slow read and the next one is fast, as a warm cache is.
// Production never loads this file: only that test passes it.
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

const flag = process.env.MURAGE_TEST_SLOW_LINEAGE_FLAG;
const ms = Number(process.env.MURAGE_TEST_SLOW_LINEAGE_MS ?? 120);

if (isMainThread && flag) {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    if (typeof sql === "string" && sql.includes("SELECT door_epoch FROM memory_session_lineage") && existsSync(flag)) {
      rmSync(flag, { force: true });
      const until = performance.now() + ms;
      while (performance.now() < until) { /* a slow disk read holds the loop the same way */ }
    }
    return prepare.call(this, sql, ...rest);
  };
}
