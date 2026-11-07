// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A calendar card picks its layout from the height it is drawn at. A routine
// is drawn as a 30-minute marker, 32px at 64px an hour, but the card took its
// two-line layout (avatar, title, detail line) from 30 minutes on, and that
// needs about 44px: the detail line was cut in half on every routine.
//
// Behaviour ported from upstream f0a2f45ae (OpenMausBot, MIT).

export type CalendarCardLayout = "roomy" | "compact" | "tiny";

/** roomy: avatar, title and detail line. compact: one line of title and
 * time. tiny: the title alone. */
export function calendarCardLayout(heightPx: number): CalendarCardLayout {
  if (heightPx >= 44) return "roomy";
  if (heightPx >= 24) return "compact";
  return "tiny";
}

/** A one-line or title-only card has no room for the bot's face, so a small
 * dot keeps the run's state in view, the same states the face shows. null:
 * nothing to show yet (no run, or one still queued). */
export type CalendarStatusTone = "working" | "attention" | "done" | "problem" | "stopped";

export function calendarStatusTone(status: string | undefined): CalendarStatusTone | null {
  if (status === "running") return "working";
  if (status === "waiting" || status === "needs-you") return "attention";
  if (status === "completed") return "done";
  if (status === "failed" || status === "missed") return "problem";
  if (status === "cancelled") return "stopped";
  return null;
}

export const CALENDAR_STATUS_DOT: Record<CalendarStatusTone, string> = {
  working: "bg-accent animate-pulse motion-reduce:animate-none",
  attention: "bg-warning",
  done: "bg-success",
  problem: "bg-danger",
  stopped: "bg-white/50",
};

/** The dot's state in words, read out with the card's name: a colour alone says nothing to a screen reader or to an owner
 * who cannot tell the colours apart. */
export const CALENDAR_STATUS_SPOKEN: Record<CalendarStatusTone, "calendar.status.working" | "calendar.status.attention" | "calendar.status.done" | "calendar.status.problem" | "calendar.status.stopped"> = {
  working: "calendar.status.working",
  attention: "calendar.status.attention",
  done: "calendar.status.done",
  problem: "calendar.status.problem",
  stopped: "calendar.status.stopped",
};
