import { t } from "@/lib/i18n";
import { threadLinkLabel } from "../../shared/thread-link";
import { unreadTaskLabel } from "@/lib/project-presentation";
// Separate task contexts for an agent or a channel.
//
// One endless thread per bot means every job contaminates the next, and
// the only clean slate is a second bot. A task is a real boundary — its
// own transcript and its own provider session — so sensitive work, a
// long job and a quick question can sit side by side under one agent.
import { allHeldTasks, taskCount } from "@/lib/task-window";
import { useOlderTasks } from "@/lib/use-ensure-task";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BellOff, Check, ChevronDown, ChevronRight, Clock, Download, Link2Off, Loader2, Maximize2, Pencil, Pin, Plus, Search, Trash2 } from "lucide-react";
import { api, useStore, type Bot, type Group, type Task } from "@/state/store";
import { deletionConsequenceLines } from "@/lib/deletion-notes";
import { useDeletionCounts } from "./ConfirmDelete";
import type { RoutineRun } from "@/lib/routines";
import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE_LAST } from "@/lib/compact-chip";
import { nextRename } from "@/lib/rename";
import { downloadConversation } from "@/lib/conversation-export";
import {
  TASK_FILTERS,
  TASK_SORTS,
  buildTaskListView,
  formatTaskMoment,
  formatTaskTokenLabel,
  formatRelativeTaskWhen,
  readableTaskTitle,
  searchTasks,
  taskSortTime,
  type RoutineRef,
  type TaskFilter,
  type TaskKind,
  type TaskListEntry,
  type TaskListSection,
  type TaskListView,
  type TaskSort,
} from "@/lib/task-list";
import { sidebarMarkLabel, taskWaitsOnYou } from "@/lib/sidebar-attention";
import { formatSnoozedUntil, threadIsQuiet } from "@/lib/thread-snooze";
import { changeThreadSnooze, useThreadAttention } from "@/lib/thread-attention";
import { useRelativeNow } from "@/lib/relative-now";
import { useDesktopSurface } from "@/lib/use-surface";
import { QuestionBadge, SnoozeChoices } from "./ConversationSnooze";
import { startConversationPrefetch } from "@/lib/conversation-cache-host";
import { MESSAGE_PAGE_SIZE } from "@/lib/scrollback";
import { modShortcut } from "@/lib/mod-shortcut";
import { chatTitle } from "@/lib/all-chats";

/** Click-to-switch used to close this menu immediately, which unmounted the
 * row before a double-click (or right-click) could start a rename. Linger
 * just long enough for the second click to land; rename cancels the close. */
export const TASK_PICKER_DISMISS_MS = 500;

export const TASK_RENAME_HINT = "Click to switch · double-click or right-click to rename";

/** The chat list's width (CHATS-FINDABILITY-DESIGN 2.1): a two-line row fits an ordinary title; the anchor maths reads the same number. */
export const CHAT_LIST_WIDTH = 440;

/** About two rows of the list (~46 px each): the least the list keeps before the whole pop-up scrolls instead. */
export const CHAT_LIST_MIN_ROWS_PX = 92;
/** The pop-up's fixed chrome above and below the list (heading, search and sort, filters, Export and its hint, New chat,
 * New chat in a folder), measured at 248 px; the live pop-up measures its own, this is the fallback before it can. */
export const CHAT_LIST_CHROME_PX = 248;

/** The space the pop-up has below the chip, in px, so its bottom stays on screen: a phone's two-row header puts the chip
 * low, and a phone keyboard (which the auto-focused search box raises) leaves even less. `tight` is true when that space
 * is under the chrome plus two rows (about 340 px): the list then keeps its two rows and the whole pop-up scrolls inside
 * the space instead, so every row and every footer button stays reachable above the keyboard. */
export function chatListMaxHeight(
  triggerBottom: number | undefined,
  viewportHeight: number,
  chrome: number = CHAT_LIST_CHROME_PX,
): { maxHeight: number; tight: boolean } | undefined {
  if (triggerBottom === undefined || !Number.isFinite(triggerBottom) || !Number.isFinite(viewportHeight)) return undefined;
  // mt-1 (4 px) above the menu, 8 px clear of the bottom edge; never shorter than two rows' worth.
  const maxHeight = Math.max(CHAT_LIST_MIN_ROWS_PX, Math.floor(viewportHeight - triggerBottom - 4 - 8));
  return { maxHeight, tight: maxHeight < chrome + CHAT_LIST_MIN_ROWS_PX };
}

/** The owner's conversations are "chats" here; a routine run and work from other bots stay "tasks" (design open question 1). */
export function chatNoun(kind: TaskKind): "chat" | "task" {
  return kind === "chat" ? "chat" : "task";
}

/** Mod+J (this list) and Mod+Shift+N (a new chat here), as the chat list reads a key press. */
export function chatListShortcut(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "key" | "code">): "toggle" | "new" | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (!event.shiftKey && (key === "j" || event.code === "KeyJ")) return "toggle";
  if (event.shiftKey && (key === "n" || event.code === "KeyN")) return "new";
  return null;
}

/** Decide what a pointer event on a task row should do. The click that
 * accompanies a dblclick (detail >= 2) must not switch/close — that is
 * what used to eat the advertised rename. */
export function taskPickerPointerIntent(
  type: string,
  detail = 1,
): "select" | "rename" | "ignore" {
  if (type === "dblclick" || type === "contextmenu") return "rename";
  if (type === "click" && detail >= 2) return "ignore";
  if (type === "click") return "select";
  return "ignore";
}

/** Filter the task switcher. Prefix matches float first so a few letters
 * still find the right row in a long list; within a tier the caller's
 * order (newest first) is preserved. Matches the stored title and the
 * readable one ("From Kessler: …"). */
