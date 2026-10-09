// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Needs you": what a bot would like to remember, answerable where it is shown
// (PROPOSAL-v2 sections 3 and 9.2, items 0.4 to 0.8). Keep, Not now and Edit sit
// above each memory, sources below. An answer takes the row off the list at once
// and says so in a toast with Undo; nothing here has a global busy state, a
// "Working" line, a history reload or a status reload, so the page around the
// list never moves. The View is plain props in, markup out, so a test can look
// at the same markup a person sees.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { useMemoryWaiting } from "@/lib/use-memory-waiting";
import {
  applyWaitingSummary, batchSentence, errorSentence, headline, itemsForTab, keepAllLabel, keepAllTargets, keepTogetherLine, memoryAction, newActionId, newArrivals,
  reasonSentence, restoreItems, subjectCount, takeExpandRequest, withoutItems,
  type ItemResult, type PinChoice, type ReviewItem, type ReviewSubject,
} from "@/lib/memory-review";

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const BUTTON = `min-h-11 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover ${FOCUS}`;
const PRIMARY = `min-h-11 rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 ${FOCUS}`;
const INLINE_ROWS = 3;

export interface SourceLine { where: { kind: "chat" | "room" | "other"; name: string }; who: "you" | "bot" | "tool"; at: number | null; excerpt: string }
export interface Counts { waiting: number; later: number; everyday: number }
export interface Toast { message: string; undo?: () => void }

export interface Handlers {
  keep(item: ReviewItem): void; later(item: ReviewItem): void; back(item: ReviewItem): void; edit(item: ReviewItem): void;
  draft(text: string): void; saveEdit(item: ReviewItem): void; cancel(): void; pinKeep(item: ReviewItem, choice: PinChoice): void;
  keepAll(): void; expand(): void; collapse(): void; tab(tab: "waiting" | "later"): void; showNew(): void; sources(item: ReviewItem): void;
  dismissToast(): void;
}
const noop = () => undefined;
export const idleHandlers: Handlers = { keep: noop, later: noop, back: noop, edit: noop, draft: noop, saveEdit: noop, cancel: noop, pinKeep: noop, keepAll: noop, expand: noop, collapse: noop, tab: noop, showNew: noop, sources: noop, dismissToast: noop };

export interface ViewProps {
  subject: ReviewSubject; counts: Counts; items: readonly ReviewItem[]; tab: "waiting" | "later"; expanded: boolean;
  pending: ReadonlySet<string>; editing: { id: string; draft: string } | null; pinAsk: string | null; newCount: number;
  error: string | null; loading?: boolean; sources: Readonly<Record<string, readonly SourceLine[] | "loading" | "error">>; toast: Toast | null; now?: number; on?: Handlers;
}

function RowActions({ item, view, on }: { item: ReviewItem; view: ViewProps; on: Handlers }) {
  const editing = view.editing?.id === item.id, asking = view.pinAsk === item.id;
  if (editing) return <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
    <button type="button" className={`${PRIMARY} col-span-2`} onClick={() => on.saveEdit(item)} disabled={!view.editing?.draft.trim()}>Save and keep</button>
    <button type="button" className={BUTTON} onClick={on.cancel}>Cancel</button>
  </div>;
  if (asking) return <div className="space-y-2">
    <p className="text-[13px]">You pinned "{item.correction?.targetText ?? "an earlier memory"}". What should happen to the pin?</p>
    <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
      <button type="button" className={PRIMARY} onClick={() => on.pinKeep(item, "transfer")}>Keep the pin on the new one</button>
      <button type="button" className={BUTTON} onClick={() => on.pinKeep(item, "unpin")}>Remove the pin</button>
      <button type="button" className={BUTTON} onClick={on.cancel}>Cancel</button>
    </div>
  </div>;
  if (item.later) return <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
    <button type="button" className={PRIMARY} onClick={() => on.keep(item)}>Keep</button>
    <button type="button" className={BUTTON} onClick={() => on.back(item)}>Back to waiting</button>
  </div>;
  return <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
    <button type="button" className={`${PRIMARY} col-span-2 sm:col-span-1`} onClick={() => on.keep(item)}>Keep</button>
    <button type="button" className={BUTTON} onClick={() => on.later(item)}>Not now</button>
    <button type="button" className={BUTTON} onClick={() => on.edit(item)}>Edit</button>
  </div>;
}

