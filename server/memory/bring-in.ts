// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bring in outside knowledge (0.1.61 lane M, plan 3.8; SPEC-P 11.3
// `project_bring_in`). A project member promotes something it already knows
// from its own chats into the project's memory, in one explicit step:
//  - the material must be the owner's: a memory record the bot reaches in its
//    own owner-audience scopes, or a message in one of its own chats, and
//    every thread it rests on must be the owner's (a channel person's thread,
//    and anything copied from one, is refused);
//  - owner-private continuity (identity records) never goes into a room;
//  - the copy is a new source in the room's scope, so every member can read
//    it, and it keeps its lineage: the source names what it was brought from
//    (payload.broughtFrom), and a record copy is derived from its original.
//    Forgetting the original forgets the copy (restore.ts
//    applyMemoryTombstones follows broughtFrom, and the derivation carries
//    record forgets).
// The text is the original's (or an exact excerpt of it), never the bot's
// paraphrase: what the room reads is what the owner's material says.
import { isLearnableSource } from "./learnable.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isWorkspaceOwner, threadHumanPrincipal } from "../human-principals.ts";
import { redactSecretsInText } from "../redact.ts";
import type { MemoryRoster } from "./policy.ts";
import { capturedMessageWithheld, messageCopy, messageSourceForgotten } from "./replay-lineage.ts";
import { scopeRow } from "./scope-id.ts";

export const BRING_IN_MAX_CHARS = 1000;

export type BringInInput = { recordId?: string; sourceMessageId?: string; threadId?: string; text?: string };
export type BringInResult = { ok: true; recordId: string } | { ok: false; status: 400 | 403 | 404 | 409; error: string };

const refuse = (status: 400 | 403 | 404 | 409, error: string): BringInResult => ({ ok: false, status, error });
const NOT_OWNERS = "Only the owner's own material can be brought into a project. This came from a conversation with someone else.";

function ownThreads(roster: MemoryRoster, botId: string): Set<string> {
  const bot = roster.bots.find(entry => entry.id === botId);
  return new Set(bot ? [bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)] : []);
}
function excludedThreads(db: DatabaseSync): Set<string> {
  return new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));
}
function scopeId(db: DatabaseSync, kind: string, owner: string): string | null {
  const row = scopeRow(db, kind, owner);
  return row ? String(row.id) : null;
}
function sourceRemoved(db: DatabaseSync, id: string, revision: number): boolean {
  const row = db.prepare("SELECT state, revision FROM memory_sources WHERE id=?").get(id);
  return !row || row.state !== "active" || Number(row.revision) !== revision
    || Boolean(db.prepare("SELECT 1 FROM memory_tombstones WHERE target_type='source' AND target_id=? AND (revision IS NULL OR revision=?)").get(id, revision));
}
/** A thread the owner's material may come from: the owner's, not left out of memory. */
function ownerThread(db: DatabaseSync, threadId: string, excluded: ReadonlySet<string>): boolean {
  return !excluded.has(threadId) && isWorkspaceOwner(threadHumanPrincipal(threadId, db));
}
/** A message copied from elsewhere must come, through every hop of its copy
 * chain, from the owner's own threads (0.1.61 lane M audit: one hop was not
 * enough; a contact's words relayed through a pair room into the bot's own
 * chat passed). A pair room (bot to bot) is never an owner source: an ask
 * mirrored there carries no provenance of its own. Past the hop or origin
 * budget of replay-lineage.ts the chain is not established, so it is refused. */
const COPY_HOPS = 4, COPY_ORIGINS = 64;
export function copiedFromOwner(db: DatabaseSync, roster: MemoryRoster, threadId: string, messageId: string, excluded: ReadonlySet<string>): boolean {
  const pairRooms = new Set(roster.groups.filter(group => group.dm).flatMap(group => [group.threadId, ...(group.tasks ?? []).map(task => task.threadId)]));
  let origins = 0;
  const walk = (thread: string, message: string, hop: number): boolean => {
    const copy = messageCopy(thread, message);
    if (!copy) return true;
    if (hop >= COPY_HOPS) return false;
    if (!ownerThread(db, copy.threadId, excluded) || pairRooms.has(copy.threadId)) return false;
    for (const origin of copy.messageIds) {
      if (++origins > COPY_ORIGINS) return false;
      if (!walk(copy.threadId, origin, hop + 1)) return false;
    }
    return true;
  };
  return !pairRooms.has(threadId) && walk(threadId, messageId, 0);
}

/** Promote owner material into room:<groupId>. The caller has checked that
 * the turn is the owner's audience and the bot a member of the project. */
