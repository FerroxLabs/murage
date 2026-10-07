// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { type RefObject, useState } from "react";
import { projectClient, refreshProject } from "@/lib/use-project";
import { BOARD_BUTTON, ProjectBoardDialog } from "./ProjectBoardDialog";
import "./project-board.css";
export default function EndProjectDialog({groupId,onClose,returnFocusRef}:{groupId:string;onClose:()=>void;returnFocusRef?:RefObject<HTMLElement|null>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function end(){if(busy)return;setBusy(true);const result=await projectClient.end(groupId);if(result.ok){await refreshProject(groupId);onClose();}else setError(result.reason);setBusy(false);}
  return <ProjectBoardDialog title={t("projects.end.title")} onClose={onClose} returnFocusRef={returnFocusRef}>
    <p>{t("projects.end.effects")}</p>
    {error && <p role="alert">{error}</p>}<button className={BOARD_BUTTON} disabled={busy} onClick={end}>{t("projects.end.title")}</button>
  </ProjectBoardDialog>;
}
