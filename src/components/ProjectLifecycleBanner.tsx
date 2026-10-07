// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
export function ProjectLifecycleBanner({closing,closed,leadName,reopening,onReopen,reopened}:{closing:boolean;closed:boolean;leadName?:string;reopening:boolean;onReopen?:()=>void;reopened?:{pausedRoutines:string[];resumeHint:string}|null}) {
  if (!closing && !closed && !reopened) return null;
  return <div role="status" className="flex flex-wrap items-center gap-3 border-b border-hairline/40 bg-panel p-3 text-sm text-ink">
    <span>{closing ? leadName ? t("projects.lifecycle.closingFor",{name:leadName}) : t("projects.lifecycle.closing") : closed ? t("projects.lifecycle.closed") : reopened?.pausedRoutines.length ? t("projects.lifecycle.reopenedPaused",{routines:reopened.pausedRoutines.join(', '),hint:reopened.resumeHint}) : t("projects.lifecycle.reopened")}</span>
    {closed && !closing && onReopen && <button className="min-h-11 rounded-lg bg-raised px-3 focus-visible:outline-2 focus-visible:outline-focus" disabled={reopening} onClick={onReopen}>{t("projects.lifecycle.reopen")}</button>}
  </div>;
}
