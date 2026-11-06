import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { api, useStoreIfAny } from "@/state/store";
import { LearningPausedCard } from "./LearningPausedCard";
import { BOX_FRAME, BoxBody, BoxHead } from "./ui/BoxShell";
import { EngineNeedCard, HealthNeedCard } from "./health/HealthNeedCard";
import { engineNeed } from "@/lib/engine-need";
import { firstRunOwnsMainView } from "@/lib/first-run";
import { useEngineReading } from "@/components/today/use-engine-health";
import type { OptionCardData } from "@/state/store";
import type { InboxItem, InboxLink, InboxPage, InboxStateUpdate, InboxView, RoutineRollup } from "../../shared/inbox";
import { InboxQuickAnswer, InboxRequestAnswer, inlineAnswerKind, readRequestCard, requestHeadline, requestSummary } from "./InboxRequest";
import { useSetupView } from "./FirstRunChrome";
import { inboxTabCounts, signedOutEngineIds, signedOutEngineRows, type SignedOutEngineRow } from "@/lib/signed-out-engines";
import { usePageVisible } from "@/lib/page-visible";
import { onInboxChanged } from "@/lib/inbox-changed";
import { backupWaitingSentence } from "../../shared/backup-waiting";
import { t } from "@/lib/i18n";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { InboxEngineSignInRow } from "./InboxEngineSignInRow";
import { NeedsRow } from "./needs/NeedsRow";
import { offerSnoozeUndo } from "./needs/snooze-undo";
import { BotAvatar } from "./Avatar";
import { botChips, createSnoozeReturns, groupNeeds, needsKeyAction, nextAfterAnswer, cameBack, doorOrder, isHeldActivation, snoozeTarget, waitingSinceTime } from "@/lib/needs-keys";
import { isEditableTarget, undoHost } from "@/lib/undo";
import { showSnoozeReturn } from "@/lib/notify";
import { ApproveAllButton } from "./ApproveAll";
import { approveAllHint } from "@/lib/approve-all";
import { bulkReadyRows, rowKey, rowKind, rowLine, rowMeta } from "@/lib/approval-row";

const ProjectRows=lazy(()=>import("./ProjectInboxRows"));
// One timer per row snoozed from the door, kept while the app is open (not while this page is), so the
// "came back" notification still lands after the owner has gone to another view.
const snoozeReturns = createSnoozeReturns();
// Learning suggestions and their screen copy load the first time the inbox has one (spec §6).
const LearningSuggestions = retryableLazy(() => import("./InboxLearningSuggestions").then((module) => ({ default: module.InboxLearningSuggestions })));
// Memories the bots would like to keep load the first time the inbox has some.
const MemoryWaitingCards = retryableLazy(() => import("./InboxMemoryWaiting").then((module) => ({ default: module.InboxMemoryWaiting })));
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
/** The Needs you door reads every waiting request on its page (25 at most): each row says WHAT it asks, and a plain
 *  one answers from the row (NEEDSYOU-INLINE-APPROVE), so no row is left a blind "Approval requested". */
const DOOR_CARD_LIMIT = 25;

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
  // The Needs you door's words for this tab (UX plan L2B): a sign-in that went, or a Flux Router allowance used up.
  connections: "A sign-in or an allowance stopped work. Fix it and the work goes ahead.",
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