export function filterTasks<T extends { title: string }>(tasks: readonly T[], query: string): T[] {
  return searchTasks(tasks, query);
}

/** Pinned tasks first; inside each group the caller's order (newest first)
 * is kept, so unpinning puts a task straight back in its recency slot. */
export function orderPickerTasks<T extends { pinned?: boolean }>(tasks: readonly T[]): T[] {
  return [...tasks.filter((task) => task.pinned), ...tasks.filter((task) => !task.pinned)];
}

const TASK_SORT_KEY = "murage-task-sort";

/** The sort is a per-viewer convenience; storage can be missing or blocked
 * (private window, preview), and the list works the same without it. */
function readTaskSort(): TaskSort {
  try {
    return localStorage.getItem(TASK_SORT_KEY) === "created" ? "created" : "activity";
  } catch {
    return "activity";
  }
}

function writeTaskSort(sort: TaskSort) {
  try {
    localStorage.setItem(TASK_SORT_KEY, sort);
  } catch {
    // remembered next time storage is available; this session keeps it
  }
}

/** Which task threads are routine runs, keyed by thread, from the run
 * receipts the client already holds (newest first, so the newest run's
 * routine name wins). */
export function routineRunIndex<R extends Pick<RoutineRun, "threadId" | "routineId" | "routineName">>(
  runs: readonly R[],
  belongs: (run: R) => boolean,
  thread: (run: R) => string | undefined = (run) => run.threadId,
): Map<string, RoutineRef> {
  const index = new Map<string, RoutineRef>();
  for (const run of runs) {
    const threadId = thread(run);
    if (!threadId || index.has(threadId) || !belongs(run)) continue;
    index.set(threadId, { routineId: run.routineId, routineName: run.routineName });
  }
  return index;
}

const NO_ROUTINES = () => undefined;

const KIND_BADGE: Record<TaskKind, string | null> = { chat: null, routine: "Routine", bot: null };

/** Exactly what a sidebar row says when it is the one waiting on you. */
const TASK_WAITING_LABEL = sidebarMarkLabel({ kind: "waiting", count: 1 });

/** Waiting outranks every other ordering in this list, because the waiting
 * task is the one the owner opened the list to find. The sidebar row already
 * says the bot is waiting; the task that is waiting used to sit wherever its
 * timestamp put it — below the fold, labelled "Working", sometimes inside a
 * collapsed routine fold — so the two controls contradicted each other.
 *
 * This only REORDERS what the view already decided to show: a task the filter
 * or the search dropped stays dropped, and nothing new appears. A waiting run
 * is lifted out of its routine fold so a closed fold cannot hide it. */
export function hoistWaitingTasks<T extends { threadId: string }>(
  view: TaskListView<T>,
  waiting: (task: T) => boolean,
): TaskListView<T> {
  const lifted: TaskListEntry<T>[] = [];
  const kept: TaskListSection<T>[] = [];
  for (const section of view.sections) {
    const entries: TaskListEntry<T>[] = [];
    for (const entry of section.entries) {
      if (entry.type === "task") {
        (waiting(entry.task) ? lifted : entries).push(entry);
        continue;
      }
      const rest: T[] = [];
      for (const run of entry.runs) {
        if (waiting(run)) lifted.push({ type: "task", task: run, kind: "routine" });
        else rest.push(run);
      }
      // A fold stands for two or more runs; one survivor is its own row,
      // which is the same rule the view itself applies.
      if (rest.length === entry.runs.length) entries.push(entry);
      else if (rest.length === 1) entries.push({ type: "task", task: rest[0]!, kind: "routine" });
      else if (rest.length > 1) entries.push({ ...entry, runs: rest, latest: rest[0]! });
    }
    if (entries.length) kept.push({ ...section, entries });
  }
  if (!lifted.length) return view;
  const sections: TaskListSection<T>[] = [
    { key: "waiting", label: sidebarMarkLabel({ kind: "waiting", count: lifted.length }), entries: lifted },
    ...kept,
  ];
  const navigable: T[] = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      if (entry.type === "task") navigable.push(entry.task);
      else navigable.push(...(entry.expanded ? entry.runs : [entry.latest]));
    }
  }
  return { sections, navigable };
}

type PickerTask = { unreadCount?: number } & Pick<Task, "threadId" | "title" | "createdAt" | "lastActivityAt" | "busy" | "unread" | "pinned" | "activity" | "link"> & {
  usage?: Task["usage"];
};

