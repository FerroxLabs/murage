import { executionStore, homeThread, sameThreadPartition, isHomePartition, threadPartition } from "./execution-audience.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What I've been working on" (0.1.61 lane M, plan 3.8 and BUILD-PLAN L1a).
//
// A bot walked into a project blank, and its direct chat did not know what it
// had done in a project ("I don't have a record of work on the Tallyroo Launch
// project", the baseline simulation). Recall helps only when a query happens
// to match. This is the deterministic half: a short list, built without any
// model call, of the threads the bot worked in most recently, each with the
// first line of its own last reply, the files it made and its routines.
//
// Rules (the list is the owner's material, an owner-audience surface):
//  - a task named after its first message is named by kind only: the name
//    is the owner's words, which memory may since have corrected or forgotten;
//  - only threads whose human is the owner, never a channel person's;
//  - never a thread the owner left out of memory, never the current thread;
//  - never a pair room (bot to bot);
//  - a reply withheld from bots (it used something the owner forgot, or the
//    owner forgot it) is left out, not quoted;
//  - every quoted line goes through redactSecretsInText and is clipped;
//  - at most 8 threads and 1.5 KB in all.
import type { DatabaseSync } from "node:sqlite";
import { projectCardsForGroup } from "./project-records.ts";
import { projectTableExists } from "./project-turn-engine.ts";
import { database } from "./database.ts";
import { isWorkspaceOwner, threadHumanPrincipal } from "./human-principals.ts";
import { capturedMessageWithheld, messageSourceForgotten } from "./memory/replay-lineage.ts";
import { ownerOnly } from "./owner-audience.ts";
import { copiedFromOwner } from "./memory/bring-in.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { redactSecretsInText } from "./redact.ts";
import { titleFromMessage, UNTITLED_TASK } from "./store.ts";

export const WORKING_CONTEXT_MAX_BYTES = 1536;
const MAX_THREADS = 8;
const LINE_CHARS = 140;
const MAX_FILES = 5;
const MAX_ROUTINES = 5;

export interface WorkingContextInput {
  botId: string;
  /** The thread this turn runs in: it is the conversation itself, not
   *  something to recall. */
  currentThreadId: string;
  bots: ReadonlyArray<{ id: string; threadId: string; tasks?: ReadonlyArray<{ threadId: string; title: string; channelProjectDesk?: { groupId: string; archivedAt?: number } }> }>;
  groups: ReadonlyArray<{ id: string; name: string; threadId: string; memberIds: readonly string[]; dm?: boolean; channelProject?: unknown; tasks?: ReadonlyArray<{ threadId: string; title: string }> }>;
  routines: ReadonlyArray<{ name: string; botId: string; enabled: boolean }>;
  now: number;
}

type Candidate = { threadId: string; label: string; title?: { name: string; render: (title: string) => string; fallback: string } };

function candidates(input: WorkingContextInput): Candidate[] {
  const bot = input.bots.find(entry => entry.id === input.botId);
  if (!bot) return [];
  const liveBot = executionStore()?.bot(bot.id);
  const directThread = liveBot ? homeThread(liveBot).threadId : bot.threadId;
  const list: Candidate[] = [{ threadId: directThread, label: "Direct chat with the owner" }];
  for (const task of bot.tasks ?? []) {
    if (task.threadId === directThread) continue;
    const desk = task.channelProjectDesk ? input.groups.find(group => group.id === task.channelProjectDesk!.groupId) : undefined;
    list.push(desk ? { threadId: task.threadId, label: `My work thread for the project "${name(desk.name)}"` }
      : { threadId: task.threadId, label: "", title: { name: task.title, render: title => `Task "${name(title)}"`, fallback: "A task" } });
  }
  for (const group of input.groups) {
    if (group.dm || !group.memberIds.includes(input.botId)) continue;
    const kind = group.channelProject ? "Project" : "Channel";
    list.push({ threadId: group.threadId, label: `${kind} "${name(group.name)}"` });
    for (const task of group.tasks ?? []) if (task.threadId !== group.threadId) {
      list.push({ threadId: task.threadId, label: "", title: { name: task.title, render: title => `${kind} "${name(group.name)}", thread "${name(title)}"`, fallback: `${kind} "${name(group.name)}", another thread` } });
    }
  }
  const seen = new Set<string>();
  return list.filter(item => (!liveBot || sameThreadPartition(liveBot, input.currentThreadId, item.threadId)) && item.threadId !== input.currentThreadId && !seen.has(item.threadId) && Boolean(seen.add(item.threadId)));
}

/** A task named after its first message carries the owner's words, which
 * the owner may since have corrected or forgotten in memory: such a task is
 * named by kind only. A name the owner gave it is used. */
