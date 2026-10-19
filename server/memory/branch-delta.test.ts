// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A branch change (an edit, a switch between versions) moves a few rows from
// one side to the other. Memory updates the sources of those rows and their
// jobs, not every source of the thread, and ends with exactly the states the
// long way (every source judged against the whole new branch) gives, whether the
// change fits the write that moved the head or runs on in slices after it.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import * as messages from "../message-db.ts";
import { setMemoryMode } from "./repository.ts";
import { branchChangeTuning, drainBranchChanges, pendingBranchChanges } from "./branch-change.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture"); delete branchChangeTuning.sync; delete branchChangeTuning.slice; });
const message = (id: string, parentId: string | null) => ({ id, text: `words of ${id}`, parentId, at: 1, role: "user" as const, kind: "text" as const });
const snapshot = () => ({
  sources: database().prepare("SELECT message_id, state FROM memory_sources ORDER BY message_id").all().map((row) => `${row.message_id}:${row.state}`),
  jobs: database().prepare("SELECT s.message_id AS m, j.status AS status, substr(j.error,1,7) AS parked FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id ORDER BY s.message_id, j.source_revision").all().map((row) => `${row.m}:${row.status}:${row.parked}`),
});

/** A tree: root > a1 > a2 > a3 > a4, a fork b3 > b4 at a2, and c1 > c2 beside a1 under root. */
async function run(): Promise<Array<ReturnType<typeof snapshot>>> {
  const steps: Array<ReturnType<typeof snapshot>> = [];
  const add = async (id: string, parent: string | null) => { messages.appendMessage("t", message(id, parent)); await drainBranchChanges(database()); steps.push(snapshot()); };
  await add("root", null); await add("a1", "root"); await add("a2", "a1"); await add("a3", "a2"); await add("a4", "a3");
  await add("b3", "a2"); await add("b4", "b3");
  await add("c1", "root"); await add("c2", "c1");
  for (const leaf of ["a4", "b4", "c2", "a3", "b3", "root", "a4", "c1", "b4"]) { messages.setActiveLeaf("t", leaf); await drainBranchChanges(database()); steps.push(snapshot()); }
  return steps;
}

it("ends every branch change in the same states whether it fits the write or runs on in slices of one row", async () => {
  const whole = await run();
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("capture");
  branchChangeTuning.sync = 1; branchChangeTuning.slice = 1;
  const sliced = await run();
  expect(sliced).toEqual(whole);
  // and the states are the branch: after the last switch (to b4) a1, a2, b3, b4 and root are active
  const last = whole.at(-1)!;
  expect(last.sources).toEqual(["a1:active", "a2:active", "a3:retired", "a4:retired", "b3:active", "b4:active", "c1:retired", "c2:retired", "root:active"]);
  // a retired source's open job is parked, an active one's is open
  expect(last.jobs.filter((job) => job.startsWith("a3:") || job.startsWith("c1:")).every((job) => job.includes("cancelled:parked:"))).toBe(true);
  expect(last.jobs.filter((job) => job.startsWith("b4:") || job.startsWith("root:")).every((job) => !job.includes("parked:"))).toBe(true);
});

it("a change longer than the write's share leaves the rest pending, and finishes it in slices", async () => {
  branchChangeTuning.sync = 2; branchChangeTuning.slice = 2;
  let previous: string | null = null;
  for (let i = 1; i <= 12; i++) { messages.appendMessage("t", message(`m${i}`, previous)); previous = `m${i}`; }
  await drainBranchChanges(database());
  // an edit at m3: m4..m12 leave (9 rows, more than the write's 2), the edit joins
  messages.appendMessage("t", message("edit", "m3"));
  expect(pendingBranchChanges(database())).toBe(1);
  await drainBranchChanges(database());
  expect(pendingBranchChanges(database())).toBe(0);
  const states = new Map(database().prepare("SELECT message_id, state FROM memory_sources").all().map((row) => [String(row.message_id), String(row.state)]));
  for (let i = 1; i <= 3; i++) expect(states.get(`m${i}`)).toBe("active");
  for (let i = 4; i <= 12; i++) expect(states.get(`m${i}`)).toBe("retired");
  expect(states.get("edit")).toBe("active");
  // a second change while the first is pending finishes the first
  messages.setActiveLeaf("t", "m12");
  messages.setActiveLeaf("t", "edit");
  await drainBranchChanges(database());
  for (let i = 4; i <= 12; i++) expect(database().prepare("SELECT state FROM memory_sources WHERE message_id = ?").get(`m${i}`)?.state).toBe("retired");
});
