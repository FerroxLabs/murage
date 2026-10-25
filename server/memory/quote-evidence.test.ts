// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.5: memory_save evidence as the quoted words. On the training rig Ember (Fuigo) could not save anything it heard in a
// memory merge: the tool took evidence only as {sourceId, revision, startByte, endByte}, and no tool ever hands a bot the
// sourceId of a conversation line. Each test names the owner's failure it prevents.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, closeDatabase } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { captureWork } from "./chunks.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { memoryAgentRoute } from "./routes.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

afterEach(() => setMemoryCaptureRoster(null));
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
const SAID = "My shop is Wren & Willow — we fix bikes in Austin.";
function fixture() {
  const roster = { bots: [{ id: "bot", threadId: "thread" }, { id: "other", threadId: "private" }], groups: [] };
  setMemoryCaptureRoster(() => roster); reconcileMemoryRoster(roster); setMemoryMode("capture");
  appendMessage("thread", { id: "said", at: 1, role: "user", origin: "desktop", kind: "text", text: SAID });
  appendMessage("private", { id: "elsewhere", at: 2, role: "user", origin: "desktop", kind: "text", text: "A private line for the other bot." });
  for (let job = claimMemoryJob("fixture"); job; job = claimMemoryJob("fixture")) publishMemoryWork(job, "fixture", captureWork(job));
  setMemoryMode("active");
  const registry = new InternalCapabilities(); registry.begin("bot", "thread", "generation");
  const token = registry.mint({ botId: "bot", threadId: "thread", generation: "generation", depth: 99, kind: "memory", skillAuthoring: false });
  const context = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const bridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
  return { context, bridge };
}
const evidenceOf = (id: string) => database().prepare("SELECT e.start_byte,e.end_byte,v.payload FROM memory_evidence e JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision WHERE e.record_id=?").all(id);

it("a bot with nothing remembered saves what the owner just said by quoting it (the merge fell back to files)", async () => {
  const f = fixture(), quote = "we fix bikes in Austin.";
  const result = await memoryAgentRoute("/api/internal/memory/save", { text: quote, evidence: [{ quote }], idempotencyKey: "quoted", claimType: "owner-statement" }, f.context, f.bridge) as { candidateId: string; state: string };
  expect(result).toMatchObject({ state: "active", pendingReview: false });
  const [row] = evidenceOf(result.candidateId);
  // the stored span is the quote's exact bytes in the captured line
  expect(Buffer.from(JSON.parse(String(row!.payload)).text).subarray(Number(row!.start_byte), Number(row!.end_byte)).toString("utf8")).toBe(quote);
  // the same save again replays (same span), it is not a conflict
  expect(await memoryAgentRoute("/api/internal/memory/save", { text: quote, evidence: [{ quote }], idempotencyKey: "quoted", claimType: "owner-statement" }, f.context, f.bridge)).toEqual(result);
});

it("a quote with the messageId thread_search returned is cited from that message", async () => {
  const f = fixture();
  const result = await memoryAgentRoute("/api/internal/memory/save", { text: "The shop is Wren & Willow.", evidence: [{ quote: "My shop is Wren & Willow", messageId: "said" }], idempotencyKey: "by-message" }, f.context, f.bridge) as { candidateId: string };
  expect(evidenceOf(result.candidateId)).toHaveLength(1);
});

it("words the conversation does not contain, or a line this bot may not read, are refused with a next step and save nothing", async () => {
  const f = fixture();
  await expect(memoryAgentRoute("/api/internal/memory/save", { text: "Maya lives in Paris.", evidence: [{ quote: "I live in Paris." }], idempotencyKey: "made-up" }, f.context, f.bridge)).rejects.toThrow("not in this conversation");
  await expect(memoryAgentRoute("/api/internal/memory/save", { text: "Private.", evidence: [{ quote: "A private line", messageId: "elsewhere" }], idempotencyKey: "other-bot" }, f.context, f.bridge)).rejects.toThrow("not in that message");
  // the other bot's line is not found by a bare quote either: only this conversation is searched
  await expect(memoryAgentRoute("/api/internal/memory/save", { text: "Private.", evidence: [{ quote: "A private line" }], idempotencyKey: "other-bot-2" }, f.context, f.bridge)).rejects.toThrow("not in this conversation");
  expect(database().prepare("SELECT count(*) AS n FROM memory_records WHERE kind='fact'").get()!.n).toBe(0);
});

function say(id: string, at: number, role: "user" | "bot", text: string) {
  appendMessage("thread", { id, at, role, origin: "desktop", kind: "text", text });
  for (let job = claimMemoryJob("fixture"); job; job = claimMemoryJob("fixture")) publishMemoryWork(job, "fixture", captureWork(job));
}

it("the owner's own line is cited over a newer echo of it by the bot, so the save is not held as another speaker's words", async () => {
  const f = fixture(), quote = "we fix bikes in Austin.";
  say("echo", 3, "bot", `Got it: ${quote}`);
  const speakers = database().prepare("SELECT speaker FROM memory_sources WHERE thread_id='thread' ORDER BY rowid").all().map(row => row.speaker);
  expect(speakers).toContain("owner"); expect(speakers.some(speaker => speaker !== "owner")).toBe(true);
  const result = await memoryAgentRoute("/api/internal/memory/save", { text: quote, evidence: [{ quote }], idempotencyKey: "owner-over-echo", claimType: "owner-statement" }, f.context, f.bridge) as { candidateId: string };
  const [row] = evidenceOf(result.candidateId);
  expect(JSON.parse(String(row!.payload)).text).toBe(SAID);
  expect(result).toMatchObject({ state: "active" });
});

it("a retried save meets the evidence its first attempt stored, even after a newer line repeats the words (no idempotency conflict)", async () => {
  const f = fixture(), quote = "we fix bikes in Austin.";
  const args = { text: quote, evidence: [{ quote }], idempotencyKey: "retried", claimType: "owner-statement" as const };
  const first = await memoryAgentRoute("/api/internal/memory/save", args, f.context, f.bridge) as { candidateId: string };
  say("again", 3, "user", `Like I said, ${quote}`);
  expect(await memoryAgentRoute("/api/internal/memory/save", args, f.context, f.bridge)).toEqual(first);
  // a fresh save (a new key) cites the newest owner line
  const fresh = await memoryAgentRoute("/api/internal/memory/save", { ...args, idempotencyKey: "fresh" }, f.context, f.bridge) as { candidateId: string };
  expect(JSON.parse(String(evidenceOf(fresh.candidateId)[0]!.payload)).text).toBe(`Like I said, ${quote}`);
});
