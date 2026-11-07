import { useChatResource } from "@/lib/chat-previews";
import { chatsEligible, compareGen, useChatsGen, type ChatsGen } from "@/lib/chats-gen";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Chats door at 50+ chats (UX L6B, UX-FIRSTRUN-SCALE-1012.md 2.2): Bots,
// Projects, Channels and Archived, each collapsible and remembered. One row
// per bot or place ("Nova · Morning brief · 08:02"); "3 chats" opens the rest
// under it; "14 older" folds what is past 30 days; Archived starts folded with
// its count and loads its chats only when opened. Loaded with All chats, which
// is itself a lazy chunk, so the first paint does not carry it.
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { chatTime, chatsRequestPath, chatTitle, type ChatPage, type ChatRow } from "@/lib/all-chats";
import {
  chatsSections,
  chatsSectionTitle,
  loadFoldedChatsSections,
  saveFoldedChatsSections,
  type ChatOwnerRow,
  type ChatsSectionKey,
  type ChatsSectionView,
} from "@/lib/chats-sections";
import { cn } from "@/lib/cn";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export interface AllChatsSectionsProps {
  rows: readonly ChatRow[];
  listGen?: ChatsGen | null;
  now: number;
  waiting: (row: ChatRow) => number;
  ownerName: (row: ChatRow) => string;
  avatar: (row: ChatRow) => ReactNode;
  time: (at: number) => string;
  renderChat: (row: ChatRow, eligible: boolean) => ReactNode;
  onOpenRow: (row: ChatRow) => void;
  /** GET a chats page; the archived count and rows come from here */
  fetchPage: (path: string) => Promise<ChatPage>;
  /** tests: start with these sections folded instead of the remembered ones */
  folded?: readonly ChatsSectionKey[];
  archivedCount?: number;
  onArchivedCount?: (count: number) => void;
  archived?: { total: number; rows: ChatRow[]; gen?: ChatsGen };
  /** tests: owner rows and older folds open at start, by key */
  expanded?: readonly string[];
}

const retainArchivedCount = (page: ChatPage): ChatPage => ({ total: page.total, chats: [], next: null });

