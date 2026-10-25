// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Thread recall (THREAD-RECALL-DESIGN r6 and S): a bot reads its own direct conversations with the owner through three read-only tools,
// thread_search, thread_list and thread_read. This file is the handler behind /api/internal/memory/thread-search|thread-list|thread-read.
//
// What it guarantees, in the order the design states it:
//  - Rules 1 and 2: the set of threads is recallThreads(access), computed on every call from the live roster; an empty set answers the fixed
//    "no-threads-for-this-audience" status.
//  - Rules 15 to 17: every row passes the reader door with Murage-voice rows and copies left out; a needle is re-tested on the shown text; the
//    two outcome classes ("still being checked", "could not be judged") are counted and never conflated.
//  - Rules 11 to 14 and 23a, and the seal (S1): one synchronous block, after the last await, re-checks the turn binding, preflights the sources,
//    re-derives the audience and the door verdicts, seals the thread, persists what the turn read, adds it to the running turn and releases
//    exactly the surviving rows. Nothing in that block awaits.
//
// The turn lineage is only ever `host.lineage()` (the turnOutputRoots entry of the authenticated generation): nothing here looks a turn up by
// thread (no currentTurnLineage, runningTurnFor, writerTurnFor or memberOf).
import { Buffer } from "node:buffer";
import { z } from "zod";
import { database, transaction } from "./database.ts";
import { botRows, botViewer, doorReader, type BotRow } from "./bot-read.ts";
import { isMurageVoice } from "./murage-voice.ts";
import { transcriptRowCheck } from "./partition-sources.ts";
import { denyLookup, lineageLive } from "./memory/deny-read.ts";
import { forgottenMessageSources } from "./memory/replay-lineage.ts";
import { executionStore } from "./execution-audience.ts";
import { lineAuthor, newestMessageAt, readActiveLeafOrNewest, readMessage, searchMessagesWithMeta, textLinesAlongBranch } from "./message-db.ts";
import { addTurnParents, isTurnOpen, recordTurnReads } from "./memory/lineage-write.ts";
import { addRootsToRunningTurn, addSourcesToRunningTurn, shownLinesRoots, sourcesRoom, TURN_SOURCES_MAX, type RunningTurnLineage, type ShownLine } from "./steer-lineage.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { recallThreads, type MemoryAccess } from "./memory/policy.ts";
import type { LineageRef, LineageAudience, LineageVerdict } from "./memory/lineage-types.ts";
import type { Message } from "./store.ts";

/** Rule 14: calls per generation (the 13th is refused). */
export const THREAD_CALLS_PER_TURN = 12;
/** Rule 21: the most an answer may weigh as the proxy measures it, under its 32,768-byte refusal. */
export const THREAD_ENVELOPE_BUDGET = 30_720;
/** Rule 9: the proxy accepts an id of up to 256 bytes, so the budget is measured with one that long. */
const PLACEHOLDER_ID = "x".repeat(256);
const PAGE = 20;
const REFILLS = 3;
const TITLE_CHARS = 120;
const TEXT_CHARS = 2000;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 90;
const READ_DEFAULT = 25;

export const NO_THREADS_STATUS = "no-threads-for-this-audience";
export const NO_THREADS_LINE = "This conversation does not reach past threads.";
export const PARTIAL_LINE = "older or same-instant lines may not have been searched; pass oldest_at as before, or read the thread";
export const CHECKING_LINE = "Some lines are still being checked; ask again in a moment for those.";
export const OUT_OF_ROOM_LINE = "this turn has read as much as it can; answer with what you have";
export const UNRECORDED_LINE = "this turn could not record what it read; answer with what you have";
export const NOT_ACTIVE_LINE = "this turn is no longer active; answer with what you have";
export const CALLS_LINE = "this turn has used the thread tools as many times as it can; answer with what you have";
const unavailableLine = (n: number) => `${n} ${n === 1 ? "line" : "lines"} could not be judged and ${n === 1 ? "is" : "are"} left out.`;
const sameInstantLine = (n: number) => `At least ${n} more ${n === 1 ? "line shares" : "lines share"} the instant of oldest_at and ${n === 1 ? "is" : "are"} not reached by before.`;

