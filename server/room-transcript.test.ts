// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 transcript fix (R-A): in an owner room every member reads every
// teammate reply. A reply is withheld, as a visible line, only when what it
// used was forgotten, deleted or changed. Other rooms keep the per-reader
// replay filter, and that filter no longer marks receipts revoked for
// everyone because of what one reader could see.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { ownerMemoryTicket, saveMemoryCandidate } from "./memory/authority.ts";
import { forgetMemory } from "./memory/forget.ts";
import { pauseRestoredMemory } from "./memory/restore.ts";
import { threadCheckpointId } from "./memory/checkpoints.ts";
import { filterMemoryReplay, roomReplayWithheld } from "./memory/disclosures.ts";
import { roomTranscriptForTurn } from "./room-transcript.ts";
import { ROOM_REPLY_WITHHELD, withheldRoomLine, withholdRoomReplies } from "./room-context.ts";
import type { Message } from "./store.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop" },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [{ id: "closing", threadId: "closing-chat", memberIds: ["finch", "dax"] }],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string, current: MemoryRoster = roster) {
  reconcileMemoryRoster(current);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => current);
}
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;
function disclose(bundleId: string, thread: string, records: Array<{ id: string; version: number }>, sources: Array<{ id: string; revision: number }>, outputs: string[], state = "delivered") {
  const a = access("dax", thread);
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?)")
    .run(bundleId, thread, "fake", JSON.stringify(records), JSON.stringify(sources), JSON.stringify(outputs), a.policyRevision, a.deletionEpoch, 10, state, Date.now());
}
/** One of Dax's own memories, from his direct chat. */
function daxMemory(text = "rows 83-86 went out on the 26th.", sourceId = "src-dax") {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: sourceId, threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text });
  return active(saveMemoryCandidate(text, [{ sourceId, revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], `k-${sourceId}`, access("dax", "dax-direct")));
}
/** memory_save lands a candidate; recall only ever discloses active records. */
function active(record: string) { database().prepare("UPDATE memory_records SET state='active' WHERE id=?").run(record); return record; }
/** Dax's room reply made with that memory in his recall bundle. */
function daxReplyWithOwnRecall(state = "delivered") {
  const record = daxMemory();
  disclose("b-dax", "closing-chat", [{ id: record, version: version(record) }], [], ["m-dax"], state);
  return record;
}
const transcript = [{ id: "m-owner" }, { id: "m-dax" }, { id: "m-finch" }];
const stateOf = (bundleId: string) => (database().prepare("SELECT state FROM memory_disclosures WHERE bundle_id=?").get(bundleId) as { state: string }).state;

it("R7 inverted: a teammate's room reply made with its own recall stays in the next member's transcript", () => {
  daxReplyWithOwnRecall();
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  // and reading it marks nothing revoked for anyone
  expect(stateOf("b-dax")).toBe("delivered");
});

it("R8 inverted: a roster change revokes every receipt, and the reply is still there for every member", () => {
  daxReplyWithOwnRecall();
  const grown: MemoryRoster = { ...roster, bots: [...roster.bots, { id: "kessler", threadId: "kessler-direct", section: "Ops" }] };
  reconcileMemoryRoster(grown);
  expect(stateOf("b-dax")).toBe("revoked");
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  const turn = roomTranscriptForTurn("closing-chat", transcript as Message[], true, access("finch", "closing-chat", grown));
  expect(turn.messages.map(m => m.id)).toEqual(["m-owner", "m-dax", "m-finch"]);
});

it("a settings change (policy revision and deletion epoch moved) leaves room replies visible", () => {
  daxReplyWithOwnRecall();
  database().exec("UPDATE memory_meta SET policy_revision=policy_revision+5,deletion_epoch=deletion_epoch+2 WHERE id=1");
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
});

it("restore: every receipt revoked and memory paused, and the owner room still reads every reply", () => {
  daxReplyWithOwnRecall();
  expect(pauseRestoredMemory(database())).toBe(true);
  expect(stateOf("b-dax")).toBe("revoked");
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
});

