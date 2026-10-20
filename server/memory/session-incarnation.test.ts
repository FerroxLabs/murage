// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lineage S6 rule 27 (test 35, the incarnation parts): a fresh session.started takes the next n for its native id from the append-only
// allocator in the transaction that writes its session row; n = 1 is the raw id, n >= 2 is `${id}#${n}`; repeated fresh starts with no line
// written between them, and a restart between them, get distinct keys and fresh stamps, while the old key's deny marks, disclosures and
// session number stay; a pre-1.0.3 id (a lineage row, no allocator row) counts as n = 1; a resume forms the same key from the stored
// incarnation; and one helper forms every SessionKey (no `nativeSession:` literal outside it).
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { doorEpochVerdict, sessionLookup } from "./deny-read.ts";
import { writetimeSessionVerdict } from "./dispatch.ts";
import type { TurnLineage } from "./lineage-types.ts";
import { noteReceiptOutput, noteReceiptSession, receiptStart } from "./receipt-outputs.ts";
import { latestIncarnation, sessionKeyOf, startFreshSession } from "./session-incarnation.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
const app = () => new WritetimeFixture(database());
const turn = (turnLsn: number): TurnLineage => ({ threadId: "T", turnId: `turn-${turnLsn}`, turnLsn, parents: [], denyGeneration: 0 });
const stamp = (session: string) => database().prepare("SELECT door_epoch FROM memory_session_lineage WHERE thread_id='T' AND driver_instance='d' AND native_session=?").get(session)?.door_epoch;
const key = (nativeSession: string) => ({ threadId: "T", driverInstance: "d", nativeSession });
const count = (table: string) => Number(database().prepare(`SELECT count(*) AS c FROM ${table}`).get()!.c);

it("sessionKeyOf: the raw id for n = 1 (and a missing incarnation), `${id}#${n}` from n = 2", () => {
  expect(sessionKeyOf("T", "d", "s")).toEqual({ threadId: "T", driverInstance: "d", nativeSession: "s" });
  expect(sessionKeyOf("T", "d", "s", 1)).toEqual({ threadId: "T", driverInstance: "d", nativeSession: "s" });
  expect(sessionKeyOf("T", "d", "s", 2).nativeSession).toBe("s#2");
  expect(sessionKeyOf("T", "d", "s", 3).nativeSession).toBe("s#3");
});

it("repeated fresh starts of one native id get n = 1, 2, 3: distinct keys, fresh stamps, the old key's rows stay and judge only the old key", () => {
  const f = app();
  const first = transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1)));
  expect(first).toMatchObject({ incarnation: 1, key: { nativeSession: "s" }, recorded: true });
  // the old incarnation is revoked: a deny mark, a disclosure bound to it and its session number
  f.denySession("T", "d", "s").receipt("b1", "T", "d", "s");
  noteReceiptOutput(database(), "b1", "T", 1, { driverInstance: "d", nativeSession: "s" });
  const oldNo = Number(database().prepare("SELECT session_no FROM memory_receipt_lines WHERE bundle_id='b1'").get()!.session_no);
  expect(sessionLookup(database(), key("s"), { audience: null })).toEqual({ state: "withheld", reason: "deny-session" });
  // no line is written between the next two starts
  const second = transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1)));
  const third = transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1)));
  expect([second.incarnation, third.incarnation]).toEqual([2, 3]);
  expect([second.key.nativeSession, third.key.nativeSession]).toEqual(["s#2", "s#3"]);
  const epoch = Number(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='reader_door_epoch'").get()!.value);
  expect([stamp("s#2"), stamp("s#3")]).toEqual([epoch, epoch]);
  expect(doorEpochVerdict(database(), second.key)).toEqual({ state: "shown" });
  expect(writetimeSessionVerdict("T", "d", "s#3")).toEqual({ state: "shown" });
  expect(sessionLookup(database(), third.key, { audience: null })).toEqual({ state: "shown" });
  // nothing of the old incarnation was deleted, and it still judges the old key
  expect(Number(database().prepare("SELECT count(*) AS c FROM memory_deny_session WHERE native_session='s'").get()!.c)).toBe(1);
  expect(database().prepare("SELECT native_session FROM memory_disclosures WHERE bundle_id='b1'").get()!.native_session).toBe("s");
  expect(receiptStart(database(), "b1")!.session).toEqual({ threadId: "T", driverInstance: "d", nativeSession: "s" });
  expect(Number(database().prepare("SELECT no FROM memory_session_no WHERE native_session='s'").get()!.no)).toBe(oldNo);
  expect(sessionLookup(database(), key("s"), { audience: null })).toEqual({ state: "withheld", reason: "deny-session" });
  // a new incarnation takes a new session number on its first receipt
  f.receipt("b3", "T", "d", "s#3");
  noteReceiptOutput(database(), "b3", "T", 2);
  noteReceiptSession(database(), ["b3"], third.key);
  const newNo = Number(database().prepare("SELECT session_no FROM memory_receipt_lines WHERE bundle_id='b3'").get()!.session_no);
  expect(newNo).not.toBe(oldNo);
  expect(count("memory_session_incarnation")).toBe(3);
});

