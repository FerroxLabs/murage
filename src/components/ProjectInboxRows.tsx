// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { t } from "@/lib/i18n";
import { useState } from "react";
import type { ProjectInboxRow, InboxLink } from "../../shared/inbox";
import { api, type OptionCardData } from "@/state/store";
import { InboxRequestAnswer, inlineAnswerKind } from "./InboxRequest";
const button="min-h-11 rounded-lg border border-hairline px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50";
export default function ProjectInboxRows({rows,onSettled,onOpen}:{rows:ProjectInboxRow[];onSettled:()=>void;onOpen:(link:InboxLink)=>void}) {
  const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);const [confirm,setConfirm]=useState<string|null>(null);
  async function cardAction(groupId:string,cardId:string,action:"retry"|"done"|"cancel") {
    if(busy)return;setBusy(cardId);setError(null);
    try {
      const board=await api(`/api/groups/${groupId}/board`) as {cards:Array<{id:string;revision:number}>};
      const card=board.cards.find(card=>card.id===cardId);if(!card)throw new Error(t("projects.inbox.stepChanged"));
      await api(`/api/groups/${groupId}/board/cards/${cardId}`,{method:"PATCH",body:JSON.stringify({expectedRevision:card.revision,action,...(action==="done"?{confirm:true}:{})})});setConfirm(null);onSettled();
    }catch(cause){setError(cause instanceof Error?cause.message:t("projects.inbox.stepFailed"));}finally{setBusy(null);}
  }
  async function goalAction(row:ProjectInboxRow,goalId:string,action:string) {
    if(busy)return;setBusy(goalId);setError(null);
    try{const read=await api(`/api/groups/${row.groupId}/project`) as {goal:{id:string;revision:number}};
      if(read.goal?.id!==goalId)throw new Error(t("projects.common.goalChanged"));
      await api(`/api/groups/${row.groupId}/project/goals/${goalId}`,{method:"PATCH",body:JSON.stringify({expectedRevision:read.goal.revision,action,note:"Please revise this."})});onSettled();
    }catch(cause){setError(cause instanceof Error?cause.message:t("projects.inbox.answerFailed"));}finally{setBusy(null);}
  }
  return <section aria-label={t("projects.inbox.aria")} className="space-y-3">
    {error&&<p role="alert">{error}</p>}
    {rows.map(row=><details key={row.groupId} className="rounded-lg border border-hairline p-3"><summary className="min-h-11 cursor-pointer font-medium">{row.sentence}</summary>
      <ul className="space-y-3">{row.approvals.map(item=><li key={item.requestId}><p>{item.summary}</p>{inlineAnswerKind(item.card as OptionCardData)?<InboxRequestAnswer threadId={item.threadId} card={item.card as OptionCardData} onSettled={onSettled}/>:<button className={button} onClick={()=>onOpen({threadId:item.threadId,messageId:item.messageId})}>{t("projects.inbox.open")}</button>}</li>)}
      {row.goals.map(goal=><li key={goal.goalId}><p>{goal.state==="awaiting_plan_ok"?t("projects.inbox.planOk"):t("projects.inbox.resultOk")}</p><button className={button} disabled={!!busy} onClick={()=>void goalAction(row,goal.goalId,goal.state==="awaiting_plan_ok"?"approve_plan":"sign_off")}>{t("projects.inbox.approve")}</button>{" "}<button className={button} disabled={!!busy} onClick={()=>void goalAction(row,goal.goalId,goal.state==="awaiting_plan_ok"?"change_plan":"send_back")}>{t("projects.common.sendBack")}</button></li>)}
      {row.deadWaitCards.map(item=><li key={item.cardId}><p>{item.waitingKind==="restart"?t("projects.inbox.restartStep"):t("projects.inbox.needsAnswer")}</p><button className={button} disabled={!!busy} onClick={()=>void cardAction(row.groupId,item.cardId,"retry")}>{t("projects.inbox.retryStep")}</button>{" "}<button className={button} disabled={!!busy} onClick={()=>setConfirm(item.cardId)}>{t("projects.inbox.skip")}</button>{" "}<button className={button} disabled={!!busy} onClick={()=>void cardAction(row.groupId,item.cardId,"cancel")}>{t("projects.inbox.cancelStep")}</button>
        {confirm===item.cardId&&<div role="group" aria-label={t("projects.inbox.confirmSkip")}><p>{t("projects.inbox.markDone")}</p><button className={button} disabled={!!busy} onClick={()=>void cardAction(row.groupId,item.cardId,"done")}>{t("projects.common.doneWithoutReview")}</button>{" "}<button className={button} onClick={()=>setConfirm(null)}>{t("projects.inbox.keepStep")}</button></div>}
      </li>)}</ul>
    </details>)}
  </section>;
}