it("withholds a reply whose record the owner forgot", () => {
  const record = daxReplyWithOwnRecall();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply whose record was deleted without a tombstone", () => {
  const record = daxReplyWithOwnRecall();
  database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(record);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply whose record carries a tombstone while still active", () => {
  const record = daxReplyWithOwnRecall();
  database().prepare("INSERT INTO memory_tombstones VALUES('t1','record',?,?,NULL,1,'owner-forget',1)").run(record, version(record));
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply whose cited source was deleted", () => {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-note", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text: "the vendor pin is 4471" });
  disclose("b-dax", "closing-chat", [], [{ id: "src-note", revision: 1 }], ["m-dax"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "src-note" });
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply whose cited source was edited (new revision)", () => {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-note", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text: "first wording" });
  disclose("b-dax", "closing-chat", [], [{ id: "src-note", revision: 1 }], ["m-dax"]);
  captureSource(database(), { id: "src-note", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text: "second wording" });
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply that used a derived record whose parent the owner forgot", () => {
  const parent = daxMemory("parent fact", "src-parent");
  const child = daxMemory("child fact", "src-child");
  database().prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,?,?,?)").run(parent, version(parent), child, version(child));
  disclose("b-dax", "closing-chat", [{ id: child, version: version(child) }], [], ["m-dax"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: parent });
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("withholds a reply that recalled an earlier reply which is itself no longer valid (ancestor receipt)", () => {
  // Dax said something in his own chat using a memory; that reply was then
  // captured and recalled into the room reply.
  const original = daxMemory("the original private fact", "src-original");
  disclose("b-direct", "dax-direct", [{ id: original, version: version(original) }], [], ["m-dax-direct"]);
  captureSource(database(), { id: "message:dax-direct:m-dax-direct", threadId: "dax-direct", messageId: "m-dax-direct", kind: "text", speaker: "dax", outcome: "recorded", text: "a paraphrase of it" });
  const paraphrase = active(saveMemoryCandidate("a paraphrase of it", [{ sourceId: "message:dax-direct:m-dax-direct", revision: 1, startByte: 0, endByte: Buffer.byteLength("a paraphrase of it") }], "k-para", access("dax", "dax-direct")));
  disclose("b-dax", "closing-chat", [{ id: paraphrase, version: version(paraphrase) }], [], ["m-dax"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  database().prepare("UPDATE memory_records SET state='deleted' WHERE id=?").run(original);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
});

it("does not withhold a reply over the room's own superseded checkpoint (stale, not forgotten)", () => {
  reconcileMemoryRoster(roster);
  const db = database();
  const scope = String((db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key='closing-chat'").get() as { id: string }).id);
  const id = threadCheckpointId(scope, "closing-chat");
  const insert = db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,created_at) VALUES(?,?,?,'checkpoint','room so far','summary',?,0,1,1)");
  insert.run(id, 1, scope, "archived");
  insert.run(id, 2, scope, "active");
  disclose("b-dax", "closing-chat", [{ id, version: 1 }], [], ["m-dax"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  // another room's checkpoint in the same state is not this room's own
  const other = threadCheckpointId(scope, "another-room");
  insert.run(other, 1, scope, "archived");
  insert.run(other, 2, scope, "active");
  disclose("b-other", "closing-chat", [{ id: other, version: 1 }], [], ["m-finch"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-finch"]);
});

it("keeps owner text: only linked generated output is ever withheld", () => {
  const record = daxReplyWithOwnRecall();
  forgetMemory(ownerMemoryTicket(), { kind: "record", id: record });
  expect(roomReplayWithheld("closing-chat", transcript).has("m-owner")).toBe(false);
});

it("a channel person's pair room refuses the owner transcript and keeps the per-reader filter", () => {
  daxReplyWithOwnRecall();
  const db = database();
  const scope = String((db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation' AND owner_key='closing-chat'").get() as { id: string }).id);
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'human-thread',?,1,'granted',?)")
    .run("human-thread:closing-chat", scope, "closing-chat", JSON.stringify({ personId: "person-1", bindingId: "human-binding:x", revision: 1 }));
  expect(() => roomReplayWithheld("closing-chat", transcript)).toThrow("MEMORY_SCOPE_DENIED");
});

it("a turn that is not an owner audience keeps filterMemoryReplay: the revoked reply is dropped, with no withheld line", () => {
  daxReplyWithOwnRecall("revoked");
  const turn = roomTranscriptForTurn("closing-chat", transcript as Message[], false, access("finch", "closing-chat"));
  expect(turn.messages.map(m => m.id)).toEqual(["m-owner", "m-finch"]);
  expect(turn.withheld.size).toBe(0);
});

it("a room's per-reader filter drops what that reader may not see and marks nothing revoked", () => {
  daxReplyWithOwnRecall();
  // Finch may not read Dax's own-chat memory: the per-reader filter drops it
  expect(filterMemoryReplay("closing-chat", transcript, access("finch", "closing-chat"), { persist: false }).map(m => m.id)).toEqual(["m-owner", "m-finch"]);
  // but one reader's filter no longer revokes it for everyone after it
  expect(stateOf("b-dax")).toBe("delivered");
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
});

it("renders a withheld reply as a line with author and time, with nothing of it left to quote", () => {
  const at = Date.UTC(2026, 8, 27, 16, 47);
  const messages: Message[] = [
    { id: "m-dax", role: "bot", kind: "text", text: "the secret line", at, from: { botId: "dax", name: "Dax", color: "amber" } as Message["from"], replyToId: "m-owner" },
    { id: "m-owner2", role: "user", kind: "text", text: "thanks", at: at + 1, replyToId: "m-dax" },
  ];
  const shown = withholdRoomReplies(messages, new Set(["m-dax"]));
  expect(shown[0].text).toBe(`[${ROOM_REPLY_WITHHELD}] (Dax, 2026-09-27 16:47 UTC)`);
  expect(withheldRoomLine(messages[0])).toBe(shown[0].text);
  expect(shown[0].replyToId).toBeUndefined();
  expect(JSON.stringify(shown)).not.toContain("the secret line");
  expect(shown[1]).toBe(messages[1]);
  expect(ROOM_REPLY_WITHHELD).not.toMatch(/—|safe/i);
});

it("a direct chat's replay still persists what it found invalid, so a resumed session sees lineage-only invalidation", () => {
  daxReplyWithOwnRecall();
  expect(filterMemoryReplay("closing-chat", transcript, access("finch", "closing-chat")).map(m => m.id)).toEqual(["m-owner", "m-finch"]);
  expect(stateOf("b-dax")).toBe("revoked");
});

it("withholds a generated reply whose own captured source the owner forgot, never the owner's words", () => {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "message:closing-chat:m-dax", threadId: "closing-chat", messageId: "m-dax", kind: "text", speaker: "dax", outcome: "recorded", text: "the pin is 4471" });
  captureSource(database(), { id: "message:closing-chat:m-owner", threadId: "closing-chat", messageId: "m-owner", kind: "text", speaker: "owner", outcome: "recorded", text: "what is the pin?" });
  const roles = [{ id: "m-owner", role: "user" }, { id: "m-dax", role: "bot" }, { id: "m-finch", role: "bot" }];
  expect([...roomReplayWithheld("closing-chat", roles)]).toEqual([]);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:closing-chat:m-dax" });
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: "message:closing-chat:m-owner" });
  expect([...roomReplayWithheld("closing-chat", roles)]).toEqual(["m-dax"]);
});

it("withholds a reply that used a projection whose original the owner corrected, but not one that used the correction", () => {
  const original = daxMemory("the vendor is Acme", "src-original");
  const projection = daxMemory("the vendor is Acme (room copy)", "src-projection");
  database().prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,?,?,?)").run(original, version(original), projection, version(projection));
  disclose("b-dax", "closing-chat", [{ id: projection, version: version(projection) }], [], ["m-dax"]);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual([]);
  // the owner corrects the original: a new version that supersedes it
  const v = version(original);
  database().prepare("UPDATE memory_records SET state='superseded' WHERE id=? AND version=?").run(original, v);
  database().prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,owner_pinned,valid_from,supersedes_id,created_at) SELECT id,version+1,scope_id,kind,'the vendor is Bolt',assertion,'active',0,1,id,1 FROM memory_records WHERE id=? AND version=?").run(original, v);
  database().prepare("INSERT INTO memory_derivations(parent_id,parent_version,child_id,child_version) VALUES(?,?,?,?)").run(original, v, original, v + 1);
  expect([...roomReplayWithheld("closing-chat", transcript)]).toEqual(["m-dax"]);
  // a reply that used the corrected version itself stays
  disclose("b-finch", "closing-chat", [{ id: original, version: v + 1 }], [], ["m-finch"]);
  expect(roomReplayWithheld("closing-chat", transcript).has("m-finch")).toBe(false);
});
