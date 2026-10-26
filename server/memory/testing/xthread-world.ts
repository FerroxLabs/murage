// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test fixtures for XTHREAD-JUDGE (lanes/release104/designs/XTHREAD-JUDGE.md): one bot, a channel person with two conversations of the
// same bot (t1, t2), the owner's direct chat, an owner room and a channel person's room. A reply in t1 is made under a memory receipt; a
// record is extracted from it through the memory job queue; a roster or settings change flips the receipt (an audience-only revoke).
import { mkdirSync } from "node:fs";
import { DATA_DIR } from "../../config.ts";
import { closeDatabase, database } from "../../database.ts";
import { appendMessage, closeMessageDb } from "../../message-db.ts";
import type { Message } from "../../store.ts";
import { InternalCapabilities } from "../../internal-capabilities.ts";
import { linkHumanBinding, observeVerifiedHuman, resolveHumanBinding, bindHumanThread, type HumanPrincipal } from "../../human-principals.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "../policy.ts";
import { bindMemoryScope, ownerMemoryTicket } from "../authority.ts";
import { setMemoryCaptureRoster } from "../capture-scope.ts";
import { setMemoryMode } from "../repository.ts";
import { claimMemoryJob, publishMemoryWork } from "../jobs.ts";
import { captureWork } from "../chunks.ts";
import { linkMemoryDisclosureOutput } from "../disclosures.ts";
import { drainRevokeMarker } from "../memory-revocation.ts";
import type { MemorySearchBridge } from "../search.ts";
import { removeTempDirSync } from "../../testing/cleanup.ts";

export const SECRET = "The side gate code is GATE-7731.";
export const QUERY = "side gate code";

export const roster: MemoryRoster = {
  bots: [
    { id: "finch", threadId: "finch-direct", section: "Ops", tasks: [{ threadId: "t1" }, { threadId: "t2" }, { threadId: "t3" }, { threadId: "finch-group" }] },
    { id: "dax", threadId: "dax-direct", section: "Ops", tasks: [{ threadId: "dax-helper" }] },
  ],
  groups: [
    { id: "crew", threadId: "crew-chat", memberIds: ["finch"] },
    { id: "lobby", threadId: "lobby-chat", memberIds: ["finch"] },
  ],
};

/** The newest line of each thread, so a line is appended as an answer to the one before it (two bot lines with one parent are a
 * regenerate, which revokes the older one). */
const heads = new Map<string, string>();
/** Appends `message` after the thread's newest line. */
export function append(thread: string, message: Message): void {
  appendMessage(thread, { ...message, ...(heads.has(thread) && message.parentId === undefined ? { parentId: heads.get(thread) } : {}) });
  heads.set(thread, message.id);
}
/** A person's question and the bot's reply `id` (text `text`, default its id). */
export function exchange(thread: string, id: string, text = id): void {
  append(thread, person(`ask-${id}`, "what do you know about the side gate code?"));
  append(thread, bot(id, { text }));
}

export function resetWorld(): void {
  heads.clear();
  closeMessageDb(); closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryCaptureRoster(() => roster);
  reconcileMemoryRoster(roster);
  setMemoryMode("active");
}

export function access(botId: string, thread: string, options: { notOwnerAudience?: boolean; human?: HumanPrincipal } = {}): MemoryAccess {
  reconcileMemoryRoster(roster);
  const registry = new InternalCapabilities(); registry.begin(botId, thread, "g", options.human);
  const token = registry.mint({ botId, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false, ...(options.notOwnerAudience ? { notOwnerAudience: true as const } : {}), ...(options.human ? { humanPrincipal: options.human } : {}) });
  return memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
}

/** A channel person (a verified sender linked as a person, not the owner). */
export function channelPerson(userId = "ana"): HumanPrincipal {
  reconcileMemoryRoster(roster);
  const binding = observeVerifiedHuman({ platform: "slack", connectionId: "fixture", authorityId: "team", userId });
  linkHumanBinding(ownerMemoryTicket(), { bindingId: binding, expectedRevision: 1, as: "person" });
  return resolveHumanBinding(binding);
}
/** A WhatsApp group (its own audience: a group guest). */
export function groupGuest(): HumanPrincipal {
  reconcileMemoryRoster(roster);
  return resolveHumanBinding(observeVerifiedHuman({ platform: "whatsapp", connectionId: "fixture", authorityId: "wa", userId: "120363@g.us" }));
}

