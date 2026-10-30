// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Health status dot (Sean 10-30): on the You menu's Health item, and on the
// You button when the owner must act. Colour is never the only signal: the
// level is spoken through `label` (an sr-only span), and the dot is a shape a
// colour-blind owner can still see change from grey.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { HealthLevel } from "./shell-contract";

const DOT: Record<HealthLevel, string> = {
  ok: "bg-success",
  watch: "bg-warning",
  act: "bg-danger",
  unknown: "bg-ink-secondary/50",
};

const WORDS = {
  ok: "ux.l2a.health.level.ok",
  watch: "ux.l2a.health.level.watch",
  act: "ux.l2a.health.level.act",
  unknown: "ux.l2a.health.level.unknown",
} as const satisfies Record<HealthLevel, string>;

/** The words a screen reader hears for each level. */
export function healthLevelWords(level: HealthLevel): string {
  return t(WORDS[level]);
}

export function StatusDot({ level, className, spoken = true }: { level: HealthLevel; className?: string; spoken?: boolean }) {
  return (
    <span className={cn("relative inline-flex", className)} data-health-dot={level}>
      <span aria-hidden="true" className={cn("block size-2 rounded-full ring-2 ring-panel", DOT[level])} />
      {spoken && <span className="sr-only">{healthLevelWords(level)}</span>}
    </span>
  );
}
