// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { Suspense, useState } from "react";
import type { ProjectRead } from "@/lib/project-client";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { LazyFallback } from "./LazyFallback";

const Details = retryableLazy(() => import("./ProjectStripDetails").then((module) => ({ default: module.ProjectStripDetails })));
export function ProjectStrip({ project, title, groupId, onBoard }: { project: ProjectRead | null; title: string; groupId: string; onBoard: (action?: "reassign" | "take_over") => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!project) return null;
  const state = project.closing ? t("projects.strip.closing") : project.lifecycle === "closed" ? t("projects.strip.closed") : project.lifecycle === "ended" ? t("projects.strip.ended")
    : project.settings.runState === "paused" ? t("projects.strip.paused") : project.goal?.state.replaceAll("_", " ") ?? t("projects.strip.running");
  const limited = project.budgets.some(budget => budget.state === "paused");
  const waiting = project.strip.needsYou;
  return <section aria-label={t("projects.strip.aria")} className="min-w-0 border-b border-hairline/40 px-3 text-[12px] text-ink">
    <button type="button" aria-expanded={expanded} aria-controls={`project-details-${groupId}`} onClick={() => setExpanded(!expanded)}
      className="flex min-h-11 w-full min-w-0 items-center gap-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <span className="min-w-0 flex-1 truncate font-medium">{project.goal?.title || title}</span>
      <span aria-live="polite" className="flex shrink-0 items-center gap-2"><span className="max-w-32 truncate capitalize" title={limited ? t("projects.strip.limitTitle") : undefined}>{limited ? t("projects.strip.limitReached") : state}</span>{waiting > 0 && <span className="text-warning">{t("projects.strip.needsYou",{count:waiting})}</span>}</span>
      <svg role="img" aria-label={t("projects.strip.usageDetails")} width="20" height="20" viewBox="0 0 20 20" className="shrink-0 text-accent">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${Math.min(1, project.strip.usage.workMs / ((project.budgets.find((budget) => budget.maxWorkMinutes)?.maxWorkMinutes ?? Infinity) * 60000)) * 50.27} 50.27`} transform="rotate(-90 10 10)" />
      </svg>
      <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
    </button>
    {expanded && <div id={`project-details-${groupId}`} className="max-h-[60dvh] overflow-y-auto"><LazyBoundary inline onRetry={Details.retry}><Suspense fallback={<LazyFallback />}><Details.Component groupId={groupId} project={project} onBoard={onBoard} /></Suspense></LazyBoundary></div>}
  </section>;
}
