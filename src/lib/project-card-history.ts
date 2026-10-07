// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import type { ProjectActivityRow } from "./project-client";
import { stateName, stateNames } from "./project-board";
import { t } from "./i18n";
export function cardHistoryLine(row: Pick<ProjectActivityRow, "kind" | "detail">): string {
  if (row.kind === "card_moved") {
    const known = (value: unknown): value is string => typeof value === "string" && Object.hasOwn(stateNames, value);
    const from = known(row.detail.from) ? stateName(row.detail.from) : null;
    const to = known(row.detail.to) ? stateName(row.detail.to) : null;
    return from && to ? t("projects.hist.moved", { from, to }) : row.detail.reorder === true ? t("projects.hist.reordered") : t("projects.hist.movedPlain");
  }
  const keys = { card_created: "projects.hist.added", card_reassigned: "projects.hist.reassigned", card_took_over: "projects.hist.tookOver", card_failed: "projects.hist.failed", card_result: "projects.hist.result" } as const;
  return Object.hasOwn(keys, row.kind) ? t(keys[row.kind as keyof typeof keys]) : t("projects.act.updated");
}
