// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// All chats (CHATS-FINDABILITY-DESIGN 3, slice 1): every chat the owner has
// with any bot or channel, newest first, grouped by day, 50 a page. Opened
// from the sidebar's All chats row, Mod+Shift+K, or a chat list's Expand
// (then filtered to that bot or channel). A title search filters the list on
// the server; from three characters the existing message search runs too,
// one row per chat, and opening a match lands on the message.
//
// Privacy: rows join chat records with owner-only summary previews; the message search asks for the chats view, where a
// forgotten line is never a hit (server/message-db.ts excludeForgotten).
import { ChatThreadMatches } from "./ChatThreadMatches";
import { useChatResource, type HitsPage } from "@/lib/chat-previews";
import { chatsEligible, useChatsGen, type ChatsGen } from "@/lib/chats-gen";
import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Loader2, Pin, Search, X } from "lucide-react";
import { t } from "@/lib/i18n";
import { api, useStore, type Bot, type Group } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { OpenBotListButton } from "./OpenBotListButton";
import { cn } from "@/lib/cn";
import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { useRelativeNow } from "@/lib/relative-now";
import { escapeIsFree } from "@/lib/escape-layer";
import { formatListTime } from "@/lib/task-list";
import { chatsSectionsShown, chatsWaitingThreads } from "@/lib/chats-sections";
import { AllChatsSections } from "./AllChatsSections";
import {
  incompleteChatCount,
  CHAT_SEARCH_MIN,
  NO_CHATS,
  activeFilterCount,
  appendChatPage,
  chatTime,
  chatTitle,
  chatSnippet,
  chatDateRange,
  chatDateInput,
  chatDateValue,
  chatsRequestPath,
  chatsSearchPath,
  foldChatHits,
  groupChats,
  type ChatFilters,
  type ChatHitRow,
  type ChatPage,
  type ChatRow,
  type ChatSection,
  type HeldChats,
} from "@/lib/all-chats";

const DEBOUNCE_MS = 250;

type Owners = { bots: readonly Bot[]; groups: readonly Group[] };

