// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 0.1.61 room privacy fix, gap 3: a room turn started by words nobody proved are the
// owner's (a script, a bot's own shell) is not an owner audience. The transcript fix
// gated the transcript; its recall still carried the member's bot and team
// memory. Memory now reads such a turn like a stranger in the owner's room:
// the room and its conversation, nothing private, and none of the replies
// its transcript leaves out.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database } from "./database.ts";
import { InternalCapabilities } from "./internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./memory/policy.ts";
import { captureSource } from "./memory/capture.ts";
import { claimMemoryJob, publishMemoryWork } from "./memory/jobs.ts";
import { captureWork } from "./memory/chunks.ts";
import { saveMemoryCandidate } from "./memory/authority.ts";
import { assertMemoryBundle, buildMemoryBundle, hydrateMemoryRecord } from "./memory/bundle.ts";
import { type MemorySearchBridge } from "./memory/search.ts";
import { memoryAgentRoute } from "./memory/routes.ts";
import { readerWithheldMessage } from "./memory/disclosures.ts";
import { roomTranscriptForTurn } from "./room-transcript.ts";
import type { Message } from "./store.ts";

const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Dev Shop" },
    { id: "dax", threadId: "dax-direct", section: "Operations" },
  ],
  groups: [{ id: "closing", threadId: "closing-chat", memberIds: ["finch", "dax"] }],
};
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

function access(botId: string, thread: string, notOwnerAudience = false) {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g");
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}
const scopeOf = (kind: string, owner: string) => (database().prepare("SELECT id FROM memory_scopes WHERE kind=? AND owner_key=?").get(kind, owner) as { id: string } | undefined)?.id;
const version = (id: string) => (database().prepare("SELECT max(version) AS version FROM memory_records WHERE id=?").get(id) as { version: number }).version;
function publishCaptures() {
  for (let work = claimMemoryJob("t2-worker"); work; work = claimMemoryJob("t2-worker")) publishMemoryWork(work, "t2-worker", captureWork(work));
}
/** A record in Dax's own bot memory, learned in his direct chat. */
function daxPrivate(text = "The vault code is VAULT-5521.") {
  reconcileMemoryRoster(roster);
  captureSource(database(), { id: "src-dax", threadId: "dax-direct", kind: "text", speaker: "owner", outcome: "recorded", text });
  const record = saveMemoryCandidate(text, [{ sourceId: "src-dax", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-dax", access("dax", "dax-direct"));
  // bot memory: the record and its evidence live in Dax's bot scope
  database().prepare("UPDATE memory_records SET state='active',scope_id=? WHERE id=?").run(scopeOf("bot", "dax")!, record);
  database().prepare("UPDATE memory_sources SET scope_id=? WHERE id='src-dax'").run(scopeOf("bot", "dax")!);
  return record;
}
const hits = (ids: Array<{ id: string; version: number }>): MemorySearchBridge => ({ search: async () => ({ hits: ids.map(hit => ({ ...hit, score: 1, lexical: true })), vectorRows: 0, coverageComplete: true }) });

it("an unproven room turn reads no bot, team or owner-shared memory", async () => {
  const record = daxPrivate();
  const owner = access("dax", "closing-chat");
  expect(owner.scopeIds).toContain(scopeOf("bot", "dax"));
  expect(owner.scopeIds).toContain(scopeOf("team", "Operations"));
  const unproven = access("dax", "closing-chat", true);
  expect(unproven.scopeIds).not.toContain(scopeOf("bot", "dax"));
  expect(unproven.scopeIds).not.toContain(scopeOf("team", "Operations"));
  expect(unproven.scopeIds).toContain(scopeOf("room", "closing"));
  expect(hydrateMemoryRecord(record, version(record), owner).text).toContain("VAULT-5521");
  expect(() => hydrateMemoryRecord(record, version(record), unproven)).toThrow("MEMORY_SCOPE_DENIED");
  const bridge = hits([{ id: record, version: version(record) }]);
  expect((await buildMemoryBundle("vault code", owner, bridge)).text).toContain("VAULT-5521");
  expect((await buildMemoryBundle("vault code", unproven, bridge)).text).not.toContain("VAULT-5521");
});

it("an owner pin in the bot's memory does not reach an unproven room turn", async () => {
  const record = daxPrivate("Always sign as Dax from Operations, code VAULT-5521.");
  database().prepare("UPDATE memory_records SET owner_pinned=1 WHERE id=?").run(record);
  const empty = hits([]);
  expect((await buildMemoryBundle("", access("dax", "closing-chat"), empty)).text).toContain("VAULT-5521");
  expect((await buildMemoryBundle("", access("dax", "closing-chat", true), empty)).text).not.toContain("VAULT-5521");
});

it("an unproven room turn does not recall an owner-audience reply its transcript leaves out", async () => {
  const record = daxPrivate();
  // Dax answered the owner in the room from his own memory; the answer is
  // captured into the room's conversation memory.
  const a = access("dax", "dax-direct");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b-dax','closing-chat','fake',NULL,?,'[]','[\"m-dax\"]',?,?,10,'delivered',?)")
    .run(JSON.stringify([{ id: record, version: version(record) }]), a.policyRevision, a.deletionEpoch, Date.now());
  captureSource(database(), { id: "message:closing-chat:m-dax", threadId: "closing-chat", messageId: "m-dax", kind: "text", speaker: "dax", outcome: "recorded", text: "The code you asked for is VAULT-5521." });
  publishCaptures();
  const chunk = database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id='message:closing-chat:m-dax' AND r.kind='source'").get() as { id: string; version: number };
  const transcript = [{ id: "m-owner", role: "user", kind: "text", text: "code?" }, { id: "m-dax", role: "bot", kind: "text", text: "The code you asked for is VAULT-5521." }] as Message[];

  // the owner's own turn reads the reply and can recall it
  const owner = access("finch", "closing-chat");
  expect(readerWithheldMessage(owner)).toBeUndefined();
  expect(roomTranscriptForTurn("closing-chat", transcript, true, owner).messages.map(m => m.text)).toContain("The code you asked for is VAULT-5521.");
  expect((await buildMemoryBundle("code", owner, hits([chunk]))).text).toContain("VAULT-5521");

  // an unproven turn's transcript leaves the reply out, and so does its recall
  const unproven = access("finch", "closing-chat", true);
  expect(roomTranscriptForTurn("closing-chat", transcript, false, unproven).messages.map(m => m.id)).toEqual(["m-owner"]);
  const withheld = readerWithheldMessage(unproven)!;
  expect(withheld("closing-chat", "m-dax")).toBe(true);
  expect(withheld("closing-chat", "m-owner")).toBe(false);
  expect((await buildMemoryBundle("code", unproven, hits([chunk]), { withheldMessage: withheld })).text).not.toContain("VAULT-5521");
  // memory search and get through the bot's own memory tools too
  const searched = await memoryAgentRoute("/api/internal/memory/search", { query: "code" }, unproven, hits([chunk])) as { hits: Array<{ id: string }> };
  expect(searched.hits.map(hit => hit.id)).not.toContain(chunk.id);
  await expect(memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: chunk.id, version: chunk.version }] }, unproven, hits([]))).rejects.toThrow("MEMORY_EVIDENCE_UNAVAILABLE");
  const own = await memoryAgentRoute("/api/internal/memory/get", { handles: [{ id: chunk.id, version: chunk.version }] }, owner, hits([])) as { records: Array<{ text: string }> };
  expect(own.records[0].text).toContain("VAULT-5521");
});

