// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Boot tolerance, one unit: the composed venue recovery settles a card only for a row it moved in the same transaction, and a refusal the admission
// gate publishes AFTER that transaction was admitted is thrown out of it (never turned into rows that look moved).
import { mkdirSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { Store } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { heldVenuePost, holdVenuePost, moveVenuePost, recoverAndSettleVenuePosts, recoverVenuePosts, type VenuePostHeldRow } from "./venue-post-held.ts";
import { WAL_ADMISSION_BYTES } from "./wal-maintenance.ts";

const walFile = () => ((database() as unknown as { location(): string | null }).location()
  ?? join(DATA_DIR, readdirSync(DATA_DIR).find((name) => name.endsWith(".db"))!)) + "-wal";
/** The real admission gate refuses when the retained log is at the ceiling and no worker has copied it (the probes' own way: a sparse tail). */
const refuseAtGate = () => truncateSync(walFile(), WAL_ADMISSION_BYTES);
const seedPosting = () => {
  const db = database();
  holdVenuePost(db, { id: "vp-a", botId: "b1", threadId: "t-1to1", origin: "desktop", requestMessageId: "m1", requestHash: "h", venueId: "g1",
    targetThreadId: "t-room", text: "Hello room", stableId: "vp-a", lineage: "[]" });
  moveVenuePost(db, "vp-a", "held", "posting");
  return db;
};
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); new Store(() => ({ instanceId: "fixture", model: "fixture" })); });

it("W4 a refusal published after the outer admission settles nothing; once the gate clears the next call moves and settles once", () => {
  const db = seedPosting();
  const settled: VenuePostHeldRow[] = [];
  const settle = (row: VenuePostHeldRow) => { settled.push(row); };
  let reached = false;
  expect(() => transaction(() => {                                    // admitted here: the log is small
    refuseAtGate();                                                   // the refusal arrives while the transaction is open
    reached = true;
    return recoverAndSettleVenuePosts(db, transaction, () => true, settle);
  })).toThrow(/busy|wal-recovery/i);
  expect(reached).toBe(true);
  expect(settled).toEqual([]);                                        // no card settled for a row that did not move
  expect(heldVenuePost(db, "vp-a")?.state).toBe("posting");
  closeDatabase();                                                    // the last connection's close checkpoints the log: the gate admits again
  const again = database();
  const seen = recoverAndSettleVenuePosts(again, transaction, () => true, settle);
  expect(seen.map((row) => [row.id, row.state, row.moved])).toEqual([["vp-a", "posted", true]]);
  expect(settled.map((row) => row.id)).toEqual(["vp-a"]);
  expect(heldVenuePost(again, "vp-a")?.state).toBe("posted");
  expect(recoverAndSettleVenuePosts(again, transaction, () => true, settle)).toEqual([]);
  expect(settled).toHaveLength(1);
});

it("W4 the standalone recovery under refusal reports the row as not moved, and moves nothing", () => {
  const db = seedPosting();
  refuseAtGate();
  expect(recoverVenuePosts(db, () => true).map((row) => [row.state, row.moved])).toEqual([["posted", false]]);
  expect(heldVenuePost(db, "vp-a")?.state).toBe("posting");
  expect(() => recoverVenuePosts(db, () => true, Date.now(), true)).toThrow(/busy|wal-recovery/i);
});
