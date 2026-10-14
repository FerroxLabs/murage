// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A bot or channel frame carries a window of its tasks, not every one it ever
// had (server/task-window.ts): the open one, pinned, unread, busy, open
// routine runs, and the newest. `tasksTotal` says how many exist. Everything
// that used to look a task up in the full list, or add the list up, goes
// through here, so a task outside the window is found (or fetched) rather
// than taken for deleted.

/** The rows the interface holds for a bot or channel. */
export interface TaskHolder<T extends { threadId: string }> {
  tasks?: readonly T[];
  tasksTotal?: number;
  extraTasks?: readonly T[];
}

/** Every task there is, from the server's count when it sent one. */
export function taskCount(holder: Pick<TaskHolder<{ threadId: string }>, "tasks" | "tasksTotal">): number {
  return holder.tasksTotal ?? holder.tasks?.length ?? 0;
}

/** Some tasks are not in the window. */
export function isTruncated(holder: Pick<TaskHolder<{ threadId: string }>, "tasks" | "tasksTotal">): boolean {
  return (holder.tasksTotal ?? 0) > (holder.tasks?.length ?? 0);
}

/** A task from the window, or from the rows asked for since. */
export function findTask<T extends { threadId: string }>(holder: TaskHolder<T> | undefined, threadId: string | undefined): T | undefined {
  if (!holder || !threadId) return undefined;
  return holder.tasks?.find((task) => task.threadId === threadId) ?? holder.extraTasks?.find((task) => task.threadId === threadId);
}

/** The window plus the rows asked for, each task once (the window's row wins), newest first. */
export function allHeldTasks<T extends { threadId: string; createdAt: number }>(holder: TaskHolder<T> | undefined): T[] {
  const rows = new Map<string, T>();
  for (const task of holder?.extraTasks ?? []) rows.set(task.threadId, task);
  for (const task of holder?.tasks ?? []) rows.set(task.threadId, task);
  return [...rows.values()];
}

/** The thread may be one of this record's: held, or the window leaves some out
 * and it could be among them. A server that knows better answers 404. */
export function mayHoldTask(holder: TaskHolder<{ threadId: string }> | undefined, threadId: string): boolean {
  return Boolean(holder) && (findTask(holder, threadId) !== undefined || isTruncated(holder!));
}

/** The "Always allow" keys on the tasks, each once. */
export function taskGrantKeys(bot: { tasks?: Array<{ alwaysAllow?: string[] }>; grantsAll?: string[] }): string[] {
  return bot.grantsAll ?? [...new Set((bot.tasks ?? []).flatMap((task) => task.alwaysAllow ?? []))];
}

/** Rows outside the window to hold after a frame replaced the window. Rows that
 * left it (read, finished, aged out) are kept as they last were, so a task
 * that only left the window does not look deleted; when the count fell, one of
 * them may be the deleted one, so none are kept. The thread this client is
 * viewing is kept either way unless it was deleted. */
export function nextExtraTasks<T extends { threadId: string }>(
  held: TaskHolder<T> & { threadId?: string },
  next: TaskHolder<T>,
  options: { keepViewed?: boolean } = {},
): T[] | undefined {
  if (!Array.isArray(next.tasks)) return held.extraTasks as T[] | undefined;
  const inWindow = new Set(next.tasks.map((task) => task.threadId));
  const kept = new Map<string, T>();
  const shrunk = held.tasksTotal !== undefined && next.tasksTotal !== undefined && next.tasksTotal < held.tasksTotal;
  if (isTruncated(next)) {
    if (!shrunk) {
      for (const task of held.extraTasks ?? []) if (!inWindow.has(task.threadId)) kept.set(task.threadId, task);
      for (const task of held.tasks ?? []) if (!inWindow.has(task.threadId)) kept.set(task.threadId, task);
    }
    const viewed = options.keepViewed === false ? undefined : findTask(held, held.threadId);
    if (viewed && !inWindow.has(viewed.threadId)) kept.set(viewed.threadId, viewed);
  }
  return kept.size ? [...kept.values()] : undefined;
}

/** The same, as the fields to spread into a bot: nothing when there are no
 * extras before or after, so a bot that never needed them keeps its shape. */
export function extraTasksPatch<T extends { threadId: string }>(
  held: TaskHolder<T> & { threadId?: string },
  next: TaskHolder<T>,
  options: { keepViewed?: boolean } = {},
): { extraTasks?: T[] } {
  const extraTasks = nextExtraTasks(held, next, options);
  return extraTasks === undefined && held.extraTasks === undefined ? {} : { extraTasks };
}

/** The viewed thread has left the list for good: it is not in the frame, and
 * either the frame holds every task or the count fell. A thread that only
 * left the window (another window moved on) is not gone. */
export function viewedThreadGone(
  before: TaskHolder<{ threadId: string }> & { threadId: string },
  next: TaskHolder<{ threadId: string }>,
): boolean {
  if (!Array.isArray(next.tasks)) return true;
  if (next.tasks.some((task) => task.threadId === before.threadId)) return false;
  if (!isTruncated(next)) return true;
  return before.tasksTotal === undefined || (next.tasksTotal ?? 0) < before.tasksTotal;
}

/** Rows put into the extras (fetched by thread id, or an older page), the
 * newest fetch replacing an older row of the same task. */
export function withExtraTasks<T extends { threadId: string }>(held: T[] | undefined, fetched: readonly T[]): T[] {
  const rows = new Map<string, T>((held ?? []).map((task) => [task.threadId, task]));
  for (const task of fetched) rows.set(task.threadId, task);
  return [...rows.values()];
}