/** What the handler keeps per generation, beside the entry of `internalTurnOwners` (rules 8 and 14), deleted with it. */
export interface ThreadRecallState {
  calls: number;
  /** Message ids this generation has been handed by a search or read answer, with their thread. */
  released: Map<string, string>;
  /** The seal bump for this generation has been written (design S1: once, before the first releasing answer). */
  sealed: boolean;
  /** Rule 22: set at the memory mount when the turn's audience reaches at least one thread (`recallThreads(access)` is not empty). */
  eligible?: boolean;
}

export type ThreadRecallTool = "thread_search" | "thread_list" | "thread_read";

export interface ThreadRecallHost {
  claim: { readonly threadId: string; readonly botId: string; readonly generation: string };
  /** The access for this turn as it stands now, or null when it no longer exists (re-derived at release, rule 23a). */
  access(): MemoryAccess | null;
  /** `turnOutputRoots.get(claim.threadId)`; nothing else is ever used as the turn (rule 12). */
  lineage(): RunningTurnLineage | undefined;
  /** `internalCapabilities.isActive(claim)`. */
  active(): boolean;
  /** `internalTurnOwners.get(claim.threadId)?.generation`. */
  ownerGeneration(): string | undefined;
  /** The per-generation state on the turn's `internalTurnOwners` entry, created on first use; undefined when the entry is gone. */
  state(): ThreadRecallState | undefined;
  /** `store.sealThread(botId, threadId)`: the immediate, throwing save (design S1). */
  seal(): void;
  /** Lets the loop run between judgment and release (the last await). */
  yield(): Promise<void>;
  /** Writes the answer. Called inside the synchronous release block, so nothing awaits between persistence and the answer. */
  respond(status: number, body: unknown): void;
}

const dateOrTime = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/, "before must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS.sssZ");
const queryText = z.string().refine(value => { const bytes = Buffer.byteLength(value, "utf8"); return bytes >= 3 && bytes <= 512; }, "query must be 3 to 512 UTF-8 bytes");
const searchArgs = z.object({ query: queryText, before: dateOrTime.optional() }).strict();
const listArgs = z.object({ before: dateOrTime.optional() }).strict();
const readArgs = z.object({ message_id: z.string().min(1).max(256), direction: z.enum(["before", "after", "around"]), limit: z.number().int().min(1).max(40).optional() }).strict();

/** `before` as epoch ms: a bare date means its start, UTC. Undefined for no cutoff; NaN is refused by the caller. */
function beforeMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(ms)) throw Object.assign(new Error("before is not a real date"), { status: 400 });
  return ms;
}
const iso = (at: number): string => new Date(at).toISOString();

/** The proxy's measure of an answer: its whole JSON-RPC envelope with a 256-byte id, plus the newline (memory-proxy.ts result()). */
export function envelopeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: PLACEHOLDER_ID, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } })) + 1;
}

/** `text` cut at `max` code points (never inside a surrogate pair). */
function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const points = Array.from(text);
  return points.length <= max ? { text, cut: false } : { text: points.slice(0, max).join(""), cut: true };
}

// ── The door ────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Seen { readonly threadId: string; readonly row: BotRow }
interface Judged { shown: Seen[]; checking: number; unavailable: number; /** `threadId\u0000id` of rows left out as forgotten, or whose forgotten state could not be told. */ gone: Set<string> }
const CHECKING_REASONS: ReadonlySet<string> = new Set(["pending", "thread-not-ready", "not-built"]);
const outcomeOf = (verdict: LineageVerdict | undefined): "shown" | "silent" | "checking" | "unavailable" => {
  if (!verdict) return "unavailable";
  if (verdict.state === "shown") return "shown";
  if (verdict.state === "withheld") return "silent";
  return CHECKING_REASONS.has(verdict.reason) ? "checking" : "unavailable";
};

/** Rules 15 to 17: the rows a bot may be handed, in order. Murage-voice rows and copies are skipped before anything else (a silent policy
 * exclusion), a withheld verdict is silent, a row whose check threw or whose verdict is "pending", "thread-not-ready" or "not-built" is
 * counted as still being checked, and "no-lineage", "lookup-error" and "footprint-wide" as could not be judged. The current thread reads with
 * the content reader, every other thread with the owner's audience. */
