// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where one run of a routine begins in the routine's own conversation. Every
// run works in that one conversation (shared/routine-run-marker.ts), so this
// line is what tells one run from the next. Shown with Tool calls on or off.
import { formatTime } from "@/state/store";
import type { RoutineRunMarkerTrigger } from "../../shared/routine-run-marker";

export function RoutineRunDivider({ trigger, routineName, at }: { trigger: RoutineRunMarkerTrigger; routineName: string; at: number }) {
  const label = trigger === "manual" ? "Run now" : "Scheduled run";
  const when = formatTime(at);
  return (
    <div
      role="separator"
      aria-label={`${label} of ${routineName}, ${when}`}
      data-testid="routine-run-divider"
      className="flex items-center gap-3 py-3 text-[12px] text-ink-secondary"
    >
      <span className="h-px flex-1 bg-hairline/60" aria-hidden="true" />
      <span className="min-w-0 max-w-[80%] truncate">
        <span className="font-medium text-ink">{label}</span> · {routineName} · {when}
      </span>
      <span className="h-px flex-1 bg-hairline/60" aria-hidden="true" />
    </div>
  );
}
