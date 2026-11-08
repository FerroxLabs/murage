// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// TURNCACHE-FAILOPEN (1.0.18): a reply verdict the read-time judge keeps must not outlive a write that changes the answer a fresh
// judge gives. Each case: warm, write, then the kept answer must equal the answer a fresh connection (no kept verdicts) gives.
// Cases from Astra's TURNSTART r12 review (c): the branch-change fence, a scope move into a denied scope, the positional inputs
// (a supporting-source tombstone, turn_first, a line's parent, a line stored after it was judged), and a bring-in's version payload.
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { saveMemoryCandidate } from "./authority.ts";
import { captureSource } from "./capture.ts";
import { supportingTombstones } from "./memory-revocation.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { capturedMessageVerdict, capturedMessageWithheld, foreignLineageWrite, forgetIndexMissing, forgetListThreads, outputRootsBad, outputRootsShallow, recordOutputRoots, replayExclusions, thawRootSetWritesForTest, INVALIDATION_SET, keptVerdictCount, lineageTriggersInstalled, positionalPaidForTest, positionalWithheld, prepareLineageCache, threadForgetsWorkForTest, warmReplies } from "./replay-lineage.ts";
import { DatabaseSync } from "node:sqlite";
import { withStatementReuse } from "../io-budget.ts";
import { buildOptionalIndexOffThread, optionalIndexReady } from "./optional-index.ts";
import { TOMBSTONE_FORGETS, TOMBSTONE_FORGETS_INDEX } from "./schema.ts";
import { join } from "node:path";
import { setMemoryMode } from "./repository.ts";
import { LineageAllowance, ROWS_PER_NODE } from "./lineage-allowance.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat", tasks: [{ threadId: "older" }] }], groups: [] };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });

const withheld = (thread: string, message: string) => capturedMessageWithheld(LineageAllowance.tool(1_000_000_000), thread, message);
const warm = (thread: string, messages: string[]) => warmReplies(thread, messages, 1_000_000_000);
/** The answer with no kept verdict: a new connection shares nothing with the last (replay-lineage.ts currentVerdictCache). */
const fresh = (thread: string, message: string, before?: () => void) => { closeDatabase(); before?.(); return withheld(thread, message); };
function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
function capture(thread: string, id: string, text: string, role: "user" | "bot", at: number, json: Record<string, unknown> = {}) {
  database().prepare("INSERT OR IGNORE INTO messages(thread_id, id, at, role, kind, text, json) VALUES(?,?,?,?,'text',?,?)")
    .run(thread, id, at, role, text, JSON.stringify({ id, role, kind: "text", text, at, ...json }));
  captureSource(database(), { id: `message:${thread}:${id}`, threadId: thread, messageId: id, kind: "text", speaker: role === "user" ? "owner" : "bot", outcome: "recorded", text });
}
function record(sourceId: string, text: string) {
  const id = saveMemoryCandidate(text, [{ sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k", access());
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(id);
  return id;
}
const receipt = (bundle: string, thread: string, records: Array<{ id: string; version: number }>, sources: Array<{ id: string; revision: number }>, output: string[]) =>
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'engine','S',?,?,?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',1)")
    .run(bundle, thread, JSON.stringify(records), JSON.stringify(sources), JSON.stringify(output));
function deniedScope(): string {
  database().prepare("INSERT OR IGNORE INTO memory_scopes VALUES('scope:gone','bot','scope:gone','[]',0)").run();
  database().prepare("INSERT OR IGNORE INTO memory_deny VALUES('scope','scope:gone',1,1)").run();
  return "scope:gone";
}
const ownerLine = () => { const text = "The alarm code is 4812."; storeAnchorMessage(database(), "older", "m1", text, "user", 1); captureSource(database(), { id: "message:older:m1", threadId: "older", messageId: "m1", kind: "text", speaker: "owner", outcome: "recorded", text }); };

it("the cache triggers install on a real data file (a failed install only drops the whole cache on every write: fail closed, but slow)", () => {
  expect(lineageTriggersInstalled()).toBe(true);
});

it("case 1: a branch change still being flipped withholds a reply resting on its thread's lines at once, kept verdict or not", () => {
  ownerLine();
  receipt("F1", "chat", [], [{ id: "message:older:m1", revision: 1 }], ["r1"]);
  expect(withheld("chat", "r1")).toBe(false);
  // branch-change.ts store(): the fence a pending move leaves, before every source of the thread is flipped
  database().prepare("INSERT OR REPLACE INTO branch_change(thread_id, from_id, to_id, leave_at, join_at, leave_done, join_done, all_cursor) VALUES ('older', NULL, 'm1', NULL, NULL, 0, 0, NULL)").run();
  const kept = withheld("chat", "r1");
  // and the fence ending (the slice deletes it) lets the reply be shown again
  database().prepare("DELETE FROM branch_change WHERE thread_id='older'").run();
  const after = withheld("chat", "r1");
  database().prepare("INSERT OR REPLACE INTO branch_change(thread_id, from_id, to_id, leave_at, join_at, leave_done, join_done, all_cursor) VALUES ('older', NULL, 'm1', NULL, NULL, 0, 0, NULL)").run();
  expect({ kept, after, fresh: fresh("chat", "r1") }).toEqual({ kept: true, after: false, fresh: true });
});

it("case 2: a record moved into a denied scope withholds the reply that used it", () => {
  ownerLine();
  const scope = deniedScope();
  const rec = record("message:older:m1", "The alarm code is 4812.");
  receipt("F1", "chat", [{ id: rec, version: 1 }], [], ["r1"]);
  expect(withheld("chat", "r1")).toBe(false);
  database().prepare("UPDATE memory_records SET scope_id=? WHERE id=?").run(scope, rec);
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: true, fresh: true });
});

it("case 2: a source moved into a denied scope withholds the reply that used it", () => {
  ownerLine();
  const scope = deniedScope();
  receipt("F1", "chat", [], [{ id: "message:older:m1", revision: 1 }], ["r1"]);
  expect(withheld("chat", "r1")).toBe(false);
  database().prepare("UPDATE memory_sources SET scope_id=? WHERE id='message:older:m1'").run(scope);
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: true, fresh: true });
});

