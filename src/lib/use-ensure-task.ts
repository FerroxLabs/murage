// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { api, useStore, useStoreIfAny } from "@/state/store";
import type { GroupTask, Task } from "@/state/store";
import { findTask, isTruncated, type TaskHolder } from "@/lib/task-window";

const asked = new Set<string>();

/** Fetch a task the window left out, once, when something on screen names it.
 * The row lands in the store's extras, so every reader finds it from then on. */
export function useEnsureTask(owner: "bot" | "group", ownerId: string | undefined, threadId: string | undefined): void {
  const store = useStoreIfAny();
  const dispatch = store?.dispatch;
  const holder: TaskHolder<Task | GroupTask> | undefined = owner === "bot"
    ? store?.state.bots.find((bot) => bot.id === ownerId)
    : store?.state.groups.find((group) => group.id === ownerId);
  const missing = Boolean(dispatch && holder && threadId && ownerId && !findTask(holder, threadId) && isTruncated(holder));
  useEffect(() => {
    if (!missing || !dispatch || !ownerId || !threadId) return;
    const key = `${owner}:${ownerId}:${threadId}`;
    if (asked.has(key)) return;
    asked.add(key);
    void api(`/api/${owner === "bot" ? "bots" : "groups"}/${encodeURIComponent(ownerId)}/tasks/${encodeURIComponent(threadId)}`)
      .then((result: { task?: Task }) => {
        if (result.task) dispatch({ type: "tasksFetched", owner, id: ownerId, tasks: [result.task] });
      })
      // Not found: the task is gone. Asked again only after a reload.
      .catch(() => {});
  }, [missing, owner, ownerId, threadId, dispatch]);
}

/** One page of the tasks past the window: `before` is where the window ends, or the last page's `next`. */
export async function fetchOlderTasks(
  request: (path: string) => Promise<{ tasks?: Task[]; next?: string | null }>,
  owner: "bot" | "group",
  ownerId: string,
  before: string,
): Promise<{ tasks: Task[]; next: string | null }> {
  const result = await request(`/api/${owner === "bot" ? "bots" : "groups"}/${encodeURIComponent(ownerId)}/tasks?before=${encodeURIComponent(before)}&limit=${OLDER_PAGE}`);
  return { tasks: result.tasks ?? [], next: result.next ?? null };
}

const OLDER_PAGE = 50;

export interface OlderTasks {
  /** Some tasks past the window have not been loaded. */
  hasMore: boolean;
  loading: boolean;
  failed: boolean;
  /** Load the next page of older tasks into the store's extras. */
  loadMore: () => void;
}

/** Page back through the tasks the window leaves out, newest first, until the
 * oldest. The rows land in the store's extras, where every reader finds them. */
export function useOlderTasks(owner: "bot" | "group", ownerId: string | undefined): OlderTasks {
  const { state, dispatch } = useStore();
  const holder = owner === "bot" ? state.bots.find((bot) => bot.id === ownerId) : state.groups.find((group) => group.id === ownerId);
  // undefined: not started, so the window's own cursor; null: the oldest was reached.
  const [cursor, setCursor] = useState<{ id?: string; next: string | null | undefined }>({ next: undefined });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const current = cursor.id === ownerId ? cursor.next : undefined;
  const next = current === undefined ? holder?.tasksOlder ?? null : current;
  const loadMore = useCallback(() => {
    if (!ownerId || next === null || loading) return;
    setLoading(true);
    setFailed(false);
    void fetchOlderTasks(api, owner, ownerId, next)
      .then((page) => {
        dispatch({ type: "tasksFetched", owner, id: ownerId, tasks: page.tasks });
        setCursor({ id: ownerId, next: page.next });
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, [owner, ownerId, next, loading, dispatch]);
  return { hasMore: next !== null, loading, failed, loadMore };
}