export function AllChatsPage() {
  const { state, dispatch } = useStore();
  const scope = state.allChatsScope;
  const [filters, setFilters] = useState<ChatFilters>(() => ({ ...(scope?.botId ? { botId: scope.botId } : {}), ...(scope?.groupId ? { groupId: scope.groupId } : {}) }));
  useEffect(() => {
    setFilters({ ...(scope?.botId ? { botId: scope.botId } : {}), ...(scope?.groupId ? { groupId: scope.groupId } : {}) });
  }, [scope?.botId, scope?.groupId]);
  const [archiveCounts, setArchiveCounts] = useState<Record<string, number>>({});
  // Archived is a global request; folded and open limits share its count.
  const archiveScope = "archived";
  const rememberArchiveCount = useCallback((count: number) => setArchiveCounts(old => old[archiveScope] === count ? old : { ...old, [archiveScope]: count }), []);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const path = chatsRequestPath(filters, null, q);
  const list = useChatResource<ChatPage>(path, undefined, q ? DEBOUNCE_MS : 0);
  const searchPath = chatsSearchPath(q, filters);
  const search = useChatResource<HitsPage>(q.length >= CHAT_SEARCH_MIN ? searchPath : null, undefined, DEBOUNCE_MS);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  useEffect(() => { setCursors([null]); setPageIndex(0); }, [path, list.listGen?.epoch, list.listGen?.rev, list.replacement]);
  const held = useMemo(() => list.data ? appendChatPage(NO_CHATS, list.data, true) : NO_CHATS, [list.data]);
  const loading = list.loading ? list.data ? "more" : "first" : null;
  const failed = list.error ? String(list.error) : null;
  const hits = search.eligible ? search.data?.hits ?? null : null;
  const hitsNext = search.data?.next;
  const hitsPartial = search.data?.partial === true;
  const loadingHits = search.loading;
  const hitsFailed = search.error ? String(search.error) : null;
  const loadPage = (before: string | null, index: number) => {
    list.more(chatsRequestPath(filters, before, q), undefined, () => {
      setCursors(previous => [...previous.slice(0, index), before]); setPageIndex(index);
    });
  };
  const loadMore = () => { if (held.next) loadPage(held.next, pageIndex + 1); };
  const loadMoreHits = () => { if (hitsNext) search.more(chatsSearchPath(q, filters, 40, hitsNext), (old, page) => ({ ...page, hits: [...old.hits, ...page.hits.filter(hit => !old.hits.some(row => row.threadId === hit.threadId))] })); };
  const waitingThreads = useMemo(() => chatsWaitingThreads(state.bots), [state.bots]);
  const hitRows = hits ? foldChatHits(hits, {}, () => ({})) : null;

  const close = () => dispatch({ type: "closeAllChats" });
  const openRow = (row: ChatRow) => {
    if (row.groupId) {
      dispatch({ type: "select", id: row.groupId, threadId: row.threadId });
      const group = state.groups.find((candidate) => candidate.id === row.groupId);
      if (group && group.threadId !== row.threadId) dispatch({ type: "switchGroupTask", groupId: row.groupId, threadId: row.threadId });
      return;
    }
    if (row.botId) {
      dispatch({ type: "select", id: row.botId, threadId: row.threadId });
      dispatch({ type: "switchTask", botId: row.botId, threadId: row.threadId });
    }
  };
  const openHit = (hit: SearchHit) => {
    landOnSearchHit(hit, state, dispatch).catch((error: unknown) => dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  return (
    <AllChatsView
      archivedCount={archiveCounts[archiveScope]}
      onArchivedCount={rememberArchiveCount}
      waitingThreads={waitingThreads}
      bots={state.bots}
      groups={state.groups}
      filters={filters}
      onFilters={setFilters}
      query={query}
      onQuery={setQuery}
      held={held}
      listGen={list.listGen}
      loading={loading}
      failed={failed}
      hitRows={q.length >= CHAT_SEARCH_MIN ? hitRows : null}
      searchingMessages={q.length >= CHAT_SEARCH_MIN && hits === null && !hitsFailed}
      hitsPartial={hitsPartial}
      onMoreHits={hitsNext ? loadMoreHits : undefined}
      loadingHits={loadingHits}
      hitsFailed={hitsFailed}
      onOpenRow={openRow}
      onOpenHit={openHit}
      onRetry={list.refresh}
      onLoadMore={loadMore}
      onPrevious={pageIndex > 0 ? () => loadPage(cursors[pageIndex - 1] ?? null, pageIndex - 1) : undefined}
      pageIndex={pageIndex}
      onClose={close}
    />
  );
}

export interface AllChatsViewProps extends Owners {
  filters: ChatFilters;
  onFilters: (next: ChatFilters) => void;
  query: string;
  onQuery: (next: string) => void;
  held: HeldChats;
  listGen?: ChatsGen | null;
  loading: "first" | "more" | null;
  failed: string | null;
  /** message matches, one row per chat; null when no message search is running */
  hitRows: ChatHitRow[] | null;
  searchingMessages: boolean;
  hitsPartial: boolean;
  onMoreHits?: () => void;
  loadingHits?: boolean;
  hitsFailed: string | null;
  onOpenRow: (row: ChatRow) => void;
  onOpenHit: (hit: SearchHit) => void;
  onRetry?: () => void;
  onLoadMore: () => void;
  onPrevious?: () => void;
  pageIndex?: number;
  onClose: () => void;
  /** GET a chats page (the Archived section's count and rows); tests pass a fake. */
  fetchPage?: (path: string) => Promise<ChatPage>;
  /** Kept above conditional section mounting. */
  archivedCount?: number;
  onArchivedCount?: (count: number) => void;
  /** Tests: supplied rows need their own generation; otherwise only count is retained. */
  archived?: { total: number; rows: ChatRow[]; gen?: ChatsGen };
  /** Threads waiting on the owner, worked out once from the store (chatsWaitingThreads), so a render never walks a bot's chat history. */
  waitingThreads?: ReadonlySet<string>;
  /** tests: owner rows and older folds open at start, by key ("bots:ember", "older:channels") */
  sectionsOpen?: readonly string[];
  /** Clock overrides for tests. */
  now?: number;
  timeZone?: string;
  locale?: string;
}

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

// The way out (Sean 11-03): Back with its word on the left, a close X at the far right, and Esc. All three call onClose.
export function AllChatsBack({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} data-all-chats-back title={t("allChats.backHint")} className={cn("inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ink-secondary hover:bg-raised hover:text-ink", focusRing)}>
      <ArrowLeft size={18} aria-hidden="true" />{t("allChats.back")}
    </button>
  );
}

export function AllChatsClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} data-all-chats-close aria-label={t("allChats.close")} title={t("allChats.close")} className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink", focusRing)}>
      <X size={18} aria-hidden="true" />
    </button>
  );
}

