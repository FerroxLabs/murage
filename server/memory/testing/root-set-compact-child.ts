// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child process for the kill test (root-set-v7.test.ts): converts root sets
// in tiny steps, saying so after each, until its parent kills it.
import { DatabaseSync } from "node:sqlite";
import { compactRootSetsStep } from "../root-set-compaction.ts";

const db = new DatabaseSync(process.argv[2]!);
db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
for (;;) {
  const step = compactRootSetsStep(db, { maxRows: 40, maxMs: 1_000_000 });
  process.stdout.write(`step ${step.converted}\n`);
  if (!step.remaining) break;
}
process.stdout.write("finished\n");
