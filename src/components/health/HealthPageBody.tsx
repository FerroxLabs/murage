// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health screen (Sean 10-30, 11-01). Needs you shows only what the owner must act on; everything else about how
// Murage is doing lives here: the status, the engines, and every open issue with what it means and what to do.
import { useCallback, useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { useEngineHealthAnswer, useEngineReading } from "@/components/today/use-engine-health";
import { t } from "@/lib/i18n";
import { StatusDot } from "@/components/shell/StatusDot";
import { OpenBotListButton } from "@/components/OpenBotListButton";
import type { HealthPageProps } from "@/components/shell/shell-contract";
import { strongestHealthLevel, type HealthFold } from "../../../shared/health-levels";
import { HEALTH_COPY, healthStateLine, recoveredLine, type HealthIssue, type HealthSummaryResponse, type NextAction } from "../../../shared/sentinel-view";
import { healthFromEngines, healthWithChecks } from "./health-status";
import { healthDestination } from "./health-guide";
import { HealthClosed, HealthDigestView, HealthIssueGroups, healthFolds, readHealthIssues } from "./HealthIssues";

export function HealthPageBody(_props: HealthPageProps) {
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
  }, [revision]);
  const now = Date.now();
  const status = healthWithChecks(healthFromEngines(reading.engine, reading.flux, reading.fromServer || state.instances.length > 0), strongestHealthLevel(folds));
  const checks = summary ? healthStateLine(summary.status, summary.view?.summary ?? null, now) : null;
  const quiet = folds.length > 0 && folds.every((fold) => fold.level === "note");
  // Nothing open from the checks: the sentence says exactly how far they got, never more than they saw.
  const line = status.level === "act" || status.level === "watch" ? status.line : quiet ? t("ux.l2b.health.lineNote") : checks?.sentence ?? status.line;
  const go = (to: NextAction) => { const place = healthDestination(to); if (place) dispatch({ type: "toggleAppSettings", open: true, section: place.section }); };
  const recovered = summary?.view?.summary.recoveredCount ?? 0;
  return (
    <main aria-labelledby="health-page-title" className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-app px-4 py-6 text-ink sm:px-6">
      {/* Phones only (OpenBotListButton.tsx): the way back to the rail drawer. */}
      <div className="md:hidden"><OpenBotListButton /></div>
      <h1 id="health-page-title" className="flex items-center gap-2 text-[20px] font-semibold">
        <StatusDot level={status.level} />{t("ux.l2a.health.title")}
      </h1>
      <p role="status" className="mt-1 text-[14px] text-ink-secondary">{line}</p>
      {checks?.time && <p className="mt-0.5 text-[12px] text-ink-secondary">{checks.time}</p>}
      {failed && <p role="alert" className="mt-2 text-[13px] text-danger">{HEALTH_COPY.unavailable}</p>}
      {server && server.engines.length > 0 && (
        <ul aria-label={t("ux.l2a.health.engines")} className="mt-4 max-w-2xl divide-y divide-hairline/40 rounded-xl border border-hairline/50 bg-panel">
          {server.engines.map((engine) => (
            <li key={engine.id} className="flex items-center gap-3 px-4 py-3 text-[14px]">
              <StatusDot level={engine.state === "ready" ? "ok" : engine.state === "limit" || engine.state === "off" ? "watch" : "act"} />
              <span className="min-w-0 flex-1"><span className="font-medium">{engine.label}</span><span className="block text-[13px] text-ink-secondary">{engine.line}</span></span>
              {engine.state !== "ready" && (
                <button type="button" onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "engines" })}
                  className="min-h-11 rounded-lg border border-hairline/50 px-3 text-[13px] font-medium hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                  {t("ux.l2a.health.openEngines")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <HealthIssueGroups folds={folds} now={now} onGo={go} onChanged={reread} />
      {recovered > 0 && <p className="mt-4 text-[13px] text-ink-secondary">{recoveredLine(recovered)}</p>}
      {summary?.digest && <HealthDigestView digest={summary.digest} now={now} />}
      <HealthClosed now={now} />
    </main>
  );
}
