// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health screen (Sean 10-30, 11-01). Needs you shows only what the owner must act on; everything else about how
// Murage is doing lives here: the status, the engines, and every open issue with what it means and what to do.
// As a doctor (Sean 11-02, designs/HEALTH-DOCTOR.md): one line says how many things to fix and where to start, the
// findings follow in order of impact with one fix each, and What was checked sits beside them on a wide window.
import { useCallback, useEffect, useId, useState } from "react";
import { api, useStore } from "@/state/store";
import { useEngineHealthAnswer, useEngineReading } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import { useDesktopSurface } from "@/lib/use-surface";
import { StatusDot } from "@/components/shell/StatusDot";
import { BoxBody, BoxHead } from "../ui/BoxShell";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { HealthPageProps } from "@/components/shell/shell-contract";
import { strongestHealthLevel, type HealthFold } from "../../../shared/health-levels";
import { HEALTH_COPY, healthStateLine, recoveredLine, type HealthIssue, type HealthSummaryResponse, type NextAction } from "../../../shared/sentinel-view";
import { healthFromEngines, healthWithChecks } from "./health-status";
import { healthDestination, healthGuide } from "./health-guide";
import { healthFindings, summaryLine } from "./health-findings";
import { HEALTH_BODY, HEALTH_FRAME, HEALTH_HEAD, HealthHeadTop } from "./HealthExit";
import { HealthClosed, HealthDigestView, HealthIssueGroups, healthFolds, readHealthIssues } from "./HealthIssues";
import { HealthFindingList } from "./HealthFindings";
import { HealthPanel } from "./HealthPanel";


export function HealthPageBody({ onLeave }: HealthPageProps) {
  const { state, dispatch } = useStore();
  const server = useEngineHealthAnswer();
  const reading = useEngineReading();
  const [summary, setSummary] = useState<HealthSummaryResponse | null>(null);
  const [folds, setFolds] = useState<HealthFold<HealthIssue>[]>([]);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const reread = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    void api("/api/sentinel/summary", { signal: controller.signal })
      .then((value: HealthSummaryResponse) => { if (!controller.signal.aborted) setSummary(value); })
      .catch(() => { if (!controller.signal.aborted) setSummary({ status: "unavailable", view: null }); });
    void readHealthIssues("open", controller.signal)
      .then((issues) => { if (!controller.signal.aborted) { setFolds(healthFolds(issues)); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [revision, state.owedRev]);
  const now = Date.now();
  const desktop = useDesktopSurface();
  const [panelOpen, setPanelOpen] = useState(false);
  const panelId = useId();
  const status = healthWithChecks(healthFromEngines(reading.engine, reading.flux, reading.fromServer || state.instances.length > 0), strongestHealthLevel(folds));
  const checks = summary ? healthStateLine(summary.status, summary.view?.summary ?? null, now) : null;
  const quiet = folds.length > 0 && folds.every((fold) => fold.level === "note");
  // Every finding in order of impact (Flux Router and Fuigo first), from what the page already holds.
  // The engine actually chosen as the default; an older server only sends the fallback it names on Today.
  const defaultId = server ? server.defaultId !== undefined ? server.defaultId : server.primary?.id ?? null : null;
  const entries = healthFindings({ engines: server?.engines ?? [], primaryId: defaultId, flux: server?.flux ?? reading.flux, fluxInfo: server?.fluxInfo, folds, desktop: desktop === true, now });
  const counted = summaryLine(entries, (fold) => t(healthGuide(fold.titleKey).title));
  // Nothing to fix: the sentence is the one the page said before (how far the checks got). A new all-clear line was cut
  // after two review rounds (FIX-LEDGER HEALTH-DOCTOR-ALLCLEAR, batch 2): it must wait for every read of this refresh.
  const line = counted
    ?? (status.level === "act" || status.level === "watch" ? status.line
      : quiet ? t("ux.l2b.health.lineNote")
        : checks?.sentence ?? status.line);
  const go = (to: NextAction) => { const place = healthDestination(to); if (place) dispatch({ type: "toggleAppSettings", open: true, section: place.section }); };
  const recovered = summary?.view?.summary.recoveredCount ?? 0;
  return (
    <main aria-labelledby="health-page-title" className={HEALTH_FRAME}>
      <BoxHead className={HEALTH_HEAD}>
        {/* The way out (Sean 11-02): the same header as while loading (HealthExit.tsx), Back and close on every screen. */}
        <HealthHeadTop onLeave={onLeave} menu={<OpenBotListButton />} dot={<StatusDot level={status.level} />} />
        <p role="status" className="mt-1 text-[14px] text-ink-secondary">{line}</p>
      </BoxHead>
      <BoxBody className={HEALTH_BODY}>
      {checks?.time && <p className="mt-0.5 text-[12px] text-ink-secondary">{checks.time}</p>}
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{HEALTH_COPY.unavailable}</p>}
      {/* Two columns from 1024 px: findings on the left (7/12), What was checked on the right (5/12), centred up to 1200 px. */}
      <div className="mx-auto mt-4 grid w-full max-w-[1200px] grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-7">
          <HealthFindingList entries={entries} now={now} onGo={go} onChanged={reread} />
          {/* What Murage is on (notes) stays out of the count and out of the findings. */}
          <HealthIssueGroups folds={folds.filter((fold) => fold.level === "note")} now={now} onGo={go} onChanged={reread} />
          {recovered > 0 && <p className="mt-4 text-[13px] text-ink-secondary">{recoveredLine(recovered)}</p>}
          {summary?.digest && <HealthDigestView digest={summary.digest} now={now} />}
          <HealthClosed now={now} />
        </div>
        <div className="min-w-0 lg:col-span-5">
          <button type="button" aria-expanded={panelOpen} aria-controls={panelId} onClick={() => setPanelOpen(!panelOpen)}
            className="min-h-10 rounded-lg text-[13px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus lg:hidden">
            {t("ux.l2a.health.checked")}
          </button>
          <div id={panelId} className={`${panelOpen ? "block" : "hidden"} lg:sticky lg:top-0 lg:block`}>
            <HealthPanel answer={server} folds={folds} />
          </div>
        </div>
      </div>
      </BoxBody>
    </main>
  );
}
