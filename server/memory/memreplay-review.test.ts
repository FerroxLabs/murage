// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61.1 memreplay, independent review (PASS WITH FIXES): the review's
// probes, kept as tests.
// - M1: the replay window no longer reaches an old native session's
//   receipts, so the continuation check judges every receipt of the session
//   it resumes, lineage included, and resets it when one fails.
// - M2: lineage lookups are grouped by what a verdict rests on and charged
//   to the budget, so a frame citing many replies of a long session is fast.
// - L1: a line quoted from far back never takes a newer line's place.
// - L3: the receipt budget withholds a direct line instead of failing.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { continuationMemoryRevoked, filterDirectReplay, filterMemoryReplay } from "./disclosures.ts";
import { recordSessionRoots, REPLAY_RECEIPT_BUDGET, replayRowsRead, resetReplayRowsRead } from "./replay-lineage.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });
function fixture(threadId = "private", notOwnerAudience = false) {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "secret-team" }], groups: [] };
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities();
  const generation = registry.begin("bot", threadId);
  const token = registry.mint({ botId: "bot", threadId, generation, kind: "memory", depth: 100, skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
type M = { id: string; role: string; kind: string; text: string; replyToId?: string };
const owner = (id: string, replyToId?: string): M => ({ id, role: "user", kind: "text", text: `ask ${id}`, ...(replyToId ? { replyToId } : {}) });
const bot = (id: string): M => ({ id, role: "bot", kind: "text", text: `answer ${id}` });
function botSource(scope: string, messageId: string) {
  database().prepare("INSERT INTO memory_sources VALUES(?,?,'private',?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:private:${messageId}`, scope, messageId);
  database().prepare("INSERT INTO memory_source_versions VALUES(?,1,'hash',?,1)").run(`message:private:${messageId}`, JSON.stringify({ text: messageId }));
}
function insertReceipt(a: { policyRevision: number; deletionEpoch: number }, id: string, session: string | null, sources: string[], outputs: string[], state = "delivered", at = 1) {
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?,?)")
    .run(id, "private", "fuigo", session, "[]", JSON.stringify(sources.map(s => ({ id: s, revision: 1 }))), JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, state, at);
}
const state = (id: string) => (database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(id) as { state: string }).state;

it("M1: a resumed session whose receipt cites a withheld reply is reset, though its outputs are far outside the replay window", () => {
  const a = fixture(); const scope = ensureScope("bot", "bot");
  // x-old: a bot reply withheld on its content: its own receipt cites a
  // source the owner since forgot (in the owner's own chat a receipt revoked
  // on state alone no longer withholds a reply; see the 1.0.1.1 case below)
  botSource(scope, "x-old"); botSource(scope, "gone");
  database().prepare("UPDATE memory_sources SET state='deleted' WHERE id='message:private:gone'").run();
  insertReceipt(a, "R-x", null, ["message:private:gone"], ["x-old"], "revoked", 1);
  // session S-A of engine fuigo: its frame cited x-old's captured source; its only output a-old
  insertReceipt(a, "R-s", "S-A", ["message:private:x-old"], ["a-old"], "delivered", 2);
  // a sound session S-B of the same engine
  botSource(scope, "y-old");
  insertReceipt(a, "R-y", null, [], ["y-old"], "delivered", 3);
  insertReceipt(a, "R-b", "S-B", ["message:private:y-old"], ["b-old"], "delivered", 4);
  // S-B is a session v6 started (its lineage row): its fixture timestamps
  // predate lineage, and an unproven pre-v6 session resets (Astra r4 #5)
  recordSessionRoots("private", "fuigo", "S-B", { roots: new Set(), over: false });
  const messages: M[] = [bot("x-old"), bot("a-old")];
  for (let i = 0; i < 60; i++) messages.push(owner(`o-${i}`), bot(`b-${i}`)); // another engine's turns
  filterDirectReplay("private", messages, a, new Set());
  expect(continuationMemoryRevoked("private", "fuigo", "S-A", a)).toBe(true);
  expect(state("R-s")).toBe("revoked");
  // a sound session resumes
  expect(continuationMemoryRevoked("private", "fuigo", "S-B", a)).toBe(false);
  expect(state("R-b")).toBe("delivered");
});

it("M1 (1.0.1.1): a cited reply whose receipt was revoked on state alone ends the session for a reader not proven the owner, never the owner's own chat", () => {
  for (const notOwner of [false, true]) {
    closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
    const a = fixture("private", notOwner); const scope = ensureScope("bot", "bot");
    // x-old: its receipt revoked by an install-wide change; its content intact
    botSource(scope, "x-old");
    insertReceipt(a, "R-x", null, [], ["x-old"], "revoked", 1);
    insertReceipt(a, "R-s", "S-A", ["message:private:x-old"], ["a-old"], "delivered", 2);
    recordSessionRoots("private", "fuigo", "S-A", { roots: new Set(), over: false });
    expect(continuationMemoryRevoked("private", "fuigo", "S-A", a)).toBe(notOwner);
    expect(state("R-s")).toBe("delivered");
  }
});

it("M1: a session whose check cannot finish is reset, not resumed", () => {
  const a = fixture(); const scope = ensureScope("bot", "bot");
  botSource(scope, "x-old");
  // the cited reply's producers run past the receipt budget
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'flood-'||v,'private','d','[]','[]','["x-old"]',?,?,0,'delivered',v FROM n`).run(REPLAY_RECEIPT_BUDGET + 1, a.policyRevision, a.deletionEpoch);
  insertReceipt(a, "R-s", "S-A", ["message:private:x-old"], ["a-old"], "delivered", REPLAY_RECEIPT_BUDGET + 10);
  expect(continuationMemoryRevoked("private", "fuigo", "S-A", a)).toBe(true);
  // nothing proven bad, so nothing is marked revoked
  expect(state("R-s")).toBe("delivered");
}, 240_000);

it("M1: a turn that is not the owner's resets the session but never marks the owner's receipts revoked", () => {
  const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "private", section: "secret-team" }], groups: [] };
  const a = fixture(); const scope = ensureScope("bot", "bot");
  botSource(scope, "x-old");
  insertReceipt(a, "R-x", null, [], ["x-old"], "revoked", 1);
  insertReceipt(a, "R-s", "S-A", ["message:private:x-old"], ["a-old"], "delivered", 2);
  const registry = new InternalCapabilities(); const generation = registry.begin("bot", "private");
  const token = registry.mint({ botId: "bot", threadId: "private", generation, kind: "memory", depth: 0, skillAuthoring: false, notOwnerAudience: true });
  const other = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  expect(continuationMemoryRevoked("private", "fuigo", "S-A", other)).toBe(true);
  expect(state("R-s")).toBe("delivered");
});

it("L3: a direct check past REPLAY_RECEIPT_BUDGET withholds the line, never throws; the strict form throws", () => {
  const a = fixture();
  database().prepare(`WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'flood-'||v,'private','d','[]','[]','["answer"]',?,?,0,'delivered',v FROM n`).run(REPLAY_RECEIPT_BUDGET + 1, a.policyRevision, a.deletionEpoch);
  expect(filterDirectReplay("private", [owner("ask"), bot("answer")], a, new Set()).allowed.map(m => m.id)).toEqual(["ask"]);
  expect(() => filterMemoryReplay("private", [owner("ask"), bot("answer")], a)).toThrow("MEMORY_REPLAY_LIMIT");
}, 240_000);

it("M2: a frame citing 256 replies of a 20,000-receipt session is checked in bounded time", () => {
  const a = fixture(); const scope = ensureScope("bot", "bot");
  const N = 20_000, K = 256;
  const replies = Array.from({ length: K }, (_, i) => `r-${i}`);
  for (const r of replies) botSource(scope, r);
  // producers: N receipts of an old session, each listing every reply (sound, cite nothing)
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,'delivered',?)");
  const outputs = JSON.stringify(replies);
  database().exec("BEGIN");
  for (let i = 0; i < N; i++) insert.run(`p-${i}`, "private", "fuigo", "old", "[]", "[]", outputs, a.policyRevision, a.deletionEpoch, i);
  database().exec("COMMIT");
  insertReceipt(a, "R-new", "new", replies.map(r => `message:private:${r}`), ["latest"], "delivered", N + 10);
  const messages: M[] = [...replies.map(bot)];
  for (let i = 0; i < 30; i++) messages.push(owner(`o-${i}`), bot(`b-${i}`));
  messages.push(owner("ask"), bot("latest"));
  resetReplayRowsRead();
  const started = performance.now();
  const kept = filterDirectReplay("private", messages, a, new Set()).allowed.map(m => m.id);
  const ms = performance.now() - started;
  expect(kept).toContain("latest");
  // The work is pinned by rows read, not time: the reviewed build read every
  // (receipt, reply) pair, more than 10 million index entries here (28 s on
  // build host). Bounded: the 20,000 receipts once, a pair count capped at the
  // pair limit, and a probe per cited reply.
  const rows = replayRowsRead();
  expect(rows).toBeLessThan(MAX_ROWS);
  // and a wall clock generous enough for a loaded machine
  expect(ms).toBeLessThan(MAX_MS);
  // one of those producers resting on something gone still withholds the
  // reply built on them, with the same bounded work per check (a withheld
  // line widens the window, so this call runs up to four checks). The
  // owner's direct chat withholds on content, not on a receipt's state (1.0.1).
  database().prepare(`UPDATE memory_disclosures SET source_versions='[{"id":"gone","revision":1}]' WHERE bundle_id='p-0'`).run();
  resetReplayRowsRead();
  expect(filterDirectReplay("private", messages, a, new Set()).allowed.map(m => m.id)).not.toContain("latest");
  expect(replayRowsRead()).toBeLessThan(4 * MAX_ROWS);
}, 600_000);
const MAX_ROWS = 100_000, MAX_MS = 20_000;

it("L1: lines quoted from far back are checked and kept for their quotes, but never push newer lines out of the 40", () => {
  const a = fixture();
  const messages: M[] = [];
  for (let i = 0; i < 100; i++) messages.push(owner(`old-${i}`));
  for (let i = 0; i < 20; i++) { messages.push(owner(`q-${i}`, i < 10 ? `old-${i}` : undefined)); messages.push(bot(`t-${i}`)); }
  // each receipt cites a source that is gone (the owner's direct chat withholds on content, 1.0.1)
  for (let i = 0; i < 10; i++) insertReceipt(a, `bad-${i}`, null, ["message:private:gone"], [`t-${i}`], "delivered", i);
  const { allowed, replayed } = filterDirectReplay("private", messages, a, new Set());
  expect(replayed).toHaveLength(40);
  expect(replayed.slice(0, 10).map(m => m.id)).toEqual(Array.from({ length: 10 }, (_, i) => `old-${90 + i}`));
  expect(replayed.at(-1)?.id).toBe("t-19");
  for (let i = 0; i < 10; i++) expect(replayed.map(m => m.id)).not.toContain(`t-${i}`);
  // the quoted lines are there for their quote text only
  expect(allowed.map(m => m.id)).toContain("old-0");
  expect(replayed.map(m => m.id)).not.toContain("old-0");
});
