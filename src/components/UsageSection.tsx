// App settings → Usage: what every bot has used, in plain numbers, and what
// memory learning has read and written this month against its limit. Bot
// figures are banked per settled turn on each task (server/store.ts
// addTaskUsage) into a bucket per local calendar month, read here for this month; the learning figures are the memory
// ledger's own (status.learning.ceiling). Tokens only.
import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { ActionButton } from "./ActionButton";
import { Card } from "./SettingsPrimitives";
import { PlanUsageCard } from "./PlanUsageCard";
import { Anchor } from "./SettingsAnchor";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useAction } from "@/lib/use-action";
import { learningConnectionLabel } from "@/lib/memory-learning";
import { LEARNING_LIMIT_ANCHOR, ceilingPercent, readLine, writtenLine } from "@/lib/learning-limit";
import { formatTokens, monthCountingStart, monthUsageRows, usageCsv } from "@/lib/usage";
import { monthRoutineUsage } from "@/lib/usage-routines";
import { SpendLimitCard } from "./SpendLimitCard";
import { useDesktopSurface } from "@/lib/use-surface";

export { usageCsv };
import type { LearningCeilingStatus } from "../../shared/memory-learning-contract";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

/** One bar: the label, the percent, and the fill. */
function LimitBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const percent = ceilingPercent(used, limit);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-[13px] text-ink-secondary">
        <span>{label}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded bg-control">
        <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

type MonthTokens = { input: number; output: number; cachedInput?: number };

/** The table shows new tokens once any engine reported a cache split (upstream #1878). */
export function monthTokensLabelKey(rows: ReadonlyArray<MonthTokens>): "settings.l6.usage.colNewTokens" | "settings.l6.usage.colTokens" {
  return rows.some((r) => typeof r.cachedInput === "number") ? "settings.l6.usage.colNewTokens" : "settings.l6.usage.colTokens";
}

/** What the new-token total leaves out, and everything that went through the model. Null with nothing cached. */
export function monthCacheNote(rows: ReadonlyArray<MonthTokens>): { cached: number; total: number } | null {
  let cached = 0, total = 0;
  for (const r of rows) {
    cached += typeof r.cachedInput === "number" ? Math.min(Math.max(0, r.cachedInput), r.input) : 0;
    total += r.input + r.output;
  }
  return cached > 0 ? { cached, total } : null;
}

const detail = (input: number, output: number, cached?: number) =>
  `${formatTokens(input)} in${typeof cached === "number" ? ` (${formatTokens(Math.min(cached, input))} cached)` : ""} \u00b7 ${formatTokens(output)} out`;

/** This month by bot (usage.by-bot): replies and tokens per bot, with the CSV export. */
export function UsageByBotCard() {
  const { state } = useStore();
  const shown = state.bots.filter((b) => !b.hidden);
  const rows = monthUsageRows(shown);
  const total = rows.reduce((sum, r) => ({ replies: sum.replies + r.replies, tokens: sum.tokens + r.tokens }), { replies: 0, tokens: 0 });
  const countingFrom = monthCountingStart(rows);
  const cacheNote = monthCacheNote(rows);
  const exportCsv = useAction(
    async () => {
      const csv = usageCsv(rows.map((row) => ({ name: row.bot.name, replies: row.replies, tokens: row.tokens })));
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "usage-this-month.csv";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    },
    { idle: t("settings.l6.usage.export"), pending: t("settings.l6.usage.exporting"), success: t("settings.l6.usage.exported"), failure: t("settings.l6.usage.exportFailed") },
  );

  return (
      <Card title={t("settings.l6.usage.byBot")} subtitle={t("settings.l6.usage.byBotHint")}>
        {rows.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">{t("settings.l6.usage.empty")}</div>
        ) : (
          <div className="flex flex-col">
            <div className="mb-2 flex justify-end">
              <ActionButton data-setting-control="usage-heading" action={exportCsv} className={button}>{t("settings.l6.usage.export")}</ActionButton>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>{t("settings.l6.usage.colBot")}</span>
              <span className="text-right">{t("settings.l6.usage.colReplies")}</span>
              <span className="text-right">{t(monthTokensLabelKey(rows))}</span>
            </div>
            {rows.map(({ bot, replies, tokens, input, output, cachedInput }) => (
              <div key={bot.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px]">
                <span className="flex min-w-0 items-center gap-2 text-ink">
                  <BotAvatar bot={bot} state="idle" size={22} animated={false} />
                  <span className="truncate">{bot.name}</span>
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{replies}</span>
                <span className="text-right tabular-nums text-ink" title={detail(input, output, cachedInput)}>
                  {formatTokens(tokens)}
                </span>
              </div>
            ))}
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-5 pt-2.5 text-[13px] font-medium text-ink">
              <span>{t("settings.l6.usage.allBots")}</span>
              <span className="text-right tabular-nums">{total.replies}</span>
              <span className="text-right tabular-nums">{formatTokens(total.tokens)}</span>
            </div>
            {cacheNote && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                {t("settings.l6.usage.cachedNote", { cached: formatTokens(cacheNote.cached), total: formatTokens(cacheNote.total) })}
              </div>
            )}
            {countingFrom !== null && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                {t("settings.l6.usage.sinceNote", { date: new Date(countingFrom).toLocaleDateString(undefined, { month: "long", day: "numeric" }) })}
              </div>
            )}
          </div>
        )}
      </Card>
  );
}

