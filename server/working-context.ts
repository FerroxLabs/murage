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
//
// Cost (1.0.2 turnctx): a turn pays for what changed and for the few lines it
// shows, never for the history.
//  - Nothing at all on a scheduled or webhook run: the block is for a turn
//    with the owner (bot-shapes.ts says "Only when it is talking with you").
//  - Only DISCOVERY is kept, per bot and current thread: which of the bot's
//    threads are its most recent (at most MAX_CONSIDERED) and which message in
//    each is its last reply. It is brought up to date from the threads that
//    changed (thread-activity.ts), and found again by one bounded read when
//    the inputs moved or TURN_CACHE_MS passed.
//  - Nothing that decides whether a line may be SHOWN is kept. Every build
//    asks afresh, for each line it is about to show (at most MAX_CONSIDERED):
//    is the thread still the bot's and in this conversation's partition, not
//    left out of memory, the owner's; does the reply still exist, still the
//    bot's, not withheld from bots, with the words it has now; and does the
//    lineage judge (whose own cache follows every dirty key) still let bots
//    see it. A verdict the judge could not prove is not shown and not kept:
//    the next turn asks again. So a change to a message, to memory or to a
//    room's scope is seen on the next turn, whatever path made it.
import { botViewer, doorReader, rowsShown } from "./bot-read.ts";
import { isMurageVoice } from "./murage-voice.ts";
import type { DatabaseSync } from "node:sqlite";
import { projectTableExists } from "./project-turn-engine.ts";
import { database } from "./database.ts";
import { isWorkspaceOwner, threadHumanPrincipal, withBindingScope } from "./human-principals.ts";
import { capturedMessageVerdict, messageSourceForgotten, type LineageAllowance } from "./memory/replay-lineage.ts";
import { ownerOnly } from "./owner-audience.ts";
import { copiedFromOwner } from "./memory/bring-in.ts";
import type { MemoryRoster } from "./memory/policy.ts";
import { redactSecretsInText } from "./redact.ts";
import { titleFromMessage, UNTITLED_TASK, type Message } from "./store.ts";
import { threadActivitySeq, threadsChangedSince } from "./thread-activity.ts";
import { ioBudget } from "./io-budget.ts";
import type { LineageReader, LineageRef, LineageVerdict, PromptPart } from "./memory/lineage-types.ts";
import { fileRef, lineRefs, memoryRefs, murageObjectRef, noneRef, promptPart } from "./memory/prompt-parts.ts";
import { denyLookup, memoryLookup } from "./memory/deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./memory/lineage-types.ts";

export const WORKING_CONTEXT_MAX_BYTES = 1536;
const MAX_THREADS = 8;
const LINE_CHARS = 140;
const MAX_FILES = 5;
const MAX_ROUTINES = 5;
/** The most recent threads a build looks at for its lines (some have no reply of the bot's that may be quoted). */
const MAX_CONSIDERED = 24;
/** Messages a first build reads newest first to find them, at most. */
const RECENT_SCAN_ROWS = 4000;
/** A bot with at most this many threads has each one's newest message read when the scan found too few. */
const SMALL_CANDIDATES = 64;
/** What was discovered is found again at least this often (a thread whose newest message predates a room join). */
const TURN_CACHE_MS = 10 * 60_000;
/** Kept discoveries, per bot and current thread, least recently used dropped first. */
const MAX_KEPT = 512;


type TaskLike = { threadId: string; title: string; channelProjectDesk?: { groupId: string; archivedAt?: number } };
export interface WorkingContextInput {
  botId: string;
  /** The thread this turn runs in: it is the conversation itself, not
   *  something to recall. */
  currentThreadId: string;
  bots: ReadonlyArray<{ id: string; threadId: string; tasks?: ReadonlyArray<TaskLike> }>;
  groups: ReadonlyArray<{ id: string; name: string; threadId: string; memberIds: readonly string[]; dm?: boolean; channelProject?: unknown; tasks?: ReadonlyArray<{ threadId: string; title: string }> }>;
  /** The bot's routines, or a function that lists them: a function is called only when the block is built
   *  (never on a scheduled or webhook run). */
  routines: ReadonlyArray<{ name: string; botId: string; enabled: boolean }> | (() => ReadonlyArray<{ name: string; botId: string; enabled: boolean }>);
  now: number;
  /** What started the turn (the routine trigger): a scheduled or webhook run gets no block and does no work for it. */
  trigger?: string;
}

