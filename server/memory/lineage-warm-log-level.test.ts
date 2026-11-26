// SPDX-License-Identifier: AGPL-3.0-or-later
// sweep-1021 N6: a warming step that the background budget deferred (BG_DEFERRED, a lock wait) is the normal state of a busy machine and is tried
// again, so it is a note and not a warning; a failure that is not a deferral stays a warning.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BgDeferred } from "../bg-admission.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import type { LineageFootprint } from "./lineage-footprint.ts";
import { lineageWarmStep, noteLineageFootprint, resetLineageWarmForTest, setLineageConfirmSourcesForTest } from "./lineage-warm.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { forgetKeptLineageForTest, thawRootSetWritesForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

// The step's own transaction guard is the first read after its retired check: a refusal there surfaces inside the step's try, as a background deferral does in production.
const fault = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock("../database.ts", async importOriginal => {
  const real = await importOriginal<typeof import("../database.ts")>();
  return { ...real, database: () => {
    const db = real.database();
    return fault.error ? new Proxy(db, { get(target, key) { if (key === "isTransaction") throw fault.error; const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } }) : db;
  } };
});

const thread = "conv-log-level";
const footprint: LineageFootprint = { botId: "b", threadId: thread, accessStamp: "fixture", exclude: [], routeHasTools: false, externalUpdates: "[]", maxBytes: 4096, cursor: null };
beforeEach(() => {
  thawRootSetWritesForTest(true); resetLineageWarmForTest(); setLineageConfirmSourcesForTest(null);
  closeDatabase(); forgetKeptLineageForTest(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active");
  reconcileMemoryRoster({ bots: [{ id: "b", threadId: thread }], groups: [] });
  database().prepare("INSERT OR REPLACE INTO memory_lineage_lsn_meta(key,value) VALUES('root_sets_dropped',1)").run();
});
afterEach(() => { vi.restoreAllMocks(); setLineageConfirmSourcesForTest(null); resetLineageWarmForTest(); thawRootSetWritesForTest(false); });

function stepWith(error: Error): { info: string[]; warn: string[] } {
  const info: string[] = [], warn: string[] = [];
  vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => { info.push(a.map(String).join(" ")); });
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { warn.push(a.map(String).join(" ")); });
  noteLineageFootprint(thread, footprint);
  fault.error = error;
  try { lineageWarmStep(25); } finally { fault.error = null; }
  return { info, warn };
}

it("a deferred warming step is a note, not a warning", () => {
  const { info, warn } = stepWith(new BgDeferred(1));
  expect(info.filter(line => line.includes("lineage warming"))).not.toEqual([]);
  expect(warn.filter(line => line.includes("lineage warming"))).toEqual([]);
});

it("a warming failure that is not a deferral stays a warning", () => {
  const { info, warn } = stepWith(new Error("fixture broken mint"));
  expect(warn.filter(line => line.includes("lineage warming"))).not.toEqual([]);
  expect(info.filter(line => line.includes("lineage warming"))).toEqual([]);
});