// 0.1.61 third fix round, Astra P1 audit #1: what a reader that is not the
// owner may see can change while recall waits (a receipt revoked without a
// policy change). The pin resting on that reply is checked again after the
// wait and again at dispatch, with a fresh verdict.
function roomReplyPin() {
  reconcileMemoryRoster(roster);
  const a = access("finch", "closing-chat");
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('b-fin','closing-chat','fake',NULL,'[]','[]','[\"m-fin\"]',?,?,10,'delivered',?)")
    .run(a.policyRevision, a.deletionEpoch, Date.now());
  const text = "Finch confirmed the vendor call is on Friday.";
  captureSource(database(), { id: "message:closing-chat:m-fin", threadId: "closing-chat", messageId: "m-fin", kind: "text", speaker: "finch", outcome: "recorded", text });
  publishCaptures();
  const pin = saveMemoryCandidate("The vendor call is on Friday.", [{ sourceId: "message:closing-chat:m-fin", revision: 1, startByte: 0, endByte: Buffer.byteLength(text) }], "k-pin-fin", a);
  database().prepare("UPDATE memory_records SET state='active',owner_pinned=1 WHERE id=?").run(pin);
  return pin;
}
const revokeFinch = () => database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id='b-fin'").run();

it("a pin whose reply an unproven reader stops seeing while recall waits is left out", async () => {
  const pin = roomReplyPin();
  const reader = access("dax", "closing-chat", true);
  const before = await buildMemoryBundle("vendor", reader, hits([]), { withheldMessage: readerWithheldMessage(reader) });
  expect(before.text).toContain("Friday");
  const during: MemorySearchBridge = { search: async () => { revokeFinch(); return { hits: [], vectorRows: 0, coverageComplete: true }; } };
  const bundle = await buildMemoryBundle("vendor", reader, during, { withheldMessage: readerWithheldMessage(reader) });
  expect(bundle.text).not.toContain("Friday");
  expect(bundle.withheldPins).toEqual([{ id: pin, version: version(pin) }]);
});

it("a pin whose reply an unproven reader stops seeing before dispatch refuses that dispatch", async () => {
  roomReplyPin();
  const reader = access("dax", "closing-chat", true);
  const bundle = await buildMemoryBundle("vendor", reader, hits([]), { withheldMessage: readerWithheldMessage(reader) });
  expect(bundle.text).toContain("Friday");
  assertMemoryBundle(bundle, reader);
  revokeFinch();
  expect(() => assertMemoryBundle(bundle, reader)).toThrow("MEMORY_CONTEXT_REVOKED");
});