export function judgeRows(access: MemoryAccess, items: ReadonlyArray<{ threadId: string; message: Message }>): Judged {
  const db = database();
  const byThread = new Map<string, Message[]>();
  for (const { threadId, message } of items) {
    const list = byThread.get(threadId);
    if (list) list.push(message); else byThread.set(threadId, [message]);
  }
  let checking = 0, unavailable = 0;
  const gone = new Set<string>();
  const shownKeys = new Map<string, BotRow>();
  const live = lineageLive(db);
  for (const [threadId, messages] of byThread) {
    const check = transcriptRowCheck(db, access.botId, threadId);
    const candidates: Message[] = [];
    for (const message of messages) {
      try {
        if (isMurageVoice(message) || message.copyOf) continue;
        if (message.kind !== "text" || typeof message.text !== "string" || !message.text) continue;
        if (!check(message)) continue;
        candidates.push(message);
      } catch { checking += 1; }
    }
    if (!candidates.length) continue;
    // A line the owner forgot is never handed out, whoever the audience and whether or not line lineage is live (silent, like a withheld
    // verdict). Forgotten is the one definition project-memory-tools.ts and All chats use: stamped `withheldFromBots: "forgotten"`, or its
    // message source deleted, denied or tombstoned (messageSourceForgotten). When that cannot be told, the rows are left out (fail closed).
    const remembered = unforgotten(threadId, candidates);
    if (remembered === null) { unavailable += candidates.length; for (const message of candidates) gone.add(`${threadId}\u0000${message.id}`); continue; }
    if (remembered.length < candidates.length) { const kept = new Set(remembered); for (const message of candidates) if (!kept.has(message)) gone.add(`${threadId}\u0000${message.id}`); }
    if (!remembered.length) continue;
    const audience: LineageAudience | null = threadId === access.threadId ? null : { owner: true, scopeIds: access.scopeIds };
    let admitted = remembered;
    if (live) {
      const verdicts = denyLookup(db, { threadId, lines: remembered.map(message => ({ messageId: message.id, author: lineAuthor(message) })) }, doorReader(audience));
      admitted = [];
      for (const message of remembered) {
        const outcome = outcomeOf(verdicts.get(message.id));
        if (outcome === "shown") admitted.push(message);
        else if (outcome === "checking") checking += 1;
        else if (outcome === "unavailable") unavailable += 1;
      }
    }
    if (!admitted.length) continue;
    for (const row of botRows(db, botViewer(access.botId), threadId, admitted, { audience })) shownKeys.set(`${threadId}\u0000${row.id}`, row);
  }
  const shown: Seen[] = [];
  for (const { threadId, message } of items) {
    const row = shownKeys.get(`${threadId}\u0000${message.id}`);
    if (row) { shown.push({ threadId, row }); shownKeys.delete(`${threadId}\u0000${message.id}`); }
  }
  return { shown, checking, unavailable, gone };
}

/** `messages` of one thread without the lines the owner forgot (the stamp, or a deleted, denied or tombstoned source), or null when that
 * cannot be told. */
function unforgotten(threadId: string, messages: readonly Message[]): Message[] | null {
  try {
    const gone = forgottenMessageSources(threadId, messages.map(message => message.id));
    return messages.filter(message => message.withheldFromBots !== "forgotten" && !gone.has(message.id));
  } catch { return null; }
}

/** thread_list's lastAt: the newest line of the thread the owner has not forgotten, so a forgotten line's time never shows. Null when the
 * thread has no such line or it cannot be told (the thread is then not listed: fail closed). */
const NEWEST_PAGE = 64;
function newestRememberedAt(threadId: string): number | null {
  try {
    const db = database();
    if (db.prepare("SELECT 1 FROM memory_deny WHERE kind='thread' AND id=? LIMIT 1").get(threadId)) return null;
    let below = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = db.prepare("SELECT rowid AS rid, id, at, json_extract(json,'$.withheldFromBots') AS stamp FROM messages WHERE thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?")
        .all(threadId, below, NEWEST_PAGE) as unknown as Array<{ rid: number; id: string; at: number; stamp: unknown }>;
      if (!rows.length) return null;
      const gone = forgottenMessageSources(threadId, rows.map(row => String(row.id)));
      for (const row of rows) if (row.stamp !== "forgotten" && !gone.has(String(row.id))) return Number(row.at);
      below = Number(rows[rows.length - 1]!.rid);
    }
  } catch { return null; }
}

