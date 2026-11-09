// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings, Usage: Flux's monthly figure and the monthly limit (UX-L2C,
// 1.0.18). The field is pre-filled with the suggested $1,000 and nothing is
// applied until the owner presses Save. The limit drives a heads-up on Today
// at 80% and at the limit; it holds and refuses nothing.
import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import { Card } from "./SettingsPrimitives";
import { monthLine, useMonthReading } from "./today/MonthCard";
import { asOfLine } from "./today/MonthCardView";
import { formatDollars, parseLimitInput, SUGGESTED_MONTHLY_LIMIT_USD } from "@/lib/spend-meter";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

export function SpendLimitCard() {
  // The Usage meter's own GET /api/spend, shown only for the current key fingerprint (pull only).
  const { show, total, state: reading } = useMonthReading();
  const [text, setText] = useState(() => String(reading.limitUsd ?? SUGGESTED_MONTHLY_LIMIT_USD));
  // A limit saved elsewhere (another window) shows here when it lands.
  useEffect(() => { if (reading.limitUsd !== null) setText(String(reading.limitUsd)); }, [reading.limitUsd]);
  const parsed = parseLimitInput(text);

  const save = useAction(
    async () => {
      if (parsed === undefined) throw new Error(t("ux.l2c.usage.invalid"));
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ spend: { monthlyLimitUsd: parsed } }) });
    },
    { idle: t("ux.l2c.usage.save"), pending: t("ux.l2c.usage.saving"), success: t("ux.l2c.usage.saved"), failure: t("ux.l2c.usage.saveFailed") },
  );
  const remove = useAction(
    async () => {
      await api("/api/config", { method: "PATCH", body: JSON.stringify({ spend: { monthlyLimitUsd: null } }) });
      setText(String(SUGGESTED_MONTHLY_LIMIT_USD));
    },
    { idle: t("ux.l2c.usage.remove"), pending: t("ux.l2c.usage.saving"), success: t("ux.l2c.usage.saved"), failure: t("ux.l2c.usage.saveFailed") },
  );

  if (!show) return null;
  return (
    <Card title={t("ux.l2c.usage.title")} subtitle={t("ux.l2c.usage.subtitle")}>
      <div className="flex flex-col gap-3 text-[13px]">
        <div className="text-[15px] font-medium tabular-nums text-ink" data-testid="spend-month">{monthLine(total, { ...reading, limitUsd: null, percent: null })}</div>
        {total.state === "ok" && <div className="text-ink-secondary">{asOfLine(total)}</div>}
        <div className="leading-relaxed text-ink-secondary">
          {reading.limitUsd !== null
            ? t("ux.l2c.usage.limitLine", { limit: formatDollars(reading.limitUsd) })
            : t("ux.l2c.usage.noLimit", { suggested: formatDollars(SUGGESTED_MONTHLY_LIMIT_USD) })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-ink">
            <span aria-hidden="true">$</span>
            <input
              type="text"
              inputMode="decimal"
              aria-label={t("ux.l2c.usage.field")}
              aria-invalid={parsed === undefined}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="min-h-10 w-32 rounded-lg border border-hairline/50 bg-control px-3 py-2 tabular-nums text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            />
          </label>
          <ActionButton action={save} className={button} blocked={parsed === undefined}>{t("ux.l2c.usage.save")}</ActionButton>
          {reading.limitUsd !== null && <ActionButton action={remove} className={button}>{t("ux.l2c.usage.remove")}</ActionButton>}
        </div>
        {parsed === undefined && <div role="alert" className="text-danger">{t("ux.l2c.usage.invalid")}</div>}
        <div className="leading-relaxed text-ink-secondary">{t("ux.l2c.usage.fluxOnly")} {t("ux.l2c.month.chatOnly")}</div>
      </div>
    </Card>
  );
}
