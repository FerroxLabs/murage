import type { PendingPermissionStatus } from "../shared/bot-access.ts";
import { accessRoleBinding, botAccessPolicy } from "./bot-access-role.ts";
import { mayReviewAccessStatus } from "./bot-access.ts";
import type { BotRecord, Store } from "./store.ts";
export interface PendingPermissionInput { kind: PendingPermissionStatus["kind"]; createdAt: number }
/** Input is supplied by the server broker adapter; whitelist output explicitly.
 * Underlying command, tool name, prompt, tokens and card text never cross here. */
export function permissionStatus(store:Store,sender:BotRecord,targetId:string,pending:readonly PendingPermissionInput[],now=Date.now()) {
 const target=store.bot(targetId);
 if(!target||!mayReviewAccessStatus(sender,target))throw Object.assign(new Error("That bot’s permission status is not visible to you."),{status:404});
 const policy=botAccessPolicy(target);
 const requests:PendingPermissionStatus[]=pending.filter(item=>["tool","question","peer","connection","access"].includes(item.kind)&&Number.isFinite(item.createdAt)).slice(0,100).map(item=>({kind:item.kind,ageSeconds:Math.max(0,Math.floor((now-item.createdAt)/1000)),blockedReason:"Waiting for owner review"}));
 for(const item of policy.requests){
  const requester=store.bot(item.requestedBy);
  const stale=!requester||!requester.chiefOfStaff||!mayReviewAccessStatus(requester,target)||accessRoleBinding(requester)!==item.requesterBinding||accessRoleBinding(target)!==item.targetBinding;
  requests.push({kind:"access",ageSeconds:Math.max(0,Math.floor((now-item.createdAt)/1000)),blockedReason:stale?"Access request is stale":"Waiting for owner review"});
 }
 return {botId:target.id,revision:policy.revision,connectedApps:target.composio===false?"disabled":policy.mode,pending:requests,canApprove:false as const};
}
