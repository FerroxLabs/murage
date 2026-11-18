// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CJ-5 (trainred-b5-cj56): on a retired file (S6) the warmer still owes a noted record its confirm, and only that: lineageWarmIdle says busy
// while such a confirm is due and could run, and idle once it ran. A record whose confirm cannot run (no mint registered: it would only read
// "checking: inputs") is no work owed, so the warmer is idle at once instead of waiting for a step the boot holds may delay
// (warm-scale-retired.test.ts, the first send after a restart).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import type { LineageFootprint } from "./lineage-footprint.ts";
import { bumpLineageWarm, lineageThreadState, lineageWarmIdle, lineageWarmRecordForTest, lineageWarmStep, noteLineageFootprint, resetLineageWarmForTest, setLineageConfirmSourcesForTest } from "./lineage-warm.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { readTimeRetired } from "./read-time-retired.ts";
import { forgetKeptLineageForTest, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const thread = "conv-retired-idle";
const footprint: LineageFootprint = { botId: "b", threadId: thread, accessStamp: "fixture", exclude: [], routeHasTools: false, externalUpdates: "[]", maxBytes: 4096, cursor: null };
beforeEach(() => {
  thawRootSetWritesForTest(true); resetLineageWarmForTest(); setLineageConfirmSourcesForTest(null);
  closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  // the reclaim's mark (root-set-reclaim.ts): the read-time judge is retired on this file
  database().prepare("INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',1)").run();
  expect(readTimeRetired(database())).toBe(true);
});
afterEach(() => { setLineageConfirmSourcesForTest(null); resetLineageWarmForTest(); thawRootSetWritesForTest(false); });

it("a retired file with no mint registered: a noted record owes nothing, the warmer is idle before any step and the thread never reads warm", () => {
  noteLineageFootprint(thread, footprint);
  expect(lineageWarmRecordForTest(thread)?.footprint).toMatchObject({ threadId: thread });
  expect(lineageWarmIdle()).toBe(true);
  expect(lineageThreadState(thread)).not.toBe("warm");
});

it("a retired file with a mint: the noted record's confirm is owed (busy) until a step runs it, then the warmer is idle and the thread is not warm", () => {
  let minted = 0;
  setLineageConfirmSourcesForTest({ mint: () => { minted++; return null; } });
  noteLineageFootprint(thread, footprint);
  expect(lineageWarmIdle()).toBe(false);
  let steps = 0;
  while (lineageWarmStep(25)) if (++steps > 50) throw new Error("the warmer did not finish");
  expect(minted).toBe(1);
  expect(lineageWarmRecordForTest(thread)?.reason).toBe("access: mint failed");
  expect(lineageWarmIdle()).toBe(true);
  expect(lineageThreadState(thread)).not.toBe("warm");
});

it("a retired file: a thread whose confirm cannot be owed reads retired (nothing will ever warm it), one whose confirm can run keeps its own state", () => {
  // lineageWarmStep drops the queue and the discovery on such a file and a confirm is owed only where it can run (lineageWarmIdle), so
  // "pending" would never end for these (index-harness.ts waitForLineageSettled). A record whose confirm can run is read the CJ-5 way.
  // (1) no record at all
  expect(lineageWarmRecordForTest("conv-retired-unnoted")).toBeNull();
  expect(lineageThreadState("conv-retired-unnoted")).toBe("retired");
  // (2) a send arrived (bumpLineageWarm): a record with no footprint, so no confirm to run
  bumpLineageWarm("conv-retired-bumped");
  expect(lineageWarmRecordForTest("conv-retired-bumped")?.footprint).toBeNull();
  expect(lineageThreadState("conv-retired-bumped")).toBe("retired");
  // (3) a noted record with no mint registered: its confirm cannot run
  noteLineageFootprint(thread, footprint);
  expect(lineageWarmIdle()).toBe(true);
  expect(lineageThreadState(thread)).toBe("retired");
  // (4) with a mint the confirm is owed: the record's own state, never retired and not warm before it ran
  setLineageConfirmSourcesForTest({ mint: () => null });
  expect(lineageWarmIdle()).toBe(false);
  expect(lineageThreadState(thread)).not.toBe("retired");
  expect(lineageThreadState(thread)).not.toBe("warm");
  // ... while the send-only record still has no footprint, so no confirm to run even with a mint
  expect(lineageThreadState("conv-retired-bumped")).toBe("retired");
});

it("control: a file whose read-time judge is live reads a thread with no record as pending", () => {
  // (the retired mark is monotone for a connection: a fresh file without the reclaim's mark)
  closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  expect(readTimeRetired(database())).toBe(false);
  expect(lineageWarmRecordForTest("conv-live-unnoted")).toBeNull();
  expect(lineageThreadState("conv-live-unnoted")).toBe("pending");
});