export const bot = (id: string, extra: Partial<Message> = {}): Message => ({ id, role: "bot", kind: "text", text: id, at: Date.now(), ...extra });
export const person = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", text, at: Date.now(), ...extra });

/** A delivered memory receipt on `thread`. */
export function receipt(bundleId: string, thread: string): void {
  const meta = database().prepare("SELECT policy_revision,deletion_epoch FROM memory_meta WHERE id=1").get()!;
  // each receipt in its own native session: a revoked receipt resets its session
  database().prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,'d',?,'[]','[]','[]',?,?,0,'delivered',?)")
    .run(bundleId, thread, `s-${bundleId}`, meta.policy_revision, meta.deletion_epoch, Date.now());
}
/** A reply made under receipt `bundleId`, its line row written and linked to the receipt. */
export function replyUnderReceipt(thread: string, ask: string, replyId: string, text: string, bundleId: string): void {
  receipt(bundleId, thread);
  append(thread, person(ask, "what is the side gate code?"));
  append(thread, bot(replyId, { text }));
  linkMemoryDisclosureOutput(bundleId, replyId);
}
/** A roster or settings change revokes the receipt (receipt-only: no data, policy or epoch change), and the marker commits it. */
export function flipReceipt(bundleId: string, drain = true): void {
  database().prepare("UPDATE memory_disclosures SET state='revoked' WHERE bundle_id=?").run(bundleId);
  if (drain) drainRevokeMarker(database());
}
/** The extraction jobs that are queued: leased now and published. */
export function runJobs(): void {
  for (let work = claimMemoryJob("xt-worker"); work; work = claimMemoryJob("xt-worker")) publishMemoryWork(work, "xt-worker", captureWork(work));
}
/** The record extracted from a captured message. */
export function recordFrom(thread: string, messageId: string): { id: string; version: number } {
  const row = database().prepare("SELECT r.id,r.version FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND r.kind='source'").get(`message:${thread}:${messageId}`);
  if (!row) throw new Error(`no record from ${thread}/${messageId}`);
  return { id: String(row.id), version: Number(row.version) };
}
export const hits = (ids: ReadonlyArray<{ id: string; version: number }>): MemorySearchBridge => ({ search: async () => ({ hits: ids.map(hit => ({ ...hit, score: 1, lexical: true })), vectorRows: 0, coverageComplete: true }) });

export interface World { person: HumanPrincipal; x: { id: string; version: number }; ownWords: { id: string; version: number } }
/** The design's fixture (XTHREAD-JUDGE T1). `flipFirst`: the receipt flips (and the marker commits) BEFORE the extraction job is leased
 * and published (the repro); otherwise the record is written while the reply is still shown to the person, and the test flips later. */
export function world(options: { flipFirst: boolean }): World {
  resetWorld();
  const who = channelPerson();
  for (const thread of ["t1", "t2", "t3", "lobby-chat"]) bindHumanThread(thread, who);
  reconcileMemoryRoster(roster);
  const conversation = ensureScope("conversation", "t1");
  // the owner's own surfaces read the person's conversation through owner grants (the owner sees what the bot told anyone)
  bindMemoryScope(ownerMemoryTicket(), conversation, "bot", "finch");
  bindMemoryScope(ownerMemoryTicket(), ensureScope("conversation", "t3"), "bot", "finch");
  bindMemoryScope(ownerMemoryTicket(), conversation, "room", "crew");
  // the person's room reads it through a share to the person
  database().prepare("INSERT INTO memory_scope_bindings VALUES('xt-share',?,'person',?,1,'granted','{}')").run(conversation, who.personId);
  replyUnderReceipt("t1", "a1", "g1", SECRET, "K");
  if (options.flipFirst) flipReceipt("K");
  runJobs();
  return { person: who, x: recordFrom("t1", "g1"), ownWords: recordFrom("t1", "a1") };
}
