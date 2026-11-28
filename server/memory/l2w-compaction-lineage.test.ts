// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2W 1.0.23 (designs/L2W-1023-WARM-MAP.md r3) L2W-7a, donor row #6670: compaction is not a laundry. ALREADY-HELD, no lineage-write change.
// (i) A compaction that reports a NEW native session id (Claude: a second system/init, claude.ts:6091) is recorded by a NON-fresh session
//     start (index.ts sessionStartOf: lineage.session is already set), which inserts door_epoch NULL; the next admit resets it with
//     writetime-door-epoch (dispatch.ts:80). Asserted on writetimeSessionVerdict for the new id (Opus r3 M1 fallback).
// (ii) Same id (Codex keeps the thread id): first_lsn is set once at insert and ON CONFLICT never moves it, so C-R2 keeps holding the
//     session against a line revoked after it began (Fable r3 M1 fallback: a direct lineage-write unit guard, not prose).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { writetimeSessionVerdict } from "./dispatch.ts";
import { writeSessionLineage } from "./lineage-write.ts";
import type { TurnLineage } from "./lineage-types.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
const key = (nativeSession: string) => ({ threadId: "T", driverInstance: "d", nativeSession });
const turn = (turnLsn: number): TurnLineage => ({ threadId: "T", turnId: `turn-${turnLsn}`, turnLsn, parents: [], denyGeneration: 0 });
const firstLsn = (session: string) => database().prepare("SELECT first_lsn FROM memory_session_lineage WHERE thread_id='T' AND driver_instance='d' AND native_session=?").get(session)?.first_lsn;

it("L2W-7a (i): the turn's fresh session is admitted; the post-compaction new id from a second init (non-fresh start) resets with door-epoch", () => {
  new WritetimeFixture(database());
  transaction(tx => writeSessionLineage(tx, key("before-compact"), turn(1), true)); // the turn's first session.started: fresh, stamped
  expect(writetimeSessionVerdict("T", "d", "before-compact")).toEqual({ state: "shown" });
  transaction(tx => writeSessionLineage(tx, key("after-compact"), turn(1))); // /compact then a second init with a new id: non-fresh
  expect(writetimeSessionVerdict("T", "d", "after-compact")).toEqual({ state: "withheld", reason: "door-epoch" });
});

it("L2W-7a (ii): a same-id session write at a later LSN (compaction on the same thread id) never moves first_lsn", () => {
  new WritetimeFixture(database());
  transaction(tx => writeSessionLineage(tx, key("same-id"), turn(3), true));
  const began = Number(firstLsn("same-id"));
  transaction(tx => writeSessionLineage(tx, key("same-id"), turn(40)));
  transaction(tx => writeSessionLineage(tx, key("same-id"), turn(41), true));
  expect(Number(firstLsn("same-id"))).toBe(began);
  expect(began).toBeLessThan(40);
});
