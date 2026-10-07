import { partitionSourcesAllowed } from "./partition-sources.ts";
import { executionStore, sameThreadPartition } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane M's internal project tools (SPEC-P 11.3, plan 3.8 and 3.10), served
// at POST /api/internal/project/<name> through lane E1's routing
// (project-tool-routing.ts authorises the call: owner audience recomputed
// now, the bound request running, the caller's role from current rows):
//  - read-messages (member or lead): the room and the project's desk
//    threads, paged, plain text with speaker, "to" and "re" marks. Every
//    teammate reply stays reachable however long the room gets; a reply
//    withheld from bots reads as its withheld line.
//  - bring-in (member): owner material from the bot's own chats into the
//    project's memory (memory/bring-in.ts).
//  - summary-update (lead): the next version of the rolling summary, with
//    the room messages it rests on (derived provenance, SPEC-P 13.1).
//  - suggest (member): a line for the lead's next turn, never an
//    assignment.
import type { DatabaseSync } from "node:sqlite";
import { bringInToProject } from "./memory/bring-in.ts";
import { roomReplayWithheld } from "./memory/disclosures.ts";
import { capturedMessageWithheld, messageSourceForgotten } from "./memory/replay-lineage.ts";
import { copiedFromOwner } from "./memory/bring-in.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { markProjectDerivedStale } from "./project-tables.ts";
import { projectTableExists } from "./project-turn-engine.ts";
import { projectToolHandlers, type ProjectToolCallContext } from "./project-tool-routing.ts";
import { ROOM_REPLY_FORGOTTEN, ROOM_REPLY_WITHHELD } from "./room-context.ts";

export const READ_MESSAGES_MAX = 50;
const MESSAGE_CHARS = 4_000;
const PAGE_BYTES = 48_000;
export const SUMMARY_MAX_CHARS = 6_000;
export const SUMMARY_SOURCES_MAX = 500;
const SUMMARY_VERSIONS_KEPT = 20;
const SUGGESTIONS_KEPT = 20;

type Result = { status: number; body: unknown };
const bad = (error: string): Result => ({ status: 400, body: { error } });

/** The memory roster with bot names (store.bots, store.groups). */
export type NamedRoster = { bots: Array<MemoryRoster["bots"][number] & { name?: string }>; groups: MemoryRoster["groups"] };

export interface ProjectMemoryToolDeps {
  /** The live roster (store.bots, store.groups). */
  roster(): NamedRoster;
  /** A Murage line in the project's room (mirrorMurageLine). */
  note(groupId: string, text: string): void;
  /** Record on the consuming turn's receipt what a tool handed it (Astra r2 #16). */
  shown?(threadId: string, messages: ReadonlyArray<{ threadId: string; messageId: string }>): void;
}
let deps: ProjectMemoryToolDeps | null = null;

function strict(body: Record<string, unknown>, allowed: string[]): Result | null {
  const unknown = Object.keys(body).find(key => !allowed.includes(key));
  return unknown ? bad(`Unknown field: ${unknown}`) : null;
}

/** The threads that belong to the project: its room, its task threads and
 * its members' desk threads. */
export function projectThreads(roster: MemoryRoster, groupId: string): Set<string> {
  const group = roster.groups.find(entry => entry.id === groupId);
  if (!group) return new Set();
  const threads = new Set([group.threadId, ...(group.tasks ?? []).map(task => task.threadId)]);
  for (const bot of roster.bots) for (const task of bot.tasks ?? []) if (task.channelProjectDesk?.groupId === groupId) threads.add(task.threadId);
  return threads;
}

/** Each project thread's project (the first that holds it). */
function projectOfThreads(roster: MemoryRoster): Map<string, string> {
  const projectOf = new Map<string, string>();
  for (const group of roster.groups) {
    if (group.dm) continue;
    for (const threadId of projectThreads(roster, group.id)) if (!projectOf.has(threadId)) projectOf.set(threadId, group.id);
  }
  return projectOf;
}

