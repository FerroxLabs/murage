// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.3 and 2.5: after a fold row answered a card, the
// card says what was ADDED (the route's own `added` receipt, never what the
// client asked for) with Undo for 8 seconds, then "Take back". Undo removes
// exactly those keys from the holder that gained them: a bot save's keys
// through the bot's Undo route by holder (its defaults, this task; never the
// global remove-everywhere route Settings uses), a task allowance through
// task-allow/remove, a routine's through its remove route, and reports which
// ones remain when some removals fail. Memory only,
// per card: a reload keeps the grant and drops the line (F8), and the grant
// is then taken back under {bot} › Level.
import { useSyncExternalStore } from "react";
import { api } from "@/state/store";
import { UNDO_WINDOW_MS } from "@/lib/undo";

export type AddedScope = "bot" | "task" | "routine";

export interface GrantAdded {
  threadId: string;
  requestId: string;
  botId: string;
  /** where the keys were kept */
  scope: AddedScope;
  routineId?: string;
  /** exactly what the server added (Undo removes these and nothing else) */
  keys: string[];
  /** a bot save: which of `keys` the bot's defaults gained and which this
   * task gained (the save's `added` receipt), and the task's thread */
  holders?: { bot: string[]; task: string[]; taskThreadId?: string };
  /** the row's words, for the line */
  words: string;
  at: number;
  state: "added" | "undoing" | "taken" | "partial";
  /** after a partial Undo: the keys still kept */
  remaining?: string[];
}

const entries = new Map<string, GrantAdded>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export function noteGrantAdded(entry: Omit<GrantAdded, "at" | "state" | "remaining">, now = Date.now()): void {
  if (entries.size >= 100 && !entries.has(entry.requestId)) entries.delete(entries.keys().next().value!);
  const keys = entry.holders ? [...entry.holders.bot, ...entry.holders.task] : entry.keys;
  entries.set(entry.requestId, { ...entry, keys: [...new Set(keys)], at: now, state: "added" });
  emit();
}

export function grantAddedFor(requestId: string | undefined): GrantAdded | undefined {
  return requestId ? entries.get(requestId) : undefined;
}

export function useGrantAdded(requestId: string | undefined): GrantAdded | undefined {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => grantAddedFor(requestId),
    // memory only, so the server snapshot is the same read
    () => grantAddedFor(requestId),
  );
}

/** Undo is offered for 8 seconds after the grant; "Take back" after that. */
export function undoOpen(entry: Pick<GrantAdded, "at">, now = Date.now()): boolean {
  return now - entry.at < UNDO_WINDOW_MS;
}

type RemoveBody = Record<string, string | string[]>;
type Removal = { path: string; body: RemoveBody; keys: string[] };

/** The request that removes one added key (2.5): task keys through
 * task-allow/remove (this conversation's allowance only), routine keys
 * through the routine's remove route. */
export function removeRequest(entry: Pick<GrantAdded, "scope" | "botId" | "threadId" | "routineId">, key: string): { path: string; body: RemoveBody } {
  if (entry.scope === "task") return { path: `/api/bots/${encodeURIComponent(entry.botId)}/task-allow/remove`, body: { threadId: entry.threadId, key } };
  if (entry.scope === "routine") return { path: `/api/routines/${encodeURIComponent(entry.routineId ?? "")}/always-allow/remove`, body: { key } };
  return botUndoRequest(entry, { bot: [key], task: [] });
}

/** A bot save's Undo (desktop only): ONE request takes the keys back from
 * the holders that gained them, in one write on the server. */
export function botUndoRequest(entry: Pick<GrantAdded, "botId" | "threadId" | "holders">, keys: { bot: string[]; task: string[] }): { path: string; body: RemoveBody } {
  const threadId = entry.holders?.taskThreadId ?? entry.threadId;
  return { path: `/api/bots/${encodeURIComponent(entry.botId)}/always-allow/undo`, body: { ...(keys.task.length ? { threadId } : {}), bot: keys.bot, task: keys.task } };
}

function removals(entry: Pick<GrantAdded, "scope" | "botId" | "threadId" | "routineId" | "holders">, keys: readonly string[]): Removal[] {
  if (entry.scope !== "bot") return keys.map((key) => ({ ...removeRequest(entry, key), keys: [key] }));
  // a bot save: each key from the holder the receipt names (an older entry without holders: the bot's defaults)
  const holders = entry.holders ?? { bot: [...keys], task: [] };
  const split = { bot: holders.bot.filter((key) => keys.includes(key)), task: holders.task.filter((key) => keys.includes(key)) };
  if (!split.bot.length && !split.task.length) return [];
  return [{ ...botUndoRequest(entry, split), keys: [...new Set([...split.bot, ...split.task])] }];
}

/** Removes every key in `keys` from its own holder; returns the ones that remain. */
export async function removeKeys(
  entry: Pick<GrantAdded, "scope" | "botId" | "threadId" | "routineId" | "holders">,
  keys: readonly string[],
  call: (path: string, body: RemoveBody) => Promise<unknown> = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }),
): Promise<string[]> {
  const planned = removals(entry, keys);
  const results = await Promise.allSettled(planned.map((removal) => call(removal.path, removal.body)));
  return planned.filter((_, index) => results[index]!.status === "rejected").flatMap((removal) => removal.keys);
}

/** Undo or Take back: removes what is still kept, then says so. */
export async function takeBackAdded(requestId: string, call?: Parameters<typeof removeKeys>[2]): Promise<GrantAdded | undefined> {
  const entry = entries.get(requestId);
  if (!entry || entry.state === "undoing" || entry.state === "taken") return entry;
  const keys = entry.state === "partial" && entry.remaining ? entry.remaining : entry.keys;
  entries.set(requestId, { ...entry, state: "undoing" });
  emit();
  const remaining = await removeKeys(entry, keys, call);
  const next: GrantAdded = remaining.length ? { ...entry, state: "partial", remaining } : { ...entry, state: "taken", remaining: [] };
  entries.set(requestId, next);
  emit();
  return next;
}

/** For tests. */
export function resetGrantAdded(): void {
  entries.clear();
  emit();
}
