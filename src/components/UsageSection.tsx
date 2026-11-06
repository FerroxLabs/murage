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
import { t } from "@/lib/i18n";
import { useAction } from "@/lib/use-action";
import { learningConnectionLabel } from "@/lib/memory-learning";
import { LEARNING_LIMIT_ANCHOR, ceilingPercent, readLine, writtenLine } from "@/lib/learning-limit";
import { formatTokens, monthCountingStart, monthUsageRows, usageCsv } from "@/lib/usage";

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

const detail = (input: number, output: number, cached?: number) =>
  `${formatTokens(input)} in${typeof cached === "number" ? ` (${formatTokens(Math.min(cached, input))} cached)` : ""} \u00b7 ${formatTokens(output)} out`;

export function UsageSection() {
  const { state, dispatch } = useStore();
  const rows = monthUsageRows(state.bots.filter((b) => !b.hidden));
  const total = rows.reduce((sum, r) => ({ replies: sum.replies + r.replies, tokens: sum.tokens + r.tokens }), { replies: 0, tokens: 0 });
  const countingFrom = monthCountingStart(rows);

  // The learning ceiling, read once when the page opens. A door without the memory page (a phone or a browser) simply has none.
  const [ceiling, setCeiling] = useState<LearningCeilingStatus | null>(null);
  const [connection, setConnection] = useState<string>("");
  useEffect(() => {
    const controller = new AbortController();
    api("/api/memory/status", { signal: controller.signal })
      .then((status) => {
        const learning = (status as { learning?: { ceiling?: LearningCeilingStatus; connection?: { label?: string; source?: string } } } | null)?.learning;
        if (controller.signal.aborted || !learning?.ceiling) return;
        setCeiling(learning.ceiling);
        setConnection(learning.connection?.source && learning.connection.source !== "none" ? learningConnectionLabel(learning.connection.label ?? "") : "");
      })
      .catch(() => { /* no memory page on this door: the learning card is left out */ });
    return () => controller.abort();
  }, []);

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
    <>
      <Card title={t("settings.l6.usage.byBot")} subtitle={t("settings.l6.usage.byBotHint")}>
        {rows.length === 0 ? (
          <div className="text-[13px] text-ink-secondary">{t("settings.l6.usage.empty")}</div>
        ) : (
          <div className="flex flex-col">
            <div className="mb-2 flex justify-end">
              <ActionButton action={exportCsv} className={button}>{t("settings.l6.usage.export")}</ActionButton>
            </div>
            <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 border-b border-hairline/40 pb-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
              <span>{t("settings.l6.usage.colBot")}</span>
              <span className="text-right">{t("settings.l6.usage.colReplies")}</span>
              <span className="text-right">{t("settings.l6.usage.colTokens")}</span>
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
            {countingFrom !== null && (
              <div className="mt-3 text-[12px] leading-relaxed text-ink-secondary">
                {t("settings.l6.usage.sinceNote", { date: new Date(countingFrom).toLocaleDateString(undefined, { month: "long", day: "numeric" }) })}
              </div>
            )}
          </div>
        )}
      </Card>
      {ceiling && (
        <div id="usage-learning-heading" tabIndex={-1} className="outline-none">
          <Card title={t("settings.l6.usage.learningTitle")}>
            <div className="flex flex-col gap-3">
              <LimitBar label={readLine(ceiling)} used={ceiling.inputUsed} limit={ceiling.input} />
              <LimitBar label={writtenLine(ceiling)} used={ceiling.outputUsed} limit={ceiling.output} />
              {ceiling.paused && <div className="text-[13px] text-ink">{t("settings.l6.usage.paused")}</div>}
              <div className="text-[13px] leading-relaxed text-ink-secondary">
                {connection ? `${t("settings.l6.usage.runsOn", { connection })} ` : ""}{t("settings.l6.usage.guard")}
              </div>
              <div>
                <button
                  type="button"
                  className="text-[13px] text-accent underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "memory", anchor: LEARNING_LIMIT_ANCHOR })}
                >
                  {t("settings.l6.usage.changeLimit")}
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
