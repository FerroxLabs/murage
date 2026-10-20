import { partitionSourcesAllowed } from "./partition-sources.ts";
import { botRows, botViewer, type BotRow, type Viewer } from "./bot-read.ts";
import type { Message } from "./store.ts";
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
import { redactSecretsInText } from "./redact.ts";
import { roomReplayWithheld } from "./memory/disclosures.ts";
import { capturedMessageWithheld, LineageAllowance, messageSourceForgotten } from "./memory/replay-lineage.ts";
import { copiedFromOwner } from "./memory/bring-in.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { markProjectDerivedStale, projectCitedMessageIds } from "./project-tables.ts";
import { projectTableExists } from "./project-turn-engine.ts";
import { projectToolHandlers, type ProjectToolCallContext } from "./project-tool-routing.ts";
import { ROOM_REPLY_CHECKING, ROOM_REPLY_FORGOTTEN, ROOM_REPLY_WITHHELD } from "./room-context.ts";
import { currentTurnLineage } from "./memory/lineage-write.ts";
import type { LineageRef, PromptPart, ToolText } from "./memory/lineage-types.ts";
import { lineRefs, murageObjectRef, promptPart, recordTurnObject, turnRefs, turnToolText, memoryRefs, noneRef } from "./memory/prompt-parts.ts";

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
  /** The lines whose words a tool handed `botId`'s running turn in `threadId` (a line read as its withheld line handed over none): they join
   * that turn's sources (server/steer-lineage.ts addSourcesToRunningTurn). Owner lines are marked, as they are never sources. */
  read?(threadId: string, botId: string, lines: ReadonlyArray<{ threadId: string; id: string; role: "user" | "bot" }>): void;
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
 * message no longer in its thread counts from the start. Each message is
 * read by its key; a thread is never read. */
