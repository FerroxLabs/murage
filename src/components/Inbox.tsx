import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import type { OptionCardData } from "@/state/store";
import type { InboxItem, InboxLink, InboxPage, InboxStateUpdate, InboxView, RoutineRollup } from "../../shared/inbox";
import { InboxRequestAnswer, inlineAnswerKind, requestHeadline } from "./InboxRequest";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
// The selected view is a filled chip, not a grey one with a slightly
// different edge: on the control tone the old `border-accent bg-accent/10`
// was invisible at a glance, so all four tabs read as "not selected".
//
// Built without the shared button class on purpose. Adding `bg-accent
// text-accent-ink` ON TOP of that class leaves `bg-control` in the list too,
// and which one paints is decided by stylesheet order, not by the order the
// names appear here — which is how white ink ended up on a light grey chip
// at 1.48:1.
const tabBase = "min-h-10 rounded-lg border px-3 py-2 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const viewTab = (selected: boolean) =>
  `${tabBase} ${selected
    ? "border-accent bg-accent font-medium text-accent-ink hover:brightness-110"
    : "border-hairline/50 bg-control text-ink hover:bg-raised-hover"}`;
const field = "min-h-10 min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const statusLabel = (status: string) => status.replaceAll("-", " ").replace(/^./, first => first.toUpperCase());
/** "Ember · Weekly report" is the thread's label; the bot is its first part. */
export const botNameFromSource = (sourceLabel: string) => sourceLabel.split(" · ")[0]?.trim() ?? "";
/** How many waiting requests the Inbox reads the live card for in one page.
 * Bounded so a workspace with a wall of them does not open a wall of reads. */
const INLINE_CARD_LIMIT = 10;

/** Opening navigates to the exact persisted source; a waiting request can
 * also be read and answered here, through the conversation's own routes. */
/**
 * THE FIVE LISTS, THEIR WORDS, AND WHICH OF THEM MAY SHOW A NUMBER.
 *
 * Exported so the tabs, the sentence under the heading and the empty state
 * cannot drift apart, and so a test can assert the rule below without
 * rendering the dialog.
 *
 * THE RULE: only `approvals`, `questions` and `connections` carry a count.
 * They are the three things that genuinely require the owner. Routines and
 * results are things that HAPPENED — telling him is the whole job, and a
 * number on them is a number that grows by itself, which is how this Inbox
 * came to read thirty six when one thing needed him.
 */
export const INBOX_VIEWS: ReadonlyArray<{ value: InboxView; label: string; count?: (page: InboxPage) => number }> = [
  // The umbrella, and the view this opens on. It is the number the sidebar
  // badge shows, so it has to have a home here or the badge would lead
  // somewhere with no tab selected. The three after it are how it breaks
  // down, and they sum to it.
  { value: "decisions", label: "Needs you", count: page => page.decisions },
  { value: "approvals", label: "Approvals", count: page => page.approvals },
  // Labelled with the owner's word. The wire name is `questions` because
  // `decisions` is already taken by the umbrella the sidebar badge reads.
  { value: "questions", label: "Decisions", count: page => page.questions },
  { value: "connections", label: "Connections", count: page => page.connections },
  { value: "routines", label: "Routines" },
  { value: "results", label: "Results" },
  { value: "all", label: "All" },
];

/** The views where something is owed. Snoozing is offered on none of them:
 *  "not now" is a legitimate answer to being asked, but the checkbox that
 *  HIDES snoozed items is not, because it would hide a request that is still
 *  outstanding behind a control that reads like a filter. */
export const INBOX_OWED_VIEWS: readonly InboxView[] = ["decisions", "approvals", "questions", "connections"];

export const INBOX_VIEW_COPY: Partial<Record<InboxView, string>> = {
  approvals: "Something is drafted and waiting on your yes. Nothing here has been sent or done. Reading one, or snoozing it, is not answering it.",
  questions: "A judgement only you can make. Nothing is drafted yet, so there is nothing to undo either way.",
  connections: "Something needs your hands. A login has gone, and no amount of waiting brings it back. Anything depending on it is stopped until you reconnect it.",
  routines: "What your routines have been doing. One line per routine, not per run, and nothing here is waiting on you.",
  results: "Work your bots finished in the background.",
  decisions: "Everything waiting on an answer from you. Nothing here moves until you say. Reading one, or snoozing it, is not answering it.",
  "to-read": "Things that already happened and are worth knowing about. Nothing is waiting on you here, so reading one is the whole job.",
  all: "Everything your bots have produced in the background.",
};

