import { t } from "./i18n";
import { api } from "@/state/store";
import { chatsGenAnswer, chatsGenSession, chatsGenSnapshot, compareGen, type ChatsGen } from "./chats-gen";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All chats (CHATS-FINDABILITY-DESIGN 3, slice 1): what the view asks the
// server for, how a page joins what is already shown, and how the rows are
// grouped. Pure: "now", the time zone and the locale are injected. Every
// function here works on the rows the view holds (pages of 50), never on the
// owner's whole history, so a render costs the same with 30 chats or 30,000.
import { dateBucket, readableTaskTitle, UNTITLED_TASK_TITLE } from "@/lib/task-list";
import type { SearchHit } from "@/lib/search-hit";

/** One chat as GET /api/chats returns it (server/chat-list.ts ChatRow). */
export interface ChatRow {
  threadId: string;
  title: string;
  createdAt: number;
  lastActivityAt?: number;
  snippet?: string;
  lastRole?: string | null;
  lastFrom?: string | null;
  botId?: string;
  groupId?: string;
  place?: { kind: "project" | "channel"; groupId: string; name: string };
  pinned?: true;
  unread?: true;
  archived?: true;
  routine?: { routineId: string; routineName: string };
}

export interface ChatPage {
  gen?: ChatsGen;
  chats: ChatRow[];
  pinned?: ChatRow[];
  next: string | null;
  total: number;
  partial?: boolean;
}

export interface ChatFilters {
  date?: "today" | "week" | "month" | "custom";
  dateFrom?: number;
  dateTo?: number;
  botId?: string;
  /** a channel or project id, or "direct" */
  groupId?: string;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /** include routine runs (folded) */
  routines?: boolean;
}

export const CHAT_PAGE_SIZE = 50;
/** Message search starts at three characters, as the sidebar's (SearchResults MIN_QUERY). */
export const CHAT_SEARCH_MIN = 3;
export const CHAT_SEARCH_LIMIT = 40;

/** Keep stored titles unchanged; the ordinary chat placeholder uses the UI noun. */
export function chatTitle(title: string, routine = false): string {
  return !routine && title === UNTITLED_TASK_TITLE ? "New chat" : readableTaskTitle(title).text;
}

/** The /api/chats request for one page. */
export function chatsRequestPath(filters: ChatFilters, before: string | null, q = "", limit = CHAT_PAGE_SIZE): string {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (before) params.set("before", before);
  if (filters.dateFrom !== undefined) params.set("date_from", String(filters.dateFrom));
  if (filters.dateTo !== undefined) params.set("date_to", String(filters.dateTo));
  if (filters.botId) params.set("bot", filters.botId);
  if (filters.groupId) params.set("group", filters.groupId);
  if (filters.pinned) params.set("pinned", "1");
  if (filters.unread) params.set("unread", "1");
  if (filters.archived) params.set("archived", "1");
  if (filters.routines) params.set("routines", "1");
  const title = q.trim();
  if (title) params.set("q", title);
  return `/api/chats?${params.toString()}`;
}

/** The message search for All chats: the existing /api/search, asked for the chats view so a forgotten line is never a hit. */
export function chatsSearchPath(q: string, filters: ChatFilters = {}, limit = CHAT_SEARCH_LIMIT, before?: string | null): string {
  const params = new URLSearchParams(chatsRequestPath(filters, null, "", limit).split("?")[1]);
  params.delete("limit");
  params.set("group_by", "thread");
  if (before) params.set("before", before);
  const suffix = params.toString();
  return `/api/search?q=${encodeURIComponent(q.trim())}&limit=${limit}&view=chats${suffix ? `&${suffix}` : ""}`;
}

/** A held page, with pinned rows separated for its heading. */
export interface HeldChats {
  pinned: ChatRow[];
  chats: ChatRow[];
  next: string | null;
  total: number;
  partial?: boolean;
}

export const NO_CHATS: HeldChats = { pinned: [], chats: [], next: null, total: 0 };