export function AllChatsView(props: AllChatsViewProps) {
  const proof = useChatsGen();
  const eligible = chatsEligible(props.listGen, proof);
  const { bots, groups, filters, onFilters, query, onQuery, held, loading, failed, hitRows, onClose } = props;
  const relativeNow = useRelativeNow();
  const now = props.now ?? relativeNow;
  const clock = { timeZone: props.timeZone, locale: props.locale };
  const sections = useMemo<ChatSection[]>(() => groupChats(held, now, clock), [held, now, props.timeZone, props.locale]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const q = query.trim();

  useEffect(() => { search.current?.focus(); }, []);
  // Escape goes back to the chat that was open (a search is cleared first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only when nothing is open on top: a dialog, menu or picker closes first (src/lib/escape-layer.ts).
      if (!escapeIsFree(event, document)) return;
      event.preventDefault();
      if (query) onQuery(""); else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [query, onQuery, onClose]);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; setExpanded(new Set()); }, [held]);

  const visibleBots = bots.filter((bot) => !bot.hidden || filters.archived);
  const places = groups.filter((group) => !group.dm && (!group.hidden || filters.archived));
  const projects = places.filter((group) => group.channelProject);
  const channels = places.filter((group) => !group.channelProject);
  const set = (patch: Partial<ChatFilters>) => onFilters({ ...filters, ...patch });
  const toggle = (key: "pinned" | "unread" | "archived" | "routines") => set({ [key]: !filters[key] });
  const filterCount = activeFilterCount(filters);
  const shown = held.pinned.length + held.chats.length;
  const scopeName = filters.botId ? bots.find((bot) => bot.id === filters.botId)?.name : filters.groupId && filters.groupId !== "direct" ? groups.find((group) => group.id === filters.groupId)?.name : undefined;

  const ownerOf = (row: { botId?: string; groupId?: string }) => {
    const bot = row.botId ? bots.find((candidate) => candidate.id === row.botId) : undefined;
    const group = row.groupId ? groups.find((candidate) => candidate.id === row.groupId) : undefined;
    return { bot, group, name: bot?.name ?? (group ? `#${group.name}` : "A removed bot") };
  };
  const avatar = (bot: Bot | undefined) => bot
    ? <BotAvatar bot={bot} state="idle" size={28} animated={false} />
    : <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md bg-raised text-[12px] text-ink-secondary">#</span>;

  const renderRow = (row: ChatRow, inFold = false, previewEligible = eligible) => {
    const owner = ownerOf(row);
    const title = chatTitle(row.title, Boolean(row.routine));
    const at = chatTime(row);
    const badge = row.place ? `${row.place.kind === "project" ? "Project" : "Channel"}: ${row.place.name}` : null;
    return (
      <li key={row.threadId}>
        <button
          type="button"
          data-chat-row={row.threadId}
          onClick={() => props.onOpenRow(row)}
          className={cn("grid w-full grid-cols-[28px_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg py-2 pr-3 text-left hover:bg-raised/60 sm:grid-cols-[28px_1fr_auto]", inFold ? "pl-9" : "pl-3", focusRing)}
        >
          {avatar(owner.bot)}
          <span className="min-w-0">
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13.5px]">
              <span className="max-w-[10rem] truncate text-ink-secondary">{owner.name}</span>
              <span aria-hidden="true" className="text-ink-secondary">·</span>
              <span dir="auto" className={cn("min-w-0 truncate text-ink", row.unread && "font-semibold")}>{title}</span>
              {row.pinned && <Pin size={12} aria-label="Pinned" className="shrink-0 fill-current text-accent" />}
              {row.unread && <span className="sr-only">Unread</span>}
              {badge && <span className="max-w-full truncate rounded border border-hairline/60 px-1 text-[11px] leading-[16px] text-ink-secondary">{badge}</span>}
              {row.routine && !inFold && <span className="shrink-0 rounded border border-hairline/60 px-1 text-[11px] leading-[16px] text-ink-secondary">Routine</span>}
              {row.archived && <span className="shrink-0 rounded border border-hairline/60 px-1 text-[11px] leading-[16px] text-ink-secondary">Archived</span>}
            </span>
            {(row.snippet || !previewEligible) && <span dir="auto" className="mt-0.5 block truncate text-[12.5px] text-ink-secondary">{previewEligible ? chatSnippet(row) : t("chats.previews.checking")}</span>}
          </span>
          <time dateTime={new Date(at).toISOString()} className="col-start-2 text-[12px] tabular-nums text-ink-secondary sm:col-start-3 sm:row-start-1 sm:pt-0.5 sm:text-right">
            {formatListTime(at, now, clock)}
          </time>
        </button>
      </li>
    );
  };

  const renderSection = (section: ChatSection) => (
    <section key={section.key} aria-labelledby={`all-chats-${section.key}`}>
      <h3 id={`all-chats-${section.key}`} className="sticky top-0 z-10 bg-panel px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{section.label}</h3>
      <ul>
        {section.entries.map((entry) => {
          if (entry.type === "chat") return renderRow(entry.row);
          const open = expanded.has(`${section.key}:${entry.id}`);
          const owner = ownerOf(entry.latest);
          return (
            <li key={`runs-${section.key}-${entry.id}`}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded((before) => { const next = new Set(before); const key = `${section.key}:${entry.id}`; if (next.has(key)) next.delete(key); else next.add(key); return next; })}
                className={cn("grid w-full grid-cols-[28px_1fr] items-start gap-x-3 rounded-lg px-3 py-2 text-left hover:bg-raised/60 sm:grid-cols-[28px_1fr_auto]", focusRing)}
              >
                {avatar(owner.bot)}
                <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
                  <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-90")} />
                  <span className="truncate text-ink">{`${entry.routineName} · ${entry.runs.length} runs`}</span>
                  <span className="shrink-0 rounded border border-hairline/60 px-1 text-[11px] leading-[16px] text-ink-secondary">Routine</span>
                </span>
                <time dateTime={new Date(chatTime(entry.latest)).toISOString()} className="col-start-2 text-[12px] tabular-nums text-ink-secondary sm:col-start-3 sm:row-start-1 sm:text-right">
                  {formatListTime(chatTime(entry.latest), now, clock)}
                </time>
              </button>
              {open && <ul aria-label={`${entry.routineName} runs`}>{entry.runs.map((run) => renderRow(run, true))}</ul>}
            </li>
          );
        })}
      </ul>
    </section>
  );

  const renderHit = ({ hit, count, countComplete }: ChatHitRow) => {
    const owner = ownerOf(hit);
    const before = hit.snippet.slice(0, hit.matchStart);
    const match = hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength);
    const after = hit.snippet.slice(hit.matchStart + hit.matchLength);
    return (
      <li key={hit.threadId}>
        <button type="button" data-chat-hit={hit.threadId} aria-expanded={(count > 1 || !countComplete) ? expanded.has(`hit:${hit.threadId}`) : undefined} onClick={() => {
          if (count <= 1 && countComplete) { props.onOpenHit(hit); return; }
          setExpanded(previous => { const next = new Set(previous); const key = `hit:${hit.threadId}`; if (next.has(key)) next.delete(key); else next.add(key); return next; });
        }}
          className={cn("grid w-full grid-cols-[28px_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg px-3 py-2 text-left hover:bg-raised/60 sm:grid-cols-[28px_1fr_auto]", focusRing)}>
          {avatar(owner.bot)}
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
              <span className="max-w-[10rem] truncate text-ink-secondary">{owner.name}</span>
              <span aria-hidden="true" className="text-ink-secondary">·</span>
              <span dir="auto" className="min-w-0 truncate text-ink">{hit.task ? chatTitle(hit.task) : "Chat"}</span>
            </span>
            <span dir="auto" className="mt-0.5 line-clamp-2 border-l-2 border-hairline/60 pl-2 text-[12.5px] leading-snug text-ink-secondary">
              {before}<mark className="rounded-sm bg-accent/25 px-0.5 text-ink">{match}</mark>{after}
              {!countComplete ? <span>{` · ${incompleteChatCount(count)}`}</span> : count > 1 && <span>{` · ${count} matches`}</span>}
            </span>
          </span>
          <time dateTime={new Date(hit.at).toISOString()} className="col-start-2 text-[12px] tabular-nums text-ink-secondary sm:col-start-3 sm:row-start-1 sm:text-right">{formatListTime(hit.at, now, clock)}</time>
        </button>
        {expanded.has(`hit:${hit.threadId}`) && <ChatThreadMatches query={q} threadId={hit.threadId} filters={filters} onOpen={props.onOpenHit} />}
      </li>
    );
  };

  const chip = (on: boolean) => cn(
    "min-h-8 rounded-full border px-2.5 text-[12.5px]",
    focusRing,
    on ? "border-accent/60 bg-accent/15 text-ink" : "border-hairline/50 text-ink-secondary hover:bg-raised hover:text-ink",
  );

  return (
    <main aria-labelledby="all-chats-title" className="flex h-full min-w-0 flex-1 flex-col bg-panel text-ink">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/40 px-4 py-3">
        <OpenBotListButton />
        <AllChatsBack onClose={onClose} />
        <h2 id="all-chats-title" className="min-w-0 flex-1 truncate text-[17px] font-semibold">
          {scopeName ? `Chats with ${scopeName}` : "All chats"}
          {loading !== "first" && !failed && <span className="ml-1.5 font-normal text-ink-secondary">{`· ${held.total}`}</span>}
        </h2>
        <div role="search" className="order-last flex min-w-0 basis-full items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 focus-within:border-accent/60 sm:order-none sm:ml-auto sm:basis-[320px]">
          <Search size={15} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <input ref={search} dir="auto" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search all chats" aria-label="Search all chats"
            className="min-h-7 w-full min-w-0 bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none" />
        </div>
        <AllChatsClose onClose={onClose} />
      </header>

      <div role="group" aria-label="Filters" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-hairline/40 px-4 py-2">
        <label className="flex items-center gap-1 text-[12.5px] text-ink-secondary">
          <span>Bot</span>
          <select aria-label="Bot" value={filters.botId ?? ""} onChange={(event) => set({ botId: event.target.value || undefined })} className={cn("min-h-8 max-w-[min(14rem,60vw)] rounded-lg border border-hairline/50 bg-panel px-1.5 text-[12.5px] text-ink", focusRing)}>
            <option value="">Any</option>
            {visibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.hidden ? `${bot.name} (archived)` : bot.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[12.5px] text-ink-secondary">
          <span>Project or channel</span>
          <select aria-label="Project or channel" value={filters.groupId ?? ""} onChange={(event) => set({ groupId: event.target.value || undefined })} className={cn("min-h-8 max-w-[14rem] rounded-lg border border-hairline/50 bg-panel px-1.5 text-[12.5px] text-ink", focusRing)}>
            <option value="">Any</option>
            <option value="direct">Direct chats only</option>
            {projects.length > 0 && <optgroup label="Projects">{projects.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>}
            {channels.length > 0 && <optgroup label="Channels">{channels.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</optgroup>}
          </select>
        </label>
        <label className="flex items-center gap-1 text-[12.5px] text-ink-secondary">
          Date
          <select aria-label="Date" value={filters.date ?? ""} onChange={event => set(chatDateRange((event.target.value || undefined) as ChatFilters["date"], now))} className={cn("min-h-8 rounded-lg border border-hairline/50 bg-panel px-2 text-ink", focusRing)}>
            <option value="">Any</option><option value="today">Today</option><option value="week">Past week</option><option value="month">Past month</option><option value="custom">Custom range</option>
          </select>
        </label>
        {filters.date === "custom" && <>
          <input type="date" aria-label="From date" value={chatDateValue(filters.dateFrom)} onChange={event => set({ dateFrom: chatDateInput(event.target.value) })} className="min-h-8 rounded bg-panel px-2 text-ink" />
          <input type="date" aria-label="Through date" value={chatDateValue(filters.dateTo, true)} onChange={event => set({ dateTo: chatDateInput(event.target.value, true) })} className="min-h-8 rounded bg-panel px-2 text-ink" />
        </>}
        <button type="button" aria-pressed={Boolean(filters.pinned)} onClick={() => toggle("pinned")} className={chip(Boolean(filters.pinned))}>Pinned</button>
        <button type="button" aria-pressed={Boolean(filters.unread)} onClick={() => toggle("unread")} className={chip(Boolean(filters.unread))}>Unread</button>
        <button type="button" aria-pressed={Boolean(filters.archived)} onClick={() => toggle("archived")} className={chip(Boolean(filters.archived))}>Archived</button>
        <button type="button" aria-pressed={Boolean(filters.routines)} onClick={() => toggle("routines")} className={cn(chip(Boolean(filters.routines)), !filters.routines && "border-dashed")}>Include routine runs</button>
        {filterCount > 0 && <button type="button" onClick={() => onFilters({})} className={cn("min-h-8 rounded-lg px-2 text-[12.5px] text-ink-secondary underline hover:no-underline", focusRing)}>Clear filters</button>}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-1 pb-4 sm:px-2">
        {props.onPrevious && <button type="button" disabled={loading !== null} onClick={props.onPrevious} className={cn("m-3 rounded-lg px-3 py-2 text-[13px] hover:bg-raised", focusRing)}>Show newer chats</button>}
        {hitRows !== null || props.searchingMessages || props.hitsFailed ? (
          <section aria-labelledby="all-chats-matches">
            <h3 id="all-chats-matches" className="sticky top-0 z-10 bg-panel px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">
              {hitRows ? `Matches in messages · ${hitRows.length} ${hitRows.length === 1 ? "chat" : "chats"}` : "Matches in messages"}
            </h3>
            {props.searchingMessages && <p role="status" className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-secondary"><Loader2 size={13} aria-hidden="true" className="animate-spin" />Searching your messages for “{q}”…</p>}
            {props.hitsFailed && <p role="alert" className="px-3 py-2 text-[13px] text-danger">Could not search messages. Try again.</p>}
            {props.hitsPartial && hitRows && <p className="px-3 pb-1 text-[12px] text-ink-secondary">Showing matches from your most recent messages. Search is still getting ready for older ones.</p>}
            {hitRows && hitRows.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-secondary">No messages match “{q}”.</p>}
            {hitRows && hitRows.length > 0 && <ul>{hitRows.map(renderHit)}</ul>}
            {props.onMoreHits && <button type="button" disabled={props.loadingHits} onClick={props.onMoreHits} className={cn("m-3 rounded-lg px-3 py-2 text-[13px] hover:bg-raised", focusRing)}>{props.loadingHits ? "Loading matches…" : "More results"}</button>}
          </section>
        ) : null}

        {q && <h3 className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">Chat titles</h3>}
        {loading === "first" && <p role="status" className="flex items-center gap-2 px-3 py-4 text-[13px] text-ink-secondary"><Loader2 size={13} aria-hidden="true" className="animate-spin" />{q ? "Looking through your chat titles…" : "Loading your chats…"}</p>}
        {failed && <p role="alert" className="px-3 py-3 text-[13px] text-danger">Could not load your chats. <button type="button" className="underline hover:no-underline" onClick={() => props.onRetry ? props.onRetry() : onFilters({ ...filters })}>Try again</button></p>}
        {loading !== "first" && !failed && shown === 0 && (
          <p className="px-3 py-6 text-center text-[13px] text-ink-secondary">
            {q ? `No chat titles match “${q}”. Try a shorter word, or clear the filters.` : filterCount > 0 ? "No chats match these filters." : "No chats yet. Start one with any bot."}
          </p>
        )}
        {held.partial && <p role="status" className="px-3 py-2 text-[12px] text-ink-secondary">{t("chats.previews.partial")}</p>}
        {loading !== "first" && (chatsSectionsShown(held.total, q, filterCount, props.pageIndex) ? (
          <AllChatsSections
            rows={[...held.pinned, ...held.chats]}
            now={now}
            waiting={(row) => (props.waitingThreads?.has(row.threadId) ? 1 : 0)}
            ownerName={(row) => (row.place ? row.place.name : ownerOf(row).name)}
            avatar={(row) => avatar(ownerOf(row).bot)}
            time={(at) => formatListTime(at, now, clock)}
            renderChat={(row, allowed) => renderRow(row, true, allowed)}
            listGen={props.listGen}
            onOpenRow={props.onOpenRow}
            fetchPage={props.fetchPage ?? api}
            archivedCount={props.archivedCount}
            onArchivedCount={props.onArchivedCount}
            archived={props.archived}
            expanded={props.sectionsOpen}
          />
        ) : sections.map(renderSection))}
        {held.next && loading !== "first" && (
          <div className="px-3 pt-2">
            <button type="button" disabled={loading === "more"} onClick={props.onLoadMore} className={cn("w-full rounded-lg px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/60 disabled:opacity-60", focusRing)}>
              {loading === "more" ? "Loading chats…" : `Show older chats (${(props.pageIndex ?? 0) * 50 + shown} of ${held.total} shown)`}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