it("a restart between fresh starts still advances n; latestIncarnation allocates nothing", () => {
  // the server's own file (no fixture tables), closed and reopened as a restart does
  transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1)));
  closeDatabase();
  expect(latestIncarnation(database(), "T", "d", "s")).toBe(1);
  expect(transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1))).incarnation).toBe(2);
  expect(latestIncarnation(database(), "T", "d", "s")).toBe(2);
  expect(latestIncarnation(database(), "T", "d", "never")).toBe(1);
  expect(count("memory_session_incarnation")).toBe(2);
});

it("a pre-1.0.3 id (a lineage row, no allocator row) counts as n = 1: its next fresh start is n = 2 and never stamps the legacy row", () => {
  const f = app();
  f.sessionLineage("T", "d", "L", 1, 2, null);
  const next = transaction(tx => startFreshSession(tx, "T", "d", "L", turn(3)));
  expect(next).toMatchObject({ incarnation: 2, key: { nativeSession: "L#2" } });
  expect(stamp("L")).toBeNull();
  expect(writetimeSessionVerdict("T", "d", "L")).toEqual({ state: "withheld", reason: "door-epoch" });
  expect(writetimeSessionVerdict("T", "d", "L#2")).toEqual({ state: "shown" });
});

it("a failed session row rolls the allocation back with it", () => {
  app();
  expect(() => transaction(tx => { startFreshSession(tx, "T", "d", "s", turn(1)); throw new Error("boom"); })).toThrow("boom");
  expect(count("memory_session_incarnation")).toBe(0);
  expect(transaction(tx => startFreshSession(tx, "T", "d", "s", turn(1))).incarnation).toBe(1);
});

// the structural rule: every SessionKey the server forms goes through sessionKeyOf
const ROOT = join(import.meta.dirname, "..");
const EXEMPT = new Set([
  "memory/session-incarnation.ts", // the helper
  "memory/lineage-types.ts", // the type and the child-ref parser (it reads a stored key back)
  "memory/lineage-backfill.ts", // the pre-1.0.3 backfill: every legacy session is n = 1, its raw id
]);
function serverFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "testing" && name !== "node_modules") serverFiles(path, out); }
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

it("no `nativeSession:` literal outside sessionKeyOf (type annotations aside)", () => {
  const offenders: string[] = [];
  for (const file of serverFiles(ROOT)) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/"); // '/' on every platform, as EXEMPT is written
    if (EXEMPT.has(rel)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      // a parameter or field type (`nativeSession: string`) is not a key being formed
      const literal = line.replace(/nativeSession\??\s*:\s*string\b/g, "");
      if (/\bnativeSession\s*:/.test(literal)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});

it("the resume forms its memory key from the cursor and the stored incarnation, and the driver resumes by the raw id", () => {
  const index = readFileSync(join(ROOT, "index.ts"), "utf8");
  expect(index).toMatch(/resumeIncarnations\?\.\[instanceId\]/);
  expect(index).toMatch(/sessionKeyOf\(threadId, instanceId, String\(resumeCursor\)/);
  const store = readFileSync(join(ROOT, "store.ts"), "utf8");
  expect(store).toMatch(/resumeIncarnations\?: Record<string, number>/);
});
