// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which conversations are snoozed and which have questions waiting, shared
// by the sidebar and every conversation list. Fed by the sidebar's existing
// five second Inbox read (usePendingApprovals), so no second poller exists.
import { useSyncExternalStore } from "react";
import type { ThreadSnooze } from "../../shared/thread-snooze";

export interface ThreadAttention {
  /** threadId to the epoch ms it wakes. Only snoozes still ahead. */
  snoozes: ReadonlyMap<string, number>;
  /** The snoozed threads that wake at their next new activity; their time
   *  in `snoozes` is only the latest they can sleep. */
  untilActivity: ReadonlySet<string>;
  /** threadId to questions waiting on the owner (Inbox `questionThreads`). */
  questions: Readonly<Record<string, number>>;
}

const EMPTY: ThreadAttention = { snoozes: new Map(), untilActivity: new Set(), questions: {} };
let current: ThreadAttention = EMPTY;
const listeners = new Set<() => void>();
let expiry: ReturnType<typeof setTimeout> | null = null;

function publish(next: ThreadAttention) {
  current = next;
  if (expiry) { clearTimeout(expiry); expiry = null; }
  // A timed snooze ends on the clock, not on the next read: re-publish at
  // the soonest wake so its row comes back without waiting for the server.
  const soonest = Math.min(...current.snoozes.values());
  if (Number.isFinite(soonest)) {
    // Timers above 2^31-1 ms fire at once, so long waits are re-checked.
    const wait = Math.min(2_147_483_647, Math.max(0, soonest - Date.now() + 1));
    expiry = setTimeout(() => {
      const at = Date.now();
      // Always re-publish, even when nothing expired, so a long wait that was
      // cut short by the timer limit schedules the next check.
      const snoozes = new Map([...current.snoozes].filter(([, until]) => until > at));
      publish({ ...current, snoozes, untilActivity: new Set([...current.untilActivity].filter(threadId => snoozes.has(threadId))) });
    }, wait);
  }
  for (const listener of listeners) listener();
}

function sameQuestions(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export function setThreadSnoozes(snoozes: readonly ThreadSnooze[], now = Date.now()) {
  const ahead = snoozes.filter(entry => entry.until > now);
  const next = new Map(ahead.map(entry => [entry.threadId, entry.until] as const));
  const untilActivity = new Set(ahead.filter(entry => entry.untilActivity).map(entry => entry.threadId));
  if (next.size === current.snoozes.size && [...next].every(([threadId, until]) => current.snoozes.get(threadId) === until)
    && untilActivity.size === current.untilActivity.size && [...untilActivity].every(threadId => current.untilActivity.has(threadId))) return;
  publish({ ...current, snoozes: next, untilActivity });
}

export function setQuestionThreads(questions: Readonly<Record<string, number>> | undefined) {
  const next = questions ?? {};
  if (sameQuestions(next, current.questions)) return;
  publish({ ...current, questions: next });
}

export function useThreadAttention(): ThreadAttention {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
    () => EMPTY,
  );
}

type Api = (path: string, init?: RequestInit) => Promise<{ snoozes?: ThreadSnooze[] }>;

/** Snooze until `until`, until the next new activity with "activity", or
 *  wake now with `null`. Throws the server's own words (a conversation
 *  waiting on you cannot be snoozed). */
export async function changeThreadSnooze(api: Api, threadId: string, until: number | "activity" | null) {
  const result = await api(`/api/thread-snoozes/${encodeURIComponent(threadId)}`, until === null
    ? { method: "DELETE" }
    : { method: "PUT", body: JSON.stringify(until === "activity" ? { untilActivity: true } : { until }) });
  setThreadSnoozes(result.snoozes ?? []);
}

export async function refreshThreadSnoozes(api: Api, signal?: AbortSignal) {
  const result = await api("/api/thread-snoozes", { signal });
  setThreadSnoozes(result.snoozes ?? []);
}

/** Tests only. */
export function peekThreadAttention(): ThreadAttention { return current; }

/** Tests only. */
export function resetThreadAttention() { if (expiry) clearTimeout(expiry); expiry = null; current = EMPTY; }
