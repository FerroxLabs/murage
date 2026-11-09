// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The two reads behind Today's Worth a look rows that the store does not hold (Today slice 1.0.18,
// designs/TODAY-SLICE-1104.md section 2): GET /api/connectors/needs-reconnect (memory only on the server, never a
// broker call) and GET /api/team-map?phase=busy (hand-offs whose teammate stayed busy). Read once on open, again on
// `inbox.changed` and on window focus, coalesced: one read of each in flight, and a change that lands mid-read gets
// exactly one more (serialRefresh). Aborted on unmount. No timers. A failed read keeps the last answer.
//
// Exported:
//   useWorthALook(enabled: boolean): WorthALook
//   worthALookReader(read, onAnswer): { refresh(): Promise<void>; abort(): void }   (pure, for the test)
//   parseReconnectApps(answer: unknown): ReconnectAppRow[]
//   parseBusyHandoffs(answer: unknown): BusyHandoffRow[]
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { onInboxChanged, serialRefresh } from "@/lib/inbox-changed";
import type { BusyHandoffRow, ReconnectAppRow } from "@/lib/today-needs";

export interface WorthALook {
  /** apps a tool call found refused (needs-reconnect `apps`) */
  reconnect: ReconnectAppRow[];
  /** team-map `queued`, busy phase only */
  handoffs: BusyHandoffRow[];
}

export const WORTH_A_LOOK_PATHS = { reconnect: "/api/connectors/needs-reconnect", handoffs: "/api/team-map?phase=busy" } as const;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function parseReconnectApps(answer: unknown): ReconnectAppRow[] {
  const apps = (answer as { apps?: unknown } | null)?.apps;
  if (!Array.isArray(apps)) return [];
  return apps.flatMap((app: unknown) => {
    const row = app as { slug?: unknown; label?: unknown } | null;
    if (!row || !text(row.slug)) return [];
    return [{ slug: row.slug, label: text(row.label) ? row.label : row.slug }];
  });
}

export function parseBusyHandoffs(answer: unknown): BusyHandoffRow[] {
  const queued = (answer as { queued?: unknown } | null)?.queued;
  if (!Array.isArray(queued)) return [];
  return queued.flatMap((item: unknown) => {
    const row = item as { sourceBotId?: unknown; targetBotId?: unknown; sourceThreadId?: unknown; reason?: unknown } | null;
    if (!row || !text(row.sourceBotId) || !text(row.targetBotId)) return [];
    return [{ sourceBotId: row.sourceBotId, targetBotId: row.targetBotId, ...(text(row.sourceThreadId) ? { sourceThreadId: row.sourceThreadId } : {}), ...(text(row.reason) ? { reason: row.reason } : {}) }];
  });
}

type Fetch = (path: string, init: { signal: AbortSignal }) => Promise<unknown>;

/** Both reads, coalesced and abortable. `onAnswer` gets each part as it answers; a failed or aborted read sends nothing. */
export function worthALookReader(read: Fetch, onAnswer: (part: Partial<WorthALook>) => void): { refresh: () => Promise<void>; abort: () => void } {
  const controller = new AbortController();
  const one = <K extends keyof WorthALook>(key: K, parse: (answer: unknown) => WorthALook[K]) => serialRefresh(async () => {
    if (controller.signal.aborted) return;
    try {
      const answer = await read(WORTH_A_LOOK_PATHS[key], { signal: controller.signal });
      if (!controller.signal.aborted) onAnswer({ [key]: parse(answer) } as Partial<WorthALook>);
    } catch { /* the last answer stays; the next change asks again */ }
  });
  const reconnect = one("reconnect", parseReconnectApps);
  const handoffs = one("handoffs", parseBusyHandoffs);
  return {
    refresh: async () => { await Promise.all([reconnect(), handoffs()]); },
    abort: () => controller.abort(),
  };
}

const EMPTY: WorthALook = { reconnect: [], handoffs: [] };

/** Today's needs-reconnect and busy hand-off rows. `enabled` false (first run, or no Needs you block) reads nothing. */
export function useWorthALook(enabled: boolean): WorthALook {
  const [data, setData] = useState<WorthALook>(EMPTY);
  useEffect(() => {
    if (!enabled) { setData(EMPTY); return; }
    const reader = worthALookReader((path, init) => api(path, init), (part) => setData((current) => ({ ...current, ...part })));
    void reader.refresh();
    const stopListening = onInboxChanged(() => { void reader.refresh(); });
    const onFocus = () => { void reader.refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { reader.abort(); stopListening(); window.removeEventListener("focus", onFocus); };
  }, [enabled]);
  return data;
}