/** The same verdicts asked again for rows already judged (rule 23a): a row gone from the store, or no longer shown, is not in the answer. */
function rejudge(access: MemoryAccess, rows: ReadonlyArray<Seen>, needle?: string): Judged {
  const items: Array<{ threadId: string; message: Message }> = [];
  for (const { threadId, row } of rows) {
    const message = readMessage(threadId, row.id);
    if (message) items.push({ threadId, message });
  }
  const judged = judgeRows(access, items);
  return needle === undefined ? judged : { ...judged, shown: judged.shown.filter(({ row }) => row.text.toLowerCase().includes(needle)) };
}

// ── The shapes ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface ThreadInfo { title: string; kind: "chat" | "task"; createdAt: number }
function threadInfo(botId: string, threadId: string): ThreadInfo {
  const bot = executionStore()?.bot(botId);
  const task = bot?.tasks?.find(candidate => candidate.threadId === threadId);
  const work = Boolean(task && (task.automationEventId || task.channelProjectDesk || task.sharedWork));
  return {
    title: cut(String(task?.title ?? bot?.title ?? ""), TITLE_CHARS).text,
    kind: work ? "task" : "chat",
    createdAt: task?.createdAt ?? 0,
  };
}
const speakerName = (row: BotRow): string => row.role === "user" ? "owner" : row.speaker?.name || "bot";
const snippetOf = (text: string, needle: string): string => {
  const at = Math.max(0, text.toLowerCase().indexOf(needle));
  const start = Math.max(0, at - SNIPPET_BEFORE), end = Math.min(text.length, at + needle.length + SNIPPET_AFTER);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
};

interface Hit { threadId: string; threadTitle: string; messageId: string; at: string; speaker: string; snippet: string; truncated?: true }
interface Plan {
  /** Everything the answer may release, in answer order, before the page cut and the envelope trim. */
  rows: Seen[];
  /** How many of `rows` one page holds; the rest are held back (they prove a next page exists) and are never released. */
  limit: number;
  /** Builds the answer for the rows kept after judgment and trim; `rest` are the rows held back or trimmed (never released). */
  build(kept: Seen[], notes: { checking: number; unavailable: number; trimmed: boolean; rest: Seen[]; truncated: boolean }): Record<string, unknown>;
  /** Which end of `rows` the envelope trim drops first: "end" is the oldest of a newest-first page, "start" the oldest of a chronological
   * read, "far" the end of a read farther from its anchor. */
  trim: "start" | "end" | "far";
  checking: number;
  unavailable: number;
  needle?: string;
  anchorId?: string;
}

// ── thread_search ───────────────────────────────────────────────────────────────────────────────────────────────────

