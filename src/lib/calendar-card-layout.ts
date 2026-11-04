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