export function ConversationTaskPicker({
  threadId,
  tasks,
  busy,
  onNew,
  onNewInFolder,
  onSwitch,
  onRename,
  onDelete,
  onTogglePin,
  onRemoveLink,
  routineOf = NO_ROUTINES,
  initialOpen = false,
  now,
  timeZone,
  locale,
  snoozes,
  untilActivity,
  questions,
  canSnooze = false,
  deleteScope,
  onPrefetch,
  older,
  total,
  heading,
  onExpand,
  shortcuts = false,
}: {
  /** The list's title ("Chats with Ember"). */
  heading?: string;
  /** Open All chats filtered to this bot or channel. */
  onExpand?: () => void;
  /** Answer Mod+J and Mod+Shift+N: the one list of the conversation on screen. */
  shortcuts?: boolean;
  /** Every task there is, when the list holds only a window of them. */
  total?: number;
  threadId: string;
  tasks: PickerTask[];
  /** Tasks past the ones held: shows the "Show older chats" row. */
  older?: { hasMore: boolean; loading: boolean; failed: boolean; onLoadMore: () => void };
  busy: boolean;
  onNew: () => void;
  /** Start a task in a folder the person picks. Desktop bots only; absent elsewhere. */
  onNewInFolder?: () => void;
  onSwitch: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
  /** Bots only for now; a channel's task switcher has no pin. */
  onTogglePin?: (threadId: string, pinned: boolean) => void;
  /** Take the link off a conversation; absent where links are not offered. */
  onRemoveLink?: (threadId: string) => void;
  /** which routine a task thread is a run of, if any */
  routineOf?: (threadId: string) => RoutineRef | undefined;
  /** Render with the menu open (static-markup tests). */
  initialOpen?: boolean;
  /** Clock overrides for tests; the device's clock, zone and language otherwise. */
  now?: number;
  timeZone?: string;
  locale?: string;
  /** Snoozed conversations: threadId to when each wakes. */
  snoozes?: ReadonlyMap<string, number>;
  /** The snoozed ones that wake at their next new activity. */
  untilActivity?: ReadonlySet<string>;
  /** Questions waiting on the owner, by threadId (Inbox questionThreads). */
  questions?: Readonly<Record<string, number>>;
  /** Snooze is a desktop action; elsewhere the marker shows and nothing more. */
  canSnooze?: boolean;
  /** Whose conversations these are, for the Delete confirmation's saved-file count. */
  deleteScope?: { botId?: string; groupId?: string };
  /** Start fetching a task's first page (pointer or focus resting on its
   * row); returns the cancel, run when the pointer or focus moves on. */
  onPrefetch?: (threadId: string) => () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  // Unsnooze runs from a row, and rows are not components, so its pending and failure live here.
  const [unsnoozing, setUnsnoozing] = useState<string | null>(null);
  const [unsnoozeFailed, setUnsnoozeFailed] = useState<string | null>(null);
  const unsnooze = (threadId: string) => {
    if (unsnoozing) return;
    setUnsnoozing(threadId); setUnsnoozeFailed(null);
    changeThreadSnooze(api, threadId, null).then(() => setUnsnoozing(null), () => { setUnsnoozing(null); setUnsnoozeFailed(threadId); });
  };
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const [sort, setSort] = useState<TaskSort>(readTaskSort);
  // The fold holding the open task starts expanded, so the check mark is
  // on screen; the user can close it.
  const openFoldFor = (id: string) => routineOf(id)?.routineId;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(initialOpen ? [openFoldFor(threadId)].filter((x): x is string => Boolean(x)) : []));
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const [renaming, setRenaming] = useState<string | null>(null);
  // One prefetch at a time: resting on a row starts it, leaving cancels it.
  const prefetching = useRef<(() => void) | null>(null);
  const stopPrefetch = () => {
    prefetching.current?.();
    prefetching.current = null;
  };
  const startPrefetch = (target: string) => {
    stopPrefetch();
    if (onPrefetch && target !== threadId) prefetching.current = onPrefetch(target);
  };
  useEffect(() => stopPrefetch, []);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ error: boolean; text: string } | null>(null);
  const [menuOffset, setMenuOffset] = useState(0);
  const [menuMaxHeight, setMenuMaxHeight] = useState<number | undefined>(undefined);
  const [menuTight, setMenuTight] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const exportPending = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishingRename = useRef(false);

  const current = tasks.find((t) => t.threadId === threadId);

  const clearDismiss = () => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  };

  const closeMenu = () => {
    clearDismiss();
    setRenaming(null);
    setQuery("");
    setOpen(false);
    trigger.current?.focus();
  };

  const openMenu = () => {
    const right = ref.current?.getBoundingClientRect().right ?? CHAT_LIST_WIDTH;
    const width = Math.min(CHAT_LIST_WIDTH, window.innerWidth - 16);
    setMenuOffset(Math.max(8, Math.min(right - width, window.innerWidth - width - 8)) - (right - width));
    const fold = openFoldFor(threadId);
    if (fold) setExpanded((before) => (before.has(fold) ? before : new Set([...before, fold])));
    setOpen(true);
  };

  // The height cap follows the screen while the list is open: a rotation, a resize, a header relayout or a phone's
  // on-screen keyboard (which shrinks only the visual viewport) re-measures the space below the chip.
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const view = window.visualViewport;
      const bottom = view ? view.offsetTop + view.height : window.innerHeight;
      // the chrome is everything in the pop-up but the list (plus its 1 px borders), measured live
      const box = menu.current, rows = list.current;
      const chrome = box && rows ? box.scrollHeight - rows.offsetHeight + 2 : CHAT_LIST_CHROME_PX;
      const next = chatListMaxHeight(ref.current?.getBoundingClientRect().bottom, bottom, chrome);
      setMenuMaxHeight(next?.maxHeight);
      setMenuTight(next?.tight ?? false);
    };
    // one measure per frame: the keyboard animation and pinch-zoom fire scroll and resize many times a frame
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    measure();
    const view = window.visualViewport;
    window.addEventListener("resize", schedule);
    view?.addEventListener("resize", schedule);
    view?.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      view?.removeEventListener("resize", schedule);
      view?.removeEventListener("scroll", schedule);
    };
  }, [open]);

  // Mod+J opens or closes this list (focus lands in its search box); Mod+Shift+N starts a new chat here. Checked against every
  // app shortcut (App.tsx, CommandPalette, keyboard-shortcuts.ts): Mod+N stays "new bot", Mod+K the palette.
  const shortcutState = useRef({ open, busy, onNew, openMenu, closeMenu });
  shortcutState.current = { open, busy, onNew, openMenu, closeMenu };
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (event: KeyboardEvent) => {
      const action = chatListShortcut(event);
      if (!action || event.defaultPrevented || event.isComposing || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const current = shortcutState.current;
      event.preventDefault();
      if (action === "toggle") {
        if (current.open) current.closeMenu();
        else current.openMenu();
      } else if (!current.busy) {
        current.onNew();
        if (current.open) current.closeMenu();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts]);

  const queueDismiss = () => {
    clearDismiss();
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null;
      setRenaming(null);
      setOpen(false);
    }, TASK_PICKER_DISMISS_MS);
  };

  const startRename = (task: PickerTask) => {
    clearDismiss();
    finishingRename.current = false;
    setDraft(task.title);
    setRenaming(task.threadId);
  };

  useEffect(() => () => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
  }, []);

  useEffect(() => {
    if (!open) {
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setQuery("");
      return;
    }
    const onDown = (e: MouseEvent) => {
      // SAFETY: a mousedown target inside a document is always a DOM Node
      if (!ref.current?.contains(e.target as Node)) {
        if (dismissTimer.current) {
          clearTimeout(dismissTimer.current);
          dismissTimer.current = null;
        }
        setRenaming(null);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (renaming) return;
      if (dismissTimer.current) {
        clearTimeout(dismissTimer.current);
        dismissTimer.current = null;
      }
      setRenaming(null);
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, renaming]);

  const exportCurrent = async () => {
    if (exportPending.current) return;
    clearDismiss();
    exportPending.current = true; setExporting(true); setExportResult(null);
    try {
      const filename = await downloadConversation(threadId, current?.title ?? "Conversation");
      setExportResult({ error: false, text: `Download started: ${filename}` });
    } catch (error) {
      setExportResult({ error: true, text: error instanceof Error ? error.message : "Could not export this conversation. Try again." });
    } finally { exportPending.current = false; setExporting(false); }
  };

  const commitRename = (threadId: string, save: boolean) => {
    // Escape unmounts the input, which fires blur. Without this guard the
    // blur would save the draft the user just cancelled.
    if (finishingRename.current) return;
    finishingRename.current = true;
    const currentTitle = tasks.find((task) => task.threadId === threadId)?.title ?? "";
    const title = save ? nextRename(currentTitle, draft) : null;
    setRenaming(null);
    if (title) onRename(threadId, title);
  };

  // the picker button stays as-is — a token count next to a truncated title
  // and count would crowd it; the open task's tally rides the hover title
  const currentTokens = formatTaskTokenLabel(current?.usage ? { ...current.usage, costUsd: null } : undefined, locale);
  const switchTitle = currentTokens ? `Switch chat · ${currentTokens.detail}` : `Switch chat${shortcuts ? ` (${modShortcut("J")})` : ""}`;
  const looking = query.trim();
  const clock = { timeZone, locale };
  // One shared 30-second clock keeps "5 min ago" honest (lib/relative-now).
  const relativeNow = useRelativeNow();
  const nowAt = now ?? relativeNow;
  // A snoozed conversation's unread is held back here exactly as in the
  // sidebar: no Unread label, not under the Unread filter, not counted in a
  // routine fold. A question or an approval in it ends that at once.
  const quiet = (task: PickerTask) =>
    threadIsQuiet(task.threadId, { snoozes: snoozes ?? new Map(), questions: questions ?? {}, now: nowAt, waiting: taskWaitsOnYou(task) });
  const listed = useMemo(
    () => tasks.map((task) => (task.unread && quiet(task) ? { ...task, unread: false, unreadCount: 0 } : task)),
    [tasks, snoozes, questions, nowAt],
  );
  const view = useMemo(
    () => hoistWaitingTasks(
      buildTaskListView(listed, { query, filter, sort, now: nowAt, activeId: threadId, routineOf, expanded, timeZone, locale }),
      taskWaitsOnYou,
    ),
    [listed, query, filter, sort, nowAt, threadId, routineOf, expanded, timeZone, locale],
  );

  const chooseSort = (next: TaskSort) => {
    setSort(next);
    writeTaskSort(next);
  };

  const toggleFold = (id: string, open?: boolean) => {
    clearDismiss();
    setExpanded((before) => {
      const next = new Set(before);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** Arrow keys walk every row, across group headers and into open folds;
   * Home/End jump; Up from the first row returns to search. */
  const navigate = (e: ReactKeyboardEvent<HTMLElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-task-nav]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const focus = (index: number) => {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, index))]?.focus();
    };
    if (e.key === "ArrowDown") focus(at + 1);
    else if (e.key === "ArrowUp") {
      if (at <= 0) {
        e.preventDefault();
        search.current?.focus();
      } else focus(at - 1);
    } else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(items.length - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const target = document.activeElement as HTMLElement | null;
      const fold = target?.dataset.fold;
      if (fold) {
        e.preventDefault();
        toggleFold(fold, e.key === "ArrowRight");
        return;
      }
      const parent = target?.dataset.inFold;
      if (parent && e.key === "ArrowLeft") {
        e.preventDefault();
        list.current?.querySelector<HTMLElement>(`[data-fold="${CSS.escape(parent)}"]`)?.focus();
      }
    }
  };

  const renderTask = (task: PickerTask, kind: TaskKind, inFold?: string) => {
    const active = task.threadId === threadId;
    const readable = readableTaskTitle(task.title);
    const name = chatTitle(task.title, kind !== "chat");
    const at = taskSortTime(task, sort);
    const moment = [
      task.lastActivityAt !== undefined ? `Last message ${formatTaskMoment(task.lastActivityAt, clock)}` : null,
      `Created ${formatTaskMoment(task.createdAt, clock)}`,
    ].filter(Boolean).join(" · ");
    const badge = readable.via === "delegation" ? "Delegated" : readable.via === "message" ? "Message" : inFold ? null : KIND_BADGE[kind];
    // A waiting task is also busy, so without this the row that is blocked on
    // the owner reads "Working" — the exact contradiction that sent him
    // scrolling a transcript looking for the approval.
    const waiting = taskWaitsOnYou(task);
    const status = [
      task.busy && !waiting ? "Working" : null,
      unreadTaskLabel(task) || null,
    ].filter(Boolean).map((part) => ` · ${part}`).join("");
    const tokens = formatTaskTokenLabel(task.usage ? { ...task.usage, costUsd: null } : undefined, locale);
    const questionCount = questions?.[task.threadId] ?? 0;
    const snoozedUntil = quiet(task) ? snoozes?.get(task.threadId) : undefined;
    const waitsForNews = untilActivity?.has(task.threadId) === true;
    const snoozedText = snoozedUntil !== undefined ? formatSnoozedUntil(snoozedUntil, nowAt, clock, waitsForNews) : null;
    // Something owed in it: it cannot be snoozed, the server refuses too.
    const owed = waiting || questionCount > 0;
    return (
      <div key={task.threadId}>
      <div
        className={cn(
          "group flex items-center gap-2 py-2 pr-2.5",
          inFold ? "pl-6" : "pl-2.5",
          // Amber is spent on one meaning here too: this row is waiting on you.
          waiting ? "bg-warning/10 hover:bg-warning/15" : active ? "bg-raised/60" : "hover:bg-raised/40",
        )}
      >
        <Check size={13} className={cn("shrink-0", active ? "text-accent" : "opacity-0")} />
        {renaming === task.threadId ? (
          <input dir="auto"
            autoFocus
            value={draft}
            maxLength={80}
            aria-label={`Rename ${chatNoun(kind)}`}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={() => commitRename(task.threadId, true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                commitRename(task.threadId, true);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                commitRename(task.threadId, false);
              }
            }}
            className="min-w-0 flex-1 rounded bg-inset px-1.5 py-0.5 text-[13px] text-ink focus:outline-none"
          />
        ) : (
          <button
            type="button"
            data-task-nav=""
            data-in-fold={inFold}
            aria-current={active ? "true" : undefined}
            onPointerEnter={() => startPrefetch(task.threadId)}
            onPointerLeave={stopPrefetch}
            onFocus={() => startPrefetch(task.threadId)}
            onBlur={stopPrefetch}
            onClick={(e) => {
              if (taskPickerPointerIntent("click", e.detail) !== "select") return;
              if (!active) onSwitch(task.threadId);
              queueDismiss();
            }}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startRename(task);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startRename(task);
            }}
            className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            title={TASK_RENAME_HINT}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {/* decoration: the row's accessible name carries the words */}
              {waiting && <span data-task-mark="waiting" aria-hidden="true" className="size-2 shrink-0 rounded-full bg-warning" />}
              <div className="truncate text-[13px] text-ink">{name}</div>
              <QuestionBadge count={questionCount} />
            </div>
            <div className="flex min-w-0 items-center gap-1 text-[11px] text-ink-secondary">
              {badge && (
                <span className="shrink-0 rounded border border-hairline/60 px-1 text-[10px] leading-[14px]">{badge}</span>
              )}
              <span className="min-w-0 truncate">
                <time dateTime={new Date(at).toISOString()} title={moment}>{formatRelativeTaskWhen(at, nowAt, clock)}</time>
                {waiting && <span className="font-medium text-warning">{` · ${TASK_WAITING_LABEL}`}</span>}
                {status}
                {snoozedText && <span data-task-snoozed="" title={snoozedText}>{` · ${snoozedText}`}</span>}
                {tokens && <span title={tokens.detail}>{` · ${tokens.label}`}</span>}
              </span>
            </div>
          </button>
        )}
        {task.link && renaming !== task.threadId && (
          <a
            href={task.link}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            title={task.link}
            aria-label={t("task.openLink", { link: threadLinkLabel(task.link) ?? task.link })}
            className="shrink-0 rounded px-1 font-mono text-[11px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus [unicode-bidi:isolate]"
          >
            {threadLinkLabel(task.link) ?? t("task.link")}
          </a>
        )}
        {task.link && onRemoveLink && renaming !== task.threadId && (
          <button
            type="button"
            onClick={() => { clearDismiss(); onRemoveLink(task.threadId); }}
            aria-label={t("task.removeLink")}
            title={t("task.removeLink")}
            className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Link2Off size={13} />
          </button>
        )}
        {renaming !== task.threadId && (
          <button
            type="button"
            onClick={() => startRename(task)}
            aria-label={`Rename ${name}`}
            title={`Rename this ${chatNoun(kind)}`}
            className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Pencil size={13} />
          </button>
        )}
        {onTogglePin && renaming !== task.threadId && (
          <button
            type="button"
            onClick={() => {
              clearDismiss();
              onTogglePin(task.threadId, !task.pinned);
            }}
            aria-label={task.pinned ? `Unpin ${name}` : `Pin ${name}`}
            aria-pressed={Boolean(task.pinned)}
            title={task.pinned ? `Unpin this ${chatNoun(kind)}` : `Pin this ${chatNoun(kind)} to the top`}
            className={cn(
              "rounded p-1 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100",
              task.pinned ? "text-accent" : "text-ink-secondary opacity-0",
            )}
          >
            <Pin size={13} className={task.pinned ? "fill-current" : undefined} />
          </button>
        )}
        {canSnooze && renaming !== task.threadId && (snoozedUntil !== undefined ? (
          <button
            type="button"
            onClick={() => { clearDismiss(); unsnooze(task.threadId); }}
            disabled={unsnoozing !== null}
            aria-busy={unsnoozing === task.threadId}
            aria-label={unsnoozing === task.threadId ? `Unsnoozing ${name}` : `Unsnooze ${name}`}
            title={`${snoozedText}. Unsnooze`}
            className="rounded p-1 text-accent hover:bg-raised hover:text-ink focus-visible:opacity-100 disabled:opacity-50"
          >
            {unsnoozing === task.threadId ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <BellOff size={13} />}
          </button>
        ) : !owed && (
          <button
            type="button"
            onClick={() => { clearDismiss(); setSnoozing((before) => (before === task.threadId ? null : task.threadId)); }}
            aria-label={`Snooze ${name}`}
            aria-expanded={snoozing === task.threadId}
            title="Snooze this conversation"
            className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Clock size={13} />
          </button>
        ))}
        <button
          type="button"
          onClick={() => { clearDismiss(); setConfirmingDelete((before) => (before === task.threadId ? null : task.threadId)); }}
          disabled={Boolean(task.busy)||(busy && active)}
          aria-expanded={confirmingDelete === task.threadId}
          aria-label={`Delete ${chatNoun(kind)}`}
          title={`Delete this ${chatNoun(kind)} and its conversation`}
          className="rounded p-1 text-ink-secondary opacity-0 hover:bg-raised hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-20"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {confirmingDelete === task.threadId && (
        <ConfirmTaskDelete
          name={name}
          preview={{ ...deleteScope, threadId: task.threadId }}
          onCancel={() => setConfirmingDelete(null)}
          onConfirm={() => { setConfirmingDelete(null); onDelete(task.threadId); }}
        />
      )}
      {unsnoozeFailed === task.threadId && (
        <p role="alert" className="px-2 py-1 text-[12px] text-danger" data-testid="unsnooze-failed">
          Could not unsnooze this {chatNoun(kind)}. <button type="button" className="underline hover:no-underline" onClick={() => unsnooze(task.threadId)}>Try again</button>
        </p>
      )}
      {canSnooze && snoozing === task.threadId && (
        <div className="border-y border-hairline/40 bg-inset/40 px-1 py-1">
          <SnoozeChoices threadId={task.threadId} name={name} until={snoozedUntil} untilActivity={waitsForNews} blocked={owed} now={nowAt} clock={clock}
            onDone={() => setSnoozing(null)} />
        </div>
      )}
      </div>
    );
  };

  return (
    <div className="relative" ref={ref}>
      <button
        ref={trigger}
        type="button"
        aria-label="Chat list"
        onClick={() => {
          if (open) closeMenu();
          else openMenu();
        }}
        title={switchTitle}
        className={cn(
          // `w-full`: a button is shrink-to-fit, so on the chat header's
          // labelled second row it must follow its root down to the floor
          // the header sets, truncating the title, rather than run past it.
          "flex w-full max-w-[220px] items-center gap-1.5 rounded-full border border-hairline/40 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
          COMPACT_BUBBLE_LAST,
        )}
      >
        <span className="truncate chip-fold:hidden">{current ? chatTitle(current.title, Boolean(routineOf(current.threadId))) : "Chat"}</span>
        {/* folded: just the count in the bubble — the title rides the tooltip */}
        <span className="shrink-0 tabular-nums opacity-60 chip-fold:opacity-100">{total ?? tasks.length}</span>
        <ChevronDown size={12} className="shrink-0 chip-fold:hidden" />
      </button>

      {open && (
        <div ref={menu} data-chat-list-menu style={{ transform: `translateX(${menuOffset}px)`, maxHeight: menuMaxHeight }} className={cn("absolute right-0 top-full z-40 mt-1 flex w-[440px] max-w-[calc(100vw-16px)] flex-col rounded-xl", menuTight ? "overflow-y-auto overflow-x-hidden overscroll-contain" : "overflow-hidden", "border border-hairline/50 bg-card py-1 shadow-2xl shadow-black/50")}>
          {(heading || onExpand) && (
            <div className="flex shrink-0 items-center gap-2 px-3 pb-0.5 pt-1.5">
              <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                {heading ?? "Chats"}
                <span className="ml-1.5 font-normal tabular-nums text-ink-secondary">{total ?? tasks.length}</span>
              </div>
              {onExpand && (
                <button
                  type="button"
                  onClick={() => { closeMenu(); onExpand(); }}
                  aria-label="Expand to All chats"
                  title={`Expand: All chats, filtered here (${modShortcut("K", { shift: true })} for every chat)`}
                  className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <Maximize2 size={13} aria-hidden="true" /> Expand
                </button>
              )}
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2 px-2 pb-1.5 pt-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-accent/60">
              <Search size={13} className="shrink-0 text-ink-secondary" />
              <input dir="auto"
                ref={search}
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (looking) setQuery("");
                    else closeMenu();
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    list.current?.querySelector<HTMLElement>("[data-task-nav]")?.focus();
                    return;
                  }
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    const first = view.navigable[0];
                    if (!first) return;
                    if (first.threadId !== threadId) onSwitch(first.threadId);
                    closeMenu();
                  }
                }}
                placeholder="Search chats"
                aria-label="Search chats"
                className="w-full min-w-0 bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
              />
            </div>
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-ink-secondary">
              <span aria-hidden="true">Sort</span>
              <select
                aria-label="Sort chats"
                value={sort}
                onChange={(e) => chooseSort(e.target.value === "created" ? "created" : "activity")}
                onMouseDown={(e) => e.stopPropagation()}
                className="rounded bg-transparent py-0.5 text-[11px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              >
                {TASK_SORTS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="shrink-0 px-2 pb-1.5">
            <div role="group" aria-label="Filter chats" className="flex flex-wrap gap-1">
              {TASK_FILTERS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  aria-pressed={filter === chip.id && !looking}
                  title={looking ? "Search looks at the chats shown here; choosing a filter clears it" : undefined}
                  onClick={() => {
                    clearDismiss();
                    setFilter(chip.id);
                    setQuery("");
                  }}
                  className={cn(
                    "rounded-full border px-1.5 py-0.5 text-[11px] leading-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus",
                    filter === chip.id && !looking
                      ? "border-accent/60 bg-accent/15 text-ink"
                      : "border-hairline/50 text-ink-secondary hover:bg-raised hover:text-ink",
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
          <div
            ref={list}
            onKeyDown={navigate}
            className={cn("max-h-[min(60vh,640px)] overflow-y-auto overflow-x-hidden border-t border-hairline/40", menuTight ? "min-h-[92px] shrink-0" : "min-h-0")}
            role="group"
            aria-label={looking ? `${view.navigable.length} matching ${view.navigable.length === 1 ? "chat" : "chats"}` : "Chats"}
          >
            {view.sections.length === 0 ? (
              <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">
                {looking ? `Nothing matches “${looking}”` : filter === "all" ? "No chats yet" : "No chats in this view"}
              </div>
            ) : view.sections.map((section) => {
              const headerId = `${baseId}-${section.key}`;
              return (
                <div key={section.key} role="group" aria-labelledby={headerId}>
                  <div
                    id={headerId}
                    className="sticky top-0 z-10 bg-card px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-secondary"
                  >{section.label}</div>
                  {section.entries.map((entry) => {
                    if (entry.type === "task") return renderTask(entry.task, entry.kind);
                    const runsId = `${baseId}-runs-${entry.id}`;
                    const holdsActive = entry.runs.some((run) => run.threadId === threadId);
                    const working = entry.runs.some((run) => run.busy);
                    const unread = entry.runs.filter((run) => run.unread).length;
                    const at = taskSortTime(entry.latest, sort);
                    const summary = [
                      formatRelativeTaskWhen(at, nowAt, clock),
                      working ? "Working" : null,
                      unread === 1 ? "Unread" : unread > 1 ? `${unread} unread` : null,
                    ].filter(Boolean).join(" · ");
                    return (
                      <div key={`fold-${entry.id}`}>
                        <div className={cn("flex items-center gap-2 px-2.5 py-2", holdsActive && !entry.expanded ? "bg-raised/60" : "hover:bg-raised/40")}>
                          {holdsActive && !entry.expanded
                            ? <Check size={13} className="shrink-0 text-accent" />
                            : <ChevronRight size={13} aria-hidden="true" className={cn("shrink-0 text-ink-secondary transition-transform", entry.expanded && "rotate-90")} />}
                          <button
                            type="button"
                            data-task-nav=""
                            data-fold={entry.id}
                            aria-expanded={entry.expanded}
                            aria-controls={entry.expanded ? runsId : undefined}
                            onClick={() => toggleFold(entry.id)}
                            className="min-w-0 flex-1 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                            title={entry.expanded ? "Hide the runs" : "Show every run"}
                          >
                            <div className="truncate text-[13px] text-ink">{`${entry.name} · ${entry.runs.length} runs`}</div>
                            <div className="flex min-w-0 items-center gap-1 text-[11px] text-ink-secondary">
                              <span className="shrink-0 rounded border border-hairline/60 px-1 text-[10px] leading-[14px]">Routine</span>
                              <span className="min-w-0 truncate">
                                <time dateTime={new Date(at).toISOString()} title={`Latest run ${formatTaskMoment(at, clock)}`}>{summary}</time>
                              </span>
                            </div>
                          </button>
                        </div>
                        {entry.expanded && (
                          <div id={runsId} role="group" aria-label={`${entry.name} runs`}>
                            {entry.runs.map((run) => renderTask(run, "routine", entry.id))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {older?.hasMore && (
              <div className="border-t border-hairline/40 px-2 py-1.5">
                <button
                  type="button"
                  data-task-nav=""
                  data-show-older=""
                  disabled={older.loading}
                  onClick={() => { clearDismiss(); older.onLoadMore(); }}
                  className="w-full rounded px-2 py-1.5 text-left text-[13px] text-ink hover:bg-raised/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
                >
                  {older.loading ? "Loading older chats…" : "Show older chats"}
                </button>
                {older.failed && !older.loading && <p role="alert" className="px-2 pt-1 text-[12px] text-danger">Could not load older chats. Try again.</p>}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => void exportCurrent()}
            disabled={exporting}
            className="mt-1 flex w-full shrink-0 items-center gap-2 border-t border-hairline/40 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/50 disabled:opacity-40"
          >
            <Download size={13} className="shrink-0 text-ink-secondary" />
            {exporting ? "Exporting conversation…" : "Export conversation (Markdown)"}
          </button>
          <p className="shrink-0 px-3 pb-2 text-[11px] text-ink-secondary">Current conversation only. Not an importable bot package.</p>
          {exportResult && <p role={exportResult.error ? "alert" : "status"} className={cn("shrink-0 break-words px-3 pb-2 text-[12px]", exportResult.error ? "text-danger" : "text-ink-secondary")}>{exportResult.text}</p>}
          <button
            type="button"
            onClick={() => {
              onNew();
              closeMenu();
            }}
            disabled={busy}
            className="mt-1 flex w-full shrink-0 items-center gap-2 border-t border-hairline/40 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/50 disabled:opacity-40"
          >
            <Plus size={13} className="text-ink-secondary" /> New chat
            {shortcuts && <span aria-hidden="true" className="ml-auto text-[11px] text-ink-secondary">{modShortcut("N", { shift: true })}</span>}
          </button>
          {onNewInFolder && (
            <button
              type="button"
              onClick={() => {
                onNewInFolder();
                closeMenu();
              }}
              disabled={busy}
              className="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-raised/50 disabled:opacity-40"
            >
              <Plus size={13} className="text-ink-secondary" /> New chat in a folder...
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const LAST_TASK_FOLDER_KEY = "murage.newTaskFolder.";

/** Ask for a folder (starting at the one used last for this bot, else the
 * bot's own) and open a new task there. Cancelling the picker does nothing. */
async function newTaskInFolder(bot: Bot, dispatch: (action: { type: "newTask"; botId: string; cwd?: string }) => void): Promise<void> {
  let last: string | undefined;
  try { last = window.localStorage.getItem(LAST_TASK_FOLDER_KEY + bot.id) ?? undefined; } catch { /* storage may be blocked */ }
  const chosen = await window.muragebox?.pickFolder?.(last ?? bot.cwd ?? undefined);
  if (!chosen) return;
  try { window.localStorage.setItem(LAST_TASK_FOLDER_KEY + bot.id, chosen); } catch { /* a suggestion only */ }
  dispatch({ type: "newTask", botId: bot.id, cwd: chosen });
}

export function TaskPicker({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const older = useOlderTasks("bot", bot.id);
  // A detached run's own task; a channel-triggered run shares the channel's
  // conversation, which is not a routine task.
  const routines = useMemo(
    () => routineRunIndex(state.routineRuns, (run) => run.botId === bot.id && run.target !== "room-goal" && run.triggerSource !== "channel"),
    [state.routineRuns, bot.id],
  );
  const routineOf = useMemo(() => (threadId: string) => routines.get(threadId), [routines]);
  const attention = useThreadAttention();
  const desktop = useDesktopSurface() === true;
  return (
    <ConversationTaskPicker
      routineOf={routineOf}
      snoozes={attention.snoozes}
      untilActivity={attention.untilActivity}
      questions={attention.questions}
      canSnooze={desktop}
      threadId={bot.threadId}
      tasks={allHeldTasks(bot)}
      total={taskCount(bot)}
      older={{ hasMore: older.hasMore, loading: older.loading, failed: older.failed, onLoadMore: older.loadMore }}
      busy={false}
      onNew={() => dispatch({ type: "newTask", botId: bot.id })}
      onNewInFolder={desktop && window.muragebox?.pickFolder ? () => void newTaskInFolder(bot, dispatch) : undefined}
      onSwitch={(threadId) => dispatch({ type: "switchTask", botId: bot.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameTask", botId: bot.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteTask", botId: bot.id, threadId })}
      deleteScope={{ botId: bot.id }}
      onPrefetch={(threadId) => startConversationPrefetch(api, { ownerId: bot.id, threadId, pageSize: MESSAGE_PAGE_SIZE })}
      onTogglePin={(threadId, pinned) => dispatch({ type: "pinTask", botId: bot.id, threadId, pinned })}
      onRemoveLink={(threadId) => dispatch({ type: "updateTask", botId: bot.id, threadId, patch: { link: null } })}
      heading={`Chats with ${bot.name}`}
      onExpand={() => dispatch({ type: "showAllChats", botId: bot.id })}
      shortcuts
    />
  );
}

/** The same task affordance in a channel. DMs never render it because their
 * transcript is the private bot-to-bot exchange rather than user work. */
export function GroupTaskPicker({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const older = useOlderTasks("group", group.id);
  const routines = useMemo(
    () => routineRunIndex(
      state.routineRuns,
      (run) => run.target === "room-goal" && run.groupId === group.id,
      (run) => run.executionThreadId ?? run.threadId,
    ),
    [state.routineRuns, group.id],
  );
  const routineOf = useMemo(() => (threadId: string) => routines.get(threadId), [routines]);
  const attention = useThreadAttention();
  const desktop = useDesktopSurface() === true;
  return (
    <ConversationTaskPicker
      routineOf={routineOf}
      snoozes={attention.snoozes}
      untilActivity={attention.untilActivity}
      questions={attention.questions}
      canSnooze={desktop}
      threadId={group.threadId}
      tasks={allHeldTasks(group)}
      total={taskCount(group)}
      older={{ hasMore: older.hasMore, loading: older.loading, failed: older.failed, onLoadMore: older.loadMore }}
      busy={Boolean(group.working || group.busyBotId)}
      onNew={() => dispatch({ type: "newGroupTask", groupId: group.id })}
      onSwitch={(threadId) => dispatch({ type: "switchGroupTask", groupId: group.id, threadId })}
      onRename={(threadId, title) => dispatch({ type: "renameGroupTask", groupId: group.id, threadId, title })}
      onDelete={(threadId) => dispatch({ type: "deleteGroupTask", groupId: group.id, threadId })}
      deleteScope={{ groupId: group.id }}
      heading={`Chats in ${group.name}`}
      onExpand={() => dispatch({ type: "showAllChats", groupId: group.id })}
      shortcuts
    />
  );
}

/** The inline confirmation under a conversation row: what goes with it
 * (its messages and saved files, counted) and what stays (earlier backups),
 * then Delete or Cancel. */
export function ConfirmTaskDelete({ name, preview, onCancel, onConfirm, savedFiles: known, messages: knownMessages }: {
  name: string;
  preview: { botId?: string; groupId?: string; threadId?: string };
  onCancel: () => void;
  onConfirm: () => void;
  /** Tests pass the counts; the app asks the server. */
  savedFiles?: number;
  messages?: number;
}) {
  const fetched = useDeletionCounts(known === undefined ? preview : undefined);
  const savedFiles = known ?? fetched?.savedFiles ?? null;
  const messages = knownMessages ?? fetched?.messages ?? null;
  return (
    <div role="group" aria-label={`Delete ${name}?`} className="border-y border-hairline/40 bg-inset/40 px-2 py-2 text-[12.5px] text-ink">
      <p className="font-medium">Delete this conversation?</p>
      <p className="mt-0.5 text-ink-secondary">Its messages, files and history are removed from this computer.</p>
      {deletionConsequenceLines(savedFiles, messages, fetched?.engines).map((line) => <p key={line} className="mt-0.5 text-ink-secondary">{line}</p>)}
      <div className="mt-1.5 flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
        <button type="button" onClick={onConfirm} className="rounded bg-danger px-2 py-1 font-medium text-white">Delete</button>
      </div>
    </div>
  );
}
