// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one Health card (1.0.9 Sentinel, GAP-SENTINEL-109 section 8.1), in the owner's Inbox and in Settings beside
// Diagnostics. It shows the open issue count, the highest-impact fixed sentence and when checks ran, the daily digest
// (heading, up to five grouped rows, one Recovered line, View Health), and the details on request.
//
// In the Inbox it renders what the owner's Inbox read carried (`health`), so nothing is fetched twice and nothing is
// shown to a surface that did not prove the owner (the server attaches it to owner reads only). In Settings it reads
// GET /api/sentinel/summary itself, which answers the owner only. When Sentinel's backup issue covers a stopped backup,
// the Inbox passes that notice in and it is shown here, with its own sentence and Open Backups, instead of as a second
// card. Every sentence comes from the fixed catalogue in shared/sentinel-view.ts.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import {
  HEALTH_COPY, ageLabel, durationLabel, healthStateLine, healthTitle, openCountLine, recoveredLine,
  type HealthDigest, type HealthInbox, type HealthSummaryResponse, type NextAction, type ViewRow,
} from "../../shared/sentinel-view";
import { HealthDetails } from "./HealthDetails";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

/** Where a next action opens: existing Settings pages only. */
export function healthDestination(action: NextAction): { section: "backups" | "storage" | "memory" | "about"; anchor?: string } | null {
  switch (action) {
    case "backups": return { section: "backups" };
    case "manage-storage": return { section: "storage" };
    case "memory-settings": return { section: "memory" };
    case "diagnostics": return { section: "about", anchor: "diagnostics-heading" };
    default: return null;
  }
}

/** The card's state from an Inbox `health` block or a summary response. */
export function cardModel(input: { status: HealthSummaryResponse["status"]; summary: HealthInbox["summary"]; rows: ViewRow[] }, now: number) {
  const state = healthStateLine(input.status, input.summary, now);
  const open = input.summary?.openCount ?? 0;
  return { ...state, open, openLine: open > 0 ? openCountLine(open) : null, rows: input.rows.filter(row => row.state !== "resolved").slice(0, 5) };
}

export function HealthDigestView({ digest, now, onView }: { digest: HealthDigest; now: number; onView?: () => void }) {
  return <section aria-labelledby={`health-digest-${digest.id}`} className="mt-3 rounded-lg border border-hairline/50 bg-inset p-3">
    <h3 id={`health-digest-${digest.id}`} className="text-[13px] font-medium text-ink">{HEALTH_COPY.digestHeading}</h3>
    {digest.rows.length > 0 && <ul className="mt-2 space-y-1 text-[13px] text-ink-secondary">
      {digest.rows.map(row => <li key={row.titleKey}>
        <span className="text-ink">{healthTitle(row.titleKey)}</span>
        {`: seen ${row.count} ${row.count === 1 ? "time" : "times"} over ${durationLabel(row.lastSeenAt - row.firstSeenAt)}${row.issues > 1 ? `, ${row.issues} issues` : ""}`}
      </li>)}
    </ul>}
    {digest.moreCount > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{`${digest.moreCount} more in Health`}</p>}
    {digest.recoveredCount > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{recoveredLine(digest.recoveredCount)}</p>}
    <p className="mt-1 text-[12px] text-ink-secondary">{`Made ${ageLabel(digest.createdAt, now)}`}</p>
    {onView && <div className="mt-2"><button type="button" className={button} onClick={onView}>{HEALTH_COPY.viewHealth}</button></div>}
  </section>;
}

export interface HealthCardProps {
  /** From the owner's Inbox read; when absent the card reads /api/sentinel/summary itself. */
  health?: HealthInbox | null;
  /** A stopped backup that Sentinel's backup issue covers (Inbox only). */
  backupNotice?: { sentence: string } | null;
  onOpenBackups?: () => void;
  onNavigate?: (action: NextAction) => void;
  /** Start with the details open (tests, deep links). */
  initiallyOpen?: boolean;
  /** The clock the ages are read against (tests). */
  now?: number;
}

export function HealthCard({ health, backupNotice, onOpenBackups, onNavigate, initiallyOpen = false, now: fixedNow }: HealthCardProps) {
  const [summary, setSummary] = useState<HealthSummaryResponse | null>(null);
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (health !== undefined) return;
    const controller = new AbortController();
    void api("/api/sentinel/summary", { signal: controller.signal })
      .then((value: HealthSummaryResponse) => { if (!controller.signal.aborted) setSummary(value); })
      .catch(() => { if (!controller.signal.aborted) setSummary({ status: "unavailable", view: null }); });
    return () => controller.abort();
  }, [health]);
  const now = fixedNow ?? Date.now();
  const source = health ?? (summary ? { status: summary.status, summary: summary.view?.summary ?? null, rows: [...(summary.view?.rows ?? [])] } : null);
  const model = source ? cardModel(source, now) : null;
  const digest = health?.digest ?? null;
  return <section aria-labelledby="health-card-title" className="rounded-xl border border-hairline/50 bg-panel p-4 text-[13px]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="health-card-title" className="text-[15px] font-semibold text-ink">{HEALTH_COPY.title}</h2>
      {model?.openLine && <span className="text-ink-secondary">{model.openLine}</span>}
    </div>
    <p role="status" className="mt-1 text-ink">{model ? model.sentence : "Loading…"}</p>
    {model?.time && <p className="mt-1 text-ink-secondary">{model.time}</p>}
    {backupNotice && <div className="mt-3 rounded-lg border border-danger/30 bg-danger/[0.06] p-3">
      <p className="font-medium text-ink">The last backup didn't finish</p>
      <p className="mt-1 text-ink-secondary">{backupNotice.sentence}</p>
      {onOpenBackups && <div className="mt-2"><button type="button" className={button} onClick={onOpenBackups}>Open Backups</button></div>}
    </div>}
    {model && model.rows.length > 0 && <ul aria-label="Open health issues" className="mt-3 space-y-1">
      {model.rows.map(row => <li key={row.fingerprint} className="text-ink-secondary">
        <span className="text-ink">{healthTitle(row.titleKey)}</span>{`, last seen ${ageLabel(row.lastSeenAt, now)}`}
      </li>)}
    </ul>}
    {digest && <HealthDigestView digest={digest} now={now} onView={() => setOpen(true)} />}
    <div className="mt-3">
      <button type="button" className={button} aria-expanded={open} aria-controls="health-details" onClick={() => setOpen(value => !value)}>
        {open ? HEALTH_COPY.hideDetails : HEALTH_COPY.details}
      </button>
    </div>
    {open && <div id="health-details"><HealthDetails onNavigate={onNavigate} /></div>}
  </section>;
}
