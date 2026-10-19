// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A bot or a channel used to carry every task it ever had on every roster
 * answer and every bot frame, so the cost of a frame grew with the number of
 * conversations. The wire now carries a window: the tasks the interface acts
 * on (pinned, unread, busy, waiting on you, the open one, open routine runs)
 * and the newest TASK_WINDOW. Everything older is one request away
 * (`GET /api/bots/:id/tasks?before=`), and `tasksTotal` says how many exist.
 * The window is chosen from the records in memory: no message is read. */
export const TASK_WINDOW = 50;
/** The roster (`GET /api/bots`) carries a smaller window than a bot frame: the sidebar shows the newest few, and the rest page in through the tasks route. */
export const ROSTER_TASK_WINDOW = 10;
/** The most one older-tasks page returns. */
export const TASK_PAGE_MAX = 200;
export const TASK_PAGE_DEFAULT = 50;

export interface WindowTask {
  threadId: string;
  createdAt: number;
  pinned?: boolean;
  unread?: boolean;
  busy?: boolean;
  activity?: string;
  unreadCount?: number;
}

/** True when the task is one the interface needs to hold whatever its age. */
export function mustKeepTask(task: WindowTask, currentThreadId: string, extra?: ReadonlySet<string>): boolean {
  return task.threadId === currentThreadId
    || task.pinned === true
    || task.unread === true
    || (task.unreadCount ?? 0) > 0
    || task.busy === true
    || (task.activity !== undefined && task.activity !== "idle")
    || extra?.has(task.threadId) === true;
}

/** Newest first; the thread id breaks a tie so a page boundary is stable. */
function newerFirst(a: WindowTask, b: WindowTask): number {
  return b.createdAt - a.createdAt || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);
}

export interface TaskWindow<T> {
  /** The window, in the order the record holds the tasks. */
  tasks: T[];
  /** Every task the record has. */
  total: number;
  /** Where the older tasks begin (`before=` for the first older page); null when the window holds every task. */
  older: string | null;
}

/** How many tasks a window keeps for being unread alone: the newest half a window of them. A bot whose
 * owner never reads its runs had 395 unread tasks of 428, and every one of them rode every roster answer
 * (392 KB of an 875 KB boot page; rc9 data test). The rest page in through the tasks route like any
 * older task, and `tasksTotal` still counts them. */
export function unreadKeep(size: number): number {
  return Math.max(1, Math.ceil(size / 2));
}

/** True when the task is one the interface needs to hold whatever its age, unread aside (see unreadKeep). */
function mustKeepTaskNow(task: WindowTask, currentThreadId: string, extra?: ReadonlySet<string>): boolean {
  return mustKeepTask({ ...task, unread: undefined, unreadCount: undefined }, currentThreadId, extra);
}

/** The window of a record's tasks. A record at or under the window size is
 * returned whole, so small installs see exactly what they always did. */
export function windowTasks<T extends WindowTask>(
  tasks: readonly T[],
  currentThreadId: string,
  extra?: ReadonlySet<string>,
  size = TASK_WINDOW,
): TaskWindow<T> {
  if (tasks.length <= size) return { tasks: [...tasks], total: tasks.length, older: null };
  const ranked = [...tasks].sort(newerFirst).slice(0, size);
  const newest = new Set(ranked.map((task) => task.threadId));
  const isUnread = (task: WindowTask) => task.unread === true || (task.unreadCount ?? 0) > 0;
  const unread = new Set(
    tasks.filter((task) => !newest.has(task.threadId) && isUnread(task) && !mustKeepTaskNow(task, currentThreadId, extra))
      .sort(newerFirst).slice(0, unreadKeep(size)).map((task) => task.threadId),
  );
  return {
    tasks: tasks.filter((task) => newest.has(task.threadId) || unread.has(task.threadId) || mustKeepTaskNow(task, currentThreadId, extra)),
    total: tasks.length,
    older: encodeTaskCursor(ranked[ranked.length - 1]!),
  };
}

/** A position in the newest-first order: the last task the client holds. */
export function encodeTaskCursor(task: Pick<WindowTask, "createdAt" | "threadId">): string {
  return `${task.createdAt}:${task.threadId}`;
}

export function decodeTaskCursor(cursor: string): { createdAt: number; threadId: string } | null {
  const at = cursor.indexOf(":");
  if (at < 1) return null;
  const createdAt = Number(cursor.slice(0, at));
  const threadId = cursor.slice(at + 1);
  return Number.isFinite(createdAt) && threadId ? { createdAt, threadId } : null;
}