/** Join a page onto what is held. A chat that moved between pages (new activity) is kept where it was first shown. */
export function appendChatPage(held: HeldChats, page: ChatPage, first: boolean): HeldChats {
  const base = first ? NO_CHATS : held;
  const seen = new Set<string>();
  for (const row of base.pinned) seen.add(row.threadId);
  for (const row of base.chats) seen.add(row.threadId);
  const pinned: ChatRow[] = [...base.pinned];
  for (const row of page.pinned ?? []) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    pinned.push(row);
  }
  const chats = [...base.chats];
  for (const row of page.chats) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    chats.push(row);
  }
  return { pinned, chats, next: page.next, total: page.total, partial: page.partial };
}

export const chatTime = (row: Pick<ChatRow, "lastActivityAt" | "createdAt">) => row.lastActivityAt ?? row.createdAt;

export type ChatEntry =
  | { type: "chat"; row: ChatRow }
  | { type: "runs"; id: string; routineName: string; runs: ChatRow[]; latest: ChatRow };

export interface ChatSection {
  key: string;
  label: string;
  entries: ChatEntry[];
}

interface Clock { timeZone?: string; locale?: string }

/** Pinned first, then Today, Yesterday, Previous 7 days, Earlier this month, then one group per month (task-list dateBucket), keyed on
 * the last message. Runs of one routine within a group fold into one row; a fold stands for two or more. */
export function groupChats(held: Pick<HeldChats, "pinned" | "chats">, now: number, clock: Clock = {}): ChatSection[] {
  const sections: ChatSection[] = [];
  const pinned = [...held.pinned, ...held.chats.filter(row => row.pinned)];
  if (pinned.length) sections.push({ key: "pinned", label: "Pinned", entries: fold(pinned) });
  let current: { key: string; label: string; rows: ChatRow[] } | null = null;
  const flush = () => { if (current?.rows.length) sections.push({ key: current.key, label: current.label, entries: fold(current.rows) }); };
  for (const row of held.chats) {
    if (row.pinned) continue;
    const bucket = dateBucket(chatTime(row), now, clock);
    if (!current || current.key !== bucket.key) {
      flush();
      current = { key: bucket.key, label: bucket.label, rows: [] };
    }
    current.rows.push(row);
  }
  flush();
  return sections;
}

function fold(rows: readonly ChatRow[]): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const runs = new Map<string, number>();
  for (const row of rows) {
    const key = row.routine ? `${row.botId ?? row.groupId}:${row.routine.routineId}` : undefined;
    const index = key ? runs.get(key) : undefined;
    const last = index === undefined ? undefined : entries[index];
    if (row.routine) {
      if (last?.type === "runs") { last.runs.push(row); continue; }
      if (last?.type === "chat" && last.row.routine?.routineId === row.routine.routineId) {
        entries[index!] = { type: "runs", id: key!, routineName: row.routine.routineName, runs: [last.row, row], latest: last.row };
        continue;
      }
    }
    if (key) runs.set(key, entries.length);
    entries.push({ type: "chat", row });
  }
  return entries;
}

/** One row per chat for message matches: the newest hit stands for the chat, with how many matched. */
export interface ChatHitRow {
  threadId: string;
  hit: SearchHit;
  count: number;
  countComplete?: boolean;
}

/** What the view knows about a thread it did not load as a row: the marks the client already holds (pinned and unread chats always ride
 * a bot's window), whether its bot or channel is archived, and whether it is a routine run. */
export interface ThreadFacts {
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  routine?: boolean;
  /** the channel or project the thread belongs to, when known */
  groupId?: string;
}

