// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The offline band (UX 1.0.13, lane L2A; mockup Desktop.dc.html and
// Phone.dc.html, copy verbatim). A full-width status line above the rail and
// the main column while this device has no internet. It says what still works
// and what waits, so nothing here needs a button: it clears by itself.
import { WifiOff } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Connectivity } from "@/lib/connectivity";

// `desktop` is the surface answer (true, false, or undefined while not known yet). Only a
// known desktop gets the "Bots on this computer" line; anything else gets the phone line,
// which makes no claim about this device.
export function OfflineBand({ connectivity, desktop }: { connectivity: Connectivity; desktop: boolean | undefined }) {
  if (connectivity !== "offline") return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-offline-band
      className="flex items-center justify-center gap-2 border-b border-hairline/40 bg-raised px-4 py-2 text-center text-[13px] font-medium text-ink"
    >
      <WifiOff size={16} className="shrink-0" aria-hidden="true" />
      <span>{desktop === true ? t("ux.l2a.offline.desktop") : t("ux.l2a.offline.phone")}</span>
    </div>
  );
}