/** This month by routine: a plain line when no routine ran this month (the card is never left out). */
export function UsageByRoutineCard() {
  const { state } = useStore();
  const shown = state.bots.filter((b) => !b.hidden);
  const rows = monthUsageRows(shown);
  const byRoutine = monthRoutineUsage(shown);
  return (
    <>
      {!byRoutine && <Card title={t("settings.l6.usage.byRoutine")}><p className="text-[13px] text-ink-secondary">{t("settings.usage.noRoutine")}</p></Card>}
      {byRoutine && (
        <Card title={t("settings.l6.usage.byRoutine")}>
          <div className="flex flex-col" data-usage-by-routine="">
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>{t("settings.l6.usage.colRoutine")}</span>
              <span className="text-right">{t("settings.l6.usage.colReplies")}</span>
              <span className="text-right">{t(monthTokensLabelKey(rows))}</span>
            </div>
            {[...byRoutine.rows, { id: "", name: "", replies: byRoutine.rest.replies, tokens: byRoutine.rest.tokens }].map((row) => (
              <div key={row.id || "rest"} className="grid grid-cols-[1fr_auto_auto] items-center gap-x-5 border-b border-hairline/20 py-2 text-[13px] last:border-b-0">
                <span className={`truncate ${row.id ? "text-ink" : "text-ink-secondary"}`}>
                  {row.id ? (row.name ?? t("settings.l6.usage.otherRoutines")) : t("settings.l6.usage.notRoutine")}
                </span>
                <span className="text-right tabular-nums text-ink-secondary">{row.replies}</span>
                <span className="text-right tabular-nums text-ink">{formatTokens(row.tokens)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/** Memory learning this month (usage.learning): distinguish a pending read, a failed read and an unavailable surface. */
export function UsageLearningCard() {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [ceiling, setCeiling] = useState<LearningCeilingStatus | null>(null);
  const [connection, setConnection] = useState<string>("");
  const [readState, setReadState] = useState<"loading" | "ready" | "failed" | "unavailable">("loading");
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const refresh = () => { setReadState("loading"); setReadVersion((version) => version + 1); };
  useEffect(() => {
    if (desktop === undefined) return;
    const controller = new AbortController();
    api(desktop ? "/api/memory/status" : "/api/memory/learning-usage", { signal: controller.signal })
      .then((status) => {
        const learning = (status as { learning?: { ceiling?: LearningCeilingStatus; connection?: { label?: string; source?: string } } } | null)?.learning;
        if (controller.signal.aborted) return;
        setCeiling(learning?.ceiling ?? null);
        setConnection(learning?.connection?.source && learning.connection.source !== "none" ? learningConnectionLabel(learning.connection.label ?? "") : "");
        setCheckedAt(learning?.ceiling ? Date.now() : null);
        setReadState(learning?.ceiling ? "ready" : "unavailable");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const status = (cause as { status?: number } | null)?.status;
        if (status === 403 || status === 404 || status === 410) {
          setCeiling(null);
          setConnection("");
          setCheckedAt(null);
          setReadState("unavailable");
        } else {
          // A failed refresh leaves the last successful snapshot and its timestamp visible.
          setReadState("failed");
        }
      });
    return () => controller.abort();
  }, [readVersion, desktop]);

  return (
    <Card title={t("settings.l6.usage.learningTitle")}>
      {readState === "loading" && <p role="status" className="text-[13px] text-ink-secondary">{t("memoryPage.loading")}</p>}
      {readState === "failed" && <div role="alert" className="space-y-1 text-[13px] text-ink-secondary">
        <p>{t("settings.usage.learningLoadFailed" as LocaleKey)}</p>
        {ceiling && checkedAt !== null && <p>{t("settings.usage.learningStale" as LocaleKey, { time: new Date(checkedAt).toLocaleString() })}</p>}
      </div>}
      {readState === "unavailable" && <p className="text-[13px] text-ink-secondary">{t("settings.usage.learningUnavailable" as LocaleKey)}</p>}
      {ceiling && (
        <div className="flex flex-col gap-3">
          <LimitBar label={readLine(ceiling)} used={ceiling.inputUsed} limit={ceiling.input} />
          <LimitBar label={writtenLine(ceiling)} used={ceiling.outputUsed} limit={ceiling.output} />
          {ceiling.paused && <div className="text-[13px] text-ink">{t("settings.l6.usage.paused")}</div>}
          <div className="text-[13px] leading-relaxed text-ink-secondary">
            {connection ? `${t("settings.l6.usage.runsOn", { connection })} ` : ""}{t("settings.l6.usage.guard")}
          </div>
          {desktop === true && <div>
            <button
              type="button"
              className="text-[13px] text-accent underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
              data-setting-control="usage-learning-heading"
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage", anchor: LEARNING_LIMIT_ANCHOR })}
            >
              {t("settings.l6.usage.changeLimit")}
            </button>
          </div>}
        </div>
      )}
      {readState !== "unavailable" && <button type="button" className={`${button} mt-3 min-h-11`} disabled={readState === "loading"} onClick={refresh}>
        {t(readState === "failed" ? "providerError.retry" : "memoryPage.refresh")}
      </button>}
    </Card>
  );
}

export function UsageSection() {
  return (
    <>
      <SpendLimitCard />
      <PlanUsageCard />
      <UsageByBotCard />
      <UsageByRoutineCard />
      <Anchor id="usage-learning-heading"><UsageLearningCard /></Anchor>
    </>
  );
}
