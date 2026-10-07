// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useState } from "react";
import type { ProjectRead } from "@/lib/project-client";
import { sinceYouLeftLine } from "@/lib/project-activity";
import { BOARD_BUTTON } from "./ProjectBoardDialog";
export default function ProjectSinceYouLeft({ counts, onBoard, boardEnabled = true }: { counts: ProjectRead["sinceYouLeft"]; onBoard: () => void; boardEnabled?: boolean }) {
  const [dismissed, setDismissed] = useState(false);
  const line = sinceYouLeftLine(counts);
  if (dismissed || !line) return null;
  return <aside aria-label={t("projects.sinceYouLeft.aria")} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline/30 px-3 py-2 text-sm text-ink"><p>{line}</p>{boardEnabled && <button className={BOARD_BUTTON} onClick={onBoard}>{t("projects.sinceYouLeft.showBoard")}</button>}<button className={BOARD_BUTTON} onClick={() => setDismissed(true)}>{t("projects.sinceYouLeft.dismiss")}</button></aside>;
}