export function AllChatsSections(props: AllChatsSectionsProps) {
  const { rows, now, waiting, fetchPage } = props;
  const [folded, setFolded] = useState<ChatsSectionKey[]>(() => [...(props.folded ?? loadFoldedChatsSections())]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(props.expanded));
  const archivedFolded = folded.includes("archived");
  const proof = useChatsGen();
  const [supplied, setSupplied] = useState(() => props.archived ? { ...props.archived, gen: props.archived.gen } : null);
  const suppliedCurrent = supplied && supplied.gen && (!proof.known || compareGen(supplied.gen, proof.known) === "same");
  useEffect(() => { if (supplied && !suppliedCurrent) setSupplied(null); }, [supplied, suppliedCurrent]);
  const archivedPage = useChatResource<ChatPage>(suppliedCurrent ? null : chatsRequestPath({ archived: true }, null, "", archivedFolded ? 1 : 50), fetchPage, 0, retainArchivedCount);
  const [localCount, setLocalCount] = useState(props.archived?.total ?? 0);
  useEffect(() => { if (archivedPage.data) { setLocalCount(archivedPage.data.total); props.onArchivedCount?.(archivedPage.data.total); } }, [archivedPage.data, props.onArchivedCount]);
  const archivedEligible = suppliedCurrent ? chatsEligible(supplied.gen, proof) : archivedPage.eligible;
  const archived = { total: props.archivedCount ?? localCount, rows: archivedFolded ? [] : suppliedCurrent ? supplied.rows : archivedPage.data?.chats ?? [] };

  const sections = chatsSections([...rows, ...(archived.rows ?? [])], now, waiting, archived.total);
  const toggleSection = (key: ChatsSectionKey) => setFolded((before) => {
    const next = before.includes(key) ? before.filter((entry) => entry !== key) : [...before, key];
    saveFoldedChatsSections(next);
    return next;
  });
  const toggle = (key: string) => setOpen((before) => {
    const next = new Set(before);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const ownerRow = (owner: ChatOwnerRow) => {
    const latest = owner.latest;
    const more = owner.chats.length > 1;
    const expanded = open.has(owner.key);
    return (
      <li key={owner.key} data-chats-owner={owner.key}>
        <div className="flex items-start">
          <button type="button" data-chat-row={latest.threadId} onClick={() => props.onOpenRow(latest)}
            className={cn("grid min-w-0 flex-1 grid-cols-[28px_1fr_auto] items-start gap-x-3 rounded-lg py-2 pl-3 pr-2 text-left hover:bg-raised/60", focusRing)}>
            {props.avatar(latest)}
            <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
              <span className="max-w-[10rem] shrink-0 truncate text-ink">{props.ownerName(latest)}</span>
              <span aria-hidden="true" className="text-ink-secondary">·</span>
              <span dir="auto" className={cn("min-w-0 truncate text-ink-secondary", latest.unread && "font-semibold text-ink")}>{chatTitle(latest.title, Boolean(latest.routine))}</span>
            </span>
            <span className="flex items-center gap-1.5 pt-0.5">
              {owner.waiting > 0 && <span data-chats-waiting aria-label={`${owner.waiting} waiting`} className="min-w-4 rounded-full bg-warning/15 px-1 text-center text-[10px] font-semibold leading-4 text-warning">{owner.waiting}</span>}
              <time dateTime={new Date(chatTime(latest)).toISOString()} className="text-[12px] tabular-nums text-ink-secondary">{props.time(chatTime(latest))}</time>
            </span>
          </button>
          {more && (
            <button type="button" aria-expanded={expanded} data-chats-more={owner.key} onClick={() => toggle(owner.key)}
              className={cn("mt-1 flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink", focusRing)}>
              {`${owner.chats.length} chats`}
              <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
            </button>
          )}
        </div>
        {more && expanded && <ul aria-label={`Chats with ${props.ownerName(latest)}`}>{owner.chats.map((chat) => props.renderChat(chat, chat.archived ? archivedEligible : chatsEligible(props.listGen, proof)))}</ul>}
      </li>
    );
  };

  const section = (view: ChatsSectionView) => {
    const isFolded = folded.includes(view.key);
    const olderKey = `older:${view.key}`;
    const Chevron = isFolded ? ChevronRight : ChevronDown;
    return (
      <section key={view.key} data-chats-section={view.key} aria-labelledby={`chats-section-${view.key}`}>
        <h3 id={`chats-section-${view.key}`} className="sticky top-0 z-10 bg-panel px-1 pt-2">
          <button type="button" aria-expanded={!isFolded} onClick={() => toggleSection(view.key)}
            className={cn("flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-secondary hover:bg-raised/50", focusRing)}>
            <Chevron size={12} aria-hidden="true" />
            {chatsSectionTitle(view, archived.total)}
          </button>
        </h3>
        {!isFolded && (
          <ul>
            {view.rows.map(ownerRow)}
            {view.older.length > 0 && (
              <li>
                <button type="button" aria-expanded={open.has(olderKey)} data-chats-older={view.key} onClick={() => toggle(olderKey)}
                  className={cn("flex min-h-9 w-full items-center gap-1 rounded-lg px-3 text-left text-[12.5px] text-ink-secondary hover:bg-raised/60 hover:text-ink", focusRing)}>
                  {open.has(olderKey) ? "Show less" : `${view.older.length} older`}
                  <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform", open.has(olderKey) && "rotate-180")} />
                </button>
                {open.has(olderKey) && <ul>{view.older.map(ownerRow)}</ul>}
              </li>
            )}
          </ul>
        )}
      </section>
    );
  };

  return <div data-chats-sections>{sections.map(section)}</div>;
}
