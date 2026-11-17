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
import { lineageThreadState, lineageWarmIdle, lineageWarmRecordForTest, lineageWarmStep, noteLineageFootprint, resetLineageWarmForTest, setLineageConfirmSourcesForTest } from "./lineage-warm.ts";
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