/** Thread chat: owner line L, generated r1 after it. Thread older: a reply r2 whose receipt cites r1's captured source, so r2's
 * verdict rests on the kept verdict of r1 (replay-lineage.ts sourcesBad -> keptVerdict). */
function positionalFixture(r1: { at: number; json?: Record<string, unknown> } | null) {
  capture("chat", "L", "The alarm code is 4812.", "user", 1000);
  if (r1) capture("chat", "r1", "Noted: 4812.", "bot", r1.at, r1.json);
  else captureSource(database(), { id: "message:chat:r1", threadId: "chat", messageId: "r1", kind: "text", speaker: "bot", outcome: "recorded", text: "Noted: 4812." });
  receipt("F2", "older", [], [{ id: "message:chat:r1", revision: 1 }], ["r2"]);
}
const ownerForget = (at: number) => database().prepare("INSERT INTO memory_tombstones VALUES(?,'source','message:chat:L',NULL,NULL,(SELECT deletion_epoch FROM memory_meta),'owner-forget',?)").run(randomUUID(), at);

it("case 3 (forget): the forget job's supporting-source tombstone withholds a later reply resting on a line after the forgotten one", () => {
  positionalFixture({ at: 2000 });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  // the supporting phase of a record forget (memory-revocation.ts, sources past forget.ts FORGET_INLINE_ROWS): no memory_meta change
  // (green on 1.0.17 too: the phase's 'forgotten-original' import tombstone, same commit, drops the whole cache; this pins that)
  supportingTombstones(database(), null, [{ id: "message:chat:L", revision: 1 }], false);
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("case 3 (turn_first): the turn's first row being indexed after the reply was judged moves the turn's start", () => {
  ownerForget(5000);
  capture("chat", "u", "go on", "user", 6000, { turnId: "T", parentId: "L" });
  capture("chat", "p", "step", "bot", 6500, { turnId: "T" });
  positionalFixture({ at: 7000, json: { turnId: "T", parentId: "p" } });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  // branch-fill.ts: the turn index is filled in slices
  database().prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('chat','T',(SELECT rowid FROM messages WHERE thread_id='chat' AND id='u'))").run();
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("case 3 (parent): a line patched to a parent from before the forget is judged on that parent", () => {
  ownerForget(5000);
  capture("chat", "p", "step", "bot", 6500);
  positionalFixture({ at: 7000, json: { parentId: "p" } });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  database().prepare("UPDATE messages SET json=json_set(json,'$.parentId','L') WHERE thread_id='chat' AND id='r1'").run();
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("case 6 (E4): a line judged before its row was stored is judged again when the row arrives", () => {
  ownerForget(5000);
  positionalFixture(null);
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  storeAnchorMessage(database(), "chat", "r1", "Noted: 4812.", "bot", 2000);
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

/** A bring-in source in chat whose current version names its origins (deny.ts DENIED_SOURCE). */
function bringIn(origins: Array<{ id: string; revision: number }>) {
  ownerLine();
  const scope = String(database().prepare("SELECT scope_id FROM memory_sources WHERE id='message:older:m1'").get()!.scope_id);
  database().prepare("INSERT INTO memory_sources VALUES('bring:1',?,'chat',NULL,NULL,1,'h','bring-in','owner','recorded',NULL,'active')").run(scope);
  database().prepare("INSERT INTO memory_source_versions VALUES('bring:1',1,'h',?,1)").run(JSON.stringify({ text: "x", broughtFrom: { sources: origins } }));
  receipt("F1", "chat", [], [{ id: "bring:1", revision: 1 }], ["r1"]);
}
const setOrigins = (origins: Array<{ id: string; revision: number }>) =>
  database().prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='bring:1' AND revision=1").run(JSON.stringify({ text: "x", broughtFrom: { sources: origins } }));

it("case 4: a version payload rewritten to name a gone origin withholds the reply (shown -> withheld)", () => {
  bringIn([{ id: "message:older:m1", revision: 1 }]);
  expect(withheld("chat", "r1")).toBe(false);
  setOrigins([{ id: "message:older:gone", revision: 1 }]);
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: true, fresh: true });
});

it("case 4: a version payload rewritten to drop a gone origin is judged again (withheld -> shown)", () => {
  bringIn([{ id: "message:older:gone", revision: 1 }]);
  expect(withheld("chat", "r1")).toBe(true);
  setOrigins([{ id: "message:older:m1", revision: 1 }]);
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: false, fresh: false });
});

// ---- the forget-list key is exact: a forget reaches the threads whose list holds it, and no other -------------------------------------

const forgetLine = (target: string, at: number) => database().prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,(SELECT deletion_epoch FROM memory_meta),'owner-forget',?)").run(randomUUID(), target, at);

it("case 7: an owner forget of a line with no source row (only its message row) withholds a kept reply after it, by key", () => {
  // a line the owner forgot whose source row was never captured: nothing names its thread but the tombstone's id
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',1500,'user','text','The gate code is 7731.','{}')").run();
  positionalFixture({ at: 2000 });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  forgetLine("message:chat:L2", 5000);
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("case 7: a forget in another thread, or in a thread whose id only begins the same way, keeps the warm verdicts", () => {
  positionalFixture({ at: 2000 });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  const count = () => { prepareLineageCache(); return keptVerdictCount(); };
  const before = count();
  expect(before).toBeGreaterThan(0);
  forgetLine("message:elsewhere:m9", 5000);
  forgetLine("message:cha:t:m9", 5000); // thread "cha" (line "t:m9") or "cha:t": never "chat"
  forgetLine("message:chatter:m9", 5000);
  expect(count(), "unrelated forgets").toBe(before);
  expect(withheld("older", "r2")).toBe(false);
});

it("forgetListThreads names every thread whose forget-list range holds the id, and nothing for a non-message source", () => {
  expect(forgetListThreads("message:chat:L")).toEqual(["chat"]);
  expect(forgetListThreads("message:a:b:c")).toEqual(["a", "a:b"]);
  expect(forgetListThreads("message::x")).toEqual([""]);
  expect(forgetListThreads("bring:1")).toEqual([]);
  expect(forgetListThreads("message:nocolon")).toEqual([]);
});

it("INVALIDATION_SET lists every installed lineage trigger, and names this lane's keys", () => {
  expect(lineageTriggersInstalled()).toBe(true);
  const installed = database().prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'lineage\\_%' ESCAPE '\\' ORDER BY name").all().map(row => String(row.name));
  expect([...new Set(INVALIDATION_SET.map(row => row.trigger))].sort()).toEqual(installed);
  const has = (table: string, op: string, kind: string, trigger?: string) =>
    INVALIDATION_SET.some(row => row.table === table && row.op === op && row.kind === kind && (!trigger || row.trigger === trigger));
  expect(has("memory_root_set_members", "UPDATE", "x", "lineage_root_sets_u")).toBe(true);
  expect(has("memory_root_set_members", "UPDATE", "structure", "lineage_root_sets_u")).toBe(true);
  expect(has("memory_root_set_members", "INSERT", "x")).toBe(true);
  expect(has("memory_root_set_parents", "INSERT", "x")).toBe(true);
  for (const op of ["INSERT", "UPDATE", "DELETE"]) expect(has("memory_tombstones", op, "P"), op).toBe(true);
  for (const op of ["INSERT", "UPDATE", "DELETE"]) expect(has("branch_change", op, "b"), op).toBe(true);
  for (const op of ["INSERT", "UPDATE", "DELETE"]) expect(has("turn_first", op, "f"), op).toBe(true);
  for (const op of ["INSERT", "UPDATE", "DELETE"]) expect(has("memory_source_versions", op, "s"), op).toBe(true);
  expect(has("messages", "INSERT", "m", "lineage_messages_i")).toBe(true);
  // complete tuples (Astra TCFO r1 Low)
  const row = (trigger: string, kind: string) => INVALIDATION_SET.find(r => r.trigger === trigger && r.kind === kind);
  expect(row("lineage_tombstones_u", "P")).toEqual({ trigger: "lineage_tombstones_u", timing: "AFTER", op: "UPDATE", table: "memory_tombstones", kind: "P", rows: "OLD+NEW", when: null });
  expect(row("lineage_tombstones_d", "P")).toEqual({ trigger: "lineage_tombstones_d", timing: "AFTER", op: "DELETE", table: "memory_tombstones", kind: "P", rows: "OLD", when: null });
  expect(row("lineage_messages_i", "m")).toMatchObject({ timing: "BEFORE", op: "INSERT", rows: "NEW", when: "NOT EXISTS (SELECT 1 FROM main.messages o WHERE o.thread_id=NEW.thread_id AND o.id=NEW.id)" });
  expect(INVALIDATION_SET.some(r => r.kind === "forgets"), "no forget-list counter (r3)").toBe(false);
  expect(row("lineage_branch_change_u", "b")).toMatchObject({ rows: "OLD+NEW", when: "OLD.thread_id IS NOT NEW.thread_id" });
  expect(row("lineage_root_parents_i", "structure")).toMatchObject({ op: "INSERT", table: "memory_root_set_parents", rows: "NEW" });
  // the roots UPDATE OLD note belongs to TURNSTART r14 (until it lands, lineage_roots_u reads NEW only)
  expect(INVALIDATION_SET.find(row => row.trigger === "lineage_roots_u")?.rows).toMatch(/NEW/);
  expect(Object.isFrozen(INVALIDATION_SET)).toBe(true);
});

// ---- Astra TCFO r1: the forget-list cache, the turn's first row, a bring-in's origins, a set grown after it was stored ---------------------

it("H1: a forgotten line whose row arrives after the reply was judged moves the forget list (no stale kept list)", () => {
  forgetLine("message:chat:L2", 5000);
  positionalFixture({ at: 2000 });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',1500,'user','text','The gate code is 7731.','{}')").run();
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("H1: a forgotten line moved to before the reply moves the forget list", () => {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',2500,'user','text','The gate code is 7731.','{}')").run();
  forgetLine("message:chat:L2", 5000);
  positionalFixture({ at: 2000 });
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  database().prepare("UPDATE messages SET at=1500 WHERE thread_id='chat' AND id='L2'").run();
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("H2: the turn's first row patched to a parent from before the forget is judged on that parent", () => {
  ownerForget(5000);
  capture("chat", "p2", "earlier step", "bot", 6400);
  capture("chat", "u", "go on", "user", 6600, { turnId: "T", parentId: "p2" });
  capture("chat", "p", "step", "bot", 6700, { turnId: "T" });
  positionalFixture({ at: 7000, json: { turnId: "T", parentId: "p" } });
  database().prepare("INSERT INTO turn_first(thread_id, turn_id, first_rowid) VALUES ('chat','T',(SELECT rowid FROM messages WHERE thread_id='chat' AND id='u'))").run();
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  database().prepare("UPDATE messages SET json=json_set(json,'$.parentId','L') WHERE thread_id='chat' AND id='u'").run();
  warm("chat", ["r1"]);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2", () => warm("chat", ["r1"])) }).toEqual({ kept: true, fresh: true });
});

it("H4: a bring-in's origin moved into a denied scope withholds the reply that cites only the bring-in", () => {
  const scope = deniedScope(); // the deny row first: its own write drops the whole cache
  bringIn([{ id: "message:older:m1", revision: 1 }]);
  expect(withheld("chat", "r1")).toBe(false);
  database().prepare("UPDATE memory_sources SET scope_id=? WHERE id='message:older:m1'").run(scope);
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: true, fresh: true });
});

it("H4: a bring-in's origin tombstoned at the cited revision withholds the reply that cites only the bring-in", () => {
  bringIn([{ id: "message:older:m1", revision: 1 }]);
  expect(withheld("chat", "r1")).toBe(false);
  database().prepare("INSERT INTO memory_tombstones VALUES(?,'source','message:older:m1',1,NULL,(SELECT deletion_epoch FROM memory_meta),'test',1)").run(randomUUID());
  const kept = withheld("chat", "r1");
  expect({ kept, fresh: fresh("chat", "r1") }).toEqual({ kept: true, fresh: true });
});

it("H3: a member or parent link added to a stored set moves the handle counter; one added to a set still being written does not", () => {
  expect(lineageTriggersInstalled()).toBe(true);
  const db = database(), n = () => Number(db.prepare("SELECT n FROM temp.lineage_structure").get()!.n);
  const start = n();
  db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES('rs-new','chat','a')").run();
  db.prepare("INSERT INTO memory_root_set_parents(set_id,parent_id) VALUES('rs-new','rs-base')").run();
  expect(n(), "a set with no row yet").toBe(start);
  db.prepare("INSERT INTO memory_root_sets(set_id,size) VALUES('rs-new',1)").run();
  db.prepare("INSERT INTO memory_root_set_members(set_id,root_thread_id,root_message_id) VALUES('rs-new','chat','b')").run();
  expect(n(), "a member added to a stored set").toBe(start + 1);
  db.prepare("INSERT OR REPLACE INTO memory_root_set_parents(set_id,parent_id) VALUES('rs-new','rs-other')").run();
  expect(n(), "a parent link replaced on a stored set").toBe(start + 2);
});

it("M1: a version row of a past revision, written or rewritten, keeps the warm verdicts", () => {
  bringIn([{ id: "message:older:m1", revision: 1 }]);
  expect(withheld("chat", "r1")).toBe(false);
  const count = () => { prepareLineageCache(); return keptVerdictCount(); };
  const before = count();
  expect(before).toBeGreaterThan(0);
  database().prepare("INSERT INTO memory_source_versions VALUES('bring:1',0,'h0',?,0)").run(JSON.stringify({ text: "old" }));
  database().prepare("UPDATE memory_source_versions SET payload=? WHERE source_id='bring:1' AND revision=0").run(JSON.stringify({ text: "older" }));
  expect(count(), "a past revision's version row").toBe(before);
  expect(withheld("chat", "r1")).toBe(false);
});

// ---- Astra TCFO r2: every tombstone write, another connection's, and a rolled-back read reach the kept forget list --------------------------

/** L2 forgotten at 5000 under `reason`; r1 at 2000 after it was written at 1500: withheld while the reason is an owner's forget. */
function forgottenL2(reason: string, created = 5000) {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',1500,'user','text','The gate code is 7731.','{}')").run();
  database().prepare("INSERT INTO memory_tombstones VALUES('t-L2','source','message:chat:L2',NULL,NULL,(SELECT deletion_epoch FROM memory_meta),?,?)").run(reason, created);
  positionalFixture({ at: 2000 });
}
const settle = (thread: string, message: string, write: () => void, expected: boolean) => {
  warm("chat", ["r1"]);
  write();
  warm("chat", ["r1"]);
  const kept = withheld(thread, message);
  expect({ kept, fresh: fresh(thread, message, () => warm("chat", ["r1"])) }).toEqual({ kept: expected, fresh: expected });
};

it("r2 H1: a tombstone's reason updated to an owner forget (no new rowid) withholds; its delete shows again", () => {
  forgottenL2("test");
  // r1 warm first, as in every case above: a reply judged while r1 is cold does not time r1 (see the TCFO ledger note)
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  settle("older", "r2", () => database().prepare("UPDATE memory_tombstones SET reason='owner-forget' WHERE id='t-L2'").run(), true);
  settle("older", "r2", () => database().prepare("DELETE FROM memory_tombstones WHERE id='t-L2'").run(), false);
});

it("r2 H1: a tombstone's time moved from after the reply to before it, by another connection through foreignLineageWrite", () => {
  forgottenL2("owner-forget", 1000); // forgotten before the reply's line was written: not withheld
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  const other = new DatabaseSync(join(DATA_DIR, "messages.db"));
  try {
    settle("older", "r2", () => foreignLineageWrite(other, () => other.exec("UPDATE memory_tombstones SET created_at=5000 WHERE id='t-L2'")), true);
  } finally { other.close(); }
});

it("r2 H2: a forget list read inside a rolled-back transaction is not kept for the committed data", () => {
  forgottenL2("test");
  warm("chat", ["r1"]);
  expect(withheld("older", "r2")).toBe(false);
  const db = database();
  db.exec("BEGIN");
  db.prepare("UPDATE memory_tombstones SET reason='other' WHERE id='t-L2'").run();
  expect(withheld("older", "r2")).toBe(false);
  db.exec("ROLLBACK");
  settle("older", "r2", () => db.prepare("UPDATE memory_tombstones SET reason='owner-forget' WHERE id='t-L2'").run(), true);
});

// ---- r3 (the simplification): the forget list is read afresh on every pass, at a cost that follows the forgets, never the history ---------

const seeks = () => threadForgetsWorkForTest().seeks;
it("r3: the list is re-read on every call outside a pass, and on every call inside a transaction; it is kept only within one pass with no write", () => {
  forgottenL2("owner-forget");
  const ask = () => positionalWithheld("chat", ["r1"]);
  let before = seeks(); ask(); ask();
  expect(seeks() - before, "two calls, no pass: two reads (no reuse across calls)").toBe(2);
  before = seeks();
  withStatementReuse(() => { ask(); ask(); });
  expect(seeks() - before, "one pass, no write: one read").toBe(1);
  before = seeks();
  withStatementReuse(() => { ask(); ask(); });
  expect(seeks() - before, "a second pass reads again (a list from an earlier pass is never read)").toBe(1);
  before = seeks();
  withStatementReuse(() => { ask(); database().prepare("UPDATE memory_tombstones SET created_at=created_at WHERE id='t-L2'").run(); ask(); });
  expect(seeks() - before, "a write in the pass: read again").toBe(2);
  const db = database();
  db.exec("BEGIN");
  try {
    before = seeks();
    withStatementReuse(() => { ask(); ask(); });
    expect(seeks() - before, "inside a transaction: never kept").toBe(2);
  } finally { db.exec("ROLLBACK"); }
});

it("r3: one read of a thread's forget list costs the same with 1,000 or 100,000 lines of history (<= 257 tombstone rows + one key read per listed line)", () => {
  const db = database();
  const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'bot','text','x','{}')");
  const forget = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,'owner-forget',9000000)");
  positionalFixture({ at: 2000 });
  // 300 forgotten lines of other threads and 40 of this one: the seek reads this thread's range only
  db.exec("BEGIN");
  for (let index = 0; index < 300; index++) forget.run(`o${index}`, `message:other:${index}`);
  for (let index = 0; index < 40; index++) { add.run(`f${index}`, 10 + index); forget.run(`c${index}`, `message:chat:f${index}`); }
  db.exec("COMMIT");
  const cost: Record<number, { seeks: number; lines: number }> = {};
  let made = 40;
  for (const history of [1_000, 100_000]) {
    db.exec("BEGIN");
    for (; made < history; made++) add.run(`h${made}`, 100_000 + made);
    db.exec("COMMIT");
    const before = threadForgetsWorkForTest();
    positionalWithheld("chat", ["r1"]);
    const after = threadForgetsWorkForTest();
    cost[history] = { seeks: after.seeks - before.seeks, lines: after.lines - before.lines };
  }
  console.log(`FORGET-LIST-COST 1k=${JSON.stringify(cost[1_000])} 100k=${JSON.stringify(cost[100_000])}`);
  expect(cost[100_000]).toEqual(cost[1_000]);
  expect(cost[1_000]).toMatchObject({ seeks: 1, lines: 40 });
  expect(cost[1_000]!.lines).toBeLessThanOrEqual(257);
}, 300_000);

// ---- Astra TCFO r3 H1: COLD-CITED-POSITIONAL (MurageMain 18:00Z): a reply citing a line no verdict was kept for ------------------------------
// Before r4 the cited line was walked (producers, roots, copy) but never timed against its thread's forgets, so a reply citing a COLD line
// written after a forget was shown, by a kept verdict and by a fresh one alike, until the cited line had been warmed (and was then withheld).

it("COLD-CITED-POSITIONAL: a reply citing a cold line written after a forget is withheld with no warming, after warming, and after reopening", () => {
  forgottenL2("owner-forget");
  // no warm of r1: the reply's judge meets r1 cold
  expect(withheld("older", "r2"), "cold, kept").toBe(true);
  expect(fresh("older", "r2"), "cold, a new connection").toBe(true);
  warm("chat", ["r1"]);
  expect(withheld("older", "r2"), "after warming").toBe(true);
  expect(fresh("older", "r2", () => warm("chat", ["r1"])), "warm, a new connection").toBe(true);
});

it("COLD-CITED-POSITIONAL: a kept cold verdict follows the forget being written after it (the p key is the reply's too)", () => {
  database().prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',1500,'user','text','The gate code is 7731.','{}')").run();
  positionalFixture({ at: 2000 });
  expect(withheld("older", "r2"), "cold, nothing forgotten").toBe(false);
  forgetLine("message:chat:L2", 5000);
  const kept = withheld("older", "r2");
  expect({ kept, fresh: fresh("older", "r2") }).toEqual({ kept: true, fresh: true });
});

// ---- Astra TCFO r3 H2: the forget-list read visits a bounded number of tombstone rows, whatever else the thread's tombstones hold ----------

it("r4: the forget-list read is flat from 1,000 to 100,000 non-forget tombstones in the thread: 1 row by the index, at most 1,025 (then fail closed) without it", async () => {
  const db = database();
  positionalFixture({ at: 2000 });
  const stone = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,?,?)");
  db.exec("BEGIN");
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat','L2',1500,'user','text','The gate code is 7731.','{}')").run();
  stone.run("t-L2", "message:chat:L2", "owner-forget", 5000);
  db.exec("COMMIT");
  const read = () => { const before = threadForgetsWorkForTest(); const out = positionalWithheld("chat", ["r1"]); const after = threadForgetsWorkForTest(); return { rows: after.rows - before.rows, withheld: out.has("r1") }; };
  const PLAN = "EXPLAIN QUERY PLAN SELECT target_id,created_at,1 AS kept FROM memory_tombstones INDEXED BY memory_tombstones_forgets WHERE target_type='source' AND reason IN ('owner-forget','forgotten-supporting-source') AND target_id>=? AND target_id<? ORDER BY target_id LIMIT 1025";
  const cost: Record<number, { fallback: { rows: number; withheld: boolean }; indexed: { rows: number; withheld: boolean } }> = {};
  let made = 0;
  for (const count of [1_000, 100_000]) {
    // a deleted bot's lines in this conversation (memory-revocation.ts endPlacedSource): tombstones the forget list never reads
    db.exec("BEGIN");
    for (; made < count; made++) stone.run(`x${made}`, `message:chat:x${made}`, "bot-deleted", 1);
    db.exec("COMMIT");
    if (optionalIndexReady(db, TOMBSTONE_FORGETS_INDEX)) db.exec(`DROP INDEX ${TOMBSTONE_FORGETS_INDEX}`);
    const fallback = read();
    expect(await buildOptionalIndexOffThread(db, TOMBSTONE_FORGETS, { inline: true })).toBe(true);
    const plan = db.prepare(PLAN).all("message:chat:", "message:chat;").map(row => String(row.detail)).join(" | ");
    expect(plan).toMatch(/memory_tombstones_forgets/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    cost[count] = { fallback, indexed: read() };
  }
  console.log(`FORGET-LIST-ROWS ${JSON.stringify(cost)}`);
  // without the index: the scan stops at its bound, and the list is "many" (every generated line withheld: fail closed)
  // (TCFO-METER) a first page of one node (16 rows) is read first; only a full one reads the whole bound
  expect(cost[1_000]!.fallback).toEqual({ rows: 16 + 1_001, withheld: true });
  expect(cost[100_000]!.fallback).toEqual({ rows: 16 + 1_025, withheld: true });
  // with it: the forgets only, the same at 1k and 100k, and the exact answer
  expect(cost[1_000]!.indexed).toEqual({ rows: 1, withheld: true });
  expect(cost[100_000]!.indexed).toEqual(cost[1_000]!.indexed);
}, 300_000);

// ---- TCFO-METER (Astra TCFO r4 Medium, MurageMain): the cited line's positional read is paid before it is made ---------------------------

/** 200 lines of thread chat forgotten, all written after r1: r1 is not withheld by them, but timing it reads all 200. */
function manyLaterForgets() {
  const db = database();
  positionalFixture({ at: 2000 });
  const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'user','text','x','{}')");
  const forget = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,'owner-forget',9000)");
  db.exec("BEGIN");
  for (let index = 0; index < 200; index++) { add.run(`z${index}`, 3000 + index); forget.run(`tz${index}`, `message:chat:z${index}`); }
  db.exec("COMMIT");
}

it("TCFO-METER: with the allowance spent before or during the read, the cited line is withheld, and no row is read unpaid", () => {
  manyLaterForgets();
  // a cold reply citing r1, with all it needs: shown (the 200 forgets came after r1)
  expect(withheld("older", "r2")).toBe(false);
  closeDatabase();
  let shownAt = -1;
  for (let nodes = 1; nodes <= 400 && shownAt < 0; nodes++) {
    closeDatabase();
    const allowance = LineageAllowance.tool(nodes);
    const before = threadForgetsWorkForTest();
    const out = capturedMessageWithheld(allowance, "older", "r2");
    const after = threadForgetsWorkForTest();
    const read = after.rows - before.rows + after.lines - before.lines;
    // every forget-list row read was paid for first: never more rows than the nodes spent buy
    expect(read, `nodes=${nodes}`).toBeLessThanOrEqual(allowance.spent * ROWS_PER_NODE);
    if (!out) shownAt = nodes;
    // short of the whole read the answer is withheld, never shown unread
    else expect(out, `nodes=${nodes}`).toBe(true);
  }
  expect(shownAt, "a large enough allowance shows it").toBeGreaterThan(0);
});

/** Rows positionalWithheld and threadForgets physically read so far. */
const physical = () => { const w = threadForgetsWorkForTest(); return w.rows + w.lines + w.reads; };

it("TCFO-METER: what the cited line's check is charged equals what it read: 15, 16 and 17 forgets, and nothing for a list reused in the pass", () => {
  positionalFixture({ at: 2000 });
  /** What the cold check of r2 spends of a real allowance. */
  const spentBy = () => { closeDatabase(); const allowance = LineageAllowance.tool(100_000); expect(capturedMessageWithheld(allowance, "older", "r2")).toBe(false); return allowance.spent; };
  const none = spentBy();
  let made = 0;
  for (const count of [15, 16, 17]) {
    const db = database();
    const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'user','text','x','{}')");
    const forget = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,'owner-forget',9000)");
    db.exec("BEGIN");
    for (; made < count; made++) { add.run(`z${made}`, 3000 + made); forget.run(`tz${made}`, `message:chat:z${made}`); }
    db.exec("COMMIT");
    closeDatabase();
    const read0 = physical(), paid0 = positionalPaidForTest();
    expect(withheld("older", "r2"), `${count}`).toBe(false);
    const read = physical() - read0, paid = positionalPaidForTest() - paid0;
    expect(paid, `${count} forgets: charged = read`).toBe(read);
    // the first page, the whole list again when the first page was full, one key read per listed line, one row per cited line
    expect(read, `${count}`).toBe((count < ROWS_PER_NODE ? count : ROWS_PER_NODE + count) + count + 1);
    // and the allowance itself is spent that many rows, ROWS_PER_NODE to a node rounded up (nothing for the unused bound)
    expect(spentBy() - none, `${count} forgets: allowance nodes`).toBe(Math.ceil(read / ROWS_PER_NODE));
  }
  // a refused reservation reads nothing: the first page, and (with the first page full) the whole bound
  for (const refuse of [1, 2]) {
    closeDatabase();
    let asked = 0;
    const refusing = { reserve() { if (++asked === refuse) throw new Error("MEMORY_REPLAY_LIMIT"); }, pay() {} };
    const read0 = threadForgetsWorkForTest().rows;
    expect(() => positionalWithheld("chat", ["r1"], refusing), `refuse ${refuse}`).toThrow("MEMORY_REPLAY_LIMIT");
    expect(threadForgetsWorkForTest().rows - read0, `refuse ${refuse}: only what was reserved before`).toBe(refuse === 1 ? 0 : ROWS_PER_NODE);
  }
  // every read is paid before it is made, or (a forget-list page) reserved before and paid for its rows after
  const ordered = { paid: 0, reserved: 0, reserve(rows: number) { expect(physical() - read00, "reserved with nothing unpaid").toBe(this.paid); this.reserved = rows; },
    pay(rows: number) {
      const ahead = physical() - read00 - this.paid;
      if (ahead) { expect(ahead, "a page: paid what it read").toBe(rows); expect(rows, "within its reservation").toBeLessThanOrEqual(this.reserved); }
      this.paid += rows; this.reserved = 0;
    } };
  closeDatabase();
  const read00 = physical();
  positionalWithheld("chat", ["r1"], ordered);
  expect(physical() - read00, "all of it paid").toBe(ordered.paid);
  // a list already read in this pass is not read, and not paid for, again
  const meter = { reserved: 0, paid: 0, reserve(rows: number) { this.reserved += rows; }, pay(rows: number) { this.paid += rows; } };
  withStatementReuse(() => {
    positionalWithheld("chat", ["r1"], meter);
    const first = { ...meter };
    positionalWithheld("chat", ["r1"], meter);
    expect(meter.reserved - first.reserved, "reused list: nothing reserved").toBe(0);
    expect(meter.paid - first.paid, "reused list: only the cited line's own row").toBe(1);
  });
});

it("TCFO-METER: the timing reads (the turn's first row, the parent) are paid before they are made, and a refused payment makes none", () => {
  // L (1000) forgotten at 1500; r1 (2000) was put together in turn T, whose first row's parent is L: r1 is withheld
  positionalFixture({ at: 2000, json: { turnId: "T", parentId: "u" } });
  capture("chat", "u", "go on", "user", 1200, { turnId: "T", parentId: "L" });
  ownerForget(1500);
  const db = database();
  const first = db.prepare("SELECT rowid FROM messages WHERE thread_id='chat' AND id='u'").get() as { rowid: number };
  db.prepare("INSERT OR REPLACE INTO turn_first(thread_id,turn_id,first_rowid) VALUES('chat','T',?)").run(first.rowid);
  closeDatabase();
  const calls: number[] = [];
  const counting = { reserve() {}, pay(rows: number) { calls.push(rows); } };
  const read0 = physical();
  expect([...positionalWithheld("chat", ["r1"], counting)], "turn begun before the forget").toEqual(["r1"]);
  const read = physical() - read0;
  // the list's page (1 row), its key read, then r1's row, the turn's first row and its parent: each paid
  expect(calls, "pay order").toEqual([1, 1, 1, 1, 1]);
  expect(read).toBe(5);
  // refusing each payment in turn: the read it pays for is not made, nor any after it
  for (let refuse = 1; refuse <= calls.length; refuse++) {
    closeDatabase();
    let asked = 0;
    const refusing = { reserve() {}, pay() { if (++asked === refuse) throw new Error("MEMORY_REPLAY_LIMIT"); } };
    const before = physical();
    expect(() => positionalWithheld("chat", ["r1"], refusing), `refuse ${refuse}`).toThrow("MEMORY_REPLAY_LIMIT");
    // the first payment is for a page already read under its reservation; every later one comes before its read
    expect(physical() - before, `refuse ${refuse}`).toBe(refuse === 1 ? 1 : refuse - 1);
  }
});

// ---- TCFO-METER r4 (Grok tcfo5 M + L) ------------------------------------------------------------------------------------------------

it("TCFO-METER: the positional read outside a judge is paid on the allowance (capturedMessageWithheld, capturedMessageVerdict, replayExclusions), and one it cannot pay is withheld", () => {
  positionalFixture({ at: 2000 });
  const spent = (run: (allowance: LineageAllowance) => unknown) => { closeDatabase(); const allowance = LineageAllowance.tool(100_000); run(allowance); return allowance.spent; };
  const entries: Array<[string, (allowance: LineageAllowance) => unknown]> = [
    ["capturedMessageWithheld", allowance => expect(capturedMessageWithheld(allowance, "chat", "r1")).toBe(false)],
    ["capturedMessageVerdict", allowance => expect(capturedMessageVerdict(allowance, "chat", "r1")).toEqual({ withheld: false, unproven: false })],
    ["replayExclusions", allowance => expect([...replayExclusions(allowance, "chat", [{ id: "r1", role: "bot" }], null, { failClosed: true })]).toEqual([])],
  ];
  const before = entries.map(([, run]) => spent(run));
  // 200 lines of chat forgotten after r1: r1 is not withheld, but timing it reads the whole list (16 + 200 rows, 200 key reads, r1's row)
  const db = database();
  const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'user','text','x','{}')");
  const forget = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,'owner-forget',9000)");
  db.exec("BEGIN");
  for (let index = 0; index < 200; index++) { add.run(`z${index}`, 3000 + index); forget.run(`tz${index}`, `message:chat:z${index}`); }
  db.exec("COMMIT");
  entries.forEach(([name, run], index) => {
    expect(spent(run) - before[index]!, `${name}: the positional read is paid`).toBeGreaterThanOrEqual(Math.floor((16 + 200 + 200 + 1) / ROWS_PER_NODE));
  });
  // with a small allowance no entry point reads more positional rows than it paid for (whatever the judge after it does)
  for (const nodes of [1, 2, 4, 8, 16]) entries.forEach(([name], index) => {
    closeDatabase();
    const allowance = LineageAllowance.tool(nodes);
    const read0 = physical();
    try {
      if (index === 0) capturedMessageWithheld(allowance, "chat", "r1");
      else if (index === 1) capturedMessageVerdict(allowance, "chat", "r1");
      else replayExclusions(allowance, "chat", [{ id: "r1", role: "bot" }], null, { failClosed: true });
    } catch { /* a limit thrown through is a withheld answer */ }
    // (the allowance pays rows ROWS_PER_NODE to a node: up to one node's rows can be owed and not yet a node, never more)
    expect(physical() - read0, `${name} nodes=${nodes}: rows read <= rows paid`).toBeLessThanOrEqual((allowance.spent + 1) * ROWS_PER_NODE);
  });
  // an allowance that cannot pay for it: withheld as still being checked, never shown
  closeDatabase();
  expect(capturedMessageWithheld(LineageAllowance.tool(2), "chat", "r1")).toBe(true);
  closeDatabase();
  expect(capturedMessageVerdict(LineageAllowance.tool(2), "chat", "r1")).toEqual({ withheld: true, unproven: true });
  closeDatabase();
  const checking = new Set<string>();
  expect([...replayExclusions(LineageAllowance.tool(2), "chat", [{ id: "r1", role: "bot" }], null, { failClosed: true, checking })]).toEqual(["r1"]);
  expect([...checking]).toEqual(["r1"]);
});