export function Inbox({ onOpen, onClose, onOpenBackups, onOpenLearning, onOpenMemory, onOpenSettingsPage, refreshKey = 0, initialView = "decisions", door = false, onViewChange }: { onOpen: (link: InboxLink) => void; door?: boolean; /** a tab picked here (the page keeps it, and may ask for another through `initialView`) */ onViewChange?: (view: InboxView) => void; onClose?: () => void; onOpenBackups?: () => void; onOpenLearning?: (botId: string) => void; onOpenMemory?: (subject: { kind: "bot" | "room" | "other"; id: string; name: string }) => void; onOpenSettingsPage?: (section: "backups" | "storage" | "memory" | "engines" | "models", anchor?: string) => void; refreshKey?: number; initialView?: InboxView }) {
  const [view, setView] = useState<InboxView>(initialView);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [result, setResult] = useState<InboxPage | null>(null);
  // Once, after an upgrade, the server is still reading the history in: it
  // says so, and nothing it holds yet is shown as the Inbox.
  const [preparing, setPreparing] = useState(false);
  // Where each page after the first starts (the `next` of the page before),
  // so a later page is a seek on the server, not a count from the top.
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([]);
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
  // Refresh presses only (APPROVALS-SIMPLE-1018 3b): each closes anything Approve all has open, whatever the list reads.
  const [refreshes, setRefreshes] = useState(0);
  // What the person has already answered here: item ids, and `engine:<id>`.
  // Hidden the moment they click, so the row goes when they say so and not
  // when the next read happens to land, and a read already in flight when
  // they clicked cannot bring it back. Put back only if the change failed.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const changing = useRef(false);
  // THE NEEDS YOU DOOR (UX L2B). On the owed tabs each row is one line with Open; the card opens in place and every
  // verb is on the open card. `openId` is the open card, `botFilter` the chip picked ("" = All).
  const [openId, setOpenId] = useState<string | null>(null);
  const [botFilter, setBotFilter] = useState("");
  const heads = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<{ id: string; into: boolean } | null>(null);
  // Snoozes already written, by id, with the first list revision that reads them back from the server.
  const snoozeWritten = useRef(new Map<string, number>());
  const revisionNow = useRef(revision);
  revisionNow.current = revision;
  useEffect(() => {
    const controller = new AbortController();
    const startedAt = revision;
    setLoading(true);
    const params = new URLSearchParams({ view, query, page: String(page), pageSize: "25", includeSnoozed: String(includeSnoozed) });
    const after = page > 0 ? cursors[page] : undefined;
    if (after) params.set("after", after);
    void api(`/api/inbox?${params}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setReadError(null);
      if ((value as InboxPage).preparing) { setPreparing(true); return; }
      setPreparing(false); setResult(value as InboxPage);
      // A written snooze was held out of the list only until a read made after the write; from here the server's answer decides (hidden, or shown with its time).
      const landed = [...snoozeWritten.current].filter(([, at]) => at <= startedAt).map(([id]) => id);
      if (landed.length) {
        for (const id of landed) snoozeWritten.current.delete(id);
        setGone(current => new Set([...current].filter(id => !landed.includes(id))));
      }
    }).catch(reason => {
      if (!controller.signal.aborted) setReadError(reason instanceof Error ? reason.message : "Inbox could not load.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
    // `cursors` changes only together with `page`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, query, page, includeSnoozed, revision, refreshKey]);
  // Read again shortly while it is getting ready; the server also announces the end.
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setTimeout(() => setRevision(current => current + 1), 2000);
    return () => window.clearTimeout(timer);
  }, [preparing, revision]);

  // A CHANGE ELSEWHERE REACHES EVERY TAB (FUNCTION-SWEEP-1018). The rail badge re-reads on the server's `inbox.changed`
  // and only Needs you had a beat of its own, so on Approvals a new request (or one answered on the phone) moved the
  // badge to 3 while the open tab still said (2) and listed the old rows until Refresh. Every tab now reads on the notice.
  useEffect(() => onInboxChanged(() => setRevision(current => current + 1)), []);
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
  const reset = () => { setResult(null); setPage(0); setCursors([]); };
  const chooseView = (next: InboxView) => { if (next !== view) { setView(next); reset(); setOpenId(null); setBotFilter(""); onViewChange?.(next); } };
  // THE TAB IS THE PAGE'S, NOT ONLY OURS (FUNCTION-SWEEP-1018). A tab picked here never reached the page, so the page
  // still thought it was on Needs you, and the rail's Needs you door (which asks for that tab) changed nothing while
  // Approvals was open. Picked tabs are reported up; a tab the page asks for is taken here.
  useEffect(() => { chooseView(initialView); }, [initialView]); // eslint-disable-line react-hooks/exhaustive-deps
  // Setting aside a request to connect an app: the same call as the card's
  // own "Not now" in the chat, one card or every one on this page.
  const dismiss = (items: InboxItem[]) => act(items.map(item => item.id), async () => {
    for (const item of items) {
      const cards = item.dismissVia === "mcp-sign-in" ? "mcp-sign-in-cards" : "connector-cards";
      await api(`/api/bots/${encodeURIComponent(item.botId!)}/${cards}/${encodeURIComponent(item.link.messageId)}/dismiss`, {
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
  const projectRows=result?.projects??[];
  const groupedMessages=new Set(projectRows.flatMap(row=>row.approvals.map(item=>item.messageId)));
  const list = inboxCardItems(view, result?.items ?? []).filter(item => !gone.has(item.id) && !groupedMessages.has(item.link.messageId));
  const routineRows = result?.routines ?? [];
  const restoreRows = result?.restore ?? [];
  // A LIVE READING, NOT A MESSAGE. See src/lib/signed-out-engines.ts: the
  // server already computes this on every setup view and exactly one
  // component ever read it, so a login that expires on day two was reported
  // nowhere at all.
  const { view: setupView, refresh: refreshSetup } = useSetupView();
  // FUIGO FRONT AND CENTER (FUIGO-FIRST-SIGNIN-PLACEMENT, 1.0.14). A row here
  // means a bot runs on an engine nobody is signed in to, so the main button
  // moves those bots to Fuigo when Fuigo can answer now. It is the owner's own
  // pick, through the same write as the model picker.
  // Read without requiring the provider: the Inbox draws without one, as it
  // did before this row needed the instance list (InboxRequest.test.ts).
  const store = useStoreIfAny();
  const instances = store?.state.instances ?? [];
  // Ready means the setup view counts it as an engine that can answer now
  // (a key or a login, and a catalogue), checked per candidate.
  const fuigo = instances.find(instance => instance.driverKind === "fuigoAgent" && instance.enabled !== false && instance.models.default.trim()
    && Boolean(setupView?.agents.some(agent => agent.id === instance.instanceId)));
  const fuigoReady = Boolean(fuigo);
  // Every write is awaited, so a refused one (a busy chat, say) reaches act's
  // catch and the row comes back; the setup view is re-read after all land.
  const moveToFuigo = (engine: SignedOutEngineRow) => act([`engine:${engine.id}`], async () => {
    if (!fuigo) return;
    const selection = { instanceId: fuigo.instanceId, model: fuigo.models.default };
    await Promise.all(engine.usedBy.map(user => user.threadId
      ? api(`/api/bots/${encodeURIComponent(user.id)}/tasks/${encodeURIComponent(user.threadId)}`, { method: "PATCH", body: JSON.stringify({ modelSelection: selection }) })
      : api(`/api/bots/${encodeURIComponent(user.id)}`, { method: "PATCH", body: JSON.stringify({ modelSelection: selection, settingsScope: "defaults" }) })));
    refreshSetup();
  }, "Those bots could not be moved to Fuigo.");
  const signedOut = (view === "connections" || view === "decisions" ? signedOutEngineRows(setupView) : [])
    .filter(engine => !gone.has(`engine:${engine.id}`));
  // The counts the tabs read, with the live rows folded in. Both numbers or
  // neither: the three segments sum to the umbrella.
  // Every tab counts every signed-out engine, not only the tabs that list
  // them (inboxTabCounts), so the numbers stay put when the tab changes.
  const reading = useEngineReading();
  const engineRow = engineNeed({ engine: reading.health, flux: reading.flux }, signedOutEngineIds(setupView), Boolean(setupView && firstRunOwnsMainView(setupView)));
  const shown = inboxTabCounts(result, setupView, gone, engineRow ? [{ id: engineRow.key }] : []);
  // A daily backup held up by a waiting card (0.1.60 Linux D6). Shown where
  // decisions are, beside the card it waits for; never counted.
  const backupWaiting = view === "decisions" || view === "approvals" || view === "questions" ? result?.backupWaiting ?? null : null;
  // The last backup stopped (0.1.60 Windows W-D7): news that needs a hand,
  // shown with the decisions and the things to read. Backups stay paused
  // until it is cleared, so the server counts it in `decisions`.
  const backupFailed = view === "decisions" || view === "to-read" || view === "all" ? result?.backupFailed ?? null : null;
  // WHAT NEEDS THE OWNER, FIRST (Sean 11-01). Health used to sit here as a whole card, and he scrolled past it every time
  // to reach what was waiting. Only a Health problem the owner must act on comes here, as an ordinary item with one
  // action, already counted by the server. Everything else is on the Health screen, one quiet link away above this page (needs/NeedsYouPageBody.tsx).
  const healthNeeds = view === "decisions" || view === "all" ? result?.health?.needs ?? [] : [];
  const engineProblem = view === "decisions" || view === "connections" || view === "all" ? engineRow : null;
  // A FLUX ROUTER ALLOWANCE USED UP is a connection problem with two ways on (UX L2B): open Flux Router, or use your own
  // key. A live reading (GET /api/engine-health), so it goes by itself once Flux answers again; counted once, in
  // Connections (inboxTabCounts, usePendingApprovals). Every other engine problem stays with Health.
  const fluxUsedUp = engineProblem?.key === "flux-used-up" ? engineProblem : null;
  const healthEngine = fluxUsedUp ? null : engineProblem;
  const openSettingsAt = (anchor: string) => {
    if (onOpenSettingsPage) onOpenSettingsPage("models", anchor);
    else store?.dispatch({ type: "toggleAppSettings", open: true, section: "models", anchor });
  };
  // Lessons a bot suggested, waiting for the owner's yes: the only learning the Inbox shows.
  const suggestionRows = view === "decisions" || view === "all" ? result?.learningSuggestions ?? [] : [];
  // Memories the bots would like to keep: one card per bot, counted per item in `decisions` (server/inbox-memory-waiting.ts).
  const memoryRows = view === "decisions" || view === "all" ? result?.memoryWaiting ?? [] : [];
  // Learning stopped at this month's limit: derived by the server on every read, counted once in `decisions` (server/inbox-learning-paused.ts).
  const learningPaused = view === "decisions" || view === "all" ? result?.learningPaused ?? null : null;
  const ownRows = [...projectRows,...restoreRows, ...signedOut, ...healthNeeds, ...(engineProblem ? [engineProblem] : []), ...(backupWaiting ? [backupWaiting] : []), ...(backupFailed ? [backupFailed] : []), ...(learningPaused ? [learningPaused] : []), ...suggestionRows, ...memoryRows];
  const dismissible = list.filter(item => item.dismissible);
  const clearable = list.filter(item => item.clearable);
  // The live card for each waiting request on this page, keyed by message id.
  // A thread this surface cannot read simply yields nothing, and the row
  // keeps its "Open request" button.
  const [cards, setCards] = useState<Record<string, OptionCardData>>({});
  const pendingRequests = (door ? doorOrder(list, Date.now()) : list).filter(item => item.kind === "request" && item.status === "pending");
  // The door reads the live card of the open row too, wherever it sits, so an open card always has its verbs.
  const cardLimit = door ? DOOR_CARD_LIMIT : INLINE_CARD_LIMIT;
  const openBeyond = door && openId ? pendingRequests.slice(cardLimit).find(item => item.id === openId) : undefined;
  const waiting = [...pendingRequests.slice(0, cardLimit), ...(openBeyond ? [openBeyond] : [])];
  const waitingKey = waiting.map(item => `${item.link.threadId}:${item.link.messageId}:${item.version}`).join("|");
  useEffect(() => {
    if (!waiting.length) { setCards(current => (Object.keys(current).length ? {} : current)); return; }
    const controller = new AbortController();
    void Promise.all(waiting.map(async item => {
      const card = await readRequestCard(item.link, controller.signal);
      return card ? ([item.link.messageId, card] as const) : null;
    })).then(found => {
      if (controller.signal.aborted) return;
      setCards(Object.fromEntries(found.filter(entry => entry !== null)));
    });
    return () => controller.abort();
    // `waitingKey` is the identity of everything `waiting` holds; depending on
    // the array itself would re-fetch on every render.
  }, [waitingKey]);
  const owed = INBOX_OWED_VIEWS.includes(view);
  // THE DOOR'S LIST: oldest first so nothing waits twice, a chip per bot, and past 20 rows a group per bot.
  const doorRows = door && owed;
  const botOf = (item: InboxItem) => botNameFromSource(item.sourceLabel);
  const ordered = doorRows ? doorOrder(list, Date.now()) : list;
  const chips = doorRows ? botChips(ordered, botOf) : [];
  const picked = doorRows && botFilter && chips.some(chip => chip.bot === botFilter) ? botFilter : "";
  const groups = doorRows ? groupNeeds(picked ? ordered.filter(item => botOf(item) === picked) : ordered, botOf) : [];
  const doorIds = groups.flatMap(group => group.rows.map(item => item.id));
  const shownOpen = openId && doorIds.includes(openId) ? openId : null;
  // "N snoozed" counts what this tab's Show snoozed brings back: everything owed on Needs you, the segment's own on its tab.
  const snoozedOwed = owed ? (view === "decisions" ? result?.snoozedOwed : result?.snoozedHere) ?? 0 : 0;
  // Focus follows the sweep: into the card that just opened (its first control, so 1 to 9 pick), or back to a row's Open.
  useEffect(() => {
    const next = focusAfter.current;
    if (!next) return;
    focusAfter.current = null;
    const head = heads.current.get(next.id);
    if (!next.into) { head?.focus(); return; }
    const body = document.getElementById(`needs-row-body-${next.id}`);
    // Never onto a verb: a held Enter that opened the row must not land on Allow. A question's first group takes 1 to 9.
    const group = body?.querySelector<HTMLElement>('[role="radiogroup"][tabindex="0"], [role="group"][tabindex="0"]');
    const item = list.find(entry => entry.id === next.id);
    const loading = item?.kind === "request" && item.status === "pending" && !cards[item.link.messageId];
    if (group) group.focus();
    else if (body) { if (!body.hasAttribute("tabindex")) body.setAttribute("tabindex", "-1"); body.focus(); }
    else head?.focus();
    // The live card has not arrived yet: try again when it does.
    if (!group && loading) focusAfter.current = next;
  });
  const openRow = (id: string | null, into = true) => { setOpenId(id); if (id) focusAfter.current = { id, into }; };
  /** A one-click answer from a collapsed row (NEEDSYOU-INLINE-APPROVE) was accepted: the row leaves now, and focus
   *  goes to the next row's Open, never onto another answer, so a second Enter opens a card rather than approving. */
  const settledInline = (item: InboxItem) => {
    snoozeReturns.cancel(item.id);
    const next = nextAfterAnswer(doorIds, item.id);
    setGone(current => new Set([...current, item.id]));
    if (next && next !== item.id) focusAfter.current = { id: next, into: false };
    // the last row answered: the page's heading, so focus is never dropped (Astra full review Medium)
    else requestAnimationFrame(() => document.getElementById("inbox-title")?.focus());
    setRevision(current => current + 1);
  };
  const snooze = (item: InboxItem) => {
    const target = snoozeTarget(Date.now());
    const remaining = doorIds.filter(id => id !== item.id);
    setGone(current => new Set([...current, item.id]));
    if (shownOpen === item.id) openRow(nextAfterAnswer(doorIds, item.id));
    else if (remaining.length) focusAfter.current = { id: nextAfterAnswer(doorIds, item.id) ?? remaining[0]!, into: false };
    const putBack = () => setGone(current => new Set([...current].filter(id => id !== item.id)));
    let written: Promise<unknown> | null = null;
    let undone = false;
    offerSnoozeUndo(undoHost, {
      id: item.id,
      message: target.tomorrow ? t("ux.l2b.snooze.doneTomorrow", { time: target.time }) : t("ux.l2b.snooze.done", { time: target.time }),
      onUndo: (committed) => {
        undone = true;
        snoozeWritten.current.delete(item.id);
        putBack();
        snoozeReturns.cancel(item.id);
        if (!committed) return;
        // After the snooze write settles, so the clear can never land first.
        void (written ?? Promise.resolve()).catch(() => undefined).then(() => saveState(item, { snoozedUntil: null })).then(() => setRevision(current => current + 1), () => setActionError(t("ux.l2b.snooze.undoFailed")));
      },
      commit: () => {
        written = saveState(item, { snoozedUntil: target.until });
        void written.then(() => {
          if (undone) return;
          snoozeWritten.current.set(item.id, revisionNow.current + 1);
          snoozeReturns.schedule(item.id, target.until, Date.now(), () => {
            showSnoozeReturn(`${item.id}:${target.until}`, { title: t("ux.l2b.snooze.returnTitle"), body: t("ux.l2b.snooze.returnBody") }, () => store?.dispatch({ type: "showNeedsYou" }));
            setRevision(current => current + 1);
          });
          setRevision(current => current + 1);
        }, () => { putBack(); setActionError(t("ux.l2b.snooze.failed")); });
      },
    });
  };
  // A held key never answers: its repeats (Enter, Space, 1 to 9) are stopped on the way down, before any card or button
  // inside the door sees them, so each answer, and each card the sweep opens, takes a fresh press.
  const onDoorKeyCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (isHeldActivation(event) && !isEditableTarget(event.target as HTMLElement)) { event.preventDefault(); event.stopPropagation(); }
  };
  const onDoorKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-needs-row]")?.dataset.needsRow ?? null;
    const onHead = target.hasAttribute("data-needs-open");
    // Enter and Space on a row's Open button, or on its one-click answer, are that button's own click.
    if ((onHead || target.closest("[data-needs-quick]")) && (event.key === "Enter" || event.key === " ")) return;
    const action = needsKeyAction({
      key: event.key,
      typing: event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(target),
      handled: event.defaultPrevented,
      inCard: Boolean(row && row === shownOpen && !onHead),
    }, doorIds, row, shownOpen);
    if (!action) return;
    event.preventDefault();
    if (action.type === "open") openRow(action.id);
    else if (action.type === "close") { const was = shownOpen; setOpenId(null); if (was) focusAfter.current = { id: was, into: false }; }
    else if (action.type === "focus") heads.current.get(action.id)?.focus();
    else if (action.type === "snooze") { const item = ordered.find(entry => entry.id === action.id); if (item) snooze(item); }
  };
  const tally = result ? inboxTally(result.total - result.items.filter(item => gone.has(item.id)).length, result.unread) : "";
  const sections = signedOut.length + restoreRows.length + healthNeeds.length + (engineProblem ? 1 : 0) + (backupWaiting ? 1 : 0) + (backupFailed ? 1 : 0) + (learningPaused ? 1 : 0) + suggestionRows.length + memoryRows.length + (view === "routines" ? routineRows.length : 0) > 0;
  /** One item's card: the classic Inbox row, and the inside of an open Needs you row (the same card, so the verbs match). */
  const remindLabel = () => { const target = snoozeTarget(Date.now()); return t(target.tomorrow ? "ux.l2b.snooze.tomorrow" : "ux.l2b.snooze.at", { time: target.time }); };
  const cardBody = (item: InboxItem) => {
            // The bot's own words head the card whenever the live request can be
            // read; `item.title` is the kind of thing it is, and stays as the
            // line above it rather than as the headline.
            const card = cards[item.link.messageId];
            // APPROVALS-SIMPLE-1018: an approval is headed by what the bot wants, in words ("Petra wants to ..."),
            // never by its command; the command stays in the answer panel and the conversation.
            const headline = requestHeadline(card) || (card && inlineAnswerKind(card) === "approval" ? rowLine(card, botNameFromSource(item.sourceLabel), requestSummary) : "");
            const answerable = Boolean(card) && inlineAnswerKind(card) !== null;
            const snoozed = item.snoozedUntil !== null && item.snoozedUntil > Date.now();
            // The door shows snoozed rows only when asked to, and says when each comes back.
            const snoozeShown = view !== "decisions" || door;
            return <>
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
              {(item.status !== "pending" || item.duplicates > 1 || (snoozeShown && snoozed)) && <div className="mt-2 flex flex-wrap gap-2 text-[12px]">
                {item.status !== "pending" && <span className="rounded-md bg-control px-2 py-0.5">{statusLabel(item.status)}</span>}
                {/* "Receipts" is the right word for the same request delivered
                    twice. It is the wrong word for an engine that failed to sign in
                    twenty times, which now arrives as one row carrying the count. */}
                {item.duplicates > 1 && <span className="py-0.5 text-ink-secondary">{item.kind === "error" ? `${item.duplicates} times` : `${item.duplicates} matching receipts`}</span>}
                {snoozeShown && snoozed && <span className="py-0.5 text-ink-secondary">{door ? t("ux.l2b.snooze.until", { time: shortWhen(item.snoozedUntil!) }) : `Snoozed until ${shortWhen(item.snoozedUntil!)}`}</span>}
              </div>}
              {answerable && <InboxRequestAnswer threadId={item.link.threadId} card={card!} botName={botNameFromSource(item.sourceLabel)} details={door} onSettled={() => {
                // The sweep: an accepted answer takes the row away now and opens the next one.
                snoozeReturns.cancel(item.id);
                if (doorRows) { setGone(current => new Set([...current, item.id])); openRow(nextAfterAnswer(doorIds, item.id)); }
                setRevision(current => current + 1);
              }} />}
              <div className="mt-3 flex flex-wrap gap-2">
                <button className={button} onClick={() => onOpen(item.link)}>Open {item.kind === "artifact" ? "file" : item.kind === "routine" || item.kind === "goal" ? "report" : "request"}</button>
                <button className={button} disabled={saving} onClick={() => void update(item, { read: !item.read })}>{item.read ? "Mark unread" : "Mark read"}</button>
                {item.dismissible && <button className={button} disabled={saving} onClick={() => void dismiss([item])}>Dismiss</button>}
                {item.clearable && <button className={button} disabled={saving} onClick={() => void update(item, { cleared: true })}>Clear</button>}
                {doorRows && (snoozed
                  ? <button className={button} disabled={saving} onClick={() => { snoozeReturns.cancel(item.id); void update(item, { snoozedUntil: null }); }}>{t("ux.l2b.snooze.returnNow")}</button>
                  : <button className={button} disabled={saving} aria-keyshortcuts="S" onClick={() => snooze(item)}>{remindLabel()}</button>)}
                {!doorRows && view !== "decisions" && (snoozed
                  ? <button className={button} disabled={saving} onClick={() => void update(item, { snoozedUntil: null })}>Return to Inbox</button>
                  : <button className={button} disabled={saving} onClick={() => void update(item, { snoozedUntil: Date.now() + 60 * 60 * 1000 })}>Snooze 1 hour</button>)}
              </div>
            </>;
  };
  // Approve all counts and binds to the rows ON SCREEN (APPROVALS-SIMPLE-1018 section 3): the door's rows under the
  // bot picked, else the list. `listed` is every request row shown, the generation token of 3b.
  const shownRows = doorRows ? groups.flatMap(group => group.rows) : list;
  const approveAllEligible = approveAllHint(view, shownRows);
  const approveAllReady = bulkReadyRows(shownRows).map(item => rowKey(item.link));
  const approveAllListed = shownRows.filter(item => item.kind === "request").map(item => rowKey(item.link));
  // The grey line's "one at a time: {reason}" is said only where Approve all is on offer (2 or more it would answer).
  const bulkNote = (approveAllEligible ?? 0) >= 2;
  return <section aria-labelledby="inbox-title" aria-busy={loading} className={`${BOX_FRAME} mx-auto h-full w-full max-w-4xl bg-panel text-ink`}>
    <BoxHead className="border-b border-hairline/40 px-4 py-3 sm:px-6"><h1 id="inbox-title" tabIndex={-1} className="text-[22px] font-semibold focus:outline-none">{door ? t("ux.l2a.door.needsYou") : "Inbox"}</h1>
      <div className="flex gap-2">
        {/* Refresh re-reads everything on the page: the list and its counts, the signed-out engine rows (FUNCTION-SWEEP-1018:
            they waited for their own poll), and it closes anything Approve all had open (APPROVALS-SIMPLE-1018 3b). */}
        <button className={`${button} inline-flex items-center gap-2`} disabled={saving} onClick={() => { setRevision(current => current + 1); setRefreshes(current => current + 1); refreshSetup(); }}>
          <RefreshCw size={14} aria-hidden className={loading ? "animate-spin motion-reduce:animate-none" : ""} />Refresh
        </button>
        {onClose && <button className={button} onClick={onClose}>Close Inbox</button>}
      </div>
    </BoxHead>
    <BoxBody className="flex flex-col p-4 sm:p-6">
    <p className="text-[13px] leading-relaxed text-ink-secondary">{INBOX_VIEW_COPY[view] ?? INBOX_VIEW_COPY.all}</p>
    {/* Approve all (APPROVE-ALL-1016): Approvals and Needs you; the server says whether this surface shows it, and under 2 it stays away */}
    {approveAllEligible !== null && <ApproveAllButton ready={approveAllReady} listed={approveAllListed} refreshes={refreshes} onApplied={() => setRevision(current => current + 1)} onChanged={() => setRevision(current => current + 1)} />}
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
        {/* Snoozed rows still count on the umbrella (hiding is not answering), as on the rail's badge. */}
        {label}{shown && count ? ` (${count(shown) + (door && value === "decisions" ? result?.snoozedOwed ?? 0 : 0)})` : ""}
      </button>)}
    </nav>
    <form role="search" className="mt-4 flex gap-2" onSubmit={event => { event.preventDefault(); const next = draft.trim(); if (next !== query) { setQuery(next); reset(); } else setRevision(current => current + 1); }}>
      <label className="sr-only" htmlFor="inbox-search">Search Inbox</label><input id="inbox-search" type="search" maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} className={`${field} flex-1`} placeholder="Search results or bots" />
      <button className={button}>Search</button>
    </form>
    {door && snoozedOwed > 0 && <p className="mt-3 flex min-h-10 flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
      <span>{snoozedOwed === 1 ? t("ux.l2b.snooze.hiddenOne") : t("ux.l2b.snooze.hiddenMany", { n: snoozedOwed })}</span>
      <button type="button" className={button} aria-pressed={includeSnoozed} onClick={() => { setIncludeSnoozed(!includeSnoozed); reset(); }}>{includeSnoozed ? t("ux.l2b.snooze.hide") : t("ux.l2b.snooze.show")}</button>
    </p>}
    {!owed && <label className="mt-3 flex min-h-10 items-center gap-2 text-[13px] text-ink-secondary"><input type="checkbox" checked={includeSnoozed} onChange={event => { setIncludeSnoozed(event.target.checked); reset(); }} />Show snoozed items</label>}
    <div className="mt-5 flex-1">
    {actionError && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{actionError}</p>}
    {readError && <p role="alert" className="mb-3 rounded-lg border border-danger/40 p-3 text-[13px] text-danger">{readError} What is shown may be out of date. Use Refresh to try again.</p>}
    {!result && !readError && <p className="py-10 text-center text-[13px] text-ink-secondary">{preparing ? "Getting your inbox ready" : "Loading…"}</p>}
    {/* Routines draws its own list, so its emptiness is the rollup's, not
        the card list's. Reading `list` here would print "your routines have
        not run yet" underneath four routines that plainly had. */}
    {result && inboxShowsEmpty(view, list, routineRows, ownRows) && <p className="rounded-xl border border-dashed border-hairline/60 p-8 text-center text-[13px] text-ink-secondary">{query ? "No matching Inbox items." : (INBOX_VIEW_EMPTY[view] ?? "No items in this view yet.")}
      {door && !query && view === "decisions" && <span className="mt-1 block">{t("ux.l2b.door.emptyMore")}</span>}</p>}
    {/* A BACKUP THAT WAITS ON A CARD.
        Every backup closes and reopens Murage, and a run waiting on the
        owner cannot survive that, so the backup waits. Ask cards wait
        indefinitely, so this says so here instead of backups quietly
        stopping. It clears itself the moment the card is answered. */}
    {fluxUsedUp && (
      <InboxSection label={t("ux.l2b.flux.section")}>
        <div role="status" data-needs-flux className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
          <p className="font-medium text-ink">{t("ux.l2b.flux.title")}</p>
          <p className="mt-1 text-ink-secondary">{t("ux.l2b.flux.detail")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={button} onClick={() => openSettingsAt("flux-router-heading")}>{t("ux.l2b.flux.open")}</button>
            <button type="button" className={button} onClick={() => openSettingsAt("models-heading")}>{t("ux.l2b.flux.ownKey")}</button>
          </div>
        </div>
      </InboxSection>
    )}
    {(healthNeeds.length > 0 || healthEngine) && (
      <InboxSection label={t("ux.l2a.health.title")}>
        <div className="space-y-2">
          {healthEngine && <EngineNeedCard title={healthEngine.title} detail={healthEngine.detail} label={healthEngine.label} onOpen={onOpenSettingsPage ? () => onOpenSettingsPage(healthEngine.section) : undefined} />}
          {healthNeeds.map(need => <HealthNeedCard key={need.titleKey} need={need} now={Date.now()} onOpen={onOpenSettingsPage} />)}
        </div>
      </InboxSection>
    )}
    {backupFailed && (
      <InboxSection label="Backups">
        <div role="status" className="rounded-xl border border-danger/30 bg-danger/[0.06] p-4 text-[13px]">
          <p className="font-medium text-ink">The last backup didn't finish</p>
          <p className="mt-1 text-ink-secondary">{backupFailed.sentence}</p>
          {onOpenBackups && <div className="mt-3 flex flex-wrap gap-2"><button className={button} onClick={onOpenBackups}>Open Backups</button></div>}
        </div>
      </InboxSection>
    )}
    {learningPaused && (
      <InboxSection label={t("settings.l6.paused.section")}>
        <LearningPausedCard row={learningPaused} onSettled={() => setRevision(current => current + 1)} />
      </InboxSection>
    )}
    {memoryRows.length > 0 && (
      <InboxSection label="Memories">
        <LazyBoundary inline onRetry={MemoryWaitingCards.retry}><Suspense fallback={null}><MemoryWaitingCards.Component rows={memoryRows} onSettled={() => setRevision(current => current + 1)} onOpenMemory={onOpenMemory} /></Suspense></LazyBoundary>
      </InboxSection>
    )}
    {suggestionRows.length > 0 && (
      <InboxSection label={t("inboxLearning.section")}>
        <LazyBoundary inline onRetry={LearningSuggestions.retry}><Suspense fallback={null}><LearningSuggestions.Component rows={suggestionRows} onSettled={() => setRevision(current => current + 1)} onOpenLearning={onOpenLearning} /></Suspense></LazyBoundary>
      </InboxSection>
    )}
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
      <InboxSection label="Bots that can't answer">
        <ul className="space-y-2" aria-label="Bots that can't answer">
          {signedOut.map(engine => (
            <InboxEngineSignInRow
              key={engine.id}
              engine={engine}
              fuigoReady={fuigoReady}
              busy={saving}
              onUseFuigo={() => void moveToFuigo(engine)}
              onOpenModels={() => onOpenSettingsPage ? onOpenSettingsPage("models") : store?.dispatch({ type: "toggleAppSettings", open: true, section: "models" })}
              onDone={refreshSetup}
            >
              {turningOff !== engine.id && <button className={`${button} mt-2`} disabled={saving} onClick={() => setTurningOff(engine.id)}>I don't use {engine.name}</button>}
              {turningOff === engine.id && <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-warning/20 pt-3">
                <span className="mr-auto text-ink-secondary">Turn off {engine.name}? Bots stop using it. You can turn it back on in Settings, Engines.</span>
                <button className={button} disabled={saving} onClick={() => setTurningOff(null)}>Keep it</button>
                <button className={`${button} border-warning/50`} disabled={saving} onClick={() => void turnOff(engine.id)}>Turn it off</button>
              </div>}
            </InboxEngineSignInRow>
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
    {projectRows.length>0&&<Suspense fallback={<p>Loading project decisions</p>}><ProjectRows onOpen={onOpen} rows={projectRows} onSettled={()=>setRevision(value=>value+1)}/></Suspense>}
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
        {doorRows ? <>
          {chips.length > 1 && <div role="group" aria-label={t("ux.l2b.door.chipsLabel")} data-needs-chips className="mb-3 flex flex-wrap gap-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:py-0.5 max-md:[&>button]:shrink-0">
            <button type="button" className={viewTab(!picked)} aria-pressed={!picked} onClick={() => setBotFilter("")}>{t("ux.l2b.door.chipAll", { n: ordered.length })}</button>
            {chips.map(chip => <button key={chip.bot} type="button" className={viewTab(picked === chip.bot)} aria-pressed={picked === chip.bot} onClick={() => setBotFilter(chip.bot)}>{t("ux.l2b.door.chip", { bot: chip.bot, n: chip.count })}</button>)}
          </div>}
          <p className="sr-only">{t("ux.l2b.door.keys")}</p>
          <div onKeyDownCapture={onDoorKeyCapture} onKeyDown={onDoorKey}>
            {groups.map(group => <div key={group.bot || "all"} className="mt-3 first:mt-0">
              {group.bot && <h3 className={`${sectionHeading} mb-2`}>{t("ux.l2b.door.group", { bot: group.bot, n: group.rows.length })}</h3>}
              <ul className="space-y-2" aria-label={group.bot ? t("ux.l2b.door.group", { bot: group.bot, n: group.rows.length }) : t("ux.l2a.door.needsYou")}>
                {group.rows.map(item => {
                  const card = cards[item.link.messageId];
                  const bot = botOf(item);
                  const since = waitingSinceTime(item.at, Date.now());
                  const botRecord = item.botId ? store?.state.bots.find(entry => entry.id === item.botId) : undefined;
                  // APPROVALS-SIMPLE-1018: the bot's words on the line, Murage's kind on the grey line, no command here
                  const approval = item.kind === "request" && (item.toolKind !== undefined || Boolean(card?.tool));
                  return <NeedsRow
                    key={item.id}
                    id={item.id}
                    line={rowLine(card, bot, requestSummary) || item.title}
                    meta={approval ? rowMeta({ kind: rowKind(item, card), ...(bot ? { bot } : {}), time: since, ...(item.bulk ? { bulk: item.bulk } : {}), note: bulkNote })
                      : bot ? t("ux.l2b.door.meta", { bot, time: since }) : t("ux.l2b.door.metaNoBot", { time: since })}
                    details={item.kind === "request"}
                    avatar={botRecord ? <BotAvatar bot={botRecord} size={32} /> : undefined}
                    open={shownOpen === item.id}
                    cameBack={cameBack(item, Date.now())}
                    onToggle={() => openRow(shownOpen === item.id ? null : item.id)}
                    headRef={(element) => { if (element) heads.current.set(item.id, element); else heads.current.delete(item.id); }}
                    actions={card ? <InboxQuickAnswer threadId={item.link.threadId} card={card} botName={bot} labelledBy={`needs-row-line-${item.id}`} onSettled={() => settledInline(item)} /> : undefined}
                  >{cardBody(item)}</NeedsRow>;
                })}
              </ul>
            </div>)}
          </div>
        </> : <ul className="space-y-2" aria-label="Inbox items">
          {list.map(item => <li key={item.id} className={`rounded-xl border bg-inset p-4 ${item.read ? "border-hairline/50" : "border-hairline"}`} data-inbox-id={item.id}>{cardBody(item)}</li>)}
        </ul>}
      </InboxSection>
    )}
    </div>
    {/* Only when there is somewhere to go. "Page 1 of 1" between two
        disabled buttons was a footer for nothing. */}
    {result && result.total > result.pageSize && <footer className="mt-4 flex items-center justify-between gap-3 border-t border-hairline/40 pt-4">
      <button className={button} disabled={page === 0} onClick={() => setPage(current => current - 1)}>Previous</button>
      <span className="text-[12px] text-ink-secondary">Page {page + 1} of {Math.ceil(result.total / result.pageSize)}</span>
      <button className={button} disabled={(page + 1) * result.pageSize >= result.total} onClick={() => { const next = result.next; setCursors(current => { const kept = [...current]; kept[page + 1] = next; return kept; }); setPage(current => current + 1); }}>Next</button>
    </footer>}
    </BoxBody>
  </section>;
}
