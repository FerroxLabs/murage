// What the task switcher shows, and in what order. Pure: "now", the time
// zone and the locale are injected, so date grouping can be tested on any
// machine and across midnight, daylight saving and a year change.
import type { TaskUsage } from "@/state/store";
import { cachedInput, formatTaskTokens, formatUsd } from "@/lib/usage";

/** The fields the list reads. Bot tasks carry all of them; channel tasks
 * only the first few. */
export interface TaskListTask {
  threadId: string;
  title: string;
  createdAt: number;
  /** last message time, from the server; absent = no messages yet */
  lastActivityAt?: number;
  pinned?: boolean;
  unread?: boolean;
  busy?: boolean;
  usage?: TaskUsage;
}

/** Which routine a task is a run of, from the routine run receipts. */
export interface RoutineRef {
  routineId: string;
  routineName: string;
}

export type TaskSort = "activity" | "created";
export type TaskFilter = "all" | "chats" | "routines" | "bots" | "unread";
export type TaskKind = "chat" | "routine" | "bot";

export const TASK_SORTS: ReadonlyArray<{ id: TaskSort; label: string }> = [
  { id: "activity", label: "Last activity" },
  { id: "created", label: "Created" },
];

export const TASK_FILTERS: ReadonlyArray<{ id: TaskFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "routines", label: "Routines" },
  { id: "bots", label: "From other bots" },
  { id: "unread", label: "Unread" },
];

export const UNTITLED_TASK_TITLE = "New task";

interface Clock {
  /** IANA zone; undefined = this device's zone */
  timeZone?: string;
  /** BCP 47 tag; undefined = this device's language */
  locale?: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? "", options]);
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

interface CalendarDay {
  year: number;
  month: number;
  day: number;
  /** days since the epoch for this calendar date — differences are whole
   * calendar days whatever the clock did in between */
  index: number;
}

