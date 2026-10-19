// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Write-time privacy, S4 wiring: the read-side files ask the deny tables as a stricter layer beside the read-time judge (which S6 removes).
// readable.ts and consolidate.ts (memory marks), disclosures.ts (replay pages), dispatch.ts (session predicate, send fence),
// result-egress.ts (result lines), lessons.ts (revbound r3 A1, A4, F2 read halves) and bundle.ts (recall's own budget, partial not empty).
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { releaseStoredResult, writetimeLinesShown, type ResultEgressDeps } from "../result-egress.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { writetimeSourceState } from "./consolidate.ts";
import { writetimeReplayWithheld } from "./disclosures.ts";
import { assertSendFence, writetimeSessionVerdict } from "./dispatch.ts";
import { lessonEvidenceForgotten } from "./lessons.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { buildPrompt, promptPart } from "./prompt-parts.ts";
import { writetimeRecordRefusal } from "./readable.ts";
import { WritetimeFixture } from "./testing/writetime-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); });
const app = () => new WritetimeFixture(database());

it("replay pages: a deny-ranged reply is withheld and a pending one checking, once lineage is live; before that the read-time judge decides alone", () => {
  const f = app();
  f.message("T", "a", "user").message("T", "b", "bot");
  // no lsn taken on this file yet: the write-time layer stays out (S1 writers not live)
  expect([...writetimeReplayWithheld("T", [{ id: "b", role: "bot" }], { audience: null })]).toEqual([]);
  f.lineage("T", "a", 10, { generated: false, turnLsn: null }).lineage("T", "b", 12, { turnLsn: 11 }).reply("T", "c", 30, { turnLsn: 29 }).denyRange("T", 10, 20).pending("T", 30);
  const checking = new Set<string>();
  expect([...writetimeReplayWithheld("T", [{ id: "a", role: "user" }, { id: "b", role: "bot" }, { id: "c", role: "bot" }], { audience: null }, checking)].sort()).toEqual(["b", "c"]);
  expect([...checking]).toEqual(["c"]);
});

it("the session predicate resets a retained session on deny_session, on a pending window, and on a session with no lineage once lineage is live", () => {
  const f = app();
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "shown" }); // not live: read-time checks alone
  f.reply("T", "g", 5).sessionLineage("T", "d", "n", 1, 5);
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "shown" });
  expect(writetimeSessionVerdict("T", "d", "unknown")).toEqual({ state: "checking", reason: "no-lineage" });
  f.pending("T", 4);
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "checking", reason: "pending" });
  f.denySession("T", "d", "n");
  expect(writetimeSessionVerdict("T", "d", "n")).toEqual({ state: "withheld", reason: "deny-session" });
});

it("the send fence refuses a prompt whose quoted line was denied after it was built (MEMORY_CONTEXT_REVOKED), and passes an unchanged one", () => {
  const f = app().reply("T", "q", 5).meta("deny_generation", 2);
  const built = buildPrompt({ threadId: "T", turnId: "t", turnLsn: 6, parents: [], denyGeneration: 2 }, [promptPart("quote", [{ kind: "line", threadId: "T", messageId: "q" }])]);
  expect(() => assertSendFence(built, { audience: null })).not.toThrow();
  f.denyLine("T", 5).meta("deny_generation", 3);
  expect(() => assertSendFence(built, { audience: null })).toThrow("MEMORY_CONTEXT_REVOKED");
});

it("(k) a hand-off result whose line is marked is withheld by the result gate; an unmarked one is released", () => {
  const f = app().reply("W", "r1", 5).reply("W", "r2", 6).denyLine("W", 6);
  const deps: ResultEgressDeps = {
    message: (threadId, id) => (database().prepare("SELECT id FROM messages WHERE thread_id=? AND id=?").get(threadId, id) ? { id, text: `text of ${id}` } : undefined),
    authorize: () => ({ ok: true }), copyOriginWithheld: () => false, capturedMessageWithheld: () => false, messageSourceForgotten: () => false,
    messageMadeWithMemory: () => false, partitionAllowed: () => true, ownUnsharedWork: () => true, linesShown: writetimeLinesShown(database),
  };
  void f;
  expect(releaseStoredResult({ origin: { threadId: "W", messageIds: ["r1"] }, requestId: "req" }, "worker", "D", { fromBotId: "asker" }, false, undefined, deps).kind).toBe("text");
  expect(releaseStoredResult({ origin: { threadId: "W", messageIds: ["r2"] }, requestId: "req" }, "worker", "D", { fromBotId: "asker" }, false, undefined, deps).kind).toBe("withheld");
});

