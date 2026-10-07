// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 cross-audit (Astra round 1): the ways a withheld reply, a
// copy of it or a member's private memory still reached a bot after the
// first T2 commits, each reproduced here and closed.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { setMemoryMode } from "./memory/repository.ts";
import { captureSource } from "./memory/capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import * as learnable from "./memory/learnable.ts";
import { consolidateMemorySource } from "./memory/consolidate.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { forgetMemory } from "./memory/forget.ts";
import { continuationMemoryRevoked, filterMemoryReplay, readerWithheldMessage, roomReplayWithheld } from "./memory/disclosures.ts";
import { _loadPending, findDelegationReceipt, recordDelegationReceipt, summarizeDelegatedActivity } from "./delegations.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { roomTranscriptWithoutMemory } from "./room-transcript.ts";
import { copyOriginWithheld, messageMadeWithMemory, recordRestsOnWithheldMessage, replayExclusions } from "./memory/replay-lineage.ts";
import { insertMessage } from "./message-db.ts";
import type { Message } from "./store.ts";

// A Windows checkout has CRLF line endings; the wiring checks read LF.
const indexSource = () => readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop" },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [
    { id: "closing", threadId: "closing-chat", memberIds: ["finch", "dax"] },
    { id: "pair", threadId: "pair-chat", memberIds: ["finch", "dax"] },
  ],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string, notOwnerAudience = false) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const scopeOf = (kind: string, owner: string) => (database().prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind, owner) as { id: string }).id;
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;
function disclose(bundleId: string, thread: string, records: Array<{ id: string; version: number }>, outputs: string[]) {
  const a = access("dax", "dax-direct");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,'[]',?,?,?,?,?,?)")
    .run(bundleId, thread, "fake", JSON.stringify(records), JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, 10, "delivered", Date.now());
}
function publishCaptures() {
  for (let work = claimMemoryJob("t2"); work; work = claimMemoryJob("t2")) publishMemoryWork(work, "t2", captureWork(work));
}
/** One of Dax's memories. `bot`: in his private bot memory; else his chat's. */
function daxMemory(bot = false) {
  reconcileMemoryRoster(roster);
  const text = "rows 83-86 went out on the 26th.";
  captureSource(database(), { id: "src-dax", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "src-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-dax", access("dax", "dax-direct"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  if (bot) {
    database().prepare("UPDATE memory_records SET scope_id=? WHERE id=?").run(scopeOf("bot", "dax"), record);
    database().prepare("UPDATE memory_sources SET scope_id=? WHERE id='src-dax'").run(scopeOf("bot", "dax"));
  }
  return record;
}
const REPLY = "Rows 83-86 went out on the 26th, the vendor confirmed it in writing.";
const bot = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text, at: Date.now(), from: { botId: "dax", name: "Dax", color: "#000" }, ...extra });
/** Dax's answer in his own chat (from `record`) and its copy in the pair room. */
function copied(record: string, originThread = "dax-direct") {
  disclose("b-task", originThread, [{ id: record, version: version(record) }], ["m-original"]);
  captureSource(database(), { id: `message:${originThread}:m-original`, threadId: originThread, messageId: "m-original", kind: "text", speaker: "dax", outcome: "recorded", text: REPLY });
  const copy = bot("m-copy", REPLY, { copyOf: { threadId: originThread, messageIds: ["m-original"] } });
  insertMessage("pair-chat", copy);
  captureSource(database(), { id: "message:pair-chat:m-copy", threadId: "pair-chat", messageId: "m-copy", kind: "text", speaker: "dax", outcome: "recorded", text: REPLY });
  publishCaptures();
  return copy;
}
const forget = (record: string) => forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });

it("finding 2: a copy of a reply made from private memory is not shown to a reader who may not see that memory", () => {
  const record = daxMemory(true);
  const copy = copied(record);
  const pair = [{ id: "m-ask", role: "user" }, copy];
  // the owner's own turn reads it (content rule only, room-transcript.ts)
  expect([...roomReplayWithheld("pair-chat", pair)]).toEqual([]);
  // a turn nobody proved is the owner's reads the room through the reader's
  // filter, and may not see Dax's bot memory, so not its copy either
  expect(filterMemoryReplay("pair-chat", pair, access("finch", "pair-chat", true), { persist: false }).map(m => m.id)).toEqual(["m-ask"]);
});

