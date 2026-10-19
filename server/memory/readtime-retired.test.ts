// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, 1.0.2 S6: the read-time lineage judge is retired on a file where lineage is written (read-time-retired.ts). Every entry
// point it had answers from the write-time lookups, and none reads a root-set table: the tables are handed back by the idle reclaim, so they are
// dropped from the file in these tests before the readers are asked.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage, closeMessageDb } from "../message-db.ts";
import type { Message } from "../store.ts";
import { authorityEpochInstalled } from "./authority-epoch.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { accessFor, freshDataDir } from "./testing/recall-fixture.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { drainRevokeMarker } from "./memory-revocation.ts";
import { provenanceTriggersInstalled } from "./provenance-stamp.ts";
import { readTimeRetired } from "./read-time-retired.ts";
import { capturedMessageVerdict, lineageTriggersInstalled, messageMadeWithMemory, outputRootsBad, outputRootsFor, replayExclusions, sessionLineageBad, sessionOutputRoots, setTurnLineageNodesForTest, threadHoldsMemoryLines } from "./replay-lineage.ts";
import { commitRevoke } from "./revoke-commit.ts";
import { ROOT_SET_RECLAIM_TABLES, runReclaimStep } from "./root-set-reclaim.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const msg = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
const owner = (id: string) => msg(id, { role: "user" });
function reset(): void { closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); }
const allowance = () => LineageAllowance.tool(Number.MAX_SAFE_INTEGER);

/** The root sets handed back, as the idle reclaim does it. */
function handBackRootSets(): void {
  const db = database();
  for (let steps = 0; steps < 100_000; steps++) {
    const { step } = runReclaimStep(db, { freeDiskBytes: () => null });
    if (step.kind === "done") break;
  }
  for (const table of ROOT_SET_RECLAIM_TABLES) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table), table).toBeUndefined();
}
/** "t": owner o1, reply r1 (a receipt, a copy source), owner o2, reply r2. "u": an unrelated thread with a reply. */
function history(): void {
  appendMessage("t", owner("o1"));
  appendMessage("t", msg("r1", { parentId: "o1" }));
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc','t','d','s','[]','[]','[\"r1\"]',(SELECT policy_revision FROM memory_meta WHERE id=1),(SELECT deletion_epoch FROM memory_meta WHERE id=1),0,'delivered',1)").run();
  appendMessage("t", { ...owner("o2"), parentId: "r1" });
  appendMessage("t", msg("r2", { parentId: "o2" }));
  appendMessage("u", owner("uo"));
  appendMessage("u", msg("ur", { parentId: "uo" }));
}

describe("the read-time lineage judge is retired on a file where lineage is written", () => {
  beforeEach(reset);

  it("a file with a line row is retired; an empty one is not, until the root sets are handed back", () => {
    expect(readTimeRetired(database())).toBe(false);
    appendMessage("t", owner("o1"));
    expect(readTimeRetired(database())).toBe(true);
    reset();
    expect(readTimeRetired(database())).toBe(false);
    handBackRootSets();
    expect(readTimeRetired(database())).toBe(true);
  });

  it("with the root-set tables gone, a forgotten line and the lines after it are withheld, an unrelated thread's reply is shown, and nothing throws", () => {
    history();
    handBackRootSets();
    commitRevoke(database(), { kind: "line", threadId: "t", messageIds: ["r1"], cause: "forget" });
    expect(drainRevokeMarker(database()).pending).toBe(false);
    const lines = (...ids: Array<[string, "user" | "bot"]>) => ids.map(([id, role]) => ({ id, role }));
    const asked = replayExclusions(allowance(), "t", lines(["o1", "user"], ["r1", "bot"], ["o2", "user"], ["r2", "bot"]), null, { failClosed: true });
    expect([...asked].sort()).toEqual(["r1", "r2"]);
    expect([...replayExclusions(allowance(), "u", lines(["uo", "user"], ["ur", "bot"]), null, { failClosed: true })]).toEqual([]);
    expect(capturedMessageVerdict(allowance(), "t", "r1")).toEqual({ withheld: true, unproven: false });
    expect(capturedMessageVerdict(allowance(), "u", "ur")).toEqual({ withheld: false, unproven: false });
  });

  it("the root-set readers answer 'nothing' and do not read the tables: roots, session roots, bad roots, session lineage, memory-made, memory lines", () => {
    history();
    handBackRootSets();
    const roots = outputRootsFor(allowance(), [{ threadId: "t", id: "r1", role: "bot" }], "t");
    expect(roots.roots.size).toBe(0);
    expect(sessionOutputRoots(allowance(), "t", "d", "s").roots.size).toBe(0);
    expect(outputRootsBad(allowance(), roots)).toBe(false);
    expect(sessionLineageBad(allowance(), "t", "d", "s", null)).toBe(false);
    // r1 was written by a turn that read memory (its row holds the receipt's lsn and footprint)
    database().prepare("UPDATE memory_line_lineage SET mem_lsn=1,footprint=0 WHERE message_id='r1'").run();
    expect(messageMadeWithMemory("t", "r1")).toBe(true);
    expect(messageMadeWithMemory("u", "ur")).toBe(false);
    expect(threadHoldsMemoryLines("t")).toBe(true);
    expect(threadHoldsMemoryLines("u")).toBe(false);
  });

  it("the temp triggers of a file with the root sets handed back install: no stamp falls back to 'every write moves it'", () => {
    history();
    handBackRootSets();
    closeMessageDb(); closeDatabase(); // a fresh connection: its triggers are made against the file as it is now
    expect(authorityEpochInstalled()).toBe(true);
    expect(provenanceTriggersInstalled(database())).toBe(true);
    expect(lineageTriggersInstalled()).toBe(true);
  });
});

describe("the continuation check of a resumed session asks the write-time session predicate first", () => {
  const SESSION = "session-0";
  beforeEach(() => {
    setTurnLineageNodesForTest(1_000_000_000);
    freshDataDir("active"); resetSessionHolds();
  });
  afterEach(() => { closeMemoryIndexReader(); resetSessionHolds(); setTurnLineageNodesForTest(null); });

  it("a denied session is revoked even when a hold or the authority stamp says nothing moved", () => {
    const { access } = accessFor();
    // a receipt that cites nothing, made under the current policy revision and deletion epoch
    database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('rc-s',?,'claude',?,'[]','[]','[]',?,?,0,'delivered',1)")
      .run(access.threadId, SESSION, access.policyRevision, access.deletionEpoch);
    // lineage is written on this file (a line row), and the session has its write-time row
    appendMessage(access.threadId, owner("o1"));
    database().prepare("INSERT INTO memory_session_lineage(thread_id,driver_instance,native_session,first_lsn,last_lsn) VALUES(?,?,?,1,1)").run(access.threadId, "claude", SESSION);
    const why: { reason?: string } = {};
    expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why), JSON.stringify(why)).toBe(false);
    // the first check passed: a hold now answers "nothing moved" for the next turn
    expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access)).toBe(false);
    commitRevoke(database(), { kind: "session", session: { threadId: access.threadId, driverInstance: "claude", nativeSession: SESSION }, cause: "session-revoked" });
    drainRevokeMarker(database());
    const after: { reason?: string } = {};
    expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, after)).toBe(true);
    expect(after.reason).toMatch(/^writetime-/);
  });
});
