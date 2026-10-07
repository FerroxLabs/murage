// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61, gap 4: a room with more than 2048 memory receipts failed
// every memory-on turn (MEMORY_REPLAY_LIMIT), because the replay check read
// every receipt of the room before it looked at a single line. A busy room
// now checks only the lines a member prompt can show, reads receipts per
// line, and withholds a line it cannot finish checking. It never fails the
// turn and never shows what it could not check.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { forgetMemory } from "./memory/forget.ts";
import { hydrateMemoryRecord } from "./memory/bundle.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import { filterMemoryReplay } from "./memory/disclosures.ts";
import { THREAD_RECEIPT_LIMIT } from "./memory/replay-lineage.ts";
import { roomTranscriptForTurn } from "./room-transcript.ts";
import type { Message } from "./store.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop" },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [{ id: "busy", threadId: "busy-room", memberIds: ["finch", "dax"] }],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string, notOwnerAudience = false) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;

/** A room whose history holds `count` bot replies, each made under its own
 * memory receipt (the receipts cite nothing, so each reply is fine), and
 * the newest one made from a memory of Dax's that can be forgotten. */
function busyRoom(count: number) {
  reconcileMemoryRoster(roster);
  const text = "rows 83-86 went out on the 26th.";
  captureSource(database(), { id: "src-dax", threadId: "busy-room", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "src-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-dax", access("dax", "busy-room"));
  database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record);
  const a = access("dax", "busy-room");
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'old-'||value,'busy-room','driver','[]','[]',json_array('reply-'||value),?,?,0,'delivered',value FROM n`).run(count - 1, a.policyRevision, a.deletionEpoch);
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b-last','busy-room','driver',?,'[]','[\"reply-last\"]',?,?,0,'delivered',?)")
    .run(JSON.stringify([{ id: record, version: version(record) }]), a.policyRevision, a.deletionEpoch, count);
  const messages: Message[] = [];
  for (let i = 1; i < count; i++) messages.push({ id: `reply-${i}`, role: "bot", kind: "text", text: `reply ${i}`, at: i, from: { botId: "dax", name: "Dax", color: "#000" } });
  messages.push({ id: "reply-last", role: "bot", kind: "text", text: "Rows 83-86 went out on the 26th.", at: count, from: { botId: "dax", name: "Dax", color: "#000" } });
  messages.push({ id: "ask", role: "user", kind: "text", text: "Finch, anything to add?", at: count + 1 });
  return { record, messages };
}

it(`reads a room at exactly ${THREAD_RECEIPT_LIMIT} receipts whole, as before`, () => {
  const { messages } = busyRoom(THREAD_RECEIPT_LIMIT);
  const turn = roomTranscriptForTurn("busy-room", messages, true, access("finch", "busy-room"));
  expect(turn.messages).toHaveLength(messages.length);
  expect(turn.withheld.size).toBe(0);
});

it(`a room past ${THREAD_RECEIPT_LIMIT} receipts no longer fails the turn, for the owner and for anyone else`, () => {
  const { record, messages } = busyRoom(THREAD_RECEIPT_LIMIT + 1);
  const owner = roomTranscriptForTurn("busy-room", messages, true, access("finch", "busy-room"));
  // only what the prompt can show was checked, and all of it is shown
  expect(owner.messages.map(m => m.id).slice(-2)).toEqual(["reply-last", "ask"]);
  expect(owner.messages.length).toBeLessThan(100);
  expect(owner.withheld.size).toBe(0);
  const other = roomTranscriptForTurn("busy-room", messages, false, access("finch", "busy-room", true));
  expect(other.messages.map(m => m.id).slice(-2)).toEqual(["reply-last", "ask"]);

  // what the owner forgets is still withheld there
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  const after = roomTranscriptForTurn("busy-room", messages, true, access("finch", "busy-room"));
  expect([...after.withheld]).toEqual(["reply-last"]);
  expect(after.messages.find(m => m.id === "reply-last")?.text).toContain("Reply withheld");
  const otherAfter = roomTranscriptForTurn("busy-room", messages, false, access("finch", "busy-room", true));
  expect(otherAfter.messages.map(m => m.id)).not.toContain("reply-last");
  // the forget moved the deletion epoch, so a reader that is not the owner
  // keeps none of the older replies (its rule, unchanged); the search for
  // replies it may show stops after a bounded number of lines
  expect(otherAfter.messages.map(m => m.id)).toEqual(["ask"]);
  expect(otherAfter.checked.size).toBeLessThanOrEqual(8 * 60 + 1);
});

// 0.1.61.1 memreplay: a line listed by more receipts than the old per-line
// cap is judged by all of them, so a sound one is shown, not withheld.
it("a line listed by more than the old per-line receipt cap is judged by all of them, not an error", () => {
  const { messages } = busyRoom(10);
  const a = access("dax", "busy-room");
  database().prepare(`WITH RECURSIVE n(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM n WHERE value<?)
    INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    SELECT 'crowd-'||value,'busy-room','driver','[]','[]','["reply-3"]',?,?,0,'delivered',value FROM n`).run(THREAD_RECEIPT_LIMIT + 1, a.policyRevision, a.deletionEpoch);
  const owner = roomTranscriptForTurn("busy-room", messages, true, access("finch", "busy-room"));
  expect([...owner.withheld]).toEqual([]);
  const other = roomTranscriptForTurn("busy-room", messages, false, access("finch", "busy-room", true));
  expect(other.messages.map(m => m.id)).toContain("reply-3");
  expect(other.messages.map(m => m.id)).toContain("reply-4");
  expect(filterMemoryReplay("busy-room", messages, access("finch", "busy-room")).map(m => m.id)).toContain("reply-3");
  // one of them revoked: a reader held to receipts no longer sees the line
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='crowd-1700'").run();
  const otherAfter = roomTranscriptForTurn("busy-room", messages, false, access("finch", "busy-room", true));
  expect(otherAfter.messages.map(m => m.id)).not.toContain("reply-3");
  expect(otherAfter.messages.map(m => m.id)).toContain("reply-4");
});

it("recall of a reply in a room past the limit still follows the content rule", () => {
  const { record } = busyRoom(THREAD_RECEIPT_LIMIT + 1);
  captureSource(database(), { id: "message:busy-room:reply-last", threadId: "busy-room", messageId: "reply-last", kind: "text", speaker: "dax", outcome: "recorded", text: "Rows 83-86 went out on the 26th." });
  for (let work = claimMemoryJob("t2"); work; work = claimMemoryJob("t2")) publishMemoryWork(work, "t2", captureWork(work));
  const chunk = database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id='message:busy-room:reply-last' AND r.kind='source'").get() as { id: string; version: number };
  expect(hydrateMemoryRecord(chunk.id, chunk.version, access("finch", "busy-room")).text).toContain("83-86");
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(() => hydrateMemoryRecord(chunk.id, chunk.version, access("finch", "busy-room"))).toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
});