type Candidate = { threadId: string; label: string; title?: { name: string; render: (title: string) => string; fallback: string } };

/** A task list by thread id, built once per list. The store replaces a bot's or room's task list when a task is
 *  added or removed, so a list that is still the same object holds the same threads; the length check catches a
 *  list grown in place. The task objects are the live ones: a title or desk read through it is current. */
const taskIndexes = new WeakMap<object, { length: number; byThread: Map<string, TaskLike> }>();
const NO_TASKS: ReadonlyMap<string, TaskLike> = new Map();
function taskIndex(tasks: ReadonlyArray<TaskLike> | undefined): ReadonlyMap<string, TaskLike> {
  if (!tasks?.length) return NO_TASKS;
  const known = taskIndexes.get(tasks);
  if (known && known.length === tasks.length) return known.byThread;
  const byThread = new Map<string, TaskLike>();
  for (const task of tasks) if (!byThread.has(task.threadId)) byThread.set(task.threadId, task);
  taskIndexes.set(tasks, { length: tasks.length, byThread });
  return byThread;
}

type LiveBot = NonNullable<ReturnType<NonNullable<ReturnType<typeof executionStore>>["bot"]>>;
/** Who the block is for: the bot as the input names it, its live record and its direct chat. */
type Subject = { bot: WorkingContextInput["bots"][number]; liveBot: LiveBot | undefined; directThread: string };
function subject(input: WorkingContextInput): Subject | undefined {
  const bot = input.bots.find(entry => entry.id === input.botId);
  if (!bot) return undefined;
  const liveBot = executionStore()?.bot(bot.id) ?? undefined;
  return { bot, liveBot, directThread: liveBot ? homeThread(liveBot).threadId : bot.threadId };
}

/** What `threadId` is to the bot right now, read from the live input: its direct chat, one of its tasks, or a room
 *  it is a member of (or one of that room's threads). Undefined when it is none of these. */
function candidateFor(input: WorkingContextInput, who: Subject, threadId: string): Candidate | undefined {
  if (threadId === who.directThread) return { threadId, label: "Direct chat with the owner" };
  const task = taskIndex(who.bot.tasks).get(threadId);
  if (task) {
    const desk = task.channelProjectDesk ? input.groups.find(group => group.id === task.channelProjectDesk!.groupId) : undefined;
    return desk ? { threadId, label: `My work thread for the project "${name(desk.name)}"` }
      : { threadId, label: "", title: { name: task.title, render: title => `Task "${name(title)}"`, fallback: "A task" } };
  }
  for (const group of input.groups) {
    if (group.dm || !group.memberIds.includes(input.botId)) continue;
    const kind = group.channelProject ? "Project" : "Channel";
    if (group.threadId === threadId) return { threadId, label: `${kind} "${name(group.name)}"` };
    const roomTask = taskIndex(group.tasks).get(threadId);
    if (roomTask) return { threadId, label: "", title: { name: roomTask.title, render: title => `${kind} "${name(group.name)}", thread "${name(title)}"`, fallback: `${kind} "${name(group.name)}", another thread` } };
  }
  return undefined;
}

/** Every thread of the bot, or null when it has more than SMALL_CANDIDATES (never listed then). */
function smallCandidateList(input: WorkingContextInput, who: Subject): string[] | null {
  let count = 1 + (who.bot.tasks?.length ?? 0);
  for (const group of input.groups) if (!group.dm && group.memberIds.includes(input.botId)) count += 1 + (group.tasks?.length ?? 0);
  if (count > SMALL_CANDIDATES) return null;
  const out = [who.directThread, ...(who.bot.tasks ?? []).map(task => task.threadId)];
  for (const group of input.groups) if (!group.dm && group.memberIds.includes(input.botId)) out.push(group.threadId, ...(group.tasks ?? []).map(task => task.threadId));
  return out;
}