it("finding 3: a reply that recalled a withheld copy is withheld too", () => {
  const record = daxMemory();
  copied(record);
  // Finch recalled the copy's chunk and answered in the pair room.
  const chunk = database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id='message:pair-chat:m-copy' AND r.kind='source'").get() as { id: string; version: number };
  disclose("b-finch", "pair-chat", [chunk], ["m-finch"]);
  const later = [bot("m-finch", "Per Dax, rows 83-86 went out on the 26th.")];
  expect([...roomReplayWithheld("pair-chat", later)]).toEqual([]);
  forget(record);
  expect([...roomReplayWithheld("pair-chat", later)]).toEqual(["m-finch"]);
});

it("finding 4: an approved projection of a record saved from a withheld reply is withheld with it", () => {
  const record = daxMemory();
  copied(record);
  const saved = saveMemoryCandidate("The vendor confirmed rows 83-86.", [{ sourceId: "message:dax-direct:m-original", revision: 1, startByte: 0, endByte: Buffer.byteLength(REPLY) }], "k-saved", access("dax", "dax-direct"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(saved);
  database().prepare("INSERT INTO memory_records VALUES('projection',1,?,'fact','The vendor confirmed rows 83-86.','owner-statement','active',0,?,NULL,NULL,?)").run(scopeOf("team", "Operations"), Date.now(), Date.now());
  database().prepare("INSERT INTO memory_derivations VALUES(?,?,'projection',1)").run(saved, version(saved));
  expect(recordRestsOnWithheldMessage("projection", 1)).toBe(false);
  forget(record);
  expect(recordRestsOnWithheldMessage(saved, version(saved))).toBe(true);
  expect(recordRestsOnWithheldMessage("projection", 1)).toBe(true);
});

it("finding 6: a delegation result read back later follows its original", () => {
  const record = daxMemory();
  const copy = copied(record);
  expect(copyOriginWithheld(copy.copyOf!)).toBe(false);
  forget(record);
  expect(copyOriginWithheld(copy.copyOf!)).toBe(true);
});

it.each([false, true])("finding 7: a withheld reply is not sent to the extractor (isolate withheld guard: %s)", async (isolateWithheldGuard) => {
  setMemoryMode("capture");
  const record = daxMemory();
  disclose("b-room", "closing-chat", [{ id: record, version: version(record) }], ["m-dax"]);
  captureSource(database(), { id: "message:closing-chat:m-dax", threadId: "closing-chat", messageId: "m-dax", kind: "text", speaker: "dax", outcome: "recorded", text: REPLY });
  let job = "";
  for (let work = claimMemoryJob("t2"); work; work = claimMemoryJob("t2")) { publishMemoryWork(work, "t2", captureWork(work)); if (work.sourceId === "message:closing-chat:m-dax") job = work.id; }
  forget(record);
  const extractor = vi.fn(async () => "[]");
  // D1 rejects generated replies before the withheld guard. Owner messages
  // are never withheld, so exercise that downstream guard independently by
  // stubbing only learnability; capture, forgotten lineage and withholding stay real.
  expect(learnable.isLearnableSource(database(), "message:closing-chat:m-dax", 1)).toEqual({ learnable: false, reason: "not-owner-speaker" });
  const gate = isolateWithheldGuard ? vi.spyOn(learnable, "isLearnableSource").mockReturnValue({ learnable: true }) : undefined;
  try {
    const result = await consolidateMemorySource(job, extractor, new AbortController().signal);
    expect(result).toMatchObject({ status: "deferred", reason: isolateWithheldGuard ? "reply-withheld" : "not-owner-speaker" });
    expect(extractor).not.toHaveBeenCalled();
  } finally {
    gate?.mockRestore();
  }
});

it("finding 8: a copy whose lineage runs past the hop or width budget is withheld, not accepted", () => {
  const record = daxMemory();
  copied(record);
  // five hops: pair-chat m-copy is the first; chain four more copies of it
  let previous = { threadId: "pair-chat", id: "m-copy" };
  for (let hop = 2; hop <= 5; hop++) {
    const next = bot(`m-hop-${hop}`, REPLY, { copyOf: { threadId: previous.threadId, messageIds: [previous.id] } });
    insertMessage("closing-chat", next);
    previous = { threadId: "closing-chat", id: next.id };
  }
  const last = bot("m-hop-6", REPLY, { copyOf: { threadId: previous.threadId, messageIds: [previous.id] } });
  expect([...replayExclusions("closing-chat", [last], null, { failClosed: true })]).toEqual(["m-hop-6"]);
  const wide = bot("m-wide", REPLY, { copyOf: { threadId: "dax-direct", messageIds: Array.from({ length: 65 }, (_, i) => `m-${i}`) } });
  expect([...replayExclusions("closing-chat", [wide], null, { failClosed: true })]).toEqual(["m-wide"]);
  const narrow = bot("m-narrow", REPLY, { copyOf: { threadId: "dax-direct", messageIds: ["m-original"] } });
  expect([...replayExclusions("closing-chat", [narrow], null, { failClosed: true })]).toEqual([]);
});

it("finding 9: a thread whose receipts are too heavy to read whole is checked through the output index and keeps the owner's words", () => {
  const a = access("dax", "closing-chat");
  // continuation-style receipts: each lists every later output of its session
  const ids = Array.from({ length: 142 }, (_, i) => `m-${i}`);
  const insert = database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d','s','[]','[]',?,?,?,0,'delivered',?)");
  for (let i = 0; i < 142; i++) insert.run(`c-${i}`, "closing-chat", JSON.stringify(ids.slice(i)), a.policyRevision, a.deletionEpoch, i);
  const messages = [{ id: "owner-1", role: "user" }, ...ids.map(id => ({ id, role: "bot" })), { id: "owner-2", role: "user" }];
  // 0.1.61.1 memreplay: output lists are no longer read into the budget, so
  // this session is judged whole (its receipts cite nothing) without failing
  expect(replayExclusions("closing-chat", messages, null).size).toBe(0);
  const withheld = replayExclusions("closing-chat", messages, null, { failClosed: true });
  expect(withheld.has("owner-1")).toBe(false);
  expect(withheld.has("owner-2")).toBe(false);
});

// Kimi K3 round 1

it("Kimi M3: a reader whose words were not proven never marks the owner's receipts revoked", () => {
  const record = daxMemory(true);
  disclose("b-direct", "dax-direct", [{ id: record, version: version(record) }], ["m-answer"]);
  const lines = [{ id: "m-ask", role: "user" }, { id: "m-answer", role: "bot" }];
  expect(filterMemoryReplay("dax-direct", lines, access("dax", "dax-direct", true)).map(m => m.id)).toEqual(["m-ask"]);
  expect(continuationMemoryRevoked("dax-direct", "fake", "none", access("dax", "dax-direct", true))).toBe(true);
  expect((database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id='b-direct'").get() as { state: string }).state).toBe("delivered");
  // the owner's own turn still reads its reply
  expect(filterMemoryReplay("dax-direct", lines, access("dax", "dax-direct")).map(m => m.id)).toEqual(["m-ask", "m-answer"]);
});

it("Kimi M4: one oversized receipt no longer fails a room turn", () => {
  const a = access("dax", "closing-chat");
  const huge = JSON.stringify(Array.from({ length: 12000 }, (_, i) => `bulk-output-${i}-padding-padding`));
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('huge','closing-chat','d',NULL,'[]','[]',?,?,?,0,'delivered',1)").run(huge, a.policyRevision, a.deletionEpoch);
  const lines = [{ id: "owner-1", role: "user" }, ...Array.from({ length: 10 }, (_, i) => ({ id: `r-${i}`, role: "bot" })), { id: "owner-2", role: "user" }];
  // its output list is never read (0.1.61.1 memreplay): no error, and the
  // lines it does not list are not withheld for it
  expect(replayExclusions("closing-chat", lines, null).size).toBe(0);
  const withheld = replayExclusions("closing-chat", lines, null, { failClosed: true });
  expect(withheld.has("owner-1") || withheld.has("owner-2")).toBe(false);
});

// Astra audit of D4: with memory not active the owner's note was never
// updated. The floor names what it checked and why each reply is withheld,
// and the room turn sets the owner's note from it as it does with memory on.
it("with memory not active, the room turn sets the owner's note from what it checked, with the forgotten reason", () => {
  reconcileMemoryRoster(roster);
  const record = daxMemory();
  disclose("b-room", "closing-chat", [{ id: record, version: version(record) }], ["m-dax"]);
  const lines = [{ id: "m-owner", role: "user", kind: "text", text: "rows?", at: 1 } as Message, bot("m-dax", REPLY), bot("m-finch", "the forgotten line")];
  captureSource(database(), { id: "message:closing-chat:m-finch", threadId: "closing-chat", messageId: "m-finch", kind: "text", speaker: "finch", outcome: "recorded", text: "the forgotten line" });
  setMemoryMode("capture");
  forget(record);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:closing-chat:m-finch" });
  const owner = roomTranscriptWithoutMemory("closing-chat", lines, true)!;
  expect([...owner.withheld].sort()).toEqual(["m-dax", "m-finch"]);
  expect([...owner.forgotten]).toEqual(["m-finch"]);
  expect([...owner.checked]).toEqual(["m-owner", "m-dax", "m-finch"]);
  const index = indexSource();
  expect(index).toContain("if (roomFloor && roomOwnerAudience) syncOwnerWithheldNotes(threadId, roomFloor);");
});

it("Kimi M5: with memory no longer active, a forgotten reply stays withheld in the room", () => {
  const record = daxMemory();
  disclose("b-room", "closing-chat", [{ id: record, version: version(record) }], ["m-dax"]);
  const lines = [{ id: "m-owner", role: "user", kind: "text", text: "rows?", at: 1 } as Message, bot("m-dax", REPLY), { id: "m-next", role: "user", kind: "text", text: "thanks", at: 3 } as Message];
  setMemoryMode("capture");
  expect(roomTranscriptWithoutMemory("closing-chat", lines, true)?.withheld.size).toBe(0);
  forget(record);
  const owner = roomTranscriptWithoutMemory("closing-chat", lines, true)!;
  expect([...owner.withheld]).toEqual(["m-dax"]);
  expect(owner.messages.find(m => m.id === "m-dax")?.text).toContain("Reply withheld");
  expect(roomTranscriptWithoutMemory("closing-chat", lines, false)!.messages.map(m => m.id)).toEqual(["m-owner", "m-next"]);
  // a room that never used memory is read as it is
  expect(roomTranscriptWithoutMemory("pair-chat", [bot("m-plain", "hello")], true)).toBeUndefined();
});

// Astra round 2

it("R2-3: the reader check follows a copy through the evidence of a later reply", () => {
  const record = daxMemory(true);
  copied(record);
  const chunk = database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id='message:pair-chat:m-copy' AND r.kind='source'").get() as { id: string; version: number };
  disclose("b-finch", "pair-chat", [chunk], ["m-finch"]);
  const later = [{ id: "m-ask", role: "user" }, bot("m-finch", "Per Dax, rows 83-86 went out on the 26th.")];
  expect([...roomReplayWithheld("pair-chat", later)]).toEqual([]);
  expect(filterMemoryReplay("pair-chat", later, access("finch", "pair-chat", true), { persist: false }).map(m => m.id)).toEqual(["m-ask"]);
});

it("R2-2: a direct turn whose words were not proven gets the reader rule for recall too", () => {
  const record = daxMemory(true);
  disclose("b-answer", "dax-direct", [{ id: record, version: version(record) }], ["m-answer"]);
  expect(readerWithheldMessage(access("dax", "dax-direct"))).toBeUndefined();
  const rule = readerWithheldMessage(access("dax", "dax-direct", true))!;
  expect(rule("dax-direct", "m-answer")).toBe(true);
  expect(rule("dax-direct", "m-other")).toBe(false);
});

it("R2-4/5/6: delegation receipts keep the audience and the whole link, and running excerpts can be left out", () => {
  const record = daxMemory();
  copied(record);
  recordDelegationReceipt({ id: "task-wide", sourceThreadId: "finch-direct", toBotId: "dax", toBotName: "Dax", status: "done", result: REPLY, notOwnerAudience: true,
    copyOf: { threadId: "dax-direct", messageIds: ["m-original", ...Array.from({ length: 69 }, (_, i) => `m-extra-${i}`)] } });
  _loadPending();
  const loaded = findDelegationReceipt("task-wide")!;
  expect(loaded.notOwnerAudience).toBe(true);
  expect(loaded.copyOf!.messageIds.length).toBe(65);
  expect(copyOriginWithheld(loaded.copyOf!)).toBe(true);
  const activity = [{ at: 2, kind: "text", text: REPLY }, { at: 3, kind: "activity", tool: { name: "Read notes" } }] as never[];
  expect(summarizeDelegatedActivity(activity, 1)).toEqual([`text: ${REPLY}`, "tool: Read notes"]);
  expect(summarizeDelegatedActivity(activity, 1, 5, false)).toEqual(["tool: Read notes"]);
});

it("R2-7: a derivation chain past the budget counts as withheld even when its first records carry no evidence", () => {
  const record = daxMemory();
  copied(record);
  const saved = saveMemoryCandidate("The vendor confirmed rows 83-86.", [{ sourceId: "message:dax-direct:m-original", revision: 1, startByte: 0, endByte: Buffer.byteLength(REPLY) }], "k-chain", access("dax", "dax-direct"));
  let parent = { id: saved, version: version(saved) };
  for (let i = 0; i < 66; i++) {
    database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','projection','owner-statement','active',0,?,NULL,NULL,?)").run(`p-${i}`, scopeOf("team", "Operations"), Date.now(), Date.now());
    database().prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(parent.id, parent.version, `p-${i}`);
    parent = { id: `p-${i}`, version: 1 };
  }
  expect(recordRestsOnWithheldMessage("p-65", 1)).toBe(true);
  expect(recordRestsOnWithheldMessage("p-10", 1)).toBe(false);
});

it("R2-8: with memory not active, words nobody proved in the owner's room see no reply made with memory", () => {
  const record = daxMemory(true);
  disclose("b-room", "closing-chat", [{ id: record, version: version(record) }], ["m-dax"]);
  setMemoryMode("capture");
  const lines = [{ id: "m-owner", role: "user", kind: "text", text: "rows?", at: 1 } as Message, bot("m-dax", REPLY), bot("m-plain", "Good morning.")];
  expect(roomTranscriptWithoutMemory("closing-chat", lines, true)!.messages.map(m => m.id)).toEqual(["m-owner", "m-dax", "m-plain"]);
  expect(roomTranscriptWithoutMemory("closing-chat", lines, false, undefined, true)!.messages.map(m => m.id)).toEqual(["m-owner", "m-plain"]);
});

it("R2-1/9/10: a turn that is not the owner's gets no standing material, no owed copy and no quoted memory reply (wiring)", () => {
  const record = daxMemory();
  disclose("b-answer", "dax-direct", [{ id: record, version: version(record) }], ["m-answer"]);
  expect(messageMadeWithMemory("dax-direct", "m-answer")).toBe(true);
  expect(messageMadeWithMemory("dax-direct", "m-plain")).toBe(false);
  const source = indexSource();
  // next: the owner's standing material follows the full owner-audience predicate
  expect(source).toContain("const standing = standingContextParts(bot, { partition: bot.partitionedAt === undefined ? undefined : threadPartition(bot, threadId), ownerAudience: surfacesForOwner,");
  expect(source).toContain("const memoryNotOwner = humanIsOwner && (!surfacesForOwner || opts?.notOwnerAudience === true);");
  expect(source).toContain("if (message?.copyOf && (memoryNotOwner || capturedMessageWithheld(threadId, id))) return { id, text: withheldRoomLine(message) };");
  expect(source).toContain("replyForPrompt(threadId, opts?.replyTo && promptRows([opts.replyTo], turnRouteHasTools, task.externalUpdates)[0], memoryNotOwner),");
  // recall leaves the notebook and brief out by the thread's audience, never
  // the turn's: a turn not shown them cannot recall them (next's authz rule)
  // three: the direct turn, the room turn, and the direct turn's early (overlapped) bundle,
  // which uses the same thread-audience exclusion as its dispatch bundle
  expect(source.split("standingContextSourceIds(bot,").length - 1).toBe(3);
  expect(source).toContain("excludeSourceIds: standingContextSourceIds(bot, humanIsOwner, bot.partitionedAt === undefined ? undefined : threadPartition(bot, threadId)),");
  expect(source).toContain("excludeSourceIds:standingContextSourceIds(bot,humanIsOwner,bot.partitionedAt === undefined ? undefined : threadPartition(bot,threadId)),");
  expect(source).toContain("excludeSourceIds:standingContextSourceIds(bot,turnAudienceIsOwner(threadId),bot.partitionedAt === undefined ? undefined : threadPartition(bot,threadId)),");
  expect(source).toContain("const withheld = (internalClaim.notOwnerAudience === true && receipt.notOwnerAudience !== true) || (receipt.copyOf && copyOriginWithheld(receipt.copyOf))");
});

// Astra round 3

// 0.1.61.1 memreplay replaces R3-12's whole-thread cap: it failed every turn
// of a long direct chat. The lines replayed are judged by every receipt that
// lists them, so the cap guarded nothing the check does not.
it("R3-12: a direct chat past 2048 receipts judges the lines it replays by their own receipts", () => {
  const a = access("dax", "dax-direct");
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<2049)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'other-'||value,'dax-direct','driver','[]','[]',json_array('other-output-'||value),?,?,0,'delivered',value FROM n`).run(a.policyRevision, a.deletionEpoch);
  expect(filterMemoryReplay("dax-direct", [{ id: "m-ask", role: "user" }, { id: "m-answer", role: "bot" }], a).map(m => m.id)).toEqual(["m-ask", "m-answer"]);
  expect([...replayExclusions("dax-direct", [{ id: "m-answer", role: "bot" }], null, { failClosed: true })]).toEqual([]);
  // one revoked receipt that lists the reply still withholds it
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('answer-receipt','dax-direct','driver','[]','[]','[\"m-answer\"]',?,?,0,'revoked',1)").run(a.policyRevision, a.deletionEpoch);
  expect(filterMemoryReplay("dax-direct", [{ id: "m-ask", role: "user" }, { id: "m-answer", role: "bot" }], a).map(m => m.id)).toEqual(["m-ask"]);
});

it("R3-9: a legacy delegation result with no recorded origin is not handed back", () => {
  recordDelegationReceipt({ id: "task-legacy", sourceThreadId: "finch-direct", toBotId: "dax", toBotName: "Dax", status: "done", result: REPLY });
  recordDelegationReceipt({ id: "task-new", sourceThreadId: "finch-direct", toBotId: "dax", toBotName: "Dax", status: "done", result: "(no text)", lineage: true });
  _loadPending();
  expect(findDelegationReceipt("task-legacy")!.lineage).toBeUndefined();
  expect(findDelegationReceipt("task-new")!.lineage).toBe(true);
  const source = indexSource();
  expect(source).toContain(`|| (receipt.status === "done" && receipt.lineage !== true);`);
});

it("R3-1/6/10: queued quotes are rendered at drain, running excerpts follow withholding, a converted ask keeps its audience (wiring)", () => {
  const source = indexSource();
  expect(source).toContain("replyForPrompt(threadId, message.replyToId ? byId.get(message.replyToId) : undefined, unproven && isWorkspaceOwner(threadHumanPrincipal(threadId)))");
  expect(source).toContain(`!capturedMessageWithheld(runningEntry[0], message.id)`);
  expect(source).toMatch(/startedAtMs: Date\.now\(\) - ASK_BOT_TIMEOUT_MS,\n\s+\.\.\.\(internalClaim\.notOwnerAudience === true \? \{ notOwnerAudience: true \} : \{\}\),/);
});
