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
  /** threadId to questions waiting on the owner (Inbox `questionThreads`). */
  questions: Readonly<Record<string, number>>;
}

const EMPTY: ThreadAttention = { snoozes: new Map(), questions: {} };
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
      publish({ ...current, snoozes: new Map([...current.snoozes].filter(([, until]) => until > at)) });
    }, wait);
  }
  for (const listener of listeners) listener();
}

function sameQuestions(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export function setThreadSnoozes(snoozes: readonly ThreadSnooze[], now = Date.now()) {
  const next = new Map(snoozes.filter(entry => entry.until > now).map(entry => [entry.threadId, entry.until] as const));
  if (next.size === current.snoozes.size && [...next].every(([threadId, until]) => current.snoozes.get(threadId) === until)) return;
  publish({ ...current, snoozes: next });
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

/** Snooze until `until`, or wake now with `null`. Throws the server's own
 *  words (a conversation waiting on you cannot be snoozed). */
export async function changeThreadSnooze(api: Api, threadId: string, until: number | null) {
  const result = await api(`/api/thread-snoozes/${encodeURIComponent(threadId)}`, until === null
    ? { method: "DELETE" }
    : { method: "PUT", body: JSON.stringify({ until }) });
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
