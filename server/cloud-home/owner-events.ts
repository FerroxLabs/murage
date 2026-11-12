// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Owner events (DESIGN section 7): when an owner's BROWSER changes something that outlives it, the home tells the control plane,
// which mails the owner. A row goes in the home database first (so a restart or an outage loses nothing), then a best-effort sender
// posts `owner-event {seq, kind}` with backoff. The kind is a fixed word; nothing else leaves the home. The control plane dedupes on seq.
import type { DatabaseSync } from "node:sqlite";
import type { IncomingMessage } from "node:http";
import { cloudIdentity, isOwnerBrowser } from "../cloud-request-identity.ts";
import type { CpResult } from "./cp-client.ts";

export const OWNER_EVENT_KINDS = ["flux_key_changed", "provider_key_changed", "channel_paired", "script_access_added", "webhook_added", "engine_signed_out", "browser_made_owner", "code_used"] as const;
export type OwnerEventKind = typeof OWNER_EVENT_KINDS[number];

export interface OwnerEventsDeps {
  db: DatabaseSync;
  call: (op: string, fields?: Record<string, unknown>) => Promise<CpResult>;
  now?: () => number;
  /** Retry cadence for unsent rows; default 60 s. */
  everyMs?: number;
  /** Rows tried per pass; default 3. */
  perPass?: number;
}
export interface OwnerEvents {
  record(kind: OwnerEventKind): void;
  /** One pass over the oldest unsent rows that are due. Resolves when the pass is done. */
  flush(): Promise<void>;
  start(): void;
  stop(): void;
}
const MAX_TRIES = 20;

export function createOwnerEvents(deps: OwnerEventsDeps): OwnerEvents {
  const { db } = deps;
  const now = () => deps.now?.() ?? Date.now();
  db.exec("CREATE TABLE IF NOT EXISTS home_owner_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0)");
  const dueAt = new Map<number, number>();
  let running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined;
  const backoff = (tries: number) => Math.min(10 * 60_000, 5_000 * 2 ** Math.min(tries, 10));
  const pass = async (): Promise<void> => {
    let rows: { seq: number; kind: string; tries: number }[] = [];
    try { rows = db.prepare("SELECT seq, kind, tries FROM home_owner_events WHERE sent=0 AND tries<? ORDER BY seq LIMIT 20").all(MAX_TRIES) as typeof rows; } catch { return; }
    let sent = 0;
    for (const row of rows) {
      if (sent >= (deps.perPass ?? 3)) break;
      if ((dueAt.get(row.seq) ?? 0) > now()) continue;
      sent++;
      let ok = false;
      try { ok = (await deps.call("owner-event", { seq: row.seq, kind: row.kind })).ok; } catch { ok = false; }
      try {
        if (ok) { db.prepare("UPDATE home_owner_events SET sent=1 WHERE seq=?").run(row.seq); dueAt.delete(row.seq); }
        else { db.prepare("UPDATE home_owner_events SET tries=tries+1 WHERE seq=?").run(row.seq); dueAt.set(row.seq, now() + backoff(row.tries + 1)); }
      } catch { /* the row stays; the next pass tries again */ }
    }
    try { db.prepare("DELETE FROM home_owner_events WHERE sent=1 AND at<?").run(now() - 7 * 86_400_000); } catch { /* tidying only */ }
  };
  const flush = (): Promise<void> => (running ??= pass().finally(() => { running = undefined; }));
  return {
    record(kind) {
      if (!(OWNER_EVENT_KINDS as readonly string[]).includes(kind)) return;
      try { db.prepare("INSERT INTO home_owner_events (kind, at) VALUES (?, ?)").run(kind, now()); } catch { return; }
      setImmediate(() => { void flush().catch(() => {}); });
    },
    flush,
    start() {
      if (timer) return;
      timer = setInterval(() => { void flush().catch(() => {}); }, deps.everyMs ?? 60_000);
      timer.unref?.();
      setImmediate(() => { void flush().catch(() => {}); });
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
  };
}

let active: OwnerEvents | undefined;
/** The server sets this once at boot on a Cloud home; elsewhere it stays unset and every call below does nothing. */
export function setOwnerEvents(events: OwnerEvents | undefined): void { active = events; }
/** Records an owner event only when this request came from an OWNER BROWSER on a Cloud home. Desktop, phone and chat browsers: nothing. */
export function ownerEvent(req: IncomingMessage, kind: OwnerEventKind): void {
  try { if (active && isOwnerBrowser(cloudIdentity(req.headers))) active.record(kind); } catch { /* never blocks the action */ }
}
/** For the places that know they are an owner browser's doing (the door issuing a new owner factor). */
export function recordOwnerEvent(kind: OwnerEventKind): void { try { active?.record(kind); } catch { /* never blocks */ } }