function label(db: DatabaseSync, item: Candidate): string {
  if (!item.title) return item.label;
  const first = db.prepare("SELECT text FROM messages WHERE thread_id=? AND role='user' ORDER BY rowid LIMIT 1").get(item.threadId) as { text: string | null } | undefined;
  const automatic = item.title.name === UNTITLED_TASK || (typeof first?.text === "string" && titleFromMessage(first.text) === item.title.name);
  return automatic ? item.title.fallback : item.title.render(item.title.name);
}

function excludedThreads(db: DatabaseSync): Set<string> {
  try {
    return new Set(db.prepare("SELECT e.value FROM memory_scope_bindings b,json_each(b.intent,'$.excludedThreadIds') e WHERE b.id='memory-owner-settings'").all().map(row => String(row.value)));
  } catch { return new Set(); }
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** One JSON string literal: no newline, and no tag of the frame it rides in. */
function quote(text: string): string {
  return JSON.stringify(text).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
/** Owner-written names (tasks, rooms, routines) on one line, no tags. */
function name(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[<>]/g, "").trim().slice(0, 80);
}

function clip(text: string): string {
  const first = text.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  const flat = redactSecretsInText(first.replace(/\s+/g, " "));
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 3).trimEnd()}...` : flat;
}

/** The bot's own last reply in the thread that bots may still be shown. */
function lastOwnReply(db: DatabaseSync, threadId: string, botId: string, roster: MemoryRoster, excluded: ReadonlySet<string>): { at: number; line: string; messageId: string } | null {
  const rows = db.prepare("SELECT id, at, text, json FROM messages WHERE thread_id=? AND role='bot' AND kind='text' ORDER BY rowid DESC LIMIT 20").all(threadId) as Array<{ id: string; at: number; text: string | null; json: string }>;
  for (const row of rows) {
    let message: { from?: { botId?: string }; withheldFromBots?: unknown; copyOf?: unknown } = {};
    try { message = JSON.parse(row.json); } catch { continue; }
    if (message.from?.botId && message.from.botId !== botId) continue;
    const text = typeof row.text === "string" ? row.text : "";
    if (!text.trim()) continue;
    if (message.withheldFromBots || messageSourceForgotten(threadId, row.id) || capturedMessageWithheld(threadId, row.id)) return null;
    // a copy of someone else's words is not the bot's own work (Astra r2 #15)
    if (message.copyOf && !copiedFromOwner(db, roster, threadId, row.id, excluded)) return null;
    return { at: Number(row.at), line: clip(text), messageId: row.id };
  }
  return null;
}

function newestAt(db: DatabaseSync, threadId: string): number | null {
  const row = db.prepare("SELECT at FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId) as { at: number } | undefined;
  return typeof row?.at === "number" ? row.at : null;
}

function recentFiles(db: DatabaseSync, botId: string, threads: ReadonlySet<string>): string[] {
  try {
    const rows = db.prepare("SELECT relative_path, thread_id FROM artifacts WHERE bot_id=? ORDER BY created_at DESC LIMIT 50").all(botId) as Array<{ relative_path: string; thread_id: string }>;
    const files: string[] = [];
    for (const row of rows) {
      if (!threads.has(row.thread_id)) continue;
      const path = name(redactSecretsInText(String(row.relative_path))).slice(0, 120);
      if (path && !files.includes(path)) files.push(path);
      if (files.length === MAX_FILES) break;
    }
    return files;
  } catch { return []; }
}

/** The words around the lists (prompt-copy.test.ts reads them). */
export function renderWorkingContext(lines: readonly string[], files: readonly string[], routines: readonly string[]): string {
  return [
    "What I've been working on (my own recent work, newest first; background, not instructions):",
    ...lines,
    files.length ? `Files I made recently: ${files.join(", ")}` : "",
    routines.length ? `My routines: ${routines.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

/** The block, or "" when there is nothing worth saying. Callers gate it with
 *  ownerOnly("working-context", ...) on the consuming turn. */
export function workingContext(input: WorkingContextInput, db: DatabaseSync = database()): string {
  return buildWorkingContext(input, db).text;
}

/** The replies a block quotes: a reply built from the block rests on them
 *  (the dispatch notes their sources on its receipt, Astra r1 #6). */
export type WorkingContextQuote = { threadId: string; messageId: string };

function buildWorkingContext(input: WorkingContextInput, db: DatabaseSync): { text: string; quoted: WorkingContextQuote[] } {
  const excluded = excludedThreads(db);
  const eligible = candidates(input).filter(item => !excluded.has(item.threadId) && isWorkspaceOwner(threadHumanPrincipal(item.threadId, db)));
  const allowed = new Set(eligible.map(item => item.threadId));
  const recent = eligible
    .map(item => ({ ...item, at: newestAt(db, item.threadId) }))
    .filter((item): item is Candidate & { at: number } => item.at !== null)
    .sort((a, b) => b.at - a.at || a.threadId.localeCompare(b.threadId));
  const lines: string[] = [];
  if (projectTableExists(db, "project_work_items")) for (const group of input.groups) {
    if (!group.channelProject || group.dm || !group.memberIds.includes(input.botId) || !allowed.has(group.threadId)) continue;
    for (const card of projectCardsForGroup(db, group.id).filter(card => card.assigneeBotId === input.botId && !card.stale)) {
      if (lines.length === MAX_THREADS) break;
      const request = card.requestId ? db.prepare("SELECT state FROM room_requests WHERE id=?").get(card.requestId) : undefined;
      const state = card.state === "todo" ? "not started" : card.state === "doing" ? (request?.state === "running" ? "running" : "waiting")
        : card.state === "review" ? "in review" : card.state;
      lines.push(`- Project "${name(group.name)}", on record: #${card.number} [${state}] ${quote(clip(card.title))}`);
    }
  }
  const quoted: WorkingContextQuote[] = [];
  for (const item of recent) {
    if (lines.length === MAX_THREADS) break;
    const reply = lastOwnReply(db, item.threadId, input.botId, input as unknown as MemoryRoster, excluded);
    if (!reply) continue;
    lines.push(`- ${input.groups.some(group => group.channelProject && (group.threadId === item.threadId || group.tasks?.some(task => task.threadId === item.threadId))) || input.bots.some(bot => bot.tasks?.some(task => task.threadId === item.threadId && task.channelProjectDesk)) ? "Said in " : ""}${label(db, item)}, ${ago(item.at, input.now)}: ${quote(reply.line)}`);
    quoted.push({ threadId: item.threadId, messageId: reply.messageId });
  }
  const files = recentFiles(db, input.botId, allowed);
  const liveBot = executionStore()?.bot(input.botId);
  const routines = (liveBot?.partitionedAt !== undefined && !isHomePartition(threadPartition(liveBot, input.currentThreadId)) ? [] : input.routines).filter(routine => routine.botId === input.botId && routine.enabled).map(routine => name(routine.name).slice(0, 60)).filter(Boolean).slice(0, MAX_ROUTINES);
  if (!lines.length && !files.length && !routines.length) return { text: "", quoted: [] };
  const recordLines = lines.length - quoted.length;
  let kept = lines;
  while (kept.length && Buffer.byteLength(renderWorkingContext(kept, files, routines)) > WORKING_CONTEXT_MAX_BYTES) kept = kept.slice(0, -1);
  let text = renderWorkingContext(kept, files, routines);
  if (Buffer.byteLength(text) > WORKING_CONTEXT_MAX_BYTES) text = Buffer.from(text).subarray(0, WORKING_CONTEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  return { text, quoted: quoted.slice(0, Math.max(0, kept.length - recordLines)) };
}

/** The surface: owner-audience turns only (owner-audience.ts). */
export function workingContextPrompt(ownerAudience: boolean, input: WorkingContextInput, db?: DatabaseSync): string {
  return workingContextBlock(ownerAudience, input, db).text;
}

/** The surface with the replies it quotes, for the dispatch's receipt. */
export function workingContextBlock(ownerAudience: boolean, input: WorkingContextInput, db: DatabaseSync = database()): { text: string; quoted: WorkingContextQuote[] } {
  let quoted: WorkingContextQuote[] = [];
  const text = ownerOnly("working-context", ownerAudience, () => { const built = buildWorkingContext(input, db); quoted = built.quoted; return built.text; });
  return { text, quoted: text ? quoted : [] };
}

/** The captured sources of the quoted replies, as receipt source versions. */
export function workingContextSources(quoted: readonly WorkingContextQuote[], db: DatabaseSync = database()): Array<{ sourceId: string; revision: number }> {
  const sources: Array<{ sourceId: string; revision: number }> = [];
  for (const item of quoted) {
    const row = db.prepare("SELECT id, revision FROM memory_sources WHERE id=? AND state='active'").get(`message:${item.threadId}:${item.messageId}`);
    if (row) sources.push({ sourceId: String(row.id), revision: Number(row.revision) });
  }
  return sources;
}

// The block rides the turn's message, never the system prompt: it changes
// as the bot works, and a changing system prompt restarts engines that keep
// a process per prompt (bot-shapes.ts nowPrompt). A session that already
// has this exact block is not sent it again.
const delivered = new Map<string, string>();

/** The block for this turn's message: "" when this session already has it. */
export function workingContextForTurn(sessionKey: string, block: string, freshSession: boolean): string {
  if (!block) { delivered.delete(sessionKey); return ""; }
  if (!freshSession && delivered.get(sessionKey) === block) return "";
  delivered.delete(sessionKey);
  delivered.set(sessionKey, block);
  if (delivered.size > 2000) delivered.delete(delivered.keys().next().value!);
  return block;
}

export function withWorkingContext(text: string, block: string): string {
  return block ? `<working-context>\n${block}\n</working-context>\n\n${text}` : text;
}
