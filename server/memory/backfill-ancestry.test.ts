// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Astra mem-review round 4, P1: the legacy backfill decided what a reply rests on by the ORDER of the thread's rows (rowid against time).
// A message stored again takes a new rowid and keeps its timestamp, so the order looked proven when it was not, and a paraphrase B of a
// receipt-backed reply A could end up with no dependency on A: archive A's record and A was withheld while B stayed readable. The backfill
// now decides by the message's own parentId chain only; where that is not provable a reply rests on every receipt output of the thread.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { forgetMemory } from "./forget.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { replayExclusions } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { backfillOutputRoots, repairOutputRootBackfill, rootSetMembers } from "./schema.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
function secretRecord() {
  const text = "The alarm code is 4812.";
  captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "message:older:m1", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access());
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
const put = (id: string, at: number, extra: Record<string, unknown> = {}, role = "bot") =>
  database().prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,?,'text','t',?)").run(id, at, role, JSON.stringify({ id, at, role, kind: "text", text: "t", ...extra }));
function receiptFor(record: string, output: string) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('F1','chat','engine','S',?,'[]','[]',(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1000)")
    .run(JSON.stringify([{ id: record, version: 1 }]));
  database().prepare("UPDATE memory_disclosures SET output_message_ids=? WHERE bundle_id='F1'").run(JSON.stringify([output]));
}
const legacyBackfill = () => { database().exec("DELETE FROM memory_output_roots"); backfillOutputRoots(database()); };
const roots = () => Object.fromEntries(database().prepare("SELECT message_id,set_id FROM memory_output_roots WHERE thread_id='chat'").all().map(r => [String(r.message_id), String(r.set_id)]));
const withheld = (ids: string[]) => new Set(replayExclusions(LineageAllowance.tool(1_000_000_000), "chat", ids.map(id => ({ id, role: "bot" })), null, { failClosed: true }));

it("P1 repro: A@1000 receipt-backed, B@500, A replaced keeping its time (row order B, A looks time-ordered): B is withheld with A", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 1000); put("B", 500);
  put("A", 1000); // stored again: new rowid, same time
  const order = database().prepare("SELECT id FROM messages WHERE thread_id='chat' ORDER BY rowid").all().map(r => String(r.id));
  expect(order).toEqual(["B", "A"]);
  legacyBackfill();
  expect(roots().B, "B rests on A").toBeTruthy();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});

it("P1: equal timestamps decide nothing either", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 1000); put("B", 1000); put("A", 1000);
  legacyBackfill();
  expect(roots().B).toBeTruthy();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});

it("P1: a reply whose parentId is the receipt reply rests on it, by the chain, whatever the times and rows say", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("U", 10, { parentId: null }, "user");
  put("A", 1000, { parentId: "U" });
  put("B", 500, { parentId: "A" });
  put("A", 1000, { parentId: "U" });
  legacyBackfill();
  expect(roots().B).toBeTruthy();
  expect(roots().A, "A has nothing above it").toBeUndefined();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});

it("a reply on another branch, with a provable chain that does not pass through the receipt reply, does not rest on it", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("U", 10, { parentId: null }, "user");
  put("A", 1000, { parentId: "U" });
  put("C", 2000, { parentId: "U" }); // a sibling answer to the same message
  legacyBackfill();
  expect(roots().C).toBeUndefined();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "C"])).toEqual(new Set(["A"]));
});

it("a chain that names a missing message, or loops, is unprovable: the reply rests on every output of the thread", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 1000); put("M", 1, { parentId: "gone" }); put("L1", 2, { parentId: "L2" }); put("L2", 3, { parentId: "L1" });
  legacyBackfill();
  for (const id of ["M", "L1", "L2"]) expect(roots()[id], id).toBeTruthy();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "M", "L1", "L2"])).toEqual(new Set(["A", "M", "L1", "L2"]));
});

it("repair: roots an earlier build backfilled by row order are widened once, never narrowed, and the marker stops a second pass", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("A", 1000); put("B", 500); put("A", 1000);
  database().exec("DELETE FROM memory_output_roots"); // what the earlier build wrote for this thread: B got nothing
  const done = repairOutputRootBackfill(database());
  expect(done.threads).toBe(1);
  expect(roots().B).toBeTruthy();
  expect(database().prepare("SELECT 1 FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'").get()).toBeTruthy();
  // a row that already held more keeps it
  const held = roots().B!;
  database().exec("DELETE FROM memory_scope_bindings WHERE id='memory-lineage-backfill-v3'");
  repairOutputRootBackfill(database());
  expect([...rootSetMembers(database(), roots().B!)!]).toEqual([...rootSetMembers(database(), held)!]);
  // the marker is there: a changed thread is not looked at again
  database().exec("DELETE FROM memory_output_roots");
  expect(repairOutputRootBackfill(database()).threads).toBe(0);
  expect(roots().B).toBeUndefined();
});

it("repair widens a row that rests on fewer outputs than its chain proves", () => {
  const record = secretRecord();
  receiptFor(record, "A");
  put("U", 10, { parentId: null }, "user"); put("A", 1000, { parentId: "U" }); put("B", 500, { parentId: "A" });
  // an earlier build left B resting on a set that does not hold A
  database().exec("INSERT OR IGNORE INTO memory_root_sets(set_id,size) VALUES('stale',0)");
  database().exec("DELETE FROM memory_output_roots");
  database().prepare("INSERT INTO memory_output_roots VALUES('chat','B','stale')").run();
  repairOutputRootBackfill(database());
  expect(roots().B).not.toBe("stale");
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(withheld(["A", "B"])).toEqual(new Set(["A", "B"]));
});