function planSearch(access: MemoryAccess, set: readonly string[], args: z.infer<typeof searchArgs>, cutoff: number | undefined): Plan {
  const needle = args.query.trim().toLowerCase();
  const collected: Seen[] = [];
  const seenIds = new Set<string>();
  let checking = 0, unavailable = 0, partial = false, cursor = cutoff, refills = 0;
  // the oldest examined row that is not forgotten (oldest_at when nothing is shown): a forgotten line's time never leaves
  let oldestExamined: { threadId: string; id: string; at: number } | undefined;
  let undecided = 0;
  for (;;) {
    const found = searchMessagesWithMeta(args.query, PAGE + 1, set, { judge: "door" }, cursor);
    const items: Array<{ threadId: string; message: Message }> = [];
    for (const hit of found.hits) {
      const message = readMessage(hit.threadId, hit.messageId);
      if (message) items.push({ threadId: hit.threadId, message });
    }
    const judged = judgeRows(access, items);
    for (const { threadId, message } of items) if (!judged.gone.has(`${threadId}\u0000${message.id}`)) oldestExamined = { threadId, id: message.id, at: message.at };
    checking += judged.checking; unavailable += judged.unavailable; undecided += judged.checking + judged.unavailable;
    for (const seen of judged.shown) {
      // the trigram match only names candidates: the needle must be in the text the bot is shown
      if (!seen.row.text.toLowerCase().includes(needle)) continue;
      const key = `${seen.threadId}\u0000${seen.row.id}`;
      if (seenIds.has(key)) continue;
      seenIds.add(key); collected.push(seen);
    }
    // rule 6: the search's own partial is never discarded, whether or not the page filled
    if (found.partial) partial = true;
    if (found.hits.length < PAGE + 1) {
      // rule 6: a short batch ends the search, but a candidate the door could not decide has no replacement unless the page is already full
      if (undecided > 0 && collected.length <= PAGE) partial = true;
      break;
    }
    if (collected.length > PAGE) break;
    if (refills >= REFILLS) { partial = true; break; }
    cursor = found.hits[found.hits.length - 1]!.at;
    refills += 1;
  }
  const titles = new Map<string, string>();
  const titleOf = (threadId: string) => { let title = titles.get(threadId); if (title === undefined) { title = threadInfo(access.botId, threadId).title; titles.set(threadId, title); } return title; };
  const baseHeld = collected.length > PAGE;
  return {
    rows: collected, limit: PAGE,
    checking, unavailable, needle, trim: "end",
    build(kept, notes) {
      const shown = kept;
      const rest = notes.rest;
      const hits: Hit[] = shown.map(({ threadId, row }) => ({ threadId, threadTitle: titleOf(threadId), messageId: row.id, at: iso(row.at), speaker: speakerName(row), snippet: snippetOf(row.text, needle) }));
      if (notes.truncated && hits.length) hits[hits.length - 1]!.truncated = true;
      const last = shown[shown.length - 1]?.row.at;
      // built inside the release block: the examined row is asked again, so a line forgotten since (or not decidable now) gives no time
      const examined = last === undefined && oldestExamined ? readMessage(oldestExamined.threadId, oldestExamined.id) : undefined;
      const examinedAt = examined && unforgotten(oldestExamined!.threadId, [examined])?.length ? oldestExamined!.at : undefined;
      const oldest = last ?? examinedAt;
      const held = baseHeld || rest.length > 0 || notes.trimmed;
      const isPartial = partial || notes.trimmed;
      const sameInstant = last === undefined ? 0 : rest.filter(({ row }) => row.at === last).length;
      const out: Record<string, unknown> = {
        hits, oldest_at: oldest === undefined ? null : iso(oldest), more: held || isPartial, partial: isPartial,
        checking: notes.checking, unavailable: notes.unavailable,
      };
      if (sameInstant > 0) out.same_instant = sameInstant;
      const lines = [...(isPartial ? [PARTIAL_LINE] : []), ...(sameInstant > 0 ? [sameInstantLine(sameInstant)] : []), ...(notes.checking > 0 ? [CHECKING_LINE] : []), ...(notes.unavailable > 0 ? [unavailableLine(notes.unavailable)] : [])];
      if (lines.length) out.notes = lines;
      return out;
    },
  };
}

// ── thread_list ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface ListedThread { threadId: string; title: string; kind: "chat" | "task"; createdAt: string; lastAt: string; current: boolean }
function listThreads(access: MemoryAccess, set: readonly string[], cutoff: number | undefined): { threads: ListedThread[]; held: boolean } {
  const rows: Array<ListedThread & { last: number }> = [];
  for (const threadId of set) {
    // the newest line's time only when that line is not forgotten; otherwise the newest remembered line's (a forgotten line never shows)
    const newest = newestMessageAt(threadId);
    const last = newest === null ? null : newestRememberedAt(threadId);
    if (last === null || (cutoff !== undefined && last >= cutoff)) continue;
    const info = threadInfo(access.botId, threadId);
    rows.push({ threadId, title: info.title, kind: info.kind, createdAt: info.createdAt ? iso(info.createdAt) : iso(last), lastAt: iso(last), current: threadId === access.threadId, last });
  }
  rows.sort((a, b) => b.last - a.last || a.threadId.localeCompare(b.threadId));
  return { threads: rows.slice(0, PAGE).map(({ last: _last, ...thread }) => thread), held: rows.length > PAGE };
}

// ── thread_read ─────────────────────────────────────────────────────────────────────────────────────────────────────