export function bringInToProject(db: DatabaseSync, input: {
  groupId: string; roomThreadId: string; botId: string; roster: MemoryRoster; now: number; botInitiated?: boolean;
} & BringInInput): BringInResult {
  const mode = db.prepare("SELECT mode FROM memory_meta WHERE id=1").get()?.mode;
  if (mode === "off" || mode === "paused") return refuse(409, "Memory is off, so nothing can be brought in.");
  const excerpt = typeof input.text === "string" ? input.text.trim() : "";
  if (excerpt.length > BRING_IN_MAX_CHARS) return refuse(400, `The text is longer than ${BRING_IN_MAX_CHARS} characters.`);
  if (Boolean(input.recordId) === Boolean(input.sourceMessageId)) return refuse(400, "Name one thing to bring in: recordId or sourceMessageId.");
  const room = scopeId(db, "room", input.groupId);
  if (!room) return refuse(404, "This project has no memory yet.");
  const excluded = excludedThreads(db);
  const own = ownThreads(input.roster, input.botId);
  const bot = input.roster.bots.find(entry => entry.id === input.botId);
  if (!bot) return refuse(403, "You are not a bot in this workspace.");

  let original: string, from: { record?: { id: string; version: number }; sources: Array<{ id: string; revision: number }> };
  let kind = "fact";
  let origin: { threadId: string; messageId: string; speaker: string } | null = null;
  if (input.recordId) {
    const record = db.prepare("SELECT * FROM memory_records WHERE id=? AND state='active' ORDER BY version DESC LIMIT 1").get(input.recordId);
    if (!record) return refuse(404, "No such note in your memory.");
    if(input.botInitiated&&["source","checkpoint"].includes(String(record.kind)))return refuse(403,"Source and checkpoint records cannot be brought in as facts by a bot.");
    if (db.prepare("SELECT 1 FROM memory_record_details WHERE record_id=? AND record_version=? AND partition='identity'").get(record.id, record.version)) return refuse(403, "Private continuity stays out of projects.");
    if (String(record.scope_id) === room) return refuse(409, "That note is already in this project's memory.");
    // The scopes this bot reaches as itself, for the owner.
    const reachable = new Set([scopeId(db, "bot", input.botId), scopeId(db, "team", bot.section?.trim() || ""),
      ...[...own].filter(thread => ownerThread(db, thread, excluded)).map(thread => scopeId(db, "conversation", thread))].filter((id): id is string => Boolean(id)));
    if (!reachable.has(String(record.scope_id))) return refuse(403, "You can only bring in notes from your own memory.");
    // The note and every note it was derived from (an owner promotion carries
    // no evidence of its own): all of it must rest on the owner's material,
    // and a note with no sources anywhere up its chain is not established
    // (Astra r2 #18). Bounded like replay-lineage.ts.
    const chain = `WITH RECURSIVE chain(id,version) AS (SELECT ?,? UNION SELECT d.parent_id,d.parent_version FROM memory_derivations d JOIN chain c ON d.child_id=c.id AND d.child_version=c.version LIMIT 66)`;
    if (Number((db.prepare(`${chain} SELECT count(*) AS n FROM chain`).get(record.id, record.version) as { n: number }).n) > 64) return refuse(403, NOT_OWNERS);
    const evidence = db.prepare(`${chain} SELECT DISTINCT e.source_id, e.source_revision, s.thread_id, s.message_id FROM chain c JOIN memory_evidence e ON e.record_id=c.id AND e.record_version=c.version
      JOIN memory_sources s ON s.id=e.source_id LIMIT 257`).all(record.id, record.version) as Array<{ source_id: string; source_revision: number; thread_id: string | null; message_id: string | null }>;
    if (!evidence.length || evidence.length > 256) return refuse(403, "That note has no sources of its own to bring in.");
    for (const item of evidence) {
      if(input.botInitiated&&!isLearnableSource(db,item.source_id,Number(item.source_revision),{roster:input.roster}).learnable)return refuse(403,"This source is not eligible for learning. Ask the owner to review it.");
      if (sourceRemoved(db, item.source_id, Number(item.source_revision))) return refuse(409, "Part of that note was forgotten.");
      if (item.thread_id && (!ownerThread(db, item.thread_id, excluded) || input.roster.groups.some(group => group.dm && (group.threadId === item.thread_id || group.tasks?.some(task => task.threadId === item.thread_id))))) return refuse(403, NOT_OWNERS);
      if (item.thread_id && item.message_id && !copiedFromOwner(db, input.roster, item.thread_id, item.message_id, excluded)) return refuse(403, NOT_OWNERS);
    }
    original = String(record.text);
    kind = /^[a-z][a-z-]{0,31}$/.test(String(record.kind)) && !["checkpoint", "source"].includes(String(record.kind)) ? String(record.kind) : "fact";
    from = { record: { id: String(record.id), version: Number(record.version) }, sources: evidence.map(item => ({ id: item.source_id, revision: Number(item.source_revision) })) };
  } else {
    const threadId = input.threadId ?? bot.threadId;
    if (!own.has(threadId)) return refuse(403, "You can only bring in messages from your own chats.");
    if (!ownerThread(db, threadId, excluded)) return refuse(403, NOT_OWNERS);
    const message = db.prepare("SELECT text FROM messages WHERE thread_id=? AND id=? AND kind='text'").get(threadId, input.sourceMessageId!) as { text: string | null } | undefined;
    if (!message || !message.text?.trim()) return refuse(404, "No such message in that chat.");
    if (!copiedFromOwner(db, input.roster, threadId, input.sourceMessageId!, excluded)) return refuse(403, NOT_OWNERS);
    const sourceId = `message:${threadId}:${input.sourceMessageId}`;
    const source = db.prepare("SELECT revision, speaker FROM memory_sources WHERE id=? AND state='active'").get(sourceId);
    if (!source || messageSourceForgotten(threadId, input.sourceMessageId!) || capturedMessageWithheld(threadId, input.sourceMessageId!)) return refuse(409, "That message is not in memory, or was forgotten.");
    if(input.botInitiated&&!isLearnableSource(db,sourceId,Number(source.revision),{roster:input.roster}).learnable)return refuse(403,"This source is not eligible for learning. Ask the owner to review it.");
    original = message.text;
    from = { sources: [{ id: sourceId, revision: Number(source.revision) }] };
    // The copy's source names the original message (thread, id, speaker), so
    // the replay content rule judges it as that message: a reply withheld for
    // what it used withholds its copy too (recordRestsOnWithheldMessage), and
    // deleting that conversation deletes the copy (captureThreadDeletion).
    origin = { threadId, messageId: input.sourceMessageId!, speaker: String(source.speaker) };
  }
  // An excerpt must be the original's own words.
  const text = redactSecretsInText(excerpt ? excerpt : original.trim().slice(0, BRING_IN_MAX_CHARS));
  if (excerpt && !original.includes(excerpt)) return refuse(400, "The text must be an exact excerpt of what you bring in.");
  if (!text.trim()) return refuse(400, "Nothing to bring in.");

  const key = createHash("sha256").update(JSON.stringify([input.groupId, from, text])).digest("hex").slice(0, 32);
  const newSource = `bring-in:${input.groupId}:${key}`;
  const existing = db.prepare("SELECT r.id FROM memory_evidence e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND r.state='active' LIMIT 1").get(newSource);
  if (existing) return { ok: true, recordId: String(existing.id) };
  if (db.prepare("SELECT 1 FROM memory_sources WHERE id=?").get(newSource)) return refuse(409, "That was brought in before and has since been forgotten.");
  const payload = JSON.stringify({ text, kind: "bring-in", speaker: input.botId, outcome: "recorded", occurredAt: input.now, actorId: input.botId, broughtFrom: from });
  const hash = createHash("sha256").update(payload).digest("hex");
  const meta = db.prepare("SELECT policy_revision, deletion_epoch FROM memory_meta WHERE id=1").get()!;
  db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(newSource, room, origin?.threadId ?? input.roomThreadId, origin?.messageId ?? null, null, 1, hash, "bring-in", origin?.speaker ?? input.botId, "recorded", null, "active");
  db.prepare("INSERT INTO memory_source_versions VALUES(?,?,?,?,?)").run(newSource, 1, hash, payload, input.now);
  // no chunking: the brought-in note is the record below
  db.prepare("INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,cursor,policy_revision,deletion_epoch) VALUES(?,?,1,'capture','1','complete',?,?,?)")
    .run(randomUUID(), newSource, Buffer.byteLength(text), meta.policy_revision, meta.deletion_epoch);
  const recordId = randomUUID();
  db.prepare("INSERT INTO memory_records VALUES(?,1,?,?,?,'assistant-inference','active',0,?,NULL,NULL,?)").run(recordId, room, kind, text, input.now, input.now);
  db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,?)").run(recordId, newSource, Buffer.byteLength(text));
  if (from.record) db.prepare("INSERT INTO memory_derivations VALUES(?,?,?,1)").run(from.record.id, from.record.version, recordId);
  db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(recordId);
  db.exec("UPDATE memory_meta SET data_revision=data_revision+1 WHERE id=1");
  return { ok: true, recordId };
}
