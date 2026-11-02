// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L2A STAND-INS for the cards other lanes render into Today and the shell
// (handoffs/HANDOFF-1013-UX-L2A.md, shell contract section 3). Each keeps the
// contract's name and props. The first-run card says what FIRSTRUN 1.2 says,
// so Today is right during setup before L6A merges; the rest render nothing
// until their lane lands (L2C This month, L6C agency, L7 phone tabs), which is
// what those cards do anyway when they have nothing to show.
import { t } from "@/lib/i18n";
import type { ClientsCardProps, FirstRunTodayCardProps, MonthCardProps, OtherWorkspacesStripProps, PhoneTabsProps, TodayTag } from "../shell-contract";

export function FirstRunTodayCard({ remote, onContinueSetup }: FirstRunTodayCardProps) {
  return (
    <section aria-labelledby="first-run-today-title" className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline/50 bg-panel p-4">
      <div className="min-w-0 flex-1">
        <h2 id="first-run-today-title" className="text-[15px] font-semibold text-ink">{t("ux.l2a.firstRun.title")}</h2>
        <p className="mt-0.5 text-[13px] text-ink-secondary">{remote ? t("ux.l2a.firstRun.remote") : t("ux.l2a.firstRun.sub")}</p>
      </div>
      {!remote && (
        <button type="button" onClick={onContinueSetup}
          className="min-h-11 rounded-lg bg-accent px-4 text-[14px] font-medium text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {t("ux.l2a.firstRun.continue")}
        </button>
      )}
    </section>
  );
}

export function MonthCard(_props: MonthCardProps) { return null; }
export function useMonthTag(): TodayTag | null { return null; }
export function ClientsCard(_props: ClientsCardProps) { return null; }
export function useClientsTag(): TodayTag | null { return null; }
export function OtherWorkspacesStrip(_props: OtherWorkspacesStripProps) { return null; }
export function PhoneTabs(_props: PhoneTabsProps) { return null; }