function Row({ item, view, on }: { item: ReviewItem; view: ViewProps; on: Handlers }) {
  const editing = view.editing?.id === item.id, known = view.sources[item.id];
  return <li data-memory-item={item.id} aria-busy={view.pending.has(item.id) || undefined} className="space-y-2 border-t border-hairline/40 py-3 first:border-t-0">
    <RowActions item={item} view={view} on={on} />
    {editing
      ? <label className="block space-y-1 text-[13px]">Edit what {view.subject.name} keeps
          <textarea autoFocus rows={3} maxLength={4096} className="w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            value={view.editing?.draft ?? ""} onChange={event => on.draft(event.target.value)} onKeyDown={event => { if (event.key === "Escape") on.cancel(); }} />
        </label>
      : <p className="whitespace-pre-wrap break-words text-[13px]" data-testid="memory-waiting-text">{item.text}</p>}
    <p className="text-[12px] text-ink-secondary">{editing ? `Was: "${item.text}"` : reasonSentence(item, view.subject.name, view.now)}</p>
    <details onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) on.sources(item); }}>
      <summary className={`min-h-6 cursor-pointer text-[12px] text-ink-secondary ${FOCUS}`}>Why this?</summary>
      <div className="mt-1 space-y-1 text-[12px] text-ink-secondary">
        {known === undefined || known === "loading" ? <p>Looking up where this came from.</p>
          : known === "error" ? <p>Could not look that up right now.</p>
          : !known.length ? <p>No longer available: the message it came from was deleted.</p>
          : known.map((line, index) => <p key={index} className="break-words">
              From {line.where.kind === "room" ? `${line.where.name}` : line.where.kind === "chat" ? `your chat with ${line.where.name}` : "a conversation"}
              {line.at ? `, ${new Date(line.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
              {line.excerpt ? `: "${line.excerpt}"` : "."}
            </p>)}
        <p>Used in your chats with {view.subject.name}. Only you can see it.</p>
      </div>
    </details>
  </li>;
}

/** The whole block, as markup. Everything that can change on a press changes inside the list or in text; the frame around it is the same elements every time. */
export function MemoryNeedsYouView(view: ViewProps) {
  const on = view.on ?? idleHandlers;
  const { counts, expanded } = view;
  const shown = itemsForTab(view.items, view.tab);
  const rows = expanded ? shown : shown.slice(0, INLINE_ROWS);
  const oneByOne = rows.filter(item => item.rank < 2), everyday = rows.filter(item => item.rank >= 2);
  const grouped = expanded && view.tab === "waiting";
  return <>
    <section aria-label="Needs you" data-testid="memory-needs-you" className="rounded-xl border border-hairline/50 bg-panel">
      <header className="sticky top-0 z-10 space-y-3 rounded-t-xl border-b border-hairline/40 bg-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-[15px] font-medium" data-testid="memory-needs-you-count">{expanded ? `Needs you · ${view.subject.name} · ` : ""}{headline(counts.waiting)}</h3>
            <p className="min-h-[18px] text-[12px] text-ink-secondary">{keepTogetherLine(counts.everyday, counts.waiting)}</p>
          </div>
          <div className="flex min-h-11 flex-wrap items-center gap-2 max-sm:w-full">
            {counts.everyday > 0 && <button type="button" className={`${PRIMARY} max-sm:flex-1`} onClick={on.keepAll}>{keepAllLabel(counts.everyday)}</button>}
            {!expanded && counts.waiting > INLINE_ROWS && <button type="button" className={`${BUTTON} max-sm:flex-1`} onClick={on.expand}>Review all {counts.waiting}</button>}
            {expanded && <button type="button" className={BUTTON} onClick={on.collapse}>Show less</button>}
          </div>
        </div>
        {expanded && <div role="tablist" aria-label="Filter" className="flex gap-2">
          <button type="button" role="tab" aria-selected={view.tab === "waiting"} className={BUTTON} onClick={() => on.tab("waiting")}>Waiting {counts.waiting}</button>
          <button type="button" role="tab" aria-selected={view.tab === "later"} className={BUTTON} onClick={() => on.tab("later")}>Later {counts.later}</button>
        </div>}
      </header>
      <div className="px-4 pb-2">
        <p role="alert" className="min-h-0 text-[13px] text-danger">{view.error}</p>
        {view.newCount > 0 && <button type="button" className={`${BUTTON} my-2`} onClick={on.showNew}>{newArrivals(view.newCount)}</button>}
        <ul aria-label="Waiting memories">
          {grouped && oneByOne.length > 0 && <li role="presentation" className="pt-3 text-[12px] font-medium text-ink-secondary">One by one</li>}
          {(grouped ? oneByOne : rows).map(item => <Row key={item.id} item={item} view={view} on={on} />)}
          {grouped && everyday.length > 0 && <li role="presentation" className="pt-3 text-[12px] font-medium text-ink-secondary">Everyday</li>}
          {grouped && everyday.map(item => <Row key={item.id} item={item} view={view} on={on} />)}
        </ul>
        {!rows.length && view.loading && counts.waiting > 0 && <div aria-hidden="true" className="h-24" />}
        {!rows.length && !view.loading && (view.tab === "later" || counts.later > 0) && <p className="py-3 text-[13px] text-ink-secondary">{view.tab === "later" ? "Nothing in Later. Not now puts things here until you decide." : `${counts.later} in Later`}</p>}
      </div>
    </section>
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md" role="status" aria-live="polite">
      {view.toast && <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline bg-card px-4 py-3 text-[13px] shadow-xl">
        <span className="min-w-0 break-words">{view.toast.message}</span>
        {view.toast.undo && <button type="button" className={BUTTON} onClick={view.toast.undo}>Undo</button>}
      </div>}
    </div>
  </>;
}

const keptMessage = (subject: ReviewSubject) => subject.kind === "bot" ? `Kept for your chats with ${subject.name}.` : `Kept for ${subject.name}.`;

/** The block with its behaviour: loads the list, answers a press at once, undoes from the toast. */
export function MemoryNeedsYou({ subject }: { subject: ReviewSubject }) {
  const snap = useMemoryWaiting();
  const counts: Counts = subjectCount(snap, subject) ?? { waiting: 0, later: 0, everyday: 0 };
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [tab, setTab] = useState<"waiting" | "later">("waiting");
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [pinAsk, setPinAsk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<Record<string, readonly SourceLine[] | "loading" | "error">>({});
  const [toast, setToast] = useState<Toast | null>(null);
  const mounted = useRef(true), toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined), itemsRef = useRef<ReviewItem[]>([]);
  itemsRef.current = items;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(toastTimer.current); }; }, []);
  useEffect(() => { if (takeExpandRequest(subject)) setExpanded(true); }, [subject.kind, subject.id]);

  const say = useCallback((next: Toast | null) => {
    clearTimeout(toastTimer.current);
    setToast(next);
    if (next) toastTimer.current = setTimeout(() => { if (mounted.current) setToast(null); }, 6000);
  }, []);
  const mark = (ids: Iterable<string>, on: boolean) => setPending(current => { const next = new Set(current); for (const id of ids) { if (on) next.add(id); else next.delete(id); } return next; });

  // The list is read in place: no loading line, the rows already on screen stay until the new ones arrive.
  const load = useCallback(async (which: "waiting" | "later" = tab) => {
    try {
      const answer = await memoryAction(api, { action: "waiting-list", subjectType: subject.kind, subjectId: subject.id, tab: which });
      if (!mounted.current) return;
      setItems(answer.items); setLoaded(true); setMore(Boolean(answer.nextCursor)); applyWaitingSummary(answer.summary); setError(null);
    } catch (cause) { if (mounted.current) setError(errorSentence(cause)); }
  }, [subject.kind, subject.id, tab]);
  useEffect(() => { void load(); }, [load]);

  const loadedWaiting = items.filter(item => !item.later).length;
  const newCount = tab === "waiting" && !more ? Math.max(0, counts.waiting - loadedWaiting) : 0;

  /** The press that removes rows: they go at once, come back if it fails, and the answer's counts replace the shown ones. */
  const answer = async (ids: string[], work: () => Promise<{ summary?: Parameters<typeof applyWaitingSummary>[0] } & Record<string, any>>, done: (result: any) => Toast | null, restoreOnly?: (result: any) => string[]) => {
    const before = itemsRef.current, gone = new Set(ids);
    setItems(current => withoutItems(current, gone)); setEditing(null); setPinAsk(null); mark(ids, true);
    try {
      const result = await work();
      if (!mounted.current) return;
      if (result.summary) applyWaitingSummary(result.summary);
      const back = restoreOnly?.(result);
      if (back?.length) { setItems(current => restoreItems(current, before, new Set(back))); void load(); }
      say(done(result));
    } catch (cause) {
      if (!mounted.current) return;
      setItems(current => restoreItems(current, before, gone));
      say({ message: errorSentence(cause) });
      if (/MEMORY_VERSION_CONFLICT|MEMORY_NOT_FOUND/.test(cause instanceof Error ? cause.message : "")) void load();
    } finally { if (mounted.current) mark(ids, false); }
  };

  const undoKeeps = (kept: Array<{ actionId: string; id: string; version: number }>) => async () => {
    say(null);
    try {
      let last: any;
      const outcomes: string[] = [];
      for (const entry of kept) {
        last = await memoryAction(api, { action: "review-undo", actionId: newActionId(), keepActionId: entry.actionId, id: entry.id, version: entry.version });
        outcomes.push(last.result.status);
      }
      if (last?.summary) applyWaitingSummary(last.summary);
      await load();
      const archived = outcomes.filter(status => status === "archived").length;
      say({ message: archived === 0 ? "Back in Needs you." : archived === outcomes.length ? `Undone. ${subject.name} will not use this here.` : `Undone. ${archived} will not be used here.` });
    } catch (cause) { say({ message: errorSentence(cause) }); }
  };

  const keep = (item: ReviewItem, pin?: PinChoice) => {
    if (item.correction?.targetPinned && !pin) { setPinAsk(item.id); return; }
    const actionId = newActionId();
    void answer([item.id], () => memoryAction(api, { action: "review-keep", actionId, id: item.id, version: item.version, ...(pin ? { correctionPin: pin } : {}) }),
      result => ({ message: pin ? "Kept. The pin is updated." : keptMessage(subject), undo: () => void undoKeeps([{ actionId, id: item.id, version: result.result.version }])() }));
  };
  const handlers: Handlers = {
    keep: item => keep(item),
    pinKeep: (item, choice) => keep(item, choice),
    later: item => {
      const actionId = newActionId();
      void answer([item.id], () => memoryAction(api, { action: "review-later", actionId, id: item.id, version: item.version }),
        () => ({ message: "Moved to Later. It stays there until you decide.", undo: () => { void (async () => { try { const back = await memoryAction(api, { action: "review-back", id: item.id }); applyWaitingSummary(back.summary); await load(); say({ message: "Back in Needs you." }); } catch (cause) { say({ message: errorSentence(cause) }); } })(); } }));
    },
    back: item => {
      void answer([item.id], () => memoryAction(api, { action: "review-back", id: item.id }), () => ({ message: "Back in Needs you." }));
    },
    edit: item => { setPinAsk(null); setEditing({ id: item.id, draft: item.text }); },
    draft: text => setEditing(current => (current ? { ...current, draft: text } : current)),
    cancel: () => { setEditing(null); setPinAsk(null); },
    saveEdit: item => {
      const text = editing?.id === item.id ? editing.draft.trim() : "";
      if (!text) return;
      const actionId = newActionId();
      void answer([item.id], () => memoryAction(api, { action: "review-edit", actionId, id: item.id, version: item.version, text, keep: true }),
        result => ({ message: "Saved your wording and kept it.", undo: () => void undoKeeps([{ actionId, id: item.id, version: result.result.version }])() }));
    },
    keepAll: () => {
      const targets = keepAllTargets(itemsRef.current);
      if (!targets.length) return;
      const actionId = newActionId();
      void answer(targets.map(target => target.id), () => memoryAction(api, { action: "review-keep-all", actionId, items: targets }),
        result => {
          const results = result.results as ItemResult[];
          const kept = results.filter(item => item.status === "kept").map(item => ({ actionId, id: item.id, version: item.version }));
          return { message: batchSentence(results), ...(kept.length ? { undo: () => void undoKeeps(kept)() } : {}) };
        },
        result => (result.results as ItemResult[]).filter(item => item.status !== "kept").map(item => item.id));
    },
    expand: () => setExpanded(true),
    collapse: () => { setExpanded(false); setTab("waiting"); },
    tab: next => setTab(next),
    showNew: () => void load(),
    sources: item => {
      if (sources[item.id] && sources[item.id] !== "error") return;
      setSources(current => ({ ...current, [item.id]: "loading" }));
      void memoryAction(api, { action: "waiting-sources", id: item.id, version: item.version })
        .then(result => { if (mounted.current) setSources(current => ({ ...current, [item.id]: result.sources })); })
        .catch(() => { if (mounted.current) setSources(current => ({ ...current, [item.id]: "error" })); });
    },
    dismissToast: () => say(null),
  };
  return <MemoryNeedsYouView subject={subject} counts={counts} items={items} tab={tab} expanded={expanded} pending={pending} editing={editing} pinAsk={pinAsk} newCount={newCount} error={error} loading={!loaded} sources={sources} toast={toast} on={handlers} />;
}
