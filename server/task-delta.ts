// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";

/** A bot whose last frame was a delta gets a whole-list frame within this,
 * on a timer, even if the bot never changes again. */
export const FULL_TASK_LIST_EVERY_MS = 30_000;

/** The `/api/events` query a client sends to say it lays `tasksDelta` over its
 * held task rows. A client that does not say so (a 1.0.1 desktop, any phone or
 * companion) gets the whole list on every frame, exactly as before. */
export const TASK_DELTA_QUERY = "tasks";
export const TASK_DELTA_VALUE = "delta";

/** The same negotiation for open request cards: a renderer that takes them
 * beside its page sends this header on every call and this query on its event
 * stream. A client that sends neither is answered with the page it always got. */
export const CARDS_BESIDE_HEADER = "x-murage-cards";
export const CARDS_BESIDE_QUERY = "cards";
export const CARDS_BESIDE_VALUE = "beside";

export interface TaskDeltaPatch<T> { upsert: T[]; count: number; base: number }

export interface TaskDeltaOptions {
  /** Names this run of the server: sequence numbers restart with it. */
  epoch?: string;
  now?: () => number;
  /** Called when a bot's whole list is due (FULL_TASK_LIST_EVERY_MS after a
   * delta). The server answers with a full frame for that bot. */
  repair?: (botId: string) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Bot frames that flip busy or unread used to carry every task the bot ever
 * had. This remembers the rows last sent per bot and numbers every frame
 * (`tasksSeq`). Each frame comes in two forms: `full`, with the whole list,
 * for every client that did not negotiate deltas and for the replay buffer;
 * and, while the task set and its order are unchanged, `delta`, which
 * replaces `tasks` with `tasksDelta`: the rows that changed, the task count,
 * and `base`, the number of the frame it builds on. A client whose held list
 * is not at `base`, or does not add up to `count`, refetches the list. The
 * first frame for a bot, any add, remove or reorder, and one frame in every
 * FULL_TASK_LIST_EVERY_MS are full for everyone; after a delta a timer sends
 * that full frame even when the bot goes idle. */
export function createTaskDelta(options: TaskDeltaOptions = {}) {
  const epoch = options.epoch ?? randomUUID().slice(0, 8);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => {
    const handle = setTimeout(run, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const sent = new Map<string, Map<string, string>>();
  const seqs = new Map<string, number>();
  const fullAt = new Map<string, number>();
  const timers = new Map<string, unknown>();
  const cancel = (botId: string) => {
    if (timers.has(botId)) clearTimer(timers.get(botId));
    timers.delete(botId);
  };
  return {
    /** The server run every number here belongs to (`tasksEpoch` on the wire). */
    epoch,
    /** The number of the last frame built for a bot (0 before any): a snapshot
     * carries it so a delta that follows can be checked against it. */
    seq(botId: string): number { return seqs.get(botId) ?? 0; },
    frame<W extends { tasks?: Array<{ threadId: string }> }>(botId: string, wired: W, forceFull = false) {
      const tasks = wired.tasks;
      if (!tasks) { this.forget(botId); return { full: wired }; }
      const seq = (seqs.get(botId) ?? 0) + 1;
      seqs.set(botId, seq);
      const full = { ...wired, tasksSeq: seq, tasksEpoch: epoch };
      const rows = new Map<string, string>(tasks.map((task) => [task.threadId, JSON.stringify(task)]));
      const before = sent.get(botId);
      sent.set(botId, rows);
      const at = now();
      const ids = [...rows.keys()], sentIds = before ? [...before.keys()] : [];
      const sameSet = before !== undefined && ids.length === sentIds.length && ids.every((id, index) => id === sentIds[index]);
      if (forceFull || !sameSet || at - (fullAt.get(botId) ?? 0) > FULL_TASK_LIST_EVERY_MS) {
        fullAt.set(botId, at);
        cancel(botId);
        return { full };
      }
      if (options.repair && !timers.has(botId)) {
        const due = Math.max(0, (fullAt.get(botId) ?? at) + FULL_TASK_LIST_EVERY_MS - at);
        timers.set(botId, setTimer(() => { timers.delete(botId); options.repair!(botId); }, due));
      }
      const upsert = tasks.filter((task) => before!.get(task.threadId) !== rows.get(task.threadId));
      const { tasks: _all, ...rest } = full;
      const tasksDelta: TaskDeltaPatch<(typeof tasks)[number]> = { upsert, count: tasks.length, base: seq - 1 };
      return { full, delta: { ...rest, tasksDelta } };
    },
    forget(botId: string) { sent.delete(botId); fullAt.delete(botId); cancel(botId); },
  };
}
