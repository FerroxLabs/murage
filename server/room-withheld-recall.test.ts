// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 lane T2, gaps 1 and 2: a room reply withheld from the transcript
// (what it used was forgotten, deleted or changed) is withheld everywhere
// else it lives too: its captured chunk in recall and memory search, the
// room checkpoint built from it, and every copy of it mirrored into a pair
// room or back into the room that asked.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import { refreshMemoryCheckpoint } from "./memory/consolidate.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { forgetMemory } from "./memory/forget.ts";
import { buildMemoryBundle, hydrateMemoryRecord } from "./memory/bundle.ts";
import { searchMemory, type MemorySearchBridge } from "./memory/search.ts";
import { filterMemoryReplay, roomReplayWithheld } from "./memory/disclosures.ts";
import { insertMessage } from "./message-db.ts";
import { capturedMessageWithheld } from "./memory/replay-lineage.ts";
import { readFileSync } from "node:fs";
import type { Message } from "./store.ts";

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

function access(botId: string, thread: string) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;
function disclose(bundleId: string, thread: string, records: Array<{ id: string; version: number }>, outputs: string[]) {
  const a = access("dax", "dax-direct");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,'[]',?,?,?,?,?,?)")
    .run(bundleId, thread, "fake", JSON.stringify(records), JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, 10, "delivered", Date.now());
}
/** One of Dax's own memories, from his direct chat. */
function daxMemory() {
  reconcileMemoryRoster(roster);
  const text = "rows 83-86 went out on the 26th.";
  captureSource(database(), { id: "src-dax", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "src-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-dax", access("dax", "dax-direct"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  return record;
}
/** A message captured the way the harness captures a room line, through a
 * real capture job, so its chunk is recallable and the checkpoint can roll. */
function captured(thread: string, messageId: string, speaker: string, text: string) {
  const id = `message:${thread}:${messageId}`;
  captureSource(database(), { id, threadId: thread, messageId, kind: "text", speaker, outcome: "recorded", text });
  // publish every pending capture (the owner's memory source included)
  let jobId = "";
  for (let work = claimMemoryJob("t2-worker"); work; work = claimMemoryJob("t2-worker")) {
    publishMemoryWork(work, "t2-worker", captureWork(work));
    if (work.sourceId === id) jobId = work.id;
  }
  if (!jobId) throw new Error(`fixture did not capture ${id}`);
  return jobId;
}
const REPLY = "Rows 83-86 went out on the 26th, the vendor confirmed it in writing.";
/** Dax answers in the room from his own memory; the answer is captured. */
function daxRoomReply() {
  const record = daxMemory();
  disclose("b-dax", "closing-chat", [{ id: record, version: version(record) }], ["m-dax"]);
  const job = captured("closing-chat", "m-dax", "dax", REPLY);
  return { record, job };
}
const chunkOf = (sourceId: string) => database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND r.kind='source' AND r.state='active'").get(sourceId) as { id: string; version: number };
const forget = (record: string) => forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });

it("gap 1: the chunk captured from a withheld room reply is not recalled or found again", async () => {
  const { record } = daxRoomReply();
  const chunk = chunkOf("message:closing-chat:m-dax");
  expect(chunk).toBeTruthy();
  expect(hydrateMemoryRecord(chunk.id, chunk.version, access("finch", "closing-chat")).text).toContain("83-86");
  forget(record);
  expect([...roomReplayWithheld("closing-chat", [{ id: "m-dax" }])]).toEqual(["m-dax"]);
  const reader = access("finch", "closing-chat");
  expect(() => hydrateMemoryRecord(chunk.id, chunk.version, reader)).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  const bridge: MemorySearchBridge = { search: async () => ({ hits: [{ id: chunk.id, version: chunk.version, score: 1, lexical: true }], vectorRows: 0, coverageComplete: true }) };
  const found = await searchMemory("rows 83-86 vendor", reader, bridge);
  expect(found.hits.map(hit => hit.id)).not.toContain(chunk.id);
  const bundle = await buildMemoryBundle("rows 83-86 vendor", reader, bridge);
  expect(bundle.text).not.toContain("83-86");
});

it("gap 1: a record the room saved from a withheld reply is not recalled", () => {
  const { record } = daxRoomReply();
  const saved = saveMemoryCandidate("The vendor confirmed rows 83-86 in writing.", [{ sourceId: "message:closing-chat:m-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(REPLY) }], "k-room", access("finch", "closing-chat"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(saved);
  expect(hydrateMemoryRecord(saved, version(saved), access("finch", "closing-chat")).text).toContain("83-86");
  forget(record);
  expect(() => hydrateMemoryRecord(saved, version(saved), access("finch", "closing-chat"))).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});

it("gap 1: the room checkpoint built from a withheld reply leaves recall, and the next one is rebuilt without it", async () => {
  const { record, job } = daxRoomReply();
  const first = refreshMemoryCheckpoint(job);
  expect(first.status).toBe("updated");
  const empty: MemorySearchBridge = { search: async () => ({ hits: [], vectorRows: 0 }) };
  expect((await buildMemoryBundle("", access("finch", "closing-chat"), empty)).text).toContain("83-86");
  forget(record);
  const after = await buildMemoryBundle("", access("finch", "closing-chat"), empty);
  expect(after.text).not.toContain("83-86");
  // the owner speaks again: the checkpoint rolls, without the withheld reply
  const next = refreshMemoryCheckpoint(captured("closing-chat", "m-owner-2", "owner", "Thanks, let us move on to the invoices."));
  expect(next.status).toBe("updated");
  const rolled = database().prepare("SELECT text FROM memory_records WHERE id=? AND version=?").get(next.checkpointId!, next.version!) as { text: string };
  expect(rolled.text).toContain("invoices");
  expect(rolled.text).not.toContain("83-86");
  const again = await buildMemoryBundle("", access("finch", "closing-chat"), empty);
  expect(again.text).toContain("invoices");
});

it("gap 1: the owner's own words and an owner pin are never withheld for what a bot recalled", () => {
  const { record } = daxRoomReply();
  captured("closing-chat", "m-owner", "owner", "Please confirm rows 83-86.");
  const pinned = saveMemoryCandidate("Rows 83-86 went out on the 26th.", [{ sourceId: "message:closing-chat:m-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(REPLY) }], "k-pin", access("finch", "closing-chat"));
  database().prepare("UPDATE memory_records SET state='active',owner_pinned=1 WHERE id=?").run(pinned);
  forget(record);
  const owner = chunkOf("message:closing-chat:m-owner");
  expect(hydrateMemoryRecord(owner.id, owner.version, access("finch", "closing-chat")).text).toContain("confirm");
  expect(hydrateMemoryRecord(pinned, version(pinned), access("finch", "closing-chat")).pinned).toBe(true);
});

/** Dax's delegated answer in his own task thread, and its copy posted by the
 * harness into the pair room. */
function mirroredReply() {
  const record = daxMemory();
  disclose("b-task", "dax-direct", [{ id: record, version: version(record) }], ["m-original"]);
  captured("dax-direct", "m-original", "dax", REPLY);
  const copy: Message = { id: "m-copy", role: "bot", kind: "text", text: REPLY, at: Date.now(), from: { botId: "dax", name: "Dax", color: "#000" }, copyOf: { threadId: "dax-direct", messageIds: ["m-original"] } };
  insertMessage("pair-chat", copy);
  captured("pair-chat", "m-copy", "dax", REPLY);
  return { record, copy };
}

it("gap 2: a mirrored copy is withheld with its original, in owner and other rooms", () => {
  const { record, copy } = mirroredReply();
  const pair = [{ id: "m-ask", role: "user" }, copy];
  expect([...roomReplayWithheld("pair-chat", pair)]).toEqual([]);
  forget(record);
  expect([...roomReplayWithheld("pair-chat", pair)]).toEqual(["m-copy"]);
  expect(filterMemoryReplay("pair-chat", pair, access("finch", "pair-chat"), { persist: false }).map(m => m.id)).toEqual(["m-ask"]);
});

it("gap 2: forgetting the original message itself withholds its copy", () => {
  const { copy } = mirroredReply();
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:dax-direct:m-original" });
  expect([...roomReplayWithheld("pair-chat", [copy])]).toEqual(["m-copy"]);
});

it("gap 2: the copy's own captured chunk leaves recall with the original", () => {
  const { record } = mirroredReply();
  const chunk = chunkOf("message:pair-chat:m-copy");
  expect(hydrateMemoryRecord(chunk.id, chunk.version, access("finch", "pair-chat")).text).toContain("83-86");
  forget(record);
  expect(() => hydrateMemoryRecord(chunk.id, chunk.version, access("finch", "pair-chat"))).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});

it("gap 2: a copy owed to the asking bot's next turn is known withheld (external delivery hands over the withheld line)", () => {
  const { record } = mirroredReply();
  expect(capturedMessageWithheld("pair-chat", "m-copy")).toBe(false);
  forget(record);
  expect(capturedMessageWithheld("pair-chat", "m-copy")).toBe(true);
  // the delivery path reads it this way (server/index.ts, planExternalDelivery input)
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("if (message?.copyOf && capturedMessageWithheld(threadId, id)) return { id, text: withheldRoomLine(message) };");
});
