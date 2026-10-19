// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra mem-review round 5. P1 ancestry (a row naming no parent is never a proven root, any role), P1 repair failure (replay of outputs is
// withheld, fail closed, until a repair succeeds), P1 holds and stamps bound to the connection, P2 terminal capture costs the turn, not the history.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it, afterEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
// 1.0.2: this file drives the read-time root-set machinery over rows a 1.0.1 file holds; thaw the frozen root-set writes to model them.
beforeEach(() => thawRootSetWritesForTest(true));
afterEach(() => thawRootSetWritesForTest(false));
import { DATA_DIR } from "../config.ts";
import { ancestryUnrepaired, closeDatabase, database, finishBackgroundUpgradeWorkNow, retryAncestryRepair, setRepairRetryBaseMs, setRepairRunnerForTest } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import type { Message } from "../store.ts";
import { authorityParts, authorityStamp } from "./authority-epoch.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource, TURN_WALK_MAX, wholeTurnText } from "./capture.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { legacyFile } from "./testing/legacy-file-model.ts";
import { outputRootsFor, recordSessionRoots, replayExclusions } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { backfillOutputRoots } from "./schema.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => {
  setRepairRunnerForTest(null); setRepairRetryBaseMs(1_000_000_000);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("active"); reconcileMemoryRoster(roster); resetSessionHolds();
});

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
let counter = 0;
function secretRecord() {
  const text = `The alarm code is ${4800 + counter++}.`, sourceId = `message:older:m${counter}`;
  storeAnchorMessage(database(), "older", `m${counter}`, text); captureSource(database(), { id: sourceId, threadId: "older", messageId: `m${counter}`, kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k${counter}`, access());
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
const put = (id: string, at: number, extra: Record<string, unknown> = {}, role = "bot") =>
  database().prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,?,'text','t',?)").run(id, at, role, JSON.stringify({ id, at, role, kind: "text", text: "t", ...extra }));
function receiptFor(record: string, output: string) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('F1','chat','engine','S',?,'[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),1,'delivered',?)")
    .run(JSON.stringify([{ id: record, version: 1 }]), JSON.stringify([output]), Date.now());
  database().prepare("INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES('F1','chat',?)").run(output);
}
const legacyBackfill = () => { database().exec("DELETE FROM memory_output_roots"); backfillOutputRoots(database()); };
const withheld = (ids: string[]) => new Set(replayExclusions(LineageAllowance.tool(1_000_000_000), "chat", ids.map(id => ({ id, role: "bot" })), null, { failClosed: true }));

it("P1 ancestry: A (receipt) -> legacy user U with no parentId -> B naming U: archiving A's record withholds B too", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 10, { parentId: null });
  put("U", 20, {}, "user"); // legacy: no parentId; the loader chains it to its predecessor, which is not provable here
  put("B", 30, { parentId: "U" });
  legacyBackfill();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});

it("P1 ancestry: a bot ancestor with no parentId is no more a root than a user one", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 10, { parentId: null });
  put("X", 20, {}); // a legacy bot row, no parentId
  put("B", 30, { parentId: "X" });
  legacyBackfill();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});

it("P1 ancestry: an explicit null parent is still a proven root", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("U", 10, { parentId: null }, "user");
  put("A", 20, { parentId: "U" });
  put("C", 30, { parentId: "U" });
  legacyBackfill();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "C"])).toEqual(new Set(["A"]));
});

it("P1 repair marker: a file marked by the earlier repair (v2) is revisited", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 10, { parentId: null }); put("U", 20, {}, "user"); put("B", 30, { parentId: "U" });
  database().exec("DELETE FROM memory_output_roots");
  const scope = database().prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id;
  database().prepare("INSERT OR IGNORE INTO memory_scope_bindings VALUES('memory-lineage-backfill-v2',?,'system','lineage-backfill',0,'granted','{}')").run(scope);
  legacyFile(database()); finishBackgroundUpgradeWorkNow(); // v10 never repairs; a 1.0.1-shaped file's repair runs in the background after listen
  const row = database().prepare("SELECT set_id FROM memory_output_roots WHERE thread_id='chat' AND message_id='B'").get();
  expect(row, "B revisited by the new repair").toBeTruthy();
});

it("P1 repair failure: replay of outputs from an unrepaired thread is withheld until a later repair succeeds", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("U", 10, { parentId: null }, "user"); put("A", 20, { parentId: "U" }); put("C", 30, { parentId: "U" });
  database().exec("DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-lineage-backfill-%'");
  setRepairRunnerForTest(() => { throw new Error("database is locked"); });
  legacyFile(database()); retryAncestryRepair(); // v10 never starts a repair at open; the failed repair on a 1.0.1-shaped file is what leaves the thread unrepaired
  expect(ancestryUnrepaired(database())).toBe(true);
  // C rests on nothing, yet nothing in this thread is trusted while its ancestry is unrepaired
  expect(withheld(["A", "C"])).toEqual(new Set(["A", "C"]));
  const stamp = authorityStamp();
  setRepairRunnerForTest(null);
  retryAncestryRepair();
  expect(ancestryUnrepaired(database())).toBe(false);
  expect(authorityStamp(), "the state change moves the stamp").not.toBe(stamp);
  expect(withheld(["A", "C"])).toEqual(new Set());
});

it("P1 connection identity: a replacement connection never matches the stamps of the one it replaced, and closing forgets the holds", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 10, { parentId: null });
  recordSessionRoots("chat", "engine", "S", outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(database(), "chat", "engine", "S"); // stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  const check = () => continuationMemoryRevoked(LineageAllowance.tool(), "chat", "engine", "S", access());
  expect(check()).toBe(false);
  const before = authorityStamp(), parts = authorityParts();
  closeDatabase(); database();
  expect(authorityStamp()).not.toBe(before);
  expect(authorityParts()!.stamp).not.toBe(parts!.stamp);
  expect(authorityParts()!.hard).not.toBe(parts!.hard);
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='F1'").run();
  expect(check(), "a hold taken on the closed connection is not reused").toBe(true);
});

// --- P2: capture costs the turn ---
/** `seedFirst`: production records a turn's first row when it is appended (message-db.ts trackTurnFirst); false is a turn written before that table existed. */
function history(rows: number, turnLength: number, seedFirst = true) {
  const db = database();
  db.exec("DELETE FROM messages WHERE thread_id='chat'; DELETE FROM turn_first WHERE thread_id='chat'");
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'chat','m'||i,i,CASE WHEN i%2=0 THEN 'user' ELSE 'bot' END,'text','old',
    json_object('id','m'||i,'at',i,'role',CASE WHEN i%2=0 THEN 'user' ELSE 'bot' END,'kind','text','text','old','turnId',CASE WHEN i%2=0 THEN NULL ELSE 'T'||i END,'parentId',CASE WHEN i=0 THEN NULL ELSE 'm'||(i-1) END,'from',json_object('botId','bot')) FROM n`).run(rows - 1);
  // the turn: an owner message, then turnLength bot pieces (same turnId)
  let parent = `m${rows - 1}`;
  put("o", rows, { parentId: parent }, "user"); parent = "o";
  let last: Message | undefined;
  for (let i = 0; i < turnLength; i++) {
    const m = { id: `p${i}`, at: rows + 1 + i, role: "bot", kind: "text", text: `piece${i}`, turnId: "TT", parentId: parent, from: { botId: "bot" }, turnTerminal: i === turnLength - 1 } as unknown as Message;
    put(m.id, m.at, m as unknown as Record<string, unknown>); parent = m.id; last = m;
  }
  db.prepare("INSERT OR REPLACE INTO thread_state(thread_id,active_leaf_id) VALUES('chat',?)").run(parent);
  if (seedFirst) db.prepare("INSERT OR REPLACE INTO turn_first(thread_id,turn_id,first_rowid) SELECT 'chat','TT',rowid FROM messages WHERE thread_id='chat' AND id='p0'").run();
  return last!;
}
function rowsRead<T>(run: () => T): { result: T; rows: number } {
  const db = database(), real = db.prepare.bind(db);
  let rows = 0;
  (db as unknown as { prepare: unknown }).prepare = (text: string) => {
    const stmt = real(text) as unknown as { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
    const get = stmt.get.bind(stmt), all = stmt.all.bind(stmt);
    stmt.get = (...a) => { const r = get(...a); if (r) rows++; return r; };
    stmt.all = (...a) => { const r = all(...a); rows += r.length; return r; };
    return stmt;
  };
  try { return { result: run(), rows }; } finally { (db as unknown as { prepare: unknown }).prepare = real; }
}
for (const size of [1_000, 10_000, 50_000]) {
  it(`P2 capture: a turn of 3 pieces reads rows proportional to the turn, not to ${size} rows of history`, () => {
    const last = history(size, 3);
    const { result, rows } = rowsRead(() => wholeTurnText(database(), "chat", last));
    expect(result).toBe("piece0\n\npiece1\n\npiece2");
    // One indexed read of turn_first plus the turn's own rows: a constant, whatever the history.
    expect(rows).toBeLessThanOrEqual(8);
  });
}
it("P2 capture: a turn that began before turn_first existed pays one bounded lookup, never the history", () => {
  const turnLength = 3;
  const last = history(50_000, turnLength, false);
  const { result, rows } = rowsRead(() => wholeTurnText(database(), "chat", last));
  expect(result).toBe("piece0\n\npiece1\n\npiece2");
  expect(rows).toBeLessThanOrEqual(turnLength + 72);
});
it("P2 capture: a turn longer than the walk cap falls back to the whole branch and still joins every piece", () => {
  const length = TURN_WALK_MAX + 20;
  const last = history(50, length);
  const text = wholeTurnText(database(), "chat", last);
  expect(text.split("\n\n")).toHaveLength(length);
  expect(text.startsWith("piece0\n\npiece1")).toBe(true);
});
