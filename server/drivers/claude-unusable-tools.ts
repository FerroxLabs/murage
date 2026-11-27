// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Native host features that Murage's isolated bot sessions do not mount.
 * Murage owns routines, reports and its bot roster through the harness. Keep
 * explicit tool lists and other audiences on their existing launch policy. */
export const CLAUDE_UNUSABLE_TOOLS = Object.freeze([
  "Workflow",
  "ScheduleWakeup",
  "ReportFindings",
  "ListAgents",
]);
