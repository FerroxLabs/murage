// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test helper: builds the revocation index slice by slice on the file in argv[2] and reports each committed slice to its
// parent over IPC, pausing between slices, until the parent ends it (the test kills it mid-build).
import { DatabaseSync } from "node:sqlite";
import { buildRevocationIndexStep } from "../revocation-index.ts";

const db = new DatabaseSync(String(process.argv[2]));
db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000");
let guard = 0;
const next = () => {
  const step = buildRevocationIndexStep(db, 50);
  process.send?.({ type: "progress", done: step.done, ready: step.ready });
  if (step.ready || ++guard > 10_000) { process.exit(0); }
  setTimeout(next, 150);
};
next();
