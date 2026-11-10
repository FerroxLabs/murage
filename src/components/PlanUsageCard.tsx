// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// DG8 slice 3: Settings > Usage > Plan usage. One row per engine account with what the engine last
// reported. A door the route refuses (or a paused Cloud, which keeps its own offline status) shows
// no card at all, so "not reported on Cloud yet" never covers a paused home.
import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { ActionButton } from "./ActionButton";
import { Card } from "./SettingsPrimitives";
import { t } from "@/lib/i18n";
import { useAction } from "@/lib/use-action";
import { readPlanUsage } from "@/lib/plan-usage-read";
import {
  planClock, planEmptyLine, planNow, planOmittedLine, planRowName, planRowStatus, planRowStale, planWindowLines,
  type PlanClock, type PlanUsageReport,
} from "@/lib/plan-usage-view";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const TICK_MS = 30_000;

export function PlanUsageCard() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [clock, setClock] = useState<PlanClock | null>(null);
  const [mono, setMono] = useState(() => performance.now());
  const [failed, setFailed] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pages, setPages] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);

  const take = (next: unknown, requestStarted: number) => {
    const r = next as PlanUsageReport | null;
    if (!r || !Array.isArray(r.accounts) || typeof r.serverNow !== "number") return;
    const at = performance.now();
    setReport(r);
    setClock(planClock(r, Date.now(), requestStarted));
    setMono(at);
  };

  const load = async (refreshing = false, page = cursor) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      await readPlanUsage(api, take, controller.signal, refreshing, page);
    } catch (error) {
      if (!controller.signal.aborted) {
        const status = (error as { status?: number })?.status;
        setHidden(status === 401 || status === 403 || status === 404 || status === 410);
        setFailed(true);
        setReport((previous) => previous && ({ ...previous, accounts: previous.accounts.map((row) => ({
          ...row, refreshing: false, status: row.windows.length ? "stale" : "unavailable",
        })) }));
      }
      throw error;
    } finally {
      if (request.current === controller) setLoading(false);
    }
  };

  useEffect(() => {
    // load() already puts a failed read on the card's own line (the alert below); this logs it too, and a cancelled read stays quiet.
    void load().catch((error: unknown) => { if ((error as { name?: string } | null)?.name !== "AbortError") console.warn("plan usage: the read failed", error); });
    const timer = window.setInterval(() => setMono(performance.now()), TICK_MS);
    return () => { request.current?.abort(); request.current = null; window.clearInterval(timer); };
  }, [cursor]);

  const refresh = useAction(
    () => load(true),
    { idle: t("settings.l6.usage.plan.refresh"), pending: t("settings.l6.usage.plan.refreshing"), success: t("settings.l6.usage.plan.refreshed"), failure: t("settings.l6.usage.plan.refreshFailed"), describeError: (_cause, fallback) => fallback },
  );

  const navigate = (next: number, history: number[]) => {
    request.current?.abort();
    refresh.dismiss();
    setReport(null);
    setClock(null);
    setFailed(false);
    setPages(history);
    setCursor(next);
  };
  if (hidden) return null;
  const now = clock ? planNow(clock, mono) : 0;
  const omitted = report ? planOmittedLine(report.omitted) : null;

  return (
    <Card title={t("settings.l6.usage.plan.title")} subtitle={t("settings.l6.usage.plan.hint")}>
      <div className="flex flex-col gap-3">
        {!report?.cloud && (
          <div className="flex justify-end">
            <ActionButton data-setting-control="plan-usage-heading" action={refresh} blocked={loading} slowHint={t("memorySettings.stillWorking")} retryLabel={t("providerError.retry")} className={button}>{t("settings.l6.usage.plan.refresh")}</ActionButton>
          </div>
        )}
        {failed && !refresh.error && <div role="alert">{t("settings.l6.usage.plan.refreshFailed")}</div>}
        {!report ? <div>{loading ? t("settings.l6.usage.plan.checking") : ""}</div> : report.accounts.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">{planEmptyLine(report)}</div>
        ) : report.accounts.map((row) => {
          const stale = planRowStale(row, now);
          return (
            <div key={row.id} className="flex flex-col gap-2 border-b border-hairline/20 pb-3">
              <div className="text-[13px] font-medium text-ink">{planRowName(row)}</div>
              {row.windows.map((w, i) => {
                const lines = planWindowLines(row, w, now, clock?.uncertain ?? true);
                return (
                  <div key={i} className={`flex flex-col gap-1 ${stale ? "opacity-70" : ""}`}>
                    <div className="flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
                      <span>{lines.label}</span>
                      <span className="tabular-nums">{lines.used}</span>
                    </div>
                    {lines.percent !== null && (
                      <div role="progressbar" aria-label={lines.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={lines.percent} aria-valuetext={lines.used} className="h-2 overflow-hidden rounded bg-control">
                        <div className={`h-full ${stale ? "bg-ink-secondary" : "bg-accent"}`} style={{ width: `${Math.min(100, lines.percent)}%` }} />
                      </div>
                    )}
                    {lines.limitReached && <div className="text-[13px] text-ink">{lines.limitReached}</div>}
                    <div className="text-[12px] text-ink-secondary" title={lines.resetUtc ?? undefined}>{lines.reset}</div>
                  </div>
                );
              })}
              <div className="text-[12px] text-ink-secondary">{planRowStatus(row, now)}</div>
            </div>
          );
        })}
        <div className="flex justify-between gap-2">
          {pages.length > 0 && <button className={button} disabled={loading || refresh.pending} onClick={() => navigate(pages[pages.length - 1], pages.slice(0, -1))}>{t("memorySettings.previousPage")}</button>}
          {report?.nextCursor != null && <button className={button} disabled={loading || refresh.pending} onClick={() => navigate(report.nextCursor!, [...pages, cursor])}>{t("memorySettings.nextPage")}</button>}
        </div>
        {omitted && <div className="text-[12px] text-ink-secondary">{omitted}</div>}
      </div>
    </Card>
  );
}
