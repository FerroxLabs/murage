// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The round update button beside the account menu. Idea from OpenMaus (Apache-2.0, UpdateIndicator.tsx); ours hangs off the
// same updater bridge as UpdateBanner, so it exists only in the packaged desktop app: no bridge (browser, dev, the phone
// app) renders nothing. It opens the centred card (lib/update-card.ts).
import { ArrowDownToLine, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { indicatorLabelKey, indicatorShows, openUpdateCard } from "@/lib/update-card";
import { useUpdaterState } from "@/lib/updater";

export function UpdateIndicator() {
  const s = useUpdaterState();
  if (!s || !indicatorShows(s.status)) return null;
  const label = t(indicatorLabelKey(s.status));
  const Icon =
    s.status === "available" ? ArrowDownToLine
      : s.status === "downloaded" || s.status === "handed-off" ? RefreshCw
        : s.status === "error" ? TriangleAlert
          : Loader2;
  return (
    <button
      type="button"
      onClick={openUpdateCard}
      aria-label={label}
      title={label}
      data-testid="update-indicator"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        s.status === "error" ? "bg-danger/15 text-danger hover:bg-danger/25" : "bg-accent/15 text-accent hover:bg-accent/25",
      )}
    >
      <Icon size={16} className={s.status === "downloading" || s.status === "installing" || s.status === "deferred" ? "animate-spin" : undefined} aria-hidden="true" />
    </button>
  );
}