function planRead(access: MemoryAccess, set: readonly string[], args: z.infer<typeof readArgs>, released: ReadonlyMap<string, string>): Plan | "not-reachable" {
  const threadId = released.get(args.message_id);
  if (!threadId || !set.includes(threadId)) return "not-reachable";
  const anchor = readMessage(threadId, args.message_id);
  if (!anchor) return "not-reachable";
  // the line itself must still read as shown, or the thread opens around nothing (one answer, never a membership oracle)
  if (!judgeRows(access, [{ threadId, message: anchor }]).shown.length) return "not-reachable";
  const limit = args.limit ?? READ_DEFAULT;
  const leaf = readActiveLeafOrNewest(threadId);
  // rule 8: the active branch in the branch's own order (branchRows), never storage rowid; an anchor that is not on that branch reads as not-reachable
  const walk = (direction: "before" | "after", need: number) => textLinesAlongBranch(threadId, leaf, anchor.id, direction, need);
  let older: Message[] = [], newer: Message[] = [], moreOlder = false, moreNewer = false, includeAnchor = false;
  if (args.direction === "before") {
    const got = walk("before", limit);
    if (!got.anchorOnBranch) return "not-reachable";
    ({ rows: older, more: moreOlder } = got);
  } else if (args.direction === "after") {
    const got = walk("after", limit);
    if (!got.anchorOnBranch) return "not-reachable";
    ({ rows: newer, more: moreNewer } = got);
  } else {
    const before = Math.floor((limit - 1) / 2), after = limit - 1 - before;
    includeAnchor = true;
    const back = walk("before", before), forward = walk("after", after);
    if (!back.anchorOnBranch || !forward.anchorOnBranch) return "not-reachable";
    ({ rows: older, more: moreOlder } = back);
    ({ rows: newer, more: moreNewer } = forward);
  }
  const ordered = [...older.reverse(), ...(includeAnchor ? [anchor] : []), ...newer];
  const judged = judgeRows(access, ordered.map(message => ({ threadId, message })));
  const baseMore = moreOlder || moreNewer;
  return {
    rows: judged.shown, limit: Number.MAX_SAFE_INTEGER, anchorId: anchor.id,
    checking: judged.checking, unavailable: judged.unavailable,
    trim: args.direction === "before" ? "start" : args.direction === "after" ? "end" : "far",
    build(kept, notes) {
      const rows = kept.map(({ row }) => {
        const shown = cut(row.text, TEXT_CHARS);
        return { messageId: row.id, at: iso(row.at), speaker: speakerName(row), text: shown.text, ...(shown.cut ? { truncated: true as const } : {}) };
      });
      if (notes.truncated && rows.length) {
        const rowOut = rows[rows.length - 1]! as { truncated?: true };
        rowOut.truncated = true;
      }
      const more = baseMore || notes.trimmed || notes.rest.length > 0;
      const out: Record<string, unknown> = { rows, more, checking: notes.checking, unavailable: notes.unavailable };
      const lines = [...(notes.checking > 0 ? [CHECKING_LINE] : []), ...(notes.unavailable > 0 ? [unavailableLine(notes.unavailable)] : [])];
      if (lines.length) out.notes = lines;
      return out;
    },
  };
}

// ── Fitting the envelope (rule 21) ──────────────────────────────────────────────────────────────────────────────────

/** Drops rows from the end the plan names until the answer fits the budget; one row that cannot fit is cut with `truncated`. Pure: nothing is
 * released here. The dropped rows come back as `rest`. */
