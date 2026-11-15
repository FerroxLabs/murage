// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { useFocusTrap } from "@/lib/focus-trap";
import { plainText } from "@/lib/plain-text";
import { fetchSkills, fetchTopics } from "@/lib/skillsLibrary";
import { BOX_FRAME, BOX_PANES, BoxBody, BoxHead } from "../ui/BoxShell";
import { SkillDetailPane } from "./SkillDetailPane";

type Topics = Awaited<ReturnType<typeof fetchTopics>>;
type Skill = Awaited<ReturnType<typeof fetchSkills>>["items"][number];
type Filter = "all" | "onBots" | "mine";
type Browse = { filter: Filter; term?: string };
const PAGE_SIZE = 100;
const FOCUS = "focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[-2px]";
const SOFT = `rounded-lg bg-raised px-3 py-1.5 text-ink hover:bg-raised-hover ${FOCUS}`;
const FILTERS: { filter: Filter; label: string }[] = [
  { filter: "all", label: "All skills" },
  { filter: "onBots", label: "On your bots" },
  { filter: "mine", label: "Your copies" },
];

export interface SkillsBrowserProps {
  bots: { id: string; name: string }[];
  compact: boolean;
  onClose(): void;
}

/** Topic browsing and search share one paged list. A search always starts from all topics. */
export function SkillsBrowser({ bots, compact }: SkillsBrowserProps) {
  const [topics, setTopics] = useState<Topics>({ topics: [], totalSkills: 0 });
  const [topicsError, setTopicsError] = useState(false);
  const [topicsLoading, setTopicsLoading] = useState(true);
  const [counts, setCounts] = useState<Partial<Record<Filter, number>>>({});
  const [browse, setBrowse] = useState<Browse>({ filter: "all" });
  const [topicQuery, setTopicQuery] = useState("");
  const [query, setQuery] = useState("");
  const q = query.trim();
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [items, setItems] = useState<Skill[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [topicsRevision, setTopicsRevision] = useState(0);
  const generation = useRef(0);
  const morePending = useRef(false);
  const loadedCount = useRef(PAGE_SIZE);
  const nextOffset = useRef(0);
  const pendingRowFocus = useRef<string | null>(null);
  const replacementSelection = useRef<string | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const rowsRef = useRef<HTMLUListElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const navigationGuard = useRef<((leave: () => void) => void) | null>(null);
  const setNavigationGuard = useCallback((guard: ((leave: () => void) => void) | null) => { navigationGuard.current = guard; }, []);
  const navigate = (leave: () => void) => {
    if (navigationGuard.current) navigationGuard.current(leave);
    else leave();
  };
  const pickerId = useId();

  const closeTopics = useCallback(() => { setTopicsOpen(false); setTopicQuery(""); }, []);
  useFocusTrap(railRef, compact && topicsOpen, {
    name: "skills-topics", kind: "dialog", initialFocus: "input", returnFocusTo: changeRef.current, fallbackFocus: changeRef.current, onEscape: closeTopics,
  });
  useEffect(() => { if (!compact) closeTopics(); }, [compact, closeTopics]);

  useEffect(() => {
    let live = true;
    setTopicsLoading(true);
    setTopicsError(false);
    void fetchTopics().then(result => { if (live) setTopics(result); })
      .catch(() => { if (live) setTopicsError(true); })
      .finally(() => { if (live) setTopicsLoading(false); });
    for (const filter of ["onBots", "mine"] as const) {
      void fetchSkills({ filter, offset: 0, limit: 1 }).then(result => {
        if (live) setCounts(previous => ({ ...previous, [filter]: result.total }));
      }).catch(() => { if (live) setCounts(previous => ({ ...previous, [filter]: undefined })); });
    }
    return () => { live = false; };
  }, [topicsRevision]);

  const criteria = useMemo(() => q ? { q, filter: "all" as const } : { ...browse }, [q, browse]);
  useEffect(() => {
    const token = ++generation.current;
    let live = true;
    setLoading(true);
    setLoadingMore(false);
    morePending.current = false;
    setError("");
    // A detail edit refreshes every page already reached, so editing the last
    // row does not send the person back to page one.
    const target = loadedCount.current;
    void (async () => {
      try {
        const refreshed: Skill[] = [];
        let offset = 0;
        let count = 0;
        do {
          const page = await fetchSkills({ ...criteria, offset, limit: PAGE_SIZE });
          if (!live || token !== generation.current) return;
          refreshed.push(...page.items);
          count = page.total;
          offset = page.offset + page.items.length;
          if (!page.items.length) break;
        } while (offset < count && offset < target);
        nextOffset.current = offset;
        loadedCount.current = Math.max(PAGE_SIZE, offset);
        setItems(refreshed);
        setTotal(count);
        setSelected(previous => replacementSelection.current ?? (refreshed.some(item => item.id === previous) ? previous : refreshed[0]?.id ?? null));
      } catch {
        if (live && token === generation.current) setError("Skills couldn’t load. Try again.");
      } finally {
        if (live && token === generation.current) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [criteria, revision]);

  const resetList = () => {
    replacementSelection.current = null;
    loadedCount.current = PAGE_SIZE;
    setItems([]);
    setSelected(null);
    setTotal(0);
    rowsRef.current?.scrollTo?.({ top: 0 });
  };
  const pickTopic = (next: Browse) => {
    const pick = () => { resetList(); setBrowse(next); setQuery(""); closeTopics(); };
    if (q || next.term !== browse.term || next.filter !== browse.filter) navigate(pick);
    else closeTopics();
  };
  const changeQuery = (value: string) => {
    if (value.trim() !== q) navigate(() => { resetList(); setQuery(value); });
    else setQuery(value);
  };
  const refreshRow = useCallback((replacementId?: string) => {
    if (replacementId) { replacementSelection.current = replacementId; setSelected(replacementId); }
    setRevision(value => value + 1); setTopicsRevision(value => value + 1);
  }, []);
  useEffect(() => {
    const index = items.findIndex(item => item.id === pendingRowFocus.current);
    if (index < 0) return;
    pendingRowFocus.current = null;
    rowsRef.current?.querySelector<HTMLButtonElement>(`[data-skill-index="${index}"]`)?.focus();
  }, [items]);

  const showMore = async () => {
    if (loading || morePending.current || nextOffset.current >= total) return;
    morePending.current = true;
    setLoadingMore(true);
    setError("");
    const token = generation.current;
    const moveFocus = rowsRef.current?.contains(document.activeElement);
    try {
      const page = await fetchSkills({ ...criteria, offset: nextOffset.current, limit: PAGE_SIZE });
      if (token !== generation.current) return;
      if (!page.items.length && page.total > nextOffset.current) throw new Error("Empty page");
      setItems(previous => {
        const ids = new Set(previous.map(item => item.id));
        return [...previous, ...page.items.filter(item => !ids.has(item.id))];
      });
      nextOffset.current = page.offset + page.items.length;
      loadedCount.current = nextOffset.current;
      setTotal(page.total);
      const firstNew = page.items.find(item => !items.some(previous => previous.id === item.id));
      if (moveFocus && firstNew) { pendingRowFocus.current = firstNew.id; setSelected(firstNew.id); }
    } catch {
      if (token === generation.current) setError("More skills couldn’t load. Try again.");
    } finally {
      if (token === generation.current) { morePending.current = false; setLoadingMore(false); }
    }
  };

  const topic = topics.topics.find(item => item.term === browse.term);
  const topicName = browse.term ? topic?.label ?? browse.term : FILTERS.find(item => item.filter === browse.filter)!.label;
  const topicCount = browse.term ? topic?.count : browse.filter === "all" ? topics.totalSkills : counts[browse.filter];
  const az = [...topics.topics].sort((a, b) => a.label.localeCompare(b.label));
  const matches = az.filter(item => item.label.toLocaleLowerCase().includes(topicQuery.trim().toLocaleLowerCase()));
  const railButton = (label: string, count: number | undefined, next: Browse, key: string) => {
    const active = !q && browse.filter === next.filter && browse.term === next.term;
    return <button key={key} type="button" aria-current={active ? "true" : undefined} onClick={() => pickTopic(next)}
      className={cn("flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] hover:bg-raised/60", FOCUS, active ? "bg-raised font-semibold text-ink" : "text-ink-secondary")}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-[12px] font-normal text-ink-secondary tabular-nums">{count.toLocaleString()}</span>}
    </button>;
  };
  const focusRow = (index: number) => {
    const item = items[index];
    if (!item) return;
    setSelected(item.id);
    const row = rowsRef.current?.querySelector<HTMLButtonElement>(`[data-skill-index="${index}"]`);
    row?.focus(); row?.scrollIntoView?.({ block: "nearest" });
  };
  const rowKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1)
      : event.key === "ArrowUp" ? Math.max(0, index - 1) : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next !== null) { event.preventDefault(); focusRow(next); }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const target = detailRef.current?.querySelector<HTMLElement>("button, input, [tabindex='0']") ?? detailRef.current;
      target?.focus();
    }
  };

  return <div className={cn(BOX_PANES, "relative flex-1 border-t border-hairline/50 text-[13px] text-ink")} data-skills-browser data-compact={compact}>
    {compact && topicsOpen && <button type="button" tabIndex={-1} aria-label="Close this menu" onClick={closeTopics} className="absolute inset-0 z-20 bg-black/35" />}
    {(!compact || topicsOpen) && <nav ref={railRef} id={pickerId} aria-label="Topics" role={compact ? "dialog" : undefined} aria-modal={compact ? true : undefined}
      className={cn(BOX_FRAME, "shrink-0", compact ? "absolute inset-y-2 left-2 z-30 w-[272px] max-w-[calc(100%-16px)] rounded-xl border border-hairline bg-card shadow-2xl" : "w-[212px] border-r border-hairline/50")}>
      <BoxHead className="gap-2 px-4 pt-3.5 pb-2">
        <h2 className="text-[12px] font-medium text-ink-secondary">Browse by topic</h2>
        {compact && <button type="button" onClick={closeTopics} className={cn(SOFT, "rounded-full text-[12px]")}>Close</button>}
      </BoxHead>
      <label className="mx-3 mb-2 flex min-h-[34px] shrink-0 items-center gap-2 rounded-lg border border-hairline/50 bg-inset px-2.5">
        <Search size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span className="sr-only">Find a topic</span>
        <input value={topicQuery} onChange={event => setTopicQuery(event.target.value)} placeholder="Find a topic" className={cn("min-h-8 min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-ink-secondary", FOCUS)} />
      </label>
      <BoxBody className="thin-scroll px-2 pb-3">
        {!topicQuery.trim() && <>
          {FILTERS.map(item => railButton(item.label, item.filter === "all" ? topics.totalSkills : counts[item.filter], { filter: item.filter }, item.filter))}
          <h3 className="mt-3.5 mb-1 px-2 text-[11.5px] font-medium text-ink-secondary">Biggest topics</h3>
          {[...topics.topics].sort((a, b) => b.count - a.count).slice(0, 8).map(item => railButton(item.label, item.count, { filter: "all", term: item.term }, `big-${item.term}`))}
        </>}
        <h3 className="mt-3.5 mb-1 px-2 text-[11.5px] font-medium text-ink-secondary">{topicQuery.trim() ? `${matches.length} ${matches.length === 1 ? "topic" : "topics"}` : `All ${topics.topics.length} topics, A to Z`}</h3>
        {matches.map(item => railButton(item.label, item.count, { filter: "all", term: item.term }, item.term))}
        {topicsLoading && <p role="status" className="p-2 text-ink-secondary">Loading topics…</p>}
        {topicsError && <div role="alert" className="p-2 text-ink-secondary">Topics couldn’t load. <button type="button" className={SOFT} onClick={() => setTopicsRevision(value => value + 1)}>Try again</button></div>}
        {!topicsLoading && !topicsError && !matches.length && <p className="m-2 text-[12.5px] leading-relaxed text-ink-secondary">No topic has that name. Try the skill search instead.</p>}
      </BoxBody>
    </nav>}
    <section aria-label="Skills" className={cn("flex min-h-0 min-w-0 shrink-0 flex-col border-r border-hairline/50", compact ? "w-[256px] max-w-[45%]" : "w-[320px]")}>
      <div className="flex shrink-0 flex-col gap-2 px-3.5 pt-3.5 pb-2.5">
        <div className="flex min-h-10 items-center gap-2 rounded-xl bg-raised/60 px-3">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          <label className="min-w-0 flex-1">
            <span className="sr-only">{topics.totalSkills ? `Search all ${topics.totalSkills.toLocaleString()} skills` : "Search all skills"}</span>
            <input value={query} onChange={event => changeQuery(event.target.value)} placeholder={topics.totalSkills ? `Search all ${topics.totalSkills.toLocaleString()} skills` : "Search all skills"}
              className={cn("min-h-9 w-full min-w-0 bg-transparent text-[14px] placeholder:text-ink-secondary", FOCUS)} />
          </label>
          {query && <button type="button" onClick={() => changeQuery("")} className={cn("rounded-md px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-raised-hover", FOCUS)}>Clear</button>}
        </div>
        {compact && <button ref={changeRef} type="button" aria-haspopup="dialog" aria-expanded={topicsOpen} aria-controls={pickerId} onClick={() => setTopicsOpen(true)} className={cn(SOFT, "flex min-h-[34px] items-center gap-1.5 px-2.5 text-left")}>
          <span className="text-ink-secondary">Topic</span><span className="min-w-0 flex-1 truncate font-medium">{q ? "All topics" : `${topicName}${topicCount === undefined ? "" : ` (${topicCount.toLocaleString()})`}`}</span><span className="text-[12px] text-ink-secondary">Change</span><ChevronDown size={14} aria-hidden="true" />
        </button>}
        <div className="flex items-baseline gap-2 px-0.5 pt-0.5">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{q ? "Search results" : topicName}</h2>
          <span role="status" className="shrink-0 text-[12px] text-ink-secondary">{loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "skill" : "skills"}${q ? ", all topics" : ""}`}</span>
        </div>
      </div>
      <ul ref={rowsRef} aria-label="Skill results" aria-busy={loading || loadingMore} className="thin-scroll m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain pr-1 pb-2.5 pl-2">
        {items.map((item, index) => <li key={item.id} className="border-t border-hairline/25">
          <button type="button" data-skill-index={index} aria-current={selected === item.id ? "true" : undefined} tabIndex={selected === item.id ? 0 : -1} onClick={() => { replacementSelection.current = null; setSelected(item.id); }} onKeyDown={event => rowKey(event, index)}
            className={cn("flex w-full items-center gap-2.5 rounded-lg py-[11px] pr-2 pl-2.5 text-left hover:bg-raised/60", FOCUS, selected === item.id && "bg-raised")}>
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="truncate text-[14px] font-medium">{item.name}</span>
              <span className="truncate text-[12.5px] leading-[1.45] text-ink-secondary">{plainText(item.description)}</span>
              {(item.mine || item.bots.length > 0) && <span className="mt-px flex flex-wrap gap-x-2.5 text-[11.5px]">
                {item.mine && <span className="text-accent-text">Your copy</span>}
                {item.bots.length > 0 && <span className="text-success">{item.bots.length === 1 ? `On ${item.bots[0].name}` : `On ${item.bots.length} bots`}</span>}
              </span>}
            </span><ChevronRight size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          </button>
        </li>)}
        {error && <li role="alert" className="p-3 text-[12.5px] text-ink-secondary">{error} <button type="button" className={SOFT} onClick={() => { if (error.startsWith("More")) void showMore(); else setRevision(value => value + 1); }}>Try again</button></li>}
        {!loading && !error && !items.length && <li className="flex flex-col items-start gap-2 px-3 py-7">
          <span className="text-[14px] font-medium">{q ? `Nothing matches “${query}”` : "No skills here yet."}</span>
          {q && <><span className="text-[12.5px] leading-relaxed text-ink-secondary">Search looks at every skill in every topic. Try a shorter word.</span><button type="button" className={cn(SOFT, "rounded-full")} onClick={() => changeQuery("")}>Clear search</button></>}
        </li>}
        {!loading && items.length > 0 && nextOffset.current < total && <li className="border-t border-hairline/25 px-2.5 pt-3 pb-1">
          <p className="mb-2 text-[12px] text-ink-secondary">Showing {items.length.toLocaleString()} of {total.toLocaleString()}.</p>
          <button type="button" disabled={loadingMore} onClick={() => void showMore()} className={cn(SOFT, "w-full disabled:opacity-50")}>{loadingMore ? "Loading…" : "Show more"}</button>
        </li>}
      </ul>
    </section>
    <main ref={detailRef} tabIndex={-1} aria-label="Skill details" className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col", FOCUS)}>
      {selected ? <SkillDetailPane skillId={selected} bots={bots} compact={compact} onChanged={refreshRow} onNavigationGuardChange={setNavigationGuard} /> : <p className="p-5 text-[13px] text-ink-secondary">{loading ? "Loading skills…" : "Choose a skill to read its instructions."}</p>}
    </main>
  </div>;
}