export function projectMessagePlaces(db: DatabaseSync, input: {
  roster: MemoryRoster;
  /** When a message was written (Store.messageById), by its key; undefined when it is no longer in its thread. */
  messageAt(threadId: string, messageId: string): number | undefined;
  messageIds: readonly string[];
  threadId?: string;
  /** Thread of each message the caller already knows (forget reads it from the source rows): those are never looked up by message id alone, which has no index. */
  threadOf?: ReadonlyMap<string, string>;
}): Map<string, { groupId: string; at: number }> {
  const places = new Map<string, { groupId: string; at: number }>();
  if (!input.messageIds.length) return places;
  const byThread = new Map<string, string[]>();
  const add = (threadId: string, messageId: string) => byThread.set(threadId, [...(byThread.get(threadId) ?? []), messageId]);
  if (input.threadId) for (const id of new Set(input.messageIds)) add(input.threadId, id);
  else if (projectTableExists(db, "memory_sources")) {
    const placed = new Set<string>();
    for (const id of new Set(input.messageIds)) { const known = input.threadOf?.get(id); if (known) { placed.add(id); add(known, id); } }
    const unknown = [...new Set(input.messageIds)].filter(id => !placed.has(id));
    for (const row of (unknown.length ? db.prepare("SELECT message_id, thread_id FROM memory_sources WHERE message_id IN (SELECT value FROM json_each(?)) AND thread_id IS NOT NULL")
      .all(JSON.stringify(unknown)) : []) as Array<{ message_id: string; thread_id: string }>) {
      if (placed.has(row.message_id)) continue;
      placed.add(row.message_id);
      add(row.thread_id, row.message_id);
    }
  }
  const projectOf = projectOfThreads(input.roster);
  for (const [threadId, ids] of byThread) {
    const groupId = projectOf.get(threadId);
    if (!groupId) continue;
    for (const id of ids) places.set(id, { groupId, at: input.messageAt(threadId, id) ?? 0 });
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
  /** The first message of a thread (Store.firstRow), for where its project's forgotten messages begin. */
  firstAt(threadId: string): number | undefined;
  /** Whether a message is one of this thread's, by its key (Store.messageById). */
  hasMessage(threadId: string, messageId: string): boolean;
  threadIds: readonly string[];
}): () => number {
  const forgotten = new Set<string>();
  const places: Array<{ groupId: string; at: number }> = [];
  const readFailed = (error: unknown) => console.warn(`[projects] the deleted conversation's messages could not be read for its project: ${error instanceof Error ? error.message : String(error)}`);
  let projectOf: Map<string, string>;
  let cited: Set<string>;
  try { projectOf = projectOfThreads(input.roster); cited = projectCitedMessageIds(db); } catch (error) { readFailed(error); return () => 0; }
  for (const threadId of new Set(input.threadIds)) {
    try {
      // the messages this conversation held that project text cites, found by key; and where its project's forgotten messages begin
      for (const id of cited) if (input.hasMessage(threadId, id)) forgotten.add(id);
      const groupId = projectOf.get(threadId), first = input.firstAt(threadId);
      if (groupId && first !== undefined) places.push({ groupId, at: first });
    } catch (error) { readFailed(error); }
  }
  return () => {
    try { return markProjectDerivedStale(db, { has: id => forgotten.has(id), places: () => places }); }
    catch (error) {
      console.warn(`[projects] the deleted conversation's project cards could not be marked stale: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  };
}

type Row = { id: string; rowid: number; at: number; role: string; kind: string; text: string | null; json: string };

/** Who reads a project page: a bot (its id and the thread of the turn reading) or the owner, named explicitly by OWNER_PAGE. */
export type ProjectPageReader = { readonly botId: string; readonly threadId: string } | typeof OWNER_PAGE;
/** The owner's own view of a project page: the owner route through the reader door (LINEAGE-DESIGN-S6 18e). */
export const OWNER_PAGE: { readonly owner: true } = Object.freeze({ owner: true });
// the one human viewer literal of this file (bot-read.test.ts 18e, project-page-door.test.ts)
const ownerPageViewer = (): Viewer => ({ kind: "human" });

export function readProjectMessages(db: DatabaseSync, roster: NamedRoster, groupId: string, body: Record<string, unknown>, caller: ProjectPageReader): Result {
  return readProjectPage(db, roster, groupId, body, caller).result;
}

/** One page of a project conversation, with the lines whose words it shows (the withheld lines show only their withheld line). The
 * lines it shows are what a reply built from the page rests on: write-time hole 1 (DESIGN-WRITETIME 2.2), see the read-messages handler. */
export function readProjectPage(db: DatabaseSync, roster: NamedRoster, groupId: string, body: Record<string, unknown>, caller: ProjectPageReader): { result: Result; threadId?: string; shown: string[] } {
  const shown: string[] = [];
  const result = readProjectPageWork(db, roster, groupId, body, caller, shown);
  const threadId = (result.body as { threadId?: unknown } | null)?.threadId;
  return { result, ...(result.status === 200 && typeof threadId === "string" ? { threadId, shown } : { shown: [] }) };
}

function readProjectPageWork(db: DatabaseSync, roster: NamedRoster, groupId: string, body: Record<string, unknown>, caller: ProjectPageReader, shown: string[]): Result {
  const refused = strict(body, ["threadId", "before", "limit"]);
  if (refused) return refused;
  const group = roster.groups.find(entry => entry.id === groupId);
  if (!group) return { status: 404, body: { error: "no such project" } };
  const threadId = body.threadId === undefined ? group.threadId : body.threadId;
  if (typeof threadId !== "string" || !projectThreads(roster, groupId).has(threadId)) return { status: 403, body: { error: "That conversation is not part of this project." } };
  // fail closed: a bot reads only as a bot on the roster now; with no record (removed, or no store) it reads no line
  const bot = "owner" in caller ? undefined : caller;
  const reader = bot && executionStore()?.bot(bot.botId);
  if (bot && !reader) return { status: 403, body: { error: "That reader is not on the team." } };
  if (bot && reader && !sameThreadPartition(reader, bot.threadId, threadId)) return { status: 403, body: { error: "That conversation belongs to another team." } };
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
    AND kind='text' ORDER BY rowid DESC LIMIT ?`).all(threadId, beforeRowid, (limit as number) + 1) as Row[];
  const more = rows.length > (limit as number);
  const page = rows.slice(0, limit as number).reverse();
  // A reply that used something the owner removed, or that the owner forgot,
  // reads as its withheld line (room-context.ts), as in the transcript.
  let withheld: Set<string>;
  const checking = new Set<string>();
  // with each copy's link, so a copy of a forgotten original is withheld too (Astra r2 #13)
  const copyOf = (row: Row) => { try { const copy = JSON.parse(row.json).copyOf; return copy && typeof copy.threadId === "string" && Array.isArray(copy.messageIds) ? { copyOf: { threadId: copy.threadId as string, messageIds: (copy.messageIds as unknown[]).filter((id): id is string => typeof id === "string") } } : {}; } catch { return {}; } };
  try { withheld = roomReplayWithheld(LineageAllowance.tool(), threadId, page.map(row => ({ id: row.id, role: row.role, ...copyOf(row) })), checking); }
  catch { return { status: 403, body: { error: "That conversation is not part of this project." } }; }
  const names = new Map(roster.bots.map(bot => [bot.id, bot.name ?? "a member"]));
  // A bot reads the page through the reader door (bot-read.ts): a Murage-voice row never, a line the lineage withholds never. Every row is
  // judged there, a hidden one included (no stand-in passes unjudged): a hidden row the door admits shows only Murage's fixed withheld copy.
  const asMessage = (row: Row): Message => { let stored: Partial<Message> = {}; try { stored = JSON.parse(row.json); } catch { /* columns only */ } return { ...stored, id: row.id, role: row.role, kind: row.kind, text: row.text ?? undefined, at: Number(row.at) } as Message; };
  // every line below is built from the door's BotRow for this viewer (rule 18b): its words, its speaker; a row the door left out is not shown
  const viewer = bot && reader ? botViewer(reader.id) : ownerPageViewer();
  const lines = new Map<string, BotRow>(botRows(db, viewer, threadId, page.map(asMessage)).map(line => [line.id, line]));
  let bytes = 0;
  const messages: Array<{ id: string; speaker: string; to?: string[]; re?: string; at: number; text: string }> = [];
  for (const row of page.reverse()) {
    if (bot && reader && !partitionSourcesAllowed(db, reader.id, bot.threadId, [row.id], { threads: [threadId], only: true })) continue;
    const line = lines.get(row.id);
    if (!line) continue;
    let message: { to?: string[]; replyToId?: string; withheldFromBots?: unknown } = {};
    try { message = JSON.parse(row.json); } catch { /* the row's own columns still say who and what */ }
    const speaker = line.role === "user" ? "Owner" : line.speaker?.name ?? (line.speaker ? names.get(line.speaker.id) : undefined) ?? "a member";
    // for a bot every role: an owner line the owner forgot reads as its withheld line too, never its words; the owner's own page keeps
    // showing the owner's lines as written
    // (a "checking" left on disk is no note: the live verdicts above decide, never a stored "checking")
    const noted = Boolean(message.withheldFromBots) && message.withheldFromBots !== "checking";
    const hidden = (bot !== undefined || line.role !== "user") && (withheld.has(row.id) || noted);
    const forgotten = hidden && (message.withheldFromBots === "forgotten" || messageSourceForgotten(threadId, row.id));
    // a hidden line reads as Murage's fixed withheld copy (it is a stand-in); any other line reads as the BotRow's words
    const raw = hidden ? (forgotten ? ROOM_REPLY_FORGOTTEN : checking.has(row.id) ? ROOM_REPLY_CHECKING : ROOM_REPLY_WITHHELD) : line.text;
    const text = raw.length > MESSAGE_CHARS ? `${raw.slice(0, MESSAGE_CHARS)} [cut]` : raw;
    bytes += Buffer.byteLength(text) + 200;
    if (bytes > PAGE_BYTES && messages.length) break;
    if (!hidden) shown.push(row.id);
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
  const allowance = LineageAllowance.tool();
  const hidden = [...found].filter(([id, thread]) => {
    const row = db.prepare("SELECT role, json_extract(json,'$.withheldFromBots') AS withheld FROM messages WHERE id=? AND thread_id=?").get(id, thread) as { role: string; withheld: unknown } | undefined;
    return messageSourceForgotten(thread, id) || (Boolean(row?.withheld) && row?.withheld !== "checking") || (row?.role !== "user" && capturedMessageWithheld(allowance, thread, id));
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
  // Every member's prompt carries this summary, so a key the lead copied into
  // it is masked before it is stored, the way captured memory is.
  db.prepare("INSERT INTO project_summaries(group_id, version, text, source_message_ids, made_by, at, stale) VALUES(?,?,?,?,?,?,0)")
    .run(context.groupId, version, redactSecretsInText(body.text.trim()), JSON.stringify(sources), context.botId, context.now);
  // the summary is the lead's own words, written in its turn: it rests on that turn (DESIGN-WRITETIME 2.5)
  recordTurnObject(db, consuming, murageObjectRef("project-summary", `${context.groupId}:${version}`));
  db.prepare("DELETE FROM project_summaries WHERE group_id=? AND version<=?").run(context.groupId, version - SUMMARY_VERSIONS_KEPT);
  return { status: 200, body: { ok: true, version } };
}

// ── suggestions: a line for the lead's next turn, kept in memory ─────────────
// A restart drops them (SPEC-P 2 ephemeral state): a suggestion is advice,
// and the member can make it again.
export interface ProjectSuggestion { from: string; botId: string; cardNumber?: number; why: string; at: number; /** the member's turn it was made in */ lineageOf?: readonly LineageRef[] }
const suggestions = new Map<string, ProjectSuggestion[]>();

export function suggestToLead(db: DatabaseSync, context: Pick<ProjectToolCallContext, "groupId" | "botId" | "memberIds" | "now"> & { consumingThreadId?: string }, body: Record<string, unknown>): Result {
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
  const lineageOf = turnRefs(context.consumingThreadId ? currentTurnLineage(context.consumingThreadId) : undefined);
  list.push({ from: context.botId, botId: body.botId, ...(cardNumber !== undefined ? { cardNumber } : {}), why: body.why.trim(), at: context.now, ...(lineageOf.length ? { lineageOf } : {}) });
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
    const consuming = call.request.targetThreadId ?? call.request.rootThreadId;
    const read = readProjectPage(call.db, deps!.roster(), call.groupId, body, { botId: call.botId, threadId: consuming });
    const { result } = read;
    const page = result.body as { threadId?: string; messages?: Array<{ id: string }> };
    // a reply built from what the tool returned rests on it (Astra r2 #16)
    if (result.status === 200 && page.threadId && page.messages?.length) deps!.shown?.(consuming, page.messages.map(message => ({ threadId: page.threadId!, messageId: message.id })));
    // and the turn's sources: a note it writes next rests on every line whose words it read
    const lines = (result.body as { messages?: Array<{ id: string; speaker: string; text: string }> }).messages?.filter(message => message.text !== ROOM_REPLY_WITHHELD && message.text !== ROOM_REPLY_FORGOTTEN) ?? [];
    if (result.status === 200 && page.threadId && lines.length) deps!.read?.(consuming, call.botId, lines.map(message => ({ threadId: page.threadId!, id: message.id, role: message.speaker === "Owner" ? "user" as const : "bot" as const })));
    // write-time hole 1: the lines whose words the page shows join the running turn as point carries (a withheld line shows no words)
    return toolResult(result, readMessagesToolText(consuming, read));
  });
  projectToolHandlers.set("summary-update", (call, body) => updateProjectSummary(call.db, deps!.roster(), call, body));
  projectToolHandlers.set("suggest", (call, body) => suggestToLead(call.db, { ...call, consumingThreadId: call.request.targetThreadId ?? call.request.rootThreadId }, body));
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
    // write-time hole 2: what is brought in joins the running turn, and the copy rests on that turn (memory/bring-in.ts)
    const result = bringInToProject(call.db, { groupId: call.groupId, roomThreadId: group.threadId, botId: call.botId, roster, now: call.now, botInitiated: true, turn: currentTurnLineage(consuming),
      recordId: body.recordId as string | undefined, sourceMessageId: body.sourceMessageId as string | undefined, threadId: body.threadId as string | undefined, text: body.text as string | undefined });
    if (!result.ok) return { status: result.status, body: { error: result.error } };
    const name = roster.bots.find(bot => bot.id === call.botId)?.name ?? "A member";
    deps!.note(call.groupId, `${name} brought a note into this project's memory.`);
    return { status: 200, body: { ok: true, recordId: result.recordId } };
  });
}

// ── write-time lineage of the tools' results (DESIGN-WRITETIME 2.2) ──────────

/** ProjectToolHandler (project-tool-routing.ts) still returns {status, body}: the result is made as a ToolText first, so what it rests on
 * joins the running turn, and its body goes back as before. API CHANGE NEEDED (project-tool-routing.ts): the handler type should return
 * the ToolText itself. */
function toolResult(result: Result, text: ToolText): Result {
  void text;
  return result;
}

/** The read-messages result as a tool text: point carries for every line whose words it shows. */
export function readMessagesToolText(consumingThreadId: string, read: { result: Result; threadId?: string; shown: readonly string[] }): ToolText {
  const refs: LineageRef[] = read.threadId && read.shown.length ? lineRefs(read.threadId, read.shown) : [noneRef("murage")];
  return turnToolText(consumingThreadId, JSON.stringify(read.result.body), refs);
}

/** What a project summary rests on when a prompt quotes it: the summary itself (the lead wrote it in a turn) and the lines it cites. */
export function projectSummaryRefs(groupId: string, version: number, sources: ReadonlyArray<{ threadId: string; messageId: string }>): LineageRef[] {
  const byThread = new Map<string, string[]>();
  for (const source of sources) byThread.set(source.threadId, [...(byThread.get(source.threadId) ?? []), source.messageId]);
  return [...memoryRefs([murageObjectRef("project-summary", `${groupId}:${version}`)]), ...[...byThread].flatMap(([thread, ids]) => lineRefs(thread, ids))];
}

/** The suggestions waiting for the lead, as a prompt part: each rests on the turn of the member that made it. */
export function suggestionPart(groupId: string, names: ReadonlyMap<string, string>): PromptPart {
  return promptPart(suggestionLines(groupId, names), pendingProjectSuggestions(groupId).flatMap(item => item.lineageOf ?? []));
}