it("(A1, F2) a lesson citing a line of a deleted conversation with no captured source is withheld; (A4) so is one citing a reply the transcript withholds", () => {
  const db = database();
  const f = app().message("X", "said", "user").message("Y", "a", "user").message("Y", "b", "bot");
  expect(lessonEvidenceForgotten(db, [{ messageId: "said" }], "X")).toBe(false);
  f.deny("thread", "X");
  expect(lessonEvidenceForgotten(db, [{ messageId: "said" }], "X")).toBe(true);
  expect(lessonEvidenceForgotten(db, [{ messageId: "b" }], "Y")).toBe(false);
  // B repeats A's secret; forget A: B is withheld by its range, and the lesson citing B with it
  f.lineage("Y", "a", 10, { generated: false, turnLsn: null }).lineage("Y", "b", 12, { turnLsn: 11 }).denyRange("Y", 10, 20).tombstone("source", "message:Y:a");
  expect(lessonEvidenceForgotten(db, [{ messageId: "b" }], "Y")).toBe(true);
});

it("readable and consolidation refuse a marked record or source; a pending scope is not known now (the limit error), never shown", () => {
  const f = app().source("s1", "s-room").source("s2", "s-room").record("r1", 1, "s-room", ["s1"]).record("r2", 1, "s-room", ["s2"]);
  const db = database();
  const handle = (id: string) => [{ sourceId: id, revision: 1, startByte: 0, endByte: 3 }];
  expect(writetimeRecordRefusal(db, { kind: "record", id: "r1", version: 1, scopeId: "s-room" }, handle("s1"))).toBeUndefined();
  f.denyMemory("record", "r1", 1).denyMemory("source", "s2", 0);
  expect(writetimeRecordRefusal(db, { kind: "record", id: "r1", version: 1, scopeId: "s-room" }, handle("s1"))).toBe("MEMORY_RECORD_UNAVAILABLE");
  expect(writetimeRecordRefusal(db, { kind: "record", id: "r2", version: 1, scopeId: "s-room" }, handle("s2"))).toBe("MEMORY_EVIDENCE_UNAVAILABLE");
  expect(writetimeSourceState({ id: "s2", revision: 1, scope_id: "s-room" })).toBe("withheld");
  expect(writetimeSourceState({ id: "s1", revision: 1, scope_id: "s-room" })).toBe("shown");
  f.pendingScope("s-room", 1);
  expect(() => writetimeRecordRefusal(db, { kind: "record", id: "r9", version: 1, scopeId: "s-room" }, [])).not.toThrow(); // gone: a refusal
  f.record("r3", 1, "s-room", ["s1"]);
  expect(() => writetimeRecordRefusal(db, { kind: "record", id: "r3", version: 1, scopeId: "s-room" }, handle("s1"))).toThrow("MEMORY_REPLAY_LIMIT");
  expect(writetimeSourceState({ id: "s1", revision: 1, scope_id: "s-room" })).toBe("checking");
});

const roster = () => ({ bots: [{ id: "a", threadId: "new", tasks: [{ threadId: "new" }, { threadId: "old" }] }], groups: [] });
function access() {
  const r = roster(); reconcileMemoryRoster(r);
  const registry = new InternalCapabilities(), generation = registry.begin("a", "new");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "a", threadId: "new", generation, depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => r);
}
const empty = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };

it("recall has its own budget: a turn whose transcript spent its allowance still recalls what can be proven; recall's own budget spent is partial", async () => {
  const a = access();
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  catchUpRecentMemory(a);
  const spent = LineageAllowance.turn(); spent.close();
  const full = await buildMemoryBundle("report colour", a, empty, { allowance: spent });
  expect(full.text).toContain("charcoal");
  expect(full.recallPartial).toBeUndefined();
  const recallSpent = LineageAllowance.tool(); recallSpent.close();
  const partial = await buildMemoryBundle("report colour", a, empty, { allowance: LineageAllowance.turn(), recallAllowance: recallSpent });
  expect(partial.text).not.toContain("charcoal");
  expect(partial.recallPartial).toBe(true);
});

it("recall leaves out a hit the marker denied, and holds a hit in a pending scope as partial", async () => {
  const a = access();
  appendMessage("old", { id: "preference", at: 123, role: "user", kind: "text", text: "My report colour is charcoal." });
  catchUpRecentMemory(a);
  const f = app();
  const row = database().prepare("SELECT id,version,scope_id FROM memory_records WHERE text LIKE '%charcoal%' LIMIT 1").get()!;
  f.pendingScope(String(row.scope_id), 1);
  const held = await buildMemoryBundle("report colour", a, empty, { allowance: LineageAllowance.turn() });
  expect(held.text).not.toContain("charcoal");
  expect(held.recallPartial).toBe(true);
  database().exec("DELETE FROM memory_deny_pending_scope");
  f.denyMemory("record", String(row.id), 0);
  const denied = await buildMemoryBundle("report colour", a, empty, { allowance: LineageAllowance.turn() });
  expect(denied.text).not.toContain("charcoal");
});
