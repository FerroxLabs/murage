// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Learning paused for the rest of the month", the Needs you item (Settings L6).
// The server derives it from the month's learning ledger on every read
// (server/inbox-learning-paused.ts); this card only offers the two answers.
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { useAction } from "@/lib/use-action";
import { ActionButton } from "./ActionButton";
import { doubleLimitRequest } from "@/lib/learning-limit";
import { formatTokens } from "@/lib/usage";
import type { InboxLearningPaused } from "../../shared/inbox";

const button = "min-h-10 rounded-lg border border-hairline/50 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

/** `onSettled` re-reads the Inbox: after a raise the item is gone, and the count with it. */
export function LearningPausedCard({ row, onSettled }: { row: InboxLearningPaused; onSettled: () => void }) {
  const double = useAction(
    async () => {
      await api("/api/memory/action", { method: "POST", body: JSON.stringify(doubleLimitRequest({ input: row.input, output: row.output }, row.learningRevision)) });
    },
    { idle: t("settings.l6.paused.double"), pending: t("settings.l6.paused.doubling"), success: t("settings.l6.paused.doubled"), failure: t("settings.l6.paused.doubleFailed"), onSuccess: onSettled, onError: onSettled },
  );
  const leave = useAction(
    async () => {
      await api("/api/inbox/learning-paused/leave", { method: "POST", body: "{}" });
    },
    { idle: t("settings.l6.paused.leave"), pending: t("settings.l6.paused.leaving"), success: t("settings.l6.paused.left"), failure: t("settings.l6.paused.leaveFailed"), onSuccess: onSettled },
  );
  return (
    <div role="status" data-learning-paused className="rounded-xl border border-warning/30 bg-warning/[0.06] p-4 text-[13px]">
      <p className="font-medium text-ink">{t("settings.l6.paused.title")}</p>
      <p className="mt-1 text-ink-secondary">{t("settings.l6.paused.body")}</p>
      <p className="mt-1 text-ink-secondary tabular-nums">
        {t("settings.l6.paused.usage", { read: formatTokens(row.inputUsed), readLimit: formatTokens(row.input), written: formatTokens(row.outputUsed), writtenLimit: formatTokens(row.output) })}
      </p>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <ActionButton action={double} className={primary} blocked={leave.pending} layout="below">{t("settings.l6.paused.double")}</ActionButton>
        <ActionButton action={leave} className={button} blocked={double.pending} layout="below">{t("settings.l6.paused.leave")}</ActionButton>
      </div>
    </div>
  );
}
