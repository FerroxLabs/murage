// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { type RefObject, useState } from "react";
import { projectClient, refreshProject } from "@/lib/use-project";
import { BOARD_BUTTON, ProjectBoardDialog } from "./ProjectBoardDialog";
import "./project-board.css";
export default function CloseProjectDialog({groupId,goalState,onClose,returnFocusRef}:{groupId:string;goalState?:string;onClose:()=>void;returnFocusRef?:RefObject<HTMLElement|null>}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const blocked=["working","planning","awaiting_plan_ok"].includes(goalState ?? "");
  const stopGoal=["paused","awaiting_signoff"].includes(goalState ?? "");
  async function close(){ if(busy||blocked)return;setBusy(true);const result=await projectClient.close(groupId,stopGoal);if(result.ok){await refreshProject(groupId);onClose();}else setError(result.reason);setBusy(false); }
  return <ProjectBoardDialog title={t("projects.close.title")} onClose={onClose} returnFocusRef={returnFocusRef}>
    <p>{blocked ? t("projects.close.blocked") : stopGoal ? t("projects.close.signOff") : t("projects.close.ready")}</p>
    <p>{t("projects.close.effects")}</p>
    {error && <p role="alert">{error}</p>}<button className={BOARD_BUTTON} disabled={busy||blocked} onClick={close}>{stopGoal ? t("projects.close.stopAndClose") : t("projects.close.title")}</button>
  </ProjectBoardDialog>;
}