/** Fold /api/search hits into one row per chat and keep the ones the filters allow. Hits arrive newest first, so the first per thread wins. */
export function foldChatHits(hits: readonly SearchHit[], filters: ChatFilters, facts: (hit: SearchHit) => ThreadFacts): ChatHitRow[] {
  const rows = new Map<string, ChatHitRow>();
  for (const hit of hits) {
    const held = rows.get(hit.threadId);
    if (held) { held.count++; continue; }
    const known = facts(hit);
    if (known.archived ? !filters.archived : filters.archived) continue;
    if (known.routine && !filters.routines) continue;
    if (filters.pinned && !known.pinned) continue;
    if (filters.unread && !known.unread) continue;
    if (filters.botId && hit.botId !== filters.botId) continue;
    if (filters.groupId) {
      const place = hit.groupId ?? known.groupId;
      if (filters.groupId === "direct" ? place !== undefined : place !== filters.groupId) continue;
    }
    rows.set(hit.threadId, { threadId: hit.threadId, hit, count: hit.hits ?? 1, countComplete: hit.countComplete === true });
  }
  return [...rows.values()];
}

/** How many filters are on, for the "Clear filters" control. */
export function activeFilterCount(filters: ChatFilters): number {
  return [filters.botId, filters.groupId, filters.pinned, filters.unread, filters.archived, filters.routines, filters.date].filter(Boolean).length;
}

/** Calendar dates use local midnight; the upper bound is exclusive, including
 * the entire last day even across a daylight-saving transition. */
export function chatDateRange(date: ChatFilters["date"], now: number): Pick<ChatFilters, "date" | "dateFrom" | "dateTo"> {
  if (!date || date === "custom") return { date, dateFrom: undefined, dateTo: undefined };
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (date === "week") start.setDate(start.getDate() - 6);
  if (date === "month") {
    const day = start.getDate(); start.setDate(1); start.setMonth(start.getMonth() - 1);
    start.setDate(Math.min(day, new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()));
  }
  const end = new Date(now); end.setHours(24, 0, 0, 0);
  return { date, dateFrom: start.getTime(), dateTo: end.getTime() };
}
export function chatDateInput(value: string, end = false): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const at = new Date(`${value}T00:00:00`);
  if (end) at.setDate(at.getDate() + 1);
  return Number.isFinite(at.getTime()) ? at.getTime() : undefined;
}
export function chatDateValue(at: number | undefined, end = false): string {
  if (at === undefined) return "";
  const day = new Date(at); if (end) day.setDate(day.getDate() - 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}
export function chatSnippet(row: Pick<ChatRow, "snippet" | "lastRole" | "lastFrom" | "groupId">): string {
  if (!row.snippet) return "";
  if (row.lastRole === "user") return t("chats.preview.you", { text: row.snippet });
  const prefix = row.groupId ? row.lastFrom : undefined;
  return prefix ? `${prefix}: ${row.snippet}` : row.snippet;
}

/** Answers never grant stream proof. Validate even if the requesting view left. */
export async function fetchChats<T extends { gen?: ChatsGen }>(path: string, expect: ChatsGen | null = null, request: (path: string) => Promise<T> = api): Promise<(T & { listGen: ChatsGen | null }) | null> {
  const session = chatsGenSession();
  const body = await request(path);
  const verdict = chatsGenAnswer(body.gen, session);
  if (verdict === "stale" || verdict === "newer") return null;
  if (expect && (verdict !== "ok" || !chatsGenSnapshot().known || compareGen(expect, chatsGenSnapshot().known!) !== "same")) return null;
  return { ...body, listGen: body.gen ?? null };
}
export const REFETCH_GAP_MS = 500;
/** One flight and one trailing request, with a fixed minimum start gap. */
export function scheduleRefetch(run: () => Promise<void>, delay = 0) {
  let active = true, flight = false, again = false, last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!active) return;
    again = true;
    if (flight || timer) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (!active) return;
      again = false; flight = true; last = Date.now();
      try { await run(); } finally { flight = false; if (active && again) schedule(); }
    }, Math.max(delay, last + REFETCH_GAP_MS - Date.now(), 0));
  };
  return { schedule, dispose() { active = false; again = false; flight = false; if (timer) clearTimeout(timer); timer = undefined; } };
}

export const incompleteChatCount = (count: number) => t(count === 1 ? "chats.matches.atLeastOne" : "chats.matches.atLeast", { count });
