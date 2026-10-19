// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A branch change on a thread that is not prepared yet is recorded at once and done after the thread is filled in slices (never filled in
// the write): it ends in the same states as the same changes on a prepared thread, including a second change while the first waits.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { dropThread } from "../branch-index.ts";
import { isPrepared, prepareStats } from "../branch-store.ts";
import * as messages from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { branchChangeTuning, drainBranchChanges, pendingBranchChanges } from "./branch-change.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); delete branchChangeTuning.sync; delete branchChangeTuning.slice; });
const message = (id: string, parentId: string | null) => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user" as const, kind: "text" as const });
const states = () => database().prepare("SELECT message_id, state FROM memory_sources ORDER BY message_id").all().map((row) => `${row.message_id}:${row.state}`);

async function scenario(unprepare: boolean): Promise<string[]> {
  let previous: string | null = null;
  for (let i = 1; i <= 12; i++) { messages.appendMessage("t", message(`m${i}`, previous)); previous = `m${i}`; }
  await drainBranchChanges(database());
  const sync = prepareStats.syncPrepares;
  const unfill = () => { if (unprepare) { database().exec("BEGIN IMMEDIATE"); dropThread(database(), "t"); database().prepare("DELETE FROM turn_first WHERE thread_id = 't'").run(); database().exec("COMMIT"); expect(isPrepared("t")).toBe(false); } };
  unfill();
  messages.setActiveLeaf("t", "m5");                // m6..m12 leave
  if (unprepare) { expect(pendingBranchChanges(database())).toBe(1); expect(isPrepared("t")).toBe(false); }
  messages.setActiveLeaf("t", "m9");                // a second change while the first waits
  await drainBranchChanges(database());
  messages.setActiveLeaf("t", "m3");
  await drainBranchChanges(database());
  unfill();
  messages.appendMessage("t", message("edit", "m2")); // an edit far back
  await drainBranchChanges(database());
  expect(pendingBranchChanges(database())).toBe(0);
  expect(prepareStats.syncPrepares).toBe(sync);
  return states();
}

it("ends in the same states on an unprepared thread as on a prepared one, with no synchronous fill", async () => {
  const prepared = await scenario(false);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  const unprepared = await scenario(true);
  expect(unprepared).toEqual(prepared);
  expect(prepared).toContain("edit:active"); expect(prepared).toContain("m2:active"); expect(prepared).toContain("m3:retired");
});