export const INBOX_VIEW_EMPTY: Partial<Record<InboxView, string>> = {
  approvals: "Nothing is waiting on your yes.",
  questions: "Nobody has a question for you.",
  connections: "Everything is connected.",
  routines: "Your routines have not run yet.",
  results: "Nothing finished in the background yet.",
  decisions: "Nothing is waiting on you right now.",
  "to-read": "Nothing new to read.",
};

/** "26 runs, 22 failed" / "8 runs, all clean". Counts belong HERE, inside a
 *  row somebody opened on purpose, and never on the tab: a number on the tab
 *  is a number that grows by itself. */
export function routineRunLine(routine: RoutineRollup): string {
  if (routine.failed === 0) return routine.runs === 1 ? "1 run, clean" : `${routine.runs} runs, all clean`;
  return `${routine.runs} run${routine.runs === 1 ? "" : "s"}, ${routine.failed} failed`;
}

/** What the row says about where the routine stands now.
 *
 *  "Recovered" is the sentence that empties this list: twelve failures
 *  followed by a clean run is a routine that WORKS, and saying so is what
 *  stops the owner reading twelve rows about it. A stalled provider is still
 *  not his job, so it says what is happening and asks nothing. */
export function routineVerdictLine(routine: RoutineRollup): string {
  if (routine.verdict === "ok") return "OK";
  if (routine.verdict === "recovered") return "Recovered";
  // The one routine state that is owed, and it says so in the words of the
  // thing the owner has to do. It is still not counted on the tab: he finds
  // it under Decisions, where everything owed is counted once.
  if (routine.verdict === "waiting") return "Waiting on your answer";
  if (routine.cause === "connection") return "Stopped, needs reconnecting";
  if (routine.stalled) return "Waiting on the AI provider";
  if (routine.cause === "upstream") return "Retrying";
  return "Not recovering";
}

/** ONE LINE PER ROUTINE MEANS NO SECOND LIST UNDERNEATH IT.
 *
 *  The rolled-up rows were added above the item list and the item list was
 *  left alone, so the Routines tab drew four summary lines and then every
 *  one of the thirty six runs they summarised. The tab's own copy promises
 *  "one line per routine, not per run" three inches above the thirty six.
 *
 *  Routines is the only view that owns a purpose-built list, so it is the
 *  only view whose cards are suppressed. Everything else renders its rows. */
export function inboxCardItems(view: InboxView, items: readonly InboxItem[]): readonly InboxItem[] {
  return view === "routines" ? [] : items;
}

/** "9 min", "4 hours", "3 days". A request that has been waiting since
 *  Tuesday said "Waiting 6231 min for your approval", which is a number
 *  nobody converts in their head and therefore a number that says nothing
 *  about whether it is urgent. */
