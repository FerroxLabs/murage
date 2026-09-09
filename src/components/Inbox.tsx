import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import type { InboxItem, InboxLink, InboxPage, InboxStateUpdate, InboxView } from "../../shared/inbox";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const field = "min-h-10 min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const statusLabel = (status: string) => status.replaceAll("-", " ").replace(/^./, first => first.toUpperCase());

/** Opening navigates to the exact persisted source. Only that conversation's
 * existing controls can answer an approval or resolve a request. */
export function Inbox({ onOpen, onClose, refreshKey = 0 }: { onOpen: (link: InboxLink) => void; onClose?: () => void; refreshKey?: number }) {
  const [view, setView] = useState<InboxView>("needs-you");
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
      if (!controller.signal.aborted) { setResult(null); setError(reason instanceof Error ? reason.message : "Inbox could not load."); }
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [view, query, page, includeSnoozed, revision, refreshKey]);

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
  return <section aria-labelledby="inbox-title" className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto bg-panel p-4 text-ink sm:p-6">
    <header className="flex items-center justify-between gap-3"><h1 id="inbox-title" className="text-[22px] font-semibold">Inbox</h1>
      <div className="flex gap-2"><button className={button} disabled={busy} onClick={() => setRevision(current => current + 1)}>Refresh</button>{onClose && <button className={button} onClick={onClose}>Close Inbox</button>}</div>
    </header>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">Background results and requests that need your attention. Reading or snoozing never answers a request.</p>
    <nav aria-label="Inbox views" className="mt-4 flex flex-wrap gap-2">
      {(["needs-you", "results", "all"] as const).map(value => <button key={value} className={`${button} ${view === value ? "border-accent bg-accent/10" : ""}`} aria-pressed={view === value} onClick={() => chooseView(value)}>
        {value === "needs-you" ? `Needs you${result ? ` (${result.needsYou})` : ""}` : value === "results" ? "Results" : "All"}
      </button>)}
    </nav>
    <form role="search" className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); setQuery(draft.trim()); setPage(0); }}>
      <label className="sr-only" htmlFor="inbox-search">Search Inbox</label><input id="inbox-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={`${field} flex-1`} placeholder="Search results or bots" />
      <button className={button} disabled={busy}>Search</button>
    </form>
    <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px] text-ink-secondary"><input type="checkbox" checked={includeSnoozed} onChange={event => { setIncludeSnoozed(event.target.checked); setPage(0); }} />Show snoozed items</label>
    {result && <p className="mb-3 text-[12px] text-ink-secondary">While you were away: {result.unread} unread on this page. {result.total} matching items.</p>}
    {busy && <p role="status" className="mb-3 text-[13px] text-ink-secondary">Updating Inbox…</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{error} Use Refresh to check the current source.</p>}
    {!busy && result && !list.length && <p className="rounded-xl border border-hairline/50 p-6 text-[13px] text-ink-secondary">{query ? "No matching Inbox items." : view === "needs-you" ? "Nothing needs your attention right now." : "No items in this view yet."}</p>}
    <ul className="space-y-3" aria-label="Inbox items">
      {list.map(item => <li key={item.id} className="rounded-xl border border-hairline/50 bg-inset p-4" data-inbox-id={item.id}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-secondary"><span>{item.sourceLabel}</span><time dateTime={new Date(item.at).toISOString()}>{new Date(item.at).toLocaleString()}</time></div>
        <h2 className="mt-2 break-words text-[15px] font-medium">{item.title}</h2>
        <div className="mt-2 flex flex-wrap gap-2 text-[12px]"><span className="rounded bg-control px-2 py-1">{statusLabel(item.status)}</span><span className="rounded bg-control px-2 py-1">{item.read ? "Read" : "Unread"}</span>
          {item.duplicates > 1 && <span className="px-1 py-1 text-ink-secondary">{item.duplicates} matching receipts</span>}
          {item.snoozedUntil !== null && item.snoozedUntil > Date.now() && <span className="px-1 py-1 text-ink-secondary">Snoozed until {new Date(item.snoozedUntil).toLocaleString()}</span>}
        </div>
        {item.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-secondary">{item.summary}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={button} onClick={() => onOpen(item.link)}>Open {item.kind === "artifact" ? "file" : item.kind === "routine" || item.kind === "goal" ? "report" : "request"}</button>
          <button className={button} disabled={busy} onClick={() => void update(item, { read: !item.read })}>{item.read ? "Mark unread" : "Mark read"}</button>
          {item.snoozedUntil !== null && item.snoozedUntil > Date.now()
            ? <button className={button} disabled={busy} onClick={() => void update(item, { snoozedUntil: null })}>Return to Inbox</button>
            : <button className={button} disabled={busy} onClick={() => void update(item, { snoozedUntil: Date.now() + 60 * 60 * 1000 })}>Snooze 1 hour</button>}
        </div>
      </li>)}
    </ul>
    {result && <footer className="mt-4 flex items-center justify-between gap-3 border-t border-hairline/40 pt-4">
      <button className={button} disabled={busy || page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span className="text-[12px] text-ink-secondary">Page {page + 1} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span>
      <button className={button} disabled={busy || (page + 1) * result.pageSize >= result.total} onClick={() => setPage(current => current + 1)}>Next</button>
    </footer>}
  </section>;
}
