// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Chats door at 50+ chats (UX L6B, UX-FIRSTRUN-SCALE-1012.md section 2.2).
// Past a page of chats the flat day list turns into four sections, Bots,
// Projects, Channels and Archived, each one row per bot or place: its latest
// chat and the time, with "3 chats" to open the rest. So 54 chats never show
// as 54 flat rows. Rows older than 30 days sit behind a fold at the bottom of
// each section, and a chat waiting on the owner rolls up into its section's
// header ("Bots · 4 waiting"). Pure: it works on the rows the view holds (one
// page), never on the whole history.
import { chatTime, type ChatRow } from "@/lib/all-chats";

export type ChatsSectionKey = "bots" | "projects" | "channels" | "archived";

export const CHATS_SECTIONS_MIN = 50;
export const CHATS_OLDER_MS = 30 * 24 * 3_600_000;

/** One bot or place: its newest chat stands for it. */
export interface ChatOwnerRow {
  key: string;
  latest: ChatRow;
  chats: ChatRow[];
  waiting: number;
}

export interface ChatsSectionView {
  key: ChatsSectionKey;
  label: string;
  rows: ChatOwnerRow[];
  /** owners whose newest chat is older than 30 days */
  older: ChatOwnerRow[];
  waiting: number;
}

const LABELS: Record<ChatsSectionKey, string> = { bots: "Bots", projects: "Projects", channels: "Channels", archived: "Archived" };

/** Which section a chat belongs to, and the bot or place that owns it there. */
export function chatHome(row: ChatRow): { section: ChatsSectionKey; owner: string } | null {
  if (row.archived) return { section: "archived", owner: row.place?.groupId ?? row.groupId ?? row.botId ?? row.threadId };
  if (row.place) return { section: row.place.kind === "project" ? "projects" : "channels", owner: row.place.groupId };
  if (row.groupId) return { section: "channels", owner: row.groupId };
  if (row.botId) return { section: "bots", owner: row.botId };
  return null;
}

/** Group held rows (pinned and the page) into the sections, owners by last activity. Empty sections are left out, except Archived when it has a count. */
export function chatsSections(
  rows: readonly ChatRow[],
  now: number,
  waiting: (row: ChatRow) => number,
  archivedTotal = 0,
): ChatsSectionView[] {
  const owners = new Map<string, { section: ChatsSectionKey; row: ChatOwnerRow }>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.threadId)) continue;
    seen.add(row.threadId);
    const home = chatHome(row);
    if (!home) continue;
    const key = `${home.section}:${home.owner}`;
    const held = owners.get(key);
    const owed = Math.max(0, waiting(row));
    if (!held) owners.set(key, { section: home.section, row: { key, latest: row, chats: [row], waiting: owed } });
    else {
      held.row.chats.push(row);
      held.row.waiting += owed;
    }
  }
  const sections = new Map<ChatsSectionKey, ChatsSectionView>();
  for (const key of Object.keys(LABELS) as ChatsSectionKey[]) sections.set(key, { key, label: LABELS[key], rows: [], older: [], waiting: 0 });
  for (const { section, row } of owners.values()) {
    row.chats.sort((a, b) => chatTime(b) - chatTime(a));
    row.latest = row.chats[0]!;
    const view = sections.get(section)!;
    (now - chatTime(row.latest) > CHATS_OLDER_MS ? view.older : view.rows).push(row);
    view.waiting += row.waiting;
  }
  const out: ChatsSectionView[] = [];
  for (const view of sections.values()) {
    view.rows.sort((a, b) => chatTime(b.latest) - chatTime(a.latest));
    view.older.sort((a, b) => chatTime(b.latest) - chatTime(a.latest));
    if (view.rows.length || view.older.length || (view.key === "archived" && archivedTotal > 0)) out.push(view);
  }
  return out;
}

type WaitingSource = { threadId?: string; activity?: string; tasks?: readonly { threadId?: string; activity?: string }[] };

/** Threads waiting on the owner: a chat's own state wins, a bot's state covers
 *  its main thread. Worked out once per store change, never per rendered row. */
export function chatsWaitingThreads(bots: readonly WaitingSource[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const bot of bots) {
    let mainHasTask = false;
    for (const task of bot.tasks ?? []) {
      if (task.threadId === bot.threadId) mainHasTask = true;
      if (task.threadId && task.activity === "waiting-on-you") out.add(task.threadId);
    }
    if (!mainHasTask && bot.threadId && bot.activity === "waiting-on-you") out.add(bot.threadId);
  }
  return out;
}

/** The section header: "Bots · 4 waiting", "Archived · 9". */
export function chatsSectionTitle(view: Pick<ChatsSectionView, "key" | "label" | "waiting">, archivedTotal = 0): string {
  if (view.key === "archived") return archivedTotal > 0 ? `${view.label} · ${archivedTotal}` : view.label;
  return view.waiting > 0 ? `${view.label} · ${view.waiting} waiting` : view.label;
}

/** Sections folded by default: Archived, until the owner opens it. */
export const CHATS_SECTIONS_FOLDED: readonly ChatsSectionKey[] = ["archived"];

const FOLD_KEY = "murage-chats-sections-folded";

/** Which sections the owner folded, remembered on this device. */
export function loadFoldedChatsSections(): ChatsSectionKey[] {
  try {
    const raw = window.localStorage.getItem(FOLD_KEY);
    if (!raw) return [...CHATS_SECTIONS_FOLDED];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((key): key is ChatsSectionKey => typeof key === "string" && key in LABELS) : [...CHATS_SECTIONS_FOLDED];
  } catch {
    return [...CHATS_SECTIONS_FOLDED];
  }
}

export function saveFoldedChatsSections(keys: readonly ChatsSectionKey[]): void {
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(keys));
  } catch {
    // storage can be blocked; Archived simply starts folded next time
  }
}

/** When the sections replace the day list: a long list, no search, no filter, the first page. */
export function chatsSectionsShown(total: number, query: string, filterCount: number, pageIndex = 0): boolean {
  return total >= CHATS_SECTIONS_MIN && !query.trim() && filterCount === 0 && pageIndex === 0;
}