export function fit(plan: Plan, rows: Seen[], notes: { checking: number; unavailable: number }): { body: Record<string, unknown>; kept: Seen[] } {
  let kept = rows.slice(0, plan.limit), trimmed = false, rest: Seen[] = rows.slice(plan.limit);
  const make = (truncated: boolean) => plan.build(kept, { ...notes, trimmed, rest, truncated });
  let body = make(false);
  const dropIndex = (): number => {
    if (plan.trim === "start") return 0;
    if (plan.trim === "end") return kept.length - 1;
    const anchor = kept.findIndex(({ row }) => row.id === plan.anchorId);
    return anchor < 0 || anchor >= kept.length / 2 ? 0 : kept.length - 1;
  };
  while (envelopeBytes(body) > THREAD_ENVELOPE_BUDGET && kept.length > 1) {
    const [gone] = kept.splice(dropIndex(), 1);
    rest = [gone!, ...rest]; trimmed = true;
    body = make(false);
  }
  if (envelopeBytes(body) > THREAD_ENVELOPE_BUDGET && kept.length === 1) {
    // one row that cannot fit: shorten its words until it does
    const only = kept[0]!;
    let points = Array.from(only.row.text);
    while (points.length > 1 && envelopeBytes(body) > THREAD_ENVELOPE_BUDGET) {
      points = points.slice(0, Math.max(1, Math.floor(points.length / 2)));
      kept = [{ threadId: only.threadId, row: Object.freeze({ ...only.row, text: points.join("") }) as BotRow }];
      body = make(true);
    }
  }
  return { body, kept };
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────────────────────────────

const refuse = (host: ThreadRecallHost, status: number, error: string): void => host.respond(status, { error });

/** Rule 12: the turn is the very object the dispatch of this generation opened, and every other fact about the generation still agrees. */
function bindTurn(host: ThreadRecallHost): RunningTurnLineage | null {
  const { claim } = host;
  const lineage = host.lineage();
  if (!lineage || lineage.generation !== claim.generation || lineage.botId !== claim.botId) return null;
  if (!isTurnOpen(lineage.turn) || !host.active() || host.ownerGeneration() !== claim.generation) return null;
  return lineage;
}

const refsOf = (rows: ReadonlyArray<Seen>): LineageRef[] => rows.map(({ threadId, row }) => ({ kind: "line" as const, threadId, messageId: row.id }));
const shownOf = (rows: ReadonlyArray<Seen>): ShownLine[] => rows.map(({ threadId, row }) => ({ threadId, id: row.id, role: row.role }));

/** Serves one thread tool call. `body` is the parsed request body; the answer goes out through `host.respond`, exactly once. */
export async function threadRecallRoute(tool: ThreadRecallTool, body: unknown, access: MemoryAccess, host: ThreadRecallHost): Promise<void> {
  const state = host.state();
  if (!state || host.ownerGeneration() !== host.claim.generation) return refuse(host, 409, NOT_ACTIVE_LINE);
  // rule 18: no memory-mode check here. The thread tools answer in off, paused and capture; eligibility is rules 1 and 2 plus the rule 12 binding.
  // rule 14: counted before any read, empty answers included
  state.calls += 1;
  if (state.calls > THREAD_CALLS_PER_TURN) return refuse(host, 409, CALLS_LINE);

  let args: z.infer<typeof searchArgs> | z.infer<typeof listArgs> | z.infer<typeof readArgs>, cutoff: number | undefined;
  try {
    args = (tool === "thread_search" ? searchArgs : tool === "thread_list" ? listArgs : readArgs).parse(body ?? {});
    cutoff = tool === "thread_read" ? undefined : beforeMs((args as { before?: string }).before);
  } catch (error) {
    const problem = error instanceof z.ZodError ? error.issues.slice(0, 4).map(issue => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ") : error instanceof Error ? error.message : "bad request";
    return refuse(host, 400, `Thread request rejected: ${problem}`);
  }

  const set = recallThreads(access);
  if (!set.length) return host.respond(200, { status: NO_THREADS_STATUS, notice: NO_THREADS_LINE });
  // rule 12, once after the body is read
  if (!bindTurn(host)) return refuse(host, 409, NOT_ACTIVE_LINE);

  let plan: Plan | "not-reachable", listed: ListedThread[] | undefined, listHeld = false;
  if (tool === "thread_search") plan = planSearch(access, set, args as z.infer<typeof searchArgs>, cutoff);
  else if (tool === "thread_read") plan = planRead(access, set, args as z.infer<typeof readArgs>, state.released);
  else {
    const listing = listThreads(access, set, cutoff);
    listed = listing.threads; listHeld = listing.held;
    plan = { rows: [], limit: PAGE, checking: 0, unavailable: 0, trim: "start", build: () => ({}) };
  }
  if (plan === "not-reachable") return host.respond(200, { rows: [], status: "not-reachable" });

  // the last await: the loop runs here, and anything may change before the release block below
  await host.yield();

  // ── one synchronous block: re-check, revalidate, seal, persist, add to the running turn, release ──
  const lineage = bindTurn(host);
  if (!lineage) return refuse(host, 409, NOT_ACTIVE_LINE);

  // rule 23a: the audience and the door verdicts again, for exactly the rows about to leave
  const fresh = host.access();
  const freshSet = fresh ? recallThreads(fresh) : [];
  let checking = plan.checking, unavailable = plan.unavailable;
  let candidates = plan.rows;
  if (candidates.length) {
    candidates = fresh ? candidates.filter(({ threadId }) => freshSet.includes(threadId)) : [];
    if (fresh && candidates.length) {
      const again = rejudge(fresh, candidates, plan.needle);
      candidates = again.shown;
      checking += again.checking; unavailable += again.unavailable;
    }
  }
  const releasingList = tool === "thread_list" && freshSet.length > 0 && listed !== undefined && listed.length > 0;
  const outcome = tool === "thread_list"
    ? { body: listedBody(fresh && freshSet.length ? relisted(fresh.botId, listed!.filter(thread => freshSet.includes(thread.threadId)), cutoff) : [], listHeld, !fresh), kept: [] as Seen[] }
    : fit(plan, candidates, { checking, unavailable });
  const released = outcome.kept;
  const releases = tool === "thread_list" ? releasingList && (outcome.body.threads as unknown[]).length > 0 : released.length > 0;

  // rule 13: the sources preflight counts only the rows that will leave: after the revalidation above, the page cut and the envelope trim,
  // still inside this synchronous block and before anything is persisted
  if (released.length) {
    const room = sourcesRoom(lineage, shownOf(released));
    const sources = lineage.sources;
    if (sources === undefined || sources === "over" || sources.length + room > TURN_SOURCES_MAX) return refuse(host, 409, OUT_OF_ROOM_LINE);
  }

  // an empty answer writes nothing: no seal, no persistence
  if (releases) {
    if (!state.sealed) {
      try { host.seal(); } catch { return refuse(host, 409, UNRECORDED_LINE); }
      state.sealed = true;
    }
    const refs = refsOf(released);
    if (refs.length) {
      try { transaction(tx => { if (!recordTurnReads(tx, lineage.turn, refs)) throw new Error("thread reads not recorded"); }); }
      catch { return refuse(host, 409, UNRECORDED_LINE); }
      const lines = shownOf(released);
      addTurnParents(lineage.turn, refs);
      addSourcesToRunningTurn(lineage, lines);
      addRootsToRunningTurn(host.claim.threadId, lineage, shownLinesRoots(LineageAllowance.tool(), lines, undefined, host.claim.threadId));
      for (const { threadId, row } of released) state.released.set(row.id, threadId);
    }
  }
  host.respond(200, outcome.body);
}

/** Release time (rule 23a for thread_list): every listed thread's lastAt asked again, so a line forgotten since the plan never gives its time;
 * a thread with no remembered line left (or one that cannot be told) is dropped. */
function relisted(botId: string, threads: ListedThread[], cutoff: number | undefined): ListedThread[] {
  const out: Array<ListedThread & { last: number }> = [];
  for (const thread of threads) {
    const last = newestRememberedAt(thread.threadId);
    if (last === null || (cutoff !== undefined && last >= cutoff)) continue;
    const created = threadInfo(botId, thread.threadId).createdAt;
    out.push({ ...thread, createdAt: created ? iso(created) : iso(last), lastAt: iso(last), last });
  }
  out.sort((a, b) => b.last - a.last || a.threadId.localeCompare(b.threadId));
  return out.map(({ last: _last, ...thread }) => thread);
}

function listedBody(threads: ListedThread[], held: boolean, gone: boolean): Record<string, unknown> {
  if (gone) return { threads: [], oldest_at: null, more: false };
  let kept = [...threads], trimmed = false;
  const make = (): Record<string, unknown> => ({ threads: kept, oldest_at: kept.length ? kept[kept.length - 1]!.lastAt : null, more: held || trimmed });
  let body = make();
  while (envelopeBytes(body) > THREAD_ENVELOPE_BUDGET && kept.length > 1) { kept = kept.slice(0, -1); trimmed = true; body = make(); }
  return body;
}