function calendarDay(at: number, timeZone: string | undefined): CalendarDay {
  const parts = formatter("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  return { year, month, day, index: Math.round(Date.UTC(year, month - 1, day) / 86_400_000) };
}

export interface DateBucket {
  key: string;
  label: string;
}

/** Today, Yesterday, the six days before that, the rest of this month, then
 * one bucket per month. Compared as calendar days in `timeZone`. */
export function dateBucket(at: number, now: number, clock: Clock = {}): DateBucket {
  const today = calendarDay(now, clock.timeZone);
  const then = calendarDay(at, clock.timeZone);
  const daysAgo = today.index - then.index;
  if (daysAgo <= 0) return { key: "today", label: "Today" };
  if (daysAgo === 1) return { key: "yesterday", label: "Yesterday" };
  if (daysAgo <= 7) return { key: "week", label: "Previous 7 days" };
  if (then.year === today.year && then.month === today.month) return { key: "month", label: "Earlier this month" };
  const label = formatter(clock.locale, { timeZone: clock.timeZone, month: "long", year: "numeric" }).format(at);
  return { key: `m-${then.year}-${String(then.month).padStart(2, "0")}`, label };
}

/** A row's time: the clock time today and yesterday (the group header says
 * which), a short date after that, with the year once it is not this one. */
export function formatTaskWhen(at: number, now: number, clock: Clock = {}): string {
  const { key } = dateBucket(at, now, clock);
  if (key === "today" || key === "yesterday") {
    return formatter(clock.locale, { timeZone: clock.timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  }
  const sameYear = calendarDay(at, clock.timeZone).year === calendarDay(now, clock.timeZone).year;
  return formatter(clock.locale, {
    timeZone: clock.timeZone,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(at);
}

/** A list row's time with no date header above it (the sidebar): the clock
 * time today, "Yesterday", the weekday within the last week, then a short
 * date, with the year once it is not this one. */
export function formatListTime(at: number, now: number, clock: Clock = {}): string {
  const { key } = dateBucket(at, now, clock);
  if (key === "today") return formatter(clock.locale, { timeZone: clock.timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  if (key === "yesterday") return "Yesterday";
  if (key === "week") {
    const day = formatter(clock.locale, { timeZone: clock.timeZone, weekday: "short" });
    // A week ago today would read as today's weekday: give it a date instead.
    if (day.format(at) !== day.format(now)) return day.format(at);
  }
  return formatTaskWhen(at, now, clock);
}

/** The full date and time, for a hover title. */
export function formatTaskMoment(at: number, clock: Clock = {}): string {
  return formatter(clock.locale, { timeZone: clock.timeZone, dateStyle: "medium", timeStyle: "short" }).format(at);
}

/** Last activity falls back to creation: a task nobody has written in yet
 * was last touched when it was made. */
export function taskActivityAt(task: Pick<TaskListTask, "createdAt" | "lastActivityAt">): number {
  return Math.max(task.createdAt, task.lastActivityAt ?? 0);
}

export function taskSortTime(task: TaskListTask, sort: TaskSort): number {
  return sort === "created" ? task.createdAt : taskActivityAt(task);
}

/** Newest first by the chosen time. Stable, so equal times keep the order
 * the server sent (newest created first). */
export function sortTasks<T extends TaskListTask>(tasks: readonly T[], sort: TaskSort): T[] {
  return tasks
    .map((task, index) => ({ task, index, at: taskSortTime(task, sort) }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ task }) => task);
}

export interface DateGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Pinned first, then date groups in time order. Items keep the caller's
 * order inside each group, so pass them already sorted. */
export function groupTasksByDate<T extends TaskListTask>(
  tasks: readonly T[],
  options: Clock & { now: number; sort: TaskSort },
): DateGroup<T>[] {
  const groups: DateGroup<T>[] = [];
  const pinned = tasks.filter((task) => task.pinned);
  if (pinned.length) groups.push({ key: "pinned", label: "Pinned", items: pinned });
  for (const task of tasks) {
    if (task.pinned) continue;
    const bucket = dateBucket(taskSortTime(task, options.sort), options.now, options);
    const last = groups[groups.length - 1];
    if (last?.key === bucket.key) last.items.push(task);
    else groups.push({ ...bucket, items: [task] });
  }
  return groups;
}

export interface ReadableTitle {
  text: string;
  /** the bot that started this task, when another bot did */
  from?: string;
  via?: "message" | "delegation";
}

// "[Message from @Kessler] text" (current), or the long preamble older
// builds cut to 48 characters: "[Message from @Kessler (Ops), another b…"
const PEER_TITLE = /^\[(Message from|Delegated by) @([^,\]\n…]+?)\s*(?:\]\s*(.*)|,.*)?$/s;

/** A task another bot started reads as "From Kessler: text". The raw title
 * stays the task's name everywhere else, and in search. */
export function readableTaskTitle(title: string): ReadableTitle {
  const match = PEER_TITLE.exec(title.trim());
  if (!match) return { text: title };
  const from = match[2]!.trim();
  const rest = match[3]?.trim();
  return {
    text: rest ? `From ${from}: ${rest}` : `From ${from}`,
    from,
    via: match[1] === "Delegated by" ? "delegation" : "message",
  };
}

export function taskKind(task: Pick<TaskListTask, "title">, routine?: RoutineRef): TaskKind {
  if (routine) return "routine";
  if (readableTaskTitle(task.title).from) return "bot";
  return "chat";
}

/** An untitled task nobody has written in is clutter, not work — unless it
 * is the one on screen, or something is happening in it. Data is untouched;
 * the row is just not listed. */
export function isHiddenEmptyTask(task: TaskListTask, activeId: string): boolean {
  return (
    task.threadId !== activeId &&
    task.title === UNTITLED_TASK_TITLE &&
    task.lastActivityAt === undefined &&
    !task.busy &&
    !task.unread &&
    !(task.usage && task.usage.turns > 0)
  );
}

function matchesFilter(filter: TaskFilter, kind: TaskKind, task: TaskListTask): boolean {
  switch (filter) {
    case "all":
      return true;
    case "chats":
      return kind === "chat";
    case "routines":
      return kind === "routine";
    case "bots":
      return kind === "bot";
    case "unread":
      return Boolean(task.unread);
  }
}

/** "674k tokens", and the split behind it for a hover title. */
export function formatTaskTokenLabel(
  usage: TaskUsage | undefined,
  locale?: string,
): { label: string; detail: string } | null {
  if (!usage) return null;
  const total = usage.input + usage.output;
  const short = formatTaskTokens(total);
  if (!short) return null;
  const label = /tokens?$/.test(short) ? short : `${short} tokens`;
  const n = (value: number) => value.toLocaleString(locale);
  const cached = cachedInput(usage);
  const parts = [
    `${n(total)} ${total === 1 ? "token" : "tokens"}`,
    `${n(usage.input)} in${cached ? ` (${n(cached)} cached)` : ""}`,
    `${n(usage.output)} out`,
  ];
  if (usage.turns > 0) parts.push(`${usage.turns} ${usage.turns === 1 ? "turn" : "turns"}`);
  const cost = formatUsd(usage.costUsd ?? Number.NaN);
  if (cost) parts.push(cost);
  return { label, detail: parts.join(" · ") };
}

/** Title search: prefix hits first, then substring hits, keeping the
 * caller's order in each tier. Matches the stored title and the readable
 * one, so "[Message from" and "From Kessler" both find a handoff. */
export function searchTasks<T extends { title: string }>(tasks: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...tasks];
  const prefix: T[] = [];
  const substring: T[] = [];
  for (const task of tasks) {
    const titles = [task.title.toLowerCase(), readableTaskTitle(task.title).text.toLowerCase()];
    if (titles.some((title) => title.startsWith(needle))) prefix.push(task);
    else if (titles.some((title) => title.includes(needle))) substring.push(task);
  }
  return [...prefix, ...substring];
}

export type TaskListEntry<T> =
  | { type: "task"; task: T; kind: TaskKind }
  | {
      type: "fold";
      /** the routine id */
      id: string;
      name: string;
      /** newest first by the current sort */
      runs: T[];
      latest: T;
      expanded: boolean;
    };

export interface TaskListSection<T> {
  key: string;
  label: string;
  entries: TaskListEntry<T>[];
}

export interface TaskListView<T> {
  sections: TaskListSection<T>[];
  /** tasks in on-screen order: a closed fold stands for its newest run */
  navigable: T[];
}

export interface TaskListOptions extends Clock {
  query: string;
  filter: TaskFilter;
  sort: TaskSort;
  now: number;
  activeId: string;
  routineOf: (threadId: string) => RoutineRef | undefined;
  /** routine ids whose fold is open */
  expanded: ReadonlySet<string>;
}

/** The whole list as sections of rows. Searching looks at every listed task
 * (whatever the filter) and shows the hits flat, ranked; otherwise the
 * filter applies, routine runs fold into one row per routine, and rows sit
 * under Pinned and date headers. */
export function buildTaskListView<T extends TaskListTask>(tasks: readonly T[], options: TaskListOptions): TaskListView<T> {
  const listed = sortTasks(
    tasks.filter((task) => !isHiddenEmptyTask(task, options.activeId)),
    options.sort,
  );
  const kindOf = (task: T) => taskKind(task, options.routineOf(task.threadId));

  if (options.query.trim()) {
    const pinnedFirst = [...listed.filter((task) => task.pinned), ...listed.filter((task) => !task.pinned)];
    const hits = searchTasks(pinnedFirst, options.query);
    return {
      sections: hits.length
        ? [{ key: "results", label: "Matches", entries: hits.map((task) => ({ type: "task" as const, task, kind: kindOf(task) })) }]
        : [],
      navigable: hits,
    };
  }

  const shown = listed.filter((task) => matchesFilter(options.filter, kindOf(task), task));
  const runsByRoutine = new Map<string, T[]>();
  for (const task of shown) {
    if (task.pinned) continue;
    const routine = options.routineOf(task.threadId);
    if (!routine) continue;
    const runs = runsByRoutine.get(routine.routineId) ?? [];
    runs.push(task);
    runsByRoutine.set(routine.routineId, runs);
  }

  const sections: TaskListSection<T>[] = [];
  const navigable: T[] = [];
  const place = (key: string, label: string, entry: TaskListEntry<T>) => {
    const last = sections[sections.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else sections.push({ key, label, entries: [entry] });
  };
  for (const group of groupTasksByDate(shown, options)) {
    for (const task of group.items) {
      const routine = task.pinned ? undefined : options.routineOf(task.threadId);
      const runs = routine ? runsByRoutine.get(routine.routineId) : undefined;
      if (!routine || !runs || runs.length < 2) {
        place(group.key, group.label, { type: "task", task, kind: kindOf(task) });
        navigable.push(task);
        continue;
      }
      // the fold sits where its newest run would; later runs are inside it
      if (runs[0] !== task) continue;
      const expanded = options.expanded.has(routine.routineId);
      place(group.key, group.label, {
        type: "fold",
        id: routine.routineId,
        name: options.routineOf(runs[0]!.threadId)?.routineName || task.title,
        runs,
        latest: task,
        expanded,
      });
      navigable.push(...(expanded ? runs : [task]));
    }
  }
  return { sections, navigable };
}