it("TCFO-METER: a reply whose roots are chat lines under 200 forgets: the root checks (the judge's badRoots, flatRootsBad) pay for every positional row they read", () => {
  thawRootSetWritesForTest(true);
  try {
    positionalFixture({ at: 2000 });
    // x: a reply in older made with no receipt, whose context carried chat's r1: its stored root set is that chat line
    capture("older", "x", "Sure.", "bot", 2500);
    const chatRoots = () => outputRootsShallow([{ threadId: "chat", id: "r1", role: "bot" }]);
    recordOutputRoots("older", "x", chatRoots());
    const entries: Array<[string, (allowance: LineageAllowance) => boolean]> = [
      ["badRoots (the judge, through x's stored root set)", allowance => capturedMessageWithheld(allowance, "older", "x")],
      ["flatRootsBad (a root set of chat lines)", allowance => outputRootsBad(allowance, chatRoots())],
    ];
    const run = (index: number, nodes: number) => {
      closeDatabase();
      const allowance = LineageAllowance.tool(nodes);
      const read0 = physical();
      let out: boolean | "threw";
      try { out = entries[index]![1](allowance); } catch { out = "threw"; /* a limit thrown through is a withheld answer */ }
      return { out, read: physical() - read0, spent: allowance.spent };
    };
    const before = entries.map((_, index) => run(index, 100_000));
    entries.forEach(([name], index) => expect(before[index]!.out, `${name}: shown before the forgets`).toBe(false));
    // 200 lines of chat forgotten after r1: r1 is not withheld, but timing it reads the whole list (16 + 200 rows, 200 key reads, r1's row)
    const db = database();
    const add = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('chat',?,?,'user','text','x','{}')");
    const forget = db.prepare("INSERT INTO memory_tombstones VALUES(?,'source',?,NULL,NULL,0,'owner-forget',9000)");
    db.exec("BEGIN");
    for (let index = 0; index < 200; index++) { add.run(`z${index}`, 3000 + index); forget.run(`tz${index}`, `message:chat:z${index}`); }
    db.exec("COMMIT");
    const scale = 16 + 200 + 200 + 1;
    entries.forEach(([name], index) => {
      const big = run(index, 100_000);
      expect(big.out, `${name}: shown with all it needs`).toBe(false);
      // the meter is reached at scale: the whole list is read here, and paid for
      expect(big.read - before[index]!.read, `${name}: the whole list read`).toBeGreaterThanOrEqual(scale);
      expect(big.spent - before[index]!.spent, `${name}: and paid`).toBeGreaterThanOrEqual(Math.floor(scale / ROWS_PER_NODE));
    });
    // with a small allowance neither root check reads more positional rows than it paid for, and the answer is never "shown"
    for (const nodes of [1, 2, 4, 8, 16]) entries.forEach(([name], index) => {
      const small = run(index, nodes);
      expect(small.read, `${name} nodes=${nodes}: rows read <= rows paid`).toBeLessThanOrEqual((small.spent + 1) * ROWS_PER_NODE);
      expect(small.out, `${name} nodes=${nodes}: withheld, never shown unread`).not.toBe(false);
    });
  } finally { thawRootSetWritesForTest(false); }
});

it("TCFO-METER: the forget list falls back to the range scan when the schema has no index, whatever the error's wording, and only then", async () => {
  const db = database();
  expect(forgetIndexMissing(db), "not built yet: the fallback").toBe(true);
  expect(await buildOptionalIndexOffThread(db as never, TOMBSTONE_FORGETS, { inline: true })).toBe(true);
  expect(optionalIndexReady(db as never, TOMBSTONE_FORGETS_INDEX)).toBe(true);
  expect(forgetIndexMissing(db), "index there: an error is thrown on").toBe(false);
  db.exec(`DROP INDEX ${TOMBSTONE_FORGETS_INDEX}`);
  expect(forgetIndexMissing(db), "no index: the fallback").toBe(true);
  // and the read still answers with it gone
  positionalFixture({ at: 2000 });
  ownerForget(1500);
  closeDatabase();
  expect(withheld("older", "r2"), "r1 written after the forget, turn begun after it: shown").toBe(false);
});
