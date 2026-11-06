// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AskRecord } from "./HelpAsk";
import type { AppState, Bot } from "@/state/store";

// Provider identity fences a replacement store; profile changes also discard the view.
// Browser re-pairing is a new page load; session revocation separately clears this lifetime.
export interface AskScope { owner: unknown; account?: string; botId?: string; threadId?: string; signedOut?: boolean }

export function reopened(record: AskRecord | null): AskRecord | null {
  if (!record) return null;
  const { stop, cancel, ...rest } = record;
  return { ...rest, ...(stop && stop !== "stopping" ? { stop } : {}), ...(cancel && cancel !== "removing" ? { cancel } : {}) };
}

export function attempts() {
  let current = 0;
  return {
    retire() { current++; },
    begin() {
      const mine = ++current;
      return { live: () => current === mine, retire: () => { if (current === mine) current++; } };
    },
  };
}

/** Lazy, memory-only lifetime. Delivery belongs to the Ask; requests belong to one opening. */
export function createAskLifetime() {
  let record: AskRecord | null = null;
  let gen = 0;
  let scope: AskScope | undefined;
  let following = { gen: -1, until: 0 };
  const openings = new Set<() => void>();
  let show: ((r: AskRecord | null) => void) | undefined;
  const keep = (r: AskRecord | null) => { record = r; show?.(r); };
  const clear = () => { gen++; for (const close of openings) close(); keep(null); following = { gen: -1, until: 0 }; };
  return {
    get record() { return record; },
    get generation() { return gen; },
    clear,
    authorize(next: AskScope) {
      if ((next.signedOut && !scope?.signedOut) || (scope && (scope.owner !== next.owner || scope.account !== next.account || scope.botId !== next.botId || scope.threadId !== next.threadId))) clear();
      scope = next;
    },
    next() { return ++gen; },
    keep,
    submit(input: Omit<AskRecord, "gen">, deliver: (r: AskRecord) => void) {
      if (scope?.signedOut) return undefined;
      const next = { ...input, gen: ++gen };
      keep(next); deliver(next);
      return next;
    },
    patch(g: number, change: Partial<AskRecord>, when?: (r: AskRecord) => boolean) {
      if (record && record.gen === g && gen === g && !scope?.signedOut && (!when || when(record))) keep({ ...record, ...change });
    },
    deadline(g: number, ms: number) {
      if (following.gen !== g) following = { gen: g, until: Date.now() + ms };
      return following.until;
    },
    open(listener?: (r: AskRecord | null) => void) {
      const controller = new AbortController();
      const removes = attempts();
      record = reopened(record);
      show = listener; show?.(record);
      const close = () => { controller.abort(); removes.retire(); openings.delete(close); if (show === listener) show = undefined; };
      openings.add(close);
      return { signal: controller.signal, close, begin: () => {
        const attempt = removes.begin();
        return { ...attempt, live: () => !controller.signal.aborted && attempt.live() };
      } };
    },
  };
}

/** Current shared delivery wins over the cached callback of an earlier attempt of the same send. */
export function reconcileDelivery(record: AskRecord, bot: Bot | undefined, pending: AppState["pendingQueued"][string] = []): AskRecord {
  if (!bot || bot.id !== record.botId || bot.threadId !== record.threadId) return record;
  const current = [...pending].reverse().find((p) => p.sendId === record.sendId);
  if (current) return { ...record, phase: current.refused ? "refused" : current.sending ? "sending" : "accepted", queueId: current.queueId };
  if (!bot.messagesUnloaded && !bot.firstPageEvents && bot.messages.some((m) => m.role === "user" && m.sendId === record.sendId)) return { ...record, phase: "accepted" };
  return record;
}

export async function settleStop(pending: Promise<Partial<AskRecord>>, signal: AbortSignal, apply: (p: Partial<AskRecord>) => void, nudge: () => void) {
  const change = await pending;
  if (!signal.aborted) { apply(change); nudge(); }
}
