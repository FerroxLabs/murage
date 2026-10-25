// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One quiet, dismissible line when update checks have been failing for a day or more (the main process sets
// `staleCheckSince`; electron/updater-health.mjs). Dismissal is remembered per streak in this browser only.
import { useState } from "react";
import { X } from "lucide-react";
import { useUpdaterState } from "@/lib/updater";

const DISMISSED_KEY = "murage.updateStaleNotice.dismissed";

export function staleNoticeText(since: string, locale?: string): string {
  const date = new Date(since);
  const when = Number.isNaN(date.getTime())
    ? "a while"
    : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  return `Murage couldn't check for updates since ${when}.`;
}

function readDismissed(): string | null {
  try { return window.localStorage.getItem(DISMISSED_KEY); } catch { return null; }
}

export function UpdateStaleNotice() {
  const s = useUpdaterState();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  const since = s?.staleCheckSince;
  const bannerOpen = Boolean(s && s.status !== "idle" && s.status !== "checking");
  // UpdateBanner sits in the same corner; it has priority while it is open.
  if (!s || !since || dismissed === since || bannerOpen) return null;
  const updater = window.muragebox!.updater!;
  return (
    <div
      role="status"
      data-testid="update-stale-notice"
      className="fixed bottom-4 left-4 z-40 flex max-w-sm items-center gap-3 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary shadow-lg"
    >
      <span>{staleNoticeText(since)}</span>
      <button onClick={() => void updater.check()} className="text-ink underline underline-offset-2 hover:text-accent">
        Check now
      </button>
      <button
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(since);
          try { window.localStorage.setItem(DISMISSED_KEY, since); } catch { /* remembered for this session only */ }
        }}
        className="rounded p-0.5 text-ink-secondary hover:text-ink"
      >
        <X size={12} />
      </button>
    </div>
  );
}