export interface TaskPage<T> {
  tasks: T[];
  /** Ask with `before=` this for the next older page; null when this is the last. */
  next: string | null;
  total: number;
}

/** The tasks older than `before` (the newest when absent), newest first. */
export function pageTasks<T extends WindowTask>(tasks: readonly T[], before: string | null, limit: number): TaskPage<T> | null {
  const from = before === null ? null : decodeTaskCursor(before);
  if (before !== null && !from) return null;
  const size = Math.max(1, Math.min(TASK_PAGE_MAX, Math.trunc(limit) || TASK_PAGE_DEFAULT));
  const ordered = [...tasks].sort(newerFirst);
  const start = from ? ordered.findIndex((task) => newerFirst(task, { threadId: from.threadId, createdAt: from.createdAt }) > 0) : 0;
  const rest = start < 0 ? [] : ordered.slice(start);
  const page = rest.slice(0, size);
  return { tasks: page, next: rest.length > size ? encodeTaskCursor(page[page.length - 1]!) : null, total: tasks.length };
}

interface UsageLike { input: number; output: number; cachedInput?: number; costUsd: number | null; turns: number }

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** What every task of a record has spent: the same sum the header chip made
 * from the whole list (src/lib/usage.ts sumUsage), made here so the client
 * need not hold the list. */
export function sumTaskUsage(tasks: ReadonlyArray<{ usage?: UsageLike }>): UsageLike {
  const out: UsageLike = { input: 0, output: 0, costUsd: null, turns: 0 };
  let uncached = false;
  for (const { usage } of tasks) {
    if (!usage) continue;
    out.input += usage.input;
    out.output += usage.output;
    out.turns += usage.turns;
    if (finite(usage.cachedInput)) out.cachedInput = (out.cachedInput ?? 0) + usage.cachedInput;
    else if (usage.input > 0) uncached = true;
    if (finite(usage.costUsd)) out.costUsd = (out.costUsd ?? 0) + usage.costUsd;
  }
  // A record with input but no cache count leaves the whole split unknown.
  if (uncached) delete out.cachedInput;
  return out;
}

/** The "Always allow" keys the tasks hold, each once. */
export function taskGrants(tasks: ReadonlyArray<{ alwaysAllow?: string[] }>): string[] {
  const seen = new Set<string>();
  for (const task of tasks) for (const key of task.alwaysAllow ?? []) seen.add(key);
  return [...seen];
}

/** What a record's windowing costs, counted in tasks looked at: a test reads it to show an idle broadcast does none. */
export const taskWindowWork = { builds: 0, tasksVisited: 0 };

export interface TaskAggregates<T> {
  window: TaskWindow<T>;
  usage: UsageLike;
  grants: string[];
}

interface CachedAggregates { tasks: readonly WindowTask[]; length: number; key: string; value: TaskAggregates<never> }

/** Remembers each bot's window, usage total and grant list until something they were built from changes. `revision` is the
 * caller's counter, moved by any task, usage or grant write (Store.revision) and by any run write (the live run threads the window
 * keeps); with it unmoved, a broadcast does O(1) work however many tasks the bot holds. The entry also lapses when the task list
 * is replaced or changes length, whatever the counter says. */
export function createTaskAggregateCache(maxBots = 4096) {
  const entries = new Map<string, CachedAggregates>();
  return {
    get<T extends WindowTask & { usage?: UsageLike; alwaysAllow?: string[] }>(
      botId: string,
      tasks: readonly T[],
      currentThreadId: string,
      revision: string,
      size: number | undefined,
      extra: () => ReadonlySet<string> | undefined,
    ): TaskAggregates<T> {
      const key = `${revision}\0${currentThreadId}\0${size ?? ""}`;
      const held = entries.get(botId);
      if (held && held.tasks === tasks && held.length === tasks.length && held.key === key) {
        entries.delete(botId); entries.set(botId, held);
        return held.value as unknown as TaskAggregates<T>;
      }
      taskWindowWork.builds++;
      taskWindowWork.tasksVisited += tasks.length;
      const value: TaskAggregates<T> = {
        window: windowTasks(tasks, currentThreadId, extra(), size),
        usage: sumTaskUsage(tasks),
        grants: taskGrants(tasks),
      };
      entries.set(botId, { tasks, length: tasks.length, key, value: value as unknown as TaskAggregates<never> });
      if (entries.size > maxBots) entries.delete(entries.keys().next().value as string);
      return value;
    },
  };
}
