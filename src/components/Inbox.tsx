import { useEffect, useRef, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "@/state/store";
import type { OptionCardData } from "@/state/store";
import type { InboxItem, InboxLink, InboxPage, InboxStateUpdate, InboxView, RoutineRollup } from "../../shared/inbox";
import { InboxRequestAnswer, inlineAnswerKind, requestHeadline } from "./InboxRequest";
import { useSetupView } from "./FirstRunChrome";
import { inboxTabCounts, signedOutEngineRows } from "@/lib/signed-out-engines";
import { usePageVisible } from "@/lib/page-visible";
import { backupWaitingSentence } from "../../shared/backup-waiting";

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

/** "2 routines, covering 7 runs": the runs the rows themselves cover, which
 *  include runs that posted no card (a run in the routine's own
 *  conversation), so never the card total. */
export function routinesCoverLine(rows: readonly Pick<RoutineRollup, "runs">[]): string {
  const runs = rows.reduce((sum, row) => sum + row.runs, 0);
  return `${rows.length} ${rows.length === 1 ? "routine" : "routines"}, covering ${runs} ${runs === 1 ? "run" : "runs"}`;
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

/** Whether the "nothing here" panel belongs on screen.
 *
 *  Routines draws its OWN list from the rollup, so once the per-run cards
 *  were suppressed its card list is always empty and the panel would have
 *  printed "your routines have not run yet" underneath four routines that
 *  plainly had. Its emptiness is the rollup's. */
export function inboxShowsEmpty(
  view: InboxView,
  cards: readonly unknown[],
  routines: readonly unknown[],
  rows: readonly unknown[] = [],
): boolean {
  if (view === "routines") return routines.length === 0;
  // `rows` is every purpose-built row on this view: a dead credential raised
  // from routine failures, and an engine nobody is signed in to. Neither has
  // a message under it, so neither is in `cards`, and without them the rows
  // saying a login has died would sit underneath "Everything is connected."
  return cards.length === 0 && rows.length === 0;
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

/** "3 items" / "3 items, 1 unread". The line that said "While you were away:
 *  0 unread on this page. 0 matching items." read like a log, and it spoke
 *  even when there was nothing to say. Nothing to count says nothing. */
export function inboxTally(total: number, unread: number): string {
  if (total <= 0) return "";
  return `${total} ${total === 1 ? "item" : "items"}${unread > 0 ? `, ${unread} unread` : ""}`;
}

/** "Sep 18, 1:01 PM". The seconds and the full year said nothing a person
 *  uses, and made every card's first line the longest thing on it. */
const shortWhen = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const sectionHeading = "text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-secondary";

function InboxSection({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  const id = `inbox-section-${label.toLowerCase().replaceAll(/[^a-z]+/g, "-")}`;
  return <section aria-labelledby={id} className="mt-5 first:mt-0">
    <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h2 id={id} className={sectionHeading}>{label}</h2>
      {aside && <div className="flex flex-wrap items-center gap-2">{aside}</div>}
    </div>
    {children}
  </section>;
}

export function Inbox({ onOpen, onClose, refreshKey = 0, initialView = "decisions" }: { onOpen: (link: InboxLink) => void; onClose?: () => void; refreshKey?: number; initialView?: InboxView }) {
  const [view, setView] = useState<InboxView>(initialView);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [result, setResult] = useState<InboxPage | null>(null);
  // TWO KINDS OF BUSY, BECAUSE ONE MADE THE INBOX UNUSABLE.
  //
  // Needs you re-reads itself every five seconds, and every read used to set
  // the same `busy` a change sets. So for part of every five seconds each
  // button was disabled and its click thrown away ("I don't use Qwen" did
  // nothing, "Dismiss all" did nothing, one at a time sometimes worked), and
  // an "Updating Inbox…" line appeared above the list and pushed it down, so
  // the whole page jumped on the beat. A read now changes nothing on screen
  // until it has an answer; only a change the person made holds the buttons.
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  // What the person has already answered here: item ids, and `engine:<id>`.
  // Hidden the moment they click, so the row goes when they say so and not
  // when the next read happens to land, and a read already in flight when
  // they clicked cannot bring it back. Put back only if the change failed.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const changing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ view, query, page: String(page), pageSize: "25", includeSnoozed: String(includeSnoozed) });
    void api(`/api/inbox?${params}`, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setResult(value as InboxPage); setReadError(null); }
    }).catch(reason => {
      if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "Inbox could not load.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [view, query, page, includeSnoozed, revision, refreshKey]);

  // Hidden (a locked phone, a background tab): no 5 s reads nobody can see.
  const pageVisible = usePageVisible();
  const wasHidden = useRef(false);
  useEffect(() => {
    if (view !== "decisions") return;
    if (!pageVisible) wasHidden.current = true;
    if (!pageVisible) return;
    if (wasHidden.current) { wasHidden.current = false; setRevision(current => current + 1); }
    const timer = window.setInterval(() => setRevision(current => current + 1), 5000);
    return () => window.clearInterval(timer);
  }, [view, pageVisible]);

  /** One change at a time. `hide` goes at once and comes back on failure. */
  const act = async (hide: readonly string[], work: () => Promise<unknown>, failure: string) => {
    if (changing.current) return;
    changing.current = true; setSaving(true); setActionError(null);
    if (hide.length) setGone(current => new Set([...current, ...hide]));
    try {
      await work();
      setRevision(current => current + 1);
    } catch (reason) {
      if (hide.length) setGone(current => new Set([...current].filter(id => !hide.includes(id))));
      setActionError(reason instanceof Error ? reason.message : failure);
    } finally { changing.current = false; setSaving(false); }
  };
  const saveState = (item: InboxItem, change: Omit<InboxStateUpdate, "id" | "version">) =>
    api("/api/inbox/state", { method: "POST", body: JSON.stringify({ id: item.id, version: item.version, ...change }) });
  const update = (item: InboxItem, change: Omit<InboxStateUpdate, "id" | "version">) =>
    act(change.cleared ? [item.id] : [], () => saveState(item, change), "Inbox state could not be saved.");
  // A new list: what was on screen belongs to the old one, so it goes rather
  // than sitting there under the new tab's name until the read lands.
  const reset = () => { setResult(null); setPage(0); };
  const chooseView = (next: InboxView) => { if (next !== view) { setView(next); reset(); } };
  // Setting aside a request to connect an app: the same call as the card's
  // own "Not now" in the chat, one card or every one on this page.
  const dismiss = (items: InboxItem[]) => act(items.map(item => item.id), async () => {
    for (const item of items) {
      await api(`/api/bots/${encodeURIComponent(item.botId!)}/connector-cards/${encodeURIComponent(item.link.messageId)}/dismiss`, {
        method: "POST", body: JSON.stringify({ threadId: item.link.threadId }),
      });
    }
  }, "That request could not be dismissed.");
  // Clearing what owes nothing (a failed sign-in, a missed request): gone
  // until it happens again.
  const clearAll = (items: InboxItem[]) => act(items.map(item => item.id), async () => {
    for (const item of items) await saveState(item, { cleared: true });
  }, "Those items could not be cleared.");
  // An engine the owner does not use: turned off, exactly as Settings >
  // Engines does, so it stops asking to be signed in to. Confirmed first,
  // because a bot set to that engine stops working with it.
  const [turningOff, setTurningOff] = useState<string | null>(null);
  const turnOff = (engineId: string) => act([`engine:${engineId}`], async () => {
    await api(`/api/instances/${encodeURIComponent(engineId)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    setTurningOff(null);
    refreshSetup();
  }, "That engine could not be turned off.");
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (engineId: string, command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(engineId); window.setTimeout(() => setCopied(current => (current === engineId ? null : current)), 2000); }
    catch { setActionError("Copying did not work. Select the command and copy it yourself."); }
  };
  const list = inboxCardItems(view, result?.items ?? []).filter(item => !gone.has(item.id));
  const routineRows = result?.routines ?? [];
  const restoreRows = result?.restore ?? [];
  // A LIVE READING, NOT A MESSAGE. See src/lib/signed-out-engines.ts: the
  // server already computes this on every setup view and exactly one
  // component ever read it, so a login that expires on day two was reported
  // nowhere at all.
  const { view: setupView, refresh: refreshSetup } = useSetupView();
  const signedOut = (view === "connections" || view === "decisions" ? signedOutEngineRows(setupView) : [])
    .filter(engine => !gone.has(`engine:${engine.id}`));
  // The counts the tabs read, with the live rows folded in. Both numbers or
  // neither: the three segments sum to the umbrella.
  // Every tab counts every signed-out engine, not only the tabs that list
  // them (inboxTabCounts), so the numbers stay put when the tab changes.
  const shown = inboxTabCounts(result, setupView, gone);
  // A daily backup held up by a waiting card (0.1.60 Linux D6). Shown where
  // decisions are, beside the card it waits for; never counted.
  const backupWaiting = view === "decisions" || view === "approvals" || view === "questions" ? result?.backupWaiting ?? null : null;
  const ownRows = [...restoreRows, ...signedOut, ...(backupWaiting ? [backupWaiting] : [])];
  const dismissible = list.filter(item => item.dismissible);
  const clearable = list.filter(item => item.clearable);
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
  const owed = INBOX_OWED_VIEWS.includes(view);
  const tally = result ? inboxTally(result.total - result.items.filter(item => gone.has(item.id)).length, result.unread) : "";
  const sections = signedOut.length + restoreRows.length + (backupWaiting ? 1 : 0) + (view === "routines" ? routineRows.length : 0) > 0;
  return <section aria-labelledby="inbox-title" aria-busy={loading} className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto bg-panel p-4 text-ink sm:p-6">
    <header className="flex items-center justify-between gap-3"><h1 id="inbox-title" className="text-[22px] font-semibold">Inbox</h1>
      <div className="flex gap-2">
        <button className={`${button} inline-flex items-center gap-2`} disabled={saving} onClick={() => setRevision(current => current + 1)}>
          <RefreshCw size={14} aria-hidden className={loading ? "animate-spin motion-reduce:animate-none" : ""} />Refresh
        </button>
        {onClose && <button className={button} onClick={onClose}>Close Inbox</button>}
      </div>
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
        {label}{shown && count ? ` (${count(shown)})` : ""}
      </button>)}
    </nav>
    <form role="search" className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); const next = draft.trim(); if (next !== query) { setQuery(next); reset(); } }}>
      <label className="sr-only" htmlFor="inbox-search">Search Inbox</label><input id="inbox-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={`${field} flex-1`} placeholder="Search results or bots" />
      <button className={button}>Search</button>
    </form>
    {!owed && <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px] text-ink-secondary"><input type="checkbox" checked={includeSnoozed} onChange={event => { setIncludeSnoozed(event.target.checked); reset(); }} />Show snoozed items</label>}
    <div className="mt-5 flex-1">
    {actionError && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{actionError}</p>}
    {readError && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{readError} What is shown may be out of date. Use Refresh to try again.</p>}
    {!result && !readError && <p className="py-10 text-center text-[13px] text-ink-secondary">Loading…</p>}
    {/* Routines draws its own list, so its emptiness is the rollup's, not
        the card list's. Reading `list` here would print "your routines have
        not run yet" underneath four routines that plainly had. */}
    {result && inboxShowsEmpty(view, list, routineRows, ownRows) && <p className="rounded-xl border border-dashed border-hairline/60 p-8 text-center text-[13px] text-ink-secondary">{query ? "No matching Inbox items." : (INBOX_VIEW_EMPTY[view] ?? "No items in this view yet.")}</p>}
    {/* A BACKUP THAT WAITS ON A CARD.
        Every backup closes and reopens Murage, and a run waiting on the
        owner cannot survive that, so the backup waits. Ask cards wait
        indefinitely, so this says so here instead of backups quietly
        stopping. It clears itself the moment the card is answered. */}
    {backupWaiting && (
      <InboxSection label="Backups">
        <div className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
          <p className="font-medium text-ink">{backupWaitingSentence(backupWaiting.bots, "daily")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {backupWaiting.bots.filter((bot, index) => backupWaiting.bots.findIndex(other => other.threadId === bot.threadId) === index).map(bot => (
              <button key={bot.threadId} className={button} onClick={() => onOpen({ threadId: bot.threadId, messageId: bot.messageId ?? "" })}>Answer {bot.name}</button>
            ))}
          </div>
        </div>
      </InboxSection>
    )}
    {/* AN ENGINE THAT IS HERE AND SIGNED OUT OF.
        The driver was asked and said nobody is signed in. It is a live
        reading re-read on a poll, so it empties itself the moment they sign
        in, which is why it is allowed to count when the failed-turn log row
        underneath it is not. */}
    {signedOut.length > 0 && (
      <InboxSection label="Engines to sign in to">
        <ul className="space-y-2" aria-label="Engines to sign in to">
          {signedOut.map(engine => (
            <li key={engine.id} className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-ink">{engine.name} is here, and nobody is signed in to it.</p>
                  <p className="mt-1 text-ink-secondary">Anything you ask it to do will fail until you sign in.{engine.signInCommand ? " Run this in a terminal:" : ""}</p>
                </div>
                {turningOff !== engine.id && <button className={button} disabled={saving} onClick={() => setTurningOff(engine.id)}>I don't use {engine.name}</button>}
              </div>
              {engine.signInCommand && <div className="mt-2 flex items-center gap-2 rounded-lg bg-control py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 break-all text-[12px] text-ink">{engine.signInCommand}</code>
                <button type="button" className="min-h-8 rounded-md px-2 text-[12px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus" aria-label={`Copy the ${engine.name} sign-in command`} onClick={() => void copy(engine.id, engine.signInCommand!)}>{copied === engine.id ? "Copied" : "Copy"}</button>
              </div>}
              {turningOff === engine.id && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-warning/20 pt-3">
                <span className="mr-auto text-ink-secondary">Turn off {engine.name}? Bots stop using it. You can turn it back on in Settings, Engines.</span>
                <button className={button} disabled={saving} onClick={() => setTurningOff(null)}>Keep it</button>
                <button className={`${button} border-warning/50`} disabled={saving} onClick={() => void turnOff(engine.id)}>Turn it off</button>
              </div>}
            </li>
          ))}
        </ul>
      </InboxSection>
    )}
    {/* A CONNECTION THAT ONLY THE RUNS KNOW IS DEAD.
        Nothing re-checks a connector once it is connected, so a token that
        expires between uses is invisible everywhere else in the product.
        This is read out of the failures it caused, so it is a row of its own
        rather than an item: there is no message under it to open, read or
        snooze. The run carrying the error is the only evidence there is, so
        that is what it offers. */}
    {restoreRows.length > 0 && (
      <InboxSection label="Connections to restore">
        <ul className="space-y-2" aria-label="Connections to restore">
          {restoreRows.map(row => (
            <li key={row.id} className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
              <p className="font-medium text-ink">{row.detail}</p>
              <p className="mt-1 text-ink-secondary">
                Stopped: {row.routines.join(", ")}. {row.bots.length === 1 ? row.bots[0] : `${row.bots.length} bots`} cannot carry on until it is reconnected.
              </p>
              {row.link && <button className={`${button} mt-3`} onClick={() => onOpen(row.link!)}>Open the run that failed</button>}
            </li>
          ))}
        </ul>
      </InboxSection>
    )}
    {/* ONE LINE PER ROUTINE, WHICH IS THE PROMISE THE TAB MAKES IN WORDS.
        The owner's thirty six rows were four routines. A run that failed and
        then ran again fine says "Recovered" and asks for nothing; a routine
        that is still down says so and names why. Nothing here is counted:
        see INBOX_VIEWS. Routines counts the ROWS a person sees, not the runs
        behind them. */}
    {view === "routines" && routineRows.length > 0 && result && (
      <InboxSection label="Routines" aside={<span className="text-[12px] text-ink-secondary">{routinesCoverLine(routineRows)}</span>}>
        <ul className="space-y-2" aria-label="Routines">
          {routineRows.map(routine => (
            <li key={routine.routineKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-hairline/50 bg-inset p-3 text-[13px]">
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
      </InboxSection>
    )}
    {list.length > 0 && (
      <InboxSection
        label={sections ? "From your bots" : "Items"}
        aside={<>
          {tally && <span className="text-[12px] text-ink-secondary">{tally}</span>}
          {/* Beside the requests it acts on, and named for them. Under the
              engine rows it read as though it dismissed THEM. */}
          {dismissible.length > 1 && <button className={button} disabled={saving} aria-label={`Dismiss all ${dismissible.length} connection requests`} onClick={() => void dismiss(dismissible)}>Dismiss all {dismissible.length}</button>}
          {clearable.length > 1 && <button className={button} disabled={saving} aria-label={`Clear all ${clearable.length} that need nothing from you`} onClick={() => void clearAll(clearable)}>Clear all {clearable.length}</button>}
        </>}
      >
        <ul className="space-y-2" aria-label="Inbox items">
          {list.map(item => {
            // The bot's own words head the card whenever the live request can be
            // read; `item.title` is the kind of thing it is, and stays as the
            // line above it rather than as the headline.
            const card = cards[item.link.messageId];
            const headline = requestHeadline(card);
            const answerable = Boolean(card) && inlineAnswerKind(card) !== null;
            const snoozed = item.snoozedUntil !== null && item.snoozedUntil > Date.now();
            return <li key={item.id} className={`rounded-xl border bg-inset p-4 ${item.read ? "border-hairline/50" : "border-hairline"}`} data-inbox-id={item.id}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-secondary">
                {!item.read && <span className="size-2 shrink-0 rounded-full bg-accent" aria-hidden />}
                {!item.read && <span className="sr-only">Unread.</span>}
                <span className="font-medium text-ink/80">{item.sourceLabel}</span>
                <span aria-hidden>·</span>
                <time dateTime={new Date(item.at).toISOString()}>{shortWhen(item.at)}</time>
                {headline && <><span aria-hidden>·</span><span>{item.title}</span></>}
              </div>
              <h3 className="mt-1.5 break-words text-[15px] font-medium leading-snug">{headline || item.title}</h3>
              {owed && <p className="mt-1 text-[12.5px] text-ink-secondary">{owedWaitingLine(item, Date.now())}</p>}
              {item.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{item.summary}</p>}
              {/* Only what adds something. "Pending" on a card in a list
                  called Needs you, and "Read" on every card, said nothing. */}
              {(item.status !== "pending" || item.duplicates > 1 || (view !== "decisions" && snoozed)) && <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                {item.status !== "pending" && <span className="rounded-md bg-control px-2 py-0.5">{statusLabel(item.status)}</span>}
                {/* "Receipts" is the right word for the same request delivered
                    twice. It is the wrong word for an engine that failed to sign in
                    twenty times, which now arrives as one row carrying the count. */}
                {item.duplicates > 1 && <span className="py-0.5 text-ink-secondary">{item.kind === "error" ? `${item.duplicates} times` : `${item.duplicates} matching receipts`}</span>}
                {view !== "decisions" && snoozed && <span className="py-0.5 text-ink-secondary">Snoozed until {shortWhen(item.snoozedUntil!)}</span>}
              </div>}
              {answerable && <InboxRequestAnswer threadId={item.link.threadId} card={card!} botName={botNameFromSource(item.sourceLabel)} onSettled={() => setRevision(current => current + 1)} />}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={button} onClick={() => onOpen(item.link)}>Open {item.kind === "artifact" ? "file" : item.kind === "routine" || item.kind === "goal" ? "report" : "request"}</button>
                <button className={button} disabled={saving} onClick={() => void update(item, { read: !item.read })}>{item.read ? "Mark unread" : "Mark read"}</button>
                {item.dismissible && <button className={button} disabled={saving} onClick={() => void dismiss([item])}>Dismiss</button>}
                {item.clearable && <button className={button} disabled={saving} onClick={() => void update(item, { cleared: true })}>Clear</button>}
                {view !== "decisions" && (snoozed
                  ? <button className={button} disabled={saving} onClick={() => void update(item, { snoozedUntil: null })}>Return to Inbox</button>
                  : <button className={button} disabled={saving} onClick={() => void update(item, { snoozedUntil: Date.now() + 60 * 60 * 1000 })}>Snooze 1 hour</button>)}
              </div>
            </li>;
          })}
        </ul>
      </InboxSection>
    )}
    </div>
    {/* Only when there is somewhere to go. "Page 1 of 1" between two
        disabled buttons was a footer for nothing. */}
    {result && result.total > result.pageSize && <footer className="mt-4 flex items-center justify-between gap-3 border-t border-hairline/40 pt-4">
      <button className={button} disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span className="text-[12px] text-ink-secondary">Page {page + 1} of {Math.ceil(result.total / result.pageSize)}</span>
      <button className={button} disabled={(page + 1) * result.pageSize >= result.total} onClick={() => setPage(current => current + 1)}>Next</button>
    </footer>}
  </section>;
}