/** Whether a thread may be named on this block, asked afresh of the live input and the database on every build
 *  (a room moved to another section, a task removed, a thread left out of memory), remembered for that build only. */
type Eligible = (threadId: string) => Candidate | null;
function eligibility(input: WorkingContextInput, db: DatabaseSync, who: Subject, excluded: ReadonlySet<string>): Eligible {
  const seen = new Map<string, Candidate | null>();
  return threadId => {
    let known = seen.get(threadId);
    if (known !== undefined) return known;
    const item = threadId === input.currentThreadId ? undefined : candidateFor(input, who, threadId);
    known = item && (!who.liveBot || sameThreadPartition(who.liveBot, input.currentThreadId, threadId)) && threadAllowed(db, threadId, excluded) ? item : null;
    seen.set(threadId, known);
    return known;
  };
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

type MessageRow = { id: string; text: string | null; json: string };
/** A row as the bot's own reply that has words, read as it is now: its words and whether it is withheld from bots
 *  or a copy. Null when it is someone else's or has no words. */
function ownReply(row: MessageRow, botId: string): { text: string; withheld: boolean; copy: boolean } | null {
  let message: { from?: { botId?: string }; withheldFromBots?: unknown; copyOf?: unknown } = {};
  try { message = JSON.parse(row.json); } catch { return null; }
  if (isMurageVoice(message)) return null;
  if (message.from?.botId && message.from.botId !== botId) return null;
  const text = typeof row.text === "string" ? row.text : "";
  if (!text.trim()) return null;
  // (a "checking" left on disk is no note: the row is judged live on every build)
  return { text, withheld: Boolean(message.withheldFromBots) && message.withheldFromBots !== "checking", copy: Boolean(message.copyOf) };
}

/** DISCOVERY: which message is the bot's own last reply with words in the thread (or null: none). Not a verdict:
 *  whether it may be shown is judged on every build (candidateLine, shownLines). The row it read is judged on the build that found it, and read again by id on later builds. */
function lastOwnReply(db: DatabaseSync, threadId: string, botId: string): MessageRow | null {
  const rows = db.prepare("SELECT id, text, json FROM messages WHERE thread_id=? AND role='bot' AND kind='text' ORDER BY rowid DESC LIMIT 20").all(threadId) as MessageRow[];
  for (const row of rows) if (ownReply(row, botId)) return row;
  return null;
}

/** The lineage judge: "shown", "withheld" (on content: what it used was forgotten; or a copy of someone else's
 *  words, Astra r2 #15), or "unproven" (the judge could not finish: not shown, and nothing about it is kept).
 *  The lineage reads run under their own source for the slow-statement log. */
type Verdict = "shown" | "withheld" | "unproven";
function judgeReply(allowance: LineageAllowance, db: DatabaseSync, threadId: string, messageId: string, copy: boolean, roster: MemoryRoster, excluded: ReadonlySet<string>): Verdict {
  return ioBudget.withSource("lineage", () => {
    if (messageSourceForgotten(threadId, messageId)) return "withheld";
    const verdict = capturedMessageVerdict(allowance, threadId, messageId);
    if (verdict.unproven) return "unproven";
    if (verdict.withheld) return "withheld";
    return copy && !copiedFromOwner(db, roster, threadId, messageId, excluded) ? "withheld" : "shown";
  });
}

function newestAt(db: DatabaseSync, threadId: string): number | null {
  const row = db.prepare("SELECT at FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(threadId) as { at: number } | undefined;
  return typeof row?.at === "number" ? row.at : null;
}

/** The bot's newest files in threads that may be named: an indexed newest-first read (artifacts_bot_date). */
function recentFiles(db: DatabaseSync, botId: string, eligible: Eligible, refs?: LineageRef[]): string[] {
  try {
    const rows = db.prepare("SELECT relative_path, thread_id FROM artifacts WHERE bot_id=? ORDER BY created_at DESC LIMIT 50").all(botId) as Array<{ relative_path: string; thread_id: string }>;
    const files: string[] = [];
    const open = shownMemoryRefs(db, rows.map(row => fileRef(botId, String(row.relative_path))));
    for (const row of rows) {
      if (!eligible(String(row.thread_id))) continue;
      if (!open.has(memoryRefKey(fileRef(botId, String(row.relative_path))))) continue;
      const path = name(redactSecretsInText(String(row.relative_path))).slice(0, 120);
      if (path && !files.includes(path)) { files.push(path); refs?.push(...memoryRefs([fileRef(botId, String(row.relative_path))])); }
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
export function workingContext(allowance: LineageAllowance, input: WorkingContextInput, db: DatabaseSync = database()): string {
  return buildWorkingContext(allowance, input, db).text;
}

/** The replies a block quotes: a reply built from the block rests on them
 *  (the dispatch notes their sources on its receipt, Astra r1 #6). */
export type WorkingContextQuote = { threadId: string; messageId: string };

/** What was discovered for one bot and current thread. Nothing here decides what is shown. */
type Kept = {
  sig: string; seq: number; builtAt: number;
  /** the MAX_CONSIDERED most recent threads of the bot, newest first */
  recent: Array<{ threadId: string; at: number }>;
  /** each considered thread's last own reply (its message id), or null: it has none */
  replies: Map<string, string | null>;
};
const keptByDb = new WeakMap<object, Map<string, Kept>>();
const remember = <T>(map: Map<string, T>, key: string, value: T) => { map.delete(key); map.set(key, value); if (map.size > MAX_KEPT) map.delete(map.keys().next().value!); };

/** When to find the recent threads again: the bot's task list and rooms as they read now (the list object itself is
 *  compared by identity through the task index, so a task added or removed anywhere moves it). A hint for freshness
 *  only: nothing shown rests on it. */
function inputSignature(input: WorkingContextInput, who: Subject, excluded: ReadonlySet<string>): string {
  const parts: unknown[] = [[...excluded].sort().join("\u0002"), who.bot.threadId, who.directThread, who.liveBot?.partitionedAt ?? "", listId(who.bot.tasks)];
  for (const group of input.groups) {
    if (group.dm || !group.memberIds.includes(input.botId)) continue;
    parts.push(group.id, group.threadId, listId(group.tasks));
  }
  return parts.join("\u0001");
}
const listIds = new WeakMap<object, number>();
let nextListId = 0;
function listId(list: ReadonlyArray<unknown> | undefined): string {
  if (!list) return "-";
  let id = listIds.get(list);
  if (id === undefined) { id = ++nextListId; listIds.set(list, id); }
  return `${id}.${list.length}`;
}

/** The bot's most recent threads and their last replies: discovered, kept and brought up to date with what changed. */
function discovered(input: WorkingContextInput, db: DatabaseSync, who: Subject, eligible: Eligible, excluded: ReadonlySet<string>): Kept {
  const key = `${input.botId}\u0000${input.currentThreadId}`;
  const sig = inputSignature(input, who, excluded);
  const keptHere = keptByDb.get(db) ?? new Map<string, Kept>();
  keptByDb.set(db, keptHere);
  const seq = threadActivitySeq();
  const previous = keptHere.get(key);
  const reusable = previous && previous.sig === sig && input.now - previous.builtAt < TURN_CACHE_MS && input.now >= previous.builtAt ? previous : undefined;
  const changed = reusable ? threadsChangedSince(reusable.seq) : null;
  if (reusable && changed) {
    // only the changed threads of the bot are read again: their newest message moves them up, their reply is found again
    const recent = new Map(reusable.recent.map(entry => [entry.threadId, entry.at] as const));
    for (const threadId of changed) {
      if (!eligible(threadId)) continue;
      const at = newestAt(db, threadId);
      if (at === null) recent.delete(threadId); else recent.set(threadId, at);
      reusable.replies.delete(threadId);
    }
    reusable.recent = sortRecent(recent).slice(0, MAX_CONSIDERED);
    const considered = new Set(reusable.recent.map(entry => entry.threadId));
    for (const threadId of [...reusable.replies.keys()]) if (!considered.has(threadId)) reusable.replies.delete(threadId);
    reusable.seq = seq;
    remember(keptHere, key, reusable);
    return reusable;
  }
  // first build (or inputs changed, or the log no longer reaches back): one bounded newest-first read
  const kept: Kept = { sig, seq, builtAt: input.now, recent: recentThreads(input, db, who, eligible), replies: new Map() };
  remember(keptHere, key, kept);
  return kept;
}

const sortRecent = (recent: Map<string, number>) => [...recent].map(([threadId, at]) => ({ threadId, at })).sort((a, b) => b.at - a.at || a.threadId.localeCompare(b.threadId));

/** The bot's threads with the newest messages that may be named now: read newest first from the messages' time
 *  index, at most RECENT_SCAN_ROWS rows; a bot with few threads has the rest read one by one. */
function recentThreads(input: WorkingContextInput, db: DatabaseSync, who: Subject, eligible: Eligible): Array<{ threadId: string; at: number }> {
  const found = new Map<string, number>();
  const passed = new Set<string>();
  let rows = 0;
  for (const row of db.prepare("SELECT thread_id, at FROM messages ORDER BY at DESC").iterate() as Iterable<{ thread_id: string; at: number }>) {
    if (++rows > RECENT_SCAN_ROWS || found.size >= MAX_CONSIDERED) break;
    const threadId = String(row.thread_id);
    if (found.has(threadId) || passed.has(threadId)) continue;
    if (eligible(threadId)) found.set(threadId, Number(row.at)); else passed.add(threadId);
  }
  const small = found.size < MAX_CONSIDERED ? smallCandidateList(input, who) : null;
  for (const threadId of small ?? []) {
    if (found.has(threadId) || !eligible(threadId)) continue;
    const at = newestAt(db, threadId);
    if (at !== null) found.set(threadId, at);
  }
  // the direct chat is always looked at
  if (!found.has(who.directThread) && eligible(who.directThread)) { const at = newestAt(db, who.directThread); if (at !== null) found.set(who.directThread, at); }
  return sortRecent(found).slice(0, MAX_CONSIDERED);
}

/** The line a thread may give on THIS build, judged now: the thread may be named, its last own reply still exists, is
 *  still the bot's, not withheld from bots, and the lineage judge lets bots see it. Its words are the ones it has now. The reader door
 *  judges the row it carries, with every other candidate of the build, in one operation (shownLines). */
type QuoteCandidate = { threadId: string; line: string; messageId: string; row: Message };
function candidateLine(allowance: LineageAllowance, input: WorkingContextInput, db: DatabaseSync, kept: Kept, eligible: Eligible, excluded: ReadonlySet<string>, threadId: string, at: number): QuoteCandidate | null {
  const item = eligible(threadId);
  if (!item) return null;
  let messageId = kept.replies.get(threadId);
  let row: MessageRow | undefined;
  if (messageId === undefined) { row = lastOwnReply(db, threadId, input.botId) ?? undefined; messageId = row?.id ?? null; kept.replies.set(threadId, messageId); }
  if (messageId === null) return null;
  row ??= db.prepare("SELECT id, text, json FROM messages WHERE thread_id=? AND id=?").get(threadId, messageId) as MessageRow | undefined;
  let reply = row ? ownReply(row, input.botId) : null;
  if (!reply) {
    // the kept reply was deleted or emptied: find the last one again
    row = lastOwnReply(db, threadId, input.botId) ?? undefined;
    messageId = row?.id ?? null;
    kept.replies.set(threadId, messageId);
    reply = row ? ownReply(row, input.botId) : null;
    if (!reply) return null;
  }
  if (reply.withheld) return null;
  if (judgeReply(allowance, db, threadId, messageId!, reply.copy, input as unknown as MemoryRoster, excluded) !== "shown") return null;
  let stored: unknown;
  try { stored = JSON.parse(row!.json); } catch { return null; }
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const saidIn = input.groups.some(group => group.channelProject && (group.threadId === threadId || taskIndex(group.tasks).has(threadId)))
    || input.bots.some(bot => taskIndex(bot.tasks).get(threadId)?.channelProjectDesk);
  return { threadId, line: `- ${saidIn ? "Said in " : ""}${label(db, item)}, ${ago(at, input.now)}: ${quote(clip(reply.text))}`, messageId: messageId!, row: { ...stored, id: messageId! } as Message };
}

/** The lines the recent threads give, newest first, at most `room`: candidates are gathered until there is room for no more, and the reader
 *  door (LINEAGE-DESIGN-S6 rule 16) judges the rows they carry in one operation (bot-read.ts rowsShown: no row read again, the per-operation
 *  state read once). Only when the door leaves some out are the next threads' candidates gathered and judged, so the work follows the lines
 *  shown, never the history. */
function shownLines(allowance: LineageAllowance, input: WorkingContextInput, db: DatabaseSync, kept: Kept, eligible: Eligible, excluded: ReadonlySet<string>, room: number, reader?: LineageReader): QuoteCandidate[] {
  const shown: QuoteCandidate[] = [];
  const viewer = botViewer(input.botId);
  let next = 0;
  while (shown.length < room && next < kept.recent.length) {
    const batch: QuoteCandidate[] = [];
    while (shown.length + batch.length < room && next < kept.recent.length) {
      const { threadId, at } = kept.recent[next++]!;
      const candidate = candidateLine(allowance, input, db, kept, eligible, excluded, threadId, at);
      if (candidate) batch.push(candidate);
    }
    if (!batch.length) break;
    const verdicts = rowsShown(db, viewer, batch);
    const fenced = readerShown(db, batch, reader);
    batch.forEach((candidate, index) => { if (verdicts[index] && fenced[index]) shown.push(candidate); });
  }
  return shown;
}
/** The candidates the turn's own reader shows, by the send fence's rule for a quoted line of another thread (deny-read.ts refsLookup: the
 *  line's marks for that reader). The door above reads as the bot's content reader; an audience reader (a room, a surface not proven the
 *  owner's) also withholds a reply under an audience-only mark, such as the receipt revoke every memory settings change, import, canon
 *  write and roster change commits on every receipt. Judged here so the block never carries a line the fence would refuse: the refusal
 *  rebuilt the same block from this door three times and then sent the last-resort prompt, with no memory frame and so none of the
 *  owner's pinned records (1.0.3 room deny-line). A content reader, or no reader, adds nothing. Fail closed: a lookup that throws leaves
 *  the batch out. */
function readerShown(db: DatabaseSync, batch: readonly QuoteCandidate[], reader: LineageReader | undefined): boolean[] {
  if (!reader || reader.audience === null) return batch.map(() => true);
  try {
    const byThread = new Map<string, string[]>();
    for (const candidate of batch) byThread.set(candidate.threadId, [...(byThread.get(candidate.threadId) ?? []), candidate.messageId]);
    const verdicts = new Map<string, LineageVerdict>();
    for (const [threadId, ids] of byThread) {
      const page = denyLookup(db, { threadId, lines: ids.map(messageId => ({ messageId, author: "generated" as const })) }, reader);
      for (const [messageId, verdict] of page) verdicts.set(`${threadId}\u0000${messageId}`, verdict);
    }
    return batch.map(candidate => verdicts.get(`${candidate.threadId}\u0000${candidate.messageId}`)?.state === "shown");
  } catch { return batch.map(() => false); }
}

/** Whether a thread's human is the owner, kept per thread. Only asked of a thread that already has messages (its
 *  newest line or an artifact led here), and a thread's human is bound before its first message and never changes
 *  after (human-principals.ts, HUMAN_THREAD_IMMUTABLE), so the answer holds. */
const ownerThreads = new WeakMap<object, Map<string, boolean>>();
function ownerThread(db: DatabaseSync, threadId: string): boolean {
  const known = ownerThreads.get(db) ?? new Map<string, boolean>();
  ownerThreads.set(db, known);
  let owner = known.get(threadId);
  if (owner === undefined) { owner = isWorkspaceOwner(threadHumanPrincipal(threadId, db)); if (known.size >= 50_000) known.clear(); known.set(threadId, owner); }
  return owner;
}
/** Whether a thread the bot is in may be named on this block (not left out of memory, its human is the owner). */
function threadAllowed(db: DatabaseSync, threadId: string, excluded: ReadonlySet<string>): boolean {
  return !excluded.has(threadId) && ownerThread(db, threadId);
}

/** The refs among `refs` the write-time lookup shows a content reader: a card title or a file name is words a bot wrote in a turn, and a forget
 * that reached its writer's turn denies it (deny_memory) whatever its explicit sources say (Astra audit P1 4). A ref that reads "checking" or
 * withheld stays out of the block; a lookup that fails leaves all out (fail closed). */
function shownMemoryRefs(db: DatabaseSync, refs: readonly MemoryRef[]): Set<string> {
  if (!refs.length) return new Set();
  try {
    const verdicts = memoryLookup(db, refs, doorReader());
    return new Set(refs.map(memoryRefKey).filter(key => verdicts.get(key)?.state === "shown"));
  } catch { return new Set(); }
}

/** The bot's cards on a project's record: an indexed read of at most `limit` (project_work_items_assignee). */
function projectCardLines(db: DatabaseSync, group: { id: string; name: string }, botId: string, limit: number, refs?: LineageRef[]): string[] {
  const found = db.prepare("SELECT id, number, title, state, request_id FROM project_work_items WHERE group_id=? AND assignee_bot_id=? AND archived_at IS NULL AND stale=0 ORDER BY position, created_at, id LIMIT ?")
    .all(group.id, botId, limit) as Array<{ id: string; number: number; title: string; state: string; request_id: string | null }>;
  const open = shownMemoryRefs(db, found.map(card => murageObjectRef("project-card", String(card.id))));
  const rows = found.filter(card => open.has(memoryRefKey(murageObjectRef("project-card", String(card.id)))));
  // a card's title may be a lead's words: the line rests on the card (project-cards.ts records a card a bot writes in its turn)
  refs?.push(...memoryRefs(rows.map(card => murageObjectRef("project-card", String(card.id)))));
  return rows.map(card => {
    const request = card.request_id ? db.prepare("SELECT state FROM room_requests WHERE id=?").get(card.request_id) as { state?: string } | undefined : undefined;
    const state = card.state === "todo" ? "not started" : card.state === "doing" ? (request?.state === "running" ? "running" : "waiting")
      : card.state === "review" ? "in review" : card.state;
    return `- Project "${name(group.name)}", on record: #${Number(card.number)} [${state}] ${quote(clip(String(card.title)))}`;
  });
}

/** (thread bindings remembered for the build: human-principals.ts withBindingScope) */
function buildWorkingContext(allowance: LineageAllowance, input: WorkingContextInput, db: DatabaseSync, refs: LineageRef[] = [], reader?: LineageReader): { text: string; quoted: WorkingContextQuote[] } {
  return withBindingScope(() => buildWorkingContextScoped(allowance, input, db, refs, reader));
}
function buildWorkingContextScoped(allowance: LineageAllowance, input: WorkingContextInput, db: DatabaseSync, refs: LineageRef[], reader?: LineageReader): { text: string; quoted: WorkingContextQuote[] } {
  // a scheduled or webhook run is not a turn with the owner: no block, and no work for it
  if (input.trigger === "schedule" || input.trigger === "webhook") return { text: "", quoted: [] };
  const who = subject(input);
  if (!who) return { text: "", quoted: [] };
  const excluded = excludedThreads(db);
  const eligible = eligibility(input, db, who, excluded);
  const lines: string[] = [];
  const projectGroups = input.groups.filter(group => group.channelProject && !group.dm && group.memberIds.includes(input.botId));
  if (projectGroups.length && projectTableExists(db, "project_work_items")) {
    for (const group of projectGroups) {
      if (lines.length === MAX_THREADS) break;
      // a room's chat may have no message yet: its human is read afresh, not kept
      if (!eligible(group.threadId) || !isWorkspaceOwner(threadHumanPrincipal(group.threadId, db))) continue;
      lines.push(...projectCardLines(db, group, input.botId, MAX_THREADS - lines.length, refs));
    }
  }
  const quoted: WorkingContextQuote[] = [];
  const kept = discovered(input, db, who, eligible, excluded);
  for (const shown of shownLines(allowance, input, db, kept, eligible, excluded, MAX_THREADS - lines.length, reader)) {
    lines.push(shown.line);
    quoted.push({ threadId: shown.threadId, messageId: shown.messageId });
  }
  const files = recentFiles(db, input.botId, eligible, refs);
  const routineList = typeof input.routines === "function" ? input.routines() : input.routines;
  const routines = (who.liveBot?.partitionedAt !== undefined && !isHomePartition(threadPartition(who.liveBot, input.currentThreadId)) ? [] : routineList).filter(routine => routine.botId === input.botId && routine.enabled).map(routine => name(routine.name).slice(0, 60)).filter(Boolean).slice(0, MAX_ROUTINES);
  if (!lines.length && !files.length && !routines.length) return { text: "", quoted: [] };
  const recordLines = lines.length - quoted.length;
  let fitted = lines;
  while (fitted.length && Buffer.byteLength(renderWorkingContext(fitted, files, routines)) > WORKING_CONTEXT_MAX_BYTES) fitted = fitted.slice(0, -1);
  let text = renderWorkingContext(fitted, files, routines);
  if (Buffer.byteLength(text) > WORKING_CONTEXT_MAX_BYTES) text = Buffer.from(text).subarray(0, WORKING_CONTEXT_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
  return { text, quoted: quoted.slice(0, Math.max(0, fitted.length - recordLines)) };
}

/** The surface: owner-audience turns only (owner-audience.ts). */
export function workingContextPrompt(allowance: LineageAllowance, ownerAudience: boolean, input: WorkingContextInput, db?: DatabaseSync): string {
  return workingContextBlock(allowance, ownerAudience, input, db).text;
}

/** The surface with the replies it quotes, for the dispatch's receipt. */
/** `reader`: the turn's send-fence reader (index.ts directFence, roomFence); the quoted lines are judged for it at the build (readerShown). */
export function workingContextBlock(allowance: LineageAllowance, ownerAudience: boolean, input: WorkingContextInput, db: DatabaseSync = database(), reader?: LineageReader): { text: string; quoted: WorkingContextQuote[]; part: PromptPart } {
  let quoted: WorkingContextQuote[] = [];
  const refs: LineageRef[] = [];
  const text = ownerOnly("working-context", ownerAudience, () => { const built = buildWorkingContext(allowance, input, db, refs, reader); quoted = built.quoted; return built.text; });
  return { text, quoted: text ? quoted : [], part: workingContextPart(text, text ? quoted : [], text ? refs : []) };
}

/** The block as a prompt part (DESIGN-WRITETIME 2.2, prompt-borne text): every reply it quotes is a point carry, every card and file it
 * names rests on that card or file. A reply built from the block then rests on all of it, whatever the owner later forgets. */
export function workingContextPart(text: string, quoted: readonly WorkingContextQuote[], named: readonly LineageRef[] = []): PromptPart {
  if (!text) return promptPart("", [noneRef("static")]);
  const byThread = new Map<string, string[]>();
  for (const item of quoted) byThread.set(item.threadId, [...(byThread.get(item.threadId) ?? []), item.messageId]);
  return promptPart(text, [...[...byThread].flatMap(([threadId, ids]) => lineRefs(threadId, ids)), ...named]);
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
