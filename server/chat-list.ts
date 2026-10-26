// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** All chats (CHATS-FINDABILITY-DESIGN 3, slice 1): one page of the owner's
 * chats across every bot and channel, newest activity first.
 *
 * Built from the task records in memory and the store's newest-message time
 * per thread (kept by every message write), so a page never reads a
 * transcript: the work of a request follows the number of chats, never the
 * number of messages, and what goes on the wire is one page (50 by default,
 * 200 at most). The page is picked in one pass that keeps only the best
 * `limit + 1` rows after the cursor, so no list of every chat is sorted or
 * copied. No schema, no background job. */

export const CHAT_PAGE_DEFAULT = 50;
export const CHAT_PAGE_MAX = 200;

export interface ChatSourceTask {
  threadId: string;
  title: string;
  createdAt: number;
  pinned?: boolean;
  unread?: boolean;
  unreadCount?: number;
  channelProjectDesk?: { groupId: string; archivedAt?: number };
}

export interface ChatSourceBot {
  id: string;
  threadId: string;
  name: string;
  createdAt?: number;
  hidden?: boolean;
  tasks?: readonly ChatSourceTask[];
}

export interface ChatSourceGroup {
  id: string;
  threadId: string;
  name: string;
  createdAt: number;
  unread?: boolean;
  dm?: boolean;
  hidden?: boolean;
  channelProject?: unknown;
  tasks?: readonly ChatSourceTask[];
}

export interface ChatRoutineRef { routineId: string; routineName: string }

export interface ChatRow {
  threadId: string;
  title: string;
  createdAt: number;
  /** newest message time; absent when the chat has no messages yet */
  lastActivityAt?: number;
  botId?: string;
  groupId?: string;
  /** the channel this chat belongs to (a channel task, or a bot's desk in a project) */
  place?: { kind: "project" | "channel"; groupId: string; name: string };
  pinned?: true;
  unread?: true;
  /** the chat of an archived bot, an archived channel or a closed project */
  archived?: true;
  /** a routine run's own conversation */
  routine?: ChatRoutineRef;
}

export interface ChatFilters {
  botId?: string;
  /** a channel or project id, or "direct" for chats that sit in no channel */
  groupId?: string;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  /** include routine runs (left out by default) */
  routines?: boolean;
  /** title contains, case-insensitive */
  q?: string;
}

export interface ChatSource {
  bots: readonly ChatSourceBot[];
  groups: readonly ChatSourceGroup[];
  /** newest message time of a thread (Store.lastActivityAt: an in-memory map, read once per thread) */
  lastActivityAt: (threadId: string) => number | undefined;
  /** which routine a thread is a run of, if any */
  routineOf: (threadId: string, owner: { botId?: string; groupId?: string }) => ChatRoutineRef | undefined;
  /** false off the desktop: archived bots, archived channels and bot-to-bot rooms are never listed */
  desktop: boolean;
}

export interface ChatPage {
  chats: ChatRow[];
  /** Pinned portion of this page; both arrays together respect the page limit. */
  pinned?: ChatRow[];
  /** ask with `before=` this for the next page; null when this is the last */
  next: string | null;
  /** how many chats match the filters (pinned included) */
  total: number;
}

/** Request work in task records. Tests separately measure bounded renderer work. No transcript is visited. */
export const chatListWork = { requests: 0, rowsVisited: 0 };

const sortTime = (row: Pick<ChatRow, "lastActivityAt" | "createdAt">) => row.lastActivityAt ?? row.createdAt;

/** Newest first; the thread id breaks a tie so a page boundary is stable. */
function newerFirst(a: ChatRow, b: ChatRow): number {
  return Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || sortTime(b) - sortTime(a) || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);
}

export function encodeChatCursor(row: Pick<ChatRow, "lastActivityAt" | "createdAt" | "threadId" | "pinned">): string {
  return `${row.pinned ? 1 : 0}:${sortTime(row)}:${row.threadId}`;
}

export function decodeChatCursor(cursor: string): { at: number; threadId: string; pinned?: true } | null {
  const match = /^([01]):(\d+(?:\.\d+)?):([\w-]+)$/.exec(cursor);
  if (!match) return null;
  const at = Number(match[2]);
  return Number.isFinite(at) ? { at, threadId: match[3]!, ...(match[1] === "1" ? { pinned: true as const } : {}) } : null;
}

/** Read the route's query into filters; unknown or empty values mean "any". */
export function chatFiltersFromQuery(params: URLSearchParams): ChatFilters {
  const flag = (name: string) => params.get(name) === "1";
  const text = (name: string) => params.get(name)?.trim() || undefined;
  return {
    botId: text("bot"),
    groupId: text("group"),
    pinned: flag("pinned"),
    unread: flag("unread"),
    archived: flag("archived"),
    routines: flag("routines"),
    q: text("q")?.toLowerCase(),
  };
}

/** Insert into a small newest-first array, keeping at most `cap` rows. */
function keepBest(best: ChatRow[], row: ChatRow, cap: number): void {
  if (best.length >= cap && newerFirst(row, best[best.length - 1]!) >= 0) return;
  let lo = 0, hi = best.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newerFirst(best[mid]!, row) <= 0) lo = mid + 1;
    else hi = mid;
  }
  best.splice(lo, 0, row);
  if (best.length > cap) best.pop();
}