/** Where forgotten messages were, for the lead's cards that cite no message
 * (project-tables.ts markProjectDerivedStale): the project whose thread held
 * each one (its room, a task thread, a member's desk) and when. The thread
 * is the caller's `threadId`, else the one memory captured it from; a
 * message no longer in its thread counts from the start. Each thread is
 * read once, however many of its messages were forgotten. */
export function projectMessagePlaces(db: DatabaseSync, input: {
  roster: MemoryRoster;
  messagesFor(threadId: string): ReadonlyArray<{ id: string; at: number }>;
  messageIds: readonly string[];
  threadId?: string;
}): Map<string, { groupId: string; at: number }> {
  const places = new Map<string, { groupId: string; at: number }>();
  if (!input.messageIds.length) return places;
  const byThread = new Map<string, string[]>();
  const add = (threadId: string, messageId: string) => byThread.set(threadId, [...(byThread.get(threadId) ?? []), messageId]);
  if (input.threadId) for (const id of new Set(input.messageIds)) add(input.threadId, id);
  else if (projectTableExists(db, "memory_sources")) {
    const placed = new Set<string>();
    for (const row of db.prepare("SELECT message_id, thread_id FROM memory_sources WHERE message_id IN (SELECT value FROM json_each(?)) AND thread_id IS NOT NULL")
      .all(JSON.stringify([...new Set(input.messageIds)])) as Array<{ message_id: string; thread_id: string }>) {
      if (placed.has(row.message_id)) continue;
      placed.add(row.message_id);
      add(row.thread_id, row.message_id);
    }
  }
  const projectOf = projectOfThreads(input.roster);
  for (const [threadId, ids] of byThread) {
    const groupId = projectOf.get(threadId);
    if (!groupId) continue;
    const at = new Map(input.messagesFor(threadId).map(message => [message.id, message.at] as const));
    for (const id of ids) places.set(id, { groupId, at: at.get(id) ?? 0 });
  }
  return places;
}

/** Deleting a project conversation (a task thread, a member's desk, or a
 * member with all its conversations) forgets its messages for the project
 * too (SPEC-P 15.3): text citing one of them, and the lead's cards that
 * cite no message made after its first, go stale. Read before the threads
 * are deleted (their messages and their project are gone after); the
 * returned step marks them once they are, and says how many rows it marked.
 * The step runs after the deletion, so it never fails it: a failure is
 * logged and marks nothing (round 12). Nor does the read: a thread whose
 * read fails is logged and left out, and the step marks what the other
 * threads' messages back (round 14). Each thread is read once, and the
 * threads' projects are worked out once per call (round 13). */
