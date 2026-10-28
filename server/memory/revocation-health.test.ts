// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel observation of memory revocation (GAP-SENTINEL-109 4.2, S02 annotation, and db_stats pending figures): each
// record a job ends counts as an affect attempt, already deleted or state changed, with the bytes it clears and the
// phase's operation class; job rows keep the pending figures, unknown until the runner's own next-job read finds none.
// The revocation's decisions are unchanged (the record still ends deleted with no text).
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { drainServerWindows, freshServerCounters, total } from "../health/test-support.ts";
import { pendingRevocationFigures, resetPendingRevocationsForTests } from "../health/pending-revocations.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { advanceRevocationJob, createRevocationJob, runRevocationJobsNow, type RevocationJob } from "./memory-revocation.ts";

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  resetPendingRevocationsForTests();
  freshServerCounters();
});

function world() {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  const scope = ensureScope("bot", "bot");
  const db = database();
  const insert = db.prepare("INSERT INTO memory_records VALUES(?,?,?,'fact',?,'owner-statement',?,0,1,NULL,NULL,1)");
  insert.run("rec", 1, scope, "PRIVATE words", "active");
  insert.run("rec", 2, scope, "", "deleted");
  return db;
}
const job = (): RevocationJob => ({ v: 2, id: "job-health", phases: ["expand"], c: null, record: { id: "rec", rev: null, notes: true } });

it("counts each ended record version, already deleted or changed, the bytes it clears, and the phase's operation", () => {
  const db = world();
  drainServerWindows();
  db.exec("BEGIN");
  expect(advanceRevocationJob(db, job(), 10_000)).toBe(true);
  db.exec("COMMIT");
  const windows = drainServerWindows();
  expect(total(windows, "io-pressure", "affect-attempts")).toBe(2);
  expect(total(windows, "io-pressure", "prior-deleted")).toBe(1);
  expect(total(windows, "io-pressure", "state-changed")).toBe(1);
  expect(total(windows, "io-pressure", "bytes-attributed")).toBe(Buffer.byteLength("PRIVATE words"));
  expect(total(windows, "io-pressure", "affect")).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(windows)).not.toContain("PRIVATE");
  // the decision is the revocation's own: both versions end deleted with no text
  expect(db.prepare("SELECT version,state,text FROM memory_records WHERE id='rec' ORDER BY version").all()).toEqual([
    { version: 1, state: "deleted", text: "" }, { version: 2, state: "deleted", text: "" },
  ]);
});

it("pending figures: NULL until the runner reads an empty queue, then one per job row until it ends", () => {
  const db = world();
  expect(createRevocationJob(db, job())).not.toBeNull();
  expect(pendingRevocationFigures()).toEqual({ pending_revocations: null, oldest_pending_at: null });
  runRevocationJobsNow(db);
  expect(pendingRevocationFigures()).toEqual({ pending_revocations: 0, oldest_pending_at: null });
  const before = Date.now();
  createRevocationJob(db, { ...job(), id: "job-health-2" });
  const figures = pendingRevocationFigures();
  expect(figures.pending_revocations).toBe(1);
  expect(figures.oldest_pending_at).toBeGreaterThanOrEqual(before);
  runRevocationJobsNow(db);
  expect(pendingRevocationFigures()).toEqual({ pending_revocations: 0, oldest_pending_at: null });
});