/** One page of chats. `before` is a cursor this function gave; null for the first page. Returns null for a cursor it did not give. */
export function pageChats(source: ChatSource, filters: ChatFilters, before: string | null, limit: number): ChatPage | null {
  const from = before === null ? null : decodeChatCursor(before);
  if (before !== null && !from) return null;
  const size = Math.max(1, Math.min(CHAT_PAGE_MAX, Math.trunc(limit) || CHAT_PAGE_DEFAULT));
  chatListWork.requests++;
  const best: ChatRow[] = [];
  let total = 0;
  const after = from ? { createdAt: from.at, threadId: from.threadId, pinned: from.pinned } as ChatRow : null;

  const withActivity = (row: ChatRow): ChatRow => {
    const at = source.lastActivityAt(row.threadId);
    return at === undefined ? row : { ...row, lastActivityAt: at };
  };
  const consider = (row: ChatRow) => {
    chatListWork.rowsVisited++;
    if (!chatMatches(row, filters)) return;
    total++;
    // the time is looked up only for a chat that passed every filter
    const timed = withActivity(row);
    if (after && newerFirst(timed, after) <= 0) return;
    keepBest(best, timed, size + 1);
  };

  visitChats(source, consider);
  const more = best.length > size;
  const page = more ? best.slice(0, size) : best;
  return {
    chats: filters.pinned ? page : page.filter(row => !row.pinned),
    ...(!filters.pinned ? { pinned: page.filter(row => row.pinned) } : {}),
    next: more ? encodeChatCursor(page[page.length - 1]!) : null,
    total,
  };
}

/** Apply the same record filters before message search's LIMIT, including tasks outside the client window. */
export function chatSearchThreads(source: ChatSource, filters: ChatFilters): string[] {
  const ids: string[] = [];
  const recordFilters = { ...filters, q: undefined };
  visitChats(source, row => { if (chatMatches(row, recordFilters)) ids.push(row.threadId); });
  return ids;
}

function chatMatches(row: ChatRow, filters: ChatFilters): boolean {
  if (Boolean(row.archived) !== Boolean(filters.archived)) return false;
  if (row.routine && !filters.routines) return false;
  if (filters.pinned && !row.pinned || filters.unread && !row.unread) return false;
  if (filters.botId && row.botId !== filters.botId) return false;
  if (filters.groupId && (filters.groupId === "direct" ? row.place !== undefined : row.place?.groupId !== filters.groupId)) return false;
  return !filters.q || row.title.toLowerCase().includes(filters.q.toLowerCase());
}

function visitChats(source: ChatSource, consider: (row: ChatRow) => void): void {
  const groups = new Map(source.groups.map(group => [group.id, group]));

  const placeOf = (groupId: string | undefined): ChatRow["place"] => {
    const group = groupId ? groups.get(groupId) : undefined;
    if (!group || group.dm) return undefined;
    return { kind: group.channelProject ? "project" : "channel", groupId: group.id, name: group.name };
  };

  for (const bot of source.bots) {
    if (bot.hidden && !source.desktop) continue;
    const tasks = bot.tasks?.length ? bot.tasks : [{ threadId: bot.threadId, title: bot.name, createdAt: bot.createdAt ?? 0 }];
    for (const task of tasks) {
      const desk = task.channelProjectDesk;
      const deskGroup = desk ? groups.get(desk.groupId) : undefined;
      const archived = bot.hidden === true || desk?.archivedAt !== undefined || deskGroup?.hidden === true;
      if (archived && !source.desktop) continue;
      const routine = source.routineOf(task.threadId, { botId: bot.id });
      const place = placeOf(desk?.groupId);
      consider({
        threadId: task.threadId,
        title: task.title,
        createdAt: task.createdAt,
        botId: bot.id,
        ...(place ? { place } : {}),
        ...(task.pinned ? { pinned: true as const } : {}),
        ...(task.unread || (task.unreadCount ?? 0) > 0 ? { unread: true as const } : {}),
        ...(archived ? { archived: true as const } : {}),
        ...(routine ? { routine } : {}),
      });
    }
  }
  for (const group of source.groups) {
    // a bot-to-bot room is the bots' exchange, not one of the owner's chats
    if (group.dm) continue;
    if (group.hidden && !source.desktop) continue;
    const tasks = group.tasks?.length ? group.tasks : [{ threadId: group.threadId, title: group.name, createdAt: group.createdAt, unread: group.unread }];
    const place = placeOf(group.id);
    for (const task of tasks) {
      const routine = source.routineOf(task.threadId, { groupId: group.id });
      consider({
        threadId: task.threadId,
        title: task.title,
        createdAt: task.createdAt,
        groupId: group.id,
        ...(place ? { place } : {}),
        ...(task.pinned ? { pinned: true as const } : {}),
        ...(task.unread || (task.unreadCount ?? 0) > 0 ? { unread: true as const } : {}),
        ...(group.hidden ? { archived: true as const } : {}),
        ...(routine ? { routine } : {}),
      });
    }
  }
}
