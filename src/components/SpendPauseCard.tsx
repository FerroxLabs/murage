// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMonthReading } from "./today/MonthCard";
import { useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { opensPurchasePages } from "@/lib/native-shell";
import { actionReason } from "@/lib/use-action";
import { pauseActions, pauseLines } from "@/lib/spend-pause";
import type { SpendPauseStatus } from "../../shared/spend-pause";

const secondary = "min-h-11 rounded-lg border border-hairline/50 px-3 py-2 text-[13px] text-ink hover:bg-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const primary = "min-h-11 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

/** One obvious next action; a check always keeps the card until the server
 * actually clears its holds. All links use our fixed owner destination. */
export function SpendPauseCard({ status, onOpenUsage, onRefresh }: { status: SpendPauseStatus | null; onOpenUsage: () => void; onRefresh: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!status || (!status.held.length && !status.headsUpOnlyNotice)) return null;
  const act = async (path: string) => {
    if (pending) return;
    setPending(true); setError("");
    try { await api(path, { method: "POST", body: "{}" }); onRefresh(); }
    catch (e) { setError(actionReason(e, t("ux.l2c.headsUp.leaveFailed"))); }
    finally { setPending(false); }
  };
  // A global hold is shown once, rather than once per configured credential.
  const account = status.held.find(row => row.credentialId === "account");
  const rows = status.held.filter(row => !account || row === account || JSON.stringify(row.holds) !== JSON.stringify(account.holds));
  return <div data-spend-pause role="status" className="rounded-xl border border-warning/30 bg-warning/[0.06] p-3 text-[13px]">
    {status.headsUpOnlyNotice && <div>
      <p className="font-medium text-ink">{t("ux.l2c.pause.capabilityOff.title")}</p>
      <p className="mt-1 text-ink-secondary">{t("ux.l2c.pause.capabilityOff.body")}</p>
      <button type="button" className={secondary} disabled={pending} onClick={() => void act("/api/spend/notice/dismiss")}>{t("ux.l2c.pause.capabilityOff.ok")}</button>
    </div>}
    {rows.map((row, index) => {
      const actions = pauseActions(row.holds);
      return <div key={row.credentialId} className="my-1">
        {pauseLines(row.holds, status.limitUsd, row.botName, row.emailOnly).map((line, i) => <p key={i} className={i === 0 ? "font-medium text-ink" : "mt-1 text-ink-secondary"}>{line}</p>)}
        {!row.emailOnly && <p className="mt-1 text-ink-secondary">{t("ux.l2c.pause.waiting")}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {actions.includes("raise") && <button type="button" className={index === 0 ? primary : secondary} onClick={onOpenUsage}>{t("ux.l2c.pause.raise")}</button>}
          <button type="button" className={index === 0 && actions[0] === "check" ? primary : secondary} disabled={pending} onClick={() => void act("/api/spend/check")}>{t(pending ? "common.checking" : "ux.l2c.pause.check")}</button>
          {opensPurchasePages() && actions.includes("openFlux") && <a className={secondary} href="https://fluxrouter.ai" target="_blank" rel="noreferrer">{t("ux.l2c.pause.openFlux")}</a>}
        </div>
      </div>;
    })}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}

/** The composer shows only holds on its current billing credential. */
export function ComposerSpendPause({ model, connectionId, onOpenUsage }: { model: string; connectionId?: string; onOpenUsage(): void }) {
  const { pause, refresh } = useMonthReading();
  const credentialId = connectionId && connectionId !== "legacy-flux" ? `bank:${connectionId}` : /^flux(?:-|::)/.test(model) || connectionId === "legacy-flux" ? "account" : null;
  const held = credentialId ? pause?.held.filter(row => row.credentialId === credentialId) ?? [] : [];
  return <SpendPauseCard status={pause && held.length ? { ...pause, held, headsUpOnlyNotice: false } : null} onOpenUsage={onOpenUsage} onRefresh={refresh} />;
}
