// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { OctagonX, ShieldCheck, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { CLEAN_LINE, verdictLabel, type SkillVerdict } from "@/lib/skills-api";

/** Skill Guard's verdict, quiet when there is nothing to act on. Only
 *  "Needs a look" and "Blocked" are spelled out. A built-in skill (it ships
 *  with the app and was checked before shipping) says "Built-in"; any other
 *  clean skill is a small shield with the words in its label. `spelled`
 *  writes a clean verdict out in full, for the import result. */
export function VerdictBadge({ verdict, builtIn, spelled, className }: { verdict: SkillVerdict; builtIn?: boolean; spelled?: boolean; className?: string }) {
  if (verdict === "review" || verdict === "blocked") {
    const Icon = verdict === "review" ? TriangleAlert : OctagonX;
    return (
      <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", verdict === "review" ? "text-warning" : "text-danger", className)}>
        <Icon size={13} aria-hidden="true" />
        {verdictLabel(verdict)}
      </span>
    );
  }
  if (builtIn) return <span className={cn("inline-flex items-center text-[11px] text-ink-secondary", className)}>Built-in</span>;
  if (spelled) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[11.5px] text-ink-secondary", className)}>
        <ShieldCheck size={13} className="text-success" aria-hidden="true" />
        {CLEAN_LINE}
      </span>
    );
  }
  return (
    <span role="img" aria-label={CLEAN_LINE} title={CLEAN_LINE} className={cn("inline-flex items-center text-success/80", className)}>
      <ShieldCheck size={13} aria-hidden="true" />
    </span>
  );
}
