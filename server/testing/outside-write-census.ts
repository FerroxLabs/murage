// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Independent literal management/project inventory from DESIGN-r2 §4.
// This is a subset of the required dispatch census, not a release-complete
// inventory. Existing-service, phone and envelope effect traps remain required.
export const managementWriters = [
  ["update", "update_bot"], ["archive", "archive_bot"], ["restore", "restore_bot"],
  ["move", "move_bot"], ["set-lead", "set_team_lead"],
] as const;

export const projectWriters = [
  ["assign", "project_assign"], ["accept", "project_accept"], ["card-manage", "project_card_manage"],
  ["review-assign", "project_review_assign"], ["criteria", "project_criteria"], ["done", "project_done"],
  ["blocked", "project_blocked"], ["brief-update", "project_brief_update"], ["card-update", "project_card_update"],
  ["review-result", "project_review_result"], ["summary-update", "project_summary_update"],
  ["suggest", "project_suggest"], ["bring-in", "project_bring_in"],
] as const;