export function waitedFor(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/** What an owed row says about how long it has been owed.
 *
 *  It used to appear on the umbrella only, so moving to Approvals — the tab
 *  built to make approvals easier to find — LOST the line that says how long
 *  one has been sitting there. And it chose its noun by searching the title
 *  for the word "Question", so a dead Gmail login read "waiting for your
 *  approval" and a routine asking a question read the same. The segment
 *  already knows which of the three it is. */
export function owedWaitingLine(item: InboxItem, now: number): string {
  const waited = waitedFor(now - item.at);
  if (item.segment === "connection") return `Stopped ${waited} ago, and it stays stopped until you reconnect it.`;
  if (item.segment === "approval") return `Waiting ${waited} for your approval.`;
  return `Waiting ${waited} for your answer.`;
}

export function Inbox({ onOpen, onClose, refreshKey = 0, initialView = "decisions" }: { onOpen: (link: InboxLink) => void; onClose?: () => void; refreshKey?: number; initialView?: InboxView }) {
  const [view, setView] = useState<InboxView>(initialView);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [result, setResult] = useState<InboxPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const changing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(null);
    const params = new URLSearchParams({ view, query, page: String(page), pageSize: "25", includeSnoozed: String(includeSnoozed) });
    void api(`/api/inbox?${params}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setResult(value as InboxPage);
    }).catch(reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : "Inbox could not load."); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [view, query, page, includeSnoozed, revision, refreshKey]);

  useEffect(() => {
    if (view !== "decisions") return;
    const timer = window.setInterval(() => setRevision(current => current + 1), 5000);
    return () => window.clearInterval(timer);
  }, [view]);

  const update = async (item: InboxItem, change: Omit<InboxStateUpdate, "id" | "version">) => {
    if (changing.current || busy) return;
    changing.current = true; setBusy(true); setError(null);
    try {
      await api("/api/inbox/state", { method: "POST", body: JSON.stringify({ id: item.id, version: item.version, ...change }) });
      setRevision(current => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Inbox state could not be saved.");
      setBusy(false);
    } finally { changing.current = false; }
  };
  const chooseView = (next: InboxView) => { setView(next); setPage(0); };
  const list = inboxCardItems(view, result?.items ?? []);
  // The live card for each waiting request on this page, keyed by message id.
  // A thread this surface cannot read simply yields nothing, and the row
  // keeps its "Open request" button.
  const [cards, setCards] = useState<Record<string, OptionCardData>>({});
  const waiting = list.filter(item => item.kind === "request" && item.status === "pending").slice(0, INLINE_CARD_LIMIT);
  const waitingKey = waiting.map(item => `${item.link.threadId}:${item.link.messageId}:${item.version}`).join("|");
  useEffect(() => {
    if (!waiting.length) { setCards(current => (Object.keys(current).length ? {} : current)); return; }
    const controller = new AbortController();
    void Promise.all(waiting.map(async item => {
      try {
        const thread = await api(`/api/threads/${item.link.threadId}/messages?around=${item.link.messageId}&limit=1`, { signal: controller.signal }) as { messages?: { id: string; card?: OptionCardData }[] };
        const card = thread.messages?.find(message => message.id === item.link.messageId)?.card;
        return card?.requestId ? ([item.link.messageId, card] as const) : null;
      } catch { return null; }
    })).then(found => {
      if (controller.signal.aborted) return;
      setCards(Object.fromEntries(found.filter(entry => entry !== null)));
    });
    return () => controller.abort();
    // `waitingKey` is the identity of everything `waiting` holds; depending on
    // the array itself would re-fetch on every render.
  }, [waitingKey]);
  return <section aria-labelledby="inbox-title" className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto bg-panel p-4 text-ink sm:p-6">
    <header className="flex items-center justify-between gap-3"><h1 id="inbox-title" className="text-[22px] font-semibold">Inbox</h1>
      <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => setRevision(current => current + 1)}>Refresh</button>{onClose && <button className={button} onClick={onClose}>Close Inbox</button>}</div>
    </header>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{INBOX_VIEW_COPY[view] ?? INBOX_VIEW_COPY.all}</p>
    {/* FIVE LISTS, AND ONLY THREE OF THEM CARRY A NUMBER.
        The owner opened this with thirty six against it, and thirty five of
        those were one provider outage listed once per run. A count he cannot
        act on is a count he stops reading, and then the one he could act on
        is invisible inside it. So routines and results are told and never
        counted, and the three that can be asked of a person are separated,
        because an approval, a judgement and a dead credential are answered in
        three different ways. */}
    <nav aria-label="Inbox views" className="mt-4 flex flex-wrap gap-2">
      {INBOX_VIEWS.map(({ value, label, count }) => <button key={value} className={viewTab(view === value)} aria-pressed={view === value} onClick={() => chooseView(value)}>
        {label}{result && count ? ` (${count(result)})` : ""}
      </button>)}
    </nav>
    <form role="search" className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setPage(0); }}>
      <label className="sr-only" htmlFor="inbox-search">Search Inbox</label><input id="inbox-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={`${field} flex-1`} placeholder="Search results or bots" />
      <button className={button} disabled={busy}>Search</button>
    </form>
    {!INBOX_OWED_VIEWS.includes(view) && <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px] text-ink-secondary"><input type="checkbox" checked={includeSnoozed} onChange={event => { setIncludeSnoozed(event.target.checked); setPage(0); }} />Show snoozed items</label>}
    {result && <p className="mb-3 text-[12px] text-ink-secondary">While you were away: {result.unread} unread on this page. {result.total} matching items.</p>}
    {busy && <p role="status" className="mb-3 text-[13px] text-ink-secondary">Updating Inbox…</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{error} Displayed items may be stale. Use Refresh to check the current source.</p>}
    {!busy && result && !list.length && <p className="rounded-xl border border-hairline/50 p-6 text-[13px] text-ink-secondary">{query ? "No matching Inbox items." : (INBOX_VIEW_EMPTY[view] ?? "No items in this view yet.")}</p>}
    {/* ONE LINE PER ROUTINE, WHICH IS THE PROMISE THE TAB MAKES IN WORDS.
        The owner's thirty six rows were four routines. A run that failed and
        then ran again fine says "Recovered" and asks for nothing; a routine
        that is still down says so and names why. Nothing here is counted:
        see INBOX_VIEWS. */}
    {view === "routines" && result?.routines && result.routines.length > 0 && (
      <ul className="mb-3 space-y-2" aria-label="Routines">
        {result.routines.map(routine => (
          <li key={routine.routineKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-hairline/50 p-3 text-[13px]">
            <span className="font-medium text-ink">{routine.routineName}</span>
            <span className="text-ink-secondary">{routine.botLabel}</span>
            <span className="flex-1 text-ink-secondary">{routineRunLine(routine)}</span>
            <span className={routine.verdict === "stuck" ? "font-medium text-danger" : routine.verdict === "waiting" ? "font-medium text-warning" : "text-ink-secondary"}>{routineVerdictLine(routine)}</span>
            {/* Without this the summary is a dead end: collapsing thirty six
                rows into four is only an improvement if the four still lead
                back to the run they summarise. */}
            {routine.link && <button className={button} onClick={() => onOpen(routine.link!)}>Open latest run</button>}
          </li>
        ))}
      </ul>
    )}
    <ul className="space-y-3" aria-label="Inbox items">
      {list.map(item => {
        // The bot's own words head the card whenever the live request can be
        // read; `item.title` is the kind of thing it is, and stays as the
        // line above it rather than as the headline.
        const card = cards[item.link.messageId];
        const headline = requestHeadline(card);
        const answerable = Boolean(card) && inlineAnswerKind(card) !== null;
        return <li key={item.id} className="rounded-xl border border-hairline/50 bg-inset p-4" data-inbox-id={item.id}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary"><span>{item.sourceLabel}</span><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time></div>
        {INBOX_OWED_VIEWS.includes(view) && <p className="mt-2 text-[12px] text-ink-secondary">{owedWaitingLine(item, Date.now())}</p>}
        {headline && <p className="mt-2 text-[12px] text-ink-secondary">{item.title}</p>}
        <h2 className="mt-1 break-words text-[15px] font-medium">{headline || item.title}</h2>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]"><span className="rounded bg-control px-2 py-1">{statusLabel(item.status)}</span><span className="rounded bg-control px-2 py-1">{item.read ? "Read" : "Unread"}</span>
          {item.duplicates > 1 && <span className="px-1 py-1 text-ink-secondary">{item.duplicates} matching receipts</span>}
          {view !== "decisions" && item.snoozedUntil !== null && item.snoozedUntil > Date.now() && <span className="px-1 py-1 text-ink-secondary">Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</span>}
        </div>
        {item.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{item.summary}</p>}
        {answerable && <InboxRequestAnswer threadId={item.link.threadId} card={card!} botName={botNameFromSource(item.sourceLabel)} onSettled={() => setRevision(current => current + 1)} />}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={button} onClick={() => onOpen(item.link)}>Open {item.kind === "artifact" ? "file" : item.kind === "routine" || item.kind === "goal" ? "report" : "request"}</button>
          <button className={button} disabled={busy} onClick={() => void update(item, { read: !item.read })}>{item.read ? "Mark unread" : "Mark read"}</button>
          {view !== "decisions" && (item.snoozedUntil !== null && item.snoozedUntil > Date.now()
            ? <button className={button} disabled={busy} onClick={() => void update(item, { snoozedUntil: null })}>Return to Inbox</button>
            : <button className={button} disabled={busy} onClick={() => void update(item, { snoozedUntil: Date.now() + 60 * 60 * 1000 })}>Snooze 1 hour</button>)}
        </div>
      </li>;
      })}
    </ul>
    {result && <footer className="mt-4 flex items-center justify-between gap-3 border-t border-hairline/40 pt-4">
      <button className={button} disabled={busy || page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span className="text-[12px] text-ink-secondary">Page {page + 1} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span>
      <button className={button} disabled={busy || (page + 1) * result.pageSize >= result.total} onClick={() => setPage(current => current + 1)}>Next</button>
    </footer>}
  </section>;
}
