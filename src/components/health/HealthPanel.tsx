// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What was checked" (designs/HEALTH-DOCTOR.md section 5): Fuigo and Flux Router on top, always shown, then the
// engines bots use, then Other engines folded away (grey, no dots), then a line for each background check area with
// something open.
import { useId, useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import type { EngineHealthAnswer } from "@/components/shell/shell-contract";
import type { HealthFold } from "../../../shared/health-levels";
import type { HealthIssue } from "../../../shared/sentinel-view";
import { checkArea, engineStateWord, fluxPanelLine, otherEngines, usedEngines } from "./health-findings";
import { settingsPagesHere } from "./health-guide";

const quietLink = "rounded-md text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus";
const AREAS = [
  { area: 4, label: "ux.l2a.health.area.backups" },
  { area: 5, label: "ux.l2a.health.area.storage" },
  { area: 3, label: "ux.l2a.health.area.engines" },
  { area: 9, label: "ux.l2a.health.area.memory" },
] as const;

const tick = <span aria-hidden="true" className="text-success">✓</span>;

export function HealthPanel({ answer, folds }: { answer: EngineHealthAnswer | null; folds: readonly HealthFold<HealthIssue>[] }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [othersOpen, setOthersOpen] = useState(false);
  const othersId = useId();
  const primaryId = answer ? answer.defaultId !== undefined ? answer.defaultId : answer.primary?.id ?? null : null;
  const rows = answer?.engines ?? [];
  const used = usedEngines(rows, primaryId);
  const others = otherEngines(rows, primaryId);
  const openEngines = settingsPagesHere(desktop) ? () => dispatch({ type: "toggleAppSettings", open: true, section: "engines" }) : null;
  // Only areas with something open get a line: a per-area "no problem found" tick waits for batch 2 (FIX-LEDGER
  // HEALTH-DOCTOR-ALLCLEAR), when every read of the refresh is tracked.
  const areaLine = (area: number): string | null => {
    const open = folds.filter((fold) => (fold.level === "act" || fold.level === "watch") && checkArea(fold.titleKey) === area);
    if (open.some((fold) => fold.level === "act")) return t("ux.l2a.health.area.act");
    return open.length > 0 ? t("ux.l2a.health.area.watch") : null;
  };
  const areas = AREAS.map(({ area, label }) => ({ area, label, line: areaLine(area) })).filter((entry) => entry.line !== null);
  const botsOf = (n: number | undefined) => (n ? ` (${n === 1 ? t("ux.l2a.health.botsOne") : t("ux.l2a.health.botsMany", { n })})` : "");
  return <section aria-labelledby="health-panel-title" className="rounded-xl border border-hairline/50 bg-panel text-[13px]">
    <h2 id="health-panel-title" className="px-4 pt-3 text-[13px] font-semibold text-ink-secondary">{t("ux.l2a.health.checked")}</h2>
    <div className="border-b border-hairline/40 px-4 py-3">
      <p className="font-medium text-ink">{t("ux.l2a.health.fluxCard")}</p>
      <p className="mt-0.5 text-ink-secondary">{answer ? fluxPanelLine(answer.flux, answer.fluxInfo) : t("ux.l2a.health.flux.checking")}</p>
    </div>
    {used.length > 0 && <div className="border-b border-hairline/40 px-4 py-3">
      <p className="text-[12px] text-ink-secondary">{t("ux.l2a.health.enginesUsed")}</p>
      <ul className="mt-1 space-y-1">{used.map((row) => <li key={row.id} className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-ink">{row.label}{botsOf(row.usedBy)}</span>
        <span className="shrink-0 text-ink-secondary">{engineStateWord(row)} {row.state === "ready" && tick}</span>
      </li>)}</ul>
    </div>}
    {others.length > 0 && <div className="border-b border-hairline/40 px-4 py-3">
      <button type="button" aria-expanded={othersOpen} aria-controls={othersId} onClick={() => setOthersOpen(!othersOpen)} className={quietLink}>
        {t("ux.l2a.health.otherEngines", { n: others.length })}
      </button>
      {/* Engines no bot uses: their state in words, a quiet link, never a dot or a red line. */}
      <ul id={othersId} hidden={!othersOpen} className="mt-1 space-y-1 text-ink-secondary">{others.map((row) => <li key={row.id} className="flex items-center justify-between gap-3">
        <span className="min-w-0">{row.label}</span>
        <span className="shrink-0">{engineStateWord(row)}{row.state !== "ready" && row.state !== "checking" && openEngines && <>{" · "}<button type="button" className={quietLink} onClick={openEngines}>
          {t(row.state === "missing" ? "ux.l2a.health.setUp" : row.state === "signed-out" ? "ux.l2a.health.signIn" : "ux.l2a.health.openEngines")}
        </button></>}</span>
      </li>)}</ul>
    </div>}
    {areas.length > 0 && <ul className="space-y-1 px-4 py-3">{areas.map(({ area, label, line }) =>
      <li key={area} className="flex items-center justify-between gap-3"><span className="text-ink">{t(label)}</span><span className="text-ink-secondary">{line}</span></li>)}</ul>}
  </section>;
}
