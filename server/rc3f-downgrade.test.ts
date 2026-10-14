// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Going back to 1.0.1 with a long branch switch cut short (a crash after the head moved, before the slices finished) finishes the switch first, so no
// memory source is left half way between the two branches, and the queue that held its place is dropped only when it is empty.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { downgradeApplicationSchemaTo101 } from "./installation-app-schema-downgrade.ts";
import * as messages from "./message-db.ts";
import { branchChangeTuning, pendingBranchChanges } from "./memory/branch-change.ts";
import { setMemoryMode } from "./memory/repository.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); delete branchChangeTuning.sync; delete branchChangeTuning.slice; });
const message = (id: string, parentId: string | null) => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user" as const, kind: "text" as const });

it("a pending branch change is finished (in slices) before its queue is dropped: the sources end on the selected branch", () => {
  branchChangeTuning.sync = 2; branchChangeTuning.slice = 2;
  let previous: string | null = null;
  for (let i = 1; i <= 12; i++) { messages.appendMessage("t", message(`m${i}`, previous)); previous = `m${i}`; }
  expect(pendingBranchChanges(database())).toBe(0);
  // an edit at m3: m4..m12 must leave, but the drain never runs (the process stopped)
  messages.appendMessage("t", message("edit", "m3"));
  expect(Number(database().prepare("SELECT COUNT(*) AS n FROM branch_change").get()!.n)).toBe(1);
  expect(database().prepare("SELECT state FROM memory_sources WHERE message_id='m4'").get()?.state).toBe("active"); // half switched
  const progress: number[] = [];
  downgradeApplicationSchemaTo101(database(), DATA_DIR, { branchChangeProgress: (n) => progress.push(n) });
  expect(progress.length).toBeGreaterThan(1); // sliced, with progress
  expect(database().prepare("SELECT 1 AS x FROM sqlite_schema WHERE name='branch_change'").get()).toBeUndefined();
  const states = new Map(database().prepare("SELECT message_id, state FROM memory_sources").all().map((row) => [String(row.message_id), String(row.state)]));
  for (let i = 1; i <= 3; i++) expect(states.get(`m${i}`)).toBe("active");
  for (let i = 4; i <= 12; i++) expect(states.get(`m${i}`)).toBe("retired");
  expect(states.get("edit")).toBe("active");
});
