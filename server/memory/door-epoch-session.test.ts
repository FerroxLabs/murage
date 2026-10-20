// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lineage S6 rules 26 and 29 (test 35, the stamp and bypass parts): the door epoch stamp is written only on INSERT by a fresh session.started,
// never by a resumed turn and never by ON CONFLICT; doorEpochVerdict reads withheld("door-epoch") for no row, a NULL stamp or one below
// the key, and runs before the lineageLive bypass at both sites, so a file with no line rows still resets every retained session once.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { doorEpochVerdict, lineageLive } from "./deny-read.ts";
import { writetimeSessionVerdict } from "./dispatch.ts";
import { writeSessionLineage } from "./lineage-write.ts";
import type { TurnLineage } from "./lineage-types.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
const app = () => new WritetimeFixture(database());
const key = (nativeSession: string) => ({ threadId: "T", driverInstance: "d", nativeSession });
const turn = (turnLsn: number): TurnLineage => ({ threadId: "T", turnId: `turn-${turnLsn}`, turnLsn, parents: [], denyGeneration: 0 });
const stamp = (session: string) => database().prepare("SELECT door_epoch FROM memory_session_lineage WHERE thread_id='T' AND driver_instance='d' AND native_session=?").get(session)?.door_epoch;
const epoch = () => Number(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch'").get()!.value);

it("doorEpochVerdict: no row, a NULL stamp and a stamp below the key withhold; a stamp at or above it shows", () => {
  const f = app();
  const db = database();
  expect(doorEpochVerdict(db, key("none"))).toEqual({ state: "withheld", reason: "door-epoch" });
  f.sessionLineage("T", "d", "legacy", 1, 2, null);
  expect(doorEpochVerdict(db, key("legacy"))).toEqual({ state: "withheld", reason: "door-epoch" });
  f.meta("reader_door_epoch", 7).sessionLineage("T", "d", "below", 1, 2, 6).sessionLineage("T", "d", "at", 1, 2, 7).sessionLineage("T", "d", "above", 1, 2, 9);
  expect(doorEpochVerdict(db, key("below"))).toEqual({ state: "withheld", reason: "door-epoch" });
  expect(doorEpochVerdict(db, key("at"))).toEqual({ state: "shown" });
  expect(doorEpochVerdict(db, key("above"))).toEqual({ state: "shown" });
});

it("the stamp is written on INSERT by a fresh start only: a resumed write leaves NULL, ON CONFLICT never touches it, a resumed old id never gains one", () => {
  app();
  expect(transaction(tx => writeSessionLineage(tx, key("fresh"), turn(1), true))).toBe(true);
  expect(stamp("fresh")).toBe(epoch());
  database().prepare("UPDATE memory_lineage_lsn_meta SET value=value+5 WHERE key='reader_door_epoch'").run();
  const before = Number(stamp("fresh"));
  transaction(tx => writeSessionLineage(tx, key("fresh"), turn(2), true)); // a second session.started on the same row: ON CONFLICT
  transaction(tx => writeSessionLineage(tx, key("fresh"), turn(3)));
  expect(stamp("fresh")).toBe(before);
  transaction(tx => writeSessionLineage(tx, key("resumed"), turn(4))); // a resumed turn whose id has no row: inserted unstamped
  expect(stamp("resumed")).toBeNull();
  transaction(tx => writeSessionLineage(tx, key("resumed"), turn(5)));
  expect(stamp("resumed")).toBeNull();
  expect(writetimeSessionVerdict("T", "d", "resumed")).toEqual({ state: "withheld", reason: "door-epoch" });
});

it("both bypass sites reset an unstamped session with lineageLive false, and admit a stamped one", () => {
  const f = app();
  expect(lineageLive(database())).toBe(false);
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "withheld", reason: "door-epoch" });
  f.sessionLineage("T", "d", "n", 1, 2, null);
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "withheld", reason: "door-epoch" });
  f.sessionLineage("T", "d", "n", 1, 2);
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "shown" });
});
