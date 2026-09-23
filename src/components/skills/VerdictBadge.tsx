// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { CircleCheck, OctagonX, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/cn";
import { verdictLabel, type SkillVerdict } from "@/lib/skills-api";

/** Skill Guard's verdict, in the words an owner acts on. */
export function VerdictBadge({ verdict, className }: { verdict: SkillVerdict; className?: string }) {
  const Icon = verdict === "clean" ? CircleCheck : verdict === "review" ? TriangleAlert : OctagonX;
  const tone = verdict === "clean" ? "text-success" : verdict === "review" ? "text-warning" : "text-danger";
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11.5px] font-medium", tone, className)}>
      <Icon size={13} aria-hidden="true" />
      {verdictLabel(verdict)}
    </span>
  );
}
