// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Health problem the owner must act on, as an ordinary Needs you item: what it is, why it matters, one action. It
// has no Dismiss: it goes by itself when the problem clears.
import { t } from "@/lib/i18n";
import { ageLabel, type HealthNeed } from "../../../shared/sentinel-view";
import { useDesktopSurface } from "@/lib/use-surface";
import { foldTimeLine, goLabel, healthDestination, healthGuide, settingsPagesHere } from "./health-guide";

export const needButton = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";

export function HealthNeedCard({ need, now, onOpen }: { need: HealthNeed; now: number; onOpen?: (section: "backups" | "storage" | "memory" | "engines") => void }) {
  const guide = healthGuide(need.titleKey);
  const to = guide.action.kind === "go" ? guide.action.to : null;
  const place = to ? healthDestination(to) : null;
  const desktop = useDesktopSurface();
  return <div role="status" className="rounded-xl border border-danger/30 bg-danger/[0.06] p-4 text-[13px]">
    <p className="font-medium text-ink">{t(guide.title)}</p>
    <p className="mt-1 text-ink-secondary">{t(guide.matters)}</p>
    <p className="mt-1 text-[12px] text-ink-secondary">{foldTimeLine(need.issues, ageLabel(need.lastSeenAt, now))}</p>
    {to && place && onOpen && settingsPagesHere(desktop) && <div className="mt-3"><button type="button" className={needButton} onClick={() => onOpen(place.section)}>{goLabel(to)}</button></div>}
  </div>;
}

/** An engine or Flux problem the owner must act on (src/lib/engine-need.ts): the same card, one action. */
export function EngineNeedCard({ title, detail, label, onOpen }: { title: string; detail: string; label: string; onOpen?: () => void }) {
  const desktop = useDesktopSurface();
  return <div role="status" className="rounded-xl border border-danger/30 bg-danger/[0.06] p-4 text-[13px]">
    <p className="font-medium text-ink">{title}</p>
    <p className="mt-1 text-ink-secondary">{detail}</p>
    {onOpen && settingsPagesHere(desktop) && <div className="mt-3"><button type="button" className={needButton} onClick={onOpen}>{label}</button></div>}
  </div>;
}
