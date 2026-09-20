import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import type { OptionCardData } from "@/state/store";
import type { InboxItem, InboxLink, InboxPage, InboxStateUpdate, InboxView } from "../../shared/inbox";
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
export function Inbox({ onOpen, onClose, refreshKey = 0, initialView = "needs-you" }: { onOpen: (link: InboxLink) => void; onClose?: () => void; refreshKey?: number; initialView?: InboxView }) {
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
    if (view !== "approvals") return;
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
  const list = result?.items ?? [];
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
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{view === "approvals" ? "Unresolved approvals and questions stay here until answered, cancelled or expired. Answer one here, or open it to see the whole conversation." : "Background results and requests that need your attention. Reading or snoozing never answers a request."}</p>
    <nav aria-label="Inbox views" className="mt-4 flex flex-wrap gap-2">
      {(["approvals", "needs-you", "results", "all"] as const).map(value => <button key={value} className={viewTab(view === value)} aria-pressed={view === value} onClick={() => chooseView(value)}>
        {value === "approvals" ? "Pending approvals" : value === "needs-you" ? `Needs you${result ? ` (${result.needsYou})` : ""}` : value === "results" ? "Results" : "All"}
      </button>)}
    </nav>
    <form role="search" className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setPage(0); }}>
      <label className="sr-only" htmlFor="inbox-search">Search Inbox</label><input id="inbox-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={`${field} flex-1`} placeholder="Search results or bots" />
      <button className={button} disabled={busy}>Search</button>
    </form>
    {view !== "approvals" && <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px] text-ink-secondary"><input type="checkbox" checked={includeSnoozed} onChange={event => { setIncludeSnoozed(event.target.checked); setPage(0); }} />Show snoozed items</label>}
    {result && <p className="mb-3 text-[12px] text-ink-secondary">While you were away: {result.unread} unread on this page. {result.total} matching items.</p>}
    {busy && <p role="status" className="mb-3 text-[13px] text-ink-secondary">Updating Inbox…</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{error} Displayed items may be stale. Use Refresh to check the current source.</p>}
    {!busy && result && !list.length && <p className="rounded-xl border border-hairline/50 p-6 text-[13px] text-ink-secondary">{query ? "No matching Inbox items." : view === "needs-you" ? "Nothing needs your attention right now." : "No items in this view yet."}</p>}
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
        {view === "approvals" && <p className="mt-2 text-[12px] text-ink-secondary">Waiting {Math.max(0, Math.floor((Date.now() - item.at) / 60000))} min for your {item.title.includes("Question") ? "answer" : "approval"}.</p>}
        {headline && <p className="mt-2 text-[12px] text-ink-secondary">{item.title}</p>}
        <h2 className="mt-1 break-words text-[15px] font-medium">{headline || item.title}</h2>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]"><span className="rounded bg-control px-2 py-1">{statusLabel(item.status)}</span><span className="rounded bg-control px-2 py-1">{item.read ? "Read" : "Unread"}</span>
          {item.duplicates > 1 && <span className="px-1 py-1 text-ink-secondary">{item.duplicates} matching receipts</span>}
          {view !== "approvals" && item.snoozedUntil !== null && item.snoozedUntil > Date.now() && <span className="px-1 py-1 text-ink-secondary">Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</span>}
        </div>
        {item.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{item.summary}</p>}
        {answerable && <InboxRequestAnswer threadId={item.link.threadId} card={card!} botName={botNameFromSource(item.sourceLabel)} onSettled={() => setRevision(current => current + 1)} />}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={button} onClick={() => onOpen(item.link)}>Open {item.kind === "artifact" ? "file" : item.kind === "routine" || item.kind === "goal" ? "report" : "request"}</button>
          <button className={button} disabled={busy} onClick={() => void update(item, { read: !item.read })}>{item.read ? "Mark unread" : "Mark read"}</button>
          {view !== "approvals" && (item.snoozedUntil !== null && item.snoozedUntil > Date.now()
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