export function projectThreadDeletion(db: DatabaseSync, input: {
  roster: MemoryRoster;
  messagesFor(threadId: string): ReadonlyArray<{ id: string; at: number }>;
  threadIds: readonly string[];
}): () => number {
  const messageIds: string[] = [];
  const places = new Map<string, { groupId: string; at: number }>();
  const readFailed = (error: unknown) => console.warn(`[projects] the deleted conversation's messages could not be read for its project: ${error instanceof Error ? error.message : String(error)}`);
  let projectOf: Map<string, string>;
  try { projectOf = projectOfThreads(input.roster); } catch (error) { readFailed(error); return () => 0; }
  for (const threadId of new Set(input.threadIds)) {
    try {
      const messages = input.messagesFor(threadId);
      messageIds.push(...messages.map(message => message.id));
      const groupId = projectOf.get(threadId);
      if (groupId) for (const message of messages) places.set(message.id, { groupId, at: message.at });
    } catch (error) { readFailed(error); }
  }
  return () => {
    try { return markProjectDerivedStale(db, messageIds, id => places.get(id)); }
    catch (error) {
      console.warn(`[projects] the deleted conversation's project cards could not be marked stale: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };
}

type Row = { id: string; rowid: number; at: number; role: string; kind: string; text: string | null; json: string };

export function readProjectMessages(db: DatabaseSync, roster: NamedRoster, groupId: string, body: Record<string, unknown>, caller?: { botId: string; threadId: string }): Result {
  const refused = strict(body, ["threadId", "before", "limit"]);
  if (refused) return refused;
  const group = roster.groups.find(entry => entry.id === groupId);
  if (!group) return { status: 404, body: { error: "no such project" } };
  const threadId = body.threadId === undefined ? group.threadId : body.threadId;
  if (typeof threadId !== "string" || !projectThreads(roster, groupId).has(threadId)) return { status: 403, body: { error: "That conversation is not part of this project." } };
  const reader = caller && executionStore()?.bot(caller.botId);
  if (reader && !sameThreadPartition(reader, caller!.threadId, threadId)) return { status: 403, body: { error: "That conversation belongs to another team." } };
  const limit = body.limit === undefined ? 20 : body.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > READ_MESSAGES_MAX) return bad(`limit is 1 to ${READ_MESSAGES_MAX}`);
  let beforeRowid = Number.MAX_SAFE_INTEGER;
  if (body.before !== undefined) {
    if (typeof body.before !== "string") return bad("before is a message id");
    const anchor = db.prepare("SELECT rowid FROM messages WHERE thread_id=? AND id=?").get(threadId, body.before) as { rowid: number } | undefined;
    if (!anchor) return bad("before names no message of that conversation");
    beforeRowid = Number(anchor.rowid);
  }
  const rows = db.prepare(`SELECT rowid, id, at, role, kind, text, json FROM messages WHERE thread_id=? AND rowid<?
    AND (kind='text' OR (kind='activity' AND json_extract(json,'$.actorKind')='murage')) ORDER BY rowid DESC LIMIT ?`).all(threadId, beforeRowid, (limit as number) + 1) as Row[];
  const more = rows.length > (limit as number);
  const page = rows.slice(0, limit as number).reverse();
  // A reply that used something the owner removed, or that the owner forgot,
  // reads as its withheld line (room-context.ts), as in the transcript.
  let withheld: Set<string>;
  // with each copy's link, so a copy of a forgotten original is withheld too (Astra r2 #13)
  const copyOf = (row: Row) => { try { const copy = JSON.parse(row.json).copyOf; return copy && typeof copy.threadId === "string" && Array.isArray(copy.messageIds) ? { copyOf: { threadId: copy.threadId as string, messageIds: (copy.messageIds as unknown[]).filter((id): id is string => typeof id === "string") } } : {}; } catch { return {}; } };
  try { withheld = roomReplayWithheld(threadId, page.map(row => ({ id: row.id, role: row.role, ...copyOf(row) }))); }
  catch { return { status: 403, body: { error: "That conversation is not part of this project." } }; }
  const names = new Map(roster.bots.map(bot => [bot.id, bot.name ?? "a member"]));
  let bytes = 0;
  const messages: Array<{ id: string; speaker: string; to?: string[]; re?: string; at: number; text: string }> = [];
  for (const row of page.reverse()) {
    if (reader && !partitionSourcesAllowed(db, reader.id, caller!.threadId, [row.id])) continue;
    let message: { from?: { botId?: string; name?: string }; to?: string[]; replyToId?: string; actorKind?: string; withheldFromBots?: unknown; tool?: { name?: string } } = {};
    try { message = JSON.parse(row.json); } catch { /* the row's own columns still say who and what */ }
    const speaker = message.actorKind === "murage" ? "Murage" : row.role === "user" ? "Owner" : message.from?.name ?? (message.from?.botId ? names.get(message.from.botId) : undefined) ?? "a member";
    const hidden = row.role !== "user" && (withheld.has(row.id) || Boolean(message.withheldFromBots));
    const forgotten = hidden && (message.withheldFromBots === "forgotten" || messageSourceForgotten(threadId, row.id));
    const raw = hidden ? (forgotten ? ROOM_REPLY_FORGOTTEN : ROOM_REPLY_WITHHELD) : message.actorKind === "murage" ? String(message.tool?.name ?? row.text ?? "") : String(row.text ?? "");
    const text = raw.length > MESSAGE_CHARS ? `${raw.slice(0, MESSAGE_CHARS)} [cut]` : raw;
    bytes += Buffer.byteLength(text) + 200;
    if (bytes > PAGE_BYTES && messages.length) break;
    messages.push({ id: row.id, speaker, ...(message.to?.length ? { to: message.to.map(id => names.get(id) ?? "a member") } : {}), ...(message.replyToId && !hidden ? { re: message.replyToId } : {}), at: Number(row.at), text });
  }
  messages.reverse();
  const oldest = messages[0];
  return { status: 200, body: { ok: true, threadId, messages, ...(oldest && (more || messages.length < page.length) ? { before: oldest.id } : {}) } };
}

export function updateProjectSummary(db: DatabaseSync, roster: MemoryRoster, context: Pick<ProjectToolCallContext, "groupId" | "botId" | "now"> & { request?: Pick<ProjectToolCallContext["request"], "targetThreadId" | "rootThreadId"> }, body: Record<string, unknown>): Result {
  const refused = strict(body, ["text", "sourceMessageIds"]);
  if (refused) return refused;
  if (typeof body.text !== "string" || !body.text.trim() || body.text.length > SUMMARY_MAX_CHARS) return bad(`text is 1 to ${SUMMARY_MAX_CHARS} characters`);
  const ids = body.sourceMessageIds;
  // A summary names what it rests on (derived provenance, SPEC-P 13.1), so
  // forgetting any of it makes the summary stale (Astra r1 #8).
  if (!Array.isArray(ids) || !ids.length || ids.length > SUMMARY_SOURCES_MAX || ids.some(id => typeof id !== "string" || !id || id.length > 200)) return bad(`sourceMessageIds is 1 to ${SUMMARY_SOURCES_MAX} ids of the project messages the summary rests on`);
  const consuming = context.request?.targetThreadId ?? context.request?.rootThreadId;
  if (consuming && !partitionSourcesAllowed(db, context.botId, consuming, ids as string[])) return { status: 403, body: { error: "Those sources belong to another team." } };
  const threads = [...projectThreads(roster, context.groupId)];
  const found = new Map<string, string>();
  for (const id of ids as string[]) {
    const row = db.prepare("SELECT thread_id, json FROM messages WHERE id=? AND thread_id IN (SELECT value FROM json_each(?))").get(id, JSON.stringify(threads)) as { thread_id: string; json: string } | undefined;
    if (row) found.set(id, row.thread_id);
  }
  const unknown = (ids as string[]).filter(id => !found.has(id));
  if (unknown.length) return bad(`These are not messages of this project: ${unknown.slice(0, 5).join(", ")}`);
  // nothing forgotten or withheld from bots may be cited back into view
  const hidden = [...found].filter(([id, thread]) => {
    const row = db.prepare("SELECT role, json_extract(json,'$.withheldFromBots') AS withheld FROM messages WHERE id=? AND thread_id=?").get(id, thread) as { role: string; withheld: unknown } | undefined;
    return messageSourceForgotten(thread, id) || Boolean(row?.withheld) || (row?.role !== "user" && capturedMessageWithheld(thread, id));
  }).map(([id]) => id);
  if (hidden.length) return { status: 409, body: { error: "not_allowed", reason: `These messages were forgotten or are withheld from bots: ${hidden.slice(0, 5).join(", ")}` } };
  // only the owner's own material, through every copy hop (Astra r2 #14)
  const excluded = new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));
  const foreign = [...found].filter(([id, thread]) => excluded.has(thread) || !isWorkspaceOwner(threadHumanPrincipal(thread, db)) || !copiedFromOwner(db, roster, thread, id, excluded)).map(([id]) => id);
  if (foreign.length) return { status: 403, body: { error: `Only the owner's own conversation can back a summary: ${foreign.slice(0, 5).join(", ")}` } };
  if (!projectTableExists(db, "project_summaries")) return { status: 409, body: { error: "not_allowed", reason: "This project has no summary yet." } };
  // A rolling summary rewrites the last one, so it keeps resting on what that
  // one rested on (newest first within the bound).
  const previous = db.prepare("SELECT source_message_ids FROM project_summaries WHERE group_id=? AND stale=0 ORDER BY version DESC LIMIT 1").get(context.groupId) as { source_message_ids: string } | undefined;
  let carried: string[] = [];
  try { const parsed = previous ? JSON.parse(previous.source_message_ids) : []; carried = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []; } catch { carried = []; }
  const sources = [...new Set([...(ids as string[]), ...carried])];
  if (consuming && !partitionSourcesAllowed(db, context.botId, consuming, sources)) return { status: 403, body: { error: "Those sources belong to another team." } };
  // never silently drop what an older version rested on (Astra r2 #8)
  if (sources.length > SUMMARY_SOURCES_MAX) return { status: 409, body: { error: "not_allowed", reason: `The summary would rest on more than ${SUMMARY_SOURCES_MAX} messages. Keep the current summary; Murage's board summary covers the rest.` } };
  const version = Number((db.prepare("SELECT max(version) AS v FROM project_summaries WHERE group_id=?").get(context.groupId) as { v: number | null }).v ?? 0) + 1;
  db.prepare("INSERT INTO project_summaries(group_id, version, text, source_message_ids, made_by, at, stale) VALUES(?,?,?,?,?,?,0)")
    .run(context.groupId, version, body.text.trim(), JSON.stringify(sources), context.botId, context.now);
  db.prepare("DELETE FROM project_summaries WHERE group_id=? AND version<=?").run(context.groupId, version - SUMMARY_VERSIONS_KEPT);
  return { status: 200, body: { ok: true, version } };
}

// ── suggestions: a line for the lead's next turn, kept in memory ─────────────
// A restart drops them (SPEC-P 2 ephemeral state): a suggestion is advice,
// and the member can make it again.
export interface ProjectSuggestion { from: string; botId: string; cardNumber?: number; why: string; at: number }
const suggestions = new Map<string, ProjectSuggestion[]>();

export function suggestToLead(db: DatabaseSync, context: Pick<ProjectToolCallContext, "groupId" | "botId" | "memberIds" | "now">, body: Record<string, unknown>): Result {
  const refused = strict(body, ["cardId", "botId", "why"]);
  if (refused) return refused;
  if (typeof body.botId !== "string" || !context.memberIds.includes(body.botId)) return bad("botId must be a member of this project");
  if (typeof body.why !== "string" || !body.why.trim() || body.why.length > 200) return bad("why is 1 to 200 characters");
  let cardNumber: number | undefined;
  if (body.cardId !== undefined) {
    if (typeof body.cardId !== "string" || !projectTableExists(db, "project_work_items")) return bad("no such card in this project");
    const card = db.prepare("SELECT number FROM project_work_items WHERE id=? AND group_id=?").get(body.cardId, context.groupId) as { number: number } | undefined;
    if (!card) return bad("no such card in this project");
    cardNumber = Number(card.number);
  }
  const list = suggestions.get(context.groupId) ?? [];
  list.push({ from: context.botId, botId: body.botId, ...(cardNumber !== undefined ? { cardNumber } : {}), why: body.why.trim(), at: context.now });
  suggestions.set(context.groupId, list.slice(-SUGGESTIONS_KEPT));
  return { status: 200, body: { ok: true } };
}

/** The suggestions waiting for the lead (not removed). */
export function pendingProjectSuggestions(groupId: string): readonly ProjectSuggestion[] {
  return suggestions.get(groupId) ?? [];
}
/** The lead's turn that carried them was accepted: they are delivered. */
export function deliveredProjectSuggestions(groupId: string, upTo: number): void {
  const left = (suggestions.get(groupId) ?? []).filter(item => item.at > upTo);
  if (left.length) suggestions.set(groupId, left); else suggestions.delete(groupId);
}
/** The lines for the lead's project status (quoted as data). */
export function suggestionLines(groupId: string, names: ReadonlyMap<string, string>): string {
  const list = pendingProjectSuggestions(groupId);
  if (!list.length) return "";
  const who = (id: string) => names.get(id) ?? "a member";
  return ["Suggestions from members (advice for you to weigh; nobody is assigned by them):",
    ...list.map(item => `- ${who(item.from)} suggests ${who(item.botId)}${item.cardNumber !== undefined ? ` for card #${item.cardNumber}` : ""}: ${JSON.stringify(item.why).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}`)].join("\n");
}

/** Register lane M's handlers by name (SPEC-P 16). */
export function registerProjectMemoryTools(dependencies: ProjectMemoryToolDeps): void {
  deps = dependencies;
  projectToolHandlers.set("read-messages", (call, body) => {
    const result = readProjectMessages(call.db, deps!.roster(), call.groupId, body, {botId:call.botId,threadId:call.request.targetThreadId ?? call.request.rootThreadId});
    const page = result.body as { threadId?: string; messages?: Array<{ id: string }> };
    // a reply built from what the tool returned rests on it (Astra r2 #16)
    if (result.status === 200 && page.threadId && page.messages?.length) deps!.shown?.(call.request.targetThreadId ?? call.request.rootThreadId, page.messages.map(message => ({ threadId: page.threadId!, messageId: message.id })));
    return result;
  });
  projectToolHandlers.set("summary-update", (call, body) => updateProjectSummary(call.db, deps!.roster(), call, body));
  projectToolHandlers.set("suggest", (call, body) => suggestToLead(call.db, call, body));
  projectToolHandlers.set("bring-in", (call, body) => {
    const refused = strict(body, ["recordId", "sourceMessageId", "threadId", "text"]);
    if (refused) return refused;
    for (const key of ["recordId", "sourceMessageId", "threadId", "text"] as const) if (body[key] !== undefined && typeof body[key] !== "string") return bad(`${key} must be text`);
    const roster = deps!.roster();
    const group = roster.groups.find(entry => entry.id === call.groupId);
    if (!group) return { status: 404, body: { error: "no such project" } };
    const caller = executionStore()?.bot(call.botId), consuming = call.request.targetThreadId ?? call.request.rootThreadId;
    const evidence = typeof body.recordId === "string" ? call.db.prepare("SELECT s.message_id FROM memory_evidence e JOIN memory_sources s ON s.id=e.source_id WHERE e.record_id=?").all(body.recordId).map(row => String(row.message_id)) : typeof body.sourceMessageId === "string" ? [body.sourceMessageId] : [];
    if (caller?.partitionedAt !== undefined && (typeof body.threadId === "string" && !sameThreadPartition(caller, consuming, body.threadId) || !evidence.length || !partitionSourcesAllowed(call.db, call.botId, consuming, evidence))) return { status: 403, body: { error: "Those sources belong to another team." } };
    const result = bringInToProject(call.db, { groupId: call.groupId, roomThreadId: group.threadId, botId: call.botId, roster, now: call.now, botInitiated: true,
      recordId: body.recordId as string | undefined, sourceMessageId: body.sourceMessageId as string | undefined, threadId: body.threadId as string | undefined, text: body.text as string | undefined });
    if (!result.ok) return { status: result.status, body: { error: result.error } };
    const name = roster.bots.find(bot => bot.id === call.botId)?.name ?? "A member";
    deps!.note(call.groupId, `${name} brought a note into this project's memory.`);
    return { status: 200, body: { ok: true, recordId: result.recordId } };
  });
}
